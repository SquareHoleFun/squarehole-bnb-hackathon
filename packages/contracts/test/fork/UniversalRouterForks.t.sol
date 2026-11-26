// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IV4Router} from "v4-periphery/src/interfaces/IV4Router.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {IRewardLedger} from "../../src/interfaces/IRewardLedger.sol";
import {SquareHoleClaimConverter} from "../../src/SquareHoleClaimConverter.sol";
import {SquareHoleHook} from "../../src/SquareHoleHook.sol";
import {SquareHoleLauncher} from "../../src/SquareHoleLauncher.sol";
import {SquareHoleRegistry} from "../../src/SquareHoleRegistry.sol";
import {MockTetherUSD} from "../../src/testnet/MockTetherUSD.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {MockERC20} from "../utils/MockTokens.sol";
import {StepRouter} from "../utils/v4/Routers.sol";
import {ForkBase, IPermit2Allowance, IUniversalRouter, IWETH9} from "./ForkTests.t.sol";

/// @notice Real Universal Router deployments, driven with encoded V4_SWAP commands (SWAP_EXACT_IN_SINGLE /
/// SWAP_EXACT_OUT_SINGLE → SETTLE_ALL → TAKE_ALL) and paid through the real Permit2 with exact, expiring allowances.
/// Each router is tried with the current v4-periphery parameter layout (with `minHopPriceX36`) and the earlier one;
/// the accepted layout is logged, and the OTHER layout is then sent explicitly and must revert (review round B), for
/// exact in and exact out, on these ERC-20/ERC-20 pools. Every swap is checked for fee attribution: one receipt,
/// exactly the pool's fee growth (buys in Q, sells in T), indexed at the swap to the prior holders, the trader earning
/// none of its own fee.
abstract contract UniversalRouterForkBase is ForkBase {
    using StateLibrary for IPoolManager;

    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    bytes internal constant V4_SWAP = hex"10";

    struct LegacyExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    struct LegacyExactOutputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountOut;
        uint128 amountInMaximum;
        bytes hookData;
    }

    struct SwapOutcome {
        uint256 gasUsed;
        bool legacyLayout;
        uint256 paid;
        uint256 received;
    }

    struct Books {
        uint256 receipts;
        uint256 qReceived;
        uint256 tReceived;
        uint256 qGrowth;
        uint256 tGrowth;
        uint256 holdersClaimable;
        uint256 qHolders;
    }

    address internal dave = makeAddr("dave");
    /// @dev Trade-size unit of the router matrix in raw Q (0: 1 whole 18-decimal Q, or 100 whole 6-decimal Q). F10
    /// suites set it so a matrix delivers about as many NFTs as the B2 matrix (e.g. 0.1 WETH for 10,000 NFTs).
    uint256 internal matrixQUnit;

    function _qUnit(address q) internal view returns (uint256) {
        if (matrixQUnit != 0) return matrixQUnit;
        return _decimals(q) == 18 ? 1e18 : 100 * 10 ** _decimals(q);
    }

    /*//////////////////////////////////////////////////////////////
                            ROUTER PLUMBING
    //////////////////////////////////////////////////////////////*/

    /// @dev Exact Permit2 allowance for `ur` (token → Permit2 exact approval, USDT-style reset first).
    function _permit(address token, address owner, address ur, uint256 amount) internal {
        _approveExact(token, owner, PERMIT2, amount);
        vm.prank(owner);
        // forge-lint: disable-next-line(unsafe-typecast)
        IPermit2Allowance(PERMIT2).approve(token, ur, uint160(amount), uint48(block.timestamp + 600));
    }

    function _execute(address ur, address trader, bytes memory actions, bytes[] memory params)
        internal
        returns (bool ok, uint256 gasUsed)
    {
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        vm.prank(trader);
        try IUniversalRouter(ur).execute(V4_SWAP, inputs, block.timestamp + 60) {
            ok = true;
            gasUsed = vm.lastCallGas().gasTotalUsed;
        } catch {}
    }

    /// Exact-input single swap `amountIn` of `cin` → `cout` on `key` through `ur`.
    function _urExactIn(
        address ur,
        address trader,
        PoolKey memory key,
        bool zeroForOne,
        address cin,
        address cout,
        uint256 amountIn
    ) internal returns (SwapOutcome memory o) {
        uint256 inBefore = _balance(cin, trader);
        uint256 outBefore = _balance(cout, trader);
        _permit(cin, trader, ur, amountIn);
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[1] = abi.encode(Currency.wrap(cin), amountIn);
        params[2] = abi.encode(Currency.wrap(cout), uint256(1));
        // forge-lint: disable-next-line(unsafe-typecast)
        params[0] = abi.encode(IV4Router.ExactInputSingleParams(key, zeroForOne, uint128(amountIn), 1, 0, ""));
        bool ok;
        (ok, o.gasUsed) = _execute(ur, trader, actions, params);
        if (!ok) {
            // forge-lint: disable-next-line(unsafe-typecast)
            params[0] = abi.encode(LegacyExactInputSingleParams(key, zeroForOne, uint128(amountIn), 1, ""));
            (ok, o.gasUsed) = _execute(ur, trader, actions, params);
            o.legacyLayout = true;
        }
        require(ok, "router refused both ExactInputSingleParams layouts");
        o.paid = inBefore - _balance(cin, trader);
        o.received = _balance(cout, trader) - outBefore;
    }

    /// Exact-output single swap: exactly `amountOut` of `cout` for at most `maxIn` of `cin`.
    function _urExactOut(
        address ur,
        address trader,
        PoolKey memory key,
        bool zeroForOne,
        address cin,
        address cout,
        uint256 amountOut,
        uint256 maxIn
    ) internal returns (SwapOutcome memory o) {
        uint256 inBefore = _balance(cin, trader);
        uint256 outBefore = _balance(cout, trader);
        _permit(cin, trader, ur, maxIn);
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_OUT_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[1] = abi.encode(Currency.wrap(cin), maxIn);
        params[2] = abi.encode(Currency.wrap(cout), amountOut);
        params[0] = abi.encode(
            // forge-lint: disable-next-line(unsafe-typecast)
            IV4Router.ExactOutputSingleParams(key, zeroForOne, uint128(amountOut), uint128(maxIn), 0, "")
        );
        bool ok;
        (ok, o.gasUsed) = _execute(ur, trader, actions, params);
        if (!ok) {
            params[0] = abi.encode(
                // forge-lint: disable-next-line(unsafe-typecast)
                LegacyExactOutputSingleParams(key, zeroForOne, uint128(amountOut), uint128(maxIn), "")
            );
            (ok, o.gasUsed) = _execute(ur, trader, actions, params);
            o.legacyLayout = true;
        }
        require(ok, "router refused both ExactOutputSingleParams layouts");
        o.paid = inBefore - _balance(cin, trader);
        o.received = _balance(cout, trader) - outBefore;
    }

    /*//////////////////////////////////////////////////////////////
                         FEE ATTRIBUTION CHECKS
    //////////////////////////////////////////////////////////////*/

    function _books(Launch memory L, address h1, address h2) internal view returns (Books memory b) {
        b.receipts = L.collector.receiptCount();
        b.qReceived = L.collector.totalQReceived();
        b.tReceived = L.collector.totalTReceived();
        (b.tGrowth, b.qGrowth) = _feeGrowthInside(L);
        b.holdersClaimable = L.ledger.claimable(h1) + L.ledger.claimable(h2);
        b.qHolders = L.collector.totalQHolders();
    }

    /// A buy through the router: one receipt in Q only, equal to the pool's fee growth × L (3% of the input within
    /// 2 wei at protocol fee 0), indexed to the prior holders at the swap, none of it to the buyer.
    function _assertBuyAttribution(
        Launch memory L,
        Books memory b0,
        address h1,
        address h2,
        address buyer,
        uint256 paid
    ) internal view {
        Books memory b1 = _books(L, h1, h2);
        assertEq(b1.receipts, b0.receipts + 1, "one fee event per router swap");
        assertEq(b1.tReceived, b0.tReceived, "a buy has no T fee");
        uint256 qFee = b1.qReceived - b0.qReceived;
        assertEq(qFee, FullMath.mulDiv(b1.qGrowth - b0.qGrowth, L.r.liquidity, Q128), "receipt == pool fee growth");
        assertApproxEqAbs(qFee, paid * 3 / 100, 2 + paid / 1e12, "3% of the router's input");
        uint256 holderQ = b1.qHolders - b0.qHolders;
        assertApproxEqAbs(b1.holdersClaimable - b0.holdersClaimable, holderQ, 2, "indexed at the swap to prior holders");
        assertEq(L.ledger.claimable(buyer), 0, "the buyer earns none of its own fee");
        assertEq(L.ledger.bootstrapQ(), 0);
        assertEq(L.ledger.poolNetOutflow(), 0);
    }

    /// A sell through the router: one T-only receipt equal to the pool's fee growth × L, pending burn.
    function _assertSellAttribution(Launch memory L, Books memory b0, address h1, address h2) internal view {
        Books memory b1 = _books(L, h1, h2);
        assertEq(b1.receipts, b0.receipts + 1, "one fee event per router swap");
        assertEq(b1.qReceived, b0.qReceived, "a sell creates no Q (ECO-10)");
        uint256 tFee = b1.tReceived - b0.tReceived;
        assertGt(tFee, 0);
        assertEq(tFee, FullMath.mulDiv(b1.tGrowth - b0.tGrowth, L.r.liquidity, Q128), "T receipt == fee growth");
        assertEq(b1.holdersClaimable, b0.holdersClaimable, "sells create no holder Q");
    }

    /*//////////////////////////////////////////////////////////////
                           THE ROUTER MATRIX
    //////////////////////////////////////////////////////////////*/

    /// Exact-in buy and exact-in sell on `fungible` (quote `q`), exact-out whole-NFT buy on `collection`. Alice and
    /// carol are prior holders of both (earlier transactions); bob trades through `ur`.
    function _routerMatrix(string memory label, address ur, Launch memory fungible, Launch memory collection) internal {
        address q = fungible.r.quote;
        // Trade sizes: 1 WETH-denominated unit for 18-decimal quotes, 100 tokens for 6-decimal dollar quotes (or the
        // suite's matrixQUnit).
        uint256 qUnit = _qUnit(q);
        // Prior holders (the first buy's bootstrap is released by the second).
        _buyIn(fungible, alice, qUnit / 20);
        _buyIn(fungible, carol, qUnit / 50);
        _buyIn(collection, alice, qUnit / 20);
        _buyIn(collection, carol, qUnit / 50);

        // 1. Exact-input buy.
        _fundQuote(q, bob, qUnit / 5);
        Books memory b0 = _books(fungible, alice, carol);
        SwapOutcome memory buy =
            _urExactIn(ur, bob, fungible.key, !fungible.tIsCurrency0, q, fungible.r.token, qUnit / 5);
        assertGt(buy.received, 0);
        _assertBuyAttribution(fungible, b0, alice, carol, bob, buy.paid);

        // 2. Exact-input sell of half of it (T fee, burned later).
        b0 = _books(fungible, alice, carol);
        SwapOutcome memory sell =
            _urExactIn(ur, bob, fungible.key, fungible.tIsCurrency0, fungible.r.token, q, buy.received / 2);
        assertGt(sell.received, 0);
        _assertSellAttribution(fungible, b0, alice, carol);

        // 3. Exact-output buy of 2 whole NFTs of the collection to a plain EOA.
        uint256 unit = _unit(collection);
        uint256 nftsBefore = _mirror(collection).balanceOf(dave);
        _fundQuote(q, dave, qUnit / 5);
        b0 = _books(collection, alice, carol);
        SwapOutcome memory nft =
            _urExactOut(ur, dave, collection.key, !collection.tIsCurrency0, q, collection.r.token, 2 * unit, qUnit / 5);
        assertEq(nft.received, 2 * unit, "exactly two whole units");
        assertEq(_mirror(collection).balanceOf(dave) - nftsBefore, 2, "two NFTs to the EOA (ECO-06, R-A07)");
        _assertBuyAttribution(collection, b0, alice, carol, dave, nft.paid);

        _assertOtherLayoutReverts(ur, fungible, collection, buy.legacyLayout, nft.legacyLayout);

        emit log_named_string("router", label);
        emit log_named_string(
            "  ExactInputSingleParams layout",
            buy.legacyLayout ? "legacy (no minHopPriceX36)" : "current (minHopPriceX36)"
        );
        emit log_named_string("  other layout (exact in and exact out)", "reverts");
        emit log_named_string(
            "  ExactOutputSingleParams layout",
            nft.legacyLayout ? "legacy (no minHopPriceX36)" : "current (minHopPriceX36)"
        );
        emit log_named_uint("  gas: exact-in buy (fungible)", buy.gasUsed);
        emit log_named_uint("  gas: exact-in sell (fungible)", sell.gasUsed);
        emit log_named_uint("  gas: exact-out 2 NFTs (collection)", nft.gasUsed);
    }

    /// Review round B: the layout the router did NOT accept above is sent on its own (funded, exact Permit2
    /// allowance) and must revert, for an exact-in buy and an exact-out whole-NFT buy; state is restored afterwards.
    /// Decoding note (analysis, not tested): the two layouts differ by one word before `hookData`, so a wrong layout
    /// misreads the `hookData` offset; in these pools currency0 is an ERC-20 address, which the router then reads as a
    /// huge `hookData` length and reverts. A pool whose currency0 is native ETH (address 0) could decode without a
    /// revert, so integrators must still encode per router version.
    function _assertOtherLayoutReverts(
        address ur,
        Launch memory fungible,
        Launch memory collection,
        bool inAcceptedLegacy,
        bool outAcceptedLegacy
    ) internal {
        address q = fungible.r.quote;
        uint256 amount = _qUnit(q) / 10;
        uint256 snapshot = vm.snapshotState();

        _fundQuote(q, bob, amount);
        _permit(q, bob, ur, amount);
        bytes[] memory params = new bytes[](3);
        params[1] = abi.encode(Currency.wrap(q), amount);
        params[2] = abi.encode(Currency.wrap(fungible.r.token), uint256(1));
        bool zeroForOne = !fungible.tIsCurrency0;
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 amountIn = uint128(amount);
        params[0] = inAcceptedLegacy
            ? abi.encode(IV4Router.ExactInputSingleParams(fungible.key, zeroForOne, amountIn, 1, 0, ""))
            : abi.encode(LegacyExactInputSingleParams(fungible.key, zeroForOne, amountIn, 1, ""));
        (bool ok,) = _execute(
            ur,
            bob,
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL)),
            params
        );
        assertFalse(ok, "exact in: the layout this router does not accept must revert");

        uint256 unitOut = 2 * _unit(collection);
        _fundQuote(q, dave, amount);
        _permit(q, dave, ur, amount);
        params[1] = abi.encode(Currency.wrap(q), amount);
        params[2] = abi.encode(Currency.wrap(collection.r.token), unitOut);
        zeroForOne = !collection.tIsCurrency0;
        // forge-lint: disable-next-line(unsafe-typecast)
        (uint128 out128, uint128 max128) = (uint128(unitOut), uint128(amount));
        params[0] = outAcceptedLegacy
            ? abi.encode(IV4Router.ExactOutputSingleParams(collection.key, zeroForOne, out128, max128, 0, ""))
            : abi.encode(LegacyExactOutputSingleParams(collection.key, zeroForOne, out128, max128, ""));
        (ok,) = _execute(
            ur,
            dave,
            abi.encodePacked(uint8(Actions.SWAP_EXACT_OUT_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL)),
            params
        );
        assertFalse(ok, "exact out: the layout this router does not accept must revert");
        require(vm.revertToStateAndDelete(snapshot), "state restored");
    }

    /// After router trading: processing burns exactly the pending fee T; R = Q holders claim Q; R = T holders
    /// convert through the claim converter by pair id.
    function _settleAfterRouterTrades(Launch memory rq, Launch memory rt) internal {
        for (uint256 i; i < 2; ++i) {
            Launch memory L = i == 0 ? rq : rt;
            uint256 supply = L.t.totalSupply();
            uint256 pending = L.collector.pendingBurnT();
            L.collector.processFees();
            assertEq(L.t.totalSupply(), supply - pending, "burned exactly the native fee T (ECO-01)");
            assertEq(L.collector.pendingBurnT(), 0);
        }
        uint256 owed = rq.ledger.claimable(alice);
        assertGt(owed, 0);
        uint256 before = _balance(rq.r.quote, alice);
        vm.prank(alice);
        assertEq(rq.ledger.claim(alice), owed);
        assertEq(_balance(rq.r.quote, alice) - before, owed, "R = Q claim paid in Q");
        owed = rt.ledger.claimable(carol);
        assertGt(owed, 0);
        uint256 tBefore = rt.t.balanceOf(carol);
        vm.prank(carol);
        (uint256 qIn, uint256 tOut) = converter.claimAsT(rt.pairId, 1, block.timestamp);
        assertEq(qIn, owed);
        assertEq(rt.t.balanceOf(carol) - tBefore, tOut, "R = T paid in T through the canonical pool");
    }

    function _decimals(address token) internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("decimals()"));
        require(ok, "decimals");
        return abi.decode(ret, (uint256));
    }
}

