#!/usr/bin/env python3
"""Generate deterministic differential vectors from the handoff reference model.

The model (square-hole-handoff/reference/fee_policy_model.py) is imported in place and never modified; bytecode
writing is disabled so the hash-checked handoff directory stays untouched. Every scenario is driven by a fixed
seed recorded in its JSON file. The Foundry test test/Differential.t.sol replays each vector against the contracts.

Supply rule (ADR-0009 F10 addendum, SH-E): every launch has exactly 1e9 whole tokens (1e27 raw, 18 decimals). A
scenario fixes the collection size N = collectionSize, a divisor of 1e27 with 1 <= N <= 1e9; one NFT is
`unit` = 1e27 / N raw units (exact), and `fractionsPerNft` is 1e9 / N when that is an integer, else 0. The same vectors
are replayed against the fungible template (always 1e9 whole tokens), where a whole-NFT step is a plain transfer of
`unit`.

Each scenario runs two instances of the unmodified model on the same steps:
- `model` is fed the raw Q receipts (exact 1/3 : 2/3 split) -> `expCumulative`, checked within `expBound`;
- `imodel` is fed the fee collector's integer split: X = q + carry, 3*floor(X/3) is recognised and X mod 3 is
  carried to the next receipt, exactly as FeeCollector.receiveFees -> `expCumulativeInt`, checked within 1 wei on
  every vector and step (the only remaining differences are the ledger's index and claim flooring).

Usage (from packages/contracts):  python3 script-py/gen_vectors.py          # (re)write test/vectors/*.json
                                  python3 script-py/gen_vectors.py --check  # fail if committed vectors differ
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import json  # noqa: E402
import math  # noqa: E402
from fractions import Fraction  # noqa: E402
from pathlib import Path  # noqa: E402
from random import Random  # noqa: E402

HERE = Path(__file__).resolve().parent
CONTRACTS = HERE.parent
REPO = CONTRACTS.parent.parent
sys.path.insert(0, str(REPO / "square-hole-handoff" / "reference"))
from fee_policy_model import Ledger  # noqa: E402

WHOLE = 10**18  # raw units per whole token (18 decimals)
FIXED_WHOLE_SUPPLY = 10**9  # F10: every launch has exactly 1e9 whole tokens
FIXED_SUPPLY = FIXED_WHOLE_SUPPLY * WHOLE  # 1e27 raw
Q = 10**18  # one whole Q (18 decimals)

# Parties. 0..3 are eligible accounts, 4 is the market (the launcher inventory, excluded like the model's
# 'market'), 5 the pool manager (a second excluded role, used by the custody scenario). On chain: alice/bob plain
# EOAs, carol an EIP-7702 EOA, dave a skip-NFT contract. 'fee_collector' and 'treasury' are excluded model parties
# reached only through fee, donation and sweep steps.
ACCOUNTS = ["alice", "bob", "carol", "dave"]
MARKET = 4
POOL = 5
PARTY = ACCOUNTS + ["market", "pool_manager"]
EXCLUDED = {"fee_collector", "market", "pool_manager", "treasury"}  # the model's defaults plus two roles
NFT_SENDERS = {0, 1, 2}  # non-skip accounts: their NFT count is always floor(balance / unit)

OP_TRANSFER, OP_NFT, OP_FEE, OP_CLAIM_Q, OP_CLAIM_T, OP_DONATE_T, OP_SWEEP_T, OP_PROCESS = range(8)
FEE_DEFER = 1  # OP_FEE opB: burn stays pending on chain until OP_PROCESS (the model burns at recognition)
MAX_MOVE_UNITS = 30  # keeps NFT materialization per replayed transfer small (in NFTs)


class Scenario:
    def __init__(self, name: str, seed: int, payout_t: bool, collection_size: int):
        self.name = name
        self.seed = seed
        self.payout_t = payout_t
        assert 1 <= collection_size <= FIXED_WHOLE_SUPPLY, "1 <= N <= 1e9"
        assert FIXED_SUPPLY % collection_size == 0, "N must divide 1e27 (every NFT an exact unit)"
        self.collection_size = collection_size
        # SquareHoleToken.fractionsPerNft: whole tokens per NFT when an integer, else 0.
        self.fractions_per_nft = (
            FIXED_WHOLE_SUPPLY // collection_size if FIXED_WHOLE_SUPPLY % collection_size == 0 else 0
        )
        self.unit = FIXED_SUPPLY // collection_size  # raw units per NFT (SquareHoleToken.unit)
        supply = FIXED_SUPPLY
        self.model = Ledger({"market": supply, "fee_collector": 0}, excluded=EXCLUDED)
        self.imodel = Ledger({"market": supply, "fee_collector": 0}, excluded=EXCLUDED)
        self.carry = 0  # FeeCollector.qRemainder
        self.claimed = [Fraction(0)] * len(ACCOUNTS)
        self.iclaimed = [Fraction(0)] * len(ACCOUNTS)
        self.fee_events = 0
        self.non_multiple_q = False
        self.receipt = 0
        self.ops: list[tuple[int, int, int, int, int, int]] = []
        self.expected: list[dict] = []

    # --- operations (each mirrors one on-chain step) -------------------------------------------------------
    def _move(self, sender: str, receiver: str, amount: int) -> None:
        """An ownership move, applied identically to both model instances."""
        self.model.transfer(sender, receiver, amount)
        self.imodel.transfer(sender, receiver, amount)

    def transfer(self, a: int, b: int, amount: int) -> None:
        self._move(PARTY[a], PARTY[b], amount)
        self._record(OP_TRANSFER, a, b, amount, 0, 0)

    def nft(self, a: int, b: int) -> None:
        self._move(PARTY[a], PARTY[b], self.unit)
        self._record(OP_NFT, a, b, self.unit, 0, 0)

    def fee(self, t: int, q: int, defer_burn: bool = False) -> None:
        # Native fee T moves from the market into fee-collector custody, then the receipt is recognized.
        if t:
            self._move("market", "fee_collector", t)
        self.receipt += 1
        rid = f"r{self.receipt}"
        self.model.recognize_fees(rid, t, q)
        # FeeCollector.receiveFees: X = q + carry; protocol floor(X/3), holders 2*floor(X/3); X mod 3 carried.
        x = q + self.carry
        self.carry = x % 3
        self.imodel.recognize_fees(rid, t, x - self.carry)
        self.fee_events += 1
        if q % 3:
            self.non_multiple_q = True
        self._record(OP_FEE, 0, FEE_DEFER if defer_burn else 0, 0, t, q)

    def claim_q(self, a: int) -> None:
        self.claimed[a] += self.model.claim_q(PARTY[a])
        self.iclaimed[a] += self.imodel.claim_q(PARTY[a])
        self._record(OP_CLAIM_Q, a, 0, 0, 0, 0)

    def claim_t(self, a: int, t_out: int) -> None:
        q_in, _ = self.model.claim_t(PARTY[a], t_out, 0)
        self.claimed[a] += q_in
        # On chain: converter claimFor (pays the floored entitlement, possibly 0) then a market -> holder transfer.
        # claim_q + transfer is claim_t without its "earned Q > 0" precondition, which the integer split can miss.
        self.iclaimed[a] += self.imodel.claim_q(PARTY[a])
        self.imodel.transfer("market", PARTY[a], t_out)
        self._record(OP_CLAIM_T, a, 0, t_out, 0, 0)

    def donate_t(self, a: int, amount: int) -> None:
        """Unsolicited T sent to the fee collector: never a fee event, never burned."""
        self._move(PARTY[a], "fee_collector", amount)
        self._record(OP_DONATE_T, a, 0, amount, 0, 0)

    def sweep_t(self) -> None:
        """FeeCollector.sweepUnaccounted(T): every donated T (the model burns fee T at recognition) to the treasury."""
        amount = int(self.model.balances.get("fee_collector", 0))
        self._move("fee_collector", "treasury", amount)
        self._record(OP_SWEEP_T, 0, 0, amount, 0, 0)

    def process(self) -> None:
        """FeeCollector.processFees after deferred burns; no economic change in the model."""
        self._record(OP_PROCESS, 0, 0, 0, 0, 0)

    def _record(self, kind: int, a: int, b: int, amount: int, t: int, q: int) -> None:
        m = self.model
        m.assert_invariants()
        self.imodel.assert_invariants()
        assert self.imodel.balances == m.balances and self.imodel.burned == m.burned
        self.ops.append((kind, a, b, amount, t, q))
        bound = 1 + (2 * self.fee_events if self.non_multiple_q else 0)
        self.expected.append(
            {
                "balances": [int(m.balances.get(p, 0)) for p in ACCOUNTS],
                "cumulative": [math.floor(self.claimed[i] + m.pending(p)) for i, p in enumerate(ACCOUNTS)],
                "cumulativeInt": [
                    math.floor(self.iclaimed[i] + self.imodel.pending(p)) for i, p in enumerate(ACCOUNTS)
                ],
                "supply": int(m.supply),
                "burned": int(m.burned),
                "qReceived": int(m.q_received),
                "protocolFloor": math.floor(m.q_protocol),
                "bound": bound,
            }
        )

    def balance(self, p: int) -> int:
        return int(self.model.balances.get(PARTY[p], 0))

    def to_json(self) -> dict:
        n = len(self.ops)
        flat = lambda key: [str(v) for e in self.expected for v in e[key]]  # noqa: E731
        return {
            "name": self.name,
            "seed": self.seed,
            "generator": "packages/contracts/script-py/gen_vectors.py",
            "model": "square-hole-handoff/reference/fee_policy_model.py",
            "payoutT": self.payout_t,
            "fractionsPerNft": str(self.fractions_per_nft),
            "collectionSize": str(self.collection_size),
            "unit": str(self.unit),
            "numAccounts": len(ACCOUNTS),
            "steps": n,
            "opKind": [o[0] for o in self.ops],
            "opA": [o[1] for o in self.ops],
            "opB": [o[2] for o in self.ops],
            "opAmount": [str(o[3]) for o in self.ops],
            "opT": [str(o[4]) for o in self.ops],
            "opQ": [str(o[5]) for o in self.ops],
            "expBalances": flat("balances"),
            "expCumulative": flat("cumulative"),
            "expCumulativeInt": flat("cumulativeInt"),
            "expSupply": [str(e["supply"]) for e in self.expected],
            "expBurned": [str(e["burned"]) for e in self.expected],
            "expQReceived": [str(e["qReceived"]) for e in self.expected],
            "expProtocolFloor": [str(e["protocolFloor"]) for e in self.expected],
            "expBound": [e["bound"] for e in self.expected],
        }


# --- scenarios ------------------------------------------------------------------------------------------------


def worked_example() -> Scenario:
    """05-ECONOMICS worked example: Alice 25 / Bob 75 eligible T, a fee event of 30 T and 3 Q (one NFT = one token:
    N = 1e9)."""
    s = Scenario("spec05-worked-example", 0, False, 1_000_000_000)
    u = s.unit
    s.transfer(MARKET, 0, 25 * u)
    s.transfer(MARKET, 1, 75 * u)
    s.fee(30 * u, 3 * Q)
    s.claim_q(0)
    s.transfer(0, 2, 0)  # no-op transfer still settles
    s.transfer(1, 2, 75 * u)  # bob sells everything; keeps his 1.5 Q
    s.fee(0, 3 * Q)
    s.claim_q(1)
    s.claim_q(2)
    return s


def zero_eligible_bootstrap() -> Scenario:
    """Model test_zero_supply_carry_only_allocates_on_next_checkpoint, plus a T-only release."""
    s = Scenario("model-zero-eligible-bootstrap", 0, False, 1_000_000_000)
    u = s.unit
    s.fee(10 * u, 3 * Q)  # no eligible T: 2 Q deferred
    s.transfer(MARKET, 0, 10 * u)
    s.fee(0, 3 * Q)  # releases 2 + 2 Q to alice
    s.transfer(0, MARKET, 10 * u)
    s.fee(0, 6 * Q)  # deferred again
    s.transfer(MARKET, 1, 5 * u)
    s.transfer(MARKET, 2, 15 * u)
    s.fee(u, 0)  # a T-only fee event is a valid checkpoint and releases the bootstrap
    s.claim_q(0)
    s.claim_q(1)
    s.claim_q(2)
    return s


def random_scenario(name: str, seed: int, steps: int, *, payout_t: bool, q_multiple_of_3: bool, size: int,
                    dust: bool = False, custody: bool = False) -> Scenario:
    """`custody` adds T donations to the collector and sweeps, the pool manager as a counterparty and deferred
    burns. Its extra random draws happen only when `custody` is set, so the other scenarios' streams are unchanged."""
    rng = Random(seed)
    s = Scenario(name, seed, payout_t, size)
    u = s.unit
    max_move = MAX_MOVE_UNITS * u
    parties = 6 if custody else 5
    for _ in range(steps):
        if custody:
            c = rng.random()
            if c < 0.06:  # donation of T to the fee collector
                a = rng.randrange(4)
                s.donate_t(a, rng.randrange(0, min(s.balance(a), 3 * u) + 1))
                continue
            if c < 0.09:
                if s.model.balances.get("fee_collector", 0) > 0:
                    s.sweep_t()
                continue
            if c < 0.12:
                s.process()
                continue
        r = rng.random()
        if r < 0.40:  # ERC-20 transfer (buys from the market, sells to it, holder to holder)
            a = rng.randrange(parties)
            b = rng.randrange(parties)
            bal = s.balance(a)
            choice = rng.random()
            if dust or choice < 0.2:
                amount = rng.randrange(0, min(bal, 1_000) + 1)
            elif choice < 0.6:
                amount = bal * rng.randrange(0, 11) // 10
            else:
                amount = rng.randrange(0, bal + 1)
            s.transfer(a, b, min(amount, max_move))
        elif r < 0.50:  # whole NFT through the mirror
            senders = [a for a in NFT_SENDERS if s.balance(a) >= u]
            if not senders:
                continue
            a = rng.choice(senders)
            b = rng.choice([x for x in range(parties) if x != a])
            s.nft(a, b)
        elif r < 0.75:  # fee event
            t = rng.randrange(0, min(s.balance(MARKET), 5 * u) + 1) if rng.random() < 0.5 else 0
            if dust:
                q = rng.randrange(0, 12)
            else:
                q = rng.randrange(0, 10**21)
            if q_multiple_of_3:
                q -= q % 3
            if t == 0 and q == 0:
                q = 3
            s.fee(t, q, defer_burn=custody and rng.random() < 0.5)
        else:  # claim
            a = rng.randrange(4)
            if payout_t:
                if s.model.pending(ACCOUNTS[a]) <= 0 or s.balance(MARKET) == 0:
                    continue
                t_out = rng.randrange(1, min(s.balance(MARKET), 10 * u) + 1)
                s.claim_t(a, t_out)
            else:
                s.claim_q(a)
    return s


