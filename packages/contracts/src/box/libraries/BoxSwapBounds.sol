// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Uniswap v4-core @ 46c68346, MIT files only (libraries, types; DEPENDENCIES.md).
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {ProtocolFeeLibrary} from "v4-core/src/libraries/ProtocolFeeLibrary.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Slot0} from "v4-core/src/types/Slot0.sol";
import {BoxSpecV1} from "../BoxSpecV1.sol";
import {IBoxPriceAverage} from "../interfaces/IBoxHook.sol";

/// @title BoxSwapBounds (slice S5.M2; docs/design/swap-module-v1.md § 4.3-4.6, § 8)
/// @notice The bounds of every protocol swap in a box's own pool, reviewed once and compiled into each caller: the box's
/// swap module (fee shares, § 4) and, from S5.M5, `deepen()`'s depth conversions (§ 8). FitBuybackExecutor's reviewed
/// bounds (FitBuybackExecutor.sol:483-508; V-R T13 B5), mirrored for sells. Q is currency0 (v1: native ETH), so a buy
/// (Q → T, `zeroForOne`) lowers the tick and a sell (T → Q) raises it; a higher tick is more T per Q (cheaper T).
/// - **Reference:** buys the cheaper-T of the 1-hour average and the latest sample (the higher tick), sells the
///   dearer-T (the lower tick): the side that only tightens the limit, so a same-block push can delay a step, never
///   loosen it (sample-and-hold: a push in the step's block has zero weight in the average).
/// - **Band:** never beyond the reference − 99 ticks (buys) or + 99 ticks (sells) (`EXECUTOR_TWAP_BAND_TICKS`).
/// - **Impact:** at most 49 ticks from spot per step (`EXECUTOR_MAX_IMPACT_TICKS`); the limit used is the nearer of the
///   two to spot; none left in the step's direction is "at the band".
/// - **Minimum output:** (input − fee − 2 × slack) at the limit price, less the slack, the slack being the most swap
///   steps one 49-tick move can take (v4 rounds per step).
/// - **Cadence, size, tip:** one step per block per box (`SWAP_STEP_COOLDOWN_BLOCKS`), a budget worth at least
///   `SWAP_STEP_MIN_Q` at the reference tick, a tip of min(5% of the step's Q, `FEE_BATCH_TIP_MAX_ETH`).
/// @dev Internal functions only (inlined into each caller); no storage. The price average is read as `deepen()` reads
/// it (BoxHookExtension `_priceGuards`): poked, then the average and the sample, each in try/catch, a failing source
/// reading as not ready.
library BoxSwapBounds {
    int24 internal constant MAX_IMPACT_TICKS = BoxSpecV1.EXECUTOR_MAX_IMPACT_TICKS;
    int24 internal constant BAND_TICKS = BoxSpecV1.EXECUTOR_TWAP_BAND_TICKS;
    /// @notice The most v4 swap steps one step can take: ⌊49 / 60⌋ + 4, as FitBuybackExecutor's `_maxSwapSteps`.
    // casting to 'uint24' is safe because both values are positive constants
    // forge-lint: disable-next-line(unsafe-typecast)
    uint256 internal constant SLACK = uint256(uint24(MAX_IMPACT_TICKS)) / uint256(uint24(BoxSpecV1.TICK_SPACING)) + 4;
    /// @notice TickMath.getSqrtPriceAtTick(−49) and (+49) in Q96 (checked against TickMath in BoxSwapBounds.t.sol).
    uint256 internal constant SQRT_IMPACT_DOWN_X96 = 79_034_300_786_611_997_084_955_914_811;
    uint256 internal constant SQRT_IMPACT_UP_X96 = 79_422_499_761_647_659_469_960_370_034;
    uint256 internal constant PIPS = 1_000_000;
    uint256 internal constant Q96 = 1 << 96;
    int24 internal constant SPACING = BoxSpecV1.TICK_SPACING;
    /// @dev Pool.State's `liquidity` and `ticks` offsets (StateLibrary @ 46c68346).
    uint256 private constant _LIQUIDITY_OFFSET = 3;
    uint256 private constant _TICKS_OFFSET = 4;

    /// @notice The average as `deepen()` reads it: poked first (a failing poke reads as not ready), then the 1-hour
    /// average and the latest sample. `ready` false: no full window, or a failing source.
    function readAverage(IBoxPriceAverage avg) internal returns (bool ready, int24 twapTick, int24 sampleTick) {
        try avg.poke() {}
        catch {
            return (ready, twapTick, sampleTick); // not ready
        }
        return viewAverage(avg);
    }

    /// @notice The same without the poke (views: `IBoxSwapModule.bounds`).
    function viewAverage(IBoxPriceAverage avg) internal view returns (bool ready, int24 twapTick, int24 sampleTick) {
        try avg.twap() returns (bool r, int24 t, uint32) {
            (ready, twapTick) = (r, t);
        } catch {}
        if (!ready) return (ready, 0, 0);
        try avg.latestSampleTick() returns (int24 s) {
            sampleTick = s;
        } catch {
            ready = false;
        }
    }

    /// @notice Buys: the cheaper-T tick (the higher); sells: the dearer-T tick (the lower).
    function referenceTick(bool buy, int24 twapTick, int24 sampleTick) internal pure returns (int24) {
        if (buy) return sampleTick > twapTick ? sampleTick : twapTick;
        return sampleTick < twapTick ? sampleTick : twapTick;
    }

    /// @notice The band's end: √price at the reference − 99 ticks (buys, at least EXECUTOR_MIN_SQRT_PRICE_X96) or + 99
    /// ticks (sells, below MAX_SQRT_PRICE).
    function bandSqrtPrice(bool buy, int24 refTick) internal pure returns (uint160 s) {
        if (buy) {
            int24 t = refTick - BAND_TICKS;
            if (t < TickMath.MIN_TICK) t = TickMath.MIN_TICK;
            s = TickMath.getSqrtPriceAtTick(t);
            if (s < BoxSpecV1.EXECUTOR_MIN_SQRT_PRICE_X96) s = BoxSpecV1.EXECUTOR_MIN_SQRT_PRICE_X96;
        } else {
            int24 t = refTick + BAND_TICKS;
            if (t > TickMath.MAX_TICK) t = TickMath.MAX_TICK;
            s = TickMath.getSqrtPriceAtTick(t);
            if (s >= TickMath.MAX_SQRT_PRICE) s = TickMath.MAX_SQRT_PRICE - 1;
        }
    }

    /// @notice The step's `sqrtPriceLimitX96`: the nearer to spot of 49 ticks of impact and the band's end; 0 when
    /// no room is left in the step's direction (at or beyond the band).
    function stepLimit(bool buy, uint160 sqrtSpot, int24 refTick) internal pure returns (uint160 limit) {
        uint160 band = bandSqrtPrice(buy, refTick);
        if (buy) {
            // casting to 'uint160' is safe because the factor is < 2^96, so the result is ≤ sqrtSpot
            // forge-lint: disable-next-line(unsafe-typecast)
            uint160 impact = uint160(FullMath.mulDivRoundingUp(sqrtSpot, SQRT_IMPACT_DOWN_X96, Q96));
            limit = impact > band ? impact : band;
            if (limit >= sqrtSpot) return 0;
        } else {
            uint256 impact = FullMath.mulDiv(sqrtSpot, SQRT_IMPACT_UP_X96, Q96);
            // casting to 'uint160' is safe because impact < band ≤ MAX_SQRT_PRICE − 1 when chosen
            // forge-lint: disable-next-line(unsafe-typecast)
            limit = impact < band ? uint160(impact) : band;
            if (limit <= sqrtSpot) return 0;
        }
    }

    /// @notice The least output an exact-input step of `amountIn` must return: (input − fee − 2 × slack) at the limit
    /// price (T per Q = (√limit / 2^96)²), less the slack (FitBuybackExecutor `_minFitOut`, mirrored for sells).
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

    /// @notice REV-16's report of one step's own fee (FitBuybackExecutor.sol:259-269): the LP part of the swap fee on
    /// what it spent, less two raw units per possible swap step, so it never credits more than the positions got.
    function feeNote(uint256 amountIn, uint24 lpShare) internal pure returns (uint256) {
        uint256 fee = FullMath.mulDiv(amountIn, lpShare, PIPS);
        return fee > 2 * SLACK ? fee - 2 * SLACK : 0;
    }

    /// @notice A step's tip: min(SWAP_STEP_TIP_BPS of the step's Q, FEE_BATCH_TIP_MAX_ETH).
    function tipOf(uint256 stepQ) internal pure returns (uint256 tip) {
        tip = stepQ * BoxSpecV1.SWAP_STEP_TIP_BPS / 10_000;
        if (tip > BoxSpecV1.FEE_BATCH_TIP_MAX_ETH) tip = BoxSpecV1.FEE_BATCH_TIP_MAX_ETH;
    }

    /// @notice What one exact-input buy from spot to `limit` can spend, in Q, its fee included, rounded down (S5 review):
    /// the input v4's own stepping takes to reach the limit. A step of at most 49 ticks crosses at most one tick a
    /// position can start or end at (TICK_SPACING 60): for a buy the multiple of 60 at or below Slot0's tick, for a sell
    /// the one above it (where v4 looks next). So the room is the stretch to that tick at the active liquidity plus the
    /// stretch beyond it at the liquidity past it (v4's addDelta of the tick's `liquidityNet`: a buy subtracts it, a
    /// sell adds it), each by SqrtPriceMath, grossed up by the swap fee. deepen()'s conversion checks
    /// DEPTH_CONVERT_MIN_Q on it (what the swap can spend, not its ceiling). `stateSlot` is the pool's Pool.State slot.
    /// Split from `sellInput` so each caller compiles one direction only.
    function buyInput(IPoolManager pm, bytes32 stateSlot, Slot0 s0, uint160 limit, uint24 swapFee)
        internal
        view
        returns (uint256)
    {
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

    /// @notice The same for a sell, in T: the module's § 13 point 7 burn takes at most this (what one sale would have
    /// sold).
    function sellInput(IPoolManager pm, bytes32 stateSlot, Slot0 s0, uint160 limit, uint24 swapFee)
        internal
        view
        returns (uint256)
    {
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

    function _liquidity(IPoolManager pm, bytes32 stateSlot) private view returns (uint128) {
        return uint128(uint256(pm.extsload(bytes32(uint256(stateSlot) + _LIQUIDITY_OFFSET))));
    }

    /// @dev Tick `c`'s `liquidityNet`: the upper 128 bits of its first word, signed (StateLibrary.getTickLiquidity; 0
    /// where no position starts or ends).
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

    /// @notice `t` valued in Q at `tick` (T per Q = 1.0001^tick), rounded down: a sell's size check.
    function tInQ(uint256 t, int24 tick) internal pure returns (uint256) {
        uint256 s = TickMath.getSqrtPriceAtTick(tick);
        return FullMath.mulDiv(FullMath.mulDiv(t, Q96, s), Q96, s);
    }

    /// @notice Whether a step may run in this block after one in `lastBlock` (0: none yet).
    function stepDue(uint256 lastBlock) internal view returns (bool) {
        return lastBlock == 0 || block.number >= lastBlock + BoxSpecV1.SWAP_STEP_COOLDOWN_BLOCKS;
    }
}
