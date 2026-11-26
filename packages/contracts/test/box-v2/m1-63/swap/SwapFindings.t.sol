// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CQ11ARealFixture} from "../../cq11-a/RealFixture.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ProtocolSkip} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";

/// @notice M1-63 M01/M02 regressions: accumulated budgets retain bounded exits.
contract M163SwapFindingsTest is CQ11ARealFixture {
    using StateLibrary for IPoolManager;

    function _largeWindowTax() internal returns (uint256 tax) {
        _make(LARGE);
        vm.warp(box.effectiveOpenAt());
        p.approve(address(router), type(uint256).max);
        for (uint256 i; i < 3; ++i) {
            router.buy(LARGE / 4, 1, address(this), block.timestamp);
        }
        tax = p.balanceOf(address(router));
        assertEq(tax, router.totalTaxCollected());
        assertGt(tax, uint256(uint128(type(int128).max)), "ordinary window tax exceeds one manager delta");
        emit log_named_uint("window tax P", tax);
    }

    function test_M163_M01_windowTaxHasExitAfterGraduation() public {
        uint256 tax = _largeWindowTax();
        _graduate();
        uint256 depth = hook.depthBudget();
        (bool ok, bytes memory result) = address(router).call(abi.encodeCall(router.sweep, ()));
        if (!ok) {
            assertEq(result, abi.encodeWithSignature("SafeCastOverflow()"));
            assertEq(hook.depthBudget(), depth, "failed sweep rolls back its credit");
            assertEq(p.balanceOf(address(router)), tax, "failed sweep preserves custody");
        }
        assertTrue(ok, "M01: accumulated window tax has no sweep exit");
        assertEq(abi.decode(result, (uint256)), tax);
        assertEq(hook.depthBudget(), depth + tax);
        assertEq(p.balanceOf(address(router)), 0);
    }

    function test_M163_M01_windowTaxHasExitAfterFailure() public {
        uint256 tax = _largeWindowTax();
        vm.warp(box.deadline());
        box.fail();
        assertTrue(box.failed(), "fail-safe sweep must not prevent closure");
        uint256 pot = _claims(address(box));
        // Failure tries the sweep under its stipend. A later permissionless retry must still have an exit.
        if (p.balanceOf(address(router)) != 0) {
            (bool ok, bytes memory result) = address(router).call(abi.encodeCall(router.sweep, ()));
            if (!ok) {
                assertEq(result, abi.encodeWithSignature("SafeCastOverflow()"));
                assertEq(p.balanceOf(address(router)), tax);
                assertEq(_claims(address(box)), pot);
            }
            assertTrue(ok, "M01: failure sweep retry cannot release accumulated tax");
        }
        assertGe(_claims(address(box)), pot);
        assertEq(p.balanceOf(address(router)), 0, "tax cannot stay trapped after failure");
    }

    function _largeLivePool() internal {
        choice = 2;
        _make(LARGE);
        _graduate();
        p.mint(address(trader), LARGE * 300);
        // Each user buy is below int128. Grow P reserves until a 49-tick fill can exceed int128.
        for (uint256 i; i < 1000; ++i) {
            vm.roll(block.number + 1);
            trader.trade(key, true, -int256(LARGE / 4), TickMath.MIN_SQRT_PRICE + 1);
        }
        receiver.collect(address(0));
        emit log_named_uint("buy-back budget P", receiver.buyBackP());
        emit log_named_uint("depth budget P", hook.depthBudget());
        vm.roll(block.number + 1);
        uint256 saved = vm.snapshotState();
        (uint160 spot,,,) = pm.getSlot0(hook.poolId());
        uint160 limit = uint160(FullMath.mulDivRoundingUp(spot, TickMath.getSqrtPriceAtTick(-49), 1 << 96));
        BalanceDelta d = trader.trade(key, true, -int256(LARGE / 4), limit);
        assertLt(d.amount0(), 0, "smaller input can still trade within the same 49-tick limit");
        assertGt(d.amount1(), 0);
        emit log_named_uint("working smaller P input", uint256(-int256(d.amount0())));
        assertTrue(vm.revertToState(saved));
    }

    function test_M163_M02_largeBuyBackTradesWhatFits() public {
        _largeLivePool();
        uint256 budget = receiver.buyBackP();
        (uint160 spot,,,) = pm.getSlot0(hook.poolId());
        uint256 mark = hook.lastProtocolBlock();
        (bool ok, bytes memory result) = address(receiver).call(abi.encodeCall(receiver.buyBack, (address(0))));
        if (!ok) {
            assertEq(result, abi.encodeWithSignature("SafeCastOverflow()"));
            assertEq(receiver.buyBackP(), budget);
            assertEq(hook.lastProtocolBlock(), mark);
            (uint160 afterPrice,,,) = pm.getSlot0(hook.poolId());
            assertEq(afterPrice, spot);
        }
        assertTrue(ok, "M02: large buy-back cannot trade a smaller representable input");
        (ProtocolSkip skip, uint256 spent, uint256 bought,) =
            abi.decode(result, (ProtocolSkip, uint256, uint256, uint256));
        assertEq(uint8(skip), uint8(ProtocolSkip.None));
        assertGt(spent, 0);
        assertGt(bought, 0);
        assertLe(spent, uint256(uint128(type(int128).max)));
        assertEq(receiver.buyBackP(), budget - spent);
        assertGt(receiver.buyBackP(), 0, "unspent budget remains for another block");
    }

    function test_M163_M02_largeDeepenTradesWhatFits() public {
        _largeLivePool();
        for (uint256 i; i < 8; ++i) {
            trader.gift(address(p), address(hook), LARGE / 4);
        }
        uint256 budget = hook.depthBudget();
        uint256 mark = hook.lastProtocolBlock();
        (uint160 spot,,,) = pm.getSlot0(hook.poolId());
        (bool ok, bytes memory result) = address(hook).call(abi.encodeCall(hook.deepen, (address(0))));
        if (!ok) {
            assertEq(result, abi.encodeWithSignature("SafeCastOverflow()"));
            assertEq(hook.depthBudget(), budget);
            assertEq(hook.lastProtocolBlock(), mark);
            (uint160 afterPrice,,,) = pm.getSlot0(hook.poolId());
            assertEq(afterPrice, spot);
        }
        assertTrue(ok, "M02: large deepen cannot trade a smaller representable input");
        (ProtocolSkip skip, uint256 qUsed,,) = abi.decode(result, (ProtocolSkip, uint256, uint256, uint256));
        assertEq(uint8(skip), uint8(ProtocolSkip.None));
        assertGt(qUsed, 0);
        assertLe(qUsed, uint256(uint128(type(int128).max)));
        assertLt(hook.depthBudget(), budget);
        assertLe(budget - hook.depthBudget(), uint256(uint128(type(int128).max)));
    }
}
