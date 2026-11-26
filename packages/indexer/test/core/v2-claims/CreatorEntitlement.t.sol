// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReceiverFixture, ReceiverRefuser} from "test/box-v2/cq11-b/ReceiverFixture.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {IBoxReceiverV2} from "src/box-v2/interfaces/IBoxReceiverV2.sol";
import {RoyaltyDestination} from "src/box/interfaces/BoxTypes.sol";
import {CreatorEntitlementV2} from "../../../src/core/v2/CreatorEntitlementV2.sol";

contract CreatorEntitlementTest is ReceiverFixture {
    uint256 constant CAP = 4 * uint256(uint128(type(int128).max));

    function setUp() public override {
        super.setUp();
        r = _receiver(1, 1, uint8(RoyaltyDestination.Creator), address(p), true);
    }

    // Mirrors the RPC code override and eth_call's discarded state, using the default-profile artifact.
    function _quote() private returns (uint256 amount) {
        uint256 snapshot = vm.snapshotState();
        vm.etch(PAYEE, vm.getDeployedCode("CreatorEntitlementV2.sol:CreatorEntitlementV2"));
        uint256 pmBefore = r.q() == address(0) ? address(pm).balance : p.balanceOf(address(pm));
        amount = CreatorEntitlementV2(PAYEE).quote{gas: 5_000_000}(address(r), r.q());
        assertEq(r.q() == address(0) ? address(pm).balance : p.balanceOf(address(pm)), pmBefore);
        assertTrue(vm.revertToState(snapshot));
    }

    function _refusal(string memory key, bytes4 expected) private {
        uint256 balance = _balance(address(r));
        uint256 creator = r.creatorP();
        uint256 royalty = r.royaltyHeldP();
        address asset = r.q();
        vm.prank(PAYEE);
        (bool ok, bytes memory data) = address(r).call(abi.encodeCall(r.claimCreator, (asset, PAYEE)));
        assertFalse(ok);
        assertEq(bytes4(data), expected);
        assertEq(_balance(address(r)), balance);
        assertEq(r.creatorP(), creator);
        assertEq(r.royaltyHeldP(), royalty);
        emit log_named_bytes(key, abi.encode(PAYEE, address(r), r.q(), data));
    }

    function test_nativeRefusalRetainsLazyRoyaltyAndRedirects() public {
        r = _receiver(1, 1, uint8(RoyaltyDestination.Creator), address(0), true);
        vm.etch(PAYEE, address(new ReceiverRefuser()).code);
        _royalty(address(0), 1234);
        coord.setGraduated();
        (uint256 owed, uint256 held) = r.creatorOwed(address(0));
        assertEq(owed + held, 0);
        _refusal("native", CustomRevert.WrappedError.selector);
        assertEq(_quote(), 1234);
        assertFalse(r.graduationSettled());
        assertEq(r.royaltyHeldP(), 1234);
        uint256 beforeP = address(0xB0B).balance;
        vm.recordLogs();
        vm.prank(PAYEE);
        assertEq(r.claimCreator(address(0), address(0xB0B)), 1234);
        emit log_named_bytes("redirected", abi.encode(vm.getRecordedLogs()));
        assertEq(address(0xB0B).balance - beforeP, 1234);
        assertEq(_quote(), 0);
    }

    function test_pausedTokenQuotesLazyFeesAndCarryThenPays() public {
        r = _receiver(1, 1, uint8(RoyaltyDestination.FeeHandling), address(p), true);
        _fees(14, 0);
        r.collect(address(0));
        _royalty(address(p), 1);
        coord.setGraduated();
        p.setPaused(true);
        _refusal("paused", CustomRevert.WrappedError.selector);
        assertEq(_quote(), 10);
        assertFalse(r.graduationSettled());
        p.setPaused(false);
        vm.prank(PAYEE);
        assertEq(r.claimCreator(address(p), PAYEE), 10);
        assertEq(p.balanceOf(PAYEE), 10);
    }

    function test_blocklistedAndInexactTokenKeepEntitlement() public {
        _royalty(address(p), 1500);
        coord.setGraduated();
        p.setBlocked(PAYEE, true);
        _refusal("blocked", CustomRevert.WrappedError.selector);
        assertEq(_quote(), 1500);
        p.setBlocked(PAYEE, false);
        p.setFeeBps(100);
        _refusal("inexact", IBoxReceiverV2.TransferNotExact.selector);
        assertEq(_quote(), 1500);
        p.setFeeBps(0);
        vm.prank(PAYEE);
        assertEq(r.claimCreator(address(p), PAYEE), 1500);
    }

    function test_quoteClipsDeficitLikeRealReceiver() public {
        _royalty(address(p), 1500);
        vm.prank(address(r));
        pm.transfer(address(0xB0B), uint160(address(p)), 600);
        coord.setGraduated();
        assertEq(_quote(), 900);
        vm.prank(PAYEE);
        assertEq(r.claimCreator(address(p), PAYEE), 900);
        assertEq(_balance(address(r)), 0);
    }

    function testFuzz_quoteMatchesBoundedPayout(uint256 raw, bool settled) public {
        uint256 amount = bound(raw, 0, CAP * 2 + 17);
        p.mint(address(this), amount);
        p.approve(address(r), amount);
        r.fundRoyalty(address(p), amount);
        if (settled) coord.graduation(r); else coord.setGraduated();
        uint256 expected = amount > CAP ? CAP : amount;
        assertEq(_quote(), expected);
        vm.prank(PAYEE);
        assertEq(r.claimCreator(address(p), PAYEE), expected);
        assertEq(p.balanceOf(PAYEE), expected);
        assertEq(r.creatorP(), amount - expected);
        assertEq(_balance(address(r)), amount - expected);
    }

    function test_refusedLargeBalanceQuotesOnlyNextFourParts() public {
        _royalty(address(p), CAP + 7);
        coord.setGraduated();
        p.setPaused(true);
        assertEq(_quote(), CAP);
        assertEq(r.royaltyHeldP(), CAP + 7);
        p.setPaused(false);
        vm.prank(PAYEE);
        assertEq(r.claimCreator(address(p), PAYEE), CAP);
        assertEq(_quote(), 7);
        vm.prank(PAYEE);
        assertEq(r.claimCreator(address(p), PAYEE), 7);
        assertEq(p.balanceOf(PAYEE), CAP + 7);
        assertEq(_balance(address(r)), 0);
    }

    function test_quoteStillEnforcesPayeeAndPhase() public {
        _royalty(address(p), 10);
        vm.etch(PAYEE, vm.getDeployedCode("CreatorEntitlementV2.sol:CreatorEntitlementV2"));
        vm.expectRevert();
        CreatorEntitlementV2(PAYEE).quote(address(r), address(p));
        coord.setGraduated();
        CreatorEntitlementV2 stranger = new CreatorEntitlementV2();
        vm.expectRevert();
        stranger.quote(address(r), address(p));
        coord.setFailed();
        vm.expectRevert();
        CreatorEntitlementV2(PAYEE).quote(address(r), address(p));
    }
}
