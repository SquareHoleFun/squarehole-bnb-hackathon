// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {TokenFixture, IBoxTokenV2} from "./Fixture.sol";
import {IBoxToken} from "../../../src/box/interfaces/IBoxToken.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {IHolderLedgerV2} from "../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {VmSafe} from "forge-std/Vm.sol";

contract LedgerGasTest is TokenFixture {
    function test_transferCallbackActivation() public { _boundary(0); }
    function test_transferFromCallbackActivation() public { _boundary(1); }
    function test_burnCallbackActivation() public { _boundary(2); }
    function _boundary(uint256 op) private {
        give(ALICE, 100); vm.prank(ALICE); token.approve(BOB, 10); ledger.setMode(2);
        bytes[3] memory inputs = [abi.encodeCall(IBoxToken.transfer, (BOB, 1)),
            abi.encodeCall(IBoxToken.transferFrom, (ALICE, BOB, 1)), abi.encodeCall(IBoxToken.burn, (1))];
            bool succeeded; uint256 lastSkip; uint256 firstCall;
            for (uint256 limit = 200000; limit <= 3500000; limit += 50000) {
                uint256 saved = vm.snapshotState();
                (bool ok, bool called) = this.attempt(inputs[op], limit, op == 1 ? BOB : ALICE);
                assertFalse(succeeded && !ok, "more gas broke token mutation");
                assertFalse(called && !ok, "hint consumed continuation gas");
                if (ok) {
                    succeeded = true;
                    assertEq(token.balanceOf(ALICE), 99);
                    assertEq(history.holderCheckpoint(), 3);
                    assertEq(history.eligibleBalanceAt(ALICE, 3), 99);
                    if (!called) lastSkip = limit;
                }
                if (called && firstCall == 0) firstCall = limit;
                assertTrue(vm.revertToState(saved));
            }
            assertGt(lastSkip, 0); assertGt(firstCall, lastSkip);
            while (firstCall - lastSkip > 1) {
                uint256 saved = vm.snapshotState(); uint256 mid = (firstCall + lastSkip) / 2;
                (bool ok, bool called) = this.attempt(inputs[op], mid, op == 1 ? BOB : ALICE);
                assertTrue(ok, "one gas boundary");
                if (called) firstCall = mid; else lastSkip = mid;
                assertTrue(vm.revertToState(saved));
            }
            emit log_named_uint("token callback activation", firstCall);
            uint256 finalSnapshot = vm.snapshotState();
            vm.expectCall(address(ledger), 0, uint64(C.TOKEN_SETTLEMENT_GAS),
                abi.encodeWithSelector(IHolderLedgerV2.onTokenCheckpoint.selector), uint64(1));
            (bool finalOk, bool finalCalled) = this.attempt(inputs[op], firstCall, op == 1 ? BOB : ALICE);
            assertTrue(finalOk && finalCalled); assertTrue(vm.revertToState(finalSnapshot));
    }
    function attempt(bytes calldata data, uint256 gasLimit, address caller) external returns (bool ok, bool called) {
        vm.cool(address(token)); vm.cool(implementation); vm.cool(address(ledger));
        vm.startStateDiffRecording(); vm.prank(caller); (ok,) = address(token).call{gas: gasLimit}(data);
        VmSafe.AccountAccess[] memory calls = vm.stopAndReturnStateDiff();
        for (uint256 i; i < calls.length; ++i) if (calls[i].account == address(ledger)
            && calls[i].kind == VmSafe.AccountAccessKind.Call) called = true;
    }
}
