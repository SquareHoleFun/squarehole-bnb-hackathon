// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {AuditU4ClaudeBase, U4Books} from "./AuditU4ClaudeBase.sol";

/// @title AuditU4ClaudeCapTest
/// @notice TEST ONLY (SH-AUDIT-B0 U4, Claude). P4.4: box 0's platform cap by every path that reaches the receiver
/// (collect, fundFees, the royalty router's flush of ETH and WETH, the coordinator's forwarded gift claims, a late
/// settlement), with forced ETH, fundDepth and the executor's receive beside them, across epoch edges ± 1 s.
/// Sources: BoxReceiver.sol:39-42 and :741-771 (`_capPlatform`, `_count`), IBoxReceiver.sol:34-37, :62-64; BC-106,
/// BC-107, BC-141, BC-143; F62 (`DECISION-LOG.md:77`), F64, F77. What holds is checked as a credit per epoch (the
/// `keep` of BC-106) and the Safe's receipts against it; proof 01 records the receipts reading (Note).
/// forge-config: default.evm_version = "osaka"
contract AuditU4ClaudeCapTest is AuditU4ClaudeBase {
    // ================================================================================================ every path

    /// BC-107 on the factory's box 0: in one epoch the Safe is credited exactly 32 ETH whatever arrives (royalties in
    /// ETH and WETH, a gift to the ETH intake, a fee batch, fundDepth, forced ETH, FIT's executor's receive); the
    /// excess goes to the hook's claims; nothing of fundDepth, forced ETH or the executor's 10 ETH counts as P.
    function testProperty_AUDIT_U4_capByEveryPathInOneEpoch() public {
        _toGraduated();
        _advance(1);
        (uint256 epoch0, uint256 kept0,) = receiver.platformEpoch();
        assertEq(epoch0, 0, "epoch 0");
        uint256 credit0 = receiver.platformOwed();
        assertEq(kept0, credit0, "everything kept so far is owed, nothing paid");
        // Royalties: 6 ETH and 30 WETH at the router, then anyone flushes (fundFees with 36 ETH).
        _payRoyalty(eoa[0], 6 ether);
        _payRoyaltyWeth(eoa[0], 30 ether);
        U4Books memory b0 = _books();
        uint256 flushed = royaltyRouter.flush();
        assertEq(flushed, 36 ether, "ETH and unwrapped WETH");
        U4Books memory b1 = _books();
        uint256 u = (36 ether + b0.qCarry) / 15;
        assertEq(b1.platformOwed - b0.platformOwed, 2 * u, "the router's P under the room: all kept");
        // A 15 ETH gift to the intake, 10 ETH to FIT's executor, 5 ETH fundDepth, 1 ETH forced.
        _fundFees(eoa[1], 15 ether);
        _fundBudget(eoa[2], 10 ether);
        _fundDepth(eoa[2], 5 ether);
        _forceEth(a.receiver, 1 ether);
        _fundDepth(eoa[2], 0);
        // A big fee batch (gifted claims, as fees any account adds) fills the cap.
        _batchOf(225 ether);
        _collect(keeper, keeper);
        (uint256 e1, uint256 kept1, uint256 rem1) = receiver.platformEpoch();
        assertEq(e1, 0);
        assertEq(kept1, CAP, "the epoch's credit is exactly the cap");
        assertEq(rem1, 0);
        // More of everything in the same epoch, to its last second: no credit.
        _warpToEpoch(1, -1);
        uint256 owed = receiver.platformOwed();
        _fundFees(eoa[1], 150 ether);
        _payRoyalty(eoa[0], 1 ether);
        royaltyRouter.flush();
        assertEq(receiver.platformOwed(), owed, "epoch 0 is full until its last second");
        // One second later: a new epoch with the whole cap, no carry-over.
        _warpToEpoch(1, 0);
        _fundFees(eoa[1], 150 ether);
        assertEq(receiver.platformOwed() - owed, 20 ether, "epoch 1: P of 150 ETH (20 ETH), all kept");
        (uint256 e2, uint256 kept2,) = receiver.platformEpoch();
        assertEq(e2, 1);
        assertEq(kept2, 20 ether);
        uint256 s0 = safe.balance;
        uint256 paid = _payPlatform(eoa[7]);
        assertEq(safe.balance - s0, paid, "the Safe receives exactly what was owed");
        assertEq(paid, CAP + 20 ether, "epoch 0's 32 ETH and epoch 1's 20 ETH");
        _assertNoOpenDelta();
        _assertGhostLedger();
    }

    /// P4.4 at the edges: a fuzzed sequence of intakes (fundFees, a gifted batch through collect, a royalty flush) and
    /// payouts at times graduatedAt + k·30 d + {−1, 0, +1} s or between. Per epoch, Σ of the PlatformCredited `kept`
    /// is ≤ 32 ETH and equals platformEpoch's `kept` for the current epoch; the Safe receives only through
    /// payPlatform and in total exactly what was credited and paid.
    function testFuzz_AUDIT_U4_capAtEpochEdges(uint8[10] memory paths, uint64[10] memory amounts, uint8[10] memory when)
        public
    {
        _toGraduated();
        uint256 g = coordinator.graduatedAt();
        uint256[8] memory credited;
        uint256 paidTotal;
        uint256 safe0 = safe.balance;
        credited[0] = receiver.platformOwed(); // the settlement's epoch-0 credit
        for (uint256 i; i < 10; ++i) {
            _stepClock(g, when[i]);
            uint256 epoch = _epochNow();
            uint256 amount = 0.01 ether + uint256(amounts[i]) * 16; // up to ~295 ETH
            uint256 sBefore = safe.balance;
            vm.recordLogs();
            paidTotal += _capPath(paths[i] % 4, amount);
            VmSafe.Log[] memory logs = vm.getRecordedLogs();
            for (uint256 e; e < 8; ++e) {
                credited[e] += _creditedIn(logs, e);
            }
            if (paths[i] % 4 != 3) assertEq(safe.balance, sBefore, "the Safe moves only in payPlatform");
            (uint256 ve, uint256 vk,) = receiver.platformEpoch();
            assertEq(ve, epoch);
            assertEq(vk, credited[epoch], "platformEpoch's kept == the sum credited in this epoch");
        }
        uint256 creditedTotal;
        for (uint256 e; e < 8; ++e) {
            assertLe(credited[e], CAP, "at most 32 ETH credited in any epoch");
            creditedTotal += credited[e];
        }
        assertEq(safe.balance - safe0, paidTotal, "the Safe's receipts are the payouts");
        assertEq(paidTotal + receiver.platformOwed(), creditedTotal, "credited == paid + owed");
        _assertNoOpenDelta();
        _assertGhostLedger();
    }

    /// One of four paths; returns what payPlatform paid (0 for the others).
    function _capPath(uint256 path, uint256 amount) internal returns (uint256 paid) {
        if (path == 0) {
            _fundFees(eoa[1], amount);
        } else if (path == 1) {
            _batchOf(amount);
            _collect(keeper, eoa[5]);
        } else if (path == 2) {
            _payRoyalty(eoa[0], amount);
            royaltyRouter.flush();
        } else if (receiver.platformOwed() != 0) {
            paid = _payPlatform(eoa[7]);
        }
    }

    /// Moves the clock to an epoch edge ± 1 s, or 12 s or 1 day on (never back).
    function _stepClock(uint256 g, uint8 w) internal {
        uint256 now_ = vm.getBlockTimestamp();
        uint256 k = (now_ - g) / EPOCH + 1; // the next boundary
        uint256 t;
        uint256 kind = w % 5;
        if (kind == 0) t = g + k * EPOCH - 1;
        else if (kind == 1) t = g + k * EPOCH;
        else if (kind == 2) t = g + k * EPOCH + 1;
        else if (kind == 3) t = now_ + 12;
        else t = now_ + 1 days;
        if (t <= now_) t = now_ + 1;
        if (t > g + 7 * EPOCH) t = now_ + 1; // stay within the epochs the test reads
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(t);
    }

    // ================================================================================================ epoch 0

    /// P4.4, BC-106 (pre-graduation P counts in epoch 0) through the coordinator's path: Q claims anyone gave the
    /// coordinator before graduation beyond its reserve are forwarded at graduation (BoxCoordinator.sol:276-283) and
    /// split in the settlement inside graduate(), in epoch 0: the Safe keeps at most 32 ETH of them and the held P,
    /// the rest goes to depth; FIT gets 11/15.
    function testProperty_AUDIT_U4_coordinatorGiftCountsInEpochZero() public {
        _toClosed();
        uint256 reserve = _claims(a.coordinator, address(0));
        _giftEth(a.coordinator, 300 ether);
        uint256 heldP = receiver.platformHeld();
        U4Books memory b0 = _books();
        _toGraduated();
        assertEq(graduationPokeFailures, 0, "every poke succeeded");
        assertTrue(receiver.graduationSettled());
        uint256 reward = _claims(a.coordinator, address(0));
        assertEq(reward, graduationReward, "the coordinator keeps only the reward");
        uint256 forwarded = reserve + 300 ether - reward;
        assertGe(forwarded, 300 ether, "the whole gift is forwarded to the receiver");
        assertEq(receiver.platformOwed(), CAP, "epoch 0's credit is capped at 32 ETH (held P + the gift's P exceed it)");
        (uint256 e0, uint256 k0,) = receiver.platformEpoch();
        assertEq(e0, 0);
        assertEq(k0, CAP);
        assertGe(receiver.fitOwed() - b0.fitOwed, forwarded * 11 / 15 - 15, "FIT gets 11/15 of the forwarded claims");
        assertGt(heldP, 0, "the curve's held P counted too");
        // Epoch 0 is full; epoch 1 has its own cap.
        _fundFees(eoa[1], 15 ether);
        assertEq(receiver.platformOwed(), CAP, "no room left in epoch 0");
        _warpToEpoch(1, 0);
        _fundFees(eoa[1], 15 ether);
        assertEq(receiver.platformOwed(), CAP + 2 ether, "epoch 1's own cap");
        _assertGhostLedger();
    }

    /// BC-106, BC-143 (the documented late path): with graduation's poke of the receiver failing (harness: the poke
    /// reverted by a mock, as M31 etched a gas sink), the held P is capped in epoch 0 on the first receiver call 45
    /// days later, and that call's own P counts in the epoch it runs in (here epoch 1), in one transaction.
    function testProperty_AUDIT_U4_lateSettlementCountsHeldInEpochZero() public {
        _toBonding();
        _fundFees(eoa[1], 300 ether); // P = 40 ETH held before graduation
        uint256 failures = _toGraduatedLate();
        assertGe(failures, 1, "the receiver's poke failed");
        _warpToEpoch(1, 15 days);
        _payRoyalty(eoa[0], 15 ether);
        vm.recordLogs();
        royaltyRouter.flush(); // the first receiver call: the settlement, then the flush's split
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(receiver.graduationSettled());
        assertEq(_creditedIn(logs, 0), CAP, "the held P: epoch 0, capped at 32 ETH");
        assertEq(_creditedIn(logs, 1), 2 ether, "the flush's P: epoch 1");
        assertEq(receiver.platformOwed(), CAP + 2 ether);
        (uint256 e, uint256 kept,) = receiver.platformEpoch();
        assertEq(e, 1);
        assertEq(kept, 2 ether, "epoch 1's counter holds only epoch 1's credit");
        _assertNoOpenDelta();
        _assertGhostLedger();
    }

    /// P4.9 / BC-143 (the late path is not reached in the world): graduate() settles the receiver inside its poke
    /// (no PokeFailed), at graduatedAt, and the settlement's cost is far below POKE_GAS (2,600,000) even late, with
    /// held depth, held P, held FIT and a final batch; the poke cannot fail for gas.
    function testProperty_AUDIT_U4_settlementRunsInsideGraduation() public {
        _toGraduated();
        assertEq(graduationPokeFailures, 0, "no poke failed");
        assertTrue(receiver.graduationSettled(), "settled inside graduate()");
        (uint256 hq, uint256 ht) = receiver.depthHeld();
        assertEq(hq, 0);
        assertEq(ht, 0);
        assertEq(receiver.platformHeld(), 0);
    }

    /// The settlement's gas, measured late (the harness), against POKE_GAS.
    function testProperty_AUDIT_U4_settlementGasBelowPokeGas() public {
        _toBonding();
        _fundFees(eoa[1], 30 ether);
        _batchOf(1 ether); // a final batch at the settlement
        _toGraduatedLate();
        _warpToEpoch(2, 0);
        uint256 g0 = gasleft();
        receiver.onGraduation();
        uint256 used = g0 - gasleft();
        emit log_named_uint("onGraduation gas (late, held parts and a final batch)", used);
        assertLt(used, BoxCoordinator(a.coordinator).POKE_GAS() / 4, "within a quarter of POKE_GAS");
        assertTrue(receiver.graduationSettled());
        vm.expectRevert(IBoxReceiver.AlreadySettled.selector);
        receiver.onGraduation();
    }

    // ================================================================================================ receipts

    /// What holds instead of a per-epoch receipt cap (see proof 01): the Safe's receipts by the end of epoch k never
    /// exceed (k + 1) × 32 ETH, whatever the payout timing, because every credit is counted in one epoch.
    function testProperty_AUDIT_U4_safeReceiptsBoundedByElapsedEpochs() public {
        _toGraduated();
        uint256 s0 = safe.balance;
        for (uint256 k; k < 4; ++k) {
            _warpToEpoch(k, 1);
            _fundFees(eoa[1], 300 ether);
            if (k % 2 == 1) _payPlatform(eoa[7]);
            assertLe(safe.balance - s0 + receiver.platformOwed(), (k + 1) * CAP, "credited by epoch k <= (k+1) caps");
        }
        if (receiver.platformOwed() != 0) _payPlatform(eoa[7]);
        assertEq(safe.balance - s0, 4 * CAP, "four full epochs");
        _assertGhostLedger();
    }

    /// BC-141 ("the Safe's balances rise only through box 0's receiver's payPlatform()") against the one other way box
    /// 0's receiver can pay the Safe: a collect whose caller names the Safe as its tip recipient (`tipTo` is any
    /// address: BoxReceiver.sol:158, :170-173, :955). The tip is the caller's own (D2, F53: self-paying batches), at
    /// most min(10% of the batch, 0.0005 ETH) per collect, never a credit: the cap's counter and `platformOwed` move
    /// only by the batch's P. Pinned as built; the evidence asks the founder whether BC-141's text should name it.
    function testProperty_AUDIT_U4_onlyACallersTipReachesTheSafeOutsidePayPlatform() public {
        _toGraduated();
        _batchOf(0.02 ether);
        uint256 s0 = safe.balance;
        uint256 owed0 = receiver.platformOwed();
        (uint256 carry0,) = receiver.carried();
        (, uint256 kept0,) = receiver.platformEpoch();
        _collect(keeper, safe);
        assertEq(safe.balance - s0, TIP_MAX, "the caller's tip, paid to the Safe it named");
        (, uint256 kept1,) = receiver.platformEpoch();
        assertEq(kept1 - kept0, receiver.platformOwed() - owed0, "the cap counts the credit only, never the tip");
        assertEq(receiver.platformOwed() - owed0, 2 * ((0.02 ether - TIP_MAX + carry0) / FIFTEEN), "the batch's P only");
        _assertGhostLedger();
    }

    // ================================================================================================ proof

    // W1-U4-2, accepted as built (FQ-09, F147): the cap counts credits per epoch; IBoxReceiver and BC-141 say so.
    /// @notice Proof 01 (Note). Property: "box 0's Safe receives at most PLATFORM_CAP_WEI per epoch by every path"
    /// (IBoxReceiver.sol:62-63); BC-141 "The Safe's balances rise only through box 0's receiver's payPlatform(), by at
    /// most 32 ETH per epoch"; the plan's X07 and the brief's P4.4 ("Safe receipts per 30-day epoch ≤
    /// PLATFORM_CAP_WEI").
    /// Expected (as written): the Safe's ETH rises by at most 32 ETH within one epoch.
    /// Observed: the cap applies to credits (`_capPlatform` keeps min(P, 32 ETH − kept this epoch) as `platformOwed`,
    /// BoxReceiver.sol:746-756); `payPlatform` (anyone, any time, BoxReceiver.sol:343-355) pays every credit not yet
    /// paid, so one call in epoch 1 delivers epoch 0's credit and epoch 1's: 64 ETH within epoch 1.
    /// Steps: graduate (the settlement credits epoch 0's held P); fundFees(300 ETH) in epoch 0 (P = 40 ETH: epoch 0
    /// fills to 32 ETH, the rest to depth); fundFees(300 ETH) at g + 30 d + 1 s (epoch 1: 32 ETH kept); nobody paid
    /// the Safe in epoch 0; one payPlatform in epoch 1. Amounts: 32 + 32 ETH credited, 64 ETH received in epoch 1.
    /// No value effect: per-epoch credits stay ≤ 32 ETH (testFuzz_AUDIT_U4_capAtEpochEdges, the invariant worlds) and
    /// receipts by the end of epoch k ≤ (k + 1) × 32 ETH (testProperty_AUDIT_U4_safeReceiptsBoundedByElapsedEpochs).
    function testAccepted_AUDIT_U4_01_safeReceiptsPerEpochExceedTheCapWhenPaidLate() public {
        _toGraduated();
        _fundFees(eoa[1], 300 ether);
        _warpToEpoch(1, 1);
        _fundFees(eoa[1], 300 ether);
        assertEq(_epochNow(), 1);
        uint256 s0 = safe.balance;
        uint256 paid = _payPlatform(eoa[7]);
        assertEq(paid, 2 * CAP, "two epochs' credits in one payout");
        assertEq(safe.balance - s0, 64 ether, "observed: 64 ETH received within epoch 1");
        assertGt(safe.balance - s0, CAP, "more than PLATFORM_CAP_WEI within one epoch");
        _assertGhostLedger();
    }
}
