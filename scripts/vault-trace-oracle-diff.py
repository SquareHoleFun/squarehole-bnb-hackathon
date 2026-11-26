#!/usr/bin/env python3
"""v2 T06 (placeholder tickets, stage 1): replay squarehole.vault-trace/v2 traces on the preserved Python oracle and
compare every raw integer.

The oracle is square-hole-core-v2/reference/v0_1/model.py (class Vault, policy block_last). It is never run in place:
this script copies it into a fresh temp directory, checks the copy's sha256 against square-hole-core-v2/MANIFEST.sha256,
imports it from there with bytecode writing disabled, and deletes the directory at the end (or uses --oracle PATH, an
existing scratch copy that is hash-checked the same way). Nothing is written inside square-hole-core-v2/.

For every trace it rebuilds the initial state and, after every operation, the outcome (result or refusal code) and the
complete post-state in trace form: S, E, D, E + D, A, n, m, h, t, the gate, the reveal count, burned, claims reserve,
each account's balance, claimable FIT, NFT and ticket counts, the custody changes, the one-Misfit and one-ticket quotes,
exact r, L, K, U and the docs/03 identity terms. Each field is compared with the trace; the final custody maps too. Any
difference is a disagreement.

The oracle knows neither tickets, the gate, reveals nor fees: it is a fee-free vault that withdraws any inside ID by
name. The adapter keeps that bookkeeping (the unreserved hidden IDs, the reserved IDs and their holders, the gate, the
revealed IDs) and refuses what the vault refuses for those reasons; every amount, and every refusal the arithmetic
decides, comes from the oracle:
- take k: the oracle's quote_withdraw(k) prices it; then withdraw(owner, k, ids=the k lowest unreserved hidden IDs)
  and burn(owner, fee): the fee leaves the owner after the principal moved, at n - k (the fee-order trace G05 asks for).
  The oracle's burn guard decides the dust refusal; a refused burn rolls the withdrawal back.
- release (hand-back or cancel): return_nfts(owner, reservedIds), then burn(owner, fee) while the gate is closed and
  the coordinator has not waived the hand-back fee (waiveHandBackFee: bookkeeping only, once, before graduation).
- named pick: withdraw(owner, k, ids) then burn(owner, 25% fee); return: return_nfts(owner, ids) then burn(owner, 5%).
- deliver, openGate, waiveHandBackFee, reveal: nothing on the oracle (a ticket already counts as outside there).
- a placeholder transfer: transfer_nft; a ticket holder is the custody holder "ticket:<owner>".
- quote-neutral unsolicited FIT: an ordinary transfer to the account UNSOLICITED, which the oracle counts inside
  A = S - E, so no quote moves; D is that account's balance. raw-balance: the oracle's own donate_fit_to_escrow.
- a Misfit sent to the vault: transfer_nft(sender, ESCROW, id), which the oracle refuses for every sender with one
  message; the refusal code is not_owner when the sender does not own that outside Misfit (a reserved ID is nobody's),
  else unsolicited_misfit.

Usage (from the repository root):
  PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/vault-trace-oracle-diff.py [--json] [--oracle MODEL] PATH...
PATH is a trace file, a directory of *.json traces, or '-' for {"traces": [...]} on stdin.
Exit 0: every trace agrees exactly. Exit 1: at least one disagreement. Exit 2: usage or setup error.
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import copy  # noqa: E402
import hashlib  # noqa: E402
import importlib.util  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import shutil  # noqa: E402
import tempfile  # noqa: E402
from collections import Counter  # noqa: E402
from pathlib import Path  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
V2 = REPO / 'square-hole-core-v2'
MODEL_REL = 'reference/v0_1/model.py'
SCHEMA = 'squarehole.vault-trace/v2'
UNSOLICITED = '__vault_unsolicited__'
VAULT = 'vault'
TICKET = 'ticket:'
MAX_REPORTED = 40
# F23 C3 in basis points: (draw, named pick, return). ADR-0014 section G05: fee = ceil(p * bps / 10,000).
FEES = {'none': (0, 0, 0), 'flat-f23': (100, 2_500, 500)}

# Oracle RuleViolation message -> reference refusal code. Traces never use negative amounts or system accounts, so the
# oracle's combined "not authorized" / "invalid donation" messages can only mean a balance shortfall here.
CODES = {
    'Not enough available NFTs': 'invalid_quantity',
    'Last NFT withdrawal disabled by scenario policy': 'last_misfit',
    'No such number of outside NFTs': 'invalid_quantity',
    'Return quote below one raw unit per NFT': 'return_below_unit',
    'Insufficient balance': 'insufficient_fit',
    'Withdrawal max FIT exceeded': 'max_fit_exceeded',
    'Insufficient owner FIT': 'insufficient_fit',
    'NFT identity not eligible': 'ineligible_ids',
    'Empty/duplicate NFT list': 'invalid_id_list',
    'Caller does not own these outside NFTs': 'not_owner',
    'Return min FIT not met': 'min_fit_not_met',
    'Escrow insolvency': 'escrow_insolvent',
    'Invalid NFT owner or recipient': 'not_owner',
    'Burn not authorized from this inventory': 'insufficient_fit',
    'Burn would leave <1 raw FIT unit per vault NFT': 'dust_guard',
    'Revenue budget is not funded': 'stream_not_funded',
    'Revenue burn breaches dust guard': 'dust_guard',
    'Invalid donation': 'insufficient_fit',
    'Donation would destroy the useful conversion unit': 'dust_guard',
}


class SetupError(Exception):
    pass


class Refused(Exception):
    """A refusal the adapter decides (tickets, gate, reveals, fee limits), with its reference code."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def manifest_hash(relative: str) -> str:
    for line in (V2 / 'MANIFEST.sha256').read_text().splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] == relative:
            return parts[0]
    raise SetupError(f'{relative} is not in the v2 manifest')


