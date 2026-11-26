// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "v4-core/lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {Math} from "v4-core/lib/openzeppelin-contracts/contracts/utils/math/Math.sol";
import {BoxFactoryV2} from "../../src/box-v2/BoxFactoryV2.sol";
import {BoxCoordinatorV2} from "../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxClones} from "../../src/box/libraries/BoxClones.sol";
import {BoxSpec} from "../../src/box-v2/interfaces/SpecTypes.sol";
import {FeeModuleDirectoryV21} from "../../src/box-v2/FeeModuleDirectoryV21.sol";
import {IFeeModulesV21} from "../../src/box-v2/interfaces/IFeeModulesV21.sol";
import {IListingRegistry, ListingClass, ListingRecord} from "../../src/box-v2/interfaces/IListingRegistry.sol";
import {ListingRegistry} from "../../src/box-v2/ListingRegistry.sol";
import {AlchemistFeeModuleV21} from "../../src/box-v2/modules/AlchemistFeeModuleV21.sol";
import {AlchemistHopV21} from "../../src/box-v2/modules/AlchemistRouteV21.sol";
import {TestGold, TestUSDC, TestNVDA, TestPEPE} from "../../src/test-coins/TestCoins.sol";
import {TestETH} from "../../src/test-coins/TestETH.sol";
import {TestPairLiquidity} from "../../src/test-coins/TestPairLiquidity.sol";
import {TestPoolLiquidity} from "../../src/test-coins/TestPoolLiquidity.sol";
import {PriceLimitSwapper} from "../../test/research/hookgas/HookGasKit.sol";
import {CoreV2LocalActions} from "../local/CoreV2LocalActions.sol";
import {LocalERC20} from "../local/LocalQuoteMocks.sol";
import {BnbTestnet, BnbTestnetCustody} from "./BnbTestnet.sol";


