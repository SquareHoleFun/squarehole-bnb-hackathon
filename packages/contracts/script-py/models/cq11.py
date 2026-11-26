"""CQ11 oracle derived from ADR-0017 Amendment 3 C3/C5/C9/C11/C13.

Python integers and exact rational shares are independent of Solidity's widths,
FullMath, storage layout and branching. This module never reads source, artifacts,
chain state or expected vectors. Inputs/outputs at the CLI boundary are decimal
strings / ABI words; no floating point or external dependency is used.

M1 choices: 1 keep, 2 burn, 3 grow. Later holder/item ledgers are out of scope.
The raise ratios pin the production spec: R=4.206980085 ETH; bootstrap=0.0015 ETH,
batch/step=0.005 ETH and tip cap=0.0005 ETH (C13's existing constants).
"""
from fractions import Fraction
from math import ceil, floor
import sys


def split(buyers: int, sellers: int, buyer_choice: int, seller_choice: int) -> list[int]:
    """Cumulative side totals give the same carries regardless of collect batching.

    Return FIT, platform, pool, keep, burn, grow, buyers carry, sellers carry.
    Complete fifteenths are allocated in exact rational shares; dust stays separate.
    """
    result = [0] * 8
    for side, (amount, choice) in enumerate(((buyers, buyer_choice), (sellers, seller_choice))):
        if choice not in (1, 2, 3):
            raise ValueError("M1 choice required")
        dust = amount % 15
        distributable = amount - dust
        for ledger, share in ((0, Fraction(2, 15)), (1, Fraction(1, 15)),
                              (2, Fraction(2, 15)), (choice + 2, Fraction(10, 15))):
            allocation = distributable * share
            assert allocation.denominator == 1
            result[ledger] += int(allocation)
        result[6 + side] = dust
    assert sum(result) == buyers + sellers
    return result


def snapshot(raise_amount: int) -> list[int]:
    if not 1_000_000 <= raise_amount < 2**128:
        raise ValueError("raise outside admitted numeric bounds")
    # Immutable snapshot value, followed by the four raw P thresholds.
    baseline = 4_206_980_085_000_000_000
    thresholds = (1_500_000_000_000_000, 5_000_000_000_000_000, 500_000_000_000_000, 5_000_000_000_000_000)
    return [raise_amount, *(ceil(Fraction(raise_amount * threshold, baseline)) for threshold in thresholds)]


def evaluate(operation: str, values: list[int]) -> list[int]:
    if any(type(value) is not int or value < 0 for value in values):
        raise ValueError("unsigned raw integers required")
    if operation == "sale":
        kind, amount = values
        if kind == 0:  # exact in: only the P which actually filled is taxable
            fee = ceil(Fraction(amount, 100))
            return [fee, amount, amount - fee]
        if kind == 1:  # exact out: gross up net at a 99% seller share
            gross = ceil(Fraction(amount * 100, 99))
            return [gross - amount, gross, amount]
        raise ValueError("sale kind must be 0 (gross) or 1 (net)")
    if operation == "split":
        return split(*values)
    if operation == "claim":
        pot, outstanding, tendered = values
        if not 0 < tendered <= outstanding:
            raise ValueError("invalid holder claim")
        # No special last-claimer branch: the rational fraction becomes exactly one.
        payout = floor(Fraction(pot * tendered, outstanding))
        return [payout, pot - payout, outstanding - tendered]
    if operation == "failure":
        principal, reserve, buyers, sellers, bc, sc, tip_cap = values
        fit, platform, pool, keep, burn, grow, b_dust, s_dust = split(buyers + reserve, sellers, bc, sc)
        pot = principal + pool + keep + burn + grow + b_dust + s_dust
        tip = min(tip_cap, pot)
        result = [pot - tip, fit, platform, tip]
        assert sum(result) == principal + reserve + buyers + sellers
        return result
    if operation == "hatch":
        filled_at, now, filled, graduated, failed = values
        boundary = filled_at + 7 * 24 * 60 * 60
        return [int(bool(filled) and not graduated and not failed and now >= boundary), boundary]
    if operation == "late":
        pot, outstanding, unpaid_creator = values
        return [0, pot]  # RC5: no sweep exists, even with no outstanding T.
    if operation == "raise":
        old, new = values
        return snapshot(old) + snapshot(new)
    if operation == "step":
        last, current, protocol = values
        allowed = not protocol or last != current
        return [int(allowed), current if protocol and allowed else last]
    raise ValueError(f"unknown operation: {operation}")


if __name__ == "__main__":
    result = evaluate(sys.argv[1], [int(value) for value in sys.argv[2:]])
    # ABI uint256[]; stdout contains only the oracle response.
    print("0x" + "".join(value.to_bytes(32, "big").hex() for value in [32, len(result), *result]))
