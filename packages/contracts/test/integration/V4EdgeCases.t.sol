// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {IRewardLedger} from "../../src/interfaces/IRewardLedger.sol";
import {CreateAddress} from "../../src/libraries/CreateAddress.sol";
import {SquareHoleClaimConverter} from "../../src/SquareHoleClaimConverter.sol";
import {SquareHoleHook} from "../../src/SquareHoleHook.sol";
import {SquareHoleLauncher} from "../../src/SquareHoleLauncher.sol";
import {SquareHoleRegistry} from "../../src/SquareHoleRegistry.sol";
import {CollectionTokenDeployer, CoreDeployer, FungibleTokenDeployer} from "../../src/deployers/LaunchDeployers.sol";
import {StepRouter} from "../utils/v4/Routers.sol";
import {V4Fixture} from "../utils/v4/V4Fixture.sol";

contract CreateAddressCaller {
    function compute(address deployer, uint256 nonce) external pure returns (address) {
        return CreateAddress.compute(deployer, nonce);
    }
}

contract CreateAddressTest is Test {
    function test_matchesForgeAcrossRlpLengths() public {
        CreateAddressCaller c = new CreateAddressCaller();
        address d = makeAddr("deployer");
        uint256[9] memory nonces = [uint256(1), 0x7f, 0x80, 0xff, 0x100, 0xffff, 0x10000, 0xffffff, 0x1000000];
        for (uint256 i; i < nonces.length; ++i) {
            assertEq(c.compute(d, nonces[i]), vm.computeCreateAddress(d, nonces[i]));
        }
        assertEq(c.compute(d, type(uint32).max), vm.computeCreateAddress(d, type(uint32).max));
        vm.expectRevert(abi.encodeWithSelector(CreateAddress.NonceOutOfRange.selector, 0));
        c.compute(d, 0);
        vm.expectRevert(abi.encodeWithSelector(CreateAddress.NonceOutOfRange.selector, uint256(type(uint32).max) + 1));
        c.compute(d, uint256(type(uint32).max) + 1);
    }
}

