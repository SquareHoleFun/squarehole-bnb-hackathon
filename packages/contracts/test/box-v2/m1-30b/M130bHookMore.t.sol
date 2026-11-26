// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {CQ11AHookMatrixBase} from "../cq11-a/Hook.t.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {IBoxHookV2, ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {BoxHookV2Base} from "../../../src/box-v2/BoxHookV2Base.sol";
contract M130bHookMoreTest is CQ11AHookMatrixBase {
    function test_M130b_hookArgumentsAndInitialize() public {
        assertEq(hook.coordinator(), address(box)); assertEq(hook.receiver(), address(receiver)); assertEq(hook.launchRouter(), address(router));
        assertEq(hook.token(), address(t)); assertEq(hook.q(), address(p));
        vm.prank(address(box)); vm.expectRevert(IBoxHookV2.AlreadyInitialised.selector); hook.initialize();
        vm.expectRevert(); hook.initialize();
    }
    function _gates(uint8 stage) internal {
        uint256 initial = vm.snapshotState();
        for (uint8 who; who < 3; ++who) for (uint8 kind; kind < 4; ++kind) {
            vm.revertToState(initial); initial = vm.snapshotState();
            address sender = _prepare(1, who);
            if (stage == 0) vm.warp(box.effectiveOpenAt() - 1);
            if (stage == 1) _fill();
            if (stage >= 2) vm.warp(box.deadline());
            if (stage == 3) box.fail();
            bool buy = kind < 2;
            Before memory b = _before(sender);
            SwapParams memory params = SwapParams(buy, kind % 2 == 0 ? -int256(1000000) : int256(1000000), buy ? b.price - 100 : b.price + 100);
            bytes memory reason;
            if (stage == 3) reason = abi.encodeWithSelector(IBoxHookV2.BoxFailed.selector);
            else if (who == 1) reason = abi.encodeWithSelector(buy ? BoxHookV2Base.NotGraduated.selector : IBoxHookV2.ReceiverCannotSell.selector);
            else if (stage == 0) reason = abi.encodeWithSelector(IBoxHookV2.TradingNotOpen.selector, hook.openAt());
            else if (stage == 1) reason = abi.encodeWithSelector(IBoxHookV2.CurveIsClosed.selector, hook.closedAtBlock());
            else reason = abi.encodeWithSelector(IBoxHookV2.FailurePending.selector, box.deadline());
            _reject(sender, params, b, reason, false);
        }
    }
    function test_M130b_hookRefusesEverySwapFromItsDeadline() public { _gates(2); }
    function test_C15_filledGateAllSendersAndKinds() public { _gates(1); }
    function test_C15_failedGateAllSendersAndKinds() public { _gates(3); }
    function test_C15_preopenGateAllSendersAndKindsAfterCreationBlock() public { _gates(0); }
    function test_M130b_deepenReportsTheDepthStillWaiting() public {
        _graduate(); trader.gift(address(p), address(hook), RAISE);
        uint256 before = hook.depthBudget(); hook.deepen(address(0)); assertLt(hook.depthBudget(), before); assertGt(hook.depthBudget(), 0);
        uint256 left = hook.depthBudget(); (ProtocolSkip skip,,,) = hook.deepen(address(0));
        assertEq(uint8(skip), uint8(ProtocolSkip.StepTaken)); assertEq(hook.depthBudget(), left);
    }
    // Closing ranges were removed by C14. The replacement close remains coordinator-only.
    function test_M130b_closeIsTheCoordinatorsOnly() public {
        vm.expectRevert(abi.encodeWithSelector(IBoxHookV2.NotCoordinator.selector, address(this))); hook.close();
        assertFalse(hook.failed()); assertEq(hook.closedTResidue(), 0);
    }
}
