#!/usr/bin/env python3
"""Deterministic DEMO accounts and claims fixture (SH-014, SH-015; ADR-0008).

Replays a documented, deterministic sequence of economic transfers and authenticated fee receipts for three demo
pairs through the handoff's exact-arithmetic reference model `square-hole-handoff/reference/fee_policy_model.py`
(imported in place, never copied or edited) and writes the resulting balances and entitlements to
`packages/providers/src/fixtures/accounts.json`. Nothing here is chain data: addresses are synthetic, amounts are
illustrative ledger inputs (05-ECONOMICS "illustrative ledger inputs, not a trade quote").

Sequence semantics (per event, in order):
  buy   who t q     Q fee recognised at the checkpoint immediately BEFORE the fee-bearing transfer (05-ECONOMICS
                    default checkpoint), then `t` T moves from the excluded market inventory to `who`. The buyer
                    does not earn from its own purchase; a later buyer never inherits old entitlement (ECO-05).
  sell  who t fee   `who` sends `fee` T to the excluded fee collector and `t - fee` T to the market, then the fee T
                    is recognised and burned (ECO-01). A T-only fee creates no Q entitlement (ECO-10).
  sell_all who fee  as `sell`, for `who`'s whole balance.
  claim_q who       R=Q settlement of the whole earned entitlement.
  claim_t who r     R=T settlement: the whole earned Q is converted at the demo quote `r` (T per Q, display units),
                    output floored; the signed minimum is floor(output x (10000 - 100) / 10000).
  claim_t_revert who quoted executable
                    the executable rate gives less than the signed minimum from `quoted`; the reference model raises
                    before mutation (atomic revert) and the entitlement is asserted unchanged (ECO-07).
  pending_harvest q observed Q fees not yet recognised (must be the last events). Each account's share is measured
                    on a deep copy that recognises them at the current checkpoint; it is NOT claimable.

Rounding: the model is exact (fractions of a raw unit). Every amount written is an integer number of raw units
rounded DOWN (floor). The dropped fractions are tracked per account (`claimableRemainderQ`) and per ledger
(`roundingDustQ`), with the exact identity
    holderAllocated = deferred + sum(claimable) + sum(claimed) + roundingDust,  0 <= roundingDust < accounts + claims
so a displayed claim is never overstated (ECO-15).

Usage:
  python3 scripts/gen-claims-fixture.py            # (re)write the fixture
  python3 scripts/gen-claims-fixture.py --stdout   # print it (used by the up-to-date test)
  python3 scripts/gen-claims-fixture.py --check    # exit 1 when the committed fixture is stale
"""
from __future__ import annotations

import argparse
import calendar
import copy
import hashlib
import json
import sys
import time
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_DIR = ROOT / 'square-hole-handoff' / 'reference'
FEED = ROOT / 'packages' / 'providers' / 'src' / 'fixtures' / 'feed.json'
OUTPUT = ROOT / 'packages' / 'providers' / 'src' / 'fixtures' / 'accounts.json'

sys.dont_write_bytecode = True  # never write __pycache__ into the immutable handoff folder
sys.path.insert(0, str(REFERENCE_DIR))
from fee_policy_model import Ledger  # noqa: E402  (reference module, imported after the path insert)

# Demo local-chain block clock: block n is mined at GENESIS + 12 s x n. Illustrative, not a real chain.
GENESIS = '2026-09-20T00:00:00Z'
BLOCK_SECONDS = 12
TOLERANCE_BPS = 100  # fixed draft demo tolerance for signed minimum payouts; not user-editable
QUOTE_TTL_SECONDS = 1200
MARKET = 'market'  # excluded: curve/pool inventory (05-ECONOMICS "not ordinary reward owners")
FEE_COLLECTOR = 'fee_collector'  # excluded

