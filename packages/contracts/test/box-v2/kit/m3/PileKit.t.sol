// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PileKit, HostileToken} from "./PileKit.sol";

contract M303PileKitTest is PileKit {
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    function decimalsAt(uint256 i) internal pure returns (uint8) { return i == 0 ? 6 : i == 1 ? 8 : 18; }
    function holders() internal {
        token.transfer(ALICE, 30); token.transfer(BOB, 70);
        vm.prank(ALICE); token.approve(address(pile), 30);
        vm.prank(BOB); token.approve(address(pile), 70);
    }
    function test_R10_threeDecimalsPauseReentryAndExactMovementRollback() public {
        for (uint256 i; i < 3; ++i) {
            uint256 seed = 1001 * 10 ** uint256(decimalsAt(i));
            makePile(decimalsAt(i), seed, 100); holders();
            asset.setPaused(true); vm.expectRevert(HostileToken.Paused.selector); pile.load();
            assertFalse(pile.loaded()); assertEq(asset.balanceOf(address(this)), seed);
            asset.setPaused(false);
            asset.armReentry(address(pile), abi.encodeCall(pile.load, ()));
            vm.expectRevert(bytes("reentry")); pile.load(); assertFalse(pile.loaded());
            assertEq(asset.allowance(address(this), address(pile)), seed);
            asset.armReentry(address(0), ""); vm.prank(BOB); pile.load(); pile.graduate();
            asset.setPaused(true);
            vm.prank(ALICE); vm.expectRevert(HostileToken.Paused.selector); pile.redeem(30, 0, ALICE);
            expectCustody(seed, 100, ALICE, 0, BOB, 0); assertEq(token.balanceOf(ALICE), 30);
            asset.setPaused(false);
            asset.armReentry(address(pile), abi.encodeCall(pile.redeem, (1, 0, BOB)));
            vm.prank(ALICE); vm.expectRevert(bytes("reentry")); pile.redeem(30, 0, ALICE);
            expectCustody(seed, 100, ALICE, 0, BOB, 0); assertEq(token.allowance(ALICE, address(pile)), 30);
            asset.armReentry(address(0), ""); asset.setFeeBps(100);
            vm.prank(ALICE); vm.expectRevert(bytes("exact")); pile.redeem(30, 0, ALICE);
            expectCustody(seed, 100, ALICE, 0, BOB, 0); asset.setFeeBps(0);
            vm.prank(ALICE); pile.redeem(30, seed * 30 / 100, ALICE);
            expectCustody(seed - seed * 30 / 100, 70, ALICE, seed * 30 / 100, BOB, 0);
            vm.prank(BOB); pile.redeem(70, 0, BOB);
            expectCustody(0, 0, ALICE, seed * 30 / 100, BOB, seed - seed * 30 / 100);
            assertEq(asset.balanceOf(ALICE) + asset.balanceOf(BOB), seed);
        }
    }
    function test_R11_eachDecimalFailedSeedReturnRetriesAndKeepsExcludedT() public {
        for (uint256 i; i < 3; ++i) {
            makePile(decimalsAt(i), 1001, 100); pile.load(); token.transfer(address(pile), 20);
            asset.setPaused(true); pile.fail(); assertEq(pile.excludedT(), 20);
            vm.expectRevert(HostileToken.Paused.selector); pile.returnSeed(); assertFalse(pile.returned());
            asset.setPaused(false);
            asset.armReentry(address(pile), abi.encodeCall(pile.returnSeed, ()));
            vm.expectRevert(bytes("reentry")); pile.returnSeed(); assertFalse(pile.returned());
            assertEq(asset.balanceOf(address(pile)), 1001); assertEq(token.balanceOf(address(pile)), 20);
            asset.armReentry(address(0), ""); vm.prank(BOB); pile.returnSeed();
            assertEq(asset.balanceOf(address(this)), 1001); assertEq(asset.balanceOf(BOB), 0);
            assertEq(token.balanceOf(address(pile)), 20); assertEq(token.totalSupply() - pile.excludedT(), 80);
            vm.expectRevert(); pile.returnSeed();
        }
    }
    function testFuzz_R10_eachHolderAndSplitRedemption(uint128 raw, bool reverse, bool split) public {
        uint256 seed = uint256(raw) + 1;
        makePile(8, seed, 100); holders(); pile.load(); pile.graduate();
        address first = reverse ? BOB : ALICE; address last = reverse ? ALICE : BOB;
        uint256 share = reverse ? 70 : 30; uint256 firstOut;
        if (split) {
            vm.prank(first); firstOut = pile.redeem(1, 0, first);
            assertEq(firstOut, seed / 100);
            expectCustody(seed-firstOut, 99, first, firstOut, last, 0);
            uint256 rest = (seed-firstOut) * (share-1) / 99;
            vm.prank(first); assertEq(pile.redeem(share-1, 0, first), rest); firstOut += rest;
            assertLe(seed * share / 100 - firstOut, 1);
        } else {
            vm.prank(first); firstOut = pile.redeem(share, 0, first); assertEq(firstOut, seed * share / 100);
        }
        expectCustody(seed-firstOut, 100-share, first, firstOut, last, 0);
        vm.prank(last); assertEq(pile.redeem(100-share, 0, last), seed-firstOut);
        expectCustody(0, 0, first, firstOut, last, seed-firstOut);
    }
    function test_R10_fullWidthProductNoIntermediateOverflow() public {
        makePile(18, 1 << 200, 1 << 100); pile.load(); pile.graduate();
        assertEq(pile.redeem(1 << 99, 0, ALICE), 1 << 199);
        expectCustody(1 << 199, 1 << 99, ALICE, 1 << 199, BOB, 0);
    }
}
