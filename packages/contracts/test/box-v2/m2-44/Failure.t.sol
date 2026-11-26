// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M234Base} from "../m2-34/Fixture.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IShopVaultV2, IStarterSetLoaderV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {HostileCollection} from "../kit/m2/ShopDoubles.sol";
import {PoolDriver} from "../kit/BoxV2TestBase.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

contract M244FailureTest is M234Base {
    function test_failedShopLedgerTokenBurnsLiquidAndClaimsWithoutCreatingPotRights() public {
        BoxSpec memory s = _shop(address(new HostileCollection()), 0, 0, 1000 ether);
        box = _create(s);
        token = BoxTokenV2(box.token());
        hook = IBoxHookV2(box.hook());
        receiver = IBoxReceiverV2(box.receiver());
        IShopVaultV2 shop = IShopVaultV2(box.vault());
        vm.prank(CREATOR);
        token.approve(address(shop), 1000 ether);
        shop.fundSeed();
        // Claims have real backing deposited by a holder, not injected balances.
        buyer = new PoolDriver(pm);
        vm.prank(CREATOR);
        token.transfer(address(buyer), 100 ether);
        buyer.mintClaims(Currency.wrap(address(token)), address(shop), 100 ether);
        vm.warp(box.openAt() + 14 days);
        box.failClosed();
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(left, token.balanceOf(CREATOR), "only creator's circulating T can claim");
        assertEq(shop.failedT(), 1100 ether);
        uint256 supply = token.totalSupply();
        uint256 creatorT = token.balanceOf(CREATOR);
        assertEq(shop.burnFailedT(), 1100 ether, "both frozen balances must have a burn exit");
        assertEq(shop.failedT(), 0);
        assertEq(token.totalSupply(), supply - 1100 ether);
        assertEq(token.balanceOf(CREATOR), creatorT, "excluded seed never returns");
        (uint256 afterPot, uint256 afterLeft) = box.claimState();
        assertEq(afterPot, pot);
        assertEq(afterLeft, left, "burn cannot reprice the pot");
        assertEq(shop.burnFailedT(), 0);
    }
}