PERSONAS = [
    {'id': 'current_holder', 'label': 'Demo persona: current holder', 'address': '0x00000000000000000000000000000000de000001'},
    {'id': 'past_holder', 'label': 'Demo persona: past holder', 'address': '0x00000000000000000000000000000000de000002'},
    {'id': 'never_held', 'label': 'Demo persona: never held', 'address': '0x00000000000000000000000000000000de000003'},
]
DEMO_HOLDERS = {
    'holder_a': '0x00000000000000000000000000000000de0000a1',
    'holder_b': '0x00000000000000000000000000000000de0000a2',
    'holder_c': '0x00000000000000000000000000000000de0000a3',
    'holder_d': '0x00000000000000000000000000000000de0000a4',
}
ADDRESS = {**{p['id']: p['address'] for p in PERSONAS}, **DEMO_HOLDERS}

# Illustrative DN404-style NFT ids for persona positions in NFT pairs (count must equal floor(balance / unit)).
NFT_IDS = {('orchard', 'current_holder'): ['7', '12', '31']}

LEDGERS = [
    {
        'slug': 'orchard',  # R = Q, AAPLx-DEMO (18 decimals)
        'quote': None,
        'events': [
            ('2026-09-22T12:10:00Z', 'buy', 'holder_a', '1000', '3'),  # zero eligible supply: holder share deferred (ECO-08)
            ('2026-09-22T13:00:00Z', 'buy', 'current_holder', '3.25', '0.3'),
            ('2026-09-22T18:00:00Z', 'buy', 'past_holder', '50000', '6'),
            ('2026-09-23T00:00:00Z', 'buy', 'holder_b', '110000', '12'),
            ('2026-09-23T06:00:00Z', 'buy', 'holder_c', '90000', '9'),
            ('2026-09-23T12:00:00Z', 'claim_q', 'current_holder'),
            ('2026-09-24T00:00:00Z', 'sell_all', 'past_holder', '40'),  # past holder exits: zero balance, claim kept (ECO-05)
            ('2026-09-24T06:00:00Z', 'sell', 'holder_b', '10000', '50'),
            ('2026-09-24T12:00:00Z', 'buy', 'holder_d', '61996.75', '60'),
            ('2026-09-24T18:00:00Z', 'sell', 'holder_c', '5000', '30'),
            ('2026-09-25T08:00:00Z', 'buy', 'holder_c', '2000', '15'),
            ('2026-09-25T11:30:00Z', 'pending_harvest', '1.2'),
        ],
    },
    {
        'slug': 'tiny-frames',  # R = T, WETH-DEMO (18 decimals)
        'quote': '2000',
        'events': [
            ('2026-09-25T00:05:00Z', 'buy', 'holder_a', '60000', '3'),  # zero eligible supply: holder share deferred (ECO-08)
            ('2026-09-25T01:00:00Z', 'buy', 'past_holder', '20000', '1.2'),
            ('2026-09-25T02:00:00Z', 'buy', 'holder_b', '25000', '1.5'),
            ('2026-09-25T03:00:00Z', 'claim_t', 'past_holder', '2000'),  # settled R=T claim; payout T is not burned (ECO-02)
            ('2026-09-25T03:30:00Z', 'buy', 'holder_c', '1000', '0.6'),
            ('2026-09-25T04:00:00Z', 'buy', 'current_holder', '0.5', '0.03'),
            ('2026-09-25T05:00:00Z', 'sell_all', 'past_holder', '60'),  # past holder exits with an unclaimed entitlement
            ('2026-09-25T06:00:00Z', 'buy', 'holder_c', '9000', '0.6'),
            ('2026-09-25T07:00:00Z', 'buy', 'holder_d', '9999.5', '0.9'),
            ('2026-09-25T08:00:00Z', 'claim_t_revert', 'past_holder', '2000', '1900'),  # min-out revert (ECO-07)
            ('2026-09-25T09:00:00Z', 'sell', 'holder_b', '5000', '60'),
            ('2026-09-25T11:00:00Z', 'pending_harvest', '0.45'),
        ],
    },
    {
        'slug': 'round-trip',  # R = T, WETH-DEMO (18 decimals)
        'quote': '3000',
        'events': [
            ('2026-09-23T13:00:00Z', 'buy', 'holder_a', '400000', '1.2'),
            ('2026-09-23T18:00:00Z', 'buy', 'holder_b', '101000', '0.3'),
            ('2026-09-24T12:00:00Z', 'sell', 'holder_b', '2500', '120'),
            ('2026-09-25T09:00:00Z', 'buy', 'current_holder', '1500', '0.006'),  # later buyer: no old entitlement
        ],
    },
]