/// @notice Sepolia fork (opt-in `SH_FORK_SEPOLIA=true`), pinned block 11,780,483: the per-chain deployment script
/// (`Deploy.deployAll` with script/config/11155111.json, ORCHARD forced on) runs on the fork from a throwaway address
/// against the canonical PoolManager, WETH9 and USDC, deploying the mock USDT, the system, the templates, The Misfits
/// (T = FIT, 10,000 NFTs, WETH, R = Q), the FIT template and ORCHARD (FIT quote, R = T); then every Universal Router on
/// Sepolia trades The Misfits (plus a WETH token launch with R = T, created on the fork by a creator) with encoded
/// V4_SWAP commands through the real Permit2, and UR 2.0 trades ORCHARD in FIT. The web app requests "2.0" (address
/// unresolved between two deployments, both tested) or, behind a flag, "2.1.1" (docs/research/sepolia-infrastructure.md
/// § 2.4, § 4.3); 2.1.2 (the Trading API's) and 2.2.0 are covered too.
contract SepoliaUniversalRouterForkTest is UniversalRouterForkBase {
    using StateLibrary for IPoolManager;

    address internal constant PM = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address internal constant WETH9 = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address internal constant USDC_SEPOLIA = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address internal constant UR_2_0_DOCS = 0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b;
    address internal constant UR_2_0_CONTRACTS = 0x470FFC67b1feEEC31D16C46AC7545C98716a194c;
    address internal constant UR_2_1_1 = 0x7DfD4F31be6814D2906BDE155c3e1B146EAc1468;
    address internal constant UR_2_1_2 = 0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3;
    address internal constant UR_2_2_0 = 0x5093f1CDED83d99FfEd6602dA6260672ae16787c;
    uint256 internal constant FORK_BLOCK = 11_780_483;
    string internal constant DEFAULT_RPC = "https://sepolia.gateway.tenderly.co";

    bool internal forkEnabled;
    Deploy.Result internal deployed;
    Launch internal misfitsL; // The Misfits: DN404, T = FIT, 10,000 NFTs, WETH, R = Q (deploy plan launch 1)
    Launch internal orchardL; // ORCHARD: DN404, T = ORCH, 1,000 NFTs, quote FIT, R = T (deploy plan launch 2)
    Launch internal tokenRtL; // a WETH token launch with R = T by a creator (the matrix's R = T side)

    function setUp() public {
        forkEnabled = vm.envOr("SH_FORK_SEPOLIA", false);
        if (!forkEnabled) return;
        vm.createSelectFork(vm.envOr("SEPOLIA_FORK_RPC_URL", string(DEFAULT_RPC)), FORK_BLOCK);
        assertEq(block.chainid, 11_155_111);
        Deploy script = new Deploy();
        address throwaway = makeAddr("sepoliaThrowawayDeployer");
        Deploy.Config memory c = script.loadConfig(11_155_111);
        c.orchard.enabled = true; // exercise the optional launch 2 as well
        deployed = script.deployAll(c, throwaway);
        // Adopt the script's deployment in the fixture.
        pm = IPoolManager(deployed.poolManager);
        registry = deployed.system.registry;
        converter = deployed.system.converter;
        hook = deployed.system.hook;
        launcher = deployed.system.launcher;
        weth = MockERC20(WETH9);
        usdc = MockERC20(USDC_SEPOLIA);
        stepRouter = new StepRouter(pm);
        misfitsL = _load(deployed.misfits.pairId);
        orchardL = _load(deployed.orchard.pairId);
        vm.prank(creator);
        (bytes32 tokenRt,) = launcher.createLaunch(
            _params(SquareHoleRegistry.AssetKind.Token, 1e9, 1, deployed.wethTemplate, IRewardLedger.PayoutAsset.T)
        );
        tokenRtL = _load(tokenRt);
        // One Misfits NFT starts at 0.0001 WETH (1 WETH / 10,000): 0.1 WETH per matrix unit keeps the NFT counts of
        // the B2 matrix (1 WETH per unit at 1,000 NFTs).
        matrixQUnit = 0.1e18;
    }

    modifier forkOnly() {
        if (!forkEnabled) vm.skip(true);
        _;
    }

    function _fundQuote(address q, address to, uint256 amount) internal override {
        if (q == WETH9) {
            vm.deal(to, amount);
            vm.prank(to);
            IWETH9(WETH9).deposit{value: amount}();
        } else if (q == deployed.usdt) {
            deal(q, to, _balance(q, to) + amount, true);
        } else if (q == misfitsL.r.token) {
            // FIT (a DN404 T) is bought for WETH on The Misfits' own pool, exact output (a fee event of that pool).
            _fundQuote(WETH9, to, 1 ether);
            _trade(misfitsL, to, true, false, amount);
        } else {
            deal(q, to, _balance(q, to) + amount);
        }
    }

    function test_fork_sepolia_deployScript_onCanonicalContracts() public forkOnly {
        assertEq(deployed.poolManager, PM);
        assertFalse(deployed.poolManagerFromSource || deployed.wethLocal || deployed.usdcLocal);
        assertEq(address(deployed.system.launcher.poolManager()), PM);
        assertEq(uint160(address(hook)) & 0x3FFF, 0x2A60);
        assertEq(registry.templateCount(), 4);
        assertEq(MockTetherUSD(deployed.usdt).symbol(), "USDT-TEST");
        assertEq(misfitsL.r.quote, WETH9);
        assertEq(uint8(misfitsL.r.kind), uint8(SquareHoleRegistry.AssetKind.Collection));
        assertEq(misfitsL.r.rewardSide, uint8(IRewardLedger.PayoutAsset.Q));
        assertEq(misfitsL.r.units, 10_000);
        assertEq(misfitsL.r.fractionsPerNft, 100_000);
        assertEq(misfitsL.r.initialSupply, 1e27, "F10: 1e9 FIT");
        assertEq(registry.template(deployed.fitTemplate).quote, misfitsL.r.token, "FIT admitted as a quote");
        assertEq(orchardL.r.quote, misfitsL.r.token, "ORCHARD is quoted in FIT");
        assertEq(orchardL.r.rewardSide, uint8(IRewardLedger.PayoutAsset.T));
        assertEq(orchardL.r.units, 1_000);
        (,, uint24 protocolFee,) = pm.getSlot0(misfitsL.id);
        assertEq(protocolFee, 0, "SEP-S01: no protocol fee on the new pool");
        emit log_named_address("throwaway deployer", deployed.deployer);
        emit log_named_address("hook (fork)", address(hook));
        emit log_named_uint("hook mining iterations", deployed.system.hookMiningIterations);
    }

    function test_fork_sepolia_UR20_webAppDefault_docsAddress() public forkOnly {
        _routerMatrix("Sepolia UR 2.0 (docs / universal-router repo) 0x3A9D...F98b", UR_2_0_DOCS, tokenRtL, misfitsL);
    }

    function test_fork_sepolia_UR20_webAppDefault_contractsRepoAddress() public forkOnly {
        _routerMatrix("Sepolia UR 2.0 (Uniswap/contracts) 0x470F...194c", UR_2_0_CONTRACTS, tokenRtL, misfitsL);
    }

    function test_fork_sepolia_UR211_webAppFlag() public forkOnly {
        _routerMatrix("Sepolia UR 2.1.1 0x7DfD...1468", UR_2_1_1, tokenRtL, misfitsL);
    }

    function test_fork_sepolia_UR212_tradingApi() public forkOnly {
        _routerMatrix("Sepolia UR 2.1.2 0x7E4f...43f3", UR_2_1_2, tokenRtL, misfitsL);
    }

    function test_fork_sepolia_UR220_permissionedPoolsRouter() public forkOnly {
        _routerMatrix("Sepolia UR 2.2.0 0x5093...787c", UR_2_2_0, tokenRtL, misfitsL);
    }

    /// Router trades (the web app's default 2.0), then burns, an R = Q claim (The Misfits, paid in WETH) and an R = T
    /// conversion (the WETH token launch) on the canonical PoolManager.
    function test_fork_sepolia_claimsBurnsAndConversionAfterRouterTrades() public forkOnly {
        _routerMatrix("Sepolia UR 2.0 0x3A9D...F98b", UR_2_0_DOCS, tokenRtL, misfitsL);
        _settleAfterRouterTrades(misfitsL, tokenRtL);
    }

    /// ORCHARD (deploy plan launch 2): quoted in FIT, R = T. UR 2.0 buys ORCH with FIT (exact-out whole NFTs) next to
    /// a FIT-quoted token launch (exact in and a sell; the matrix needs two pairs of one quote so that each pair's
    /// prior holders are exactly alice and carol); then processing burns the fee ORCH and an R = T conversion pays ORCH
    /// through the canonical pool. The FIT is bought for WETH on The Misfits' pool first (`_fundQuote`).
    function test_fork_sepolia_orchardQuotedInFit_routerTradesAndClaimAsT() public forkOnly {
        vm.prank(creator);
        (bytes32 fitTokenPair,) = launcher.createLaunch(
            _params(SquareHoleRegistry.AssetKind.Token, 1e9, 1, deployed.fitTemplate, IRewardLedger.PayoutAsset.Q)
        );
        Launch memory fitToken = _load(fitTokenPair);
        assertEq(fitToken.r.quote, misfitsL.r.token);
        // One ORCHARD NFT starts at 1,000 FIT (1,000,000 FIT / 1,000 NFTs): 1,000,000 FIT per matrix unit.
        matrixQUnit = 1e24;
        _routerMatrix("Sepolia UR 2.0, FIT quote: a token launch and ORCHARD", UR_2_0_DOCS, fitToken, orchardL);
        uint256 supply = orchardL.t.totalSupply();
        uint256 pending = orchardL.collector.pendingBurnT();
        orchardL.collector.processFees();
        assertEq(orchardL.t.totalSupply(), supply - pending, "burned exactly the pending fee ORCH (ECO-01)");
        uint256 owed = orchardL.ledger.claimable(carol);
        assertGt(owed, 0, "carol earned FIT from dave's ORCHARD buy");
        uint256 tBefore = orchardL.t.balanceOf(carol);
        vm.prank(carol);
        (uint256 qIn, uint256 tOut) = converter.claimAsT(orchardL.pairId, 1, block.timestamp);
        assertEq(qIn, owed);
        assertEq(orchardL.t.balanceOf(carol) - tBefore, tOut, "R = T paid in ORCH through the canonical pool");
        assertGt(tOut, 0);
    }

    /// The mock USDT (no return values, approve-from-non-zero) through the real Permit2 and the web app's router:
    /// a USDT-TEST launch trades exact in both ways and exact out (the documented PoolSwapTest harness cannot pay a
    /// no-return token; SH-B2 Build A open issue).
    function test_fork_sepolia_mockTetherThroughPermit2AndRouter() public forkOnly {
        matrixQUnit = 0; // 100 USDT-TEST per unit (a 1,000-NFT collection, as in B2)
        vm.prank(creator);
        (bytes32 fid,) = launcher.createLaunch(
            _params(SquareHoleRegistry.AssetKind.Token, 1e9, 1, deployed.usdtTemplate, IRewardLedger.PayoutAsset.Q)
        );
        vm.prank(creator);
        (bytes32 cid,) = launcher.createLaunch(
            _params(
                SquareHoleRegistry.AssetKind.Collection, 1_000, 0, deployed.usdtTemplate, IRewardLedger.PayoutAsset.T
            )
        );
        Launch memory fungible = _load(fid);
        Launch memory collection = _load(cid);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(bob);
        MockTetherUSD(deployed.usdt).faucet(1_000e6); // the public capped faucet on the fork
        assertEq(MockTetherUSD(deployed.usdt).balanceOf(bob), 1_000e6);
        _routerMatrix("Sepolia UR 2.0 with USDT-TEST (no-return quote)", UR_2_0_DOCS, fungible, collection);
        _settleAfterRouterTrades(fungible, collection);
    }
}

