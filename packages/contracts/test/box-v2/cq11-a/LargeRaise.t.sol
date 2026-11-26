// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CQ11AFixture} from "./Fixture.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";

contract CQ11ALargeRaiseTest is CQ11AFixture {
    using StateLibrary for IPoolManager;
    uint256 internal constant LARGE = 340282366920938463376658674914100925496;

    function _fillInClips() internal {
        _open();
        for (uint256 i; i < 5 && !hook.closed(); ++i) _buy(layout.raise / 4);
        assertTrue(hook.closed(), "five bounded buys fill the admitted curve");
    }

    function _graduateAndCheck() internal {
        _fillInClips();
        uint256 beforeT = t.balanceOf(address(coordinator));
        (uint256 qOut, uint256 tOut, uint256 pulled, uint256 dust) = abi.decode(
            coordinator.exec(address(hook), abi.encodeCall(hook.migrate, (layout.poolShare))),
            (uint256, uint256, uint256, uint256)
        );
        assertLe(qOut, layout.raise);
        assertApproxEqAbs(qOut, layout.raise, 3, "bounded removal rounding");
        assertEq(beforeT - t.balanceOf(address(coordinator)), pulled);
        assertLe(pulled, layout.poolShare);
        assertEq(hook.depthBudget(), dust);
        uint128 l = hook.pairedLiquidity();
        assertGt(l, 0);
        assertEq(pm.getPositionLiquidity(hook.poolId(), keccak256(abi.encodePacked(address(hook), layout.tickLower, layout.tickUpper, bytes32(0)))), 0);
        assertEq(pm.getPositionLiquidity(hook.poolId(), keccak256(abi.encodePacked(address(hook), BoxSpecV1.MIN_USABLE_TICK,
            BoxSpecV1.MAX_USABLE_TICK, bytes32(uint256(3))))), l);
        (uint160 spot,,,) = pm.getSlot0(hook.poolId());
        assertEq(spot, layout.sqrtPriceEndX96);
        uint256 pairedP = SqrtPriceMath.getAmount0Delta(spot,
            TickMath.getSqrtPriceAtTick(BoxSpecV1.MAX_USABLE_TICK), l, true);
        uint256 pairedT = SqrtPriceMath.getAmount1Delta(
            TickMath.getSqrtPriceAtTick(BoxSpecV1.MIN_USABLE_TICK), spot, l, true);
        assertLe(pairedP + dust, qOut);
        assertApproxEqAbs(pairedP + dust, qOut, 3, "bounded add rounding");
        assertLe(pairedT, tOut + pulled);
        assertEq(hook.reserveMinted(), layout.raise / 1000);
    }

    function test_C6_largeAdmittedRaiseGraduates() public {
        _make(LARGE);
        _graduateAndCheck();
    }

    function test_C6_reportedRaiseGraduates() public {
        // Keep the integration counterexample even when a shorter fuzz run misses it.
        testFuzz_C6_representableRaiseGraduates(189353331869283);
    }

    function test_C11_largeFilledRaiseHasFailureExit() public {
        _make(LARGE);
        _fillInClips();
        uint256 gift = 12345;
        trader.gift(address(p), address(hook), gift);
        (uint256 pot,) = abi.decode(coordinator.exec(address(hook), abi.encodeCall(hook.close, ())), (uint256, uint256));
        assertApproxEqAbs(pot, LARGE + gift, 3);
        assertEq(_claims(address(coordinator)), pot + hook.reserveMinted());
        assertEq(hook.depthBudget(), 0);
        assertTrue(hook.failed());
    }

    function test_C11_largePartFilledRaiseHasFailureExit() public {
        _make(LARGE);
        _open();
        for (uint256 i; i < 3; ++i) _buy(LARGE / 4);
        assertFalse(hook.closed());
        (uint256 pot,) = abi.decode(coordinator.exec(address(hook), abi.encodeCall(hook.close, ())), (uint256, uint256));
        assertGt(pot, uint256(uint128(type(int128).max)));
        assertEq(_claims(address(coordinator)), pot + hook.reserveMinted());
        assertTrue(hook.failed());
    }

    function testFuzz_C6_representableRaiseGraduates(uint128 sample) public {
        uint256 r = bound(uint256(sample), 1e6, type(uint128).max);
        // Admission requires exact curve liquidity. Snap to the amount represented by this range,
        // rather than assuming every uint128 raw value is an admitted raise.
        int24 centre = BoxLayoutV2.centreTick(r, false);
        uint160 lo = TickMath.getSqrtPriceAtTick(centre - 13440);
        uint160 hi = TickMath.getSqrtPriceAtTick(centre + 13440);
        uint128 l = LiquidityAmounts.getLiquidityForAmount0(lo, hi, r);
        r = SqrtPriceMath.getAmount0Delta(lo, hi, l, false);
        if (r < 1e6) r = 1e6;
        _make(r);
        _graduateAndCheck();
    }
}
