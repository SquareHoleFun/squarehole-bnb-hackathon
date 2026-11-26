// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {ItemClaimModel} from "./ItemClaimModel.sol";
import {ItemHistoryModel} from "./ItemHistoryModel.sol";
import {HostileToken} from "../kit/HostileToken.sol";

contract M300ClaimsTest is Test {
    ItemHistoryModel h; ItemClaimModel m; HostileToken p;
    address constant ALICE = address(0xA11CE);
    function setUp() public {
        p = new HostileToken("Price","P",6); h = new ItemHistoryModel(4,1,0);
        m = new ItemClaimModel(h,address(p)); h.graduate(); h.pick(1,ALICE);
    }
    function fund(uint256 amount) internal { h.fund(1,2,0,amount*4); m.sync(32); p.mint(address(m),amount*4); }
    function ids() internal pure returns (uint256[] memory a) { a = new uint256[](1); a[0] = 1; }
    function test_F127_removedPushPreservesOwnerCredit() public {
        fund(1000);
        (bool ok,) = address(m).call(abi.encodeWithSignature("claimFor(uint256[])", ids()));
        assertFalse(ok, "F127 removes pushed payouts");
        (uint256 credit,) = m.itemCredit(1); assertEq(credit,1000);
        assertEq(p.balanceOf(ALICE),0); assertEq(p.balanceOf(address(this)),0);
    }
    function test_S4_ownerHasNoMinimumOrTipAndStrangersCannotClaim() public {
        fund(1); vm.expectRevert(); m.claim(ids(),ALICE);
        vm.prank(ALICE); assertEq(m.claim(ids(),ALICE),1);
        fund(1000); vm.prank(ALICE); assertEq(m.claim(ids(),ALICE),1000);
        assertEq(p.balanceOf(ALICE),1001); assertEq(p.balanceOf(address(this)),0);
        assertEq(m.accounted(),h.ledgerTransferred());
        vm.prank(ALICE); vm.expectRevert(); m.claim(ids(),ALICE);
    }
    function test_S4_pausedAndBlockedPKeepCreditWithoutExpiry() public {
        fund(100); p.setBlocked(ALICE,true);
        vm.prank(ALICE); vm.expectRevert(); m.claim(ids(),ALICE);
        (uint256 credit,) = m.itemCredit(1); assertEq(credit,100);
        p.setBlocked(ALICE,false); p.setPaused(true);
        vm.prank(ALICE); vm.expectRevert(); m.claim(ids(),ALICE);
        (credit,) = m.itemCredit(1); assertEq(credit,100);
        vm.warp(block.timestamp + 3650 days); p.setPaused(false);
        vm.prank(ALICE); assertEq(m.claim(ids(),ALICE),100);
        assertEq(m.accounted(),h.ledgerTransferred());
    }
    function test_S4_ownerContract7702DuplicatesVaultAndReentry() public {
        fund(100); vm.etch(ALICE,hex"00");
        vm.prank(ALICE); assertEq(m.claim(ids(),ALICE),100);
        vm.etch(ALICE,abi.encodePacked(hex"ef0100",address(0xD311))); fund(100);
        vm.prank(ALICE); assertEq(m.claim(ids(),ALICE),100);
        fund(100); uint256[] memory twice = new uint256[](2); twice[0] = 1; twice[1] = 1;
        vm.prank(ALICE); vm.expectRevert(); m.claim(twice,ALICE);
        vm.prank(ALICE); vm.expectRevert(); m.claim(ids(),address(h));
        vm.prank(ALICE); vm.expectRevert(); m.claim(ids(),address(0));
        p.armReentry(address(m),abi.encodeCall(m.claim,(ids(),ALICE)));
        vm.prank(ALICE); vm.expectRevert(); m.claim(ids(),ALICE);
        (uint256 c,) = m.itemCredit(1); assertEq(c,100);
        p.armReentry(address(0),""); vm.prank(ALICE); assertEq(m.claim(ids(),ALICE),100);
    }
    function test_S4_cappedExhaustionAndLowGasPreserveCredit() public {
        h = new ItemHistoryModel(1,1,0); m = new ItemClaimModel(h,address(0));
        h.graduate(); h.pick(1,ALICE); h.fund(1,2,0,100); m.sync(32); vm.deal(address(m),100);
        address sink = address(new ClaimGasSink());
        vm.prank(ALICE); vm.expectRevert(); m.claim(ids(),sink);
        (uint256 c,) = m.itemCredit(1); assertEq(c,100); assertEq(address(m).balance,100);
        vm.prank(ALICE); (bool ok,) = address(m).call{gas:200_000}(abi.encodeCall(m.claim,(ids(),ALICE)));
        assertFalse(ok); (c,) = m.itemCredit(1); assertEq(c,100);
        vm.prank(ALICE); assertEq(m.claim(ids(),ALICE),100);
    }
    function test_S4_inexactTransferRollsBackAndCanRetry() public {
        fund(100); p.setFeeBps(100);
        vm.prank(ALICE); vm.expectRevert(); m.claim(ids(),ALICE);
        assertEq(p.balanceOf(ALICE),0); assertEq(p.balanceOf(address(m)),400);
        (uint256 c,) = m.itemCredit(1); assertEq(c,100);
        p.setFeeBps(0); vm.prank(ALICE); assertEq(m.claim(ids(),ALICE),100);
    }
    function test_S4_singleUnitNativePayout() public {
        h = new ItemHistoryModel(1,1,0); m = new ItemClaimModel(h,address(0));
        h.graduate(); h.pick(1,ALICE); m.sync(32);
        vm.prank(ALICE); vm.expectRevert(); m.claim(ids(),ALICE);
        h.fund(1,2,0,1); m.sync(32); vm.deal(address(m),1);
        vm.prank(ALICE); assertEq(m.claim(ids(),ALICE),1); assertEq(ALICE.balance,1);
    }
}

contract ClaimGasSink { receive() external payable { assembly ("memory-safe") { for {} 1 {} {} } } }
