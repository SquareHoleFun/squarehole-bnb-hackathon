// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {Pool} from "v4-core/src/libraries/Pool.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {IRewardLedger} from "../../src/interfaces/IRewardLedger.sol";
import {LaunchTokenCore} from "../../src/base/LaunchTokenCore.sol";
import {LaunchMath} from "../../src/libraries/LaunchMath.sol";
import {SquareHoleClaimConverter} from "../../src/SquareHoleClaimConverter.sol";
import {SquareHoleHook} from "../../src/SquareHoleHook.sol";
import {SquareHoleLauncher} from "../../src/SquareHoleLauncher.sol";
import {SquareHoleRegistry} from "../../src/SquareHoleRegistry.sol";
import {SquareHoleToken} from "../../src/SquareHoleToken.sol";
import {CollectionTokenDeployer, CoreDeployer, LaunchDeployerBase} from "../../src/deployers/LaunchDeployers.sol";
import {V4Fixture} from "../utils/v4/V4Fixture.sol";

/// @notice The hook's address, permissions and access control; the registry's add-only admin and append-only
/// launcher; the launcher's validation, determinism and "no creator knobs" rules.
contract V4LaunchSystemTest is V4Fixture {
    function setUp() public {
        _deploySystem();
    }

    /*//////////////////////////////////////////////////////////////
                                  HOOK
    //////////////////////////////////////////////////////////////*/

    /// Routing class (ADR-0006 SH-019 item 4): exactly the A1 permission bits, no return-delta flag, a static fee
    /// below 11%, and no 0x91 address prefix: eligible for Uniswap's auto-admission queue in the public code.
    function test_hook_addressFlagsAndRoutingClass() public view {
        uint160 a = uint160(address(hook));
        assertEq(hook.REQUIRED_FLAGS(), HOOK_FLAGS);
        assertEq(a & Hooks.ALL_HOOK_MASK, 0x2A60, "beforeInitialize|beforeAdd|beforeRemove|afterSwap|beforeDonate");
        assertEq(a & Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG, 0);
        assertEq(a & Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG, 0);
        assertEq(a & Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG, 0);
        assertEq(a & Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG, 0);
        assertEq(a & Hooks.BEFORE_SWAP_FLAG, 0, "no beforeSwap");
        assertTrue(a >> 152 != 0x91, "no 0x91 prefix");
        uint24 fee = hook.LP_FEE();
        assertFalse(LPFeeLibrary.isDynamicFee(fee), "static fee");
        assertEq(fee, 30_000);
        assertLe(fee, 110_000, "below the 11% auto-admission ceiling");
        assertTrue(Hooks.isValidHookAddress(IHooks(address(hook)), fee));
        assertEq(hook.launcher(), address(launcher));
        assertEq(address(hook.poolManager()), address(pm));
    }

    function test_hook_cannotBeDeployedAtAnAddressWithoutItsFlags() public {
        vm.expectRevert(); // Hooks.HookAddressNotValid
        new SquareHoleHook(pm, address(launcher));
    }

    function test_hook_launchPoolOnlyLauncher() public {
        Launch memory L =
            _launch(SquareHoleRegistry.AssetKind.Collection, 100, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
        SquareHoleHook.LaunchPoolParams memory p = SquareHoleHook.LaunchPoolParams({
            key: L.key,
            sqrtPriceX96: L.r.sqrtPriceX96,
            tickLower: L.r.tickLower,
            tickUpper: L.r.tickUpper,
            liquidity: 1,
            collector: L.r.collector
        });
        vm.expectRevert(SquareHoleHook.NotLauncher.selector);
        hook.launchPool(p);
        vm.prank(address(launcher));
        vm.expectRevert(SquareHoleHook.PoolAlreadyLaunched.selector);
        hook.launchPool(p);
        p.key.fee = 3_000;
        vm.prank(address(launcher));
        vm.expectRevert(SquareHoleHook.InvalidLaunch.selector);
        hook.launchPool(p);
    }

    function test_hook_callbacksOnlyFromPoolManager() public {
        PoolKey memory key;
        vm.expectRevert(SquareHoleHook.NotPoolManager.selector);
        hook.afterSwap(address(this), key, SwapParams(true, 1, 0), BalanceDelta.wrap(0), "");
        vm.expectRevert(SquareHoleHook.NotPoolManager.selector);
        hook.beforeDonate(address(this), key, 1, 1, "");
        vm.expectRevert(SquareHoleHook.NotPoolManager.selector);
        hook.unlockCallback("");
        vm.prank(address(pm));
        vm.expectRevert(SquareHoleHook.UnknownPool.selector);
        hook.afterSwap(address(this), key, SwapParams(true, 1, 0), BalanceDelta.wrap(0), "");
        vm.expectRevert(SquareHoleHook.HookNotImplemented.selector);
        hook.beforeSwap(address(this), key, SwapParams(true, 1, 0), "");
        vm.expectRevert(SquareHoleHook.HookNotImplemented.selector);
        hook.afterInitialize(address(this), key, 1, 0);
    }

    function test_hook_poolConfigView() public {
        Launch memory L = _launch(SquareHoleRegistry.AssetKind.Token, 1e9, 1, wethTemplate, IRewardLedger.PayoutAsset.Q);
        SquareHoleHook.PoolConfig memory c = hook.poolConfig(L.id);
        assertEq(c.collector, L.r.collector);
        assertEq(c.tickLower, L.r.tickLower);
        assertEq(c.tickUpper, L.r.tickUpper);
        assertEq(c.tIsCurrency0, L.tIsCurrency0);
        assertEq(hook.poolConfig(PoolId.wrap(bytes32(uint256(1)))).collector, address(0));
    }

    /*//////////////////////////////////////////////////////////////
                                REGISTRY
    //////////////////////////////////////////////////////////////*/

    function test_registry_adminCanOnlyAddAndRetire() public {
        vm.expectRevert(SquareHoleRegistry.NotAdmin.selector);
        registry.addTemplate(address(weth), 1e18, 1e14, 60, 69_060);
        vm.expectRevert(SquareHoleRegistry.NotAdmin.selector);
        registry.retireTemplate(wethTemplate);
        vm.startPrank(admin);
        vm.expectRevert(SquareHoleRegistry.InvalidTemplate.selector);
        registry.addTemplate(address(0), 1e18, 1e14, 60, 69_060);
        vm.expectRevert(SquareHoleRegistry.InvalidTemplate.selector);
        registry.addTemplate(makeAddr("noCode"), 1e18, 1e14, 60, 69_060);
        vm.expectRevert(LaunchMath.InvalidTemplate.selector);
        registry.addTemplate(address(weth), 1e18, 1e14, 60, 61);
        vm.expectRevert(); // a start price that does not fit the tick range for every supported supply
        registry.addTemplate(address(weth), 1e54, 1e14, 60, 69_060); // 1e36 Q per T at the smallest supply: off range
        // The NFT unit-value floor must be positive and admit a one-NFT collection.
        vm.expectRevert(SquareHoleRegistry.InvalidTemplate.selector);
        registry.addTemplate(address(weth), 1e18, 0, 60, 69_060);
        vm.expectRevert(SquareHoleRegistry.InvalidTemplate.selector);
        registry.addTemplate(address(weth), 1e18, 1e18 + 1, 60, 69_060);
        vm.expectEmit(address(registry));
        emit SquareHoleRegistry.TemplateAdded(4, address(weth), 2e18, 2e15, 200, 69_000, 1);
        uint32 v = registry.addTemplate(address(weth), 2e18, 2e15, 200, 69_000);
        assertEq(v, 4);
        assertEq(registry.templateCount(), 4);
        assertEq(registry.latestTemplateFor(address(weth)), 4);
        SquareHoleRegistry.LaunchTemplate memory t = registry.template(v);
        assertEq(t.quote, address(weth));
        assertEq(t.startFdvQ, 2e18);
        assertEq(t.minStartUnitValueQ, 2e15);
        assertEq(registry.maxCollectionUnits(v), 1_000);
        assertEq(registry.maxCollectionUnits(99), 0);
        assertEq(t.tickSpacing, 200);
        assertEq(t.rangeTicks, 69_000);
        assertEq(t.shape, 1);
        assertTrue(t.active);
        vm.expectRevert(abi.encodeWithSelector(SquareHoleRegistry.UnknownTemplate.selector, uint32(99)));
        registry.retireTemplate(99);
        vm.stopPrank();
    }

    /// Review round A: a template whose largest launch would exceed v4's per-tick liquidity cap is refused at
    /// addTemplate (before, `addTemplate(weth, 1e30, spacing 1, range 1)` was accepted and a max-supply launch then
    /// reverted in Pool.sol with TickLiquidityOverflow). The reimplemented cap equals Pool.sol's.
    function test_registry_refusesTemplatesAboveMaxLiquidityPerTick() public {
        int24[6] memory spacings = [int24(1), 10, 60, 200, 16_384, 32_767];
        for (uint256 i; i < spacings.length; ++i) {
            assertEq(
                LaunchMath.maxLiquidityPerTick(spacings[i]),
                Pool.tickSpacingToMaxLiquidityPerTick(spacings[i]),
                "same cap as Pool.sol"
            );
        }
        vm.startPrank(admin);
        vm.expectRevert(SquareHoleRegistry.InvalidTemplate.selector);
        registry.addTemplate(address(weth), 1e30, 1e14, 1, 1);
        vm.stopPrank();
        // The fixture templates are far inside the cap at the largest supply, in both orders.
        uint128 cap = LaunchMath.maxLiquidityPerTick(TICK_SPACING);
        for (uint256 o; o < 2; ++o) {
            uint128 l = LaunchMath.launchPosition(1e27, WETH_START_FDV, RANGE_TICKS, TICK_SPACING, o == 0).liquidity;
            assertLt(uint256(l) * 1_000, cap);
        }
    }

    /// Review round A: retiring the quote's latest template clears `latestTemplateFor` (no pointer to a retired
    /// version); retiring an older one leaves the latest in place.
    function test_registry_retireClearsLatestPointer() public {
        vm.startPrank(admin);
        uint32 v2 = registry.addTemplate(address(weth), 2e18, 2e14, TICK_SPACING, RANGE_TICKS);
        assertEq(registry.latestTemplateFor(address(weth)), v2);
        registry.retireTemplate(wethTemplate); // an older version
        assertEq(registry.latestTemplateFor(address(weth)), v2);
        registry.retireTemplate(v2);
        assertEq(registry.latestTemplateFor(address(weth)), 0, "no active default");
        vm.stopPrank();
    }

    /// Retiring a template stops NEW launches only; a launched pair keeps trading, earning and paying.
    function test_registry_retireAffectsFutureLaunchesOnly() public {
        Launch memory L =
            _launch(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
        vm.prank(admin);
        registry.retireTemplate(wethTemplate);
        assertFalse(registry.template(wethTemplate).active);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(SquareHoleLauncher.TemplateInactive.selector, wethTemplate));
        launcher.createLaunch(
            _params(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, wethTemplate, IRewardLedger.PayoutAsset.Q)
        );
        _buyIn(L, alice, 0.1 ether);
        _buyIn(L, bob, 0.1 ether);
        assertGt(L.ledger.claimable(alice), 0, "the launched pair is untouched");
        assertEq(registry.pair(L.pairId).token, L.r.token);
    }

    function test_registry_recordPairOnlyLauncherAndOnce() public {
        Launch memory L =
            _launch(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
        vm.expectRevert(SquareHoleRegistry.NotLauncher.selector);
        registry.recordPair(L.r);
        vm.prank(address(launcher));
        vm.expectRevert(abi.encodeWithSelector(SquareHoleRegistry.PairExists.selector, L.pairId));
        registry.recordPair(L.r);
        vm.prank(admin);
        vm.expectRevert(SquareHoleRegistry.NotLauncher.selector);
        registry.recordPair(L.r);
        // The canonical id must match the token and chain.
        SquareHoleRegistry.PairRecord memory bad = L.r;
        bad.token = makeAddr("otherToken");
        vm.prank(address(launcher));
        vm.expectRevert(SquareHoleRegistry.InvalidRecord.selector);
        registry.recordPair(bad);
        bad = L.r;
        bad.chainId = 1;
        vm.prank(address(launcher));
        vm.expectRevert(SquareHoleRegistry.InvalidRecord.selector);
        registry.recordPair(bad);
    }

    function test_registry_pagination() public {
        bytes32[] memory ids = new bytes32[](3);
        for (uint256 i; i < 3; ++i) {
            ids[i] =
            _launch(SquareHoleRegistry.AssetKind.Token, 1e9, 1, wethTemplate, IRewardLedger.PayoutAsset.Q).pairId;
        }
        assertEq(registry.pairCount(), 3);
        bytes32[] memory page = registry.pairIds(1, 10);
        assertEq(page.length, 2);
        assertEq(page[0], ids[1]);
        assertEq(page[1], ids[2]);
        assertEq(registry.pairIds(3, 5).length, 0);
        assertEq(registry.pairOfToken(registry.pair(ids[0]).token).pairId, ids[0]);
    }

    /*//////////////////////////////////////////////////////////////
                                LAUNCHER
    //////////////////////////////////////////////////////////////*/

    function test_registryAndConverter_rejectZeroAddresses() public {
        vm.expectRevert(SquareHoleRegistry.ZeroAddress.selector);
        new SquareHoleRegistry(address(0), address(launcher));
        vm.expectRevert(SquareHoleRegistry.ZeroAddress.selector);
        new SquareHoleRegistry(admin, address(0));
        vm.expectRevert(SquareHoleClaimConverter.ZeroAddress.selector);
        new SquareHoleClaimConverter(IPoolManager(address(0)), registry);
        vm.expectRevert(SquareHoleClaimConverter.ZeroAddress.selector);
        new SquareHoleClaimConverter(pm, SquareHoleRegistry(address(0)));
    }

    function test_launcher_wiringChecks() public {
        vm.expectRevert(SquareHoleLauncher.WiringMismatch.selector); // the hook names a different launcher
        new SquareHoleLauncher(
            pm, hook, registry, treasury, address(converter), coreDeployer, collectionDeployer, fungibleDeployer
        );
        vm.expectRevert(SquareHoleLauncher.ZeroAddress.selector);
        new SquareHoleLauncher(
            pm, hook, registry, address(0), address(converter), coreDeployer, collectionDeployer, fungibleDeployer
        );
    }

    /// Deterministic: every per-launch address is known before the launch (deployer nonces).
    function test_launcher_addressesArePredictable() public {
        address ledger = coreDeployer.predict(0);
        address collector = coreDeployer.predict(1);
        address token = collectionDeployer.predict(0);
        address mirror = vm.computeCreateAddress(token, 1);
        Launch memory L =
            _launch(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
        assertEq(L.r.ledger, ledger);
        assertEq(L.r.collector, collector);
        assertEq(L.r.token, token);
        assertEq(L.r.mirror, mirror);
        assertEq(coreDeployer.predict(0), vm.computeCreateAddress(address(coreDeployer), coreDeployer.nextNonce()));
        address fungibleToken = fungibleDeployer.predict(0);
        Launch memory F = _launch(SquareHoleRegistry.AssetKind.Token, 1e9, 1, wethTemplate, IRewardLedger.PayoutAsset.Q);
        assertEq(F.r.token, fungibleToken);
        assertEq(F.r.mirror, address(0));
    }

    function test_launcher_deployersOnlyServeTheLauncher() public {
        vm.expectRevert(LaunchDeployerBase.NotLauncher.selector);
        coreDeployer.deployCollector(address(1), address(2), address(3), address(4), address(5), address(6));
        vm.expectRevert(LaunchDeployerBase.ZeroAddress.selector);
        new CoreDeployer(address(0));
    }

    function test_launcher_rejectsInvalidParams() public {
        SquareHoleLauncher.LaunchParams memory p =
            _params(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
        _expectLaunchRevert(_withName(p, ""), abi.encodeWithSelector(SquareHoleLauncher.InvalidParams.selector));
        _expectLaunchRevert(
            _withName(p, string(new bytes(65))), abi.encodeWithSelector(SquareHoleLauncher.InvalidParams.selector)
        );
        SquareHoleLauncher.LaunchParams memory q =
            _params(SquareHoleRegistry.AssetKind.Token, 1_000, 10, wethTemplate, IRewardLedger.PayoutAsset.Q);
        _expectLaunchRevert(q, abi.encodeWithSelector(SquareHoleLauncher.InvalidParams.selector)); // token: r must be 1
        q = _params(SquareHoleRegistry.AssetKind.Token, 1e9, 1, 77, IRewardLedger.PayoutAsset.Q);
        _expectLaunchRevert(q, abi.encodeWithSelector(SquareHoleLauncher.TemplateInactive.selector, uint32(77)));
        // Supply rules are the token templates' own (F10): always 1e9 tokens; a collection's N must divide 1e27 raw
        // and the optional r must equal 1e9 / N; a token's units must be exactly 1e9.
        q = _params(SquareHoleRegistry.AssetKind.Collection, 1_000, 3, wethTemplate, IRewardLedger.PayoutAsset.Q);
        _expectLaunchRevert(q, abi.encodeWithSelector(SquareHoleToken.InvalidFractionsPerNft.selector, uint256(3)));
        q = _params(SquareHoleRegistry.AssetKind.Collection, 1_000, 1, wethTemplate, IRewardLedger.PayoutAsset.Q);
        _expectLaunchRevert(q, abi.encodeWithSelector(SquareHoleToken.InvalidFractionsPerNft.selector, uint256(1)));
        q = _params(SquareHoleRegistry.AssetKind.Collection, 1_001, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
        _expectLaunchRevert(q, abi.encodeWithSelector(SquareHoleToken.InvalidCollectionSize.selector, uint256(1_001)));
        q = _params(SquareHoleRegistry.AssetKind.Collection, 3_333, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
        _expectLaunchRevert(q, abi.encodeWithSelector(SquareHoleToken.InvalidCollectionSize.selector, uint256(3_333)));
        q = _params(SquareHoleRegistry.AssetKind.Collection, 0, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
        _expectLaunchRevert(q, abi.encodeWithSelector(SquareHoleToken.InvalidCollectionSize.selector, uint256(0)));
        q = _params(SquareHoleRegistry.AssetKind.Token, 0, 1, wethTemplate, IRewardLedger.PayoutAsset.Q);
        _expectLaunchRevert(q, abi.encodeWithSelector(LaunchTokenCore.InvalidSupply.selector, uint256(0)));
        q = _params(SquareHoleRegistry.AssetKind.Token, 21_000_000, 1, wethTemplate, IRewardLedger.PayoutAsset.Q);
        _expectLaunchRevert(q, abi.encodeWithSelector(LaunchTokenCore.InvalidSupply.selector, uint256(21_000_000)));
        // A failed launch leaves no trace: nonces and the registry are unchanged.
        assertEq(coreDeployer.nextNonce(), 1);
        assertEq(registry.pairCount(), 0);
    }

    /// Review round A, finding 3: a collection's N is bounded by its template (one NFT starts at ≥ the template's
    /// minStartUnitValueQ); the bound is the registry's `maxCollectionUnits` (10,000 on the testnet templates) and it
    /// is checked before the token's own F10 rule; token launches have no NFTs and are not bounded by it.
    function test_launcher_boundsCollectionSizeByTemplateUnitValue() public {
        uint256 maxN = registry.maxCollectionUnits(wethTemplate);
        assertEq(maxN, WETH_START_FDV / WETH_MIN_UNIT_VALUE);
        assertEq(maxN, 10_000);
        uint256[3] memory ratios = [uint256(0), 1, 1e5];
        for (uint256 i; i < ratios.length; ++i) {
            _expectLaunchRevert(
                _params(
                    SquareHoleRegistry.AssetKind.Collection,
                    maxN + 1,
                    ratios[i],
                    wethTemplate,
                    IRewardLedger.PayoutAsset.Q
                ),
                abi.encodeWithSelector(SquareHoleLauncher.CollectionTooLarge.selector, maxN + 1, maxN)
            );
        }
        Launch memory L =
            _launch(SquareHoleRegistry.AssetKind.Collection, maxN, 1e5, wethTemplate, IRewardLedger.PayoutAsset.Q);
        assertEq(L.r.units, maxN);
        assertEq(L.r.fractionsPerNft, 1e5, "10,000 NFTs of 100,000 tokens");
        assertEq(L.r.initialSupply, 1e27);
        assertEq(L.r.startFdvQ, WETH_START_FDV);
        assertEq(L.r.minStartUnitValueQ, WETH_MIN_UNIT_VALUE);
        Launch memory F = _launch(SquareHoleRegistry.AssetKind.Token, 1e9, 1, wethTemplate, IRewardLedger.PayoutAsset.Q);
        assertEq(F.r.units, 1e9, "no NFTs: not bounded by the unit-value floor");
    }

    function test_launcher_acceptsNoEthAndGivesTheCreatorNothing() public {
        SquareHoleLauncher.LaunchParams memory p =
            _params(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
        vm.deal(creator, 1 ether);
        vm.prank(creator);
        (bool ok,) = address(launcher).call{value: 1}(abi.encodeCall(SquareHoleLauncher.createLaunch, (p)));
        assertFalse(ok, "createLaunch is not payable: no first buy, no creator deposit");
        vm.prank(creator);
        (bytes32 pairId, address token) = launcher.createLaunch(p);
        assertEq(SquareHoleToken(payable(token)).balanceOf(creator), 0);
        assertEq(weth.balanceOf(creator), 0);
        assertEq(registry.pair(pairId).creator, creator);
        assertEq(address(launcher).balance, 0);
    }

    /// F10: every collection size N that divides 1e27 and fits the template launches with exactly 1e9 tokens; one NFT
    /// is 1e27 / N raw (a whole number of tokens or not), and a whole-unit buy mints exactly one NFT. Includes the
    /// wizard presets, N = 1 (one NFT is the whole supply) and the non-1e9 divisors 1,024 / 5,120 / 8,192.
    function test_launcher_everyCollectionSizePreset() public {
        uint256[13] memory sizes =
            [uint256(1), 2, 100, 500, 1_000, 1_024, 2_000, 2_500, 4_000, 5_000, 5_120, 8_192, 10_000];
        for (uint256 i; i < sizes.length; ++i) {
            uint256 n = sizes[i];
            Launch memory L =
                _launch(SquareHoleRegistry.AssetKind.Collection, n, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
            assertEq(L.r.initialSupply, 1e27, "always 1e9 tokens");
            assertEq(L.r.units, n);
            assertEq(_collection(L).unit(), 1e27 / n);
            assertEq(_collection(L).unit() * n, 1e27, "exact unit");
            assertEq(L.r.fractionsPerNft, 1e9 % n == 0 ? 1e9 / n : 0);
            assertEq(_collection(L).fractionsPerNft(), L.r.fractionsPerNft);
            if (n == 1) continue; // one NFT is the whole supply
            _fundQuote(address(weth), alice, 100 ether);
            uint256 before = _mirror(L).balanceOf(alice);
            _trade(L, alice, true, false, _unit(L));
            assertEq(_mirror(L).balanceOf(alice) - before, 1, "one whole unit, one NFT");
        }
    }

    /// The optional r cross-check: 1e9 / N is accepted (and recorded), 0 derives the same record, anything else and a
    /// non-zero r for an N that does not divide 1e9 revert.
    function test_launcher_fractionsPerNftCrossCheck() public {
        Launch memory A =
            _launch(SquareHoleRegistry.AssetKind.Collection, 2_500, 400_000, wethTemplate, IRewardLedger.PayoutAsset.Q);
        // r = 0: the launcher creates T with the derived r = 1e9 / N, so the constructor arguments (what a source
        // verifier replays) equal the record.
        SquareHoleLauncher.LaunchParams memory pb =
            _params(SquareHoleRegistry.AssetKind.Collection, 2_500, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
        vm.expectCall(
            address(collectionDeployer),
            abi.encodeCall(
                CollectionTokenDeployer.deploy,
                (SquareHoleToken.LaunchTerms({
                        name: pb.name,
                        symbol: pb.symbol,
                        fractionsPerNft: 400_000,
                        collectionSize: 2_500,
                        initialHolder: address(hook),
                        feeCollector: coreDeployer.predict(1),
                        rewardLedger: coreDeployer.predict(0),
                        baseURI: pb.baseURI,
                        metadataManifestHash: pb.metadataManifestHash
                    }))
            )
        );
        vm.prank(creator);
        (bytes32 pairB,) = launcher.createLaunch(pb);
        Launch memory B = _load(pairB);
        assertEq(A.r.fractionsPerNft, 400_000);
        assertEq(B.r.fractionsPerNft, 400_000, "0 derives the same value");
        assertEq(_unit(A), _unit(B));
        _expectLaunchRevert(
            _params(SquareHoleRegistry.AssetKind.Collection, 2_500, 400_001, wethTemplate, IRewardLedger.PayoutAsset.Q),
            abi.encodeWithSelector(SquareHoleToken.InvalidFractionsPerNft.selector, uint256(400_001))
        );
        // 1e9 / 1,024 = 976,562.5 is not an integer: only r = 0 is accepted.
        _expectLaunchRevert(
            _params(SquareHoleRegistry.AssetKind.Collection, 1_024, 976_562, wethTemplate, IRewardLedger.PayoutAsset.Q),
            abi.encodeWithSelector(SquareHoleToken.InvalidFractionsPerNft.selector, uint256(976_562))
        );
    }

    /// Fuzz over N (valid and invalid, incl. non-divisors such as 3,333 and sizes above the template bound): a launch
    /// succeeds iff 1 ≤ N ≤ maxCollectionUnits and 1e27 % N == 0, always with exactly 1e27 raw T; otherwise it reverts
    /// with the documented error and leaves no trace.
    function testFuzz_launcher_collectionSizeRule(uint256 n) public {
        n = bound(n, 0, 20_000);
        uint256 maxN = registry.maxCollectionUnits(wethTemplate);
        SquareHoleLauncher.LaunchParams memory p =
            _params(SquareHoleRegistry.AssetKind.Collection, n, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
        if (n > maxN) {
            _expectLaunchRevert(p, abi.encodeWithSelector(SquareHoleLauncher.CollectionTooLarge.selector, n, maxN));
        } else if (n == 0 || 1e27 % n != 0) {
            _expectLaunchRevert(p, abi.encodeWithSelector(SquareHoleToken.InvalidCollectionSize.selector, n));
        } else {
            vm.prank(creator);
            (bytes32 pairId,) = launcher.createLaunch(p);
            SquareHoleRegistry.PairRecord memory r = registry.pair(pairId);
            assertEq(r.initialSupply, 1e27);
            assertEq(SquareHoleToken(payable(r.token)).unit() * n, 1e27);
            return;
        }
        assertEq(registry.pairCount(), 0, "a failed launch leaves no trace");
    }

    function _withName(SquareHoleLauncher.LaunchParams memory p, string memory name)
        internal
        pure
        returns (SquareHoleLauncher.LaunchParams memory)
    {
        p.name = name;
        return p;
    }

    function _expectLaunchRevert(SquareHoleLauncher.LaunchParams memory p, bytes memory err) internal {
        vm.prank(creator);
        vm.expectRevert(err);
        launcher.createLaunch(p);
    }
}
