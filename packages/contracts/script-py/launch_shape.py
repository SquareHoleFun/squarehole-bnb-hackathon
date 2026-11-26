#!/usr/bin/env python3
"""The launch shape's hard-coded constants (src/v2/genesis/FitLaunchShape.sol), recomputed with exact v4 math.

F40 (L6) sets the raise to exactly R = 4,206,980,085,000,000,000 wei (F15 D5) on the unchanged range: ticks
177,180 ... 204,060 (spacing 60, k = 1.0001^26,880), so the tick-aligned curve no longer raises 4.2168 ETH. The ETH a
fully crossed single-sided range holds is getAmount0Delta(P1, P0, L, roundDown), a step function of the liquidity L:
about 9,500 consecutive values of L give exactly R. The rule used here: **the smallest L that raises exactly R**
(one unit less raises R - 1 wei), and the curve's FIT is exactly what that position takes,
getAmount1Delta(P1, P0, L, roundUp), so the approval is used up to the raw unit and no dust is left. The pool share
is the rest of the 1e27 raw FIT.

Everything is integer arithmetic ported line by line from the pinned v4-core 46c6834 (TickMath.getSqrtPriceAtTick,
SqrtPriceMath.getAmount0Delta / getAmount1Delta / getNextSqrtPriceFromAmount0RoundingUp, SwapMath.computeSwapStep's
exact-input branch, FullMath) and v4-periphery 9969eec (LiquidityAmounts.getLiquidityForAmount1). Standard library
only, deterministic. The Solidity test test/v2/genesis/FitLaunchShape.t.sol recomputes the same values from the
pinned libraries themselves.

Graduation (T16/T17; F40 L1): the migration seeds layout b' at exactly P1 with the fully crossed curve's ETH (R) and
the pool share: bid [177,180, 204,060] with floor(R x 99 / 100), bid sentinel [204,060, 887,220] with the rest, ask
[-887,220, 177,180] with the whole pool share. Liquidities by LiquidityAmounts.getLiquidityForAmount0 / ...Amount1 (as
the hook computes them on chain), amounts taken by getAmount0Delta / getAmount1Delta rounded up (as the pool charges an
add); the FIT the ask cannot take is the dust the genesis burns. Also the eps band's sqrt price (tick 177,190) and the
usable-range sqrt prices (+-887,220).

The general layout library (launch pipeline v1 § 1, slice S1; extended by CQ9-4 for v2): `box_curve` and
`box_graduated` port src/box-v2/libraries/BoxLayoutV2.sol for any raise and either token order. The centre stays
v1-identical for every previously buildable raise; only formerly overflowing P-first small raises change. It reads
the fixed values from
packages/box-spec/box-spec.v1.json. `--check` also asserts that they return this file's constants for box 0 (BC-002);
`--write-layout-vectors` / `--check-layout-vectors` write and check test/vectors/box-spec/layout-v1.json, which Foundry
(test/box/BoxLayoutV1.t.sol) and vitest (packages/box-spec/src/layout.test.ts) replay (BC-003).

Usage (from packages/contracts):
  python3 script-py/launch_shape.py           # print the constants, the bootstrap buy and the old shape for comparison
  python3 script-py/launch_shape.py --check   # exit 1 unless FitLaunchShape.sol holds exactly these constants
  python3 script-py/launch_shape.py --write-layout-vectors   # write test/vectors/box-spec/layout-v1.json
  python3 script-py/launch_shape.py --check-layout-vectors   # exit 1 when that file is stale
  python3 script-py/launch_shape.py --check-small-raises     # v2 vectors and independent exact-centre bounds
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

Q96 = 1 << 96
U256_MAX = (1 << 256) - 1
MAX_TICK = 887_272
MAX_SWAP_FEE = 1_000_000

ISSUANCE = 10**27
RAISE_TARGET_WEI = 4_206_980_085_000_000_000  # F15 (D5), F23 C1, F40 (L6)
TICK_LOWER = 177_180
TICK_UPPER = 204_060
MIN_USABLE_TICK = -887_220
MAX_USABLE_TICK = 887_220
EPS_TICKS = 10
REOPEN_TICKS = 600  # the reopening margin (ADR-0013 § 2.3b, security review 2026-09-30)
BID_SHARE_PERCENT = 99
LP_FEE = 10_000
BOOTSTRAP_ETH = 1_500_000_000_000_000  # 0.0015 ETH
OLD_CURVE_FIT = 800_000_000 * 10**18  # the shape before F40 (L6): 80% of FIT, raise 4.2168 ETH

SHAPE = Path(__file__).resolve().parent.parent / "src" / "v2" / "genesis" / "FitLaunchShape.sol"
REPO = Path(__file__).resolve().parents[3]
BOX_SPEC = REPO / "packages" / "box-spec" / "box-spec.v1.json"
BOX_CASES = REPO / "packages" / "box-spec" / "vectors" / "cases.v1.json"
LAYOUT_VECTORS = REPO / "packages" / "contracts" / "test" / "vectors" / "box-spec" / "layout-v1.json"
MIN_TICK = -MAX_TICK
MIN_SQRT_PRICE = 4_295_128_739  # TickMath.MIN_SQRT_PRICE
MAX_SQRT_PRICE = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342  # TickMath.MAX_SQRT_PRICE

# TickMath.sol: the factors for bits 0x2 ... 0x80000 of |tick|
_BIT_FACTORS = (
    (0x2, 0xFFF97272373D413259A46990580E213A),
    (0x4, 0xFFF2E50F5F656932EF12357CF3C7FDCC),
    (0x8, 0xFFE5CACA7E10E4E61C3624EAA0941CD0),
    (0x10, 0xFFCB9843D60F6159C9DB58835C926644),
    (0x20, 0xFF973B41FA98C081472E6896DFB254C0),
    (0x40, 0xFF2EA16466C96A3843EC78B326B52861),
    (0x80, 0xFE5DEE046A99A2A811C461F1969C3053),
    (0x100, 0xFCBE86C7900A88AEDCFFC83B479AA3A4),
    (0x200, 0xF987A7253AC413176F2B074CF7815E54),
    (0x400, 0xF3392B0822B70005940C7A398E4B70F3),
    (0x800, 0xE7159475A2C29B7443B29C7FA6E889D9),
    (0x1000, 0xD097F3BDFD2022B8845AD8F792AA5825),
    (0x2000, 0xA9F746462D870FDF8A65DC1F90E061E5),
    (0x4000, 0x70D869A156D2A1B890BB3DF62BAF32F7),
    (0x8000, 0x31BE135F97D08FD981231505542FCFA6),
    (0x10000, 0x9AA508B5B7A84E1C677DE54F3E99BC9),
    (0x20000, 0x5D6AF8DEDB81196699C329225EE604),
    (0x40000, 0x2216E584F5FA1EA926041BEDFE98),
    (0x80000, 0x48A170391F7DC42444E8FA2),
)


def div_up(a: int, b: int) -> int:
    q, r = divmod(a, b)
    return q + 1 if r else q


def sqrt_price_at_tick(tick: int) -> int:
    """TickMath.getSqrtPriceAtTick."""
    abs_tick = abs(tick)
    if abs_tick > MAX_TICK:
        raise ValueError(f"InvalidTick({tick})")
    price = 0xFFFCB933BD6FAD37AA2D162D1A594001 if abs_tick & 0x1 else 1 << 128
    for bit, factor in _BIT_FACTORS:
        if abs_tick & bit:
            price = (price * factor) >> 128
    if tick > 0:
        price = U256_MAX // price
    return (price + (1 << 32) - 1) >> 32


def amount0_delta(a: int, b: int, liquidity: int, round_up: bool) -> int:
    """SqrtPriceMath.getAmount0Delta."""
    a, b = min(a, b), max(a, b)
    numerator1, numerator2 = liquidity << 96, b - a
    if round_up:
        return div_up(div_up(numerator1 * numerator2, b), a)
    return (numerator1 * numerator2 // b) // a


def amount1_delta(a: int, b: int, liquidity: int, round_up: bool) -> int:
    """SqrtPriceMath.getAmount1Delta."""
    q, r = divmod(liquidity * abs(b - a), Q96)
    return q + 1 if (round_up and r) else q


def liquidity_for_amount1(a: int, b: int, amount1: int) -> int:
    """LiquidityAmounts.getLiquidityForAmount1."""
    return amount1 * Q96 // (max(a, b) - min(a, b))


def liquidity_for_amount0(a: int, b: int, amount0: int) -> int:
    """LiquidityAmounts.getLiquidityForAmount0."""
    a, b = min(a, b), max(a, b)
    return amount0 * (a * b // Q96) // (b - a)


def migration(raise_wei: int, pool_share: int) -> dict[str, int]:
    """Layout b' at exactly P1 for a curve holding `raise_wei` and no FIT (FitPoolHook._seedLayout)."""
    p1, p0 = sqrt_price_at_tick(TICK_LOWER), sqrt_price_at_tick(TICK_UPPER)
    smin, smax = sqrt_price_at_tick(MIN_USABLE_TICK), sqrt_price_at_tick(MAX_USABLE_TICK)
    l_bid = liquidity_for_amount0(p1, p0, raise_wei * BID_SHARE_PERCENT // 100)
    bid_eth = amount0_delta(p1, p0, l_bid, True)
    l_sentinel = liquidity_for_amount0(p0, smax, raise_wei - bid_eth)
    sentinel_eth = amount0_delta(p0, smax, l_sentinel, True)
    l_ask = liquidity_for_amount1(smin, p1, pool_share)
    ask_fit = amount1_delta(smin, p1, l_ask, True)
    return {
        "SQRT_PRICE_BAND_X96": sqrt_price_at_tick(TICK_LOWER + EPS_TICKS),
        "SQRT_PRICE_REOPEN_X96": sqrt_price_at_tick(TICK_LOWER + REOPEN_TICKS),
        "SQRT_PRICE_MIN_USABLE_X96": smin,
        "SQRT_PRICE_MAX_USABLE_X96": smax,
        "BID_ETH": bid_eth,
        "L_BID": l_bid,
        "SENTINEL_ETH": sentinel_eth,
        "L_SENTINEL": l_sentinel,
        "L_ASK": l_ask,
        "ASK_FIT": ask_fit,
        "ASK_DUST": pool_share - ask_fit,
        "ETH_DUST": raise_wei - bid_eth - sentinel_eth,
    }


def bootstrap_buy(sqrt_price: int, liquidity: int, eth_in: int) -> tuple[int, int, int]:
    """One exact-input ETH -> FIT step inside the range (SwapMath.computeSwapStep, zeroForOne, not reaching the
    target): (FIT out, ETH principal in, ETH fee)."""
    less_fee = eth_in * (MAX_SWAP_FEE - LP_FEE) // MAX_SWAP_FEE
    numerator1 = liquidity << 96
    # SqrtPriceMath.getNextSqrtPriceFromAmount0RoundingUp (adding ETH)
    sqrt_next = div_up(numerator1 * sqrt_price, numerator1 + less_fee * sqrt_price)
    return amount1_delta(sqrt_next, sqrt_price, liquidity, False), less_fee, eth_in - less_fee


def smallest_liquidity_for_raise(lower: int, upper: int, target: int) -> int:
    """The least L with getAmount0Delta(lower, upper, L, false) == target (the function is monotone in L)."""
    lo, hi = 0, 1 << 128
    while lo < hi:
        mid = (lo + hi) // 2
        if amount0_delta(lower, upper, mid, False) >= target:
            hi = mid
        else:
            lo = mid + 1
    if amount0_delta(lower, upper, lo, False) != target:
        raise ValueError("no liquidity raises the target exactly")
    return lo


def compute() -> dict[str, int]:
    lower, upper = sqrt_price_at_tick(TICK_LOWER), sqrt_price_at_tick(TICK_UPPER)
    liquidity = smallest_liquidity_for_raise(lower, upper, RAISE_TARGET_WEI)
    curve_fit = amount1_delta(lower, upper, liquidity, True)
    assert liquidity_for_amount1(lower, upper, curve_fit) == liquidity, "the curve FIT maps back to L"
    assert amount1_delta(lower, upper, liquidity, True) == curve_fit, "the position takes exactly the curve FIT"
    assert amount0_delta(lower, upper, liquidity - 1, False) == RAISE_TARGET_WEI - 1, "L is the smallest"
    fit_out, _, _ = bootstrap_buy(upper, liquidity, BOOTSTRAP_ETH)
    raise_wei = amount0_delta(lower, upper, liquidity, False)
    m = migration(raise_wei, ISSUANCE - curve_fit)
    return m | {
        "SQRT_PRICE_LOWER_X96": lower,
        "SQRT_PRICE_UPPER_X96": upper,
        "CURVE_LIQUIDITY": liquidity,
        "CURVE_FIT": curve_fit,
        "CURVE_RAISE_WEI": amount0_delta(lower, upper, liquidity, False),
        "POOL_SHARE": ISSUANCE - curve_fit,
        "BOOTSTRAP_FIT": fit_out,
    }


def fmt(raw: int, decimals: int = 18) -> str:
    whole, frac = divmod(raw, 10**decimals)
    return f"{whole:,}.{frac:0{decimals}d}"


CHECKED = ("CURVE_FIT", "SQRT_PRICE_LOWER_X96", "SQRT_PRICE_UPPER_X96", "CURVE_LIQUIDITY", "CURVE_RAISE_WEI",
           "POOL_SHARE", "SQRT_PRICE_BAND_X96", "SQRT_PRICE_REOPEN_X96", "SQRT_PRICE_MIN_USABLE_X96",
           "SQRT_PRICE_MAX_USABLE_X96", "BID_ETH", "L_BID", "SENTINEL_ETH", "L_SENTINEL", "L_ASK", "ASK_FIT", "ASK_DUST")


def solidity_constants() -> dict[str, int]:
    src = SHAPE.read_text()
    found = {}
    for name in CHECKED:
        m = re.search(rf"constant {name} =\s*([\d_]+)(e18)?;", src)
        if not m:
            raise ValueError(f"{name} not found as a literal in {SHAPE.name}")
        found[name] = int(m.group(1).replace("_", "")) * (10**18 if m.group(2) else 1)
    return found


# ---------------------------------------------------------------------------------------------------------------
# The general layout library (src/box/BoxLayoutV1.sol), for any raise and token order
# ---------------------------------------------------------------------------------------------------------------

B_PRIME = 1  # BoxSpecV1.GRAD_LAYOUT_B_PRIME
ASK_FULL_BID_SENTINEL = 2  # BoxSpecV1.GRAD_LAYOUT_ASK_FULL_BID_SENTINEL


def box_constants() -> dict[str, int]:
    """The fixed values BoxLayoutV1 reads from BoxSpecV1 (generated from box-spec.v1.json)."""
    spec = json.loads(BOX_SPEC.read_text())
    wanted = ("ISSUANCE", "CURVE_SHARE_TARGET", "TICK_SPACING", "CURVE_SPAN_TICKS", "MIN_USABLE_TICK",
              "MAX_USABLE_TICK", "BID_SHARE_PERCENT")
    found = {c["name"]: int(c["value"]) for c in spec["constants"] if c["name"] in wanted}
    if set(found) != set(wanted):
        raise ValueError(f"box-spec.v1.json lacks {set(wanted) - set(found)}")
    return found


def tick_at_sqrt_price(sqrt_price: int) -> int:
    """TickMath.getTickAtSqrtPrice: the greatest tick whose sqrt price is <= sqrt_price."""
    if not MIN_SQRT_PRICE <= sqrt_price < MAX_SQRT_PRICE:
        raise ValueError(f"InvalidSqrtPrice({sqrt_price})")
    lo, hi = MIN_TICK, MAX_TICK
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if sqrt_price_at_tick(mid) <= sqrt_price:
            lo = mid
        else:
            hi = mid - 1
    return lo


def centre_tick(raise_q: int, t_is_c0: bool, k: dict[str, int]) -> tuple[int, int]:
    """BoxLayoutV2.centreTick: v1-identical except for formerly overflowing P-first small raises."""
    if not t_is_c0 and raise_q <= k["CURVE_SHARE_TARGET"] >> 64:
        if raise_q == 0:
            raise ValueError("RaiseIsZero")
        # CQ9-4: exact Q96 root minus this root is in [0, 2^32); see the evidence's bound.
        sqrt_price = math.isqrt((k["CURVE_SHARE_TARGET"] << 128) // raise_q) << 32
    else:
        ratio = raise_q * (1 << 192) // k["CURVE_SHARE_TARGET"] if t_is_c0 else k["CURVE_SHARE_TARGET"] * (1 << 192) // raise_q
        if ratio >> 256:
            raise ValueError("FullMath.mulDiv overflow")
        sqrt_price = math.isqrt(ratio)
    if not MIN_SQRT_PRICE <= sqrt_price < MAX_SQRT_PRICE:
        raise ValueError(f"CentreOutOfRange({sqrt_price})")
    tick = tick_at_sqrt_price(sqrt_price)
    spacing = k["TICK_SPACING"]
    compressed = tick // spacing
    if tick - compressed * spacing >= spacing // 2:
        compressed += 1
    return compressed * spacing, tick


def q_amount(a: int, b: int, liquidity: int, round_up: bool, t_is_c0: bool) -> int:
    return amount1_delta(a, b, liquidity, round_up) if t_is_c0 else amount0_delta(a, b, liquidity, round_up)


def t_amount(a: int, b: int, liquidity: int, round_up: bool, t_is_c0: bool) -> int:
    return amount0_delta(a, b, liquidity, round_up) if t_is_c0 else amount1_delta(a, b, liquidity, round_up)


def to_uint128(v: int) -> int:
    if v >> 128:
        raise ValueError("LiquidityAmounts: uint128 overflow")
    return v


def q_liquidity(a: int, b: int, amount: int, t_is_c0: bool) -> int:
    return to_uint128(liquidity_for_amount1(a, b, amount) if t_is_c0 else liquidity_for_amount0(a, b, amount))


def t_liquidity(a: int, b: int, amount: int, t_is_c0: bool) -> int:
    return to_uint128(liquidity_for_amount0(a, b, amount) if t_is_c0 else liquidity_for_amount1(a, b, amount))


def smallest_liquidity(a: int, b: int, raise_q: int, t_is_c0: bool) -> int:
    """BoxLayoutV1._smallestLiquidity: the least L < 2^128 whose fully crossed range holds exactly raise_q."""
    lo, hi = 0, 1 << 128
    while lo < hi:
        mid = (lo + hi) // 2
        if q_amount(a, b, mid, False, t_is_c0) >= raise_q:
            hi = mid
        else:
            lo = mid + 1
    if lo >> 128 or q_amount(a, b, lo, False, t_is_c0) != raise_q:
        raise ValueError(f"NoExactLiquidity({raise_q})")
    return lo


def box_curve(raise_q: int, t_is_c0: bool, k: dict[str, int]) -> dict:
    """BoxLayoutV2.curve (identical to v1 on its original buildable domain)."""
    if raise_q == 0:
        raise ValueError("RaiseIsZero")
    centre, exact = centre_tick(raise_q, t_is_c0, k)
    half = k["CURVE_SPAN_TICKS"] // 2
    lower, upper = centre - half, centre + half
    if lower < k["MIN_USABLE_TICK"] or upper > k["MAX_USABLE_TICK"]:
        raise ValueError(f"CurveOutOfRange({lower}, {upper})")
    s_lower, s_upper = sqrt_price_at_tick(lower), sqrt_price_at_tick(upper)
    liquidity = smallest_liquidity(s_lower, s_upper, raise_q, t_is_c0)
    curve_t = t_amount(s_lower, s_upper, liquidity, True, t_is_c0)
    if curve_t >= k["ISSUANCE"]:
        raise ValueError(f"CurveTooLarge({curve_t})")
    start, end = (lower, upper) if t_is_c0 else (upper, lower)
    return {
        "tIsCurrency0": t_is_c0, "raise": raise_q, "centreTickExact": exact,
        "tickLower": lower, "tickUpper": upper, "tickStart": start, "tickEnd": end,
        "sqrtPriceLowerX96": s_lower, "sqrtPriceUpperX96": s_upper,
        "sqrtPriceStartX96": sqrt_price_at_tick(start), "sqrtPriceEndX96": sqrt_price_at_tick(end),
        "liquidity": liquidity, "curveT": curve_t, "poolShare": k["ISSUANCE"] - curve_t,
        "raiseHeld": q_amount(s_lower, s_upper, liquidity, False, t_is_c0),
    }


def box_full_range(c: dict, q_held: int, t_available: int, k: dict[str, int]) -> dict:
    """BoxLayoutV2.fullRange / C6: floor L at P1, round up add debits, leave unpaired dust.

    c is a validated curve; T includes the coordinator's budget. The admitted domain
    has raise in [1e6, 2^128-1], q_held <= 2^128-1, t_available <= ISSUANCE.
    Take min before narrowing so a non-limiting gift cannot overflow the position.
    """
    a = sqrt_price_at_tick(k["MIN_USABLE_TICK"])
    b = sqrt_price_at_tick(k["MAX_USABLE_TICK"])
    p = c["sqrtPriceEndX96"]
    x, y = (t_available, q_held) if c["tIsCurrency0"] else (q_held, t_available)
    liquidity = min(liquidity_for_amount0(p, b, x), liquidity_for_amount1(a, p, y))
    if liquidity >= 1 << 128:
        raise ValueError(f"FullRangeLiquidityOverflow({liquidity})")
    x = amount0_delta(p, b, liquidity, True)
    y = amount1_delta(a, p, liquidity, True)
    q, t = (y, x) if c["tIsCurrency0"] else (x, y)
    return {"tickLower": k["MIN_USABLE_TICK"], "tickUpper": k["MAX_USABLE_TICK"], "liquidity": liquidity,
            "qAmount": q, "tAmount": t, "qDust": q_held - q, "tDust": t_available - t}


def q_position(tick_a: int, tick_b: int, s_a: int, s_b: int, t_is_c0: bool, budget: int, max_liquidity: int) -> dict:
    liquidity = min(q_liquidity(s_a, s_b, budget, t_is_c0), max_liquidity)
    return {"tickLower": min(tick_a, tick_b), "tickUpper": max(tick_a, tick_b), "liquidity": liquidity,
            "amount": q_amount(s_a, s_b, liquidity, True, t_is_c0)}


def box_graduated(c: dict, grad_layout: int, q_held: int, t_available: int, k: dict[str, int]) -> dict:
    """BoxLayoutV1.graduated."""
    t_is_c0 = c["tIsCurrency0"]
    q_edge = k["MIN_USABLE_TICK"] if t_is_c0 else k["MAX_USABLE_TICK"]
    t_edge = k["MAX_USABLE_TICK"] if t_is_c0 else k["MIN_USABLE_TICK"]
    s_q_edge, s_t_edge = sqrt_price_at_tick(q_edge), sqrt_price_at_tick(t_edge)
    s_end, s_start = c["sqrtPriceEndX96"], c["sqrtPriceStartX96"]
    u128 = (1 << 128) - 1
    ask_liquidity = t_liquidity(s_t_edge, s_end, t_available, t_is_c0)
    if grad_layout == B_PRIME:
        bid = q_position(c["tickEnd"], c["tickStart"], s_end, s_start, t_is_c0,
                         q_held * k["BID_SHARE_PERCENT"] // 100, u128)
    elif grad_layout == ASK_FULL_BID_SENTINEL:
        bid = q_position(c["tickEnd"], q_edge, s_end, s_q_edge, t_is_c0, q_held, ask_liquidity)
    else:
        raise ValueError(f"UnknownGradLayout({grad_layout})")
    sentinel = q_position(c["tickStart"], q_edge, s_start, s_q_edge, t_is_c0, q_held - bid["amount"], u128)
    ask = {"tickLower": min(c["tickEnd"], t_edge), "tickUpper": max(c["tickEnd"], t_edge), "liquidity": ask_liquidity,
           "amount": t_amount(s_t_edge, s_end, ask_liquidity, True, t_is_c0)}
    return {"bid": bid, "sentinel": sentinel, "ask": ask,
            "qDust": q_held - bid["amount"] - sentinel["amount"], "tDust": t_available - ask["amount"]}


def check_general_reproduces_box0(c: dict[str, int]) -> list[str]:
    """BC-002 (Python leg): the general layout returns FitLaunchShape's constants for box 0's inputs."""
    k = box_constants()
    curve = box_curve(RAISE_TARGET_WEI, False, k)
    grad = box_graduated(curve, B_PRIME, curve["raiseHeld"], curve["poolShare"], k)
    pairs = {
        "tickLower": (curve["tickLower"], TICK_LOWER), "tickUpper": (curve["tickUpper"], TICK_UPPER),
        "SQRT_PRICE_LOWER_X96": (curve["sqrtPriceLowerX96"], c["SQRT_PRICE_LOWER_X96"]),
        "SQRT_PRICE_UPPER_X96": (curve["sqrtPriceUpperX96"], c["SQRT_PRICE_UPPER_X96"]),
        "start = P0": (curve["sqrtPriceStartX96"], c["SQRT_PRICE_UPPER_X96"]),
        "CURVE_LIQUIDITY": (curve["liquidity"], c["CURVE_LIQUIDITY"]), "CURVE_FIT": (curve["curveT"], c["CURVE_FIT"]),
        "POOL_SHARE": (curve["poolShare"], c["POOL_SHARE"]), "CURVE_RAISE_WEI": (curve["raiseHeld"], c["CURVE_RAISE_WEI"]),
        "L_BID": (grad["bid"]["liquidity"], c["L_BID"]), "BID_ETH": (grad["bid"]["amount"], c["BID_ETH"]),
        "L_SENTINEL": (grad["sentinel"]["liquidity"], c["L_SENTINEL"]),
        "SENTINEL_ETH": (grad["sentinel"]["amount"], c["SENTINEL_ETH"]),
        "L_ASK": (grad["ask"]["liquidity"], c["L_ASK"]), "ASK_FIT": (grad["ask"]["amount"], c["ASK_FIT"]),
        "ASK_DUST": (grad["tDust"], c["ASK_DUST"]), "ETH_DUST": (grad["qDust"], c["ETH_DUST"]),
    }
    return [f"{name}: general {got:,} != FitLaunchShape {want:,}" for name, (got, want) in pairs.items() if got != want]


def layout_inputs() -> list[dict]:
    """Every (Q class, decimals, raise, order) of the version contexts in box-spec.v1.json and the test context in
    cases.v1.json (the layout itself depends only on the raw raise and the order)."""
    contexts = json.loads(BOX_SPEC.read_text())["contexts"] + json.loads(BOX_CASES.read_text())["contexts"]
    seen, inputs = set(), []
    for ctx in contexts:
        for q in ctx["qList"]:
            orders = [False] if q["qClass"] == "NATIVE_ETH" else [False, True]
            for preset in q["raisePresets"]:
                for t_is_c0 in orders:
                    key = (q["qClass"], q["decimals"], int(preset), t_is_c0)
                    if key in seen:
                        continue
                    seen.add(key)
                    inputs.append({"context": ctx["name"], "q": q["label"], "qClass": q["qClass"],
                                   "decimals": q["decimals"], "raise": int(preset), "tIsCurrency0": t_is_c0})
    return inputs


def layout_vectors() -> str:
    k = box_constants()
    vectors = []
    for inp in layout_inputs():
        curve = box_curve(inp["raise"], inp["tIsCurrency0"], k)
        vector = {key: inp[key] for key in ("context", "q", "qClass", "decimals")}
        for key, v in curve.items():
            vector[key] = v if isinstance(v, bool) or key.startswith("tick") or key == "centreTickExact" else str(v)
        for name, grad in (("bPrime", B_PRIME), ("askFullBidSentinel", ASK_FULL_BID_SENTINEL)):
            g = box_graduated(curve, grad, curve["raiseHeld"], curve["poolShare"], k)
            vector[name] = {
                part: {"tickLower": g[part]["tickLower"], "tickUpper": g[part]["tickUpper"],
                       "liquidity": str(g[part]["liquidity"]), "amount": str(g[part]["amount"])}
                for part in ("bid", "sentinel", "ask")
            } | {"qDust": str(g["qDust"]), "tDust": str(g["tDust"])}
        vectors.append(vector)
    out = {
        "about": [
            "GENERATED by packages/contracts/script-py/launch_shape.py --write-layout-vectors: do not edit.",
            "BC-002/BC-003: BoxLayoutV1 (Solidity), layout.ts (TypeScript) and launch_shape.py (this file's source) agree on",
            "every curve and on both graduated layouts of the fully crossed curve (qHeld = raise, tAvailable = pool share).",
            "Inputs: every raise preset of box-spec.v1.json's contexts and of the test context in cases.v1.json, with T as",
            "currency1 and (except native ETH, always currency0) as currency0.",
        ],
        "count": len(vectors),
        "vectors": vectors,
    }
    return json.dumps(out, indent=2) + "\n"


def check_small_raises() -> None:
    """CQ9-4 / BC-003/067/215: independent unbounded-integer oracle and shared v2 vectors."""
    from random import Random

    k = box_constants()
    target = k["CURVE_SHARE_TARGET"]
    limit = target >> 64
    numerator = target << 192
    vectors = json.loads((REPO / "packages/box-spec/vectors/cases.v2.json").read_text())["layouts"]
    for v in vectors:
        r = int(v["curve"]["raise"])
        c = box_curve(r, False, k)
        for key, value in c.items():
            expected = v["curve"][key]
            assert value == (int(expected) if isinstance(expected, str) else expected), (v["name"], key)
        for name, layout in (("bPrime", B_PRIME), ("askFullBidSentinel", ASK_FULL_BID_SENTINEL)):
            g = box_graduated(c, layout, r, c["poolShare"], k)
            assert g["bid"]["amount"] + g["sentinel"]["amount"] + g["qDust"] == r
            assert g["ask"]["amount"] + g["tDust"] == c["poolShare"]
            for key, value in g.items():
                expected = v[name][key]
                if isinstance(value, dict):
                    assert value == {part: int(amount) for part, amount in expected.items()}, (v["name"], name, key)
                else:
                    assert value == int(expected), (v["name"], name, key)

    def exact_centre(r: int, order: bool = False) -> int:
        ratio = r * (1 << 192) // target if order else numerator // r
        tick = tick_at_sqrt_price(math.isqrt(ratio))
        return ((tick + 30) // 60) * 60

    rng = Random(0x435139)
    for _ in range(200_000):
        r = rng.randrange(1, limit + 1)
        exact = math.isqrt(numerator // r)
        approx = math.isqrt((target << 128) // r) << 32
        assert 0 <= exact - approx < 1 << 32
    transitions = 0
    low = tick_at_sqrt_price(math.isqrt(numerator // limit))
    high = tick_at_sqrt_price(math.isqrt(numerator))
    # Exhaust the finite affected tick interval, including its neighbours: no 2^32-wide
    # root error can cross two TickMath thresholds. This checks the actual pinned TickMath
    # integer function, without assuming an idealised real-valued exponential.
    for tick in range(low - 1, high + 2):
        assert sqrt_price_at_tick(tick + 1) - sqrt_price_at_tick(tick) > 1 << 32
    for tick in range((low // 60) * 60 + 30, high + 61, 60):
        price = sqrt_price_at_tick(tick)
        boundary = numerator // (price * price)
        for r in (boundary - 1, boundary, boundary + 1):
            if 0 < r <= limit:
                assert 0 <= exact_centre(r) - centre_tick(r, False, k)[0] <= 60
                transitions += 1
    for r in range(limit - 100, limit + 101):
        assert centre_tick(r, False, k)[0] == exact_centre(r)
    for i in range(2_003):
        r = limit + 1 + rng.randrange(1 << 64) * 10 ** (i % 14)
        for order in (False, True):
            assert centre_tick(r, order, k)[0] == exact_centre(r, order)
    print(f"CQ9-4: {len(vectors)} layouts; 200000 root bounds; {transitions} spacing neighbours; "
          f"{high - low + 3} adjacent tick gaps; 201 overflow neighbours; "
          "2003 legacy raises in both orders: PASS")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="compare with FitLaunchShape.sol's hard-coded constants")
    ap.add_argument("--write-layout-vectors", action="store_true", help=f"write {LAYOUT_VECTORS.name}")
    ap.add_argument("--check-layout-vectors", action="store_true", help=f"exit 1 when {LAYOUT_VECTORS.name} is stale")
    ap.add_argument("--check-small-raises", action="store_true", help="check CQ9-4's v2 layouts and centre bounds")
    args = ap.parse_args()

    if args.check_small_raises:
        check_small_raises()
        return 0

    if args.write_layout_vectors or args.check_layout_vectors:
        content = layout_vectors()
        if args.write_layout_vectors:
            LAYOUT_VECTORS.parent.mkdir(parents=True, exist_ok=True)
            LAYOUT_VECTORS.write_text(content)
            print(f"wrote {LAYOUT_VECTORS.relative_to(REPO)}")
            return 0
        if not LAYOUT_VECTORS.exists() or LAYOUT_VECTORS.read_text() != content:
            print(f"STALE {LAYOUT_VECTORS.relative_to(REPO)}: run launch_shape.py --write-layout-vectors")
            return 1
        print(f"{LAYOUT_VECTORS.name} is up to date ({json.loads(content)['count']} layouts)")
        return 0

    c = compute()
    lower, upper = c["SQRT_PRICE_LOWER_X96"], c["SQRT_PRICE_UPPER_X96"]
    widest = smallest_liquidity_for_raise(lower, upper, RAISE_TARGET_WEI + 1) - 1
    old_l = liquidity_for_amount1(lower, upper, OLD_CURVE_FIT)
    old_bootstrap, _, _ = bootstrap_buy(upper, old_l, BOOTSTRAP_ETH)
    print(f"ticks {TICK_LOWER:,} ... {TICK_UPPER:,}; k = 1.0001^{TICK_UPPER - TICK_LOWER:,}")
    print(f"target R = {RAISE_TARGET_WEI:,} wei ({fmt(RAISE_TARGET_WEI)} ETH)")
    count = widest - c["CURVE_LIQUIDITY"] + 1
    lowest = c["CURVE_LIQUIDITY"]
    print(f"liquidities raising exactly R: {lowest:,} ... {widest:,} ({count:,} values); the smallest is used")
    print("| Constant | Value | Before F40 (L6) |")
    print("|---|---:|---:|")
    print(f"| SQRT_PRICE_LOWER_X96 (P1, tick {TICK_LOWER:,}) | {lower:,} | same |")
    print(f"| SQRT_PRICE_UPPER_X96 (P0, tick {TICK_UPPER:,}) | {upper:,} | same |")
    print(f"| CURVE_LIQUIDITY | {c['CURVE_LIQUIDITY']:,} | {old_l:,} |")
    print(f"| CURVE_FIT (= deposited) | {c['CURVE_FIT']:,} raw = {fmt(c['CURVE_FIT'])} FIT | "
          f"{OLD_CURVE_FIT:,} ({amount1_delta(lower, upper, old_l, True):,} deposited) |")
    print(f"| CURVE_RAISE_WEI | {c['CURVE_RAISE_WEI']:,} | {amount0_delta(lower, upper, old_l, False):,} |")
    print(f"| Pool share (1e27 - curve) | {c['POOL_SHARE']:,} raw = {fmt(c['POOL_SHARE'])} FIT | "
          f"{ISSUANCE - amount1_delta(lower, upper, old_l, True):,} |")
    print(f"| Curve share of the issuance | {c['CURVE_FIT'] * 10**6 // ISSUANCE / 10**4:.4f}% | 80.0000% |")
    print(f"| Bootstrap buy 0.0015 ETH: FIT out (burned) | {c['BOOTSTRAP_FIT']:,} raw = {fmt(c['BOOTSTRAP_FIT'])} | "
          f"{old_bootstrap:,} |")
    print()
    print("Migration to layout b' at exactly P1 (fully crossed curve: R, no FIT; the whole pool share):")
    print("| Position | Ticks | Liquidity | Amount |")
    print("|---|---|---:|---:|")
    print(f"| Bid | [{TICK_LOWER:,}, {TICK_UPPER:,}] | {c['L_BID']:,} | {c['BID_ETH']:,} wei |")
    print(f"| Bid sentinel | [{TICK_UPPER:,}, {MAX_USABLE_TICK:,}] | {c['L_SENTINEL']:,} | {c['SENTINEL_ETH']:,} wei "
          f"(ETH dust {c['ETH_DUST']:,}) |")
    print(f"| Ask | [{MIN_USABLE_TICK:,}, {TICK_LOWER:,}] | {c['L_ASK']:,} | {c['ASK_FIT']:,} raw FIT "
          f"(dust {c['ASK_DUST']:,}) |")
    print(f"eps band: sqrt price at tick {TICK_LOWER + EPS_TICKS:,} = {c['SQRT_PRICE_BAND_X96']:,}")
    reopen_eth = amount0_delta(c["SQRT_PRICE_REOPEN_X96"], upper, c["CURVE_LIQUIDITY"], False)
    print(f"reopening margin: sqrt price at tick {TICK_LOWER + REOPEN_TICKS:,} = {c['SQRT_PRICE_REOPEN_X96']:,}; "
          f"the curve holds {fmt(reopen_eth)} ETH there, {fmt(RAISE_TARGET_WEI - reopen_eth)} ETH short of R")

    if args.check:
        onchain = solidity_constants()
        bad = {k: v for k, v in onchain.items() if c[k] != v}
        if bad:
            for k, v in bad.items():
                print(f"MISMATCH {k}: {SHAPE.name} has {v:,}, computed {c[k]:,}")
            return 1
        print(f"{SHAPE.name} matches ({len(onchain)} constants)")
        general = check_general_reproduces_box0(c)
        if general:
            for line in general:
                print(f"MISMATCH (BoxLayoutV1 port) {line}")
            return 1
        print("the general layout (BoxLayoutV1 port) reproduces box 0's shape (17 values)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
