// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FactoryLife} from "../kit/FactoryLife.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {IBoxCoordinatorV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";

contract InboxClaimViewsTest is FactoryLife {
    function test_RR_LateCreatorNative() public { _creator(true, 77); }
    function test_RR_LateCreatorERC20() public { _creator(false, 77); }
    function test_RR_LateCreatorNativeEmptyControl() public { _creator(true, 0); }
    function test_RR_LateCreatorERC20EmptyControl() public { _creator(false, 0); }
    function test_RR_lastHolderNative() public { _holder(true, 77); }
    function test_RR_lastHolderERC20() public { _holder(false, 77); }
    function test_RR_lastHolderNativeEmptyControl() public { _holder(true, 0); }
    function test_RR_lastHolderERC20EmptyControl() public { _holder(false, 0); }

    function _priced(bool native) private returns (HostileToken p) {
        if (native) _start(_spec());
        else {
            BoxSpec memory s;
            (s, p) = _priceSpec(1, 2, 6);
            _start(s);
        }
    }

    function _fund(bool native, HostileToken p, uint256 amount) private {
        if (native) vm.deal(box.royaltyRouter(), amount);
        else p.mint(box.royaltyRouter(), amount);
    }

    function _creator(bool native, uint256 pending) private {
        HostileToken p = _priced(native);
        vm.warp(box.deadline()); box.fail();
        uint256 first = box.quoteClaim(0);
        vm.prank(CREATOR); assertEq(box.claim(0, CREATOR), first);
        _fund(native, p, pending);
        if (native && pending != 0) assertEq(box.quoteClaim(0), pending);
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(left, 0); assertEq(pot, pending, "late inbox P reopens the creator view");
        if (pending == 0) {
            vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector); box.quoteClaim(0);
            vm.prank(CREATOR); vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector); box.claim(0, CREATOR);
        } else {
            assertEq(box.quoteClaim(0), pending);
            vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector); box.claim(0, address(this));
            vm.prank(CREATOR); assertEq(box.claim(0, CREATOR), pending);
            (pot,) = box.claimState(); assertEq(pot, 0);
            vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector); box.quoteClaim(0);
        }
    }

    function _holder(bool native, uint256 pending) private {
        HostileToken p = _priced(native);
        _buy(box.raise() / 5);
        vm.warp(box.deadline()); box.fail();
        (uint256 pot, uint256 left) = box.claimState();
        // The last share belongs to any holder, not necessarily the original buyer.
        address holder = address(0xA11CE);
        vm.prank(address(buyer)); token.transfer(holder, left);
        _fund(native, p, pending);
        uint256 quoted = box.quoteClaim(left);
        assertEq(quoted, pot + pending, "last share previews the claim's inbox intake");
        vm.startPrank(holder); token.approve(address(box), left);
        assertEq(box.claim(left, holder), quoted); vm.stopPrank();
        (pot, left) = box.claimState(); assertEq(pot, 0); assertEq(left, 0);
        _fund(native, p, 77);
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector); box.quoteClaim(0);
    }
}
