// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M244Base} from "../../../m2-44/Fixture.sol";
import {DefaultArtifacts} from "../../../m3-40/DefaultArtifacts.sol";
import {StdCheatsSafe} from "forge-std/StdCheats.sol";

/// FINAL-M01 / F132: minimum admitted real factory shop, repeated budget replenishment and exits.
contract Round2ShopCyclesTest is M244Base, DefaultArtifacts {
    function deployCode(string memory what, bytes memory args)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what, args); }
    function deployCode(string memory what)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what); }

    function test_minimumSeedKeepsAnExitAcrossRepeatedAnnualCycles() public {
        _createShop(0, 2 ether, false, true);
        _fill(); box.graduate();
        vm.warp(vm.getBlockTimestamp() + 8 days);
        nft.mint(ALICE, 10); nft.mint(ALICE, 11);
        vm.prank(ALICE); nft.setApprovalForAll(address(shop), true);
        vm.prank(ALICE); shop.give(address(nft), 10, 1 ether);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        vm.prank(ALICE); shop.give(address(nft), 11, 1 ether);
        assertEq(shop.budgetT(), 0);
        uint256 total = token.balanceOf(ALICE) + token.balanceOf(address(buyer));
        vm.prank(address(buyer)); token.approve(address(shop), type(uint256).max);
        for (uint256 i; i < 4; ++i) {
            vm.warp(vm.getBlockTimestamp() + 365 days);
            vm.prank(address(buyer)); assertEq(shop.pick(address(nft), 10, 1.5 ether, ALICE), 1.5 ether);
            assertEq(shop.inside(), 1);
            vm.prank(address(buyer)); vm.expectRevert(); shop.pick(address(nft), 11, 1.5 ether, ALICE);
            // The first pick started the week: its new receipt cannot replenish that snapshot.
            if (i < 2) {
                vm.prank(ALICE); vm.expectRevert(); shop.give(address(nft), 10, 1 ether);
            }
            vm.warp(vm.getBlockTimestamp() + 7 days);
            vm.prank(ALICE); assertEq(shop.give(address(nft), 10, 1 ether), 1 ether);
            assertEq(shop.budgetT(), (i + 1) * 0.5 ether);
            assertEq(shop.inside(), 2);
            assertEq(token.balanceOf(address(shop)), shop.budgetT());
            assertEq(token.balanceOf(ALICE) + token.balanceOf(address(buyer)) + shop.budgetT(), total);
            assertEq(token.totalSupply() + token.totalBurned(), token.initialSupply());
        }
    }
}
