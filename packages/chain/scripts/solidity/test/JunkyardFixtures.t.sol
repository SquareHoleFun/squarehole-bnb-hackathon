// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {JunkyardGold, JunkyardSafeDouble, JunkyardCollection} from "../JunkyardLocal.s.sol";

contract JunkyardFixturesTest is Test {
    JunkyardGold private gold;
    address private constant ISSUER = address(0x1111);
    address private constant ALICE = address(0x2222);
    address private constant BOB = address(0x3333);
    function setUp() public { gold = new JunkyardGold(ISSUER); gold.mint(ALICE, 100 ether); }
    function test_issuerOnlyFreezePauseAndFee() public {
        vm.expectRevert(); gold.setPaused(true);
        vm.expectRevert(); gold.setFrozen(ALICE, true);
        vm.expectRevert(); gold.setFeeBps(100);
        vm.prank(ISSUER); gold.setFrozen(ALICE, true);
        vm.prank(ALICE); vm.expectRevert(); gold.transfer(BOB, 1 ether);
        assertEq(gold.balanceOf(ALICE), 100 ether); assertEq(gold.balanceOf(BOB), 0);
        vm.prank(ISSUER); gold.setFrozen(ALICE, false);
        vm.prank(ISSUER); gold.setPaused(true);
        vm.prank(ALICE); vm.expectRevert(); gold.transfer(BOB, 1 ether);
        vm.prank(ISSUER); gold.setPaused(false);
        vm.prank(ISSUER); gold.setFeeBps(100);
        vm.prank(ALICE); gold.transfer(BOB, 1 ether);
        assertEq(gold.balanceOf(BOB), 0.99 ether); assertEq(gold.balanceOf(ISSUER), 0.01 ether);
        assertEq(gold.totalSupply(), 100 ether);
    }
    function test_refusalRestoresAllowanceAndIssuerCanResume() public {
        vm.prank(ALICE); gold.approve(BOB, 5 ether);
        vm.prank(ISSUER); gold.setFrozen(BOB, true);
        vm.prank(BOB); vm.expectRevert(); gold.transferFrom(ALICE, address(this), 5 ether);
        assertEq(gold.allowance(ALICE, BOB), 5 ether);
        vm.prank(ISSUER); gold.setFrozen(BOB, false);
        vm.prank(BOB); gold.transferFrom(ALICE, address(this), 5 ether);
        assertEq(gold.balanceOf(address(this)), 5 ether);
    }
    function test_safeDoubleOwnsTokensAndRequiresOwnerForCalls() public {
        JunkyardSafeDouble safe = new JunkyardSafeDouble(ALICE);
        JunkyardCollection nft = new JunkyardCollection(); nft.mint(address(safe), 1);
        gold.mint(address(safe), 10 ether);
        bytes memory callData = abi.encodeCall(gold.transfer, (BOB, 1 ether));
        vm.expectRevert(); safe.execute(address(gold), 0, callData);
        vm.prank(ALICE); safe.execute(address(gold), 0, callData);
        assertEq(gold.balanceOf(address(safe)), 9 ether); assertEq(nft.ownerOf(1), address(safe));
        vm.prank(ALICE); vm.expectRevert(); safe.execute(address(gold), 0, abi.encodeCall(gold.transfer, (BOB, 20 ether)));
        assertEq(gold.balanceOf(address(safe)), 9 ether);
    }
}
