// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxHook} from "../../../src/box/BoxHook.sol";
import {BoxHookBase} from "../../../src/box/BoxHookBase.sol";
import {BoxHookExtension} from "../../../src/box/BoxHookExtension.sol";
import {BoxLaunchRouter} from "../../../src/box/BoxLaunchRouter.sol";
import {BoxLayoutV1} from "../../../src/box/BoxLayoutV1.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {IBoxHook} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxLaunchRouter} from "../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {BoxKind, BoxPhase} from "../../../src/box/interfaces/BoxTypes.sol";
import {NativeLiquidityHelper} from "../../v2/utils/NativeV4Callers.sol";
import {LaunchTaxTestKit} from "../../v2/utils/LaunchTaxTestKit.sol";
import {S0Clones} from "../../spikes/S0Clones.sol";
import {BoxS45Base} from "./BoxS45Base.sol";
import {ForeignUnlocker, MockBoxCoordinator} from "./BoxS45Mocks.sol";
import {OpenTime} from "../utils/OpenTime.sol";

/// @notice S4: the hook's clone rules, the gate (BC-023), the routing class (BC-031), the closed pool (BC-032), the
/// creator buy (BC-116), the tax table (BC-024), the router's holdings and sweeps (BC-022) and dust (BC-033).
contract BoxHookGateTest is BoxS45Base {
    using StateLibrary for IPoolManager;

    NativeLiquidityHelper internal lp;
    ForeignUnlocker internal foreign;

    function setUp() public {
        _setUpWorld();
        lp = new NativeLiquidityHelper(pm);
        foreign = new ForeignUnlocker(pm);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Clones: only the coordinator initialises, once; an uninitialised clone and the implementations are inert

    function test_clone_onlyTheCoordinatorInitialisesOnce() public {
        Params memory p = _box0Params();
        Box memory b = _build(p);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotCoordinator.selector, alice));
        b.hook.initialize();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.NotCoordinator.selector, alice));
        b.router.initialize();
        _launch(b, p);
        vm.prank(address(b.coord));
        vm.expectRevert(IBoxHook.AlreadyInitialised.selector);
        b.hook.initialize();
        vm.prank(address(b.coord));
        vm.expectRevert(IBoxHook.AlreadyLaunched.selector);
        b.hook.launch();
        vm.prank(address(b.coord));
        vm.expectRevert(IBoxLaunchRouter.AlreadyInitialised.selector);
        b.router.initialize();
        assertEq(b.hook.deployBlock(), block.number);
        assertEq(b.hook.openAt(), block.timestamp + 12 * p.openDelay);
        assertEq(b.router.openAt(), b.hook.openAt(), "router and hook agree on the open");
    }

    /// S0 decision 9: a clone the coordinator never initialised refuses every state-changing entry point, and no
    /// pool can exist for it (`launch` is the only initialiser `beforeInitialize` lets through).
    function test_clone_uninitialisedIsInert() public {
        Box memory b = _build(_box0Params());
        vm.expectRevert(IBoxHook.NotInitialised.selector);
        b.hook.launch();
        vm.expectRevert(IBoxHook.NotInitialised.selector);
        b.hook.migrate(1);
        vm.expectRevert(IBoxHook.NotInitialised.selector);
        b.hook.deepen(alice);
        vm.prank(address(b.receiver));
        vm.expectRevert(IBoxHook.NotInitialised.selector);
        b.hook.harvest();
        vm.expectRevert(BoxLaunchRouter.NotInitialised.selector);
        b.router.sweep();
        // No pool: a swap on its key reverts in the PoolManager; a foreign initialise reverts in the hook.
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(IPoolManager.PoolNotInitialized.selector);
        swapper.swap{value: 1 ether}(b.key, true, -1 ether, 0);
        vm.expectRevert(
            _wrapped(
                address(b.hook),
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(IBoxHook.ForeignInitialize.selector)
            )
        );
        pm.initialize(b.key, b.curve.sqrtPriceUpperX96);
    }

    function test_clone_implementationsAreInert() public {
        // The coordinator argument read from the implementation's own code is nobody's address.
        vm.expectRevert();
        hookImpl.initialize();
        vm.expectRevert(BoxHookExtension.NotDelegated.selector);
        hookExt.launch();
        vm.expectRevert(BoxHookExtension.NotDelegated.selector);
        hookExt.deepen(alice);
        vm.expectRevert(BoxHookExtension.NotDelegated.selector);
        hookExt.unlockCallback("");
        vm.expectRevert(IBoxHook.NotPoolManager.selector);
        hookImpl.unlockCallback(abi.encode(uint8(3), bytes("")));
        vm.expectRevert();
        routerImpl.buy{value: 1}(1, 0, alice, block.timestamp);
        // The implementation is not at a flag address and is marked initialised.
        assertEq(hookImpl.deployBlock(), 1);
    }

    /// A clone whose address does not carry exactly 0x2AE0 cannot be initialised (FitPoolHook.sol:231-234).
    function test_clone_refusesAWrongAddress() public {
        Params memory p = _box0Params();
        Box memory b = _build(p);
        address wrong = address(uint160(address(b.hook)) ^ uint160(Hooks.AFTER_DONATE_FLAG));
        vm.etch(wrong, address(b.hook).code);
        vm.prank(address(b.coord));
        vm.expectRevert(abi.encodeWithSelector(Hooks.HookAddressNotValid.selector, wrong));
        BoxHook(wrong).initialize();
    }

    /// A real CREATE2 at a mined salt (BC-030's own-address part): the clone's code is 45 + 203 bytes.
    function test_clone_atAMinedCreate2Address() public {
        Params memory p = _box0Params();
        Box memory b = _build(p);
        bytes memory args = _hookArgs(b, p, address(b.router), address(b.receiver));
        assertEq(args.length, 203, "hook arguments");
        bytes memory init = S0Clones.initCode(address(hookImpl), args);
        (bytes32 salt, address predicted, uint256 tries) =
            S0Clones.mineHookSalt(address(this), keccak256(init), FLAGS, 0, 2_000_000);
        address created = S0Clones.deploy(init, salt, 0);
        assertEq(created, predicted);
        assertEq(uint160(created) & 0x3FFF, FLAGS, "flags 0x2AE0");
        assertTrue(uint160(created) >> 152 != 0x91, "no 0x91 prefix");
        assertEq(created.code.length, 45 + 203);
        emit log_named_uint("salt tries", tries);
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-023: the sniper at the open, for Now and opening times up to the 14-day horizon (F80: openAt is a clock time;
    // blocks come every 12 s from the creation, as on Ethereum: BoxOpenAtWindow.t.sol probes every second)

    function test_BC023_sniperAtTheOpen_now() public {
        _sniper(0);
    }

    function test_BC023_sniperAtTheOpen_in5Minutes() public {
        _sniper(5 minutes);
    }

    function test_BC023_sniperAtTheOpen_in1Hour() public {
        _sniper(1 hours);
    }

    function test_BC023_sniperAtTheOpen_in14Days() public {
        _sniper(uint32(BoxSpecV1.MAX_OPEN_AHEAD_SECONDS));
    }

    /// @dev openAt `ahead` seconds after the creation (0: Now, the creation's time + 1).
    function _sniper(uint32 ahead) internal {
        Params memory p = _standardParams(address(0));
        p.openDelay = 0;
        p.openAt = ahead == 0 ? 0 : uint32(block.timestamp + ahead);
        Box memory b = _buildAndLaunch(p);
        uint256 open = b.hook.openAt();
        assertEq(open, ahead == 0 ? block.timestamp + 1 : block.timestamp + ahead, "the open");
        // The creation block and the last slot before the open: every direct route refuses; the router too.
        bytes memory notOpen = _wrapped(
            address(b.hook), IHooks.beforeSwap.selector, abi.encodeWithSelector(IBoxHook.TradingNotOpen.selector, open)
        );
        _expectDirectBuyReverts(b, notOpen);
        _routerBuyReverts(b, abi.encodeWithSelector(IBoxLaunchRouter.NotOpen.selector, open));
        OpenTime.toSlot(open - 12);
        _expectDirectBuyReverts(b, notOpen);
        // A sell before the open reverts too (only the router, only in the creation block).
        deal(address(b.t), bob, 1e18);
        vm.startPrank(bob);
        b.t.approve(address(swapper), type(uint256).max);
        vm.expectRevert(notOpen);
        swapper.swap(b.key, false, -1e18, 0);
        vm.stopPrank();
        // The first block at or after openAt: a direct buy reverts BuyThroughLaunchRouter; the router buy pays
        // 93.1974% (step 0); sells pass.
        OpenTime.toSlot(open);
        bytes memory viaRouter = _wrapped(
            address(b.hook),
            IHooks.beforeSwap.selector,
            abi.encodeWithSelector(IBoxHook.BuyThroughLaunchRouter.selector, address(b.router), open + 384)
        );
        _expectDirectBuyReverts(b, viaRouter);
        (uint256 tax, uint256 out) = _routerBuy(b, alice, 1 ether);
        assertEq(tax, 931_974 * 1 ether / 1e6, "93.1974% in step 0");
        assertGt(out, 0);
        vm.prank(alice);
        b.t.transfer(bob, out / 2);
        assertGt(_sell(b, bob, out / 2), 0, "sells pass in the window");
        // The block in step 31 (from openAt + 372 s): still router only, 8.0565%.
        OpenTime.toSlot(open + 372);
        _expectDirectBuyReverts(b, viaRouter);
        (tax,) = _routerBuy(b, alice, 1 ether);
        assertEq(tax, 80_565 * 1 ether / 1e6, "8.0565% in step 31");
        // The first block from openAt + 384 s: every route with the 1% alone; the router refuses.
        OpenTime.toSlot(open + 384);
        (uint256 got,) = _buy(b, carol, 0.1 ether, 0);
        assertGt(got, 0, "direct buy after the window");
        _routerBuyReverts(b, abi.encodeWithSelector(IBoxLaunchRouter.WindowClosed.selector, open + 384));
    }

    function _expectDirectBuyReverts(Box memory b, bytes memory reason) internal {
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(reason);
        swapper.swap{value: 0.01 ether}(b.key, true, -0.01 ether, 0);
    }

    function _routerBuy(Box memory b, address who, uint256 qIn) internal returns (uint256 tax, uint256 out) {
        vm.deal(who, who.balance + qIn);
        uint256 taxBefore = b.router.totalTaxCollected();
        vm.prank(who);
        out = b.router.buy{value: qIn}(qIn, 0, who, block.timestamp);
        tax = b.router.totalTaxCollected() - taxBefore;
    }

    function _routerBuyReverts(Box memory b, bytes memory reason) internal {
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(reason);
        b.router.buy{value: 0.01 ether}(0.01 ether, 0, bob, block.timestamp);
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-031: the routing class, BC-032: closed to outside liquidity in every phase

    function test_BC031_routingClassInEveryPhase() public {
        Box memory b = _buildAndLaunch(_box0Params());
        for (uint256 phase; phase < 5; ++phase) {
            _toPhase(b, phase);
            PoolKey memory k = b.hook.poolKey();
            assertEq(k.fee, 10_000, "static 1%");
            assertFalse(LPFeeLibrary.isDynamicFee(k.fee), "no dynamic fee");
            assertEq(k.tickSpacing, 60);
            assertEq(uint160(address(k.hooks)) & Hooks.ALL_HOOK_MASK, FLAGS, "flags 0x2AE0");
            assertFalse(Hooks.hasPermission(k.hooks, Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG));
            assertFalse(Hooks.hasPermission(k.hooks, Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG));
            assertEq(b.hook.REQUIRED_FLAGS(), FLAGS);
            // A foreign pool with the same hook cannot be initialised (another spacing).
            PoolKey memory foreignKey = PoolKey(k.currency0, k.currency1, 10_000, 120, k.hooks);
            vm.expectRevert(
                _wrapped(
                    address(b.hook),
                    IHooks.beforeInitialize.selector,
                    abi.encodeWithSelector(IBoxHook.ForeignInitialize.selector)
                )
            );
            pm.initialize(foreignKey, b.curve.sqrtPriceUpperX96);
        }
    }

    function test_BC032_closedToOutsideLiquidityInEveryPhase() public {
        Box memory b = _buildAndLaunch(_box0Params());
        for (uint256 phase; phase < 5; ++phase) {
            _toPhase(b, phase);
            _assertClosed(b);
        }
    }

    function _assertClosed(Box memory b) internal {
        vm.deal(address(this), 10 ether);
        b.t.approve(address(lp), type(uint256).max);
        deal(address(b.t), address(this), 1e24);
        bytes memory locked = _wrapped(
            address(b.hook),
            IHooks.beforeAddLiquidity.selector,
            abi.encodeWithSelector(IBoxHook.LiquidityLocked.selector)
        );
        vm.expectRevert(locked);
        lp.modify{value: 1 ether}(b.key, BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, 1);
        vm.expectRevert(locked);
        lp.modify{value: 1 ether}(b.key, BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, 1e18);
        vm.expectRevert(
            _wrapped(
                address(b.hook),
                IHooks.beforeRemoveLiquidity.selector,
                abi.encodeWithSelector(IBoxHook.LiquidityLocked.selector)
            )
        );
        lp.modify(b.key, b.curve.tickLower, b.curve.tickUpper, -1);
        vm.expectRevert(
            _wrapped(
                address(b.hook),
                IHooks.beforeDonate.selector,
                abi.encodeWithSelector(IBoxHook.DonationsDisabled.selector)
            )
        );
        foreign.donate{value: 1}(b.key);
    }

    /// @dev 0 upcoming, 1 window, 2 bonding, 3 closed, 4 graduated.
    function _toPhase(Box memory b, uint256 phase) internal {
        if (phase == 0) {
            assertEq(uint256(b.hook.phase()), uint256(BoxPhase.Upcoming));
        } else if (phase == 1) {
            OpenTime.toStep(b.hook.openAt(), 0);
            assertEq(uint256(b.hook.phase()), uint256(BoxPhase.Window));
        } else if (phase == 2) {
            _skipWindow(b);
            assertEq(uint256(b.hook.phase()), uint256(BoxPhase.Bonding));
        } else if (phase == 3) {
            _close(b, carol);
            assertEq(uint256(b.hook.phase()), uint256(BoxPhase.Closed));
        } else {
            b.coord.graduate();
            assertEq(uint256(b.hook.phase()), uint256(BoxPhase.Graduated));
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-116: the creator buy

    function test_BC116_creatorBuy_halfEth_delay1() public {
        _creatorBuy(0.5 ether, 1);
    }

    function test_BC116_creatorBuy_raiseMinusOneWei_delay25() public {
        _creatorBuy(BOX0_RAISE - 1, 25);
    }

    function test_BC116_creatorBuy_none() public {
        Params memory p = _standardParams(address(0));
        Box memory b = _buildAndLaunch(p);
        assertFalse(b.router.creatorBought());
    }

    /// The raise itself: the router refuses only a buy that reaches P1; the raise is refused earlier by the spec's
    /// validate() (OUT_OF_RANGE at creatorBuy, BC-116; S1 vectors, S7's createBox). After the 1% fee it ends below P1.
    function test_BC116_creatorBuy_theRaiseIsTheSpecsRefusalNotTheRouters() public {
        Box memory b = _creatorBuy(BOX0_RAISE, 1);
        assertFalse(b.hook.closed());
    }

    /// A creator buy that would reach P1 is refused and the whole launch reverts (nothing created).
    function test_BC116_creatorBuy_thatWouldCloseIsRefused() public {
        Params memory p = _standardParams(address(0));
        p.creator = carol;
        p.creatorBuy = BOX0_RAISE * 102 / 100;
        Box memory b = _build(p);
        vm.deal(address(this), 10 ether);
        vm.expectRevert(IBoxLaunchRouter.CreatorBuyClosesCurve.selector);
        b.coord.launch{value: BoxSpecV1.BOOTSTRAP_ETH + p.creatorBuy}(p.creator, p.creatorBuy);
    }

    function test_BC116_noOtherUntaxedOrPreOpenBuy() public {
        Params memory p = _standardParams(address(0));
        p.creator = carol;
        p.creatorBuy = 0.5 ether;
        Box memory b = _buildAndLaunch(p);
        vm.deal(alice, 2 ether);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.NotCoordinator.selector, alice));
        b.router.creatorBuy{value: 0.1 ether}(alice, 0.1 ether);
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.NotCoordinator.selector, alice));
        b.router.bootstrap{value: BoxSpecV1.BOOTSTRAP_ETH}();
        vm.stopPrank();
        vm.deal(address(b.coord), 1 ether);
        vm.startPrank(address(b.coord));
        vm.expectRevert(IBoxLaunchRouter.AlreadyCreatorBought.selector);
        b.router.creatorBuy{value: 0.1 ether}(carol, 0.1 ether);
        vm.expectRevert(IBoxLaunchRouter.AlreadyBootstrapped.selector);
        b.router.bootstrap{value: BoxSpecV1.BOOTSTRAP_ETH}();
        vm.stopPrank();
        // A sniper's direct buy in the creation block reverts (BC-023).
        _expectDirectBuyReverts(
            b,
            _wrapped(
                address(b.hook),
                IHooks.beforeSwap.selector,
                abi.encodeWithSelector(IBoxHook.TradingNotOpen.selector, b.hook.openAt())
            )
        );
        // The router's creator buy outside the creation block: AfterOpen once the window is reached, and the hook's
        // gate refuses any pre-open swap outside the creation block anyway.
        OpenTime.toStep(b.hook.openAt(), 0);
        vm.prank(address(b.coord));
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.AlreadyCreatorBought.selector));
        b.router.creatorBuy{value: 0.1 ether}(carol, 0.1 ether);
    }

    function test_BC116_box0HasNoCreatorBuy() public {
        Params memory p = _box0Params();
        p.creator = carol;
        p.creatorBuy = 0.1 ether;
        Box memory b = _build(p);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(BoxLaunchRouter.NoCreatorBuy.selector);
        b.coord.launch{value: BoxSpecV1.BOOTSTRAP_ETH + p.creatorBuy}(p.creator, p.creatorBuy);
    }

    function _creatorBuy(uint256 amount, uint32 delay) internal returns (Box memory b) {
        Params memory p = _standardParams(address(0));
        p.openDelay = delay;
        p.creator = carol;
        p.creatorBuy = amount;
        b = _build(p);
        vm.deal(address(this), BoxSpecV1.BOOTSTRAP_ETH + amount);
        vm.expectEmit(true, false, false, false, address(b.router));
        emit IBoxLaunchRouter.CreatorBought(carol, amount, 0);
        b.coord.launch{value: BoxSpecV1.BOOTSTRAP_ETH + amount}(carol, amount);
        assertTrue(b.router.creatorBought());
        assertGt(b.t.balanceOf(carol), 0, "T to the creator");
        assertEq(b.router.totalTaxCollected(), 0, "untaxed");
        assertEq(address(b.router).balance, 0, "the router keeps nothing of it");
        assertFalse(b.hook.closed(), "below P1");
        assertGt(_sqrtP(b), b.curve.sqrtPriceLowerX96, "price above P1");
        assertEq(uint256(b.hook.phase()), uint256(BoxPhase.Upcoming));
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-024: one tax table for every box

    function test_BC024_oneTaxTableFitsEveryBox() public view {
        uint24[32] memory table = routerImpl.taxTable();
        assertEq(keccak256(abi.encode(table)), BoxSpecV1.LAUNCH_TAX_TABLE_HASH, "the version's table hash");
        for (uint256 i; i < 32; ++i) {
            assertEq(uint256(table[i]), LaunchTaxTestKit.pips(i), "recomputed from k");
        }
        assertEq(routerImpl.taxPips(32), 0);
        // k is the same for every layout: the span is fixed at 26,880 ticks, so P1 / P0 is the same ratio.
        uint256[5] memory raises = [uint256(0.5 ether), 1 ether, BOX0_RAISE, 10 ether, 100 ether];
        for (uint256 i; i < raises.length; ++i) {
            BoxLayoutV1.Curve memory c = BoxLayoutV1.curve(raises[i], false);
            assertEq(c.tickUpper - c.tickLower, 26_880, "span");
            uint256 num = uint256(c.sqrtPriceLowerX96) * c.sqrtPriceLowerX96 / (1 << 64);
            uint256 den = uint256(c.sqrtPriceUpperX96) * c.sqrtPriceUpperX96 / (1 << 64);
            uint256 invK = num * 1e6 / den;
            if ((num * 1e6 % den) * 2 >= den) ++invK;
            assertEq(1e6 - invK, table[0], "tax(0) = 1 - 1/k for every raise");
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-022: the router holds only its tax, which goes only where the box kind says

    /// F77 (superseding F68 (1b)): box 0's router follows every box's rule. It holds only the unswept tax, names no
    /// Safe, and after graduation its sweep() makes the tax box 0's own depth budget; the tax never reaches the Safe.
    function test_BC022_box0TaxWaitsThenBecomesDepth() public {
        Box memory b = _buildAndLaunch(_box0Params());
        OpenTime.toStep(b.hook.openAt(), 0);
        (uint256 tax1,) = _routerBuy(b, alice, 1 ether);
        _roll(3);
        (uint256 tax2,) = _routerBuy(b, bob, 2 ether);
        assertEq(address(b.router).balance, tax1 + tax2, "holds exactly the unswept tax");
        // Forced ETH is swept with the tax (no receive: a plain send reverts).
        (bool ok,) = address(b.router).call{value: 1}("");
        assertFalse(ok, "plain ETH refused");
        vm.deal(address(b.router), address(b.router).balance + 7);
        vm.expectRevert(IBoxLaunchRouter.NotGraduated.selector);
        b.router.sweep();
        _skipWindow(b);
        _closeAndGraduate(b);
        (uint256 q0,) = b.hook.depthBudget();
        uint256 swept = b.router.sweep();
        assertEq(swept, tax1 + tax2 + 7);
        (uint256 q1,) = b.hook.depthBudget();
        assertEq(q1 - q0, swept, "the tax became box 0's own depth budget (the hook's Q claims)");
        assertEq(safe.balance, 0, "never the Safe");
        assertEq(address(b.router).balance, 0);
        assertEq(b.router.totalSwept(), swept);
    }

    function test_BC022_standardTaxWaitsThenBecomesDepth() public {
        Box memory b = _buildAndLaunch(_standardParams(address(0)));
        OpenTime.toStep(b.hook.openAt(), 5);
        (uint256 tax,) = _routerBuy(b, alice, 1 ether);
        vm.expectRevert(IBoxLaunchRouter.NotGraduated.selector);
        b.router.sweep();
        _skipWindow(b);
        _closeAndGraduate(b);
        (uint256 q0,) = b.hook.depthBudget();
        assertEq(b.router.sweep(), tax);
        (uint256 q1,) = b.hook.depthBudget();
        assertEq(q1 - q0, tax, "the tax became the hook's Q claims (its depth budget)");
        assertEq(safe.balance, 0, "never the Safe");
        assertEq(address(b.router).balance, 0);
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-033: dust

    function test_BC033_dustBlocksNothingAndCountsNothing() public {
        Box memory b = _buildAndLaunch(_standardParams(address(0)));
        _skipWindow(b);
        _buy(b, alice, 1 ether, 0);
        for (uint256 i; i < 5; ++i) {
            _buy(b, bob, 1, 0);
        }
        // ETH to the hook reverts (no receive); T sent to the receiver and coordinator is not a fee.
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(b.hook).call{value: 1}("");
        assertFalse(ok, "ETH to the hook reverts");
        deal(address(b.t), alice, 1e18);
        vm.startPrank(alice);
        b.t.transfer(address(b.receiver), 1e9);
        b.t.transfer(address(b.coord), 1e9);
        vm.stopPrank();
        (uint256 qb, uint256 tb) = b.receiver.booked();
        assertEq(qb | tb, 0);
        b.receiver.collect(keeper);
        // A second collect right away is below the minimum: it never pays more than a valid batch's tip.
        vm.expectRevert();
        b.receiver.collect(keeper);
        _closeAndGraduate(b);
        assertTrue(b.coord.graduated(), "dust never blocks graduation");
    }
}
