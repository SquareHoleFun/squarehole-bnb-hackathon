// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ShopFixture} from "../m2-32/ShopFixture.sol";
import {IShopVaultV2, ShopConfigV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";

/// Direct clone admission bypasses the spec validator; only the coordinator is a local double.
contract ShopAdmissionTest is ShopFixture {
    function initializeConfig(ShopConfigV2 memory cfg) external {
        IShopVaultV2 candidate = IShopVaultV2(BoxClones.create(BoxClones.initCode(implementation,
            abi.encodePacked(address(coord), address(token), LOADER, abi.encode(cfg)))));
        coord.wire(CREATOR, address(token), address(candidate), LOADER, address(pm));
        vm.prank(address(coord)); candidate.initialize();
        assertEq(candidate.seedReady(), cfg.seedT == 0); assertEq(candidate.budgetT(), 0); assertEq(candidate.inside(), 0);
        coord.wire(CREATOR, address(token), address(shop), LOADER, address(pm));
    }

    function _refuse(ShopConfigV2 memory cfg) private {
        uint256 beforeT = token.balanceOf(CREATOR);
        vm.expectRevert(IShopVaultV2.InvalidRequest.selector); this.initializeConfig(cfg);
        assertEq(token.balanceOf(CREATOR), beforeT);
        assertEq(coord.vault(), address(shop)); // all initialization writes rolled back
        assertEq(shop.budgetT(), 0);
    }

    function test_zeroSmallSeedAndEmptyListRefusedBeforeCustody() public {
        config.seedT = 0; _refuse(config);
        config.seedT = 1; _refuse(config);
        config.seedT = 19; _refuse(config); // two cheapest initially listed gives
        config.seedT = 20; this.initializeConfig(config);
        config.collections = new address[](0); config.tiers = new uint8[](0);
        config.seedT = type(uint256).max; _refuse(config);
    }

    function test_onlyInitiallyListedTiersSetTheMinimum() public {
        for (uint256 i; i < config.tiers.length; ++i) config.tiers[i] = 3;
        config.tiers[4] = 2;
        config.seedT = 99; _refuse(config); // tier 0 is cheaper but is not accepted
        config.seedT = 100; this.initializeConfig(config);
    }

    function test_initialCollectionMustHaveUsableERC721Code() public {
        config.collections = new address[](1); config.tiers = new uint8[](1);
        config.collections[0] = address(0x721); _refuse(config);
        config.collections[0] = address(nfts[0]);
        vm.mockCall(address(nfts[0]), abi.encodeWithSignature("supportsInterface(bytes4)", bytes4(0x80ac58cd)), abi.encode(false));
        _refuse(config);
    }

    function test_unrepresentableRequiredSeedIsRefused() public {
        uint256 price = type(uint256).max / 2 + 1;
        config.givePricesT = [price, price + 1, price + 2, price + 3];
        config.seedT = type(uint256).max; _refuse(config);
    }

    function test_fullWidthPriceAndSeedDoNotOverflow() public {
        uint256 price = type(uint256).max / 10000 + 1;
        config.givePricesT = [price, price + 1, price + 2, price + 3];
        uint256 required = price * 2;
        config.seedT = required - 1; _refuse(config);
        config.seedT = required; this.initializeConfig(config);
        config.seedT = type(uint256).max; this.initializeConfig(config);
    }

    function testFuzz_twoGiveBoundary(uint128 rawPrice, uint8 preset) public {
        uint256 price = uint256(rawPrice) + 1;
        config.collectionBps = [uint16(100), 250, 500][preset % 3];
        config.givePricesT = [price, price + 1, price + 2, price + 3];
        uint256 required = price * 2;
        config.seedT = required - 1; _refuse(config);
        config.seedT = required; this.initializeConfig(config);
    }
}
