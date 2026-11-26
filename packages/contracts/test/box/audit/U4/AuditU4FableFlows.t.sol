// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxRoyaltyRouter} from "../../../../src/box/interfaces/IBoxRoyaltyRouter.sol";
import {TIn} from "../common/AuditGhostLedger.sol";
import {AuditU4FableBase, AuditU4Tally} from "./AuditU4FableBase.sol";

/// @notice SH-AUDIT-B0 U4 (Fable), lenses L1 value flow and L7 arithmetic on the factory's box 0 (mainnet build):
/// per-batch conservation to the wei with carry before and after graduation, box 0's fifteenths, claims == ledgers +
/// the next batch on every path, forced ETH, `payFit` / `payPlatform` exactness, the royalty router's one sink, the
/// tip rule, the T side, the packed ledgers' lifetime bound and the epoch counter's.
/// forge-config: default.evm_version = "osaka"
contract AuditU4FableFlowsTest is AuditU4FableBase {
    using TransientStateLibrary for IPoolManager;

    function setUp() public override {
        super.setUp();
        _toBonding();
    }

    // ================================================================================================ L1: batches

    /// P4.1, P4.2, BC-015, BC-020, F77 before graduation: a curve batch is split in fifteenths with the remainder
    /// carried; FIT, the platform share and both depth parts are held in the receiver; 13/15 of the T is burned at once;
    /// nothing reaches the hook, the executor or the Safe.
    function testProperty_AUDIT_U4_curveBatchIsHeldAndBurned() public {
        _trade(eoa[3], 0.5 ether, 5_000);
        _trade(eoa[4], 0.4 ether, 2_500);
        _advance(1);
        (uint256 uq, uint256 ut) = _unbooked();
        (uint256 cq, uint256 ct) = receiver.carried();
        uint256 fit0 = receiver.fitOwed();
        uint256 held0 = receiver.platformHeld();
        (uint256 dq0, uint256 dt0) = receiver.depthHeld();
        uint256 supply0 = token.totalSupply();
        uint256 hookQ0 = _claimsQ(a.hook);
        uint256 tip0 = eoa[5].balance;
        vm.recordLogs();
        _collect(keeper, eoa[5]);
        AuditU4Tally memory t = _tally(vm.getRecordedLogs());
        assertTrue(t.collected && !t.settled);
        _assertBatchConserved(t, uq, ut, cq, ct);
        _assertFifteenths(t, false);
        uint256 u = t.qFit / 11;
        assertEq(receiver.fitOwed() - fit0, t.qFit + t.back, "FIT held: 11u plus the executor's returns");
        assertEq(receiver.platformHeld() - held0, 2 * u, "the platform part is held: 2u");
        (uint256 dq1, uint256 dt1) = receiver.depthHeld();
        assertEq(dq1 - dq0, t.qDepth, "Q depth held");
        assertEq(dt1 - dt0, t.tDepth, "T depth held");
        assertEq(supply0 - token.totalSupply(), t.tBurned, "13/15 of the T burned at once");
        assertEq(receiver.tBurnPending(), 0);
        assertEq(t.tStream, 0, "no stream before graduation");
        assertEq(_claimsQ(a.hook), hookQ0, "nothing to the hook before graduation");
        assertEq(a.executor.balance, 0, "BC-020: nothing to the executor");
        assertEq(safe.balance, 0, "nothing to the Safe");
        assertEq(eoa[5].balance - tip0, t.tip, "the tip went to tipTo");
        (uint256 uq1, uint256 ut1) = _unbooked();
        assertEq(uq1 | ut1, 0, "after a collect every claim is in a ledger");
        _assertGhostLedger();
    }

    /// P4.1, P4.2, BC-015, BC-139 after graduation: the split's depth parts become the hook's claims at once, the
    /// platform part is credited under the cap, 13/15 of the T goes to the per-item stream.
    function testProperty_AUDIT_U4_graduatedBatchSplitsAndStreams() public {
        _toGraduated();
        _trade(eoa[3], 1 ether, 5_000);
        _trade(eoa[4], 0.7 ether, 0);
        _advance(1);
        (uint256 uq, uint256 ut) = _unbooked();
        (uint256 cq, uint256 ct) = receiver.carried();
        uint256 fit0 = receiver.fitOwed();
        uint256 owed0 = receiver.platformOwed();
        uint256 hookQ0 = _claimsQ(a.hook);
        uint256 hookT0 = _claimsT(a.hook);
        uint256 streamT0 = token.balanceOf(a.itemStream);
        uint256 supply0 = token.totalSupply();
        vm.recordLogs();
        _collect(keeper, keeper);
        AuditU4Tally memory t = _tally(vm.getRecordedLogs());
        assertTrue(t.collected && !t.settled);
        assertGt(t.collectedT, 0, "the sells left T fees");
        _assertBatchConserved(t, uq, ut, cq, ct);
        _assertFifteenths(t, true);
        assertEq(receiver.fitOwed() - fit0, t.qFit + t.back);
        assertEq(receiver.platformOwed() - owed0, t.qPlatform, "credited to the Safe's ledger");
        assertEq(_claimsQ(a.hook) - hookQ0, t.qDepth + t.hookBack, "Q depth (and the hook's returns) moved at once");
        assertEq(_claimsT(a.hook) - hookT0, t.tDepth, "T depth moved at once");
        // The stream burns at once what no outside owner accrued (every item is in the vault here): what it got is
        // what it kept plus what it burned in its notice; the receiver itself burned nothing.
        assertEq(
            token.balanceOf(a.itemStream) - streamT0 + (supply0 - token.totalSupply()),
            t.tStream,
            "the stream got exactly 13/15 of the T (kept plus burned by its own notice)"
        );
        assertEq(t.tBurned, 0, "after graduation the receiver streams the T instead of burning it");
        assertEq(t.streamNotices, 1);
        assertEq(t.streamFailures, 0);
        (uint256 dq, uint256 dt) = receiver.depthHeld();
        assertEq(dq | dt, 0, "nothing held after the settlement");
        (uint256 uq1, uint256 ut1) = _unbooked();
        assertEq(uq1 | ut1, 0);
        _assertGhostLedger();
    }

    /// P4.17, BC-015, BC-107: `fundFees` splits exact fifteenths with the remainder carried, batch after batch, the
    /// platform part under epoch 0's cap; each part's lifetime total is within 14 wei of the exact share of the total.
    function testFuzz_AUDIT_U4_fundFeesSplitsToTheWeiWithCarry(uint256[6] memory raw) public {
        _toGraduated();
        (uint256 c0,) = receiver.carried();
        uint256 sum;
        uint256 fitSum;
        uint256 pSum;
        for (uint256 i; i < 6; ++i) {
            uint256 amount = bound(raw[i], 1, 50 ether);
            (uint256 carry,) = receiver.carried();
            uint256 u = (amount + carry) / DENOM;
            (,, uint256 room) = receiver.platformEpoch();
            uint256 keep = 2 * u < room ? 2 * u : room;
            uint256 fit0 = receiver.fitOwed();
            uint256 owed0 = receiver.platformOwed();
            uint256 hookQ0 = _claimsQ(a.hook);
            _fundFees(eoa[i], amount);
            assertEq(receiver.fitOwed() - fit0, 11 * u, "11u to FIT");
            assertEq(receiver.platformOwed() - owed0, keep, "min(2u, the epoch's room) to the Safe");
            assertEq(_claimsQ(a.hook) - hookQ0, 2 * u + (2 * u - keep), "2u plus the cap's excess to depth");
            (uint256 carry1,) = receiver.carried();
            assertEq(carry1, (amount + carry) % DENOM, "the remainder is carried");
            sum += amount;
            fitSum += 11 * u;
            pSum += 2 * u;
        }
        (uint256 c,) = receiver.carried();
        assertLe(_absDiff(sum * 11 / DENOM, fitSum), 14, "FIT within 14 wei of 11/15 of the total");
        assertLe(_absDiff(sum * 2 / DENOM, pSum), 14, "P within 14 wei of 2/15 of the total");
        assertEq(fitSum * 2, pSum * 11, "FIT : P == 11 : 2 exactly, batch by batch");
        assertEq(sum + c0, fitSum + 2 * pSum + c, "every wei: 11u + 2u + 2u per batch, the rest carried");
        _assertGhostLedger();
    }

    function _absDiff(uint256 x, uint256 y) internal pure returns (uint256) {
        return x > y ? x - y : y - x;
    }

    /// P4.3, BC-015, X09: the receiver's claims equal its ledgers plus the next batch after every path: a gift of
    /// claims, `fundFees`, `fundDepth`, the executor's fee note, `collect`, `payFit`, `payPlatform`, a royalty flush.
    function testProperty_AUDIT_U4_claimsEqualLedgersPlusNextBatchOnEveryPath() public {
        _toGraduated();
        _trade(eoa[3], 0.8 ether, 3_000);
        _advance(1);
        _collect(keeper, keeper);
        _assertClaimsCoverLedgers(0, 0, "after a collect the next batch is empty");
        _mintClaimsTo(a.receiver, 0.01 ether);
        _assertClaimsCoverLedgers(0.01 ether, 0, "a gift of claims is the next batch");
        _fundFees(eoa[0], 1 ether);
        _assertClaimsCoverLedgers(0.01 ether, 0, "fundFees books only its own amount");
        _fundDepth(eoa[0], 0.5 ether);
        _assertClaimsCoverLedgers(0.01 ether, 0, "fundDepth mints to the hook after graduation");
        vm.prank(a.executor);
        receiver.noteModuleFees(0.004 ether, 0);
        _assertClaimsCoverLedgers(0.01 ether, 0, "a note is not a claim");
        (uint256 pq,) = receiver.moduleFeesPending();
        assertEq(pq, 0.004 ether);
        uint256 fit0 = receiver.fitOwed();
        _collect(keeper, keeper);
        _assertClaimsCoverLedgers(0, 0, "the gift was split with the batch");
        assertGe(receiver.fitOwed() - fit0, 0.004 ether, "REV-16: the note came back to FIT's ledger first");
        (pq,) = receiver.moduleFeesPending();
        assertEq(pq, 0, "the note is consumed");
        _payFit(eoa[1]);
        _assertClaimsCoverLedgers(0, 0, "payFit burned exactly its ledger's claims");
        _payPlatform(eoa[1]);
        _assertClaimsCoverLedgers(0, 0, "payPlatform burned exactly its ledger's claims");
        _payRoyalty(eoa[2], 0.3 ether);
        _payRoyaltyWeth(eoa[2], 0.2 ether);
        royaltyRouter.flush();
        _assertClaimsCoverLedgers(0, 0, "a flush is a fundFees");
        _assertGhostLedger();
    }

    function _assertClaimsCoverLedgers(uint256 nextQ, uint256 nextT, string memory why) internal view {
        (uint256 bq, uint256 bt) = receiver.booked();
        assertEq(_claimsQ(a.receiver), bq + nextQ, string.concat("Q claims == ledgers + next batch: ", why));
        assertEq(_claimsT(a.receiver), bt + nextT, string.concat("T claims == ledgers + next batch: ", why));
    }

    /// P4.5, BC-107: ETH forced into the receiver is never counted as fees and never reaches the Safe; `fundDepth`
    /// takes the whole balance, and nothing of another ledger is ever in that balance outside a guarded call.
    function testProperty_AUDIT_U4_forcedEthIsNeverFeesAndNeverReachesTheSafe() public {
        _forceEth(a.receiver, 1 ether);
        uint256 fit0 = receiver.fitOwed();
        uint256 held0 = receiver.platformHeld();
        (uint256 dq0,) = receiver.depthHeld();
        _fundFees(eoa[0], 1.5 ether);
        assertEq(receiver.fitOwed() - fit0, 1.1 ether, "11/15 of the 1.5 ETH only");
        assertEq(receiver.platformHeld() - held0, 0.2 ether);
        (uint256 dq1,) = receiver.depthHeld();
        assertEq(dq1 - dq0, 0.2 ether);
        assertEq(a.receiver.balance, 1 ether, "the forced ETH is still there, uncounted");
        vm.recordLogs();
        _fundDepth(eoa[1], 0);
        AuditU4Tally memory t = _tally(vm.getRecordedLogs());
        assertEq(t.depthGifted, 1 ether, "fundDepth(0) by anyone moves the forced ETH to depth");
        (uint256 dq2,) = receiver.depthHeld();
        assertEq(dq2 - dq1, 1 ether, "held before graduation");
        assertEq(a.receiver.balance, 0);
        _toGraduated();
        _forceEth(a.receiver, 2 ether);
        uint256 owed = receiver.platformOwed();
        assertGt(owed, 0);
        assertEq(_payPlatform(eoa[2]), owed, "payPlatform pays exactly the ledger");
        assertEq(safe.balance, owed, "the Safe got the ledger and nothing of the forced ETH");
        assertEq(a.receiver.balance, 2 ether);
        uint256 hookQ0 = _claimsQ(a.hook);
        _fundDepth(eoa[1], 0.5 ether);
        assertEq(_claimsQ(a.hook) - hookQ0, 2.5 ether, "msg.value plus the forced ETH, all to depth");
        assertEq(a.receiver.balance, 0);
        _payFit(eoa[2]);
        assertEq(a.receiver.balance, 0, "payFit holds nothing after the call");
        assertEq(safe.balance, owed, "no other path paid the Safe");
        _assertGhostLedger();
    }

    /// P4.7, BC-020, BC-021: `payFit` moves exactly `fitOwed` into the executor's budget, only after the settlement;
    /// the executor gets nothing before graduation, not even at graduation.
    function testProperty_AUDIT_U4_payFitExactAndNothingBeforeGraduation() public {
        _trade(eoa[3], 0.6 ether, 0);
        _advance(1);
        _collect(keeper, keeper);
        assertGt(receiver.fitOwed(), 0, "FIT's share is held");
        vm.expectRevert(IBoxReceiver.NotGraduated.selector);
        vm.prank(eoa[0]);
        receiver.payFit();
        assertEq(a.executor.balance, 0, "BC-020: the executor holds nothing on the curve");
        _toGraduated();
        assertEq(a.executor.balance, 0, "graduation itself pays the executor nothing: payFit does");
        uint256 owed = receiver.fitOwed();
        uint256 claims = _claimsQ(a.receiver);
        vm.expectEmit(true, false, false, true, a.receiver);
        emit IBoxReceiver.FitPaid(a.executor, owed);
        assertEq(_payFit(eoa[0]), owed);
        assertEq(a.executor.balance, owed, "exactly fitOwed in the budget");
        assertEq(executor.budget(), owed);
        assertEq(receiver.fitOwed(), 0);
        assertEq(_claimsQ(a.receiver), claims - owed, "the claims were redeemed for it");
        vm.expectRevert(IBoxReceiver.NothingOwed.selector);
        vm.prank(eoa[0]);
        receiver.payFit();
        _assertGhostLedger();
    }

    /// P4.7, BC-021, BC-141: `payPlatform` moves exactly `platformOwed` to the fixed mainnet Safe, by anyone, only
    /// once settled; no other path ever pays the Safe.
    function testProperty_AUDIT_U4_payPlatformExactToTheFixedSafe() public {
        assertEq(receiver.platformSafe(), BoxSpecV1.PLATFORM_SAFE_MAINNET, "the fixed Safe (F44)");
        uint256 held0 = receiver.platformHeld();
        _fundFees(eoa[0], 3 ether);
        assertEq(receiver.platformHeld() - held0, 0.4 ether);
        vm.expectRevert(IBoxReceiver.NothingOwed.selector);
        vm.prank(eoa[1]);
        receiver.payPlatform();
        _toGraduated();
        uint256 owed = receiver.platformOwed();
        assertGe(owed, held0 + 0.4 ether, "the held share was released in epoch 0");
        vm.expectEmit(true, false, false, true, a.receiver);
        emit IBoxReceiver.PlatformPaid(safe, owed);
        assertEq(_payPlatform(eoa[1]), owed);
        assertEq(safe.balance, owed);
        assertEq(receiver.platformOwed(), 0);
        vm.expectRevert(IBoxReceiver.NothingOwed.selector);
        receiver.payPlatform();
        // Every other path leaves the Safe where it is.
        _trade(eoa[3], 0.6 ether, 2_000);
        _advance(1);
        _collect(keeper, keeper);
        _fundFees(eoa[0], 1 ether);
        _fundDepth(eoa[0], 0.1 ether);
        _payRoyalty(eoa[2], 0.2 ether);
        royaltyRouter.flush();
        _payFit(eoa[2]);
        assertEq(safe.balance, owed, "BC-141: only payPlatform pays the Safe");
        uint256 owed2 = receiver.platformOwed();
        assertEq(_payPlatform(eoa[1]), owed2);
        _assertGhostLedger();
    }

    /// P4.6, BC-114, BC-115 (box 0): the router's ETH and unwrapped WETH leave only to `receiver.fundFees()`, only after
    /// `coordinator.graduated()`; `sweep` takes only WETH.
    function testProperty_AUDIT_U4_royaltyRouterLeavesOnlyToFundFees() public {
        _payRoyalty(eoa[2], 1 ether);
        _payRoyaltyWeth(eoa[2], 2 ether);
        vm.expectRevert(IBoxRoyaltyRouter.NotGraduated.selector);
        royaltyRouter.flush();
        vm.expectRevert(IBoxRoyaltyRouter.NotGraduated.selector);
        royaltyRouter.sweep(a.weth);
        assertEq(a.royaltyRouter.balance, 1 ether, "held for the box before graduation");
        assertEq(_wethOf(a.royaltyRouter), 2 ether);
        _toGraduated();
        vm.expectRevert(abi.encodeWithSelector(IBoxRoyaltyRouter.TokenNotTaken.selector, a.token));
        royaltyRouter.sweep(a.token);
        vm.expectRevert(abi.encodeWithSelector(IBoxRoyaltyRouter.TokenNotTaken.selector, address(0)));
        royaltyRouter.sweep(address(0));
        vm.expectRevert(abi.encodeWithSelector(IBoxRoyaltyRouter.TokenNotTaken.selector, eoa[0]));
        royaltyRouter.sweep(eoa[0]);
        uint256 fit0 = receiver.fitOwed();
        uint256 owed0 = receiver.platformOwed();
        uint256 hookQ0 = _claimsQ(a.hook);
        vm.expectEmit(true, false, false, true, a.receiver);
        emit IBoxReceiver.FeesFunded(a.royaltyRouter, 3 ether);
        vm.expectEmit(true, false, false, true, a.royaltyRouter);
        emit IBoxRoyaltyRouter.Flushed(a.receiver, 3 ether, 2 ether);
        vm.prank(eoa[5]);
        assertEq(royaltyRouter.sweep(a.weth), 3 ether, "sweep(WETH) is a flush");
        assertEq(a.royaltyRouter.balance, 0);
        assertEq(_wethOf(a.royaltyRouter), 0);
        assertEq(receiver.fitOwed() - fit0, 2.2 ether, "11/15 FIT");
        assertEq(receiver.platformOwed() - owed0, 0.4 ether, "2/15 under the cap");
        assertEq(_claimsQ(a.hook) - hookQ0, 0.4 ether, "2/15 depth");
        vm.expectRevert(IBoxRoyaltyRouter.NothingToFlush.selector);
        royaltyRouter.flush();
        _assertGhostLedger();
    }

    function _wethOf(address who) internal view returns (uint256) {
        (bool ok, bytes memory r) = a.weth.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        require(ok, "weth balanceOf");
        return abi.decode(r, (uint256));
    }

    /// P4.17, BC-017, REV-16: the tip is min(10% of the batch's Q after the reserve, 0.0005 ETH, what is left after the
    /// executor's returns). On the mainnet build every batch at or above the 0.005 ETH minimum tips the cap unless the
    /// returns leave less; the tip's base is the whole new Q, the returns included (observed, pinned here).
    function testProperty_AUDIT_U4_tipIsMinOfTenPercentCapAndRest() public {
        _toGraduated();
        _trade(eoa[3], 0.6 ether, 0);
        _advance(1);
        _collect(keeper, keeper);
        // The positions are empty now: a gift of claims is the next batch, exactly.
        _mintClaimsTo(a.receiver, BATCH_MIN);
        assertEq(_collect(keeper, eoa[5]).tip, TIP_MAX, "10% of 0.005 ETH == the cap");
        _mintClaimsTo(a.receiver, 0.3 ether);
        assertEq(_collect(keeper, eoa[5]).tip, TIP_MAX, "the cap");
        _mintClaimsTo(a.receiver, BATCH_MIN - 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.BatchTooSmall.selector, BATCH_MIN - 1, BATCH_MIN));
        vm.prank(keeper);
        receiver.collect(eoa[5]);
        _mintClaimsTo(a.receiver, 1);
        assertEq(_collect(keeper, eoa[5]).tip, TIP_MAX, "at the minimum exactly");
        // The executor's note comes back first; the tip is clipped to what is left.
        vm.prank(a.executor);
        receiver.noteModuleFees(0.0058 ether, 0);
        _mintClaimsTo(a.receiver, 0.006 ether);
        uint256 fit0 = receiver.fitOwed();
        uint256 hookQ0 = _claimsQ(a.hook);
        assertEq(_collect(keeper, eoa[5]).tip, 0.0002 ether, "min(10% of 0.006, cap, 0.006 - 0.0058)");
        assertEq(receiver.fitOwed() - fit0, 0.0058 ether, "the note returned whole, nothing split");
        assertEq(_claimsQ(a.hook), hookQ0, "nothing left for depth: the tip took the rest");
        _assertGhostLedger();
    }

    /// P4.2, BC-139, BC-016: the T side: 13/15 burned on the curve (a burn the vault's floor refuses waits in
    /// `tBurnPending`, never counted as burned, never touching the depth part), 13/15 to the stream after graduation;
    /// the 2/15 depth part is never redeemed.
    function testProperty_AUDIT_U4_tSideThirteenBurnedOrStreamedTwoToDepth() public {
        _trade(eoa[3], 1 ether, 6_000);
        _advance(1);
        uint256 supply0 = token.totalSupply();
        uint256 burned0 = _tBurnedTotal();
        (, uint256 dt0) = receiver.depthHeld();
        vm.recordLogs();
        _collect(keeper, keeper);
        AuditU4Tally memory t = _tally(vm.getRecordedLogs());
        assertGt(t.tBurned, 0);
        assertEq(supply0 - token.totalSupply(), t.tBurned, "13/15 burned");
        assertEq(_tBurnedTotal() - burned0, t.tBurned);
        (, uint256 dt1) = receiver.depthHeld();
        assertEq(dt1 - dt0, t.tDepth, "2/15 held for depth");
        // The vault's floor refuses the next burn (a stand-in answer from the real vault's view).
        _trade(eoa[4], 1 ether, 6_000);
        _advance(1);
        vm.mockCall(a.vault, abi.encodeWithSignature("supplyFloor()"), abi.encode(type(uint256).max >> 1));
        supply0 = token.totalSupply();
        uint256 burned1 = _tBurnedTotal();
        vm.recordLogs();
        _collect(keeper, keeper);
        t = _tally(vm.getRecordedLogs());
        assertEq(token.totalSupply(), supply0, "the refused burn lowered nothing");
        assertEq(receiver.tBurnPending(), t.tBurned, "it waits as real T in the receiver");
        assertEq(token.balanceOf(a.receiver), t.tBurned);
        assertEq(_tBurnedTotal(), burned1, "totals count only real burns");
        (, uint256 dt2) = receiver.depthHeld();
        assertEq(dt2 - dt1, t.tDepth, "the depth part is untouched by the refusal");
        uint256 pending = receiver.tBurnPending();
        assertGt(pending, 0);
        vm.clearMockedCalls();
        _toGraduated();
        assertEq(receiver.tBurnPending(), 0, "the waiting burn went through at the settlement's payout");
        assertEq(_tBurnedTotal() - burned1, pending, "the totals count the burn when it happens");
        burned1 = _tBurnedTotal();
        _trade(eoa[3], 1 ether, 6_000);
        _advance(1);
        uint256 streamT0 = token.balanceOf(a.itemStream);
        uint256 hookT0 = _claimsT(a.hook);
        supply0 = token.totalSupply();
        vm.recordLogs();
        _collect(keeper, keeper);
        t = _tally(vm.getRecordedLogs());
        uint256 streamKept = token.balanceOf(a.itemStream) - streamT0;
        assertEq(_claimsT(a.hook) - hookT0, t.tDepth, "2/15 to depth");
        assertEq(supply0 - token.totalSupply(), t.tStream - streamKept, "only the stream's own surplus burn");
        assertEq(receiver.tBurnPending(), 0);
        assertEq(_tBurnedTotal(), burned1, "the receiver burned nothing after graduation");
        _assertGhostLedger();
    }

    /// P4.18: the lifetime bound of a packed uint128 ledger is 2^128 − 1 raw units (3.4 × 10^20 ETH, far above all
    /// ETH; T issuance is 10^27 < 2^128): the ledger reaches 2^128 − 1 exactly, and the next credit reverts (checked
    /// uint128 arithmetic) instead of wrapping, so no ledger ever silently loses a unit.
    function testProperty_AUDIT_U4_packedLedgerBoundIsTwoToThe128() public {
        _toGraduated();
        _payFit(eoa[0]);
        (uint256 carry,) = receiver.carried();
        uint256 u = (1 ether + carry) / DENOM;
        uint256 owed = receiver.platformOwed();
        // fitOwed (low 128 bits of slot 1) just below the top: the 11u of a 1 ETH batch lands on 2^128 − 1 exactly.
        vm.store(a.receiver, bytes32(SLOT_FIT_PLATFORM), bytes32((owed << 128) | (type(uint128).max - 11 * u)));
        assertEq(receiver.fitOwed(), type(uint128).max - 11 * u);
        _fundFees(eoa[0], 1 ether);
        assertEq(receiver.fitOwed(), type(uint128).max, "the bound itself is reachable without a wrap");
        _fund(eoa[0], 1 ether);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("Panic(uint256)")), 0x11));
        vm.prank(eoa[0]);
        receiver.fundFees{value: 1 ether}();
        assertEq(receiver.fitOwed(), type(uint128).max, "a credit beyond the bound reverts whole");
    }

    // W1-U4-1, accepted as built (FQ-07, F147): the cap is exact for 2^32 epochs, now stated in the NatSpec.
    /// @notice Property it breaks: box 0's Safe receives at most PLATFORM_CAP_WEI per 30-day epoch, with no carry-over
    /// (`IBoxReceiver.sol:62-63`; BC-106; F62 `DECISION-LOG.md:77`). The epoch number is kept in 32 bits of the state
    /// word (`BoxReceiverBase.sol:44-53`: `_O_EPOCH` 8, `_M32`) and written as `epoch << _O_EPOCH` with no bound check
    /// (`BoxReceiver.sol:760-771`, `_count`): from epoch 2^32 on the stored field holds `epoch mod 2^32`, so the
    /// comparison in `_count` never matches, `kept` restarts from zero on every cap call, and the cap is void. The
    /// write also sets bit 40 (the Q carry's lowest bit, `_O_QCARRY`), but for box 0 every `_count` runs inside
    /// `_split`, whose closing carry write (`BoxReceiver.sol:704`) clears bits 40-55 again, so the carry is unharmed.
    /// Expected: once the stored counter cannot represent the epoch, the cap still holds per epoch.
    /// Observed: in calendar epoch 2^32 two `fundFees` of 300 ETH keep 32 ETH each (64 ETH credited to the Safe's
    /// ledger in one epoch); the view reads epoch 2^32 with nothing kept; the stored epoch field reads 0; the carry is
    /// unchanged. At epoch 2^32 − 1 the cap works.
    /// Steps: graduate; warp to graduatedAt + (2^32 − 1) × 2,592,000 s; fundFees 300 ETH (32 kept); warp one epoch on;
    /// fundFees 300 ETH twice (32 + 32 kept). Amounts: 300 ETH batches, P = 40 ETH each.
    /// Severity: Note. 2^32 epochs is 353 million years; the bound is unreachable in box 0's life. Recorded as the
    /// lifetime bound P4.18 asks for, not as a fix to make.
    function testAccepted_AUDIT_U4_26_platformEpochCounterWrapsAtTwoToThe32() public {
        _toGraduated();
        _payPlatform(eoa[0]);
        uint256 g = coordinator.graduatedAt();
        vm.warp(g + (2 ** 32 - 1) * EPOCH);
        _fundFees(eoa[0], 300 ether);
        assertEq(receiver.platformOwed(), 32 ether, "epoch 2^32 - 1: the cap holds");
        (uint256 e, uint256 kept,) = receiver.platformEpoch();
        assertEq(e, 2 ** 32 - 1);
        assertEq(kept, 32 ether);
        assertEq((uint256(vm.load(a.receiver, bytes32(SLOT_S))) >> 8) & (2 ** 32 - 1), 2 ** 32 - 1, "stored: 2^32 - 1");
        (uint256 carryBefore,) = receiver.carried();
        vm.warp(g + (2 ** 32) * EPOCH);
        _fundFees(eoa[0], 300 ether);
        _fundFees(eoa[0], 300 ether);
        assertEq(receiver.platformOwed(), 32 ether + 64 ether, "epoch 2^32: 64 ETH credited in one epoch");
        (e, kept,) = receiver.platformEpoch();
        assertEq(e, 2 ** 32);
        assertEq(kept, 0, "the view sees no credit either: the stored epoch reads 0");
        uint256 word = uint256(vm.load(a.receiver, bytes32(SLOT_S)));
        assertEq((word >> 8) & (2 ** 32 - 1), 0, "the stored epoch field holds 2^32 mod 2^32");
        (uint256 carryAfter,) = receiver.carried();
        // 300 ETH is a multiple of 15: the carry is unchanged, and the split's carry write cleared the stray bit 40.
        assertEq(carryAfter, carryBefore, "the Q carry is unharmed (the split rewrites bits 40-55 after the cap call)");
        assertEq((word >> 40) & 0xff, carryBefore);
    }

    /// P4.15 (L6), BC-015: no PoolManager unlock or delta outlives a receiver call. After `collect`, `fundFees`,
    /// `fundDepth`, `payFit`, `payPlatform` and a royalty flush the PoolManager is locked again, its nonzero-delta
    /// count is zero and the receiver's own ETH and T deltas are zero (the PoolManager's own end-of-unlock check is
    /// what enforces it: a receiver call that completed settled every delta it opened).
    function testProperty_AUDIT_U4_noOpenPoolManagerDeltaAfterAnyReceiverCall() public {
        _toGraduated();
        _trade(eoa[3], 0.8 ether, 3_000);
        _advance(1);
        _collect(keeper, keeper);
        _assertNoOpenDelta("collect");
        _fundFees(eoa[0], 1 ether);
        _assertNoOpenDelta("fundFees");
        _fundDepth(eoa[0], 0.5 ether);
        _assertNoOpenDelta("fundDepth");
        _payFit(eoa[1]);
        _assertNoOpenDelta("payFit");
        _payPlatform(eoa[1]);
        _assertNoOpenDelta("payPlatform");
        _payRoyalty(eoa[2], 0.3 ether);
        royaltyRouter.flush();
        _assertNoOpenDelta("flush");
        _mintClaimsTo(a.receiver, BATCH_MIN);
        _collect(keeper, eoa7702);
        _assertNoOpenDelta("a collect of gifted claims with a tip to a delegated EOA");
        _assertGhostLedger();
    }

    function _assertNoOpenDelta(string memory after_) internal view {
        assertFalse(pm.isUnlocked(), string.concat("the PoolManager is locked after ", after_));
        assertEq(pm.getNonzeroDeltaCount(), 0, string.concat("no nonzero delta after ", after_));
        assertEq(pm.currencyDelta(a.receiver, Currency.wrap(address(0))), 0, string.concat("ETH delta after ", after_));
        assertEq(pm.currencyDelta(a.receiver, Currency.wrap(a.token)), 0, string.concat("T delta after ", after_));
    }

    /// P4.17, L7 extremes (0, 1, 14, 15, 16 wei): `fundFees` with 0 wei is a no-op (no event, nothing booked); 1 and
    /// then 13 more wei are carried whole (a split of zeros, the claims rising by each wei); the 15th wei makes one
    /// unit (11 to FIT, 2 to depth, 2 to the Safe's ledger) and empties the carry; 16 wei make one unit and carry 1.
    function testProperty_AUDIT_U4_weiEdgesOfTheSplit() public {
        _toGraduated();
        // 0 wei: no event, no state change.
        uint256 claims0 = _claimsQ(a.receiver);
        (uint256 bq0,) = receiver.booked();
        vm.recordLogs();
        vm.prank(eoa[0]);
        receiver.fundFees{value: 0}();
        assertEq(vm.getRecordedLogs().length, 0, "0 wei: no event at all");
        assertEq(_claimsQ(a.receiver), claims0);
        (uint256 bq1,) = receiver.booked();
        assertEq(bq1, bq0, "0 wei: nothing booked");
        // Empty the carry (c wei carried: 15 - c more make exactly one unit).
        (uint256 c,) = receiver.carried();
        if (c != 0) _fundFees(eoa[0], DENOM - c);
        (c,) = receiver.carried();
        assertEq(c, 0, "the carry is empty");
        uint256 fit0 = receiver.fitOwed();
        uint256 owed0 = receiver.platformOwed();
        uint256 hookQ0 = _claimsQ(a.hook);
        claims0 = _claimsQ(a.receiver);
        // 1 wei, then 13 more: carried, nothing split, every wei in the receiver's claims and in `booked()`.
        _fundFeesEdge(1, 0, 1);
        _fundFeesEdge(13, 0, 14);
        assertEq(receiver.fitOwed(), fit0, "14 wei: nothing to FIT");
        assertEq(receiver.platformOwed(), owed0, "14 wei: nothing to the Safe");
        assertEq(_claimsQ(a.hook), hookQ0, "14 wei: nothing to depth");
        assertEq(_claimsQ(a.receiver), claims0 + 14, "14 wei of claims, carried");
        (uint256 bq2,) = receiver.booked();
        assertEq(bq2, bq0 + 14, "the carry is booked (part of the ledgers)");
        // The 15th wei: one unit.
        _fundFeesEdge(1, 1, 0);
        assertEq(receiver.fitOwed(), fit0 + 11, "11 wei to FIT");
        assertEq(receiver.platformOwed(), owed0 + 2, "2 wei to the Safe's ledger (under the cap)");
        assertEq(_claimsQ(a.hook), hookQ0 + 2, "2 wei to depth");
        assertEq(_claimsQ(a.receiver), claims0 + 15 - 2, "15 wei in, 2 moved to the hook");
        // 16 wei: one unit and 1 carried.
        _fundFeesEdge(16, 1, 1);
        assertEq(receiver.fitOwed(), fit0 + 22);
        assertEq(receiver.platformOwed(), owed0 + 4);
        assertEq(_claimsQ(a.hook), hookQ0 + 4);
        (uint256 uq,) = _unbooked();
        assertEq(uq, 0, "every wei is in a ledger (the carry included)");
        _assertGhostLedger();
    }

    /// @dev `fundFees{value: amount}` by eoa[0]: expects `units` units split and `carryAfter` carried.
    function _fundFeesEdge(uint256 amount, uint256 units, uint256 carryAfter) internal {
        vm.recordLogs();
        _fundFees(eoa[0], amount);
        AuditU4Tally memory t = _tally(vm.getRecordedLogs());
        assertEq(t.funded, amount, "FeesFunded");
        assertEq(t.splits, 1, "one BatchSplit, even of zeros");
        assertEq(t.qFit, 11 * units);
        assertEq(t.qDepth, 2 * units);
        assertEq(t.qPlatform, 2 * units);
        (uint256 c,) = receiver.carried();
        assertEq(c, carryAfter, "the carry");
    }

    /// M01 (accepted by the founder, F126 `DECISION-LOG.md:141`; map § 5): raw T (FIT) sent straight to the receiver,
    /// not as claims, is in no ledger and has no exit: a collect reads claims only, `_burnPending` burns only
    /// `tBurnPending`, and no path moves it. Pinned as the accepted behaviour, not reported.
    function testAccepted_AUDIT_U4_M01_rawTAtTheReceiverHasNoExit() public {
        _toGraduated();
        uint256 amount = 1e18;
        vm.prank(eoa[0]);
        token.transfer(a.receiver, amount);
        _noteTIn(TIn.Direct, amount);
        assertEq(token.balanceOf(a.receiver), amount);
        assertEq(receiver.tBurnPending(), 0, "no burn waits: the T is not the receiver's own");
        _trade(eoa[3], 0.8 ether, 3_000);
        _advance(1);
        _collect(keeper, keeper);
        _fundFees(eoa[0], 1 ether);
        _fundDepth(eoa[0], 1);
        _payFit(eoa[1]);
        _payPlatform(eoa[1]);
        _payRoyalty(eoa[2], 0.1 ether);
        royaltyRouter.flush();
        assertEq(token.balanceOf(a.receiver), amount, "every path leaves it where it is");
        assertEq(receiver.tBurnPending(), 0);
        _assertGhostLedger();
    }

    /// M02 (accepted by the founder, F126; BC-114's "any other ERC-20 stays"): T (FIT) sent to the royalty router
    /// stays: `sweep(T)` is `TokenNotTaken`, a flush moves ETH and unwrapped WETH only. Pinned as accepted.
    function testAccepted_AUDIT_U4_M02_tAtTheRoyaltyRouterStays() public {
        _toGraduated();
        uint256 amount = 1e18;
        vm.prank(eoa[0]);
        token.transfer(a.royaltyRouter, amount);
        _noteTIn(TIn.Direct, amount);
        vm.expectRevert(abi.encodeWithSelector(IBoxRoyaltyRouter.TokenNotTaken.selector, a.token));
        royaltyRouter.sweep(a.token);
        _payRoyalty(eoa[2], 0.1 ether);
        _payRoyaltyWeth(eoa[2], 0.1 ether);
        assertEq(royaltyRouter.flush(), 0.2 ether, "ETH and WETH leave");
        assertEq(token.balanceOf(a.royaltyRouter), amount, "the T stays");
        _assertGhostLedger();
    }

    /// P4.4, BC-106, BC-143: ETH claims gifted to the coordinator before graduation are forwarded to the receiver at
    /// graduation and split by the settlement in epoch 0 together with the held platform share, under one cap.
    function testProperty_AUDIT_U4_coordinatorGiftIsForwardedAndCappedInEpochZero() public {
        uint256 held0 = receiver.platformHeld();
        _fundFees(eoa[0], 150 ether);
        assertEq(receiver.platformHeld() - held0, 20 ether);
        _toClosed();
        _mintClaimsTo(a.coordinator, 300 ether);
        uint256 held = receiver.platformHeld();
        uint256 reserve = hook.reserveMinted();
        _warpTo(_requestTimeFor(r0));
        vm.recordLogs();
        vm.prank(keeper);
        uint256 reward = coordinator.graduate();
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        assertEq(reward, reserve, "the reward is the reserve, never the gift");
        bool forwarded;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.coordinator) assertTrue(logs[i].topics[0] != POKE_FAILED, "no poke failed");
            if (logs[i].emitter == a.coordinator && logs[i].topics[0] == CLAIMS_FORWARDED) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), a.receiver, "forwarded to the receiver");
                assertEq(abi.decode(logs[i].data, (uint256)), 300 ether, "the whole gift was forwarded");
                forwarded = true;
            }
        }
        assertTrue(forwarded);
        AuditU4Tally memory t = _tally(logs);
        assertTrue(t.settled);
        assertEq(t.heldKept, held, "the held share first, whole (below the cap)");
        assertEq(t.heldToDepth, 0);
        assertEq(t.qPlatform, 32 ether - held, "the gift's P of 40 ETH: what the cap leaves is kept, the rest to depth");
        assertEq(t.credits, 2, "two cap calls: the held share, then the forwarded gift's split");
        for (uint256 i; i < t.credits; ++i) {
            assertEq(t.creditEpoch[i], 0, "everything in epoch 0");
        }
        assertEq(receiver.platformOwed(), 32 ether);
        assertEq(_claimsQ(a.coordinator), reward, "the coordinator keeps exactly the reward");
        _assertGhostLedger();
    }
}
