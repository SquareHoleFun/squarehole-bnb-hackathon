// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ShopFixture, ShopNFT} from "../m2-32/ShopFixture.sol";

/// F132: real vault/T/PM, coordinator and ERC-721 doubles. No injected budget or allowance storage.
contract ShopFloorTest is ShopFixture {
    function testFuzz_fundedShopCanGiveCheapestAvailableItemWithinAWeek(
        uint64 rawPrice, uint8 tier, uint8 caps, uint8 rawWeeks, uint32 elapsed
    ) public {
        tier %= 4;
        uint256 unit = bound(uint256(rawPrice), 1, 1e15);
        config.givePricesT = [unit, unit * 2, unit * 3, unit * 4];
        uint256 price = config.givePricesT[tier];
        uint256 weeksToSpend = bound(uint256(rawWeeks), 2, 12);
        config.seedT = price * weeksToSpend;
        config.weeklyBps = caps % 2 == 0 ? 500 : 1000;
        config.collectionBps = [uint16(100), 250, 500][caps % 3];
        for (uint256 i; i < config.tiers.length; ++i) config.tiers[i] = tier;
        _deploy(config); _fund(); _open();
        uint256 original = token.balanceOf(ALICE) + shop.budgetT();
        for (uint256 i; i < weeksToSpend; ++i) {
            vm.warp(vm.getBlockTimestamp() + uint256(elapsed) % 7 days);
            assertGe(shop.budgetT(), price);
            // Even if this week was consumed, waiting exactly a week is sufficient.
            uint256 nowAt = vm.getBlockTimestamp();
            vm.warp(nowAt + 7 days);
            _give(0, i);
            assertEq(shop.budgetT(), config.seedT - (i + 1) * price);
            assertEq(token.balanceOf(address(shop)), shop.budgetT());
            assertEq(token.balanceOf(ALICE) + shop.budgetT(), original);
            assertEq(shop.inside(), i + 1);
        }
        assertEq(shop.budgetT(), 0);
        // A depleted shop has at least two items: picking restores the budget without seed withdrawal.
        vm.prank(ALICE); shop.pick(address(nfts[0]), 0, type(uint256).max, ALICE);
        assertGe(shop.budgetT(), price); assertGe(shop.inside(), 1);
        assertEq(token.balanceOf(ALICE) + shop.budgetT(), original);
        assertEq(token.totalSupply() + token.totalBurned(), token.initialSupply());
    }

    function test_floorIsSharedAcrossCollectionsAndConsumedUntilNextWeek() public {
        config.seedT = 20; _deploy(config); _fund(); _open();
        _give(0, 1);
        nfts[0].mint(ALICE, 2); nfts[1].mint(ALICE, 1);
        uint256 nextWeek = vm.getBlockTimestamp() + 7 days;
        vm.warp(nextWeek - 1);
        vm.prank(ALICE); vm.expectRevert(); shop.give(address(nfts[0]), 2, 0);
        vm.prank(ALICE); vm.expectRevert(); shop.give(address(nfts[1]), 1, 0);
        vm.warp(nextWeek);
        vm.prank(ALICE); assertEq(shop.give(address(nfts[1]), 1, 10), 10);
        assertEq(shop.budgetT(), 0); assertEq(shop.inside(), 2);
        vm.warp(nextWeek + 7 days); // pick first at zero budget: floor must not spend this new receipt
        vm.prank(ALICE); shop.pick(address(nfts[0]), 1, 13, ALICE);
        assertEq(shop.budgetT(), 13);
        vm.prank(ALICE); vm.expectRevert(); shop.give(address(nfts[0]), 2, 0);
        vm.warp(nextWeek + 14 days);
        vm.prank(ALICE); assertEq(shop.give(address(nfts[0]), 2, 10), 10);
        assertEq(shop.budgetT(), 3);
    }

    function test_collectionFloorDoesNotReplenishWithEachGive() public {
        config.seedT = 200; config.collectionBps = 100;
        _deploy(config); _fund(); _open();
        _give(0, 1);
        nfts[0].mint(ALICE, 2);
        vm.prank(ALICE); vm.expectRevert(); shop.give(address(nfts[0]), 2, 0);
        _give(1, 1); // total percentage allowance is 20, each collection's floor is 10
        nfts[2].mint(ALICE, 1);
        vm.prank(ALICE); vm.expectRevert(); shop.give(address(nfts[2]), 1, 0);
        assertEq(shop.budgetT(), 180); assertEq(shop.inside(), 2);
    }

    function test_newCheaperCollectionCannotLowerFloorBeforeItsDelay() public {
        config.seedT = 200;
        for (uint256 i; i < config.tiers.length; ++i) config.tiers[i] = 3;
        _deploy(config); _fund(); _open();
        ShopNFT extra = new ShopNFT();
        vm.prank(CURATOR); shop.addCollection(address(extra), 0);
        // An unused tier or a pending collection cannot suppress the active 100 T floor.
        _give(0, 1); assertEq(shop.budgetT(), 100);
        (, , uint256 activeAt) = shop.collectionTerms(address(extra));
        extra.mint(ALICE, 1); vm.prank(ALICE); extra.setApprovalForAll(address(shop), true);
        vm.warp(activeAt - 1);
        vm.prank(ALICE); vm.expectRevert(); shop.give(address(extra), 1, 10);
        vm.warp(activeAt);
        vm.prank(ALICE); assertEq(shop.give(address(extra), 1, 10), 10);
        assertEq(shop.budgetT(), 90);
        nfts[0].mint(ALICE, 2);
        vm.prank(ALICE); vm.expectRevert(); shop.give(address(nfts[0]), 2, 100);
    }
}