/// @notice Edge cases: hook launch validation and unused callbacks, a launcher without a converter, and a conversion
/// that cannot fill (sold-out range) failing atomically.
contract V4EdgeCasesTest is V4Fixture {
    function setUp() public {
        _deploySystem();
    }

    function test_hook_launchPoolValidatesKeyAndCollector() public {
        Launch memory L =
            _launch(SquareHoleRegistry.AssetKind.Collection, 100, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
        Launch memory M = _launch(SquareHoleRegistry.AssetKind.Token, 1e9, 1, wethTemplate, IRewardLedger.PayoutAsset.Q);
        SquareHoleHook.LaunchPoolParams memory p = SquareHoleHook.LaunchPoolParams({
            key: L.key,
            sqrtPriceX96: L.r.sqrtPriceX96,
            tickLower: L.r.tickLower,
            tickUpper: L.r.tickUpper,
            liquidity: L.r.liquidity,
            collector: L.r.collector
        });
        p.key.tickSpacing = 200; // a new, unlaunched pool id
        SquareHoleHook.LaunchPoolParams memory bad = p;
        bad.liquidity = 0;
        _expectInvalidLaunch(bad);
        bad = p;
        bad.key.hooks = IHooks(address(0x2a60));
        _expectInvalidLaunch(bad);
        bad = p;
        bad.collector = M.r.collector; // another launch's collector: its T is not in this key
        _expectInvalidLaunch(bad);
        bad = p;
        bad.key.currency1 = bad.key.currency0; // not the collector's T/Q pair
        _expectInvalidLaunch(bad);
    }

    function _expectInvalidLaunch(SquareHoleHook.LaunchPoolParams memory p) internal {
        vm.prank(address(launcher));
        vm.expectRevert(SquareHoleHook.InvalidLaunch.selector);
        hook.launchPool(p);
    }

    function test_hook_unusedCallbacksAndUnknownUnlock() public {
        PoolKey memory key;
        ModifyLiquidityParams memory mp;
        vm.expectRevert(SquareHoleHook.HookNotImplemented.selector);
        hook.afterAddLiquidity(address(this), key, mp, BalanceDelta.wrap(0), BalanceDelta.wrap(0), "");
        vm.expectRevert(SquareHoleHook.HookNotImplemented.selector);
        hook.afterRemoveLiquidity(address(this), key, mp, BalanceDelta.wrap(0), BalanceDelta.wrap(0), "");
        vm.expectRevert(SquareHoleHook.HookNotImplemented.selector);
        hook.afterDonate(address(this), key, 0, 0, "");
        vm.prank(address(pm));
        vm.expectRevert(SquareHoleHook.UnknownPool.selector);
        hook.unlockCallback(abi.encode(key, int24(0), int24(60), uint128(1), address(weth)));
    }

    /// A deployment without a claim converter launches R = Q only; the converter wiring is checked.
    function test_launcher_withoutConverter_andConverterWiring() public {
        uint256 nonce = vm.getNonce(address(this));
        address predicted = vm.computeCreateAddress(address(this), nonce + 5);
        SquareHoleRegistry reg2 = new SquareHoleRegistry(admin, predicted);
        bytes memory init = abi.encodePacked(type(SquareHoleHook).creationCode, abi.encode(pm, predicted));
        (bytes32 salt,) = _mineHookSalt(address(this), keccak256(init));
        SquareHoleHook hook2 = new SquareHoleHook{salt: salt}(pm, predicted);
        CoreDeployer c2 = new CoreDeployer(predicted);
        CollectionTokenDeployer d2 = new CollectionTokenDeployer(predicted);
        FungibleTokenDeployer f2 = new FungibleTokenDeployer(predicted);
        // The existing converter reads another registry: refused.
        vm.expectRevert(SquareHoleLauncher.WiringMismatch.selector);
        new SquareHoleLauncher(pm, hook2, reg2, treasury, address(converter), c2, d2, f2);
        vm.setNonceUnsafe(address(this), uint64(nonce + 5));
        SquareHoleLauncher l2 = new SquareHoleLauncher(pm, hook2, reg2, treasury, address(0), c2, d2, f2);
        assertEq(address(l2), predicted);
        vm.prank(admin);
        uint32 v = reg2.addTemplate(address(weth), 1e18, 1e14, TICK_SPACING, RANGE_TICKS);
        vm.prank(creator);
        vm.expectRevert(SquareHoleLauncher.PayoutTUnavailable.selector);
        l2.createLaunch(_params(SquareHoleRegistry.AssetKind.Collection, 100, 0, v, IRewardLedger.PayoutAsset.T));
        vm.prank(creator);
        (bytes32 pairId,) =
            l2.createLaunch(_params(SquareHoleRegistry.AssetKind.Collection, 100, 0, v, IRewardLedger.PayoutAsset.Q));
        assertEq(reg2.pair(pairId).hook, address(hook2));
    }

    /*//////////////////////////////////////////////////////////////
          EIP-7825 NFT CAP PER TRANSACTION (REVIEW ROUND A, FINDING 3)
    //////////////////////////////////////////////////////////////*/

    /// @dev EIP-7825 (Osaka/Fusaka): maximum gas limit of one transaction.
    uint256 internal constant EIP7825_TX_GAS_CAP = 16_777_216;

    /// Review round A, finding 3: at the largest N a template admits (startFdvQ / minStartUnitValueQ), the template's
    /// reference buy (REFERENCE_BUY_NFTS × minStartUnitValueQ of Q at the start price, exact input, delivered to a
    /// plain EOA) and an R = T conversion of the same size paid to an EOA both fit one EIP-7825 transaction, run from
    /// cold storage with the transaction's intrinsic cost subtracted.
    function test_nftCap_referenceBuyAndConversionFitEip7825_largestN() public {
        uint256 maxN = registry.maxCollectionUnits(wethTemplate);
        assertEq(maxN, 10_000);
        Launch memory L =
            _launch(SquareHoleRegistry.AssetKind.Collection, maxN, 0, wethTemplate, IRewardLedger.PayoutAsset.T);
        assertEq(_unit(L), 1e23, "F10: 10,000 NFTs of 100,000 tokens");
        uint256 refBuy = registry.REFERENCE_BUY_NFTS() * WETH_MIN_UNIT_VALUE; // 0.1 WETH
        address buyer = makeAddr("referenceBuyer");
        _fundQuote(address(weth), buyer, refBuy);
        _approveExact(address(weth), buyer, address(stepRouter), refBuy);
        StepRouter.Step[] memory s = new StepRouter.Step[](3);
        s[0] = _swapStep(L, true, -int256(refBuy));
        s[1] = _payStep(StepRouter.Op.SettleAll, address(weth), buyer, 0);
        s[2] = _payStep(StepRouter.Op.TakeAll, L.r.token, buyer, 0);
        (bool ok, uint256 used) = _capped(L, address(0), address(stepRouter), abi.encodeCall(StepRouter.run, (s)));
        uint256 nfts = _mirror(L).balanceOf(buyer);
        emit log_named_uint("reference buy: NFTs delivered", nfts);
        emit log_named_uint("reference buy: gas (execution)", used);
        assertTrue(ok, "the reference buy fits one EIP-7825 transaction");
        assertGt(nfts, 850, "about 1,000 minus the 3% fee and the price impact");
        assertLe(nfts, registry.REFERENCE_BUY_NFTS());

        // The buyer earns an entitlement of at least the reference size from other traders' buys (round trips by a
        // skip-NFT trader, so the price returns near the start: the worst case for NFTs per Q).
        address trader = makeAddr("roundTripper");
        vm.prank(trader);
        _collection(L).setSkipNFT(true);
        for (uint256 i; i < 6 && L.ledger.claimable(buyer) < refBuy; ++i) {
            uint256 tOut = _buyIn(L, trader, 1 ether);
            _sellIn(L, trader, tOut);
        }
        assertGe(L.ledger.claimable(buyer), refBuy);
        uint256 before = _mirror(L).balanceOf(buyer);
        // `claimAsT` is overloaded (token slice, or pair id whole entitlement): select the slice form explicitly.
        bytes memory call = abi.encodeWithSignature(
            "claimAsT(address,uint256,uint256,uint256)", L.r.token, refBuy, uint256(0), block.timestamp
        );
        (ok, used) = _capped(L, buyer, address(converter), call);
        uint256 converted = _mirror(L).balanceOf(buyer) - before;
        emit log_named_uint("R = T conversion of the reference size: NFTs delivered", converted);
        emit log_named_uint("R = T conversion of the reference size: gas (execution)", used);
        assertTrue(ok, "the reference-size conversion fits one EIP-7825 transaction");
        assertGt(converted, 500, "hundreds of NFTs (the price is above the start after the round trips)");
    }

    /// The measured per-transaction NFT cap with the hook: the largest exact-output buy of whole NFTs a fresh EOA can
    /// receive in one EIP-7825 transaction (cold storage, intrinsic cost subtracted). Recorded for the wizard and the
    /// app (ADR-0011 §4); the template bound keeps the reference buy at or below REFERENCE_BUY_NFTS.
    /// F10: at the testnet templates' largest N = 10,000 (The Misfits), one NFT is 100,000 tokens = 0.01% of the fixed
    /// 1e9 supply, so the cap is also reported as a share of the supply.
    function test_nftCap_measuredLargestExactOutBuyPerTransaction() public {
        Launch memory L =
            _launch(SquareHoleRegistry.AssetKind.Collection, 10_000, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
        assertEq(_unit(L), 1e23);
        _buyIn(L, alice, 0.01 ether); // a prior holder, so the measured buy indexes (the steady state)
        uint256 lo = 1; // fits
        uint256 hi = 4_000; // does not fit
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            if (_exactOutFits(L, mid)) lo = mid;
            else hi = mid;
        }
        emit log_named_uint("largest exact-out NFT buy per EIP-7825 transaction", lo);
        // Share of the fixed supply in 1e-4 percent (4 decimals): lo × unit / 1e27 × 100%.
        uint256 shareOfSupply = lo * _unit(L) * 1e6 / L.r.initialSupply;
        emit log_named_decimal_uint("  as a share of the 1e9-token supply (%)", shareOfSupply, 4);
        assertEq(shareOfSupply, lo * 100, "N = 10,000: one NFT is 0.01% of the supply");
        assertGe(lo, 1_100, "comfortably above the 1,000-NFT reference buy");
        assertLt(lo, 1_500);
        assertLe(registry.REFERENCE_BUY_NFTS(), lo);
    }

    function _exactOutFits(Launch memory L, uint256 k) internal returns (bool ok) {
        uint256 snap = vm.snapshotState();
        address buyer = makeAddr("capProbe");
        _fundQuote(address(weth), buyer, 100 ether);
        _approveExact(address(weth), buyer, address(stepRouter), 100 ether);
        StepRouter.Step[] memory s = new StepRouter.Step[](3);
        s[0] = _swapStep(L, true, int256(k * _unit(L)));
        s[1] = _payStep(StepRouter.Op.SettleAll, address(weth), buyer, 0);
        s[2] = _payStep(StepRouter.Op.TakeAll, L.r.token, buyer, 0);
        (ok,) = _capped(L, address(0), address(stepRouter), abi.encodeCall(StepRouter.run, (s)));
        if (ok) assertEq(_mirror(L).balanceOf(buyer), k);
        vm.revertToState(snap);
    }

    /// Calls `target` with `data` (as `from` unless zero) with the gas a 16,777,216-gas transaction leaves after its
    /// intrinsic cost (21,000 + 16 per calldata byte, an upper bound), from cold accounts and storage.
    function _capped(Launch memory L, address from, address target, bytes memory data)
        internal
        returns (bool ok, uint256 used)
    {
        address[9] memory touched = [
            address(pm),
            L.r.token,
            L.r.mirror,
            L.r.ledger,
            L.r.collector,
            address(hook),
            address(weth),
            target,
            address(registry)
        ];
        for (uint256 i; i < touched.length; ++i) {
            vm.cool(touched[i]);
        }
        uint256 budget = EIP7825_TX_GAS_CAP - 21_000 - 16 * data.length;
        if (from != address(0)) vm.prank(from);
        uint256 g = gasleft();
        (ok,) = target.call{gas: budget}(data);
        used = g - gasleft();
    }

    /// ECO-07: when the pool cannot fill the conversion (the range is sold out), it reverts and the claim is intact.
    function test_converter_partialFillRevertsAndKeepsTheClaim() public {
        Launch memory L = _launch(SquareHoleRegistry.AssetKind.Token, 1e9, 1, wethTemplate, IRewardLedger.PayoutAsset.T);
        _buyIn(L, alice, 0.5 ether);
        _fundQuote(address(weth), bob, 1_000 ether);
        (uint256 reservesT,) = _principal(L);
        // Buys out (almost) the whole range, exact output: F10's 1e27 supply leaves ~1e-12 WETH of T in the range (the
        // 1e21-supply B2 version left 2 wei; with 1e6 times the liquidity such a remainder rounds the price to the
        // limit instead).
        _trade(L, bob, true, false, reservesT - 2e6);
        (reservesT,) = _principal(L);
        assertLt(reservesT, 1e7);
        uint256 owed = L.ledger.claimable(alice);
        assertGt(owed, 0.1 ether, "alice earned from bob's large buy");
        vm.prank(alice);
        vm.expectPartialRevert(SquareHoleClaimConverter.PartialFill.selector);
        converter.claimAsT(L.r.token, ALL, 0, block.timestamp);
        assertEq(L.ledger.claimable(alice), owed, "atomic: nothing consumed");
    }
}
