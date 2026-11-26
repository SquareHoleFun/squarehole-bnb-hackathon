#!/usr/bin/env python3
"""The launch-window tax table (F33; docs/research/sniper-tax.md § 3.1), recomputed from the launch shape.

tax(b) = 1 - k^(-(32 - b) / 32) for the blocks b = 0 … 31 after the announced open, with k = P1 / P0 of the curve.
The curve spans ticks 177,180 … 204,060 (src/v2/genesis/FitLaunchShape.sol), so k = 1.0001^26,880 and each of the 32
steps is 840 ticks. Entries are pips (10^6 = 100%), rounded to the nearest pip. 80-digit Decimal arithmetic, standard
library only, deterministic.

Usage (from packages/contracts):
  python3 script-py/launch_tax_table.py           # print k, the table, its keccak256 and the research's k = 14.69 list
  python3 script-py/launch_tax_table.py --check   # exit 1 unless src/v2/LaunchTaxRouter.sol holds exactly this table
"""

from __future__ import annotations

import argparse
import re
import sys
from decimal import Decimal, getcontext
from pathlib import Path

from rehearsal_name_scan import keccak256  # standard-library keccak-256, same directory

getcontext().prec = 80

TICK_LOWER = 177_180
TICK_UPPER = 204_060
WINDOW = 32
PIPS = 1_000_000
ROUTER = Path(__file__).resolve().parent.parent / "src" / "v2" / "LaunchTaxRouter.sol"


def table(k: Decimal) -> list[tuple[int, Decimal]]:
    """(pips rounded to nearest, exact pips) per block."""
    rows = []
    for b in range(WINDOW):
        exact = (1 - k ** (-Decimal(WINDOW - b) / Decimal(WINDOW))) * PIPS
        rows.append((int(exact.to_integral_value()), exact))
    return rows


def router_table() -> list[int]:
    src = ROUTER.read_text()
    body = src.split("function taxTable()", 1)[1].split("return [", 1)[1].split("];", 1)[0]
    return [int(v.replace("_", "")) for v in re.findall(r"(?<![\w])(\d[\d_]*)(?![\w])", body)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="compare with the router's hard-coded table")
    args = ap.parse_args()

    span = TICK_UPPER - TICK_LOWER
    assert span % WINDOW == 0, "the window must split the curve into whole tick steps"
    k = Decimal("1.0001") ** span
    rows = table(k)
    pips = [p for p, _ in rows]
    margin = min(abs((e - int(e)) - Decimal("0.5")) for _, e in rows)
    encoded = b"".join(p.to_bytes(32, "big") for p in pips)  # abi.encode(uint24[32]) = 32 words
    print(f"k = 1.0001^{span} = {k:.12f}; step = 1.0001^{span // WINDOW} = {Decimal('1.0001') ** (span // WINDOW):.9f}")
    print(f"closest entry to a rounding boundary: {margin:.6f} pips")
    print("| Block after the open | Launch tax | Pips |")
    print("|---:|---:|---:|")
    for b, (p, e) in enumerate(rows):
        print(f"| {b} | {e / 10_000:.4f}% | {p:,} |")
    print("| 32 and later | 0 | 0 |")
    print(f"keccak256(abi.encode(taxTable())) = 0x{keccak256(encoded).hex()} (the hash to publish with the launch)")
    research = [p for p, _ in table(Decimal("14.69"))]
    print(f"research § 3.1 (k = 14.69): {research}")
    print(f"this table minus the research's: {[a - b for a, b in zip(pips, research)]}")

    if args.check:
        onchain = router_table()
        if onchain != pips:
            print(f"MISMATCH: router has {onchain}")
            return 1
        print(f"router table matches ({ROUTER.name}, {len(onchain)} entries)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
