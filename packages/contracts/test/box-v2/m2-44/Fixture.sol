// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M234Base} from "../m2-34/Fixture.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {IBoxHookV2, TradeBatchV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IHolderLedgerV2} from "../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {IShopVaultV2, IStarterSetLoaderV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {HostileCollection} from "../kit/m2/ShopDoubles.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {PoolDriver} from "../kit/BoxV2TestBase.sol";

/// Factory-created M2 parts throughout. Fault tests explicitly replace only the failing dependency's code.
abstract contract M244Base is M234Base {
    address internal constant ALICE = address(0xA11CE);
    IShopVaultV2 internal shop;
    IStarterSetLoaderV2 internal loader;
    IHolderLedgerV2 internal ledger;
    HostileCollection internal nft;
    bytes32[11] internal suffix;

    function _createShop(uint8 decimals, uint256 seed, bool starter, bool complete) internal {
        nft = new HostileCollection();
        if (starter) {
            for (uint256 i = 10; i != 0;) {
                --i;
                suffix[i] = keccak256(abi.encode(address(nft), i, uint8(0), suffix[i + 1]));
                nft.mint(CREATOR, i);
            }
        }
        BoxSpec memory s = _shop(address(nft), suffix[0], starter ? 10 : 0, seed);
        if (decimals != 0) {
            (BoxSpec memory priced,) = _priceSpec(3, 3, decimals);
            s.pricing = priced.pricing;
            s.raise = priced.raise;
            s.creatorBuy = s.raise / 100;
        }
        box = _create(s);
        token = BoxTokenV2(box.token());
        hook = IBoxHookV2(box.hook());
        receiver = IBoxReceiverV2(box.receiver());
        shop = IShopVaultV2(box.vault());
        loader = IStarterSetLoaderV2(box.starterSetLoader());
        ledger = IHolderLedgerV2(box.roleAddress(17));
        layout = BoxLayoutV2.curve(s.raise, false);
        buyer = new PoolDriver(pm);
        if (decimals == 0) vm.deal(address(buyer), s.raise * 10);
        else HostileToken(s.pricing.token).mint(address(buyer), s.raise * 10);
        vm.startPrank(CREATOR);
        token.approve(address(shop), seed);
        nft.setApprovalForAll(address(shop), true);
        vm.stopPrank();
        if (seed != 0) shop.fundSeed();
        if (complete) {
            if (starter) _page(0, 10);
            loader.complete();
            vm.warp(box.effectiveOpenAt() + 384);
            vm.roll(block.number + 1);
        }
    }

    function _page(uint256 start, uint256 count) internal {
        address[] memory collections = new address[](count);
        uint256[] memory ids = new uint256[](count);
        uint8[] memory tiers = new uint8[](count);
        for (uint256 i; i < count; ++i) { collections[i] = address(nft); ids[i] = start + i; }
        vm.prank(CREATOR);
        loader.load(collections, ids, tiers, suffix[start + count]);
    }

    function _trade() internal {
        (, uint256 bought) = _buy(box.raise() / 10);
        buyer.swap(hook.poolKey(), false, bought / 4, layout.sqrtPriceStartX96);
        assertEq(hook.saleFeesPending(), 0, "curve T fees do not mint P");
    }

    function _claimT(address holder) internal returns (uint256 paid) {
        uint256 amount = token.balanceOf(holder);
        vm.startPrank(holder);
        token.approve(address(box), amount);
        paid = box.claim(amount, holder);
        vm.stopPrank();
    }

    function _assertOutstanding() internal view {
        (, uint256 left) = box.claimState();
        assertEq(left, token.balanceOf(CREATOR) + token.balanceOf(ALICE) + token.balanceOf(address(buyer)),
            "all and only circulating T can still be handed in");
    }

    function _pClaims(address holder) internal view returns (uint256) {
        return pm.balanceOf(holder, uint160(box.q()));
    }
}
