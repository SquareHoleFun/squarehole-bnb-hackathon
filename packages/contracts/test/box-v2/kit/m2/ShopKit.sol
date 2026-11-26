// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {HostileToken} from "../HostileToken.sol";
import {PoolDriver} from "../BoxV2TestBase.sol";
import {ShopModel} from "../../m2-00/ShopModel.sol";
import {ShopDouble, StarterLoaderDouble, ShopGateDouble, HostileCollection} from "./ShopDoubles.sol";

/// @dev TEST ONLY shop box and unchanged M2-00 oracle. Model uses its own canonical collection 0x721 hash;
/// actual loader uses the deployed collection, same ordered ids/tiers. Reduced and full-size inputs are explicit.
abstract contract ShopKit is Test {
    address internal constant CREATOR = address(0xcafe);
    ShopDouble internal shop; StarterLoaderDouble internal loader; ShopGateDouble internal gate;
    HostileCollection internal nft; HostileToken internal t; IPoolManager internal pm; PoolDriver internal driver;
    ShopModel internal shopModel; bytes32[] internal suffix; bytes32[] internal modelSuffix; uint256 internal seed;
    function _shopBox(uint256 count, uint256 seedT) internal {
        vm.warp(1_000_000); seed = seedT;
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        driver = new PoolDriver(pm); t = new HostileToken("Shop T", "T", 18); nft = new HostileCollection();
        gate = new ShopGateDouble(CREATOR, block.timestamp);
        shop = new ShopDouble(gate, t, pm, seedT);
        suffix = new bytes32[](count + 1); modelSuffix = new bytes32[](count + 1);
        for (uint256 i = count; i != 0;) {
            --i; nft.mint(CREATOR, i + 1);
            suffix[i] = keccak256(abi.encode(address(nft), i + 1, uint8(0), suffix[i + 1]));
            modelSuffix[i] = keccak256(abi.encode(address(0x721), i + 1, uint8(0), modelSuffix[i + 1]));
        }
        loader = new StarterLoaderDouble(gate, shop, suffix[0], uint32(count)); gate.wire(shop, address(loader));
        shopModel = new ShopModel(CREATOR, address(this), seedT); shopModel.commit(modelSuffix[0], uint32(count));
        t.mint(CREATOR, seedT); vm.prank(CREATOR); nft.setApprovalForAll(address(shop), true); _assertShop();
    }
    function _seed() internal {
        vm.prank(CREATOR); t.approve(address(shop), seed);
        vm.prank(CREATOR); shopModel.approveSeed(seed);
        shop.fundSeed(); shopModel.fundSeed(); _assertShop();
    }
    function _page(uint256 start, uint256 n) internal {
        address[] memory collections = new address[](n); uint256[] memory ids = new uint256[](n); uint8[] memory tiers = new uint8[](n);
        for (uint256 i; i < n; ++i) { collections[i] = address(nft); ids[i] = start + i + 1; }
        vm.prank(CREATOR); loader.load(collections, ids, tiers, suffix[start + n]);
        for (uint256 i; i < n; ++i) shopModel.load(start + i + 1, modelSuffix[start + i + 1]);
        _assertLoaded(start + n); _assertShop();
    }
    function _shopClaims(uint256 amount) internal {
        t.mint(address(driver), amount); driver.mintClaims(Currency.wrap(address(t)), address(shop), amount); shopModel.addClaims(amount);
    }
    function _assertShop() internal view {
        assertEq(shop.budgetT(), shopModel.budgetT()); assertEq(shop.seedReady(), shopModel.seedReady());
        assertEq(gate.gateOpen(), shopModel.open()); assertEq(shop.failedT(), shopModel.excluded());
    }
    function _assertLoaded(uint256 count) internal view {
        (uint32 n, bytes32 remaining,) = loader.progress(); assertEq(n, count); assertEq(shopModel.loaded(), count);
        assertEq(remaining, suffix[count]); assertEq(shop.starterCount(), count);
    }
}
