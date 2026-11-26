// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../rc5-a/NoFailureSweep.sol";

import {M244Base} from "./Fixture.sol";
import {IBoxCoordinatorV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IHolderTokenHistoryV2, IHolderLedgerV2} from "../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {ShopVaultV2} from "../../../src/box-v2/ShopVaultV2.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {LifeForeignUnlock} from "../kit/FactoryLife.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

/// Immutable fault switch avoids overwriting the real ledger's storage when its runtime is substituted.
contract M244HostileLedger {
    uint256 private immutable mode;
    constructor(uint256 m) { mode = m; }
    fallback() external {
        if (mode == 1) revert("ledger refusal");
        if (mode == 2) { assembly ("memory-safe") { for {} 1 {} {} } }
        assembly ("memory-safe") { revert(0, 65536) }
    }
}

contract M244RecoveryTest is M244Base {
    function test_partialStarterReturnsOnlyCreatorAndRefusedBurnsRetry() public {
        _createShop(0, 1000 ether, true, false);
        _page(0, 3);
        vm.prank(CREATOR); token.transfer(address(buyer), 100 ether);
        buyer.mintClaims(Currency.wrap(address(token)), address(shop), 100 ether);
        vm.warp(box.openAt() + 14 days);
        // A token refusal cannot stop failure; the coordinator/hook retain excluded burn balances.
        vm.mockCallRevert(address(token), abi.encodeWithSignature("burn(uint256)"), "refused burn");
        box.failClosed();
        _assertOutstanding();
        uint256 creatorT = token.balanceOf(CREATOR);
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(shop.burnFailedT(), 0);
        assertEq(shop.failedT(), 1100 ether);
        assertEq(token.balanceOf(address(ShopVaultV2(address(shop)).burnSink())), 0, "failed redemption is atomic");
        uint256[] memory indexes = new uint256[](3);
        indexes[1] = 1; indexes[2] = 2;
        nft.setBlocked(1, true);
        vm.prank(ALICE); assertEq(shop.returnStarter(indexes), 2);
        assertEq(nft.ownerOf(0), CREATOR); assertEq(nft.ownerOf(2), CREATOR);
        assertEq(nft.ownerOf(1), address(shop)); assertEq(nft.ownerOf(3), CREATOR);
        assertEq(shop.inside(), 1);
        nft.setBlocked(1, false); nft.setSink(true);
        assertEq(shop.returnStarter(indexes), 0);
        nft.setSink(false);
        assertEq(shop.returnStarter(indexes), 1);
        assertEq(shop.returnStarter(indexes), 0);
        assertEq(nft.ownerOf(1), CREATOR);
        vm.clearMockedCalls();
        uint256 supply = token.totalSupply();
        assertEq(shop.burnFailedT(), 1100 ether);
        assertEq(token.totalSupply(), supply - 1100 ether);
        assertEq(shop.failedT(), 0); assertEq(token.balanceOf(CREATOR), creatorT);
        (uint256 afterPot, uint256 afterLeft) = box.claimState();
        assertEq(afterPot, pot); assertEq(afterLeft, left); _assertOutstanding();
        vm.expectRevert(); loader.complete();
        vm.expectRevert(); shop.fundSeed();
        vm.expectRevert(); shop.give(address(nft), 3, 0);
        vm.expectRevert(); shop.pick(address(nft), 1, type(uint256).max, ALICE);
        vm.expectRevert(); shop.enterFailure();
        vm.expectRevert(); receiver.enterFailure();
        vm.expectRevert(); ShopVaultV2(address(shop)).burnLiquid();
        vm.expectRevert(); ShopVaultV2(address(shop)).burnClaims();
        vm.expectRevert(); ShopVaultV2(address(shop)).returnOne(0);
        assertEq(_claimT(CREATOR), pot);
    }

    function test_fixedNoBuyerAmountCannotGrowWithLateMoneyOrHolderResidue() public {
        BoxSpec memory s = _holders();
        _start(s);
        ledger = IHolderLedgerV2(box.roleAddress(17));
        _gift(address(box), 1000);
        vm.warp(box.deadline()); box.fail();
        (, uint256 left) = box.claimState(); assertEq(left, 0);
        uint256 fixedClaim = box.quoteClaim(0);
        assertGt(fixedClaim, 0);
        _gift(address(box), 53); _gift(address(hook), 59);
        assertEq(box.quoteClaim(0), fixedClaim);
        NoFailureSweep.check(address(box));
        assertEq(box.quoteClaim(0), fixedClaim);
        vm.expectRevert(); box.claim(0, address(this));
        vm.prank(CREATOR); assertEq(box.claim(0, CREATOR), fixedClaim);
        vm.expectRevert(); vm.prank(CREATOR); box.claim(0, CREATOR);
        for (uint256 id = 1; id <= 4; ++id) {
            assertTrue(ledger.settleBatch(id, 64));
            assertEq(ledger.claimable(id, CREATOR), 0);
            ledger.flushResidue(id);
        }
        receiver.collect(address(0));
        assertGt(receiver.payFit(), 0); NoFailureSweep.check(address(box));
    }

    function test_RC6_holderResidueIsQuotedBeforePublicCollectAndNotCountedTwice() public {
        _createShop(0, 1000 ether, false, true); _trade();
        vm.warp(box.deadline()); box.fail();
        assertTrue(ledger.settleBatch(1, 64));
        (,,, uint256 residue) = ledger.batchState(1); assertGt(residue, 0);
        (uint256 pot, uint256 left) = box.claimState(); assertGt(left, 0);
        uint256 fit = receiver.fitOwed();
        assertEq(ledger.flushResidue(1), residue);
        (uint256 beforeCollect,) = box.claimState(); assertEq(beforeCollect, pot + residue);
        uint256 callerP = _balance(ALICE);
        assertEq(receiver.collect(ALICE).buyersP, residue);
        assertEq(_balance(ALICE), callerP, "failed collect pays no tip");
        assertEq(receiver.fitOwed(), fit);
        (uint256 afterCollect,) = box.claimState(); assertEq(afterCollect, pot + residue);
        uint256 paid = _claimT(CREATOR) + _claimT(address(buyer));
        assertEq(paid, pot + residue);
    }

    function test_revertingLedgerCannotBlockFailureOrClaim() public { _hostile(1); }
    function test_gasSinkLedgerCannotBlockFailureOrClaim() public { _hostile(2); }
    function test_largeRevertLedgerCannotBlockFailureOrClaim() public { _hostile(3); }
    function test_gasSinkLedgerCannotBlockUnopenedFailureOrFunding() public {
        _createShop(0, 1000 ether, true, false);
        _page(0, 3);
        bytes memory original = address(ledger).code;
        vm.etch(address(ledger), address(new M244HostileLedger(2)).code);
        vm.warp(box.openAt() + 14 days); box.failClosed();
        _assertOutstanding();
        uint256 funded = _pClaims(address(ledger)); assertEq(funded, 0, "no public trade before opening");
        for (uint256 id = 1; id <= 4; ++id) assertTrue(receiver.holderBatchClosed(id));
        _claimT(CREATOR); _assertOutstanding();
        assertEq(_pClaims(address(ledger)), funded);
        vm.etch(address(ledger), original);
        for (uint256 id = 1; id <= 4; ++id) assertTrue(ledger.settleBatch(id, 64));
    }
    function _hostile(uint256 mode) private {
        _createShop(0, 1000 ether, false, true);
        _trade();
        bytes memory original = address(ledger).code;
        vm.etch(address(ledger), address(new M244HostileLedger(mode)).code);
        _trade(); // failed hook notices retain denominator units
        if (mode == 2) { _fill(); vm.warp(hook.closedAt() + 7 days); }
        else vm.warp(box.deadline());
        box.fail();
        _assertOutstanding();
        uint256 funded = _pClaims(address(ledger)); assertGt(funded, 0);
        _claimT(CREATOR); _assertOutstanding();
        _claimT(address(buyer)); _assertOutstanding();
        assertEq(_pClaims(address(ledger)), funded, "closure never called or confiscated ledger");
        vm.etch(address(ledger), original);
        assertTrue(ledger.settleBatch(1, 64));
        uint256 earned = ledger.claimable(1, CREATOR); assertGt(earned, 0);
        (,,, uint256 residue) = ledger.batchState(1); assertGt(residue, 0);
        assertEq(earned + residue, receiver.holderBatchPaid(1));
        vm.prank(CREATOR); assertEq(ledger.claim(1, CREATOR), earned);
    }

    function test_pausedPDoesNotBlockClosureAndBothClaimsRollbackForRetry() public {
        _createShop(6, 1000 ether, false, true);
        _trade();
        HostileToken p = HostileToken(box.q()); p.setPaused(true);
        vm.warp(box.deadline()); box.fail();
        _assertOutstanding();
        assertTrue(ledger.settleBatch(1, 64));
        uint256 earned = ledger.claimable(1, CREATOR); assertGt(earned, 0);
        vm.expectRevert(); vm.prank(CREATOR); ledger.claim(1, CREATOR);
        assertEq(ledger.claimable(1, CREATOR), earned);
        uint256 t = token.balanceOf(CREATOR);
        vm.prank(CREATOR); token.approve(address(box), t);
        (uint256 pot, uint256 left) = box.claimState();
        uint256 checkpoint = IHolderTokenHistoryV2(address(token)).holderCheckpoint();
        vm.expectRevert(); vm.prank(CREATOR); box.claim(t, CREATOR);
        assertEq(token.balanceOf(CREATOR), t);
        assertEq(token.allowance(CREATOR, address(box)), t);
        assertEq(IHolderTokenHistoryV2(address(token)).holderCheckpoint(), checkpoint);
        (uint256 afterPot, uint256 afterLeft) = box.claimState();
        assertEq(afterPot, pot); assertEq(afterLeft, left);
        p.setPaused(false);
        vm.prank(CREATOR); assertEq(ledger.claim(1, CREATOR), earned);
        _claimT(CREATOR); _claimT(address(buyer)); _assertOutstanding();
    }

    function test_hatchBoundaryForeignUnlockLowGasAndExclusiveOutcome() public {
        _createShop(0, 1000 ether, false, true); _trade(); _fill();
        uint256 filled = hook.closedAt();
        vm.warp(filled + 7 days - 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.GraduationEscapeNotReached.selector, filled + 7 days));
        box.fail();
        vm.warp(filled + 7 days);
        LifeForeignUnlock foreign = new LifeForeignUnlock(pm);
        (bool ok, bytes memory reason) = foreign.attempt(address(box), abi.encodeCall(box.fail, ()));
        assertFalse(ok); assertEq(bytes4(reason), IBoxCoordinatorV2.ForeignUnlock.selector);
        uint256 state = vm.snapshotState();
        (ok,) = address(box).call{gas: 100000}(abi.encodeCall(box.fail, ()));
        assertFalse(ok); assertFalse(box.failed()); assertEq(hook.closedAt(), filled);
        assertFalse(receiver.holderBatchClosed(1));
        box.fail(); assertTrue(box.failed()); _assertOutstanding();
        vm.expectRevert(); box.graduate();
        assertTrue(vm.revertToState(state));
        box.graduate(); assertTrue(box.graduated());
        vm.expectRevert(); box.fail(); assertFalse(box.failed());
    }
}
