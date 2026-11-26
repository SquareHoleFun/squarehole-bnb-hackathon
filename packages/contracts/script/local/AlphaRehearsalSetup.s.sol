// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {CoreV2LocalActions} from "./CoreV2LocalActions.sol";
import {LocalTwin} from "./LocalTwin.sol";
import {LocalV2Custody} from "./DeployCoreV2Local.s.sol";
import {AlphaLocalCustody} from "./AlphaLocalCustody.sol";
import {LocalERC20} from "./LocalQuoteMocks.sol";
import {TestETH} from "../../src/test-coins/TestETH.sol";
import {TestGold, TestUSDC, TestNVDA, TestPEPE} from "../../src/test-coins/TestCoins.sol";
import {TestPairLiquidity} from "../../src/test-coins/TestPairLiquidity.sol";
import {TestPoolLiquidity} from "../../src/test-coins/TestPoolLiquidity.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IERC20} from "v4-core/lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {BoxFactoryV2} from "../../src/box-v2/BoxFactoryV2.sol";
import {BoxClones} from "../../src/box/libraries/BoxClones.sol";
import {BoxSpec} from "../../src/box-v2/interfaces/SpecTypes.sol";
import {IListingRegistry, ListingClass, ListingRecord} from "../../src/box-v2/interfaces/IListingRegistry.sol";

