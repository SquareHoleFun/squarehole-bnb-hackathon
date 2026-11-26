// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {AuditU4ClaudeBase, U4Books} from "./AuditU4ClaudeBase.sol";
import {AuditU4ClaudeProbe, AuditU4ClaudeStreamStandIn} from "./AuditU4ClaudeHelpers.sol";

/// @title AuditU4ClaudeReentrancyTest
/// @notice TEST ONLY (SH-AUDIT-B0 U4, Claude). Lens L3: P4.10 (one transient lock for both receiver halves: every
/// party that gets control flow inside a receiver call, the tip recipient, the Safe, the per-item stream and FIT's
/// executor, tries every entry point of both halves and is refused), P4.11 (the stream's notice capped at 200,000 gas
/// and fail-safe), P4.12 (a reverting or gas-burning Safe or tip recipient blocks only its own payout; BC-021).
/// Sources: TransientReentrancyGuard.sol:26-57; BoxReceiverBase.sol:7-15; BoxReceiverExtension.sol:11-19, :123, :156,
/// :166; BoxReceiver.sol:344-355, :385-408, :941-988; IBoxReceiver.sol:57-58; BC-021, BC-139.
/// Stand-ins (the property is how the receiver treats another contract's behaviour): `AuditU4ClaudeProbe` (a callee
/// that re-enters everything) as the tip recipient, and etched for one call at the Safe's, the stream's and the
/// executor's addresses; `AuditU4ClaudeStreamStandIn` etched at the stream's address (reverts, uses all its gas, or
/// logs the gas it got); the world's `ethRefuser` and `gasBurner` code etched at the Safe's address. Every etch is
/// undone in the same test (the stream's and executor's storage is never written by the stand-ins).
/// forge-config: default.evm_version = "osaka"
contract AuditU4ClaudeReentrancyTest is AuditU4ClaudeBase {
    // ================================================================================================ P4.10

    /// The tip recipient (control flow inside collect's unlock) tries all 15 entry points of both halves.
    function testProperty_AUDIT_U4_sharedLockAgainstTheTipRecipient() public {
        _toGraduated();
        AuditU4ClaudeProbe probe = new AuditU4ClaudeProbe(payable(a.receiver));
        _ghostAddOutside(address(probe));
        _batchOf(0.02 ether);
        vm.recordLogs();
        _collect(keeper, address(probe));
        _assertEveryAttemptRefused(vm.getRecordedLogs(), address(probe));
        assertEq(address(probe).balance, TIP_MAX, "the tip was paid");
        (uint256 uq, uint256 ut) = _unbooked();
        assertEq(uq + ut, 0, "the batch completed");
        _assertGhostLedger();
    }

    /// The Safe (control flow inside payPlatform's unlock), etched with the probe for the call.
    function testProperty_AUDIT_U4_sharedLockAgainstTheSafe() public {
        _toGraduated();
        _fundFees(eoa[1], 15 ether);
        vm.etch(safe, address(new AuditU4ClaudeProbe(payable(a.receiver))).code);
        uint256 owed = receiver.platformOwed();
        vm.recordLogs();
        uint256 paid = _payPlatform(keeper);
        _assertEveryAttemptRefused(vm.getRecordedLogs(), safe);
        vm.etch(safe, "");
        assertEq(paid, owed);
        _assertGhostLedger();
    }

    /// The per-item stream (control flow in collect's capped notice, 200,000 gas), etched with the probe for the call.
    function testProperty_AUDIT_U4_sharedLockAgainstTheStream() public {
        _toGraduated();
        _tradeBothSides(1 ether);
        bytes memory code = a.itemStream.code;
        vm.etch(a.itemStream, address(new AuditU4ClaudeProbe(payable(a.receiver))).code);
        vm.recordLogs();
        _collect(keeper, keeper);
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        vm.etch(a.itemStream, code);
        _assertEveryAttemptRefused(logs, a.itemStream);
        _assertGhostLedger();
    }

    /// FIT's executor (control flow in payFit's fundBudget), etched with the probe for the call.
    function testProperty_AUDIT_U4_sharedLockAgainstTheExecutor() public {
        _toGraduated();
        _fundFees(eoa[1], 3 ether);
        bytes memory code = a.executor.code;
        vm.etch(a.executor, address(new AuditU4ClaudeProbe(payable(a.receiver))).code);
        vm.recordLogs();
        _payFit(keeper);
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        vm.etch(a.executor, code);
        _assertEveryAttemptRefused(logs, a.executor);
        _assertGhostLedger();
    }

    /// Each of the 15 attempts was refused: the guarded entry points of both halves with `Reentrancy()` (one lock),
    /// `initialize` (no lock, run once) with NotCoordinator, `unlockCallback` with NotPoolManager.
    function _assertEveryAttemptRefused(VmSafe.Log[] memory logs, address emitter) internal pure {
        uint256 n;
        bytes32 sig = AuditU4ClaudeProbe.Attempt.selector;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != emitter || logs[i].topics[0] != sig) continue;
            bytes4 selector = bytes4(logs[i].topics[1]);
            (bool ok, bytes4 reason) = abi.decode(logs[i].data, (bool, bytes4));
            assertFalse(ok, "every entry point refused mid-call");
            if (selector == IBoxReceiver.initialize.selector) {
                assertEq(reason, IBoxReceiver.NotCoordinator.selector, "initialize: not the coordinator");
            } else if (selector == IUnlockCallback.unlockCallback.selector) {
                assertEq(reason, IBoxReceiver.NotPoolManager.selector, "unlockCallback: not the PoolManager");
            } else {
                assertEq(reason, REENTRANCY, "the shared lock (both halves)");
            }
            ++n;
        }
        assertEq(n, 15, "all 15 entry points tried");
    }

    // ================================================================================================ P4.11

    /// The stream gets exactly STREAM_NOTIFY_GAS (200,000) for its notice: a stand-in logs gasleft() at entry.
    function testProperty_AUDIT_U4_streamGetsItsWholeCap() public {
        _toGraduated();
        _tradeBothSides(1 ether);
        (uint256 gasAtEntry, bool funded,) = _collectWithStream(AuditU4ClaudeStreamStandIn.Mode.Accept);
        assertTrue(funded, "StreamFunded");
        emit log_named_uint("gas at the stream's entry", gasAtEntry);
        assertLe(gasAtEntry, 200_000, "at most the cap");
        assertGe(gasAtEntry, 199_900, "the whole cap (less the callee's own first opcodes)");
    }

    /// A stream that reverts or uses all its gas: collect still succeeds, the notice is logged as failed, the T
    /// (exactly 13/15 of the batch's T units) is at the stream's address, nothing is left unbooked, and the next
    /// collect with the real stream works (BC-139: "the stream receives exactly 13/15 ... whatever its notice does").
    function testFuzz_AUDIT_U4_failingStreamLeavesTheBatchAccounted(bool burnAll, uint96 buyRaw) public {
        _toGraduated();
        _tradeBothSides(bound(buyRaw, 0.6 ether, 3 ether));
        U4Books memory b0 = _books();
        (, bool funded, uint256 streamGot) = _collectWithStream(
            burnAll ? AuditU4ClaudeStreamStandIn.Mode.BurnAll : AuditU4ClaudeStreamStandIn.Mode.Revert
        );
        assertFalse(funded, "StreamNotifyFailed, not funded");
        U4Books memory b1 = _books();
        uint256 v = (b1.hookClaimsT - b0.hookClaimsT) / 2;
        assertEq(streamGot, 13 * v, "the stream's address holds 13/15 of the T units anyway");
        assertEq(b1.claimsT - b1.bookedT, 0, "nothing unbooked");
        assertEq(b1.claimsQ - b1.bookedQ, 0);
        _tradeBothSides(0.6 ether);
        _collect(keeper, keeper);
        _assertGhostLedger();
    }

    /// Runs collect with a stream stand-in in `mode` etched for the call; returns the gas the stand-in saw (Accept),
    /// whether the receiver logged StreamFunded, and the T the stream's address received.
    function _collectWithStream(AuditU4ClaudeStreamStandIn.Mode mode)
        internal
        returns (uint256 gasAtEntry, bool funded, uint256 streamGot)
    {
        bytes memory code = a.itemStream.code;
        vm.etch(a.itemStream, address(new AuditU4ClaudeStreamStandIn(mode)).code);
        uint256 t0 = token.balanceOf(a.itemStream);
        vm.recordLogs();
        _collect(keeper, keeper);
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        streamGot = token.balanceOf(a.itemStream) - t0;
        vm.etch(a.itemStream, code);
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.itemStream && logs[i].topics[0] == AuditU4ClaudeStreamStandIn.Notified.selector) {
                (gasAtEntry,) = abi.decode(logs[i].data, (uint256, bytes));
            }
            if (logs[i].emitter == a.receiver && logs[i].topics[0] == IBoxReceiver.StreamFunded.selector) {
                funded = true;
            }
        }
    }

    // ================================================================================================ P4.12

    /// BC-021: a Safe that reverts or uses all its gas (its code etched at the fixed address) makes payPlatform
    /// revert with the credit and the claims kept; every other function keeps working meanwhile (collect, fundFees,
    /// fundDepth, payFit, the router's flush); once the Safe accepts, the kept credit is paid in full.
    function testFuzz_AUDIT_U4_failingSafeBlocksOnlyItsOwnPayout(bool burnAll) public {
        _toGraduated();
        _fundFees(eoa[1], 30 ether);
        vm.etch(safe, burnAll ? address(gasBurner).code : address(ethRefuser).code);
        uint256 owed = receiver.platformOwed();
        uint256 claims = _claims(a.receiver, address(0));
        (bool ok,) = a.receiver.call{gas: 5_000_000}(abi.encodeCall(IBoxReceiver.payPlatform, ()));
        assertFalse(ok, "the Safe's refusal reverts payPlatform");
        assertEq(receiver.platformOwed(), owed, "the credit stays");
        assertEq(_claims(a.receiver, address(0)), claims, "the claims stay");
        _batchOf(0.05 ether);
        _collect(keeper, keeper);
        _fundFees(eoa[2], 15 ether);
        _fundDepth(eoa[2], 1 ether);
        _payFit(keeper);
        _payRoyalty(eoa[0], 1 ether);
        royaltyRouter.flush();
        uint256 owedNow = receiver.platformOwed();
        assertGt(owedNow, owed, "credits keep accruing for the Safe");
        vm.etch(safe, "");
        uint256 s0 = safe.balance;
        assertEq(_payPlatform(keeper), owedNow);
        assertEq(safe.balance - s0, owedNow, "paid in full once the Safe accepts");
        _assertGhostLedger();
    }

    /// BC-021 for FIT's payout (map gap 8: a reverting or gas-burning executor in place of FIT's): with the
    /// executor's code replaced by a refusing or gas-burning account for the call (`vm.etch`, its storage untouched),
    /// payFit reverts with `fitOwed` and the claims kept; collect, fundFees, fundDepth, payPlatform and the router's
    /// flush keep working; with the real code back, payFit pays everything owed by then, once.
    function testFuzz_AUDIT_U4_failingExecutorBlocksOnlyPayFit(bool burnAll) public {
        _toGraduated();
        _fundFees(eoa[1], 3 ether);
        bytes memory code = a.executor.code;
        vm.etch(a.executor, burnAll ? address(gasBurner).code : address(ethRefuser).code);
        uint256 owed = receiver.fitOwed();
        uint256 claims = _claims(a.receiver, address(0));
        (bool ok,) = a.receiver.call{gas: 3_000_000}(abi.encodeCall(IBoxReceiver.payFit, ()));
        assertFalse(ok, "the executor's refusal reverts payFit");
        assertEq(receiver.fitOwed(), owed, "FIT's credit stays");
        assertEq(_claims(a.receiver, address(0)), claims, "the claims stay");
        _batchOf(0.05 ether);
        _collect(keeper, keeper);
        _fundFees(eoa[2], 15 ether);
        _fundDepth(eoa[2], 1 ether);
        _payPlatform(keeper);
        _payRoyalty(eoa[0], 1 ether);
        royaltyRouter.flush();
        vm.etch(a.executor, code);
        uint256 owedNow = receiver.fitOwed();
        assertGt(owedNow, owed, "FIT's credit kept accruing");
        uint256 budget0 = executor.budget();
        assertEq(_payFit(keeper), owedNow, "paid in full once the executor accepts");
        assertEq(executor.budget() - budget0, owedNow, "into the budget");
        assertEq(receiver.fitOwed(), 0);
        _assertGhostLedger();
    }

    /// BC-021, P4.12: a tip recipient that reverts or uses all its gas reverts only that collect (its caller's
    /// choice); the batch waits whole and the next caller with any accepting recipient (an EOA, a contract, an
    /// EIP-7702 EOA) collects it.
    function testFuzz_AUDIT_U4_failingTipRecipientBlocksOnlyItsCollect(bool burnAll, uint8 who) public {
        _toGraduated();
        _batchOf(0.05 ether);
        (uint256 uq0,) = _unbooked();
        address bad = burnAll ? address(gasBurner) : address(ethRefuser);
        (bool ok,) = a.receiver.call{gas: 5_000_000}(abi.encodeCall(IBoxReceiver.collect, (bad)));
        assertFalse(ok, "that collect reverts");
        (uint256 uq1,) = _unbooked();
        assertEq(uq1, uq0, "the batch waits whole");
        address[3] memory good = [eoa[4], address(contractDrawer), eoa7702];
        address tipTo = good[who % 3];
        uint256 e0 = tipTo.balance;
        _collect(eoa[6], tipTo);
        assertEq(tipTo.balance - e0, TIP_MAX, "the next caller's recipient gets the tip");
        _assertGhostLedger();
    }
}