def scenarios() -> list[Scenario]:
    return [
        worked_example(),
        zero_eligible_bootstrap(),
        # N = 1,000 (1,000,000 tokens per NFT), N = 1 (the whole supply is one NFT), N = 1,000,000 (1,000 tokens).
        random_scenario("random-q-multiple-of-3-seed42", 42, 400, payout_t=False, q_multiple_of_3=True, size=1_000),
        random_scenario("random-any-q-seed7", 7, 400, payout_t=False, q_multiple_of_3=False, size=1),
        random_scenario("random-payout-t-seed11", 11, 300, payout_t=True, q_multiple_of_3=True, size=1_000_000),
        # Units that are not a whole number of tokens: N = 8,192 (122,070.3125) and N = 1,024 (976,562.5 tokens).
        random_scenario("dust-seed5", 5, 300, payout_t=False, q_multiple_of_3=False, size=8_192, dust=True),
        random_scenario("custody-seed13", 13, 400, payout_t=False, q_multiple_of_3=False, size=1_024, custody=True),
    ]


def main() -> int:
    check = "--check" in sys.argv[1:]
    out_dir = CONTRACTS / "test" / "vectors"
    out_dir.mkdir(parents=True, exist_ok=True)
    stale = []
    for s in scenarios():
        text = json.dumps(s.to_json(), indent=1, sort_keys=True) + "\n"
        path = out_dir / f"{s.name}.json"
        if check:
            if not path.exists() or path.read_text() != text:
                stale.append(path.name)
        else:
            path.write_text(text)
        print(f"{s.name}: steps={len(s.ops)} fee_events={s.fee_events} seed={s.seed} payoutT={s.payout_t}")
    if stale:
        print("stale vectors:", ", ".join(stale), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
