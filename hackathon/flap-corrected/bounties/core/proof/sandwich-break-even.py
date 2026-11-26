#!/usr/bin/env python3
"""The best sandwich against our capped buys on a PancakeSwap V2 pool, in integer math (Flap's pre-audit finding R2).

  python3 bounties/core/proof/sandwich-break-even.py

Built on an earlier version of this measurement (the pool, the tax model and the search); this version adds the
minimum output and front-runs up to 1000 times the pool. No floats anywhere.

Pool: constant product, 0.25% fee on each swap (PancakeSwap V2: amountIn x 9975 / 10000), quote reserve X = 100e18,
token reserve Y = 1e27. The token's tax is taken in tokens: `buy` bps of what a buyer receives, `sell` bps of what a seller sends. `n` of our buyers buy one after the
other inside the attacker's sandwich (the case measured: a splitter and three shops of the same token in one
transaction; not a ceiling, as any number of shops can exist for one token). The
attacker front-runs with a quote amount `a`, searched log-spaced from X / 10^6 to 1000 X (200 steps a decade, and every
0.001% of X up to 5% of X), and sells everything it bought right after. Printed: the attacker's best profit as bps of
what our buyers spent ("0" = no front-run size searched makes a profit).

Tables:
  A. the buy's size fixed BEFORE the front-run (k bps of the settled X): where 25 bps comes from;
  B. the guard as built: the cap (k bps of the quote reserve) and the minimum output read in the same transaction,
     after the front-run; the minimum (output x 88.7%) is checked and never binds.
"""

F = 9975  # PancakeSwap V2 fee: 0.25%
X = 100 * 10**18
Y = 10**27
MIN_KEEP = 10_000 - 1000 - 30 - 100  # PairPriceGuard.minimumOut: tax room 10%, fee room 0.3%, slippage 1%


def out(ain, rin, rout):
    a = ain * F
    return a * rout // (rin * 10000 + a)


def sizes():
    s = set()
    for i in range(1, 5001):  # 0.001% .. 5% of X in steps of 0.001%
        s.add(X * i // 100000)
    for e in range(-6, 3):  # decades 10^-6 X .. 10^3 X, 200 log-spaced steps a decade (x 10^(j/200), integer)
        for j in range(200):
            num = 10 ** (6 + e) * _pow10_frac(j)
            s.add(X * num // 10**6 // 10**12)
    s.add(1000 * X)
    s.discard(0)
    return sorted(s)


def _pow10_frac(j):
    """10^(j/200) scaled by 10^12, by integer bisection (no floats)."""
    target = 10 ** (12 * 200 + j)  # (10^12 x 10^(j/200))^200 = 10^(2400 + j)
    lo, hi = 10**12, 10**13
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if mid**200 <= target:
            lo = mid
        else:
            hi = mid - 1
    return lo


SIZES = sizes()


def best(k, n, buy, sell, mode):
    """The attacker's best profit (quote units) and what our buyers spent at that size."""
    best_p, spent_at_best = 0, 0
    for a in SIZES:
        x, y = X, Y
        t = out(a, x, y)
        x, y = x + a, y - t
        t = t * (10000 - buy) // 10000
        spent = 0
        for _ in range(n):
            if mode == "A":
                v = X * k // 10000
            else:
                v = x * k // 10000  # the cap, read now: after the front-run
            raw = v * y // (x + v)
            minimum = raw * MIN_KEEP // 10000
            tv = out(v, x, y)
            arrives = tv * (10000 - buy) // 10000
            assert arrives >= minimum or buy > 1000, "the minimum would refuse a buy"
            x, y = x + v, y - tv
            spent += v
        s = t * (10000 - sell) // 10000
        q = out(s, y, x)
        p = q - a
        if p > best_p:
            best_p, spent_at_best = p, spent
    return best_p, spent_at_best


def row(k, n, buy, sell, mode):
    p, spent = best(k, n, buy, sell, mode)
    if p == 0:
        return "0"
    return f"{p * 10000 // spent} bps"


TAXES = [(0, 0), (100, 100), (300, 500)]


def header():
    return "  k (bps)  " + "".join(f"tax {b}/{s}".ljust(16) for b, s in TAXES)


def table(title, ks, n, mode):
    print(title)
    print(header())
    for k in ks:
        print(f"  {k:<8} " + "".join(row(k, n, b, s, mode).ljust(16) for b, s in TAXES))


if __name__ == "__main__":
    print(f"front-run sizes searched: {len(SIZES)}, from {SIZES[0]} to {SIZES[-1]} quote units (X = {X})")
    print("best sandwich profit, as bps of what our buyers spent (0 = never profitable)")
    table("A. one buy of k bps of X, its size fixed before the front-run:", [5, 10, 20, 25, 30, 50, 100, 400, 1000], 1, "A")
    table("B. the guard: one buy capped at k bps of the quote reserve read after the front-run:", [5, 25, 100], 1, "B")
    table("B. the guard: four buys bundled, each capped at k bps at its moment:", [5], 4, "B")