def load_model(path: Path):
    if sha256(path) != manifest_hash(MODEL_REL):
        raise SetupError(f'{path} does not match MANIFEST.sha256 for {MODEL_REL}')
    spec = importlib.util.spec_from_file_location('sh_v2_trace_oracle_model', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def code_of(error) -> str:
    message = str(error)
    if message not in CODES:
        raise SetupError('unmapped oracle message: ' + message)
    return CODES[message]


def rational(value) -> dict:
    return {'num': str(value.numerator), 'den': str(value.denominator)}


def fee_of(principal: int, bps: int) -> int:
    return (principal * bps + 9_999) // 10_000


def group(pairs, holders) -> dict:
    by_holder: dict = {}
    for token_id, holder in pairs:
        by_holder.setdefault(holder, []).append(token_id)
    return {h: sorted(by_holder[h]) for h in holders if h in by_holder}


class Replay:
    """One trace on one fresh oracle Vault, plus the adapter's ticket, gate and reveal bookkeeping."""

    def __init__(self, model, trace: dict):
        self.model = model
        self.trace = trace
        self.policy = trace['policy']['unsolicitedFit']
        self.draw_bps, self.pick_bps, self.return_bps = FEES[trace['policy']['conversionFees']]
        self.accounts = list(trace['accounts'])
        self.holders = self.accounts + [TICKET + a for a in self.accounts] + [VAULT]
        allocations = {a: int(v) for a, v in trace['initial']['balances'].items()}
        self.vault = model.Vault(allocations, nfts=trace['collectionSize'], empty_policy='block_last')
        self.n0 = trace['collectionSize']
        self.hidden = set(range(self.n0))
        self.tickets: dict = {}
        self.revealed: set = set()
        self.gate = False
        self.waived = False  # the coordinator's hand-back fee waiver (not a trace state field)

    # ---------------------------------------------------------------------------------------------------- state

    def unsolicited(self) -> int:
        return self.vault.balances.get(UNSOLICITED, 0) if self.policy == 'quote-neutral' else 0

    def quote(self, fn) -> dict:
        try:
            return {'ok': str(fn(1))}
        except self.model.RuleViolation as error:
            return {'error': code_of(error)}

    def quote_take(self) -> dict:
        try:
            principal = self.vault.quote_withdraw(1)
        except self.model.RuleViolation as error:
            return {'error': code_of(error)}
        if not self.hidden:
            return {'error': 'no_hidden'}
        return {'ok': str(principal + fee_of(principal, self.draw_bps))}

    def custody(self) -> dict:
        """ID -> holder for every ID outside the vault: an account, or ticket:<account> for a reserved ID."""
        out = {}
        for token_id, owner in self.vault.outside.items():
            if token_id in self.tickets:
                if self.tickets[token_id] != owner:
                    raise SetupError(f'ticket {token_id} held by {self.tickets[token_id]} but outside for {owner}')
                out[token_id] = TICKET + owner
            else:
                out[token_id] = owner
        return out

    def state(self, before) -> dict:
        v = self.vault
        s, e, d = v.total_supply, v.escrow, self.unsolicited()
        n, m, a = v.n, v.m, v.active
        after = self.custody()
        changes = []
        if before is not None:
            changes += [(i, h) for i, h in after.items() if before.get(i) != h]
            changes += [(i, VAULT) for i in before if i not in after]
        tickets = Counter(self.tickets.values())
        en, ma = e * n, m * a
        return {
            'supply': str(s),
            'escrow': str(e),
            'unsolicited': str(d),
            'vaultFit': str(e + d),
            'active': str(a),
            'inside': n,
            'outside': m,
            'hidden': len(self.hidden),
            'tickets': len(self.tickets),
            'gateOpen': self.gate,
            'revealed': len(self.revealed),
            'burned': str(v.total_burned),
            'claimsReserve': str(v.balances.get(self.model.CLAIMS, 0)),
            'balances': {acc: str(v.balances.get(acc, 0)) for acc in self.accounts},
            'claimable': {acc: str(v.claims.get(acc, 0)) for acc in self.accounts},
            'nftCounts': {acc: v.owner_counts.get(acc, 0) - tickets.get(acc, 0) for acc in self.accounts},
            'ticketCounts': {acc: tickets.get(acc, 0) for acc in self.accounts},
            'custodyChanges': group(changes, self.holders),
            'quoteWithdraw1': self.quote(v.quote_withdraw),
            'quoteReturn1': self.quote(v.quote_return),
            'quoteTake1': self.quote_take(),
            'rate': rational(v.rate),
            'obligation': rational(v.obligation),
            'surplus': rational(v.surplus),
            'envelope': rational(v.hypothetical_all_return_fit),
            'identities': {
                'En': str(en),
                'mA': str(ma),
                'Kn': str(en - ma),
                'Sn': str(s * n),
                'NA': str(self.n0 * a),
                'held': str(sum(v.balances.values())),
                'issued': str(s + v.total_burned),
                'vaultFitN': str((e + d) * n),
            },
        }

    def final(self) -> dict:
        after = self.custody()
        misfits = [(i, h) for i, h in after.items() if not h.startswith(TICKET)]
        tickets = [(i, h) for i, h in after.items() if h.startswith(TICKET)]
        return {'outside': group(misfits, self.accounts), 'tickets': group(tickets, [TICKET + a for a in self.accounts])}

    # ---------------------------------------------------------------------------------------------------- helpers

    def left(self, token_id: int) -> bool:
        return 0 <= token_id < self.n0 and token_id not in self.hidden and token_id not in self.tickets

    def charged(self, run, owner: str, fee: int) -> None:
        """Run the oracle's principal step, then burn the fee from `owner`; a refused burn rolls everything back."""
        if fee == 0:
            run()
            return
        snapshot = copy.deepcopy(self.vault)
        run()
        try:
            self.vault.burn(owner, fee)
        except self.model.RuleViolation:
            self.vault = snapshot
            raise

    @staticmethod
    def check_list(ids: list) -> None:
        if not ids or len(ids) != len(set(ids)):
            raise Refused('invalid_id_list')

    # ---------------------------------------------------------------------------------------------------- ops

    def take(self, op: dict) -> dict:
        v, owner, k = self.vault, op['owner'], op['count']
        principal = v.quote_withdraw(k)
        if k > len(self.hidden):
            raise Refused('no_hidden')
        fee = fee_of(principal, self.draw_bps)
        if 'maxFit' in op and principal + fee > int(op['maxFit']):
            raise Refused('max_fit_exceeded')
        if v.balances.get(owner, 0) < principal + fee:
            raise Refused('insufficient_fit')
        ids = sorted(self.hidden)[:k]
        self.charged(lambda: v.withdraw(owner, k, ids=ids), owner, fee)
        for token_id in ids:
            self.hidden.discard(token_id)
            self.tickets[token_id] = owner
        return {'principal': str(principal), 'fee': str(fee), 'ids': ids}

    def release(self, op: dict) -> dict:
        v, owner, ids = self.vault, op['owner'], list(op['ids'])
        self.check_list(ids)
        if any(self.tickets.get(i) != owner for i in ids):
            raise Refused('not_owner')
        principal = v.quote_return(len(ids))
        fee = 0 if self.gate or self.waived else fee_of(principal, self.return_bps)
        if 'minFit' in op and principal - fee < int(op['minFit']):
            raise Refused('min_fit_not_met')
        self.charged(lambda: v.return_nfts(owner, ids), owner, fee)
        for token_id in ids:
            del self.tickets[token_id]
            self.hidden.add(token_id)
        return {'principal': str(principal), 'fee': str(fee)}

    def deliver(self, op: dict) -> dict:
        owner, ids = op['owner'], list(op['ids'])
        self.check_list(ids)
        if any(self.tickets.get(i) != owner for i in ids):
            raise Refused('not_owner')
        if not self.gate:
            raise Refused('gate_closed')
        for token_id in ids:
            del self.tickets[token_id]
        return {}

    def reveal(self, op: dict) -> dict:
        ids = list(op['ids'])
        if not ids:
            raise Refused('invalid_id_list')
        seen = set()
        for token_id in ids:
            if not 0 <= token_id < self.n0:
                raise Refused('ineligible_ids')
            if not self.left(token_id):
                raise Refused('not_revealable')
            if token_id in self.revealed or token_id in seen:
                raise Refused('already_revealed')
            seen.add(token_id)
        self.revealed |= seen
        return {}

    def pick(self, op: dict) -> dict:
        v, owner, ids = self.vault, op['owner'], list(op['ids'])
        if not self.gate:
            raise Refused('gate_closed')
        principal = v.quote_withdraw(len(ids))
        fee = fee_of(principal, self.pick_bps)
        if 'maxFit' in op and principal + fee > int(op['maxFit']):
            raise Refused('max_fit_exceeded')
        if v.balances.get(owner, 0) < principal + fee:
            raise Refused('insufficient_fit')
        marked = set()
        for token_id in ids:
            misfit_outside = token_id in v.outside and token_id not in self.tickets
            if not 0 <= token_id < self.n0 or misfit_outside or token_id in marked:
                raise Refused('ineligible_ids')
            marked.add(token_id)
            if token_id in self.hidden or token_id in self.tickets:
                raise Refused('hidden_misfit')
            if token_id not in self.revealed:
                raise Refused('not_revealed')
        self.charged(lambda: v.withdraw(owner, len(ids), ids=ids), owner, fee)
        return {'principal': str(principal), 'fee': str(fee)}

    def give_back(self, op: dict) -> dict:
        v, owner, ids = self.vault, op['owner'], list(op['ids'])
        if not self.gate:
            raise Refused('gate_closed')
        self.check_list(ids)
        for token_id in ids:
            if v.outside.get(token_id) != owner or token_id in self.tickets:
                raise Refused('not_owner')
            if token_id not in self.revealed:
                raise Refused('not_revealed')
        principal = v.quote_return(len(ids))
        fee = fee_of(principal, self.return_bps)
        if 'minFit' in op and principal - fee < int(op['minFit']):
            raise Refused('min_fit_not_met')
        self.charged(lambda: v.return_nfts(owner, ids), owner, fee)
        return {'principal': str(principal), 'fee': str(fee)}

    def apply(self, op: dict) -> dict:
        v, kind = self.vault, op['op']
        if kind == 'take':
            return self.take(op)
        if kind == 'release':
            return self.release(op)
        if kind == 'deliver':
            return self.deliver(op)
        if kind == 'openGate':
            if self.gate:
                raise Refused('gate_already_open')
            self.gate = True
            return {}
        if kind == 'waiveHandBackFee':
            if self.gate:
                raise Refused('gate_already_open')
            if self.waived:
                raise Refused('fee_already_waived')
            self.waived = True
            return {}
        if kind == 'reveal':
            return self.reveal(op)
        if kind == 'withdraw':
            return self.pick(op)
        if kind == 'return':
            return self.give_back(op)
        if kind == 'transferTicket':
            if self.tickets.get(op['id']) != op['from']:
                raise Refused('not_owner')
            v.transfer_nft(op['from'], op['to'], op['id'])
            self.tickets[op['id']] = op['to']
            return {}
        if kind == 'transferMisfit':
            if op['id'] in self.tickets:
                raise Refused('not_owner')
            v.transfer_nft(op['from'], op['to'], op['id'])
            return {}
        if kind == 'transferFit':
            v.transfer(op['from'], op['to'], int(op['amount']))
            return {}
        if kind == 'sendFitToVault':
            if self.policy == 'quote-neutral':
                v.transfer(op['from'], UNSOLICITED, int(op['amount']))
            else:
                v.donate_fit_to_escrow(op['from'], int(op['amount']))
            return {}
        if kind == 'sendMisfitToVault':
            raise SetupError('sendMisfitToVault is handled in outcome()')
        if kind == 'burn':
            v.burn(op['owner'], int(op['amount']))
            return {}
        if kind == 'allocateStream':
            r = v.accrue_nft_fit_revenue(op['source'], int(op['budget']))
            return {'burned': str(r['burned']), 'credited': str(r['credited']), 'dust': str(r['dust_retained_by_source'])}
        if kind == 'claim':
            return {'paid': str(v.claim(op['owner']))}
        raise SetupError('unknown op: ' + kind)

    def send_misfit(self, op: dict) -> dict:
        """The oracle refuses every NFT transfer to ESCROW with one message; split it by current ownership."""
        owns = self.vault.outside.get(op['id']) == op['from'] and op['id'] not in self.tickets
        try:
            self.vault.transfer_nft(op['from'], self.model.ESCROW, op['id'])
        except self.model.RuleViolation as error:
            code = code_of(error)
            return {'error': 'unsolicited_misfit' if owns and code == 'not_owner' else code}
        raise SetupError('the oracle accepted a Misfit sent to the escrow')

    def outcome(self, op: dict) -> dict:
        if op['op'] == 'sendMisfitToVault':
            return self.send_misfit(op)
        try:
            return {'ok': self.apply(op)}
        except Refused as refusal:
            return {'error': refusal.code}
        except self.model.RuleViolation as error:
            return {'error': code_of(error)}


def diff(path: str, expected, actual, out: list) -> None:
    if expected == actual and type(expected) is type(actual):
        return
    if isinstance(expected, dict) and isinstance(actual, dict):
        for key in list(dict.fromkeys(list(expected) + list(actual))):
            diff(f'{path}.{key}', expected.get(key, '<missing>'), actual.get(key, '<missing>'), out)
        return
    if isinstance(expected, list) and isinstance(actual, list) and len(expected) == len(actual):
        for i, (x, y) in enumerate(zip(expected, actual)):
            diff(f'{path}.{i}', x, y, out)
        return
    out.append({'path': path, 'expected': expected, 'actual': actual})


def replay_trace(model, trace: dict, tally: Counter) -> list:
    if trace.get('schema') != SCHEMA:
        raise SetupError(f"{trace.get('id')}: not a {SCHEMA} trace")
    mismatches: list = []
    replay = Replay(model, trace)
    diff('initial', trace['initial'], replay.state(None), mismatches)
    for i, step in enumerate(trace['steps']):
        before = replay.custody()
        outcome = replay.outcome(step['op'])
        replay.vault.assert_invariants(deep=True)
        diff(f'steps.{i}.outcome', step['outcome'], outcome, mismatches)
        diff(f'steps.{i}.state', step['state'], replay.state(before), mismatches)
        kind = step['op']['op']
        tally[f"{kind}:{'ok' if 'ok' in outcome else outcome['error']}"] += 1
        tally['steps'] += 1
    diff('final', trace['final'], replay.final(), mismatches)
    tally['traces'] += 1
    tally[f"policy:{replay.policy}"] += 1
    tally[f"fees:{trace['policy']['conversionFees']}"] += 1
    return [{'trace': trace['id'], **m} for m in mismatches]


def read_traces(paths: list) -> list:
    traces = []
    for raw in paths:
        if raw == '-':
            traces += json.load(sys.stdin)['traces']
            continue
        path = Path(raw)
        files = sorted(path.glob('*.json')) if path.is_dir() else [path]
        for file in files:
            traces.append(json.loads(file.read_text()))
    return traces


def main(argv: list) -> int:
    as_json = '--json' in argv
    args = [a for a in argv if a != '--json']
    oracle_path = None
    if '--oracle' in args:
        i = args.index('--oracle')
        if i + 1 >= len(args):
            print('--oracle needs a path', file=sys.stderr)
            return 2
        oracle_path = Path(args[i + 1])
        del args[i:i + 2]
    if not args:
        print(__doc__, file=sys.stderr)
        return 2
    scratch = None
    try:
        if oracle_path is None:
            scratch = Path(tempfile.mkdtemp(prefix='sh-v2-trace-oracle-'))
            oracle_path = scratch / MODEL_REL
            oracle_path.parent.mkdir(parents=True)
            shutil.copyfile(V2 / MODEL_REL, oracle_path)
        if V2.resolve() in oracle_path.resolve().parents:
            raise SetupError('refusing to load the oracle from inside square-hole-core-v2/')
        model = load_model(oracle_path)
        traces = read_traces(args)
        tally: Counter = Counter()
        mismatches: list = []
        for trace in traces:
            mismatches += replay_trace(model, trace, tally)
    except SetupError as error:
        print(f'setup error: {error}', file=sys.stderr)
        return 2
    finally:
        if scratch is not None:
            shutil.rmtree(scratch, ignore_errors=True)
    report = {
        'oracle': {'file': MODEL_REL, 'sha256': manifest_hash(MODEL_REL), 'scratchCopy': str(scratch or oracle_path),
                   'scratchRemoved': scratch is None or not os.path.exists(scratch)},
        'traces': tally['traces'],
        'steps': tally['steps'],
        'policies': {k.split(':', 1)[1]: v for k, v in sorted(tally.items()) if k.startswith('policy:')},
        'fees': {k.split(':', 1)[1]: v for k, v in sorted(tally.items()) if k.startswith('fees:')},
        'outcomes': {k: v for k, v in sorted(tally.items()) if ':' in k and not k.startswith(('policy:', 'fees:'))},
        'mismatchCount': len(mismatches),
        'mismatches': mismatches[:MAX_REPORTED],
    }
    if as_json:
        json.dump(report, sys.stdout)
        sys.stdout.write('\n')
    else:
        print(f"oracle {MODEL_REL} sha256 {report['oracle']['sha256'][:16]}... (scratch copy, removed: "
              f"{report['oracle']['scratchRemoved']})")
        print(f"{report['traces']} traces, {report['steps']} steps, policies {report['policies']}, fees {report['fees']}")
        for m in report['mismatches']:
            print(f"MISMATCH {m['trace']} {m['path']}: expected {m['expected']!r}, oracle {m['actual']!r}")
        print('every raw integer agrees' if not mismatches else f'{len(mismatches)} disagreement(s)')
    return 0 if not mismatches else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
