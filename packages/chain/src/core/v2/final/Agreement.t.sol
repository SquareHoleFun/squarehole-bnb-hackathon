// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReceiverFixture} from "test/box-v2/cq11-b/ReceiverFixture.sol";
import {RoyaltyDestination} from "src/box/interfaces/BoxTypes.sol";
import {M244Base} from "test/box-v2/m2-44/Fixture.sol";

contract FinalCreatorAgreementTest is ReceiverFixture {
    uint256 constant CAP = 4 * uint256(uint128(type(int128).max));

    function test_lazyCreatorRoyaltyHasAnImmediateExitDespiteZeroView() public {
        r = _receiver(1, 1, uint8(RoyaltyDestination.Creator), address(p), true);
        _royalty(address(p), 1234);
        coord.setGraduated();
        (uint256 owed, uint256 held) = r.creatorOwed(address(p));
        assertEq(owed + held, 0);
        vm.prank(PAYEE);
        assertEq(r.claimCreator(address(p), PAYEE), 1234);
        assertEq(p.balanceOf(PAYEE), 1234);
        assertEq(_balance(address(r)), 0);
    }

    function test_nextCreatorPaymentIsBoundedAndTailRemainsPayable() public {
        r = _receiver(1, 1, uint8(RoyaltyDestination.Creator), address(p), true);
        _royalty(address(p), CAP + 7);
        coord.graduation(r);
        (uint256 owed,) = r.creatorOwed(address(p));
        assertEq(owed, CAP + 7);
        vm.prank(PAYEE);
        assertEq(r.claimCreator(address(p), PAYEE), CAP);
        assertEq(p.balanceOf(PAYEE) + _balance(address(r)), CAP + 7);
        vm.prank(PAYEE);
        assertEq(r.claimCreator(address(p), PAYEE), 7);
        assertEq(p.balanceOf(PAYEE), CAP + 7);
        assertEq(_balance(address(r)), 0);
    }
}

contract FinalShopAgreementTest is M244Base {
    // Linked to production transactionGas(shopReturn, 30000) in keeper.test.ts.
    uint256 constant KEEPER_RETURN_FLOOR = 2_000_000;

    function _failedStarter() private {
        _createShop(0, 1000 ether, true, false);
        _page(0, 10);
        vm.warp(box.openAt() + 14 days);
        box.failClosed();
    }

    function test_INT_PINS_keeperFloorMustReturnAnAvailableStarter() public {
        _failedStarter();
        uint256[] memory indexes = new uint256[](1);
        (bool ok, bytes memory data) = address(shop).call{gas: KEEPER_RETURN_FLOOR}(
            abi.encodeCall(shop.returnStarter, (indexes))
        );
        assertTrue(ok, "a low-gas no-op still returns success");
        assertEq(abi.decode(data, (uint256)), 1, "available NFT must leave custody");
        assertEq(nft.ownerOf(0), CREATOR);
    }

    function test_measuredTwoMillionEnvelopeReturnsOnceWithoutChangingFailureMoney() public {
        _failedStarter();
        (uint256 pot, uint256 left) = box.claimState();
        uint256[] memory indexes = new uint256[](1);
        (bool ok, bytes memory data) = address(shop).call{gas: 2_000_000}(
            abi.encodeCall(shop.returnStarter, (indexes))
        );
        assertTrue(ok);
        assertEq(abi.decode(data, (uint256)), 1);
        assertEq(nft.ownerOf(0), CREATOR);
        assertEq(shop.returnStarter(indexes), 0);
        (uint256 afterPot, uint256 afterLeft) = box.claimState();
        assertEq(afterPot, pot);
        assertEq(afterLeft, left);
    }
}
