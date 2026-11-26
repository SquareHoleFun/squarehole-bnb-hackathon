// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditU4FableBase, AuditU4Tally} from "./AuditU4FableBase.sol";

/// @notice SH-AUDIT-B0 U4 (Fable), P4.4: box 0's platform cap by every path (collect, fundFees, royalty flush, the late
/// settlement counted in epoch 0) across 30-day epoch edges, plus and minus one second, on the factory's box 0
/// (mainnet build: 32 ETH per 2,592,000 s from `graduatedAt`).
/// forge-config: default.evm_version = "osaka"
contract AuditU4FableCapTest is AuditU4FableBase {
    /// What each epoch was credited, from `PlatformCredited`.
    mapping(uint256 => uint256) internal credited;

    function setUp() public override {
        super.setUp();
        _toBonding();
    }

    /// @dev Runs `call`-like steps through the tally and books every credit per epoch.
    function _book(AuditU4Tally memory t) internal {
        for (uint256 i; i < t.credits && i < 8; ++i) {
            credited[t.creditEpoch[i]] += t.creditKept[i];
            assertEq(t.creditTotal[i], credited[t.creditEpoch[i]], "the event's running total is the epoch's credit");
            assertLe(credited[t.creditEpoch[i]], CAP, "P4.4: never above the cap in any epoch");
        }
    }

    function _fundFeesTally(address who, uint256 amount) internal returns (AuditU4Tally memory t) {
        vm.recordLogs();
        _fundFees(who, amount);
        t = _tally(vm.getRecordedLogs());
        _book(t);
    }

    function _flushTally(uint256 ethRoyalty, uint256 wethRoyalty) internal returns (AuditU4Tally memory t) {
        if (ethRoyalty != 0) _payRoyalty(eoa[2], ethRoyalty);
        if (wethRoyalty != 0) _payRoyaltyWeth(eoa[2], wethRoyalty);
        vm.recordLogs();
        vm.prank(eoa[5]);
        royaltyRouter.flush();
        t = _tally(vm.getRecordedLogs());
        _book(t);
    }

    function _collectTally(uint256 ethIn) internal returns (AuditU4Tally memory t) {
        _trade(eoa[3], ethIn, 2_500);
        _advance(1);
        vm.recordLogs();
        _collect(keeper, keeper);
        t = _tally(vm.getRecordedLogs());
        _book(t);
    }

    function _assertEpochView(uint256 epoch, uint256 kept) internal view {
        (uint256 e, uint256 k, uint256 r) = receiver.platformEpoch();
        assertEq(e, epoch, "platformEpoch: the epoch");
        assertEq(k, kept, "platformEpoch: kept");
        assertEq(r, CAP - kept, "platformEpoch: remaining");
    }

    /// BC-106, BC-107, BC-141, F62: the Safe keeps at most 32 ETH per epoch through fees, gifts and royalties in any
    /// order, the epoch changing exactly at `graduatedAt + k × 2,592,000` (a second earlier is the old epoch); the
    /// excess goes to depth; no carry-over; the Safe's balance rises only by `payPlatform`.
    function testProperty_AUDIT_U4_capHoldsByEveryPathAcrossEpochEdges() public {
        _fundFees(eoa[0], 150 ether); // held: P = 20 ETH (plus the bonding batch's)
        _toGraduated();
        uint256 g = coordinator.graduatedAt();
        uint256 kept0 = _toPlatform();
        assertGe(kept0, 20 ether, "the held share was released in epoch 0");
        credited[0] = kept0;
        _assertEpochView(0, kept0);
        // Epoch 0: a royalty flush (P = 8), a collect, then at the last second a 300 ETH batch fills the cap.
        vm.warp(g + 100);
        AuditU4Tally memory t = _flushTally(40 ether, 20 ether);
        assertEq(t.creditKept[0], 8 ether);
        assertEq(t.creditToDepth[0], 0);
        t = _collectTally(2 ether);
        uint256 small = t.creditKept[0];
        assertGt(small, 0);
        vm.warp(g + EPOCH - 1);
        t = _fundFeesTally(eoa[0], 300 ether);
        assertEq(t.creditEpoch[0], 0, "a second before the edge is still epoch 0");
        assertEq(t.creditKept[0], CAP - kept0 - 8 ether - small, "what the cap leaves");
        assertEq(t.creditToDepth[0], 40 ether - t.creditKept[0], "the rest to depth");
        _assertEpochView(0, CAP);
        // Epoch 1 starts exactly at the edge, from zero.
        vm.warp(g + EPOCH);
        t = _fundFeesTally(eoa[0], 150 ether);
        assertEq(t.creditEpoch[0], 1);
        assertEq(t.creditKept[0], 20 ether, "no carry-over: a fresh 32 ETH");
        _assertEpochView(1, 20 ether);
        vm.warp(g + EPOCH + 1);
        t = _flushTally(30 ether, 0);
        assertEq(t.creditKept[0], 4 ether);
        vm.warp(g + 2 * EPOCH - 1);
        t = _fundFeesTally(eoa[0], 300 ether);
        assertEq(t.creditEpoch[0], 1);
        assertEq(t.creditKept[0], 8 ether, "epoch 1 filled to 32");
        assertEq(t.creditToDepth[0], 32 ether);
        _assertEpochView(1, CAP);
        // Epoch 2.
        vm.warp(g + 2 * EPOCH);
        t = _fundFeesTally(eoa[0], 300 ether);
        assertEq(t.creditEpoch[0], 2);
        assertEq(t.creditKept[0], CAP);
        (uint256 carry,) = receiver.carried();
        t = _fundFeesTally(eoa[0], 1 ether);
        assertEq(t.creditKept[0], 0, "the cap reached: everything to depth");
        assertEq(t.creditToDepth[0], (1 ether + carry) / DENOM * 2);
        _assertEpochView(2, CAP);
        assertEq(_toPlatform(), 3 * CAP, "three epochs, 32 ETH each");
        assertEq(safe.balance, 0, "nothing paid yet");
        assertEq(_payPlatform(eoa[1]), 3 * CAP);
        assertEq(safe.balance, 3 * CAP, "BC-141: the Safe's balance rose only by payPlatform");
        _assertGhostLedger();
    }

    /// BC-106, BC-143, M31 (recorded; pinned on the factory's box 0 with `collect` as the first call): a settlement run
    /// two epochs late caps the held share in epoch 0, the held depth moves whole, and the same call's own batch counts
    /// in the calendar epoch.
    function testProperty_AUDIT_U4_lateSettlementCountsTheHeldShareInEpochZero() public {
        _fundFees(eoa[0], 300 ether); // held P = 40 ETH + the bonding batch's; held depth 40 ETH + its
        uint256 heldP = receiver.platformHeld();
        (uint256 heldQ, uint256 heldT) = receiver.depthHeld();
        uint256 failures = _graduateWithFailedReceiverPoke(keeper);
        assertGe(failures, 1, "the receiver's poke failed");
        uint256 g = coordinator.graduatedAt();
        vm.warp(g + 2 * EPOCH + 5);
        _assertEpochView(0, 0);
        (uint256 uq, uint256 ut) = _unbooked();
        (uint256 cq, uint256 ct) = receiver.carried();
        uint256 hookQ0 = _claimsQ(a.hook);
        uint256 hookT0 = _claimsT(a.hook);
        _trade(eoa[3], 2 ether, 2_500);
        _advance(1);
        vm.recordLogs();
        _collect(keeper, keeper);
        AuditU4Tally memory t = _tally(vm.getRecordedLogs());
        _book(t);
        assertTrue(t.settled && t.collected);
        assertEq(t.heldKept, CAP, "the held share capped at 32 in epoch 0, however late");
        assertEq(t.heldToDepth, heldP - CAP);
        assertEq(t.creditEpoch[0], 0, "the held share's credit names epoch 0");
        assertEq(t.creditEpoch[t.credits - 1], 2, "the call's own batch names the calendar epoch");
        _assertBatchConserved(t, uq, ut, cq, ct);
        _assertFifteenths(t, true);
        assertEq(receiver.platformHeld(), 0);
        (uint256 dq, uint256 dt) = receiver.depthHeld();
        assertEq(dq | dt, 0, "held depth moved whole");
        assertGe(_claimsQ(a.hook) - hookQ0, heldQ + t.heldToDepth, "to the hook's claims");
        assertGe(_claimsT(a.hook) - hookT0, heldT);
        uint256 batchKept = t.creditKept[t.credits - 1];
        _assertEpochView(2, batchKept);
        assertEq(receiver.platformOwed(), CAP + batchKept);
        // Epoch 2 keeps its own 32 ETH (the recorded M31 behaviour).
        t = _fundFeesTally(eoa[0], 300 ether);
        assertEq(t.creditKept[0], CAP - batchKept);
        assertEq(receiver.platformOwed(), 2 * CAP);
        assertEq(credited[0], CAP);
        assertEq(credited[2], CAP);
        _assertGhostLedger();
    }

    /// BC-106, BC-107, BC-141 under random paths and warps (fees, gifts, royalties, collects, payouts, warps of 1 s to
    /// an epoch plus a second): no epoch is ever credited above the cap, the running totals agree, and the Safe's
    /// balance plus the credit owed equals everything ever counted.
    function testFuzz_AUDIT_U4_capNeverExceededUnderRandomPathsAndWarps(uint256 seed) public {
        _toGraduated();
        credited[0] = _toPlatform();
        uint256 paid;
        for (uint256 i; i < 24; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 action = r % 6;
            uint256 amount = 1 + (r >> 8) % 100 ether;
            if (action == 0) {
                _fundFeesTally(eoa[i % 8], amount);
            } else if (action == 1) {
                _flushTally(amount, (r >> 16) % 2 == 0 ? amount / 3 : 0);
            } else if (action == 2) {
                _collectTally(0.6 ether + amount / 50);
            } else if (action == 3) {
                if (receiver.platformOwed() != 0) paid += _payPlatform(eoa[1]);
            } else {
                uint256[9] memory menu = [uint256(1), 12, 1 hours, 1 days, 7 days, EPOCH - 1, EPOCH, EPOCH + 1, 30 days];
                vm.warp(block.timestamp + menu[(r >> 24) % 9]);
            }
            (uint256 e, uint256 k,) = receiver.platformEpoch();
            assertEq(k, credited[e], "the view agrees with the credits of the current epoch");
            assertLe(k, CAP);
        }
        assertEq(safe.balance, paid);
        assertEq(safe.balance + receiver.platformOwed(), _toPlatform(), "paid + owed == counted");
        _assertGhostLedger();
    }
}