/// @notice Ethereum mainnet fork (opt-in `SH_FORK_MAINNET=true`), pinned block 26,055,260 (ADR-0006 AU-03), keyless
/// archive RPC: Square Hole deployed locally on the fork against the canonical PoolManager `0x0000…4444`, with WETH9
/// and Circle USDC templates; the three Universal Routers of ADR-0006's swap matrix (`0x66a9…`, 2.1.1 `0x4c82…`,
/// 2.1.2 `0x2361…`) trade through the real Permit2; the mock USDT is compared with the real USDT. The deployment
/// script itself refuses chain 1 (G08), so the fork uses the test fixture's deployment.
contract MainnetUniversalRouterForkTest is UniversalRouterForkBase {
    using StateLibrary for IPoolManager;

    address internal constant PM = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address internal constant WETH9 = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant USDC_MAINNET = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDT_MAINNET = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address internal constant UR_2_0 = 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af;
    address internal constant UR_2_1_1 = 0x4C82D1fBFe28C977cBB58D8C7FF8FCF9F70a2cCA;
    address internal constant UR_2_1_2 = 0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85;
    uint256 internal constant FORK_BLOCK = 26_055_260;
    string internal constant DEFAULT_RPC = "https://eth.drpc.org";

    bool internal forkEnabled;

    function setUp() public {
        forkEnabled = vm.envOr("SH_FORK_MAINNET", false);
        if (!forkEnabled) return;
        vm.createSelectFork(vm.envOr("MAINNET_FORK_RPC_URL", string(DEFAULT_RPC)), FORK_BLOCK);
        assertEq(block.chainid, 1);
        _deploySystemOnFork(PM, address(0), WETH9, USDC_MAINNET);
    }

    modifier forkOnly() {
        if (!forkEnabled) vm.skip(true);
        _;
    }

    function _fundQuote(address q, address to, uint256 amount) internal override {
        if (q == WETH9) {
            vm.deal(to, amount);
            vm.prank(to);
            IWETH9(WETH9).deposit{value: amount}();
        } else if (q == USDC_MAINNET) {
            deal(q, to, _balance(q, to) + amount);
        } else {
            super._fundQuote(q, to, amount);
        }
    }

    function _wethPairs() internal returns (Launch memory fungible, Launch memory collection) {
        fungible = _launch(SquareHoleRegistry.AssetKind.Token, 1e9, 1, wethTemplate, IRewardLedger.PayoutAsset.Q);
        collection =
            _launch(SquareHoleRegistry.AssetKind.Collection, 1_000, 1e6, wethTemplate, IRewardLedger.PayoutAsset.T);
    }

    function _usdcPairs() internal returns (Launch memory fungible, Launch memory collection) {
        fungible = _launch(SquareHoleRegistry.AssetKind.Token, 1e9, 1, usdcTemplate, IRewardLedger.PayoutAsset.Q);
        collection =
            _launch(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, usdcTemplate, IRewardLedger.PayoutAsset.T);
    }

    function test_fork_mainnet_UR20_weth() public forkOnly {
        (Launch memory f, Launch memory c) = _wethPairs();
        _routerMatrix("mainnet UR 2.0 0x66a9...A8Af, WETH", UR_2_0, f, c);
    }

    function test_fork_mainnet_UR211_weth() public forkOnly {
        (Launch memory f, Launch memory c) = _wethPairs();
        _routerMatrix("mainnet UR 2.1.1 0x4c82...2cca, WETH", UR_2_1_1, f, c);
    }

    function test_fork_mainnet_UR212_weth() public forkOnly {
        (Launch memory f, Launch memory c) = _wethPairs();
        _routerMatrix("mainnet UR 2.1.2 0x2361...De85, WETH", UR_2_1_2, f, c);
    }

    function test_fork_mainnet_UR20_usdc() public forkOnly {
        (Launch memory f, Launch memory c) = _usdcPairs();
        _routerMatrix("mainnet UR 2.0 0x66a9...A8Af, USDC", UR_2_0, f, c);
    }

    function test_fork_mainnet_UR212_usdc() public forkOnly {
        (Launch memory f, Launch memory c) = _usdcPairs();
        _routerMatrix("mainnet UR 2.1.2 0x2361...De85, USDC", UR_2_1_2, f, c);
    }

    /// Burns, R = Q claims and R = T conversions after router trades, WETH and USDC; a new pool's protocol fee is 0
    /// (the controller must set it per pool; mainnet controller present, ADR-0011 §8).
    function test_fork_mainnet_claimsBurnsAndConversionAfterRouterTrades() public forkOnly {
        (Launch memory f, Launch memory c) = _wethPairs();
        (,, uint24 protocolFee,) = pm.getSlot0(c.id);
        assertEq(protocolFee, 0, "a new pool starts without a protocol fee");
        emit log_named_address("mainnet protocolFeeController", _controller());
        _routerMatrix("mainnet UR 2.1.2, WETH", UR_2_1_2, f, c);
        _settleAfterRouterTrades(f, c);
        (Launch memory fu, Launch memory cu) = _usdcPairs();
        _routerMatrix("mainnet UR 2.1.2, USDC", UR_2_1_2, fu, cu);
        _settleAfterRouterTrades(fu, cu);
    }

    function _controller() internal view returns (address c) {
        (bool ok, bytes memory ret) = address(pm).staticcall(abi.encodeWithSignature("protocolFeeController()"));
        require(ok, "controller");
        c = abi.decode(ret, (address));
    }

    /*//////////////////////////////////////////////////////////////
                MOCK USDT VS THE REAL USDT (DIFFERENTIAL)
    //////////////////////////////////////////////////////////////*/

    /// The research doc's differential (§ 3.1): the same operations on the real USDT (forked, issuer powers used by
    /// pranking its owner) and on MockTetherUSD give the same observable behaviour: return data, reverts, allowance
    /// handling, pause, sender blacklist, and the fee formula.
    function test_fork_mainnet_mockTetherMatchesRealUsdt() public forkOnly {
        MockTetherUSD mock = new MockTetherUSD(makeAddr("mockIssuer"));
        address[2] memory tokens = [USDT_MAINNET, address(mock)];
        for (uint256 i; i < 2; ++i) {
            _differential(tokens[i], i == 0 ? _owner(USDT_MAINNET) : mock.owner(), i == 1);
        }
    }

    function _owner(address token) internal view returns (address o) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("owner()"));
        require(ok, "owner");
        o = abi.decode(ret, (address));
    }

    function _differential(address token, address issuer, bool isMock) internal {
        address a = makeAddr(isMock ? "diffA.mock" : "diffA.real");
        address b = makeAddr(isMock ? "diffB.mock" : "diffB.real");
        address sp = makeAddr(isMock ? "diffSpender.mock" : "diffSpender.real");
        if (isMock) {
            vm.prank(a);
            MockTetherUSD(token).faucet(10_000e6);
        } else {
            deal(token, a, 10_000e6);
        }
        // decimals is a uint256 (32 bytes) equal to 6.
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("decimals()"));
        assertTrue(ok);
        assertEq(abi.decode(ret, (uint256)), 6);
        // transfer / approve / transferFrom return no data.
        (ok, ret) = _as(a, token, abi.encodeWithSelector(0xa9059cbb, b, 1e6));
        assertTrue(ok && ret.length == 0, "transfer: no return data");
        (ok, ret) = _as(a, token, abi.encodeWithSelector(0x095ea7b3, sp, 5e6));
        assertTrue(ok && ret.length == 0, "approve: no return data");
        (ok,) = _as(a, token, abi.encodeWithSelector(0x095ea7b3, sp, 6e6));
        assertFalse(ok, "approve from non-zero to non-zero reverts");
        (ok, ret) = _as(sp, token, abi.encodeWithSelector(0x23b872dd, a, b, 2e6));
        assertTrue(ok && ret.length == 0, "transferFrom: no return data");
        assertEq(_allowance(token, a, sp), 3e6, "finite allowance reduced");
        (ok,) = _as(a, token, abi.encodeWithSelector(0x095ea7b3, sp, 0));
        (ok,) = _as(a, token, abi.encodeWithSelector(0x095ea7b3, sp, type(uint256).max));
        (ok,) = _as(sp, token, abi.encodeWithSelector(0x23b872dd, a, b, 1e6));
        assertTrue(ok);
        assertEq(_allowance(token, a, sp), type(uint256).max, "max allowance never reduced");
        // Short calldata reverts.
        (ok,) = _as(a, token, abi.encodePacked(bytes4(0xa9059cbb), bytes32(uint256(uint160(b)))));
        assertFalse(ok, "short payload reverts");
        // Sender blacklist: a blacklisted sender cannot send, anyone can still pay it.
        vm.prank(issuer);
        (ok,) = token.call(abi.encodeWithSignature("addBlackList(address)", b));
        assertTrue(ok);
        (ok,) = _as(b, token, abi.encodeWithSelector(0xa9059cbb, a, 1));
        assertFalse(ok, "blacklisted sender blocked");
        (ok,) = _as(a, token, abi.encodeWithSelector(0xa9059cbb, b, 1));
        assertTrue(ok, "a blacklisted recipient can receive");
        vm.prank(issuer);
        (ok,) = token.call(abi.encodeWithSignature("removeBlackList(address)", b));
        // Pause blocks transfers, not approvals.
        vm.prank(issuer);
        (ok,) = token.call(abi.encodeWithSignature("pause()"));
        assertTrue(ok);
        (ok,) = _as(a, token, abi.encodeWithSelector(0xa9059cbb, b, 1));
        assertFalse(ok, "paused transfer reverts");
        (ok,) = _as(a, token, abi.encodeWithSelector(0x095ea7b3, makeAddr(isMock ? "sp2m" : "sp2r"), 1));
        assertTrue(ok, "approve works while paused");
        vm.prank(issuer);
        (ok,) = token.call(abi.encodeWithSignature("unpause()"));
        // Fee formula: min(value × bps / 10,000, maxFee), paid to the owner.
        vm.prank(issuer);
        (ok,) = token.call(abi.encodeWithSignature("setParams(uint256,uint256)", 10, 1));
        assertTrue(ok);
        uint256 bBefore = _balance(token, b);
        uint256 issuerBefore = _balance(token, issuer);
        (ok,) = _as(a, token, abi.encodeWithSelector(0xa9059cbb, b, 100e6));
        assertTrue(ok);
        assertEq(_balance(token, b) - bBefore, 100e6 - 0.1e6, "fee 10 bps");
        assertEq(_balance(token, issuer) - issuerBefore, 0.1e6, "fee to the owner");
        (ok,) = _as(a, token, abi.encodeWithSelector(0xa9059cbb, b, 5_000e6));
        assertEq(_balance(token, issuer) - issuerBefore, 0.1e6 + 1e6, "fee capped at maxFee");
        emit log_named_string("differential passed", isMock ? "MockTetherUSD" : "mainnet USDT 0xdAC1...1ec7");
    }

    function _as(address from, address token, bytes memory data) internal returns (bool ok, bytes memory ret) {
        vm.prank(from);
        (ok, ret) = token.call(data);
    }

    function _allowance(address token, address o, address s) internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("allowance(address,address)", o, s));
        require(ok, "allowance");
        return abi.decode(ret, (uint256));
    }
}
