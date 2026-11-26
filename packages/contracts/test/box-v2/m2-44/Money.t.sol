// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../rc5-a/NoFailureSweep.sol";

import {Vm} from "forge-std/Vm.sol";
import {M244Base} from "./Fixture.sol";
import {TradeBatchV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {FailCause} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";

contract M244MoneyTest is M244Base {
    struct Before {
        uint256 pot;
        uint256 reserve;
        uint256 pool;
        uint256 fit;
        uint256 platform;
        uint256 ledgerP;
        uint256 tax;
        uint256 tipBalance;
    }

    struct After { uint256 principal; uint256 events; uint256 funded; uint256 pool; uint256 fit; uint256 platform; uint256 pot; }

    function test_deadlineNativeFinalBatchAndEarnedCreditsStaySeparate() public { _scenario(0, 0, false); }
    function test_deadlineSixDecimalsPreservesEarlierCredits() public { _scenario(0, 6, true); }
    function test_deadlineEightDecimalsFinalBatch() public { _scenario(0, 8, false); }
    function test_deadlineEighteenDecimalsPreservesEarlierCredits() public { _scenario(0, 18, true); }
    function test_hatchNativePreservesEarlierCredits() public { _scenario(2, 0, true); }
    function test_hatchSixDecimalsFinalBatch() public { _scenario(2, 6, false); }
    function test_hatchEightDecimalsPreservesEarlierCredits() public { _scenario(2, 8, true); }
    function test_hatchEighteenDecimalsFinalBatch() public { _scenario(2, 18, false); }
    function test_unopenedNativeFinalizesBootstrapAndCreatorBatches() public { _scenario(1, 0, false); }
    function test_unopenedSixDecimals() public { _scenario(1, 6, false); }
    function test_unopenedEightDecimals() public { _scenario(1, 8, false); }
    function test_unopenedEighteenDecimals() public { _scenario(1, 18, false); }

    function _scenario(uint8 mode, uint8 decimals, bool prior) private {
        _createShop(decimals, 1000 ether, mode == 1, mode != 1);
        if (mode == 1) _page(0, 3);
        else {
            uint256 third = token.balanceOf(CREATOR) / 3;
            vm.prank(CREATOR);
            token.transfer(ALICE, third);
            _trade();
            if (prior) receiver.collect(address(0));
            _trade();
            if (mode == 2) _fill();
        }
        uint256 first = prior ? 3 : 1;
        uint256 totalP = _money() + _balance(ALICE);
        After memory a = _closeAccounting(mode, first);
        _claimsAndLate(mode, first, a, totalP);
    }

    function _closeAccounting(uint8 mode, uint256 first) private returns (After memory a) {
        Before memory b = Before(_pClaims(address(box)), box.reserve(), receiver.poolHeldP(),
            receiver.fitOwed(), receiver.platformOwed(), _pClaims(address(ledger)),
            _balance(box.launchRouter()), _balance(address(this)));
        // A plain donation is a separately attributed source, not a holder receipt or curve principal.
        _gift(address(receiver), 31);
        // Pre-failure royalties join the pot whole, without earning units or entering the D6 split.
        _royalty(47);
        b.tipBalance = _balance(address(this));
        vm.warp(mode == 1 ? box.openAt() + 14 days : mode == 2 ? hook.closedAt() + 7 days : box.deadline());
        vm.recordLogs();
        if (mode == 1) box.failClosed(); else box.fail();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == keccak256("Closed(bytes32,uint256,uint256)")) {
                (a.principal,) = abi.decode(logs[i].data, (uint256, uint256));
            }
            if (logs[i].emitter == address(receiver) && logs[i].topics[0] == keccak256("HolderBatchFunded(uint256,uint256)")) ++a.events;
        }
        assertEq(uint256(box.failCause()), uint256(mode == 1 ? FailCause.ClosedPastCap : mode == 2 ? FailCause.GraduationTimedOut : FailCause.Deadline));
        assertGt(a.principal, 0);
        assertEq(a.events, 4, "close and harvest pairs finalized exactly once, including empty pair");
        _assertOutstanding();
        a.pool = b.pool;
        a.fit = b.fit;
        a.platform = b.platform;
        for (uint256 id = first; id < first + 4; ++id) {
            TradeBatchV2 memory receipt = hook.tradeBatch(id);
            assertTrue(receipt.closed);
            assertTrue(receiver.holderBatchClosed(id));
            uint256 unit = receipt.netP / 15;
            assertEq(receiver.holderBatchPaid(id), 10 * unit, "only receipt net P funds this batch");
            a.funded += 10 * unit;
            a.pool += 2 * unit + receipt.netP % 15;
            a.fit += 2 * unit;
            a.platform += unit;
        }
        uint256 nonTrade = hook.reserveMinted() + 31;
        a.pool += 12 * (nonTrade / 15) + nonTrade % 15;
        a.fit += 2 * (nonTrade / 15);
        a.platform += nonTrade / 15;
        assertEq(receiver.fitOwed(), a.fit, "FIT receives only its pre-failure fee share");
        assertEq(receiver.platformOwed(), a.platform);
        assertEq(_pClaims(address(ledger)), b.ledgerP + a.funded, "old and new holder funding outside pot");
        (a.pot,) = box.claimState();
        uint256 tip = _balance(address(this)) - b.tipBalance;
        assertLe(tip, hook.deepenTipCap());
        assertEq(a.pot + tip, b.pot - b.reserve + a.principal + b.tax + a.pool + 47, "D6 alone leaves principal for splitting");
        assertEq(receiver.poolHeldP(), 0);
        assertEq(receiver.royaltyHeldP(), 0);
        uint256 fundingBefore = _pClaims(address(ledger));
        receiver.collect(address(this));
        vm.prank(address(box)); receiver.enterFailure();
        assertEq(_pClaims(address(ledger)), fundingBefore, "retries cannot fund again");
        assertFalse(receiver.holderBatchClosed(first + 4));
        vm.expectRevert(); if (mode == 1) box.failClosed(); else box.fail();

    }

    function _claimsAndLate(uint8 mode, uint256 first, After memory expected, uint256 totalP) private {
        // Failure-pot claims burn all circulating T before holder settlement: historical earnings survive.
        uint256 paid = _claimT(CREATOR);
        _assertOutstanding();
        if (mode != 1) {
            paid += _claimT(ALICE);
            _assertOutstanding();
            paid += _claimT(address(buyer));
        }
        assertEq(paid, expected.pot, "last counted T empties the pot");
        _assertOutstanding();
        (uint256 pot,) = box.claimState(); assertEq(pot, 0);
        vm.warp(block.timestamp + 60 days);
        uint256 credits;
        uint256 residue;
        for (uint256 id = 1; id < first + 4; ++id) {
            assertTrue(ledger.settleBatch(id, 64));
            uint256 c = ledger.claimable(id, CREATOR);
            uint256 a = ledger.claimable(id, ALICE);
            (,,, uint256 r) = ledger.batchState(id);
            assertEq(c + a + r, receiver.holderBatchPaid(id));
            if (c != 0) { vm.prank(CREATOR); assertEq(ledger.claim(id, CREATOR), c); }
            if (a != 0) { vm.prank(ALICE); assertEq(ledger.claim(id, ALICE), a); }
            credits += c + a; residue += r;
            assertEq(ledger.flushResidue(id), r);
            assertEq(ledger.flushResidue(id), 0);
        }
        if (mode != 1) assertGt(credits, 0); else assertEq(credits, 0, "creator receives T only after its buy notice");
        assertEq(_pClaims(address(ledger)), 0);
        receiver.collect(address(0));
        assertEq(receiver.fitOwed(), expected.fit);
        _gift(address(box), 53);
        _gift(address(hook), 59);
        NoFailureSweep.check(address(box));
        _royalty(61);
        assertEq(receiver.fitOwed(), expected.fit, "late P never becomes FIT debt");
        assertEq(receiver.payFit(), expected.fit);
        assertEq(receiver.payPlatform(), expected.platform);
        assertEq(receiver.booked(box.q()), 0);
        assertEq(_pClaims(address(receiver)), 0);
        assertEq(_money() + _balance(ALICE), totalP, "all underlying P conserved");
    }

    function _royalty(uint256 amount) private {
        address p = box.q();
        if (p == address(0)) receiver.fundRoyalty{value: amount}(address(0), amount);
        else {
            // Move existing fixture P, never mint money during conservation checks.
            vm.prank(CREATOR);
            (bool ok,) = p.call(abi.encodeWithSignature("approve(address,uint256)", address(receiver), amount));
            assertTrue(ok);
            vm.prank(CREATOR); receiver.fundRoyalty(p, amount);
        }
    }
}
