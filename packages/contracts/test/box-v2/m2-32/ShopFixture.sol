// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {IShopVaultV2, ShopConfigV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {IBoxTokenV2, BoxTokenV2Args} from "../../../src/box-v2/interfaces/IBoxTokenV2.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolDriver} from "../kit/BoxV2TestBase.sol";

contract ShopCoordinator {
    address public creator;
    address public token;
    address public vault;
    address public starterSetLoader;
    address public poolManager;
    bool public graduated;
    bool public failed;
    bool public gateOpen;
    function wire(address c, address t, address v, address l, address pm) external {
        creator = c; token = t; vault = v; starterSetLoader = l; poolManager = pm;
    }
    function roleAddress(uint256 role) external view returns (address) { return role == 3 ? vault : address(0); }
    function phase(bool g, bool f, bool o) external { graduated = g; failed = f; gateOpen = o; }
}
contract ShopNFT {
    mapping(uint256 => address) public ownerOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    uint8 public mode; // 1 sticky, 2 reentry, 3 stipend sink, 4 giant revert
    address public target;
    bytes public data;
    function supportsInterface(bytes4 id) external pure returns (bool) { return id == 0x80ac58cd; }
    function mint(address to, uint256 id) external { require(ownerOf[id] == address(0)); ownerOf[id] = to; }
    function seize(uint256 id, address to) external { ownerOf[id] = to; }
    function setApprovalForAll(address to, bool yes) external { isApprovedForAll[msg.sender][to] = yes; }
    function hostile(uint8 m, address t, bytes calldata d) external { mode = m; target = t; data = d; }
    function transferFrom(address from, address to, uint256 id) public {
        require(ownerOf[id] == from && (msg.sender == from || isApprovedForAll[from][msg.sender]), "owner/approval");
        if (mode == 1) return;
        if (mode == 3) { assembly { invalid() } }
        if (mode == 4) { assembly { revert(0, 65536) } }
        ownerOf[id] = to;
        if (mode == 2) { (bool ok,) = target.call(data); require(ok, "reentry"); }
    }
    function safeTransferFrom(address from, address to, uint256 id) external {
        transferFrom(from, to, id);
        if (to.code.length != 0) {
            (bool ok, bytes memory ret) = to.call(abi.encodeWithSignature(
                "onERC721Received(address,address,uint256,bytes)", msg.sender, from, id, bytes("")));
            require(ok && abi.decode(ret, (bytes4)) == 0x150b7a02, "receiver");
        }
    }
}
abstract contract ShopFixture is Test {
    address internal constant CREATOR = address(0xC123);
    address internal constant ALICE = address(0xA11CE);
    address internal constant CURATOR = address(0xC0);
    address internal constant LOADER = address(0x10AD);
    IShopVaultV2 internal shop;
    IBoxTokenV2 internal token;
    ShopCoordinator internal coord;
    ShopNFT[5] internal nfts;
    IPoolManager internal pm;
    PoolDriver internal driver;
    address internal coordinatorImpl;
    address internal implementation;
    ShopConfigV2 internal config;
    function setUp() public virtual {
        vm.warp(100 days);
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        driver = new PoolDriver(pm);
        coordinatorImpl = address(new ShopCoordinator());
        implementation = deployCode("ShopVaultV2.sol:ShopVaultV2", abi.encode(pm, coordinatorImpl));
        for (uint256 i; i < 5; ++i) nfts[i] = new ShopNFT();
        config.seedT = 10000;
        config.givePricesT = [uint256(10), 20, 50, 100];
        config.pickBps = 12500; config.weeklyBps = 1000; config.collectionBps = 250;
        config.listDelay = 7 days; config.curator = CURATOR;
        for (uint256 i; i < 5; ++i) { config.collections.push(address(nfts[i])); config.tiers.push(0); }
        _deploy(config);
    }
    function _deploy(ShopConfigV2 memory cfg) internal {
        coord = ShopCoordinator(BoxClones.create(BoxClones.initCode(coordinatorImpl, "")));
        // Token and shop refer to each other through their immutable predicted addresses.
        address tokenImpl = deployCode("BoxTokenV2.sol:BoxTokenV2", abi.encode(coordinatorImpl));
        address nextShop = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        token = IBoxTokenV2(BoxClones.create(BoxClones.initCode(tokenImpl,
            BoxTokenV2Args.encode(address(coord), nextShop, address(0), 1e30, "Shop", "SHOP"))));
        shop = IShopVaultV2(BoxClones.create(BoxClones.initCode(implementation,
            abi.encodePacked(address(coord), address(token), LOADER, abi.encode(cfg)))));
        require(address(shop) == nextShop, "prediction");
        coord.wire(CREATOR, address(token), address(shop), LOADER, address(pm));
        vm.prank(address(coord)); token.initialize();
        vm.prank(address(coord)); token.transfer(CREATOR, 1e20);
        vm.prank(address(coord)); token.transfer(ALICE, 1e20);
        vm.prank(address(coord)); token.transfer(address(driver), 1e20);
        vm.prank(address(coord)); shop.initialize();
        vm.prank(CREATOR); token.approve(address(shop), type(uint256).max);
        vm.prank(ALICE); token.approve(address(shop), type(uint256).max);
        for (uint256 i; i < 5; ++i) {
            vm.prank(CREATOR); nfts[i].setApprovalForAll(address(shop), true);
            vm.prank(ALICE); nfts[i].setApprovalForAll(address(shop), true);
        }
    }
    function _fund() internal { shop.fundSeed(); }
    function _open() internal {
        coord.phase(true, false, true);
        vm.prank(address(coord)); shop.openGate();
        vm.warp(block.timestamp + config.listDelay);
    }
    function _fail() internal { coord.phase(false, true, false); vm.prank(address(coord)); shop.enterFailure(); }
    function _load(uint256 id) internal {
        nfts[0].mint(CREATOR, id); vm.prank(LOADER); shop.loadStarter(address(nfts[0]), id, 0);
    }
    function _give(uint256 col, uint256 id) internal {
        nfts[col].mint(ALICE, id); vm.prank(ALICE); shop.give(address(nfts[col]), id, 0);
    }
}
