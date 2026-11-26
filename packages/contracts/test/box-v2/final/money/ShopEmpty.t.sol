// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M244Base} from "../../m2-44/Fixture.sol";
import {DefaultArtifacts} from "../../m3-40/DefaultArtifacts.sol";
import {StdCheatsSafe} from "forge-std/StdCheats.sol";

/// FINAL-M01: seed admission, zero-count loader completion, weekly allowance and last-item reserve compose.
contract FinalMoneyEmptyShopTest is M244Base, DefaultArtifacts {
    function deployCode(string memory what, bytes memory args)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what, args); }
    function deployCode(string memory what)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what); }

    function _firstGive(uint256 seed) private {
        _createShop(0, seed, false, true);
        assertEq(shop.inside(), 0);
        (uint32 loaded, bytes32 remaining, bool notified) = loader.progress();
        assertEq(loaded, 0); assertEq(remaining, bytes32(0)); assertTrue(notified);
        _fill(); box.graduate();
        vm.warp(vm.getBlockTimestamp() + 8 days);
        nft.mint(ALICE, 10); nft.mint(ALICE, 11);
        vm.startPrank(ALICE);
        nft.setApprovalForAll(address(shop), true);
        assertEq(shop.give(address(nft), 10, 1 ether), 1 ether);
        vm.stopPrank();
        assertEq(shop.budgetT(), seed - 1 ether);
        assertEq(token.balanceOf(address(shop)), seed - 1 ether);
        assertEq(token.balanceOf(ALICE), 1 ether);
        assertEq(shop.inside(), 1);
    }

    function test_FINAL_M01_emptyAdmittedShopRetainsAnExitAfterFirstGive() public {
        _firstGive(40 ether);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        vm.prank(address(buyer)); token.approve(address(shop), type(uint256).max);
        vm.prank(address(buyer));
        (bool pick,) = address(shop).call(abi.encodeCall(shop.pick, (address(nft), 10, 1.5 ether, ALICE)));
        assertFalse(pick, "frozen last-item reserve");
        (bool seed,) = address(shop).call(abi.encodeCall(shop.fundSeed, ()));
        (bool burn,) = address(shop).call(abi.encodeCall(shop.burnFailedT, ()));
        (bool fail,) = address(box).call(abi.encodeCall(box.fail, ()));
        assertFalse(seed); assertFalse(burn); assertFalse(fail);
        // F132: 39 * 2.5% is only 0.975 T; the floor must still permit the next 1 T give.
        vm.prank(ALICE);
        (bool give,) = address(shop).call(abi.encodeCall(shop.give, (address(nft), 11, 1 ether)));
        assertTrue(give, "accepted seed must not become permanently unspendable after the first honest give");
        assertEq(shop.budgetT(), 38 ether);
        assertEq(token.balanceOf(address(shop)), 38 ether);
        assertEq(token.balanceOf(ALICE), 2 ether);
        assertEq(shop.inside(), 2);
        assertEq(token.totalSupply() + token.totalBurned(), token.initialSupply());
    }

    function test_twoGiveSeedEmptyShopCanGiveTwiceThenPickAndConserveT() public {
        _firstGive(2 ether);
        vm.prank(ALICE); vm.expectRevert(); shop.give(address(nft), 11, 1 ether);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        vm.prank(ALICE); assertEq(shop.give(address(nft), 11, 1 ether), 1 ether);
        assertEq(shop.budgetT(), 0); assertEq(shop.inside(), 2);
        vm.startPrank(address(buyer));
        token.approve(address(shop), type(uint256).max);
        assertEq(shop.pick(address(nft), 10, 1.5 ether, ALICE), 1.5 ether);
        vm.stopPrank();
        assertEq(shop.inside(), 1); assertEq(shop.budgetT(), 1.5 ether);
        assertEq(token.balanceOf(address(shop)), 1.5 ether);
        assertEq(token.balanceOf(ALICE), 2 ether);
        assertEq(token.totalSupply() + token.totalBurned(), token.initialSupply());
        vm.warp(vm.getBlockTimestamp() + 7 days);
        vm.prank(ALICE); assertEq(shop.give(address(nft), 10, 1 ether), 1 ether);
        assertEq(shop.inside(), 2); assertEq(shop.budgetT(), 0.5 ether);
    }

    function test_emptyShop41TControlCanGiveAgainThenPickAndConserveT() public {
        _firstGive(41 ether);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        vm.prank(ALICE); assertEq(shop.give(address(nft), 11, 1 ether), 1 ether);
        vm.startPrank(address(buyer));
        token.approve(address(shop), type(uint256).max);
        assertEq(shop.pick(address(nft), 10, 1.5 ether, ALICE), 1.5 ether);
        vm.stopPrank();
        assertEq(shop.inside(), 1);
        assertEq(shop.budgetT(), 40.5 ether);
        assertEq(token.balanceOf(address(shop)), 40.5 ether);
        assertEq(token.balanceOf(ALICE), 2 ether);
        assertEq(token.totalSupply() + token.totalBurned(), token.initialSupply());
    }
}
