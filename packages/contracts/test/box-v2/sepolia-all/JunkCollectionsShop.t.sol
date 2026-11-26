// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ShopFixture} from "../m2-32/ShopFixture.sol";
import {IShopVaultV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {JunkCollection} from "../../../src/test-coins/JunkCollection.sol";

contract JunkCollectionsShopTest is ShopFixture {
    JunkCollection[5] private junk;

    function setUp() public override {
        vm.chainId(31337);
        super.setUp();
        for (uint8 i; i < 5; ++i) {
            junk[i] = new JunkCollection(address(this), i);
            junk[i].mint(ALICE, 1, 1);
            junk[i].mint(ALICE, 2, 2);
            config.collections[i] = address(junk[i]);
        }
        config.pickBps = 20000;
        _deploy(config);
        for (uint8 i; i < 5; ++i) {
            vm.prank(ALICE); junk[i].setApprovalForAll(address(shop), true);
        }
        _fund();
    }

    function test_TA40_allFiveWaitSevenDaysThenGiveAndPickExactAmounts() public {
        coord.phase(true, false, true);
        vm.prank(address(coord)); shop.openGate();
        uint256 budget = shop.budgetT();
        uint256 balance = token.balanceOf(ALICE);
        (uint256 price, uint256 pickPrice, uint256 readyAt) = shop.collectionTerms(address(junk[0]));
        vm.warp(readyAt - 1);
        for (uint8 i; i < 5; ++i) {
            vm.prank(ALICE); vm.expectRevert(IShopVaultV2.InvalidRequest.selector);
            shop.give(address(junk[i]), 1, price);
            assertEq(junk[i].ownerOf(1), ALICE);
        }
        assertEq(shop.budgetT(), budget);
        assertEq(token.balanceOf(ALICE), balance);
        vm.warp(readyAt);
        for (uint8 i; i < 5; ++i) {
            vm.prank(ALICE); assertEq(shop.give(address(junk[i]), 1, price), price);
            assertEq(junk[i].ownerOf(1), address(shop));
        }
        assertEq(shop.inside(), 5);
        assertEq(shop.budgetT(), budget - 5 * price);
        assertEq(token.balanceOf(ALICE), balance + 5 * price);
        vm.prank(ALICE); assertEq(shop.pick(address(junk[0]), 1, pickPrice, ALICE), pickPrice);
        assertEq(junk[0].ownerOf(1), ALICE);
        assertEq(shop.inside(), 4);
        assertEq(shop.budgetT(), budget - 5 * price + pickPrice);
        assertEq(token.balanceOf(ALICE), balance + 5 * price - pickPrice);
    }

    function test_TA40_newEntryDelayAndMissingApprovalAreAtomic() public {
        _open();
        JunkCollection later = new JunkCollection(address(this), 0);
        later.mint(ALICE, 1, 1);
        vm.prank(CURATOR); shop.addCollection(address(later), 0);
        (uint256 price,, uint256 readyAt) = shop.collectionTerms(address(later));
        assertEq(readyAt, block.timestamp + 7 days);
        vm.prank(ALICE); later.approve(address(shop), 1);
        vm.warp(readyAt - 1);
        vm.prank(ALICE); vm.expectRevert(IShopVaultV2.InvalidRequest.selector); shop.give(address(later), 1, price);
        vm.warp(readyAt);
        vm.prank(ALICE); later.approve(address(0), 1);
        uint256 budget = shop.budgetT();
        vm.prank(ALICE); vm.expectRevert(); shop.give(address(later), 1, price);
        assertEq(shop.budgetT(), budget);
        assertEq(later.ownerOf(1), ALICE);
        vm.prank(ALICE); later.approve(address(shop), 1);
        vm.prank(ALICE); assertEq(shop.give(address(later), 1, price), price);
        assertEq(later.ownerOf(1), address(shop));
    }
}
