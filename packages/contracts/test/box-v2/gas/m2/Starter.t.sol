// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IBoxToken} from "../../../../src/box/interfaces/IBoxToken.sol";
import {StarterGasTest} from "../../m2-33/Gas.t.sol";
import {M260Measure} from "./Measure.sol";
import {HostileCollection} from "../../kit/m2/ShopDoubles.sol";
import {BoxSpec} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {ShopConfigV2, IShopVaultV2, IStarterSetLoaderV2} from "../../../../src/box-v2/interfaces/IShopVaultV2.sol";

/// Reuse the real loader/shop/coordinator cold 10,000-item, 313-page custody proof.
/// Its hook/router/receiver are explicitly lifecycle doubles; loading never trades or moves T.
contract M260StarterHistoryTest is StarterGasTest {}

contract M260StarterDistinctTest is M260Measure {
    function test_largestBatch32DistinctColdCollections() public {
        address[] memory collections = new address[](32);
        uint256[] memory ids = new uint256[](32); uint8[] memory tiers = new uint8[](32);
        bytes32 root;
        for (uint256 i = 32; i != 0;) {
            --i; HostileCollection collection = new HostileCollection(); collections[i] = address(collection); ids[i] = 1;
            collection.mint(CREATOR, 1);
            root = keccak256(abi.encode(collections[i], uint256(1), uint8(0), root));
        }
        BoxSpec memory s = _shop(collections[0], root, 32, 40 ether);
        ShopConfigV2 memory cfg = abi.decode(s.contentsParams, (ShopConfigV2));
        cfg.collections = collections; cfg.tiers = tiers; s.contentsParams = abi.encode(cfg);
        box = _create(s); shop = IShopVaultV2(box.vault()); loader = IStarterSetLoaderV2(box.starterSetLoader());
        IBoxToken t = IBoxToken(box.token());
        vm.prank(CREATOR); t.approve(address(shop), 40 ether); shop.fundSeed();
        for (uint256 i; i < 32; ++i) {
            vm.prank(CREATOR); HostileCollection(collections[i]).setApprovalForAll(address(shop), true);
            vm.cool(collections[i]);
        }
        _measure("load 32 distinct cold collections", address(loader), CREATOR,
            abi.encodeCall(loader.load, (collections, ids, tiers, bytes32(0))), 49500000);
        assertEq(shop.inside(), 32); assertFalse(box.gateOpen());
        _measure("complete starter gate", address(loader), address(this), abi.encodeCall(loader.complete, ()), 2000000);
        assertTrue(box.gateOpen());
    }
}