/// @notice Steps 3 to 8 of the BNB Chain test network deployment (chain 97), each its own call so a run can stop and
/// go on between them: the test coins, the converter routes and their registration (the one-day clock), the listings,
/// the pool helpers, the pools, the faucet coin's public phase. `runBox` and `runTrade` are the rehearsal's proof that
/// the release is wired (a box created, bought into, filled and graduated). Signed by the configured Foundry sender, who
/// owns both holding contracts; this file reads no key.
/// Steps 4, 5, 7 and 8 can run again after a stop in the middle: each reads first what is already on chain (a
/// registered route, a listing, a seeded pool, the open faucet) and sends only what is missing.
/// Prices are fixture prices for test stand-ins, not market quotes: 1 BNB = 4 tNVDA = 0.25 tGOLD; 1 tETH = 100 tUSDC =
/// 100 tNVDA = 1 tGOLD = 1,000,000 tPEPE (the Sepolia alpha's depths); 1 tNVDA = 1 tUSDC.
contract BnbTestnetSetup is Script, CoreV2LocalActions {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    struct Coins { address usdc; address nvda; address gold; address pepe; address teth; }
    struct Routes { address nvdaFromBnb; address goldFromBnb; address nvdaFromUsdc; }
    struct Helpers { address pairs; address nativePools; }
    struct RouteSpec { address tokenIn; address tokenOut; uint256 cap; uint256 dust; address trigger; }
    struct Raises { uint256 native; uint256 usdc; uint256 nvda; uint256 gold; uint256 pepe; uint256 teth; }

    /// @notice Converter caps and dust (raw units of the route's input coin). Dust stays far below one cent and
    /// 2 * dust < cap, as RegisterAlchemistV21 asks of every registration.
    uint256 internal constant BNB_INPUT_CAP = 10 ether;
    uint256 internal constant BNB_DUST = 1_000;
    uint256 internal constant USDC_INPUT_CAP = 100_000e6;
    uint256 internal constant USDC_DUST = 10;
    /// @notice sqrt(raw coin per wei) * 2**96, exact: 4 tNVDA per BNB (sqrt 4 = 2) and 0.25 tGOLD per BNB (sqrt 1/4 = 1/2).
    uint160 internal constant NVDA_PER_BNB_SQRT_X96 = 2 << 96;
    uint160 internal constant GOLD_PER_BNB_SQRT_X96 = 1 << 95;

    // ---- Step 3: the test coins (one issuance each to the deployer; no faucet, mint or issuer rights).

    function runCoins() external returns (Coins memory k) {
        BnbTestnet.check(block.chainid);
        vm.startBroadcast(msg.sender);
        k.usdc = address(new TestUSDC(msg.sender, 1_000_000_000e6));
        k.nvda = address(new TestNVDA(msg.sender, 1_000_000 ether));
        k.gold = address(new TestGold(msg.sender, 1_000_000 ether));
        k.pepe = address(new TestPEPE(msg.sender, 1_000_000_000_000 ether));
        // The test-coin page's faucet coin, as on Sepolia: closed until the `faucet` step opens its public phase.
        k.teth = address(new TestETH(msg.sender));
        vm.stopBroadcast();
        console.log(string.concat("BNB|coins|", vm.toString(abi.encode(k))));
    }

    // ---- Step 4: the converter routes, deployed and registered in the release's fee-module directory. A
    // registration becomes selectable one day after its block (FeeModuleDirectoryV21.DELAY): run this early.

    /// @param which bit 0: BNB to tNVDA, bit 1: BNB to tGOLD, bit 2: tUSDC to tNVDA (7 = all three). A later call can
    /// add the others; each registration has its own one-day clock. A route already registered in the directory (same
    /// coins, trigger, release, manager, hop, cap and dust) is taken as it is: never a second module or registration.
    /// @param candidates modules a stopped earlier attempt of this step created (from its recorded nonces): one that
    /// matches and is not registered yet is registered instead of creating another.
    function runRoutes(address factory, Coins memory k, address trigger, uint8 which, address[] memory candidates)
        external returns (Routes memory m)
    {
        BnbTestnet.check(block.chainid);
        BoxFactoryV2 f = BoxFactoryV2(factory);
        (,, address directory) = IFeeModulesV21(f.implementation(5)).receiverCode();
        BnbTestnetCustody lister = BnbTestnetCustody(payable(FeeModuleDirectoryV21(directory).lister()));
        require(lister.getOwners()[0] == msg.sender && !FeeModuleDirectoryV21(directory).renounced(), "lister");
        require(trigger != address(0) && which != 0 && which < 8, "trigger and routes");
        vm.startBroadcast(msg.sender);
        if (which & 1 != 0) {
            m.nvdaFromBnb = _route(f, lister, directory,
                RouteSpec(address(0), k.nvda, BNB_INPUT_CAP, BNB_DUST, trigger), candidates);
        }
        if (which & 2 != 0) {
            m.goldFromBnb = _route(f, lister, directory,
                RouteSpec(address(0), k.gold, BNB_INPUT_CAP, BNB_DUST, trigger), candidates);
        }
        if (which & 4 != 0) {
            m.nvdaFromUsdc = _route(f, lister, directory,
                RouteSpec(k.usdc, k.nvda, USDC_INPUT_CAP, USDC_DUST, trigger), candidates);
        }
        vm.stopBroadcast();
        console.log(string.concat("BNB|routes|", vm.toString(abi.encode(m))));
        console.log(string.concat("BNB|directory|", vm.toString(directory)));
    }

    /// @dev One hop through a hookless 0.3% pool (tick spacing 60) in the release's own PoolManager, registered right
    /// after its creation.
    function _route(BoxFactoryV2 f, BnbTestnetCustody lister, address directory, RouteSpec memory r,
        address[] memory candidates) private returns (address module)
    {
        module = _registeredRoute(f, directory, r);
        if (module != address(0)) return module;
        for (uint256 i; i < candidates.length && module == address(0); ++i) {
            if (candidates[i].code.length != 0 && _sameRoute(f, candidates[i], r)) module = candidates[i];
        }
        if (module == address(0)) {
            address manager = f.poolManager();
            AlchemistHopV21[] memory route = new AlchemistHopV21[](1);
            route[0] = AlchemistHopV21(4, r.tokenIn, r.tokenOut, manager, 3000, 60);
            bytes memory code = bytes.concat(vm.getCode("AlchemistFeeModuleV21.sol:AlchemistFeeModuleV21"),
                abi.encode(IPoolManager(manager), f.implementation(5), f.implementation(0), route, r.cap, r.dust, r.trigger));
            assembly ("memory-safe") { module := create(0, add(code, 32), mload(code)) }
            require(module.code.length != 0 && _sameRoute(f, module, r), "route deployment");
        }
        lister.execute(directory, 0, abi.encodeCall(FeeModuleDirectoryV21.register, (module)));
    }

    /// @dev The directory row of a converter with exactly these settings for this release, or zero.
    function _registeredRoute(BoxFactoryV2 f, address directory, RouteSpec memory r) private view returns (address) {
        FeeModuleDirectoryV21 d = FeeModuleDirectoryV21(directory);
        uint256 count = d.count();
        for (uint32 id; id < count; ++id) {
            (address module,,, bool withdrawn) = d.record(id);
            if (!withdrawn && _sameRoute(f, module, r)) return module;
        }
        return address(0);
    }

    function _sameRoute(BoxFactoryV2 f, address module, RouteSpec memory r) private view returns (bool) {
        // The release's own modules have no pileCoin(): their call fails and they never match.
        (bool ok, bytes memory out) = module.staticcall(abi.encodeWithSignature("pileCoin()"));
        if (!ok || out.length != 32 || abi.decode(out, (address)) != r.tokenOut) return false;
        AlchemistFeeModuleV21 a = AlchemistFeeModuleV21(module);
        if (a.priceCoin() != r.tokenIn || a.conversionTrigger() != r.trigger || a.inputCap() != r.cap
            || a.dustMax() != r.dust || a.receiverImplementation() != f.implementation(5)
            || a.coordinatorImplementation() != f.implementation(0) || address(a.poolManager()) != f.poolManager()) {
            return false;
        }
        return _sameHop(a, f.poolManager(), r);
    }

    function _sameHop(AlchemistFeeModuleV21 a, address manager, RouteSpec memory r) private view returns (bool) {
        if (a.executor().length() != 1) return false;
        AlchemistHopV21 memory h = a.executor().hop(0);
        return h.kind == 4 && h.tokenIn == r.tokenIn && h.tokenOut == r.tokenOut && h.pool == manager
            && h.fee == 3000 && h.tickSpacing == 60;
    }

    // ---- Step 5: the listings. The native row's raise is lowered for future boxes; each coin enters with its class.
    // The lister's admission probe moves 10,000 raw units, so the deployer first hands the holding contract that much.

    function runListings(address factory, Coins memory k, Raises memory r) external {
        BnbTestnet.check(block.chainid);
        IListingRegistry listings = IListingRegistry(BoxFactoryV2(factory).listingRegistry());
        BnbTestnetCustody lister = BnbTestnetCustody(payable(listings.lister()));
        require(lister.getOwners()[0] == msg.sender, "lister");
        // Row 0: only the one change from the release's initial native raise to the target; any other value stops.
        uint256 native = listings.listing(0).raise;
        require(native == r.native || native == ListingRegistry(address(listings)).RAISE_ETH(), "native raise changed by someone");
        vm.startBroadcast(msg.sender);
        if (native != r.native) {
            lister.execute(address(listings), 0, abi.encodeCall(IListingRegistry.updateRaise, (0, r.native)));
        }
        _list(listings, lister, k.usdc, ListingClass.STABLE, r.usdc, 1);
        _list(listings, lister, k.nvda, ListingClass.STOCK, r.nvda, 2);
        _list(listings, lister, k.gold, ListingClass.OTHER, r.gold, 3);
        _list(listings, lister, k.pepe, ListingClass.OTHER, r.pepe, 4);
        _list(listings, lister, k.teth, ListingClass.OTHER, r.teth, 5);
        vm.stopBroadcast();
        console.log(string.concat("BNB|listings|", vm.toString(address(listings))));
    }

    function _list(IListingRegistry listings, BnbTestnetCustody lister, address coin, ListingClass class, uint256 raise,
        uint32 expected) private
    {
        uint32 count = listings.listingCount();
        for (uint32 i; i < count; ++i) {
            ListingRecord memory row = listings.listing(i);
            if (row.token == coin) {
                require(i == expected && row.class == class && row.raise == raise, "listed with other settings");
                return;
            }
        }
        require(count == expected, "listings out of order");
        if (IERC20(coin).balanceOf(address(lister)) < 10_000) {
            require(IERC20(coin).transfer(address(lister), 10_000), "probe funds");
        }
        uint32 id = lister.listPriceCoin(listings, LocalERC20(coin), class, raise);
        require(id == expected, "unexpected listing id");
    }

    // ---- Step 6: the pool helpers (owned by the deployer; only they can seed or remove).

    /// @param recovered helpers a stopped earlier attempt of this step created (zero: none); each is checked (its manager
    /// and owner) and kept, so only a missing helper is created.
    function runHelpers(address manager, Helpers memory recovered) external returns (Helpers memory h) {
        BnbTestnet.check(block.chainid);
        if (recovered.pairs != address(0)) {
            TestPairLiquidity p = TestPairLiquidity(recovered.pairs);
            require(address(p.manager()) == manager && p.owner() == msg.sender && p.LOWER() == -887220, "recovered pair helper");
        }
        if (recovered.nativePools != address(0)) {
            TestPoolLiquidity n = TestPoolLiquidity(recovered.nativePools);
            require(address(n.manager()) == manager && n.owner() == msg.sender, "recovered native-pool helper");
        }
        h = recovered;
        vm.startBroadcast(msg.sender);
        if (h.pairs == address(0)) h.pairs = address(new TestPairLiquidity(IPoolManager(manager), msg.sender));
        if (h.nativePools == address(0)) h.nativePools = address(new TestPoolLiquidity(IPoolManager(manager), msg.sender));
        vm.stopBroadcast();
        console.log(string.concat("BNB|helpers|", vm.toString(abi.encode(h))));
    }

    // ---- Step 7: the pools. For the converter routes: BNB/tNVDA and BNB/tGOLD (native BNB, `bnbPerPool` wei each) and
    // tUSDC/tNVDA (`nvdaInPair` raw tNVDA, one tUSDC per tNVDA). For the test-coin page, as on Sepolia (the alpha's
    // recorded depths): each coin paired with tETH through the pair helper: 1,000 tETH with 100,000 tUSDC, 100,000 tNVDA,
    // 1,000 tGOLD; 200 tETH with 200,000,000 tPEPE. Full range, hookless, 0.3%, tick spacing 60.

    function runPools(Helpers memory h, Coins memory k, uint256 bnbPerPool, uint256 nvdaInPair) external {
        BnbTestnet.check(block.chainid);
        require(bnbPerPool > 0 && nvdaInPair > 0, "amounts");
        vm.startBroadcast(msg.sender);
        // 4 tNVDA and 0.25 tGOLD per BNB, with 1% room above the exact ratio; the helper pays at most the budgets.
        _native(h, k.nvda, NVDA_PER_BNB_SQRT_X96, bnbPerPool, bnbPerPool * 4 * 101 / 100);
        _native(h, k.gold, GOLD_PER_BNB_SQRT_X96, bnbPerPool, bnbPerPool * 101 / 400);
        _pair(h, k.nvda, k.usdc, nvdaInPair, nvdaInPair / 1e12);
        _pair(h, k.teth, k.usdc, 1000 ether, 100_000e6);
        _pair(h, k.teth, k.nvda, 1000 ether, 100_000 ether);
        _pair(h, k.teth, k.gold, 1000 ether, 1000 ether);
        _pair(h, k.teth, k.pepe, 200 ether, 200_000_000 ether);
        vm.stopBroadcast();
        console.log("BNB|pools|7");
    }

    // ---- Step 8: the faucet coin's public phase opens (anyone may drip one tETH a day, within its daily cap).

    function runFaucet(address teth) external {
        BnbTestnet.check(block.chainid);
        vm.startBroadcast(msg.sender);
        if (!TestETH(teth).open()) TestETH(teth).setOpen(true);
        vm.stopBroadcast();
        console.log(string.concat("BNB|faucet|", vm.toString(teth)));
    }

    /// @dev A pair already initialized must be at exactly the price this seed opens it at and hold the helper's
    /// position; one initialized without it (by anyone) stops the step. Allowances are set only when they differ and
    /// cleared whatever happened before (a stopped attempt may have left one).
    function _pair(Helpers memory h, address a, address b, uint256 amountA, uint256 amountB) private {
        TestPairLiquidity pairs = TestPairLiquidity(h.pairs);
        (uint160 current,,,) = pairs.manager().getSlot0(pairs.key(a, b).toId());
        if (current != 0) {
            require(current == pairPrice(a, b, amountA, amountB), "pair at another price");
            require(pairs.liquidity(a, b) != 0, "pair initialized without the helper's position");
        } else {
            _allow(a, h.pairs, amountA);
            _allow(b, h.pairs, amountB);
            pairs.seed(TestPairLiquidity.Seed(a, b, amountA, amountB, block.timestamp + 1 hours));
        }
        _clear(a, h.pairs);
        _clear(b, h.pairs);
    }

    /// @dev A native pool already initialized must be at exactly the stated price and hold the helper's full-range
    /// position (a seed initializes and adds in one transaction); otherwise the step stops.
    function _native(Helpers memory h, address coin, uint160 price, uint256 bnb, uint256 coinBudget) private {
        TestPoolLiquidity pools = TestPoolLiquidity(h.nativePools);
        PoolKey memory k = pools.key(coin);
        (uint160 current,,,) = pools.manager().getSlot0(k.toId());
        if (current != 0) {
            require(current == price, "native pool at another price");
            (uint128 held,,) = pools.manager().getPositionInfo(k.toId(), h.nativePools, -887220, 887220, bytes32(0));
            require(held != 0, "native pool initialized without the helper's position");
        } else {
            _allow(coin, h.nativePools, coinBudget);
            pools.seed{value: bnb}(
                TestPoolLiquidity.Seed(coin, price, -887220, 887220, bnb, coinBudget, block.timestamp + 1 hours));
        }
        _clear(coin, h.nativePools);
    }

    function _allow(address coin, address spender, uint256 amount) private {
        if (IERC20(coin).allowance(msg.sender, spender) != amount) {
            require(IERC20(coin).approve(spender, amount), "approve");
        }
    }

    function _clear(address coin, address spender) private {
        if (IERC20(coin).allowance(msg.sender, spender) != 0) require(IERC20(coin).approve(spender, 0), "clear");
    }

    /// @notice The price the pair helper opens a pool at for these budgets (its `_startingPrice`, coins sorted by
    /// address). Exact for every pair here except tNVDA/tETH: sqrt(1/10) * 2^96 is rounded down there, which opens the
    /// pool at 100.000000000000000000000000015 tNVDA per tETH.
    function pairPrice(address a, address b, uint256 amountA, uint256 amountB) public pure returns (uint160) {
        (uint256 amount0, uint256 amount1) = a < b ? (amountA, amountB) : (amountB, amountA);
        uint256 root = (amount1 >> 64) < amount0
            ? Math.sqrt(FullMath.mulDiv(amount1, uint256(1) << 192, amount0))
            : Math.sqrt(FullMath.mulDiv(amount1, uint256(1) << 128, amount0)) << 32;
        return uint160(root);
    }

    // ---- Rehearsal proof (anvil only): one box created (`runBox`), then bought into, sold from and filled to graduation
    // (`runTrade`), all through the release contracts. `listingId` 0 prices it in BNB; another id prices it in that
    // listed coin (the sender holds it).

    function runBox(address factory, address swapper, uint32 listingId) external returns (address box) {
        BnbTestnet.check(block.chainid);
        BnbTestnet.checkAnvil(_client());
        localFactory = BoxFactoryV2(factory);
        localSwapper = PriceLimitSwapper(payable(swapper));
        localActor = msg.sender;
        BoxSpec memory s = _localSpec(0);
        ListingRecord memory listing = IListingRegistry(localFactory.listingRegistry()).listing(listingId);
        s.pricing.listingId = listingId;
        s.pricing.token = listing.token;
        s.raise = listing.raise;
        s.creatorBuy = s.raise / 100;
        s.tokenName = listingId == 0 ? "Rehearsal BNB Box" : "Rehearsal Coin Box";
        s.tokenSymbol = listingId == 0 ? "RBNB" : "RCOIN";
        (bytes32 cs, bytes32 hs) = _salts(s);
        uint256 payment = localFactory.boxQParameters(listingId, s.raise).bootstrapQ + s.creatorBuy;
        vm.startBroadcast(msg.sender);
        if (listingId != 0) require(IERC20(listing.token).approve(factory, payment), "approve");
        box = _createLocalBox(s, cs, hs, listingId == 0 ? payment : 0);
        if (listingId != 0) require(IERC20(listing.token).approve(factory, 0), "clear");
        vm.stopBroadcast();
        console.log(string.concat("BNB|box|", vm.toString(box)));
    }

    /// @notice After the box's open time and launch window: buy a tenth of the raise, sell a quarter of it back, buy
    /// until the curve closes, press graduate, then buy and sell once more in the graduated pool.
    function runTrade(address box, address swapper) external {
        BnbTestnet.check(block.chainid);
        BnbTestnet.checkAnvil(_client());
        BoxCoordinatorV2 b = BoxCoordinatorV2(box);
        localSwapper = PriceLimitSwapper(payable(swapper));
        localActor = msg.sender;
        vm.startBroadcast(msg.sender);
        _tradeLocal(b);
        _fillLocal(b);
        b.graduate{gas: LOCAL_TX_GAS}();
        require(b.graduated(), "not graduated");
        _tradeLocal(b);
        vm.stopBroadcast();
        console.log(string.concat("BNB|traded|", vm.toString(box)));
    }

    /// @dev The node's `web3_clientVersion` (a test overrides it to pin the anvil-only refusal).
    function _client() internal virtual returns (string memory) {
        return abi.decode(vm.rpc("web3_clientVersion", "[]"), (string));
    }

    function _salts(BoxSpec memory s) private view returns (bytes32 cs, bytes32 hs) {
        address predicted;
        bytes32 initHash;
        for (uint256 i;; ++i) {
            address t;
            cs = bytes32(i);
            (predicted, t, initHash) = localFactory.predictBox(localActor, s, cs);
            if (t > s.pricing.token && t < localFactory.tokenAddressLimit(s.pricing.token)) break;
        }
        for (uint256 i;; ++i) {
            hs = bytes32(i);
            address h = BoxClones.predict(predicted, hs, initHash);
            if (uint160(h) & 0x3fff == 0x2ae0 && uint160(h) >> 152 != 0x91) break;
        }
    }
}
