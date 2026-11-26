// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FeeBatch} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {AuditU4ClaudeBase, U4Books, U4Expected} from "./AuditU4ClaudeBase.sol";

/// @title AuditU4ClaudeSplitTest
/// @notice TEST ONLY (SH-AUDIT-B0 U4, Claude). Lens L1 (value flow) and L7 (fifteenths, carry, tip) on the factory's box
/// 0: every batch's wei in exactly one place, measured on the receiving side (the hook's claims, the stream's T, the
/// tip recipient's ETH, the coordinator's reserve claims, T's supply), never only from the receiver's own figures.
/// Sources: IBoxReceiver.sol:31-37 and :62-64 (per batch reward + FIT + depth + platform + burned + tip + reserve == the
/// batch, remainders carried; claims == ledgers + next batch), BoxReceiver.sol:158-181, :632-705, :906-932; BC-015,
/// BC-017, BC-106, BC-133, BC-139.
/// Stand-ins: the executor's and the hook's REV-16 notes are made with `vm.prank` as those two contracts (their real
/// calls are BoxHookExtension.sol:407 and FitBuybackExecutor.sol:270; what is checked here is the receiver's return
/// of a note, whatever its size); new claims come from real trades or from claim gifts any account can make.
/// forge-config: default.evm_version = "osaka"
contract AuditU4ClaudeSplitTest is AuditU4ClaudeBase {
    // ================================================================================================ graduated batches

    /// P4.1, P4.2, P4.17 after graduation (settled in graduate()'s poke): one collect of real trading fees plus a gift,
    /// with REV-16 notes pending and the epoch's cap partly used. Every Q wei of the batch and the carry in ends in FIT's
    /// ledger, the Safe's credit, the hook's claims (depth), the tip or the carry out; T 13/15 to the stream and 2/15
    /// to depth; nothing stays unbooked; the new claims equal what the receiver received during the call.
    function testFuzz_AUDIT_U4_graduatedBatchToTheWei(
        uint96 giftQ,
        uint96 buyQ,
        uint64 execNote,
        uint64 hookNote,
        uint96 prefill,
        uint32 dt
    ) public {
        _toGraduated();
        _advance(1);
        vm.warp(vm.getBlockTimestamp() + bound(dt, 0, 100 days));
        _prepareGraduatedBatch(giftQ, buyQ, execNote, hookNote, prefill);
        U4Books memory b0 = _books();
        (,, uint256 room) = receiver.platformEpoch();
        (FeeBatch memory b, uint256 tipPaid) = _collectMeasured(keeper, eoa[5]);
        U4Books memory b1 = _books();
        assertEq(b.qToReserve, 0, "no reserve after graduation");
        _assertBatchIsWhatArrived(b0, b1, b, tipPaid);
        U4Expected memory e = _expect(b0, b.q, b.t, room, true, true);
        _assertGraduatedBatch(b0, b1, e, tipPaid);
        assertEq(b.tip, tipPaid, "the batch reports the tip paid");
        (,, uint256 remaining) = receiver.platformEpoch();
        assertEq(remaining, room - e.keep, "the epoch's room falls by keep");
        assertEq(b1.toFit - b0.toFit, 11 * e.u + e.back, "totals: FIT");
        assertEq(b1.toPlatform - b0.toPlatform, e.keep, "totals: platform");
        assertEq(b1.qToDepth - b0.qToDepth, 2 * e.u + e.excess, "totals: Q depth (hook notes are returns, not depth)");
        _assertNoOpenDelta();
        _assertGhostLedger();
    }

    function _prepareGraduatedBatch(uint96 giftQ, uint96 buyQ, uint64 execNote, uint64 hookNote, uint96 prefill)
        internal
    {
        uint256 pre = bound(prefill, 0, 300 ether);
        if (pre != 0) _fundFees(eoa[4], pre);
        uint256 buy = bound(buyQ, 0, 3 ether);
        if (buy >= 0.0001 ether) {
            uint256 tOut = _buy(eoa[3], buy);
            _advance(1);
            if (tOut / 2 != 0) _sell(eoa[3], tOut / 2);
        }
        _giftEth(a.receiver, bound(giftQ, BATCH_MIN, 400 ether));
        uint256 en = bound(execNote, 0, 0.05 ether);
        uint256 hn = bound(hookNote, 0, 0.05 ether);
        if (en != 0) {
            vm.prank(a.executor);
            receiver.noteModuleFees(en, 0);
        }
        if (hn != 0) {
            vm.prank(a.hook);
            receiver.noteModuleFees(hn, 5); // the hook's T is clipped (Q only)
        }
    }

    /// @notice The batch the receiver reports is its unbooked claims before the call plus what it received during it
    /// (measured: claims after, plus what left to the tip, the hook and the stream, less claims before).
    function _assertBatchIsWhatArrived(U4Books memory b0, U4Books memory b1, FeeBatch memory b, uint256 tipPaid)
        internal
        pure
    {
        uint256 harvestedQ = b1.claimsQ + tipPaid + (b1.hookClaimsQ - b0.hookClaimsQ) - b0.claimsQ;
        uint256 harvestedT = b1.claimsT + _streamIn(b0, b1) + (b1.hookClaimsT - b0.hookClaimsT) - b0.claimsT;
        assertEq(b.q - b.qToReserve, (b0.claimsQ - b0.bookedQ) + harvestedQ, "batch.q = unbooked + harvested");
        assertEq(b.t, (b0.claimsT - b0.bookedT) + harvestedT, "batch.t = unbooked + harvested");
    }

    /// P4.2 before graduation: Q 11/15 FIT (held), 2/15 depth (held), 2/15 platform (held, counts in epoch 0); T 13/15
    /// burned, 2/15 depth held; the D6 reserve first to the coordinator; tip; nothing paid to the Safe, the executor,
    /// the hook or the stream (BC-020, BC-109, F77).
    function testFuzz_AUDIT_U4_bondingBatchHoldsEveryPart(uint96 buyQ, uint96 sellFrac, uint96 giftQ) public {
        _toBonding();
        uint256 tOut = _buy(eoa[3], bound(buyQ, 0.55 ether, 1.2 ether));
        _advance(1);
        uint256 sold = tOut * bound(sellFrac, 0, 100) / 100;
        if (sold != 0) _sell(eoa[3], sold);
        uint256 gift = bound(giftQ, 0, 2 ether);
        if (gift != 0) _giftEth(a.receiver, gift);
        U4Books memory b0 = _books();
        (FeeBatch memory b, uint256 tipPaid) = _collectMeasured(keeper, eoa[5]);
        U4Books memory b1 = _books();
        assertEq(b1.coordinatorClaimsQ - b0.coordinatorClaimsQ, b.qToReserve, "the reserve, to the coordinator");
        U4Expected memory e = _expect(b0, b.q - b.qToReserve, b.t, 0, false, true);
        assertEq(tipPaid, e.tip, "tip");
        assertEq(b1.fitOwed - b0.fitOwed, 11 * e.u, "FIT 11/15 held");
        assertEq(b1.platformHeld - b0.platformHeld, 2 * e.u, "P 2/15 held (epoch 0)");
        assertEq(b1.platformOwed, 0, "nothing credited to the Safe before graduation");
        assertEq(b1.depthHeldQ - b0.depthHeldQ, 2 * e.u, "Q depth 2/15 held");
        assertEq(b1.depthHeldT - b0.depthHeldT, 2 * e.v, "T depth 2/15 held");
        assertEq(b0.tSupply - b1.tSupply + (b1.tBurnPending - b0.tBurnPending), 13 * e.v, "T 13/15 burned (or pending)");
        _assertNothingPaidBeforeGraduation(b0, b1);
        assertEq(b.q - b.qToReserve + b0.qCarry, 15 * e.u + e.tip + e.qCarry, "Q identity (held parts, tip, carry)");
        assertEq(b.t + b0.tCarry, 15 * e.v + e.tCarry, "T identity (burned, depth, carry)");
        assertEq(b1.claimsQ - b1.bookedQ, 0, "nothing left unbooked");
        assertEq(b1.claimsT - b1.bookedT, 0);
        _assertNoOpenDelta();
        _assertGhostLedger();
    }

    function _assertNothingPaidBeforeGraduation(U4Books memory b0, U4Books memory b1) internal pure {
        assertEq(b1.hookClaimsQ, b0.hookClaimsQ, "the hook gets nothing before graduation");
        assertEq(b1.hookClaimsT, b0.hookClaimsT);
        assertEq(b1.streamT, b0.streamT, "the stream gets nothing before graduation");
        assertEq(b1.safeEth, b0.safeEth);
        assertEq(b1.executorEth, b0.executorEth, "nothing reaches the executor before graduation (BC-020)");
    }

    /// P4.2 / BC-107: `fundFees` splits like a Q batch, without tip or minimum, and leaves the next batch alone.
    function testFuzz_AUDIT_U4_fundFeesSplitsLikeAQBatch(uint96 amountRaw, uint96 giftQ, uint96 prefill) public {
        _toGraduated();
        uint256 pre = bound(prefill, 0, 250 ether);
        if (pre != 0) _fundFees(eoa[4], pre);
        uint256 gift = bound(giftQ, 0, 1 ether);
        if (gift != 0) _giftEth(a.receiver, gift);
        uint256 amount = bound(amountRaw, 1, 300 ether);
        U4Books memory b0 = _books();
        (,, uint256 room) = receiver.platformEpoch();
        _fundFees(eoa[2], amount);
        U4Books memory b1 = _books();
        U4Expected memory e = _expect(b0, amount, 0, room, true, false);
        assertEq(b1.fitOwed - b0.fitOwed, 11 * e.u, "FIT 11/15");
        assertEq(b1.platformOwed - b0.platformOwed, e.keep, "keep");
        assertEq(b1.hookClaimsQ - b0.hookClaimsQ, 2 * e.u + e.excess, "depth 2/15 + excess");
        assertEq(b1.qCarry, e.qCarry, "Q carry");
        assertEq(b1.tCarry, b0.tCarry, "the T carry is untouched");
        assertEq(b1.claimsQ - b1.bookedQ, b0.claimsQ - b0.bookedQ, "the next batch is untouched");
        assertEq(amount + b0.qCarry, 15 * e.u + e.qCarry, "identity");
        _assertNoOpenDelta();
        _assertGhostLedger();
    }

    // ================================================================================================ many batches (L7)

    /// P4.17: fifteenths with carry over many batches. For k intakes a_1..a_k from carry c0, each part's total is its
    /// share of ⌊(Σa + c0)/15⌋ exactly (15 × FIT + 11 × carry out == 11 × (Σa + c0)), so it is within 14 wei of the
    /// exact share of Σa; nothing is lost or counted twice (the carry is booked claims, BoxReceiver.sol:604-606).
    function testFuzz_AUDIT_U4_carryOverManyBatches(uint64[12] memory amounts, uint8 k) public {
        _toGraduated();
        uint256 n = bound(k, 1, 12);
        U4Books memory b0 = _books();
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            // Mostly dust (1-40 wei), sometimes up to 18 ETH: the carry must survive both.
            uint256 x = amounts[i] % 3 == 0 ? uint256(amounts[i]) + 1 : 1 + uint256(amounts[i]) % 40;
            _fundFees(eoa[i % 6], x);
            sum += x;
        }
        U4Books memory b1 = _books();
        uint256 fit = b1.fitOwed - b0.fitOwed;
        uint256 depthAndKept = (b1.hookClaimsQ - b0.hookClaimsQ) + (b1.platformOwed - b0.platformOwed);
        assertEq(b1.qCarry, (sum + b0.qCarry) % 15, "the carry is what is left");
        assertEq(15 * fit + 11 * b1.qCarry, 11 * (sum + b0.qCarry), "FIT is 11/15 of the units, exactly");
        assertEq(15 * depthAndKept + 4 * b1.qCarry, 4 * (sum + b0.qCarry), "depth + platform is 4/15, exactly");
        assertEq(fit + depthAndKept + b1.qCarry, sum + b0.qCarry, "no wei lost or doubled");
        uint256 exact = 11 * sum / 15;
        assertLe(exact > fit ? exact - fit : fit - exact, 14, "FIT within 14 wei of 11/15 of the intake");
        _assertNoOpenDelta();
        _assertGhostLedger();
    }

    /// P4.17, BC-017: the tip is min(10% of the batch's Q after the reserve, 0.0005 ETH) around the 0.005 ETH minimum
    /// and above it, and a batch below the minimum is refused with `BatchTooSmall` and changes nothing.
    function testFuzz_AUDIT_U4_tipAndMinimum(uint96 qRaw) public {
        _toGraduated();
        uint256 q = bound(qRaw, BATCH_MIN - 3, 0.02 ether);
        _giftEth(a.receiver, q);
        if (q < BATCH_MIN) {
            U4Books memory b0 = _books();
            vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.BatchTooSmall.selector, q, BATCH_MIN));
            vm.prank(keeper);
            receiver.collect(eoa[5]);
            U4Books memory b1 = _books();
            assertEq(b1.claimsQ, b0.claimsQ, "refused: the claims stay");
            assertEq(b1.fitOwed, b0.fitOwed);
            return;
        }
        (FeeBatch memory b, uint256 tipPaid) = _collectMeasured(keeper, eoa[5]);
        uint256 want = q / 10;
        if (want > TIP_MAX) want = TIP_MAX;
        assertEq(b.q, q);
        assertEq(tipPaid, want, "tip = min(10%, 0.0005 ETH)");
    }

    /// P4.3 (BC-015, IBoxReceiver.sol:64): the receiver's claims equal Σ ledgers + the next batch at every point; the
    /// next batch is exactly what arrived since the last batch-consuming call (collect, the settlement), never a
    /// booked wei; ETH intake and payouts leave it alone.
    function testProperty_AUDIT_U4_nextBatchIsExactlyWhatArrived() public {
        _toGraduated();
        (uint256 uq, uint256 ut) = _unbooked();
        assertEq(uq, 0, "settled at graduation: nothing unbooked");
        assertEq(ut, 0);
        _giftEth(a.receiver, 0.7 ether);
        _fundFees(eoa[1], 3 ether);
        _fundDepth(eoa[1], 1 ether);
        _payFit(keeper);
        _payPlatform(keeper);
        (uq, ut) = _unbooked();
        assertEq(uq, 0.7 ether, "only the gift is the next batch");
        assertEq(ut, 0);
        uint256 tOut = _buy(eoa[2], 1 ether);
        (uq,) = _unbooked();
        assertEq(uq, 0.7 ether, "a swap mints nothing to the receiver (D2, BC-017)");
        _advance(1);
        _sell(eoa[2], tOut / 3);
        _collect(keeper, keeper);
        (uq, ut) = _unbooked();
        assertEq(uq, 0, "a collect consumes the whole next batch");
        assertEq(ut, 0);
        U4Books memory b = _books();
        assertEq(b.bookedQ, b.fitOwed + b.platformOwed + b.qCarry, "box 0's Q ledgers after graduation");
        assertEq(b.bookedT, b.tCarry, "box 0's T ledgers after graduation: the carry only");
        _assertGhostLedger();
    }

    // ================================================================================================ proof

    // W1-U4-3, accepted as built (F147, the register's default): claims are the ledgers plus the next batch.
    /// @notice Proof 02 (Note). Property: IBoxReceiver.sol:62-64 "@dev Invariants: ... claims held == Σ ledgers
    /// below" (the receiver's ERC-6909 claims equal the sum of its ledgers).
    /// Expected (as written): after any call, the receiver's Q and T claims on the PoolManager equal Σ of its ledgers.
    /// Observed: claims in no ledger are the next batch (BoxReceiver.sol:28-30 "Q and T claims not yet in a ledger are
    /// the next batch"; `booked()` :600-613; `_unbooked()` :1024-1029), so fees the hook mints outside collect (the
    /// migration's Q dust, deepen()'s poke of the pair) or any account's gift of claims leave claims above Σ ledgers
    /// until the next collect or settlement takes them. The code is the design; the interface line omits the next
    /// batch (the unit brief's P4.3 states the property that holds: claims == Σ ledgers + next batch, pinned by
    /// testProperty_AUDIT_U4_nextBatchIsExactlyWhatArrived and invariant_AUDIT_U4_claimsCoverLedgersAndNextBatch).
    /// Steps: box 0 graduated (settled inside graduate(): claims == Σ ledgers); a stranger gifts 1 wei of ETH claims to
    /// the receiver (any account can mint claims to any address in its own unlock). Amounts: 1 wei above Σ ledgers.
    /// No value effect: the next collect splits the wei like any fee.
    function testAccepted_AUDIT_U4_02_claimsExceedLedgersByTheNextBatch() public {
        _toGraduated();
        U4Books memory b0 = _books();
        assertEq(b0.claimsQ, b0.bookedQ, "settled: claims == the sum of the ledgers here");
        _giftEth(a.receiver, 1);
        U4Books memory b1 = _books();
        assertEq(b1.bookedQ, b0.bookedQ, "no ledger moved");
        assertEq(b1.claimsQ - b1.bookedQ, 1, "observed: claims exceed the ledgers by the next batch (1 wei)");
        _assertGhostLedger();
    }
}
