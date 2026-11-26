// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M244Base} from "../../m2-44/Fixture.sol";
import {M260CapDouble} from "../../gas/m2/CapDouble.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ShopLimitsV2 as L} from "../../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {ReleaseConstantsV2 as C} from "../../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";

/// Half-cap doubles preserve production code/custody; a failure is an open production 2x-margin property.
contract M263ShopCapFindingsTest is M244Base, M260CapDouble {
    function test_R02_productionLiquidBurnHasTwiceColdHeadroom() public { _headroom(0, false); }
    function test_R02_productionClaimsBurnHasTwiceColdHeadroom() public { _headroom(1, false); }
    function test_R02_productionNftReturnHasTwiceColdHeadroom() public { _headroom(2, false); }
    function test_R02_localLiquidBurnHasTwiceColdHeadroom() public { _headroom(0, true); }
    function test_R02_localClaimsBurnHasTwiceColdHeadroom() public { _headroom(1, true); }
    function test_R02_localNftReturnHasTwiceColdHeadroom() public { _headroom(2, true); }

    function _headroom(uint256 mode, bool proposed) private {
        _createShop(0, 1000 ether, true, false); _page(0, 10);
        vm.prank(CREATOR); token.transfer(address(buyer), 100 ether);
        buyer.mintClaims(Currency.wrap(address(token)), address(shop), 100 ether);
        vm.warp(box.openAt() + 14 days); box.failClosed();
        address implementation = release.implementations[21];
        if (proposed) _shopCaps(implementation, true);
        else _shopCaps(implementation, true);
        for (uint256 i; i < 24; ++i) {
            if (release.implementations[i] != address(0)) vm.cool(release.implementations[i]);
            if (box.roleAddress(i) != address(0)) vm.cool(box.roleAddress(i));
        }
        vm.cool(vm.computeCreateAddress(implementation, 1)); vm.cool(address(pm)); vm.cool(address(nft));
        if (mode == 2) {
            uint256[] memory indexes = new uint256[](1);
            assertEq(shop.returnStarter(indexes), 1, "NFT return must fit half stipend");
            assertEq(nft.ownerOf(0), CREATOR);
        } else {
            shop.burnFailedT();
            if (mode == 0) assertEq(token.balanceOf(address(shop)), 0, "liquid burn must fit half stipend");
            else assertEq(pm.balanceOf(address(shop), uint160(address(token))), 0, "claims burn must fit half stipend");
        }
    }
}
