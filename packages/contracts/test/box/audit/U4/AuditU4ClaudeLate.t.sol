// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {AuditU4ClaudeBase, U4Books} from "./AuditU4ClaudeBase.sol";

/// @title AuditU4ClaudeLateTest
/// @notice TEST ONLY (SH-AUDIT-B0 U4, Claude). The late graduation settlement (P4.4, P4.9): BC-106 "the held
/// pre-graduation platform share counts in epoch 0, however late the settlement runs", BC-143 (held depth moved whole
/// at the settlement), BC-133 "a note still pending at a late settlement returns there", and `_settleIfDue`
/// (BoxReceiver.sol:1031-1036: "the first call after graduation runs the settlement (anyone's call does it)").
/// Sources: BoxReceiver.sol:184-189, :741-771, :852-900, :902-932; IBoxReceiver.sol:34-37, :155-157.
/// Harness: the late state needs graduation's poke of the receiver to fail; it gets exactly POKE_GAS (2,600,000;
/// BoxCoordinator.sol:532-541) and the settlement costs far less (testProperty_AUDIT_U4_settlementGasBelowPokeGas), so
/// the state is reached with `vm.mockCallRevert` on the receiver's `onGraduation` for that one call
/// (`_toGraduatedLate`), as the money review's M31 etched a gas sink there. Everything after is the real code.
/// forge-config: default.evm_version = "osaka"
contract AuditU4ClaudeLateTest is AuditU4ClaudeBase {
    struct Credit {
        uint256 epoch;
        uint256 kept;
        uint256 toDepth;
    }

    /// Any first receiver call (collect, fundFees, fundDepth, payFit, payPlatform, the router's flush into fundFees,
    /// onGraduation), 0 to 200 days after graduation, with 0 to 400 ETH of pre-graduation fundFees held: the call
    /// settles first, in its own transaction; the held P is credited in epoch 0 (capped), then the final batch's P in
    /// epoch 0 with the room left, each to the wei as `_capPlatform` computes; the call's own P is credited in the
    /// epoch it runs in; platformEpoch then names that epoch with exactly its credits; held depth (Q and T) has moved
    /// to the hook; the Safe receives only through payPlatform.
    function testFuzz_AUDIT_U4_lateSettlementByAnyEntryPoint(uint8 entryRaw, uint32 delayRaw, uint96 preRaw) public {
        _toBonding();
        uint256 pre = bound(preRaw, 0, 400 ether);
        if (pre != 0) _fundFees(eoa[1], pre);
        _batchOf(0.3 ether);
        _toGraduatedLate();
        uint256 delay = bound(delayRaw, 0, 200 days);
        if (delay != 0) {
            vm.roll(vm.getBlockNumber() + 1 + delay / 12);
            vm.warp(vm.getBlockTimestamp() + delay);
        }
        uint256 entry = entryRaw % 7;
        // What each entry needs, with no receiver call: trades for collect's own batch (its harvest runs after the
        // settlement has taken every unbooked claim), royalties for the flush.
        if (entry == 0) _tradeBothSides(1 ether);
        if (entry == 5) _payRoyalty(eoa[0], 15 ether);
        assertFalse(receiver.graduationSettled(), "nothing settled before the first receiver call");

        U4Books memory b0 = _books();
        LateExpect memory x = _lateExpect(b0);
        uint256 safe0 = safe.balance;
        vm.recordLogs();
        uint256 paidToSafe = _enter(entry);
        Credit[] memory credits = _credits(vm.getRecordedLogs());
        assertTrue(receiver.graduationSettled(), "settled by the first receiver call");
        uint256 keptNow = _assertCredits(b0, x, credits);
        (uint256 e, uint256 kept, uint256 remaining) = receiver.platformEpoch();
        assertEq(e, x.epochNow, "platformEpoch names the epoch now");
        assertEq(kept, keptNow, "and exactly its credits");
        assertEq(remaining, CAP - keptNow);
        _assertHeldMoved(b0, _books());
        assertEq(safe.balance - safe0, paidToSafe, "the Safe moves only in payPlatform");
        vm.expectRevert(IBoxReceiver.AlreadySettled.selector);
        receiver.onGraduation();
        _assertNoOpenDelta();
        _assertGhostLedger();
    }

    /// @dev What the late settlement credits in epoch 0, from the books before it (BoxReceiver.sol:856-899):
    /// keep0 = min(held P, CAP); the final batch's P = 2 × ⌊(unbooked Q + carry) / 15⌋ (no notes pending here) and
    /// keep1 = min(that P, CAP − keep0).
    struct LateExpect {
        uint256 keep0;
        uint256 p1;
        uint256 keep1;
        uint256 epochNow;
    }

    function _lateExpect(U4Books memory b0) internal view returns (LateExpect memory x) {
        (uint256 newQ,) = _unbooked();
        x.keep0 = b0.platformHeld < CAP ? b0.platformHeld : CAP;
        x.p1 = 2 * ((newQ + b0.qCarry) / FIFTEEN);
        x.keep1 = x.p1 < CAP - x.keep0 ? x.p1 : CAP - x.keep0;
        x.epochNow = _epochNow();
    }

    /// @dev The credits in order: the held P (epoch 0), the final batch's P (epoch 0), then the call's own (the epoch
    /// now). Returns the epoch now's total.
    function _assertCredits(U4Books memory b0, LateExpect memory x, Credit[] memory credits)
        internal
        pure
        returns (uint256 keptNow)
    {
        uint256 i;
        if (b0.platformHeld != 0) {
            assertEq(credits[i].epoch, 0, "the held P: epoch 0, however late");
            assertEq(credits[i].kept, x.keep0, "the held P: min(held, 32 ETH)");
            assertEq(credits[i].toDepth, b0.platformHeld - x.keep0, "the held P's excess to depth");
            ++i;
        }
        if (x.p1 != 0) {
            assertEq(credits[i].epoch, 0, "the final batch's P: epoch 0 too");
            assertEq(credits[i].kept, x.keep1, "the final batch's P: the room epoch 0 has left");
            ++i;
        }
        keptNow = x.epochNow == 0 ? x.keep0 + x.keep1 : 0;
        for (; i < credits.length; ++i) {
            assertEq(credits[i].epoch, x.epochNow, "the call's own P: the epoch it runs in");
            keptNow += credits[i].kept;
        }
        assertLe(x.epochNow == 0 ? keptNow : x.keep0 + x.keep1, CAP, "epoch 0 within its cap");
    }

    function _assertHeldMoved(U4Books memory b0, U4Books memory b1) internal view {
        assertEq(b1.platformHeld, 0, "nothing held after the settlement");
        (uint256 hq, uint256 ht) = receiver.depthHeld();
        assertEq(hq + ht, 0, "held depth moved");
        assertGe(b1.hookClaimsQ - b0.hookClaimsQ, b0.depthHeldQ, "held Q depth to the hook's claims");
        assertGe(b1.hookClaimsT - b0.hookClaimsT, b0.depthHeldT, "held T depth to the hook's claims");
    }

    /// BC-133: notes pending when the late settlement runs return there, before its split: FIT's executor's (a real
    /// buy after graduation, funded through fundBudget, BC-108) to fitOwed, the hook's (a pranked note of 0.001 ETH
    /// standing in for a conversion's, BoxHookExtension.sol:407) to the hook's claims; never split; the rest of the
    /// final batch split as usual in epoch 0.
    function testProperty_AUDIT_U4_notesPendingAtALateSettlementReturnThere() public {
        _toBonding();
        _batchOf(0.3 ether);
        _toGraduatedLate();
        _fundBudget(eoa[2], 3 ether);
        vm.warp(vm.getBlockTimestamp() + 3600);
        vm.roll(vm.getBlockNumber() + 300);
        (uint256 chunks,,) = executor.execute(1);
        assertEq(chunks, 1, "FIT's executor bought before the receiver settled");
        assertFalse(receiver.graduationSettled(), "its note did not settle the receiver");
        (uint256 noted,) = receiver.moduleFeesPending();
        assertGt(noted, 0, "the executor's note is pending");
        uint256 hookNote = 0.001 ether;
        vm.prank(a.hook);
        receiver.noteModuleFees(hookNote, 0);

        U4Books memory b0 = _books();
        (uint256 newQ,) = _unbooked();
        assertGe(newQ, noted + hookNote, "the final batch covers both notes");
        // The rest of the final batch after both returns, split in fifteenths in epoch 0.
        uint256 rest = newQ - noted - hookNote + b0.qCarry;
        LateExpect memory x;
        x.keep0 = b0.platformHeld < CAP ? b0.platformHeld : CAP;
        x.p1 = 2 * (rest / FIFTEEN);
        x.keep1 = x.p1 < CAP - x.keep0 ? x.p1 : CAP - x.keep0;

        vm.recordLogs();
        vm.prank(keeper);
        receiver.onGraduation();
        (uint256 mq, uint256 hq) = _returned(vm.getRecordedLogs());
        U4Books memory b1 = _books();

        assertEq(mq, noted, "the executor's note returned whole");
        assertEq(hq, hookNote, "the hook's note returned whole");
        assertEq(b1.moduleQPending + b1.hookFeesPending, 0, "no note left pending");
        assertEq(b1.fitOwed - b0.fitOwed, noted + 11 * (rest / FIFTEEN), "FIT: its note back, then 11/15 of the rest");
        assertEq(
            b1.hookClaimsQ - b0.hookClaimsQ,
            b0.depthHeldQ + hookNote + x.p1 + (b0.platformHeld - x.keep0) + (x.p1 - x.keep1),
            "depth: held Q, the hook's note, 2/15, the cap's excess"
        );
        assertEq(b1.platformOwed - b0.platformOwed, x.keep0 + x.keep1, "epoch 0's credit");
        assertEq(b1.qCarry, rest % FIFTEEN, "the carry");
        _assertNoOpenDelta();
        _assertGhostLedger();
    }

    // ================================================================================================ helpers

    function _enter(uint256 entry) internal returns (uint256 paidToSafe) {
        if (entry == 0) {
            _collect(keeper, eoa[5]);
        } else if (entry == 1) {
            _fundFees(eoa[2], 1 ether);
        } else if (entry == 2) {
            _fundDepth(eoa[2], 0.1 ether);
        } else if (entry == 3) {
            _payFit(keeper);
        } else if (entry == 4) {
            paidToSafe = _payPlatform(keeper);
        } else if (entry == 5) {
            royaltyRouter.flush();
        } else {
            vm.prank(keeper);
            receiver.onGraduation();
        }
    }

    function _credits(VmSafe.Log[] memory logs) internal view returns (Credit[] memory c) {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.receiver && logs[i].topics[0] == IBoxReceiver.PlatformCredited.selector) ++n;
        }
        c = new Credit[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != a.receiver || logs[i].topics[0] != IBoxReceiver.PlatformCredited.selector) continue;
            (uint256 k, uint256 d,) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            c[n++] = Credit({epoch: uint256(logs[i].topics[1]), kept: k, toDepth: d});
        }
    }

    function _returned(VmSafe.Log[] memory logs) internal view returns (uint256 mq, uint256 hq) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != a.receiver || logs[i].topics[0] != IBoxReceiver.ModuleFeesReturned.selector) {
                continue;
            }
            (uint256 m,, uint256 h) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            mq += m;
            hq += h;
        }
    }
}
