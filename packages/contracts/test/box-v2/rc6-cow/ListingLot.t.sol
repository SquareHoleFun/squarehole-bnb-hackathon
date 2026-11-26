// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FactoryLife} from "../kit/FactoryLife.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxRoyaltyRouterV2} from "../../../src/box-v2/BoxRoyaltyRouterV2.sol";
import {ListingClass} from "../../../src/box-v2/interfaces/IListingRegistry.sol";

contract ListingLotTest is FactoryLife {
    function test_IN08_eachCoinLotAndListVersionCapturedAtCreation() public {
        HostileToken coin = new HostileToken("USDC", "USDC", 6);
        coin.mint(address(this), 10000); coin.approve(address(listings), 10000);
        uint32 id = listings.add(address(coin), ListingClass.STABLE, 2000e6);
        listings.setRoyaltyLot(id, 100e6);
        BoxSpec memory s = _spec();
        BoxRoyaltyRouterV2 first = BoxRoyaltyRouterV2(payable(_create(s).royaltyRouter()));
        assertEq(first.lotSize(address(coin)), 100e6);
        assertEq(first.lotSize(first.weth()), 0, "native P excludes WETH-as-P");
        assertEq(first.listVersion(), listings.sellableVersion());
        uint256 version = first.listVersion();
        assertEq(listings.sellableCount(version), 2);
        assertEq(listings.sellableToken(1), address(coin));
        listings.setRoyaltyLot(id, 200e6);
        assertEq(first.lotSize(address(coin)), 100e6);
        s.tokenName = "Next snapshot";
        BoxRoyaltyRouterV2 second = BoxRoyaltyRouterV2(payable(_create(s).royaltyRouter()));
        assertEq(second.lotSize(address(coin)), 200e6);
        assertGt(second.listVersion(), version);
        HostileToken later = new HostileToken("Later", "L", 18);
        later.mint(address(this), 10000); later.approve(address(listings), 10000);
        listings.add(address(later), ListingClass.OTHER, 1 ether);
        assertEq(first.lotSize(address(later)), 0);
        assertEq(listings.sellableCount(version), 2, "old enumeration never grows");
        vm.expectRevert(BoxRoyaltyRouterV2.NoOrder.selector); first.refreshOrder(address(later));
        vm.prank(CREATOR); vm.expectRevert(); listings.setRoyaltyLot(id, 1);
        vm.expectRevert(); listings.setRoyaltyLot(id, 0);
    }
    function test_IN08_wethFloorAndLotAreIndependentOfPricingCoin() public {
        (BoxSpec memory s,) = _priceSpec(1, 2, 6);
        listings.setRoyaltyLot(0, 1);
        BoxRoyaltyRouterV2 inbox = BoxRoyaltyRouterV2(payable(_create(s).royaltyRouter()));
        assertEq(inbox.lotSize(inbox.weth()), inbox.minimumLot());
        listings.setRoyaltyLot(0, 2 ether);
        assertEq(inbox.lotSize(inbox.weth()), inbox.minimumLot());
        assertEq(inbox.lotSize(inbox.token()), 0);
        assertEq(inbox.lotSize(s.pricing.token), 0);
    }
}