/// @notice Local alpha fixtures. Real money contracts; only custody and the unused CoW service are doubles.
contract AlphaRehearsalSetup is Script, CoreV2LocalActions {
    struct Assets { address teth; address gold; address usdc; address nvda; address pepe; address pairs; address nativePools; }

    function _local() private {
        LocalTwin.checkAlpha(block.chainid, abi.decode(vm.rpc("web3_clientVersion", "[]"), (string)));
    }

    function runAssets(address manager) external returns (Assets memory a) {
        _local();
        a = _assets(manager, msg.sender);
        console.log(string.concat("ALPHA|assets|", vm.toString(abi.encode(a))));
    }

    function _assets(address manager, address owner) internal returns (Assets memory a) {
        require(block.chainid == 31337, "alpha local only");
        vm.startBroadcast(owner);
        a.teth = address(new TestETH(owner));
        a.gold = address(new TestGold(owner, 1_000_000 ether));
        a.usdc = address(new TestUSDC(owner, 1_000_000e6));
        a.nvda = address(new TestNVDA(owner, 1_000_000 ether));
        a.pepe = address(new TestPEPE(owner, 1_000_000_000 ether));
        a.pairs = address(new TestPairLiquidity(IPoolManager(manager), owner));
        a.nativePools = address(new TestPoolLiquidity(IPoolManager(manager), owner));
        vm.stopBroadcast();
    }

    function runListing(address factory, address teth) external returns (uint32 id) {
        _local(); id = _listing(factory, teth, msg.sender);
        console.log("ALPHA|listing|", uint256(id));
    }

    /// @notice Local rehearsal of an owner-configured server admitting one approved tester.
    function runAdmission(address teth, address admitter, address tester) external {
        _local(); _admission(teth, msg.sender, admitter, tester);
    }

    function _admission(address teth, address owner, address admitter, address tester) internal {
        require(block.chainid == 31337, "alpha local only");
        vm.startBroadcast(owner);
        TestETH(teth).setAdmitter(admitter, 1);
        vm.stopBroadcast();
        vm.startBroadcast(admitter);
        TestETH(teth).admitOne(tester);
        vm.stopBroadcast();
    }

    function _listing(address factory, address teth, address owner) internal returns (uint32 id) {
        require(block.chainid == 31337, "alpha local only");
        IListingRegistry listings = IListingRegistry(BoxFactoryV2(factory).listingRegistry());
        vm.startBroadcast(owner);
        AlphaLocalCustody(payable(listings.lister())).updateLocalRaise(listings, 0, 0.1 ether);
        require(IERC20(teth).transfer(listings.lister(), 10_000));
        id = LocalV2Custody(payable(listings.lister())).listPriceCoin(listings, LocalERC20(teth), ListingClass.OTHER, 1 ether);
        vm.stopBroadcast();
    }

    function runPools(Assets memory a) external { _local(); _pools(a, msg.sender); }

    function _pools(Assets memory a, address owner) internal {
        require(block.chainid == 31337, "alpha local only");
        vm.startBroadcast(owner);
        _pair(a, a.gold, 1000 ether, 1000 ether);
        _pair(a, a.usdc, 1000 ether, 100_000e6);
        _pair(a, a.nvda, 1000 ether, 100_000 ether);
        _pair(a, a.pepe, 200 ether, 200_000_000 ether);
        // Recorded TA-30 / alpha-plan depth, not a new live-chain observation. Retained pools only.
        _native(a, a.gold, uint160(1 << 96), 1 ether);
        _native(a, a.pepe, uint160(1000 * (1 << 96)), 1_000_000 ether);
        vm.stopBroadcast();
    }

    function _pair(Assets memory a, address coin, uint256 teth, uint256 other) private {
        require(IERC20(a.teth).approve(a.pairs, teth));
        require(IERC20(coin).approve(a.pairs, other));
        TestPairLiquidity(a.pairs).seed(TestPairLiquidity.Seed(a.teth, coin, teth, other, block.timestamp + 1 hours));
        require(IERC20(a.teth).approve(a.pairs, 0));
        require(IERC20(coin).approve(a.pairs, 0));
    }

    function _native(Assets memory a, address coin, uint160 price, uint256 other) private {
        require(IERC20(coin).approve(a.nativePools, other));
        TestPoolLiquidity(a.nativePools).seed{value: 1 ether}(TestPoolLiquidity.Seed(
            coin, price, -887220, 887220, 1 ether, other, block.timestamp + 1 hours));
        require(IERC20(coin).approve(a.nativePools, 0));
    }

    function runBox(address factory, uint32 listingId, uint32 openAt) external returns (address box) {
        _local(); box = _box(factory, listingId, openAt, msg.sender);
        console.log(string.concat("ALPHA|box|", vm.toString(box)));
    }

    function _box(address factory, uint32 listingId, uint32 openAt, address actor) internal returns (address box) {
        require(block.chainid == 31337, "alpha local only");
        localFactory = BoxFactoryV2(factory); localActor = actor;
        BoxSpec memory s = _localSpec(0);
        s.pricing.listingId = listingId;
        ListingRecord memory listing = IListingRegistry(localFactory.listingRegistry()).listing(listingId);
        s.pricing.token = listing.token; s.raise = listing.raise; s.creatorBuy = s.raise / 100;
        s.openAt = openAt;
        s.tokenName = listingId == 0 ? "Alpha ETH Box" : "Alpha tETH Box";
        s.tokenSymbol = listingId == 0 ? "AETH" : "ATETH";
        (bytes32 cs, bytes32 hs) = _salts(s);
        uint256 payment = localFactory.boxQParameters(listingId, s.raise).bootstrapQ + s.creatorBuy;
        vm.startBroadcast(actor);
        if (listingId != 0) require(IERC20(listing.token).approve(factory, payment));
        box = _createLocalBox(s, cs, hs, listingId == 0 ? payment : 0);
        if (listingId != 0) require(IERC20(listing.token).approve(factory, 0));
        vm.stopBroadcast();
    }

    function _salts(BoxSpec memory s) private view returns (bytes32 cs, bytes32 hs) {
        address predicted; bytes32 initHash;
        for (uint256 i;; ++i) {
            address t; cs = bytes32(i);
            (predicted, t, initHash) = localFactory.predictBox(localActor, s, cs);
            if (t > s.pricing.token && t < localFactory.tokenAddressLimit(s.pricing.token)) break;
        }
        for (uint256 i;; ++i) {
            hs = bytes32(i); address h = BoxClones.predict(predicted, hs, initHash);
            if (uint160(h) & 0x3fff == 0x2ae0 && uint160(h) >> 152 != 0x91) break;
        }
    }
}