def epoch(iso: str) -> int:
    return calendar.timegm(time.strptime(iso, '%Y-%m-%dT%H:%M:%SZ'))


def iso(seconds: int) -> str:
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(seconds))


def block_at(at: str) -> int:
    elapsed = epoch(at) - epoch(GENESIS)
    if elapsed < 0 or elapsed % BLOCK_SECONDS:
        raise ValueError(f'{at} is not on the demo block clock')
    return elapsed // BLOCK_SECONDS


def raw(amount: str, decimals: int) -> int:
    """Exact decimal string -> raw integer units; refuses excess precision (no float anywhere)."""
    whole, _, fraction = amount.partition('.')
    if len(fraction) > decimals or not (whole + fraction).isdigit():
        raise ValueError(f'{amount} is not representable with {decimals} decimals')
    return int(whole) * 10**decimals + (int(fraction.ljust(decimals, '0')) if fraction else 0)


def integral(value: Fraction, label: str) -> int:
    if value.denominator != 1:
        raise ValueError(f'{label} is not an integer number of raw units: {value}')
    return value.numerator


def floor_split(value: Fraction) -> tuple[int, Fraction]:
    whole = value.numerator // value.denominator
    return whole, value - whole


def fraction_text(value: Fraction) -> str:
    """Exact rational in raw units: 'n' for integers, else 'n/d' (lowest terms)."""
    return str(value.numerator) if value.denominator == 1 else f'{value.numerator}/{value.denominator}'


def rate_fraction(rate: str) -> Fraction:
    whole, _, frac = rate.partition('.')
    return Fraction(int(whole + frac), 10 ** len(frac))


def convert(q_raw: Fraction, rate: str, q_decimals: int, t_decimals: int) -> int:
    """floor(q x rate) in T raw units; the rate is T per Q in display units."""
    exact = q_raw * rate_fraction(rate) * Fraction(10**t_decimals, 10**q_decimals)
    return floor_split(exact)[0]


def min_out(payout: int) -> int:
    return payout * (10_000 - TOLERANCE_BPS) // 10_000


def measured_policy() -> dict:
    """The Q split measured from the reference model itself (checked against the TS policy constants)."""
    ledger = Ledger({'probe': 1})
    ledger.recognize_fees('policy-probe', 0, 3)
    return {'qProtocolShare': fraction_text(ledger.q_protocol / 3), 'qHolderShare': fraction_text(ledger.pending('probe') / 3)}


