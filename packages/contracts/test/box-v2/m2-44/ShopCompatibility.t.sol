// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ShopFixture, ShopNFT} from "../m2-32/ShopFixture.sol";
import {IShopVaultV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";

// M2-32 assertions, with explicit clock reads across vm.warp to prevent compiler timestamp caching.
contract M244ShopCompatibilityTest is ShopFixture {
    function test_seedIsApprovedExactOnceAndNotPulledOnInitialize() public {
        assertFalse(shop.seedReady()); assertEq(shop.budgetT(), 0);
        uint256 before = token.balanceOf(CREATOR);
        _fund(); assertTrue(shop.seedReady()); assertEq(shop.budgetT(), 10000);
        assertEq(token.balanceOf(CREATOR), before - 10000);
        vm.expectRevert(); shop.fundSeed();
    }
    function test_fixedPricesRoundUpAndRoundTripAddsSpread() public {
        _fund(); _load(1); _load(2); _open();
        (uint256 giveT, uint256 pickT,) = shop.collectionTerms(address(nfts[0]));
        assertEq(giveT, 10); assertEq(pickT, 13);
        vm.prank(ALICE); assertEq(shop.pick(address(nfts[0]), 2, 13, ALICE), 13);
        vm.prank(ALICE); assertEq(shop.give(address(nfts[0]), 2, 10), 10);
        assertEq(shop.budgetT(), 10003); assertEq(token.balanceOf(address(shop)), 10003);
        assertEq(shop.inside(), 2); assertEq(shop.collectionSize(), 2); assertEq(shop.supplyFloor(), 0);
    }
    function test_lastItemAndCallerLimitsAreAtomic() public {
        _fund(); _load(1); _load(2); _open();
        vm.prank(ALICE); vm.expectRevert(); shop.pick(address(nfts[0]), 2, 12, ALICE);
        vm.prank(ALICE); shop.pick(address(nfts[0]), 2, 13, ALICE);
        vm.prank(ALICE); vm.expectRevert(); shop.pick(address(nfts[0]), 1, 13, ALICE);
        vm.prank(ALICE); vm.expectRevert(); shop.give(address(nfts[0]), 2, 11);
        assertEq(shop.inside(), 1); assertEq(shop.budgetT(), 10013);
    }
    function test_noMovesBeforeGraduationOrAfterFailure() public {
        _fund(); _load(1); _load(2);
        vm.prank(ALICE); vm.expectRevert(); shop.pick(address(nfts[0]), 1, 100, ALICE);
        nfts[0].mint(ALICE, 3);
        vm.prank(ALICE); vm.expectRevert(); shop.give(address(nfts[0]), 3, 0);
        _fail();
        vm.prank(address(coord)); vm.expectRevert(); shop.openGate();
        vm.expectRevert(); shop.fundSeed();
        vm.prank(LOADER); vm.expectRevert(); shop.loadStarter(address(nfts[0]), 3, 0);
        assertEq(shop.budgetT(), 0); assertEq(shop.failedT(), 10000);
    }
    function test_weeklyAndConcurrentCollectionLimitsAtBoundary() public {
        _fund(); _open();
        uint256 start = vm.getBlockTimestamp();
        for (uint256 c; c < 4; ++c) for (uint256 i; i < 25; ++i) _give(c, i);
        vm.prank(ALICE); nfts[4].mint(ALICE, 1);
        vm.prank(ALICE); vm.expectRevert(); shop.give(address(nfts[4]), 1, 0);
        vm.warp(start + 7 days - 1);
        vm.prank(ALICE); vm.expectRevert(); shop.give(address(nfts[4]), 1, 0);
        vm.warp(start + 7 days);
        vm.prank(ALICE); shop.give(address(nfts[4]), 1, 0);
        assertEq(shop.budgetT(), 8990); assertEq(shop.inside(), 101);
    }
    function test_pickReceiptsWaitUntilNextWeekAndLoopsCostSpread() public {
        _fund(); _load(100); _load(101); _open();
        uint256 start = vm.getBlockTimestamp();
        for (uint256 i; i < 25; ++i) _give(0, i);
        vm.prank(ALICE); shop.pick(address(nfts[0]), 0, 13, ALICE);
        vm.prank(ALICE); vm.expectRevert(); shop.give(address(nfts[0]), 0, 0);
        vm.warp(start + 7 days);
        vm.prank(ALICE); shop.give(address(nfts[0]), 0, 0);
        assertEq(shop.budgetT(), 9753);
    }
    function test_initialDelayAndCuratorCooldownSurviveHandover() public {
        _fund(); coord.phase(true, false, true); vm.prank(address(coord)); shop.openGate();
        nfts[0].mint(ALICE, 1);
        vm.warp(vm.getBlockTimestamp() + 7 days - 1);
        vm.prank(ALICE); vm.expectRevert(); shop.give(address(nfts[0]), 1, 0);
        vm.warp(vm.getBlockTimestamp() + 1); vm.prank(ALICE); shop.give(address(nfts[0]), 1, 0);
        ShopNFT extra = new ShopNFT(); vm.prank(CURATOR); shop.addCollection(address(extra), 3);
        vm.prank(CURATOR); shop.proposeCurator(ALICE);
        vm.expectRevert(); shop.acceptCurator(); vm.prank(ALICE); shop.acceptCurator();
        ShopNFT later = new ShopNFT();
        vm.prank(ALICE); vm.expectRevert(); shop.addCollection(address(later), 2);
        vm.warp(vm.getBlockTimestamp() + 7 days); vm.prank(ALICE); shop.addCollection(address(later), 2);
        vm.prank(ALICE); shop.proposeCurator(CURATOR); vm.prank(ALICE); shop.renounceCurator();
        vm.prank(CURATOR); vm.expectRevert(); shop.acceptCurator();
        ShopNFT last = new ShopNFT();
        vm.prank(ALICE); vm.expectRevert(); shop.addCollection(address(last), 0);
    }
    function test_hostileMintingSeizureAndStickyTransfersCannotDoublePay() public {
        _fund(); _open(); _give(0, 1); _give(0, 2);
        nfts[0].seize(1, ALICE);
        vm.prank(ALICE); vm.expectRevert(); shop.give(address(nfts[0]), 1, 0);
        vm.prank(ALICE); vm.expectRevert(); shop.pick(address(nfts[0]), 1, 100, ALICE);
        nfts[0].hostile(1, address(0), ""); nfts[0].mint(ALICE, 3);
        vm.prank(ALICE); vm.expectRevert(); shop.give(address(nfts[0]), 3, 0);
        vm.prank(ALICE); vm.expectRevert(); shop.pick(address(nfts[0]), 2, 100, ALICE);
        assertEq(shop.budgetT(), 9980); assertEq(shop.inside(), 2);
    }
    function test_reentryCannotSpendAllowanceOrPickAgain() public {
        _fund(); _load(1); _load(2); _open(); nfts[0].mint(ALICE, 3);
        nfts[0].hostile(2, address(shop), abi.encodeCall(IShopVaultV2.give, (address(nfts[0]), 3, 0)));
        vm.prank(ALICE); vm.expectRevert(); shop.give(address(nfts[0]), 3, 0);
        assertEq(shop.budgetT(), 10000); assertEq(shop.inside(), 2);
    }
    function test_countIntegralAndUnsolicitedNFTs() public {
        _fund(); _load(1); uint256 start = vm.getBlockTimestamp();
        vm.warp(start + 11); _load(2);
        (uint256 integral,) = shop.insideIntegral(); assertEq(integral, 11);
        nfts[0].mint(ALICE, 9);
        vm.prank(ALICE); vm.expectRevert(); nfts[0].safeTransferFrom(ALICE, address(shop), 9);
        vm.prank(ALICE); nfts[0].transferFrom(ALICE, address(shop), 9);
        assertEq(shop.inside(), 2); assertEq(shop.collectionSize(), 2);
        vm.prank(ALICE); vm.expectRevert(); token.transfer(address(shop), 1);
    }
}
