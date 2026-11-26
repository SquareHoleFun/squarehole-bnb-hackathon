// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxSwapBounds} from "../../../../src/box/libraries/BoxSwapBounds.sol";
import {AuditU3ClaudeBase} from "./AuditU3ClaudeBase.sol";

/// @notice SH-AUDIT-B0-U3 (Claude), lenses L6 and L7 (P3.13, P3.14, P3.16): BoxSwapBounds' one-step exact-input bound
/// against real swaps in box 0's own graduated pool, for its real liquidity layouts: the ask/bid edge at P1 (ticks
/// 177,180, where the L7 positions meet and liquidityNet is zero but the tick is initialised), the sentinel's start at
/// P0 (204,060), with and without the pair-and-lock position. From a spot landed anywhere inside a tick (or exactly on
/// its edge, from above or from below, so v4's tick convention after a crossing is exercised), the step's limit is
/// `stepLimit` with any reference tick; `buyInput` / `sellInput` must never state more than the real exact-input swap
/// to that limit spends (else a sliver could pass DEPTH_CONVERT_MIN_Q, the S5 review's finding 2) and may fall short
/// only by rounding; the real swap ends exactly at the limit, never more than 49 ticks of price from spot
/// (`BoxSwapBounds.sol:94-111`, `:146-195`; BC-129, BC-137). The extsload reads the bounds use (liquidity, tick
/// liquidityNet) are compared with StateLibrary's.
/// forge-config: default.evm_version = "osaka"
contract AuditU3ClaudeBoundsTest is AuditU3ClaudeBase {
    using StateLibrary for IPoolManager;

    uint24 internal constant FEE = 10_000;

    function setUp() public override {
        super.setUp();
        _toGraduated();
        vm.prank(keeper);
        launchRouter.sweep();
    }

    /// Near P1 (the ask/bid edge), with or without the pair: `buyInput` and `sellInput` never above the real swap's
    /// spend, short by at most 6 raw units; the real swap ends exactly at the limit, at most 49 ticks away.
    function testFuzz_AUDIT_U3_stepRoomMatchesRealSwapsNearP1(
        int256 tickSeed,
        uint256 frac,
        int256 refSeed,
        bool fromAbove,
        bool buy,
        bool withPair
    ) public {
        if (withPair) _addPair();
        _bigWhale();
        int24 t = int24(bound(tickSeed, curve.tickLower - 150, curve.tickLower + 150));
        _landInside(t, frac, fromAbove);
        _checkStep(refSeed, buy);
    }

    /// Near P0 (the sentinel's start), with or without the pair: the same, across the liquidity the sentinel adds.
    function testFuzz_AUDIT_U3_stepRoomMatchesRealSwapsNearP0(
        int256 tickSeed,
        uint256 frac,
        int256 refSeed,
        bool fromAbove,
        bool buy,
        bool withPair
    ) public {
        if (withPair) _addPair();
        _bigWhale();
        int24 t = int24(bound(tickSeed, curve.tickUpper - 150, curve.tickUpper + 150));
        _landInside(t, frac, fromAbove);
        _checkStep(refSeed, buy);
    }

    /// The reads BoxSwapBounds makes by extsload are StateLibrary's: active liquidity and each tick's liquidityNet at
    /// the layout's edges (MIN, P1, P0, MAX), with the pair present.
    function testProperty_AUDIT_U3_boundsReadsEqualStateLibrary() public {
        _addPair();
        bytes32 slot = _stateSlot();
        assertEq(uint256(pm.extsload(bytes32(uint256(slot) + 3))), pm.getLiquidity(_id()), "active liquidity");
        int24[4] memory ticks = [MIN_T, curve.tickLower, curve.tickUpper, MAX_T];
        for (uint256 i; i < ticks.length; ++i) {
            (, int128 net) = pm.getTickLiquidity(_id(), ticks[i]);
            int256 read = int256(uint256(pm.extsload(keccak256(abi.encode(ticks[i], uint256(slot) + 4))))) >> 128;
            assertEq(read, int256(net), "liquidityNet");
        }
        (, int128 netP1) = pm.getTickLiquidity(_id(), curve.tickLower);
        assertEq(netP1, int128(uint128(_bidL())) - int128(uint128(_askL())), "P1: bid starts, ask ends");
        (, int128 netP0) = pm.getTickLiquidity(_id(), curve.tickUpper);
        assertEq(netP0, int128(uint128(_sentinelL())), "P0: the sentinel starts");
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _checkStep(int256 refSeed, bool buy) internal {
        uint160 s = _sqrtP();
        int24 spot = _tickNow();
        int24 ref = int24(bound(refSeed, int256(spot) - 160, int256(spot) + 160));
        uint160 limit = bounds.stepLimit(buy, s, ref);
        if (limit == 0) return; // no room: the step does not run (ConvertBelowMin / at the band)
        uint256 est =
            buy ? bounds.buyInput(pm, _stateSlot(), limit, FEE) : bounds.sellInput(pm, _stateSlot(), limit, FEE);
        BalanceDelta d;
        if (buy) {
            d = _swap(whale, SwapParams(true, -int256(est + 1 ether), limit), est + 1 ether);
        } else {
            d = _swap(whale, SwapParams(false, -int256(est + 1e26), limit), 0);
        }
        assertEq(_sqrtP(), limit, "the real swap reached the limit");
        // casting to 'uint256' is safe because the paid side of an exact-input swap is negative
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 real = uint256(uint128(-(buy ? d.amount0() : d.amount1())));
        assertLe(est, real, "never more than the real swap spends");
        assertLe(real - est, 6, "short of it by rounding only");
        // The bound is 49 ticks of price: the √price factor TickMath gives 49 ticks (BoxSwapBounds.sol:39-41, :96-111;
        // stated so in test/box/s45/BoxSwapBounds.t.sol:100-123). The real swap ended exactly at the limit, never past
        // that factor from spot. In tick indices that is 49, or 50 for a sale from the last few raw units of a tick
        // (the limit then lies at the bottom of tick + 50; box 0's hook only buys).
        if (buy) {
            assertGe(
                limit, FullMath.mulDivRoundingUp(s, BoxSwapBounds.SQRT_IMPACT_DOWN_X96, 1 << 96), "49 ticks of price"
            );
        } else {
            assertLe(limit, FullMath.mulDiv(s, BoxSwapBounds.SQRT_IMPACT_UP_X96, 1 << 96), "49 ticks of price");
        }
        int24 end = TickMath.getTickAtSqrtPrice(limit);
        int24 start = TickMath.getTickAtSqrtPrice(s);
        assertLe(_abs(int256(end) - int256(start)), buy ? 49 : 50, "tick indices: 49 for a buy, 50 at most for a sale");
    }

    /// @dev Lands the price strictly inside tick `t` (or exactly on its edge when `frac` is a multiple of 4), coming
    /// from 80 ticks above or below.
    function _landInside(int24 t, uint256 frac, bool fromAbove) internal {
        _land(_sqrtAt(fromAbove ? t + 80 : t - 80));
        uint160 lo = _sqrtAt(t);
        uint160 hi = _sqrtAt(t + 1);
        _land(frac % 4 == 0 ? lo : uint160(bound(frac, lo, hi - 1)));
    }

    /// @dev The pair: the tax swept, two deepens 300 blocks apart (a conversion, then a conversion and the pair).
    function _addPair() internal {
        _advance(300);
        hook.deepen(keeper);
        _advance(300);
        hook.deepen(keeper);
        require(_pairL() != 0, "a pair exists");
    }

    /// @dev The whale: ETH for buys and T for sells. T beyond what the curve sold comes from forge-std `deal` to this
    /// outside stand-in (reaching P0 from P1 takes more T than any holder has); no ghost check in this suite.
    function _bigWhale() internal {
        deal(a.token, whale, 8e26);
        vm.deal(whale, 1_000 ether);
    }
}