class Replay:
    """Replays one ledger spec through the reference model, one small handler per event kind."""

    def __init__(self, spec: dict, pair: dict, as_of: str):
        self.slug = spec['slug']
        self.spec = spec
        self.pair = pair
        self.as_of = as_of
        self.t_dec = pair['token']['decimals']
        self.q_dec = pair['quote']['decimals']
        self.ledger = Ledger({MARKET: int(pair['totalSupplyRaw']) + int(pair['burnedRaw']), FEE_COLLECTOR: 0})
        self.names = sorted({e[2] for e in spec['events'] if e[1] != 'pending_harvest'})
        for name in self.names:
            self.ledger._ensure(name)  # noqa: SLF001  (reference helper: open a zero-balance account at the current index)
        self.history = {name: [] for name in self.names}
        self.claimed = {name: 0 for name in self.names}
        self.pending_share = {name: Fraction(0) for name in self.names}
        self.claim_dust = Fraction(0)
        self.settled_claims = 0
        self.t_paid = 0
        self.receipts = 0
        self.q_received = 0
        self.pending_harvest = Fraction(0)

    def _receipt(self) -> str:
        self.receipts += 1
        return f'{self.slug}-r{self.receipts}'

    def _settled(self, who: str, at: str, q_in: Fraction, payout: int | None, side: str) -> int:
        paid, dust = floor_split(q_in)
        self.claimed[who] += paid
        self.claim_dust += dust
        self.settled_claims += 1
        payout_raw = paid if payout is None else payout
        self.history[who].append({'at': at, 'block': str(block_at(at)), 'qConsumedRaw': str(paid), 'payoutRaw': str(payout_raw), 'payoutSide': side, 'outcome': 'settled'})
        return paid

    def buy(self, at: str, who: str, t_amount: str, q_fee: str) -> dict:
        receipt, q_fee_raw, t_raw = self._receipt(), raw(q_fee, self.q_dec), raw(t_amount, self.t_dec)
        self.ledger.recognize_fees(receipt, 0, q_fee_raw)  # checkpoint before the fee-bearing transfer
        self.ledger.transfer(MARKET, who, t_raw)
        self.q_received += q_fee_raw
        return {'account': ADDRESS[who], 'receiptId': receipt, 'tRaw': str(t_raw), 'feeQRaw': str(q_fee_raw), 'feeTRaw': '0'}

    def sell(self, at: str, who: str, t_amount: str | None, t_fee: str) -> dict:
        t_raw = integral(self.ledger.balances[who], 'sell_all balance') if t_amount is None else raw(t_amount, self.t_dec)
        fee_raw, receipt = raw(t_fee, self.t_dec), self._receipt()
        self.ledger.transfer(who, FEE_COLLECTOR, fee_raw)
        self.ledger.transfer(who, MARKET, t_raw - fee_raw)
        self.ledger.recognize_fees(receipt, fee_raw, 0)  # native fee T is burned; no Q is created
        return {'kind': 'sell', 'account': ADDRESS[who], 'receiptId': receipt, 'tRaw': str(t_raw), 'feeQRaw': '0', 'feeTRaw': str(fee_raw)}

    def claim_q(self, at: str, who: str) -> dict:
        paid = self._settled(who, at, self.ledger.claim_q(who), None, 'Q')
        return {'account': ADDRESS[who], 'qConsumedRaw': str(paid), 'payoutRaw': str(paid), 'payoutSide': 'Q'}

    def claim_t(self, at: str, who: str, rate: str) -> dict:
        t_out = convert(self.ledger.pending(who), rate, self.q_dec, self.t_dec)
        q_in, _ = self.ledger.claim_t(who, t_out, min_out(t_out))
        paid = self._settled(who, at, q_in, t_out, 'T')
        self.t_paid += t_out
        return {'account': ADDRESS[who], 'qConsumedRaw': str(paid), 'payoutRaw': str(t_out), 'payoutSide': 'T', 'tPerQ': rate, 'minPayoutRaw': str(min_out(t_out))}

    def claim_t_revert(self, at: str, who: str, quoted: str, executable: str) -> dict:
        before = self.ledger.pending(who)
        signed_min = min_out(convert(before, quoted, self.q_dec, self.t_dec))
        offered = convert(before, executable, self.q_dec, self.t_dec)
        try:
            self.ledger.claim_t(who, offered, signed_min)
        except ValueError:
            pass
        else:
            raise AssertionError(f'{self.slug} {at}: expected a min-out revert')
        if self.ledger.pending(who) != before:
            raise AssertionError(f'{self.slug} {at}: a reverted conversion changed the entitlement')
        self.history[who].append({'at': at, 'block': str(block_at(at)), 'qConsumedRaw': '0', 'payoutRaw': '0', 'payoutSide': 'T', 'outcome': 'reverted', 'reason': 'min_payout_not_met'})
        return {'account': ADDRESS[who], 'tPerQ': quoted, 'executableTPerQ': executable, 'minPayoutRaw': str(signed_min), 'offeredPayoutRaw': str(offered), 'outcome': 'reverted'}

    def harvest(self, at: str, q_fee: str) -> dict:
        q_fee_raw = raw(q_fee, self.q_dec)
        probe = copy.deepcopy(self.ledger)  # recognised only on a copy: pending harvest is NOT claimable
        probe.recognize_fees(f'{self.slug}-pending-probe', 0, q_fee_raw)
        for name in self.names:
            self.pending_share[name] += probe.pending(name) - self.ledger.pending(name)
        self.pending_harvest += q_fee_raw
        return {'feeQRaw': str(q_fee_raw), 'recognised': False}

    def run(self) -> list[dict]:
        handlers = {
            'buy': lambda at, who, t, q: self.buy(at, who, t, q),
            'sell': lambda at, who, t, fee: self.sell(at, who, t, fee),
            'sell_all': lambda at, who, fee: self.sell(at, who, None, fee),
            'claim_q': self.claim_q,
            'claim_t': self.claim_t,
            'claim_t_revert': self.claim_t_revert,
            'pending_harvest': self.harvest,
        }
        events, last_at, harvest_started = [], epoch(self.pair['launchedAt']), False
        for step, (at, kind, *args) in enumerate(self.spec['events'], start=1):
            if not (last_at <= epoch(at) <= epoch(self.as_of)):
                raise ValueError(f'{self.slug} step {step}: {at} outside the launch window or out of order')
            if harvest_started and kind != 'pending_harvest':
                raise ValueError(f'{self.slug} step {step}: pending_harvest events must come last')
            if kind not in handlers:
                raise ValueError(f'unknown event kind {kind}')
            last_at, harvest_started = epoch(at), harvest_started or kind == 'pending_harvest'
            record = {'step': step, 'at': at, 'block': str(block_at(at)), 'kind': kind}
            record.update(handlers[kind](at, *args))
            self.ledger.assert_invariants()
            events.append(record)
        return events

    def reconcile(self) -> int:
        """Cross-check the replay against the feed record (FEED-07); returns the eligible supply."""
        eligible = integral(self.ledger.eligible_supply, 'eligible supply')
        checks = {
            'burned': (integral(self.ledger.burned, 'burned'), int(self.pair['burnedRaw'])),
            'totalSupply': (integral(self.ledger.supply, 'supply'), int(self.pair['totalSupplyRaw'])),
            'eligible=circulating': (eligible, int(self.pair['circulatingSupplyRaw'])),
            'feeCollector': (integral(self.ledger.balances[FEE_COLLECTOR], 'fee collector'), 0),
        }
        for label, (actual, expected) in checks.items():
            if actual != expected:
                raise AssertionError(f'{self.slug}: {label} {actual} != feed {expected}')
        return eligible

    def quote(self) -> dict | None:
        if self.spec['quote'] is None:
            return None
        if self.pair['rewardSide'] != 'T':
            raise AssertionError(f'{self.slug}: a conversion quote only exists for R=T pairs')
        return {
            'source': 'demo_quote',
            'tPerQ': self.spec['quote'],
            'quotedAt': self.as_of,
            'asOfBlock': str(block_at(self.as_of)),
            'deadline': iso(epoch(self.as_of) + QUOTE_TTL_SECONDS),
            'toleranceBps': TOLERANCE_BPS,
        }

    def account(self, name: str, quote: dict | None) -> tuple[dict, int, Fraction]:
        balance = integral(self.ledger.balances[name], f'{name} balance')
        claimable, remainder = floor_split(self.ledger.pending(name))
        persona = next((p['id'] for p in PERSONAS if p['id'] == name), None)
        nft_ids = NFT_IDS.get((self.slug, name), [])
        if self.pair['type'] == 'nft_collection' and persona is not None and balance > 0:
            whole = balance // int(self.pair['nftUnitRaw'])
            if len(nft_ids) != whole:
                raise AssertionError(f'{self.slug}: {name} needs {whole} NFT ids')
        estimate = None
        if quote is not None and claimable > 0:
            payout = convert(Fraction(claimable), quote['tPerQ'], self.q_dec, self.t_dec)
            estimate = {'payoutRaw': str(payout), 'minPayoutRaw': str(min_out(payout))}
        entry = {
            'address': ADDRESS[name],
            'role': 'persona' if persona else 'demo_holder',
            'persona': persona,
            'balanceRaw': str(balance),
            'nftTokenIds': nft_ids,
            'claimableQRaw': str(claimable),
            'claimableRemainderQ': fraction_text(remainder),
            'claimedQRaw': str(self.claimed[name]),
            'pendingHarvestQRaw': str(floor_split(self.pending_share[name])[0]),
            'history': self.history[name],
            'convertibleEstimate': estimate,
        }
        return entry, claimable, remainder

    def output(self, events: list[dict]) -> dict:
        eligible = self.reconcile()
        quote = self.quote()
        rows = [self.account(name, quote) for name in self.names]
        claimable_total = sum(claimable for _, claimable, _ in rows)
        remainder_total = sum((remainder for _, _, remainder in rows), Fraction(0))
        claimed_total = sum(self.claimed.values())
        holder_allocated = integral(self.ledger.q_holders + self.ledger.q_settled, 'holder allocation')
        deferred = integral(self.ledger.q_deferred, 'deferred')
        dust = Fraction(holder_allocated) - deferred - claimable_total - claimed_total
        if dust != remainder_total + self.claim_dust or not (0 <= dust < len(self.names) + self.settled_claims):
            raise AssertionError(f'{self.slug}: rounding dust {dust} out of bounds')
        return {
            'pairId': self.pair['pairId'],
            'slug': self.slug,
            'rewardSide': self.pair['rewardSide'],
            'tDecimals': self.t_dec,
            'qDecimals': self.q_dec,
            'events': events,
            'accounts': [entry for entry, _, _ in rows],
            'excluded': {'marketRaw': str(integral(self.ledger.balances[MARKET], 'market')), 'feeCollectorRaw': '0'},
            'quote': quote,
            'totals': {
                'qReceivedRaw': str(self.q_received),
                'protocolQRaw': str(integral(self.ledger.q_protocol, 'protocol share')),
                'holderAllocatedQRaw': str(holder_allocated),
                'deferredQRaw': str(deferred),
                'claimableQRaw': str(claimable_total),
                'claimedQRaw': str(claimed_total),
                'roundingDustQ': fraction_text(dust),
                'settledClaims': self.settled_claims,
                'tPaidRaw': str(self.t_paid),
                'tBurnedRaw': str(integral(self.ledger.burned, 'burned')),
                'pendingHarvestQRaw': str(integral(self.pending_harvest, 'pending harvest')),
                'eligibleSupplyRaw': str(eligible),
                'totalSupplyRaw': str(integral(self.ledger.supply, 'supply')),
            },
        }


