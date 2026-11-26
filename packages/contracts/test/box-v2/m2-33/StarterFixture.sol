// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {CoordinatorV2Config, BoxCoordinatorV2Args as A} from "../../../src/box-v2/libraries/BoxCoordinatorV2Args.sol";
import {M2SeamArgs} from "../../../src/box-v2/libraries/M2SeamArgs.sol";
import {IBoxTokenV2, BoxTokenV2Args} from "../../../src/box-v2/interfaces/IBoxTokenV2.sol";
import {IStarterSetLoaderV2, IShopVaultV2, ShopConfigV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {ChunkPart} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {HostileCollection} from "../kit/m2/ShopDoubles.sol";
import {ShopModel} from "../m2-00/ShopModel.sol";
import {PoolDriver} from "../kit/BoxV2TestBase.sol";

// Test-only hook/router/receiver lifecycle counterparts. No pool trading or fee-allocation proof.
contract StarterPart {
    uint256 public open;
    function setOpen(uint256 at) external { open = at; }
    fallback() external { assembly ("memory-safe") { mstore(0, 0) return(0, 128) } }
}

abstract contract StarterFixture is Test {
    address internal constant CREATOR = address(0xcafe);
    address internal constant OTHER = address(0xbeef);
    IPoolManager internal pm;
    PoolDriver internal driver;
    BoxCoordinatorV2 internal box;
    IShopVaultV2 internal shop;
    IStarterSetLoaderV2 internal loader;
    IBoxTokenV2 internal token;
    HostileCollection internal nft;
    HostileCollection internal second;
    ShopModel internal model;
    address internal loaderImpl;
    address internal shopImpl;
    bytes32[] internal suffix;
    bytes32[] internal modelSuffix;
    uint256[] internal itemIds;
    uint256 internal count;
    uint256 internal seed;

    // This coordinator factory fixture creates only SHOP vaults, never PILE.
    function isPileVault(address) external pure returns (bool) { return false; }

    function _make(uint256 n, uint256 seedT, bool chunks, uint32 open, bool duplicate) internal {
        vm.warp(1_000_000); count = n; seed = seedT;
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        driver = new PoolDriver(pm);
        address coordImpl = deployCode("BoxCoordinatorV2.sol:BoxCoordinatorV2", abi.encode(pm, address(this)));
        nft = new HostileCollection(); second = new HostileCollection();
        suffix = new bytes32[](n + 1); modelSuffix = new bytes32[](n + 1); itemIds = new uint256[](n);
        for (uint256 i = n; i != 0;) {
            --i; uint256 id = duplicate && i == 1 ? 1 : i + 1; itemIds[i] = id;
            suffix[i] = keccak256(abi.encode(address(nft), id, uint8(0), suffix[i + 1]));
            modelSuffix[i] = keccak256(abi.encode(address(0x721), id, uint8(0), modelSuffix[i + 1]));
            if (!duplicate || i != 1) nft.mint(CREATOR, id);
        }
        bytes memory nonces = new bytes(24);
        nonces[1] = 0x01; nonces[5] = 0x02; nonces[6] = 0x03; nonces[3] = 0x04; nonces[19] = 0x05;
        CoordinatorV2Config memory c;
        c.creator = CREATOR; c.raise = 1e18; c.deadlineDays = 30; c.openAt = open; c.nonces = bytes24(nonces);
        box = BoxCoordinatorV2(BoxClones.create(BoxClones.initCode(coordImpl, A.withShop(A.encode(c), true))));
        _deployParts(coordImpl, chunks);
        model = new ShopModel(CREATOR, address(this), seedT); model.commit(modelSuffix[0], uint32(n));
        if (!chunks) model.chunksReady();
    }
    function _deployParts(address coordImpl, bool chunks) private {
        bytes[] memory codes = _codes(coordImpl);
        bytes32 root = chunks ? keccak256(abi.encodePacked(hex"00", bytes32(0))) : bytes32(0);
        box.deploy(codes, type(StarterPart).creationCode, 0, 0, [root, bytes32(0)], [chunks ? uint256(1) : 0, uint256(0)]);
        box.launch();
        // Script initial user distribution; no real creator-buy execution is claimed here.
        vm.prank(address(box)); token.transfer(CREATOR, seed + 100);
        vm.prank(address(box)); token.transfer(address(driver), 40);
        vm.prank(CREATOR); nft.setApprovalForAll(address(shop), true);
        vm.prank(CREATOR); second.setApprovalForAll(address(shop), true);
    }
    function _codes(address coordImpl) private returns (bytes[] memory codes) {
        address t = vm.computeCreateAddress(address(box), 1);
        address s = vm.computeCreateAddress(address(box), 4);
        address l = vm.computeCreateAddress(address(box), 5);
        address tokenImpl = deployCode("BoxTokenV2.sol:BoxTokenV2", abi.encode(coordImpl));
        shopImpl = deployCode("ShopVaultV2.sol:ShopVaultV2", abi.encode(pm, coordImpl));
        loaderImpl = deployCode("StarterSetLoaderV2.sol:StarterSetLoaderV2", abi.encode(coordImpl));
        ShopConfigV2 memory cfg;
        cfg.seedT = seed; cfg.givePricesT = [uint256(10), 20, 50, 100];
        cfg.pickBps = 12500; cfg.weeklyBps = 1000; cfg.collectionBps = 250; cfg.listDelay = 7 days;
        cfg.collections = new address[](2); cfg.tiers = new uint8[](2);
        cfg.collections[0] = address(nft); cfg.collections[1] = address(second); cfg.tiers[1] = 3;
        codes = new bytes[](5);
        codes[0] = BoxClones.initCode(tokenImpl, BoxTokenV2Args.encode(address(box), s, address(0), 1e30, "Shop", "SHOP"));
        codes[1] = type(StarterPart).creationCode; codes[2] = type(StarterPart).creationCode;
        codes[3] = BoxClones.initCode(shopImpl, this.shopArgs(address(box), t, l, abi.encode(cfg)));
        codes[4] = BoxClones.initCode(loaderImpl, M2SeamArgs.starter(address(box), s, suffix[0], uint32(count)));
        shop = IShopVaultV2(s); token = IBoxTokenV2(t); loader = IStarterSetLoaderV2(l);
    }
    function shopArgs(address c, address t, address l, bytes calldata contents) external pure returns (bytes memory) {
        return M2SeamArgs.shop(c, t, l, contents);
    }
    function _args(uint256 start, uint256 n) internal view returns (address[] memory cs, uint256[] memory ids, uint8[] memory tiers) {
        cs = new address[](n); ids = new uint256[](n); tiers = new uint8[](n);
        for (uint256 i; i < n; ++i) { cs[i] = address(nft); ids[i] = itemIds[start + i]; }
    }
    function _page(uint256 start, uint256 n) internal {
        (address[] memory cs, uint256[] memory ids, uint8[] memory tiers) = _args(start, n);
        vm.prank(CREATOR); loader.load(cs, ids, tiers, suffix[start + n]);
        for (uint256 i; i < n; ++i) model.load(ids[i], modelSuffix[start + i + 1]);
        _assertProgress(start + n, false); _assertState();
    }
    function _seed() internal {
        vm.prank(CREATOR); token.approve(address(shop), seed);
        vm.prank(CREATOR); model.approveSeed(seed);
        shop.fundSeed(); model.fundSeed(); _assertState();
    }
    function _chunks() internal { box.loadChunk(ChunkPart.Table, hex"00", 0); model.chunksReady(); _assertState(); }
    function _complete() internal { vm.prank(OTHER); loader.complete(); model.complete(); _assertState(); }
    function _assertProgress(uint256 n, bool done) internal view {
        (uint32 loaded, bytes32 hash, bool notified) = loader.progress();
        assertEq(loaded, n); assertEq(hash, suffix[n]); assertEq(notified, done);
        assertEq(model.loaded(), n);
    }
    function _assertState() internal view {
        assertEq(shop.seedReady(), model.seedReady()); assertEq(shop.budgetT(), model.budgetT());
        assertEq(box.gateOpen(), model.open()); assertEq(shop.failedT(), model.excluded());
    }
    function loadPage(uint256 start, uint256 n) external { _page(start, n); }
}
