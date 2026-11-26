// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M260Measure} from "./Measure.sol";
import {WalletDriver} from "../../m2-31/Trade.t.sol";
import {IHolderTokenHistoryV2} from "../../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {ReleaseConstantsV2 as C} from "../../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {IBoxHolderBatchNoticeV2} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";

/// Real factory topology; only the ledger bytecode is replaced for fault injection.
contract M260BoundariesTest is M260Measure {
    function test_hookNoticeRevertAndExhaustion() public { _hookFault(false); _hookFault(true); }
    function _hookFault(bool exhaust) private {
        uint256 initial = vm.snapshotState();
        _start(_holders()); address ledgerAddress = box.roleAddress(17);
        WalletDriver driver = new WalletDriver(pm, ALICE); vm.deal(address(driver), box.raise());
        vm.etch(ledgerAddress, exhaust ? bytes(hex"fe") : bytes(hex"60006000fd"));
        bytes memory input = abi.encodeCall(driver.buy, (hook.poolKey(), box.raise() / 100, layout.sqrtPriceEndX96));
        _measure(exhaust ? "trade exhausting both notices" : "trade reverting both notices",
            address(driver), address(this), input, 5000000);
        assertGt(token.balanceOf(ALICE), 0); assertGt(hook.tradeBatch(1).tradeUnits, 0);
        assertGt(IHolderTokenHistoryV2(address(token)).holderCheckpoint(), 1);
        assertTrue(vm.revertToState(initial));
    }

    function test_hookOneGasActivationWithFreshWallet() public {
        _start(_holders()); address ledgerAddress = box.roleAddress(17); vm.etch(ledgerAddress, hex"fe");
        WalletDriver driver = new WalletDriver(pm, ALICE); vm.deal(address(driver), box.raise());
        bytes memory input = abi.encodeCall(driver.buy, (hook.poolKey(), box.raise() / 100, layout.sqrtPriceEndX96));
        _boundary(address(driver), address(this), input, address(hook), ledgerAddress);
    }

    function test_tokenTransferFromOneGasActivation() public {
        _start(_holders()); _buy(box.raise() / 100);
        vm.prank(address(buyer)); token.transfer(ALICE, 100);
        vm.prank(ALICE); token.approve(address(this), 100);
        address ledgerAddress = box.roleAddress(17); vm.etch(ledgerAddress, hex"fe");
        _boundary(address(token), address(this), abi.encodeCall(token.transferFrom, (ALICE, address(0xb0b), 1)),
            address(token), ledgerAddress);
    }

    function _boundary(address target, address caller, bytes memory input, address accessor, address callee) private {
        uint256 low; uint256 high; bytes32 outcome;
        for (uint256 limit = 500000; limit <= 5000000; limit += 100000) {
            uint256 snapshot = vm.snapshotState();
            (bool ok, bool called) = this.attempt(target, caller, input, limit, accessor, callee);
            if (outcome != 0) assertTrue(ok, "more gas cannot break continuation");
            if (ok) {
                bytes32 state = keccak256(abi.encode(token.balanceOf(ALICE), token.balanceOf(address(0xb0b)),
                    hook.tradeBatch(1), IHolderTokenHistoryV2(address(token)).holderCheckpoint()));
                if (outcome == 0) outcome = state; else assertEq(state, outcome, "skip and exhaustion same money/history");
                if (!called) low = limit;
            }
            assertFalse(called && !ok, "activated callback exhausted continuation");
            if (called && high == 0) high = limit;
            assertTrue(vm.revertToState(snapshot));
        }
        assertGt(low, 0); assertGt(high, low);
        while (high - low > 1) {
            uint256 snapshot = vm.snapshotState(); uint256 mid = (low + high) / 2;
            (bool ok, bool called) = this.attempt(target, caller, input, mid, accessor, callee);
            assertTrue(ok); if (called) high = mid; else low = mid;
            assertTrue(vm.revertToState(snapshot));
        }
        emit log_named_uint("one gas callback activation", high);
        vm.expectCall(callee, 0, uint64(accessor == address(hook) ? C.HOLDER_NOTICE_GAS : C.TOKEN_SETTLEMENT_GAS),
            abi.encodeWithSelector(accessor == address(hook) ? IBoxHolderBatchNoticeV2.onTradeFeeBatch.selector
                : bytes4(keccak256("onTokenCheckpoint(uint256,address,address)"))), uint64(1));
        (bool finalOk, bool finalCalled) = this.attempt(target, caller, input, high, accessor, callee);
        assertTrue(finalOk && finalCalled);
    }

    function attempt(address target, address caller, bytes calldata input, uint256 limit, address accessor, address callee)
        external returns (bool ok, bool called)
    {
        _cold(); vm.cool(target); vm.cool(callee);
        vm.startStateDiffRecording(); vm.prank(caller); (ok,) = target.call{gas: limit}(input);
        VmSafe.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        for (uint256 i; i < accesses.length; ++i) {
            if (accesses[i].kind == VmSafe.AccountAccessKind.Call && accesses[i].account == callee
                && accesses[i].accessor == accessor) called = true;
        }
    }
}
