// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {IBoxItemStream} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {ModuleProceedsTo} from "../../../../src/box/interfaces/BoxTypes.sol";
import {
    AuditU4FableBase,
    AuditU4FableGasProbe,
    AuditU4FableGasSink,
    AuditU4FableInsideTip,
    AuditU4FableReenterTip,
    AuditU4Tally
} from "./AuditU4FableBase.sol";

/// @notice SH-AUDIT-B0 U4 (Fable), lens L3 reentrancy and callbacks, run under Osaka and under Amsterdam (the stream's
/// gas cap and the `StreamGasTooLow` floor are gas rules): the two receiver halves share one transient lock, the
/// stream's notice is capped at 200,000 gas and fail-safe, a failing Safe or tip recipient blocks only its own payout,
/// a short gas budget refuses the collect rather than shorting the stream, and the receiver's open unlock gives a tip
/// recipient no way to break the accounting.
abstract contract AuditU4FableReentrancyBase is AuditU4FableBase {
    bytes4 internal constant REENTRANCY = 0xab143c06;

    function setUp() public virtual override {
        super.setUp();
        _toGraduated();
    }

    function _batch() internal {
        _trade(eoa[3], 0.8 ether, 2_000);
        _advance(1);
    }

    /// P4.10: a tip recipient re-entering any entry point of either half while `collect` is mid-call gets
    /// `Reentrancy()`: the extension's functions (DELEGATECALL) read the clone's lock. `initialize` has no lock and
    /// refuses on its caller instead.
    function testProperty_AUDIT_U4_oneLockForBothHalves() public {
        AuditU4FableReenterTip tip = new AuditU4FableReenterTip();
        bytes[13] memory calls = [
            abi.encodeCall(IBoxReceiver.collect, (address(tip))),
            abi.encodeCall(IBoxReceiver.onGraduation, ()),
            abi.encodeCall(IBoxReceiver.pullForModule, ()),
            abi.encodeCall(IBoxReceiver.moduleProceeds, (ModuleProceedsTo.FitQ, 1)),
            abi.encodeCall(IBoxReceiver.fundFees, ()),
            abi.encodeCall(IBoxReceiver.fundDepth, ()),
            abi.encodeCall(IBoxReceiver.fundCreator, ()),
            abi.encodeCall(IBoxReceiver.payFit, ()),
            abi.encodeCall(IBoxReceiver.payPlatform, ()),
            abi.encodeCall(IBoxReceiver.claimCreator, (address(tip))),
            abi.encodeCall(IBoxReceiver.noteModuleFees, (1, 0)),
            abi.encodeCall(IBoxReceiver.proposeCreatorPayee, (address(tip))),
            abi.encodeCall(IBoxReceiver.acceptCreatorPayee, ())
        ];
        for (uint256 i; i < calls.length; ++i) {
            _batch();
            tip.arm(a.receiver, 0, calls[i]);
            _collect(keeper, address(tip));
            assertTrue(tip.called(), "the tip's receive ran");
            assertFalse(tip.ok(), string.concat("refused while mid-call: ", vm.toString(i)));
            assertEq(_selector(tip.ret()), REENTRANCY, string.concat("Reentrancy(): ", vm.toString(i)));
        }
        _batch();
        tip.arm(a.receiver, 0, abi.encodeCall(IBoxReceiver.initialize, ()));
        _collect(keeper, address(tip));
        assertEq(_selector(tip.ret()), IBoxReceiver.NotCoordinator.selector, "initialize: no lock, the caller check");
        // Nor can it drive the PoolManager into the receiver's callback, or open another unlock.
        _batch();
        tip.arm(a.receiver, 0, abi.encodeWithSignature("unlockCallback(bytes)", ""));
        _collect(keeper, address(tip));
        assertEq(_selector(tip.ret()), IBoxReceiver.NotPoolManager.selector);
        _batch();
        tip.arm(address(pm), 0, abi.encodeWithSignature("unlock(bytes)", ""));
        _collect(keeper, address(tip));
        assertFalse(tip.ok(), "a nested unlock is refused by the PoolManager (AlreadyUnlocked)");
        _assertGhostLedger();
    }

    /// P4.11, BC-139: a stream whose notice reverts or burns all its gas leaves the batch fully accounted (the T was
    /// delivered first) and `collect` succeeds; the notice gets exactly the 200,000-gas cap.
    function testProperty_AUDIT_U4_streamFailureLeavesTheBatchAccounted() public {
        bytes memory streamCode = a.itemStream.code;
        // (a) The notice reverts.
        vm.mockCallRevert(a.itemStream, IBoxItemStream.onStreamFunds.selector, "stream: no");
        _batch();
        uint256 streamT0 = token.balanceOf(a.itemStream);
        (uint256 uq, uint256 ut) = _unbooked();
        (uint256 cq, uint256 ct) = receiver.carried();
        vm.recordLogs();
        _collect(keeper, keeper);
        AuditU4Tally memory t = _tally(vm.getRecordedLogs());
        assertEq(t.streamFailures, 1, "StreamNotifyFailed");
        assertEq(t.streamNotices, 0);
        assertGt(t.tStream, 0);
        assertEq(token.balanceOf(a.itemStream) - streamT0, t.tStream, "the T reached the stream all the same");
        _assertBatchConserved(t, uq, ut, cq, ct);
        _assertFifteenths(t, true);
        vm.clearMockedCalls();
        // (b) The notice burns every unit of gas it is given.
        vm.etch(a.itemStream, address(new AuditU4FableGasSink()).code);
        _batch();
        streamT0 = token.balanceOf(a.itemStream);
        vm.recordLogs();
        vm.prank(keeper);
        receiver.collect{gas: 3_000_000}(keeper);
        t = _tally(vm.getRecordedLogs());
        assertEq(t.streamFailures, 1, "a gas burner only loses its cap");
        assertEq(token.balanceOf(a.itemStream) - streamT0, t.tStream);
        // (c) The notice gets exactly STREAM_NOTIFY_GAS.
        AuditU4FableGasProbe probe = new AuditU4FableGasProbe();
        vm.etch(a.itemStream, address(probe).code);
        _batch();
        vm.prank(keeper);
        receiver.collect(keeper);
        uint256 given = uint256(vm.load(a.itemStream, probe.probeSlot()));
        emit log_named_uint("gas the stream's notice had at entry", given);
        assertLe(given, STREAM_GAS, "never above the cap");
        assertGe(given, STREAM_GAS - 100, "and the whole cap, less the entry's own opcodes");
        vm.etch(a.itemStream, streamCode);
        // The real stream is whole again: the next batch's notice succeeds.
        _batch();
        vm.recordLogs();
        _collect(keeper, keeper);
        t = _tally(vm.getRecordedLogs());
        assertEq(t.streamNotices, 1);
        assertEq(t.streamFailures, 0);
    }

    /// P4.12, BC-021, M22 (recorded): a Safe whose code reverts or burns gas blocks only `payPlatform`, whose credit
    /// stays; every other function keeps working; once the Safe takes ETH again the credit is paid.
    function testProperty_AUDIT_U4_safeFailureBlocksOnlyPayPlatform() public {
        _fundFees(eoa[0], 3 ether);
        uint256 owed = receiver.platformOwed();
        assertGt(owed, 0);
        vm.etch(safe, address(ethRefuser).code);
        vm.expectRevert();
        receiver.payPlatform();
        assertEq(receiver.platformOwed(), owed, "the credit stays");
        _everythingElseWorks();
        vm.etch(safe, address(new AuditU4FableGasSink()).code);
        (bool ok,) = a.receiver.call{gas: 1_000_000}(abi.encodeCall(IBoxReceiver.payPlatform, ()));
        assertFalse(ok, "a gas-burning Safe fails its own payout");
        assertEq(receiver.platformOwed() + 0, receiver.platformOwed());
        _everythingElseWorks();
        vm.etch(safe, "");
        uint256 owedNow = receiver.platformOwed();
        assertEq(_payPlatform(eoa[1]), owedNow);
        assertEq(safe.balance, owedNow);
    }

    function _everythingElseWorks() internal {
        _batch();
        _collect(keeper, keeper);
        _fundFees(eoa[0], 0.2 ether);
        _fundDepth(eoa[0], 0.1 ether);
        _payRoyalty(eoa[2], 0.2 ether);
        royaltyRouter.flush();
        _payFit(eoa[1]);
    }

    /// P4.12, BC-021: a tip recipient that refuses ETH or burns all its gas fails only its caller's collect; the next
    /// caller with a good recipient (an EIP-7702-delegated EOA here) collects the same batch.
    function testProperty_AUDIT_U4_tipRecipientFailureBlocksOnlyItsCollect() public {
        _batch();
        vm.expectRevert();
        vm.prank(keeper);
        receiver.collect(address(ethRefuser));
        (bool ok,) = a.receiver.call{gas: 2_000_000}(abi.encodeCall(IBoxReceiver.collect, (address(gasBurner))));
        assertFalse(ok, "a gas-burning tip recipient fails its collect");
        uint256 e0 = eoa7702.balance;
        uint256 tip = _collect(keeper, eoa7702).tip;
        assertGt(tip, 0);
        assertEq(eoa7702.balance - e0, tip, "the delegated EOA got the tip (an all-gas call, no stipend)");
        _assertGhostLedger();
    }

    /// P4.11: a `collect` sent with too little gas to give the stream its whole cap reverts (`StreamGasTooLow`) and
    /// changes nothing, instead of running the notice with a short budget; one unit more and it succeeds.
    function testProperty_AUDIT_U4_lowGasRefusesRatherThanShortingTheStream() public {
        _batch();
        uint256 lo = 150_000;
        uint256 hi = 3_000_000;
        (bool okHi,) = _tryCollect(hi);
        assertTrue(okHi);
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            (bool ok,) = _tryCollect(mid);
            if (ok) hi = mid;
            else lo = mid;
        }
        emit log_named_uint("least gas with which collect succeeds here", hi);
        (bool okLo, bytes4 sel) = _tryCollect(lo);
        assertFalse(okLo);
        assertEq(sel, BoxReceiver.StreamGasTooLow.selector, "one unit less: refused by the stream gas check");
        assertGe(_collect(keeper, keeper).q, BATCH_MIN, "nothing changed: the batch was still waiting");
    }

    function _tryCollect(uint256 gas_) internal returns (bool ok, bytes4 sel) {
        uint256 snap = vm.snapshotState();
        vm.prank(keeper);
        bytes memory ret;
        (ok, ret) = a.receiver.call{gas: gas_}(abi.encodeCall(IBoxReceiver.collect, (keeper)));
        sel = ok ? bytes4(0) : _selector(ret);
        vm.revertToState(snap);
    }

    /// P4.3, P4.5 (observation): a tip recipient can use the receiver's open unlock to mint claims to the receiver and
    /// to take ETH into it (its `receive` accepts the PoolManager inside the guarded call). Both are donations: the
    /// minted claims are the next batch, the ETH is forced ETH that only `fundDepth` moves; the batch being paid is
    /// unaffected.
    function testProperty_AUDIT_U4_openUnlockInsideCollectCannotBreakAccounting() public {
        AuditU4FableInsideTip tip = new AuditU4FableInsideTip(pm);
        vm.deal(address(tip), 1 ether);
        _batch();
        (uint256 uq, uint256 ut) = _unbooked();
        (uint256 cq, uint256 ct) = receiver.carried();
        tip.arm(a.receiver, 0.3 ether, 0.7 ether);
        vm.recordLogs();
        _collect(keeper, address(tip)); // books the tip's net move: its 1 ETH in, less the tip it got
        AuditU4Tally memory t = _tally(vm.getRecordedLogs());
        assertTrue(tip.ran(), "the tip used the open unlock");
        _assertBatchConserved(t, uq, ut, cq, ct);
        (uint256 uq1,) = _unbooked();
        assertEq(uq1, 0.3 ether, "the minted claims are the next batch");
        assertEq(a.receiver.balance, 0.7 ether, "the taken ETH sits as forced ETH");
        uint256 hookQ0 = _claimsQ(a.hook);
        _fundDepth(eoa[1], 0);
        assertEq(_claimsQ(a.hook) - hookQ0, 0.7 ether, "forced ETH: depth only, never fees, never the Safe");
        vm.recordLogs();
        _mintClaimsTo(a.receiver, BATCH_MIN);
        _collect(keeper, keeper);
        t = _tally(vm.getRecordedLogs());
        assertEq(t.collectedQ, 0.3 ether + BATCH_MIN, "the minted claims were split with the next batch");
        _assertGhostLedger();
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU4FableReentrancyTest is AuditU4FableReentrancyBase {}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU4FableReentrancyAmsterdamTest is AuditU4FableReentrancyBase {}
