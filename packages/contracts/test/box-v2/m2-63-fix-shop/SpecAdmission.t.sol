// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M210SpecTest} from "../m2-10/Spec.t.sol";
import {BoxSpec, AddOn} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {ShopConfigV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";

/// Both generated Solidity entry points, plus the complete inherited spec/parity suite.
contract ShopSpecAdmissionTest is M210SpecTest {
    function _checkConfig(ShopConfigV2 memory c, bool accepted) private view {
        BoxSpec memory s = shop(); s.contentsParams = abi.encode(c);
        s.addOns = new AddOn[](2); s.addOns[0] = AddOn(7, "");
        s.addOns[1] = AddOn(8, abi.encode(bytes32(0), uint32(0)));
        check(s, accepted ? 0 : 4, accepted ? 0 : 30);
    }

    function test_seedThresholdUsesOnlyInitialTiersAndAllCaps() public view {
        for (uint8 tier; tier < 4; ++tier) for (uint8 cap; cap < 3; ++cap) {
            ShopConfigV2 memory c = config(); c.tiers[0] = tier;
            c.collectionBps = [uint16(100), 250, 500][cap];
            uint256 needed = c.givePricesT[tier] * 2;
            c.seedT = needed - 1; _checkConfig(c, false);
            c.seedT = needed; _checkConfig(c, true);
        }
    }

    function test_zeroSeedAndNoInitialCollectionsRefused() public view {
        ShopConfigV2 memory c = config(); c.seedT = 0; _checkConfig(c, false);
        c.seedT = type(uint256).max; c.collections = new address[](0); c.tiers = new uint8[](0);
        _checkConfig(c, false);
    }

    function test_fullWidthSeedAndUnrepresentableThresholdNeverPanic() public view {
        ShopConfigV2 memory c = config();
        uint256 price = type(uint256).max / 10000 + 1;
        c.givePricesT = [price, price + 1, price + 2, price + 3];
        c.seedT = price * 2;
        _checkConfig(c, true); c.seedT -= 1; _checkConfig(c, false);
        price = type(uint256).max / 2 + 1;
        c.givePricesT = [price, price + 1, price + 2, price + 3];
        c.seedT = type(uint256).max; _checkConfig(c, false);
    }
}
