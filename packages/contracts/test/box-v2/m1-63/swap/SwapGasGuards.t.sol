// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CQ11ARealFixture} from "../../cq11-a/RealFixture.sol";
import {ProtocolSkip} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";

/// @notice Insufficient caller gas reverts atomically; adequate retries run the same entry.
contract M163SwapGasGuardsTest is CQ11ARealFixture {
    function test_M163_lowGasPendingBurnRollsBackAndRetries() public {
        choice = 2;
        _make(RAISE);
        _graduate();
        receiver.collect(address(0));
        vm.mockCallRevert(address(t), abi.encodeWithSignature("burn(uint256)"), "temporary refusal");
        (,, uint256 bought,) = receiver.buyBack(address(0));
        assertGt(bought, 0);
        assertEq(receiver.tBurnPending(), bought);
        vm.clearMockedCalls();
        emit log_named_uint("pending T", bought);
        // This deliberately cannot fund BURN_GAS plus EIP-150 headroom.
        // The keeper estimates transaction gas dynamically; gasPerRun is only a cost-table estimate.
        uint256 saved = vm.snapshotState();
        assertEq(receiver.burnPending(), bought, "the token accepts a burn once its refusal is lifted");
        assertTrue(vm.revertToState(saved));
        (bool ok, bytes memory result) = address(receiver).call{gas: 180_000}(abi.encodeCall(receiver.burnPending, ()));
        if (!ok) {
            assertEq(result, abi.encodeWithSignature("Error(string)", "ReceiverGasTooLow"));
            assertEq(receiver.tBurnPending(), bought);
            assertEq(t.balanceOf(address(receiver)), bought);
        }
        assertFalse(ok, "insufficient stipend must revert the entire entry");
        assertEq(receiver.burnPending(), bought);
        assertEq(receiver.tBurnPending(), 0);
    }

    function test_M163_lowGasDeepenRollsBackAndRetries() public {
        _graduate();
        receiver.collect(address(0));
        (bool ok, bytes memory result) =
            address(hook).call{gas: 400_000}(abi.encodeCall(hook.deepen, (address(0xCE11))));
        assertFalse(ok);
        // Amsterdam can exhaust this deliberately tiny budget before the late tip stipend check.
        if (result.length != 0) assertEq(result, abi.encodeWithSignature("GasTooLow()"));
        assertEq(hook.lastProtocolBlock(), 0);
        (ProtocolSkip skip,,,) = hook.deepen(address(0xCE11));
        assertEq(uint8(skip), 0);
    }

    function test_M163_lowGasBuyBackRollsBackAndRetries() public {
        choice = 2;
        _make(RAISE);
        _graduate();
        receiver.collect(address(0));
        (bool ok, bytes memory result) =
            address(receiver).call{gas: 500_000}(abi.encodeCall(receiver.buyBack, (address(0xCE11))));
        assertFalse(ok);
        assertEq(result, abi.encodeWithSignature("Error(string)", "ReceiverGasTooLow"));
        assertEq(hook.lastProtocolBlock(), 0);
        (ProtocolSkip skip,,,) = receiver.buyBack(address(0xCE11));
        assertEq(uint8(skip), 0);
    }
}
