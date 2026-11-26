// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Uniswap v4-core @ 46c68346, MIT files only (libraries, types; DEPENDENCIES.md).
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {ProtocolFeeLibrary} from "v4-core/src/libraries/ProtocolFeeLibrary.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Slot0} from "v4-core/src/types/Slot0.sol";
import {BoxSpecV1} from "../../box/BoxSpecV1.sol";
import {ReleaseConstantsV2} from "../interfaces/ReleaseConstantsV2.sol";

/// @title BoxSwapBoundsV2 (core v2 M1, ticket M1-30-a; file map § 1 rule 8, change queue 4 FM1)
/// @notice v1's `BoxSwapBounds` (`src/box/libraries/BoxSwapBounds.sol`, pinned with box 0) for any pricing token P, by
/// reference, with these changes (ADR-0017 § 4, § 11 and Amendment 1 A2/A5):
/// - **`tipOf(stepQ, tipMaxQ)`** takes the box's tip cap in P (its `QParameters.tipMaxQ`), since v1's cap is a raw-wei
///   constant (`FEE_BATCH_TIP_MAX_ETH`) that does not bind at 6 decimals: min(5% of the step's P, `tipMaxQ`).
/// - **The step and band ticks** are `ReleaseConstantsV2.STEP_TICKS` and `BAND_TICKS` (F95 R19R: M1-23 sets the step;
///   F96 keeps the band at 99), and the impact factors and the slack follow `STEP_TICKS`.
/// - **`roomLimit(buy, sqrtSpot, ticksLeft)`** bounds v2 steps from live spot by the remaining directional room,
///   capped at `STEP_TICKS`, without an average or band. Callers own the room's accounting and 25-block window.
/// P is currency0: a buy (P → T, `zeroForOne`) lowers the tick and a sell raises it. The existing average, reference,
/// band and `stepLimit` entries retain v1's behavior for deepen; the minimum output and input walks are unchanged.
/// @dev Internal functions only (inlined into each caller); no storage.
library BoxSwapBoundsV2 {
    /// @notice `buyInput` and `sellInput` walk one crossed initialised tick, so a `STEP_TICKS` of one spacing (60) or
    /// more needs the walk over each crossing first (M1-23's grid names 99 and 150). The check folds away at 49.
    error StepTicksNeedTickWalk();

    /// @notice The most one protocol step moves a box pool's price (v1's `MAX_IMPACT_TICKS`, 49 until M1-23 sets it).
    int24 internal constant STEP_TICKS = ReleaseConstantsV2.STEP_TICKS;
    /// @notice v1's name for `STEP_TICKS` (`BoxSwapBounds.MAX_IMPACT_TICKS`), so a caller switches here by name.
    int24 internal constant MAX_IMPACT_TICKS = STEP_TICKS;
    /// @notice Deepen's band around the reference (v1's `BAND_TICKS`, 99); unused by `roomLimit`.
    /// @notice The most v4 swap steps one step can take: ⌊STEP_TICKS / 60⌋ + 4, as v1's `SLACK`.
    // casting to 'uint24' is safe because both values are positive constants
    // forge-lint: disable-next-line(unsafe-typecast)
    uint256 internal constant SLACK = uint256(uint24(STEP_TICKS)) / uint256(uint24(BoxSpecV1.TICK_SPACING)) + 4;
    uint256 internal constant PIPS = 1_000_000;
    uint256 internal constant Q96 = 1 << 96;
    int24 internal constant SPACING = BoxSpecV1.TICK_SPACING;
    /// @dev v1's literals for 49 ticks (`BoxSwapBounds.sol:35-36`), used while `STEP_TICKS` is 49.
    uint256 private constant _SQRT_DOWN_49_X96 = 79_034_300_786_611_997_084_955_914_811;
    uint256 private constant _SQRT_UP_49_X96 = 79_422_499_761_647_659_469_960_370_034;
    /// @dev Pool.State's `liquidity` and `ticks` offsets (StateLibrary @ 46c68346).
    uint256 private constant _LIQUIDITY_OFFSET = 3;
    uint256 private constant _TICKS_OFFSET = 4;

    /// @notice TickMath.getSqrtPriceAtTick(−STEP_TICKS) in Q96 (v1's `SQRT_IMPACT_DOWN_X96`): v1's literal at 49
    /// ticks, folded by the compiler, else computed.
    function sqrtImpactDownX96() internal pure returns (uint256) {
        if (STEP_TICKS == 49) return _SQRT_DOWN_49_X96;
        return TickMath.getSqrtPriceAtTick(-STEP_TICKS);
    }

    /// @notice TickMath.getSqrtPriceAtTick(+STEP_TICKS) in Q96 (v1's `SQRT_IMPACT_UP_X96`).
    function sqrtImpactUpX96() internal pure returns (uint256) {
        if (STEP_TICKS == 49) return _SQRT_UP_49_X96;
        return TickMath.getSqrtPriceAtTick(STEP_TICKS);
    }

    /// @notice v1's `readAverage`: poked first (a failing poke reads as not ready), then the 1-hour average and the
    /// latest sample.


    /// @notice v1's `viewAverage`: the same without the poke.


    /// @notice Buys: the cheaper-T tick (the higher); sells: the dearer-T tick (the lower).


    /// @notice The band's end: √price at the reference − `BAND_TICKS` (buys, at least EXECUTOR_MIN_SQRT_PRICE_X96) or
    /// + `BAND_TICKS` (sells, below MAX_SQRT_PRICE).


    /// @notice The retained banded `sqrtPriceLimitX96`: the nearer to spot of `STEP_TICKS` of impact and the band's end; 0
    /// when no room is left in the step's direction (at or beyond the band).


    /// @notice A v2 box-pool step's `sqrtPriceLimitX96`, at most min(ticksLeft, STEP_TICKS) from live spot.
    /// Buys lower the tick; sells raise it. Rounded toward spot and clamped strictly inside v4's price bounds.
    /// Returns 0 for no room or no valid limit in that direction. No sampler reading or band is used.
    /// @dev `sqrtSpot` is the pool's current Q64.96 price, including its fractional tick. Callers pass their own
    /// direction's remaining room and charge actual movement after the swap; this pure entry consumes no room.
    function roomLimit(bool buy, uint160 sqrtSpot, uint24 ticksLeft) internal pure returns (uint160 limit) {
        if (ticksLeft == 0) return 0;
        // STEP_TICKS is positive and below one tick spacing; cap before converting the unsigned room to int24.
        // forge-lint: disable-next-line(unsafe-typecast)
        int24 ticks = ticksLeft > uint24(STEP_TICKS) ? STEP_TICKS : int24(ticksLeft);
        if (buy) {
            // The factor is below Q96, so impact fits uint160 and never exceeds spot.
            // forge-lint: disable-next-line(unsafe-typecast)
            limit = uint160(FullMath.mulDivRoundingUp(sqrtSpot, TickMath.getSqrtPriceAtTick(-ticks), Q96));
            if (limit < TickMath.MIN_SQRT_PRICE + 1) limit = TickMath.MIN_SQRT_PRICE + 1;
            if (limit >= sqrtSpot) return 0;
        } else {
            uint256 impact = FullMath.mulDiv(sqrtSpot, TickMath.getSqrtPriceAtTick(ticks), Q96);
            // Clamp before narrowing: the upward product can exceed uint160 near the maximum pool price.
            // forge-lint: disable-next-line(unsafe-typecast)
            limit = impact >= TickMath.MAX_SQRT_PRICE ? TickMath.MAX_SQRT_PRICE - 1 : uint160(impact);
            if (limit <= sqrtSpot) return 0;
        }
    }

    /// @notice v1's `minOut`: (input − fee − 2 × slack) at the limit price, less the slack.
    function minOut(bool buy, uint256 amountIn, uint160 limit, uint24 swapFee) internal pure returns (uint256) {
        uint256 net = FullMath.mulDiv(amountIn, PIPS - swapFee, PIPS);
        if (net <= 2 * SLACK) return 0;
        uint256 out = buy
            ? FullMath.mulDiv(FullMath.mulDiv(net - 2 * SLACK, limit, Q96), limit, Q96)
            : FullMath.mulDiv(FullMath.mulDiv(net - 2 * SLACK, Q96, limit), Q96, limit);
        return out > SLACK ? out - SLACK : 0;
    }

    /// @notice The swap fee of one direction (pips) and its LPs' part (Uniswap's protocol share excluded).
    function fees(Slot0 slot0, bool zeroForOne) internal pure returns (uint24 swapFee, uint24 lpShare) {
        uint16 protocolFee = zeroForOne
            ? ProtocolFeeLibrary.getZeroForOneFee(slot0.protocolFee())
            : ProtocolFeeLibrary.getOneForZeroFee(slot0.protocolFee());
        swapFee = protocolFee == 0 ? slot0.lpFee() : ProtocolFeeLibrary.calculateSwapFee(protocolFee, slot0.lpFee());
        lpShare = swapFee - protocolFee;
    }

    /// @notice v1's `feeNote`: the LP part of the swap fee on what a step spent, less two raw units per swap step.
    function feeNote(uint256 amountIn, uint24 lpShare) internal pure returns (uint256) {
        uint256 fee = FullMath.mulDiv(amountIn, lpShare, PIPS);
        return fee > 2 * SLACK ? fee - 2 * SLACK : 0;
    }

    /// @notice A step's tip: min(SWAP_STEP_TIP_BPS of the step's P, the box's `tipMaxQ`) (ADR-0017 § 4).
    function tipOf(uint256 stepQ, uint256 tipMaxQ) internal pure returns (uint256 tip) {
        tip = stepQ * BoxSpecV1.SWAP_STEP_TIP_BPS / 10_000;
        if (tip > tipMaxQ) tip = tipMaxQ;
    }

    /// @notice v1's `buyInput`: what one exact-input buy from spot to `limit` can spend, in P, its fee included,
    /// rounded down. It counts at most one crossed tick (the multiple of `SPACING` at or below spot), which holds while
    /// `STEP_TICKS` is below `SPACING` (60): a `STEP_TICKS` of 99 or 150 (M1-23's grid) can cross two or three, and
    /// then this walk must cover each (a change with M1-23's value, not built here): until then both refuse
    /// (`StepTicksNeedTickWalk`) rather than answer at the wrong liquidity.
    function buyInput(IPoolManager pm, bytes32 stateSlot, Slot0 s0, uint160 limit, uint24 swapFee)
        internal
        view
        returns (uint256)
    {
        if (STEP_TICKS >= SPACING) revert StepTicksNeedTickWalk();
        uint128 l = _liquidity(pm, stateSlot);
        int24 tick = s0.tick();
        int24 c = tick / SPACING * SPACING;
        if (tick < c) c -= SPACING; // round towards −∞
        uint160 at = limit;
        uint128 past = l;
        if (c >= TickMath.MIN_TICK) {
            uint160 x = TickMath.getSqrtPriceAtTick(c);
            if (x > limit) (at, past) = (x, _past(l, -_net(pm, stateSlot, c)));
        }
        uint256 amount = SqrtPriceMath.getAmount0Delta(at, s0.sqrtPriceX96(), l, false)
            + SqrtPriceMath.getAmount0Delta(limit, at, past, false);
        return FullMath.mulDiv(amount, PIPS, PIPS - swapFee);
    }

    /// @notice v1's `sellInput`: the same for a sell, in T (the same one-tick walk and refusal).
    function sellInput(IPoolManager pm, bytes32 stateSlot, Slot0 s0, uint160 limit, uint24 swapFee)
        internal
        view
        returns (uint256)
    {
        if (STEP_TICKS >= SPACING) revert StepTicksNeedTickWalk();
        uint128 l = _liquidity(pm, stateSlot);
        int24 tick = s0.tick();
        int24 c = tick / SPACING * SPACING;
        if (tick < c) c -= SPACING; // round towards −∞
        c += SPACING;
        uint160 at = limit;
        uint128 past = l;
        if (c <= TickMath.MAX_TICK) {
            uint160 x = TickMath.getSqrtPriceAtTick(c);
            if (x < limit) (at, past) = (x, _past(l, _net(pm, stateSlot, c)));
        }
        uint256 amount = SqrtPriceMath.getAmount1Delta(s0.sqrtPriceX96(), at, l, false)
            + SqrtPriceMath.getAmount1Delta(at, limit, past, false);
        return FullMath.mulDiv(amount, PIPS, PIPS - swapFee);
    }

    /// @notice `t` valued in P at `tick` (T per P = 1.0001^tick), rounded down: a sell's size check.
    function tInQ(uint256 t, int24 tick) internal pure returns (uint256) {
        uint256 s = TickMath.getSqrtPriceAtTick(tick);
        return FullMath.mulDiv(FullMath.mulDiv(t, Q96, s), Q96, s);
    }

    /// @notice T valued in P at the exact live Q64.96 spot, including its fractional tick, rounded down.
    /// Module step minima use this; sampler-based consumers retain `tInQ(t, tick)`.
    function tInQAtSqrt(uint256 t, uint160 sqrtSpot) internal pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(t, Q96, sqrtSpot), Q96, sqrtSpot);
    }

    /// @notice Whether a step may run in this block after one in `lastBlock` (0: none yet).
    function stepDue(uint256 lastBlock) internal view returns (bool) {
        return lastBlock == 0 || block.number >= lastBlock + BoxSpecV1.SWAP_STEP_COOLDOWN_BLOCKS;
    }

    function _liquidity(IPoolManager pm, bytes32 stateSlot) private view returns (uint128) {
        return uint128(uint256(pm.extsload(bytes32(uint256(stateSlot) + _LIQUIDITY_OFFSET))));
    }

    /// @dev Tick `c`'s `liquidityNet`: the upper 128 bits of its first word, signed.
    function _net(IPoolManager pm, bytes32 stateSlot, int24 c) private view returns (int256) {
        // casting to 'int256' is safe because it reinterprets the word, whose arithmetic shift is the int128
        // forge-lint: disable-next-line(unsafe-typecast)
        return int256(uint256(pm.extsload(keccak256(abi.encode(c, uint256(stateSlot) + _TICKS_OFFSET))))) >> 128;
    }

    /// @dev The liquidity past a crossing: `l` plus `delta` (v4's addDelta), never below 0.
    function _past(uint128 l, int256 delta) private pure returns (uint128) {
        int256 next = int256(uint256(l)) + delta;
        // casting to 'uint128' is safe because liquidity after a crossing is in [0, 2^128) (v4's addDelta)
        // forge-lint: disable-next-line(unsafe-typecast)
        return next > 0 ? uint128(uint256(next)) : 0;
    }
}
