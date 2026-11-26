// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../../rc5-a/NoFailureSweep.sol";

import {M244Base} from "../../m2-44/Fixture.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

/// Actual factory/coordinator/hook/receiver/token/ledger/shop/loader and real PoolManager.
/// Asset behavior and swap callers are fixtures, not substitutes for the M2 money path.
contract M263LifecycleTest is M244Base {
    function test_R40A_deadlineNative() public { _scenario(0, 0); }
    function test_R40A_deadlineSixDecimals() public { _scenario(0, 6); }
    function test_R40A_deadlineEightDecimals() public { _scenario(0, 8); }
    function test_R40A_deadlineEighteenDecimals() public { _scenario(0, 18); }
    function test_R40A_unopenedNative() public { _scenario(1, 0); }
    function test_R40A_unopenedSixDecimals() public { _scenario(1, 6); }
    function test_R40A_unopenedEightDecimals() public { _scenario(1, 8); }
    function test_R40A_unopenedEighteenDecimals() public { _scenario(1, 18); }
    function test_R40A_hatchNative() public { _scenario(2, 0); }
    function test_R40A_hatchSixDecimals() public { _scenario(2, 6); }
    function test_R40A_hatchEightDecimals() public { _scenario(2, 8); }
    function test_R40A_hatchEighteenDecimals() public { _scenario(2, 18); }

    function _scenario(uint8 mode, uint8 decimals) private {
        _createShop(decimals, 1000 ether, mode == 1, mode != 1);
        uint256 totalP = _money() + _balance(ALICE);
        uint256 aliceT = token.balanceOf(CREATOR) / 5;
        vm.startPrank(CREATOR);
        token.transfer(ALICE, aliceT);
        token.transfer(address(buyer), 100 ether);
        vm.stopPrank();
        buyer.mintClaims(Currency.wrap(address(token)), address(shop), 100 ether);
        if (mode == 1) _page(0, 3);
        else { _trade(); if (mode == 2) _fill(); }
        vm.warp(mode == 1 ? box.openAt() + 14 days : mode == 2 ? hook.closedAt() + 7 days : box.deadline());
        if (mode == 1) box.failClosed(); else box.fail();
        _assertOutstanding();
        (uint256 pot, uint256 left) = box.claimState();
        assertGt(pot, 0);
        uint256 ledgerBacking = _pClaims(address(ledger));
        uint256 creatorT = token.balanceOf(CREATOR);
        uint256 supply = token.totalSupply();
        assertEq(shop.failedT(), 1100 ether);
        assertEq(shop.burnFailedT(), 1100 ether);
        assertEq(token.totalSupply(), supply - 1100 ether);
        assertEq(token.balanceOf(CREATOR), creatorT, "R43-M2A: excluded seed never returns as spendable T");
        assertEq(shop.failedT(), 0);
        assertEq(shop.burnFailedT(), 0);
        // R40A deliberately keeps lost/burned circulating T in the fixed count.
        vm.prank(CREATOR); token.burn(7);
        (, uint256 afterBurn) = box.claimState(); assertEq(afterBurn, left);
        uint256 quote = box.quoteClaim(aliceT);
        assertEq(_claimT(ALICE), quote);
        (pot, afterBurn) = box.claimState(); assertEq(afterBurn, left - aliceT);
        assertEq(_pClaims(address(ledger)), ledgerBacking, "pot claim cannot debit earned P");
        _noSweepAndEarnedExit(pot, afterBurn);
        if (mode == 1) _starterExit();
        assertEq(token.totalSupply() + token.totalBurned(), token.initialSupply());
        assertEq(_money() + _balance(ALICE), totalP, "P conserved through trades, fees, claims and retained failure money");
    }

    function _noSweepAndEarnedExit(uint256 pot, uint256 left) private {
        uint256 deadline = uint256(box.failedAt()) + 365 days;
        vm.warp(deadline - 1);
        NoFailureSweep.check(address(box));
        assertEq(box.quoteClaim(left), pot, "claims remain open one second before the failure anniversary");
        uint256 fitBefore = receiver.fitOwed();
        vm.warp(deadline);
        vm.prank(address(0xBAD)); NoFailureSweep.check(address(box));
        assertEq(receiver.fitOwed(), fitBefore);
        (uint256 remainingP, uint256 remainingT) = box.claimState();
        assertEq(remainingP, pot); assertEq(remainingT, left);
        assertEq(box.quoteClaim(left), pot);
        // The owner may still surrender its T, including after this year boundary.
        _gift(address(box), 53); _gift(address(hook), 59);
        NoFailureSweep.check(address(box));
        NoFailureSweep.check(address(box));
        assertEq(receiver.fitOwed(), fitBefore);
        vm.warp(deadline + 365 days);
        // Settlement two years after failure still reconstructs pre-burn history; pot and owner claims never expire.
        for (uint256 id = 1; id <= 4; ++id) {
            assertTrue(ledger.settleBatch(id, 64));
            uint256 a = ledger.claimable(id, ALICE);
            uint256 c = ledger.claimable(id, CREATOR);
            (,,, uint256 residue) = ledger.batchState(id);
            assertEq(a + c + residue, receiver.holderBatchPaid(id));
            if (a != 0) { vm.prank(ALICE); assertEq(ledger.claim(id, ALICE), a); }
            if (c != 0) { vm.prank(CREATOR); assertEq(ledger.claim(id, CREATOR), c); }
            assertEq(ledger.flushResidue(id), residue);
            assertEq(ledger.flushResidue(id), 0);
        }
        assertEq(_pClaims(address(ledger)), 0);
        receiver.collect(address(0));
        uint256 fit = receiver.fitOwed();
        vm.prank(fitSafe); assertEq(receiver.payFit(), fit);
        uint256 platform = receiver.platformOwed();
        assertEq(receiver.payPlatform(), platform); // fixture itself is the immutable platform owner
        assertEq(receiver.booked(box.q()), 0);
        assertEq(_pClaims(address(receiver)), 0);
    }

    function _starterExit() private {
        uint256[] memory indexes = new uint256[](3); indexes[1] = 1; indexes[2] = 2;
        nft.setBlocked(1, true);
        vm.prank(ALICE); assertEq(shop.returnStarter(indexes), 2);
        assertEq(nft.ownerOf(0), CREATOR); assertEq(nft.ownerOf(1), address(shop));
        assertEq(nft.ownerOf(2), CREATOR); assertEq(nft.ownerOf(3), CREATOR);
        nft.setBlocked(1, false);
        assertEq(shop.returnStarter(indexes), 1);
        assertEq(shop.returnStarter(indexes), 0);
        assertEq(nft.ownerOf(1), CREATOR);
        assertEq(shop.inside(), 0);
        vm.expectRevert(); loader.complete();
    }
}