def replay(spec: dict, pair: dict, as_of: str) -> dict:
    run = Replay(spec, pair, as_of)
    return run.output(run.run())


def build() -> dict:
    feed_bytes = FEED.read_bytes()
    reference_bytes = (REFERENCE_DIR / 'fee_policy_model.py').read_bytes()
    feed = json.loads(feed_bytes)
    by_slug = {item.get('slug'): item for item in feed['items']}
    as_of = feed['asOf']
    return {
        'schemaVersion': '1.0',
        'mode': 'demo',
        'chainId': feed['chainId'],
        'asOf': as_of,
        'asOfBlock': str(block_at(as_of)),
        'blockClock': {'genesis': GENESIS, 'blockSeconds': BLOCK_SECONDS},
        'note': 'DEMO personas and synthetic addresses. Entitlements replayed through the handoff reference model; not chain data.',
        'generator': 'scripts/gen-claims-fixture.py',
        'reference': 'square-hole-handoff/reference/fee_policy_model.py',
        'referenceSha256': hashlib.sha256(reference_bytes).hexdigest(),
        'feedFixtureSha256': hashlib.sha256(feed_bytes).hexdigest(),
        'rounding': 'floor',
        'claimToleranceBps': TOLERANCE_BPS,
        'measuredPolicy': measured_policy(),
        'personas': PERSONAS,
        'ledgers': [replay(spec, by_slug[spec['slug']], as_of) for spec in LEDGERS],
    }


def render(document: dict) -> str:
    return json.dumps(document, indent=2, sort_keys=True, ensure_ascii=True) + '\n'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--stdout', action='store_true', help='print the fixture instead of writing it')
    mode.add_argument('--check', action='store_true', help='exit 1 if the committed fixture is stale')
    args = parser.parse_args()
    text = render(build())
    if args.stdout:
        sys.stdout.write(text)
        return 0
    if args.check:
        current = OUTPUT.read_text(encoding='utf-8') if OUTPUT.exists() else ''
        if current != text:
            sys.stderr.write(f'{OUTPUT.relative_to(ROOT)} is stale; run python3 scripts/gen-claims-fixture.py\n')
            return 1
        return 0
    OUTPUT.write_text(text, encoding='utf-8')
    sys.stdout.write(f'wrote {OUTPUT.relative_to(ROOT)} ({len(json.loads(text)["ledgers"])} ledgers)\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
