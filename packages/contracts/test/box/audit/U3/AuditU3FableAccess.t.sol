// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxHookExtension} from "../../../../src/box/BoxHookExtension.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxKind, BoxPhase, DeepenSkip, DepthKind} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {CoreImpls} from "../../conformance/core/CoreBox0Kit.sol";
import {AuditU3FableBase} from "./AuditU3FableBase.sol";

/// @notice SH-AUDIT-B0 U3 (Fable): access and roles (L2: P3.5, P3.6, P3.7), the hook's Uniswap v4 assumptions (L6:
/// P3.13) and the clone's deployment facts (L8: P3.17) on the factory's box 0 (mainnet build), from creation through
/// graduation. Sources: `BoxHook.sol:112-131` (initialize), `:134-142` (harvest), `:145-174` (the refused
/// callbacks), `:181-228` (the gate and the close), `BoxHookExtension.sol:52-56`, `:69-77`, `:140-142`
/// (`_onlyDelegated`); BC-031, BC-032, BC-100; `IBoxHook.sol:44-59`.
/// forge-config: default.evm_version = "osaka"
contract AuditU3FableAccessTest is AuditU3FableBase {
    using StateLibrary for IPoolManager;

    // ================================================================================================ L8: deployment

    /// P3.17: every clone argument the hook reads equals the planner's (the kit's addresses, curve and spec), the
    /// implementation immutables are the version's, and the clone's storage at creation is exactly the state word.
    function testProperty_AUDIT_U3_cloneArgumentsMatchThePlanner() public view {
        CoreImpls memory impls = kit.impls();
        PoolKey memory k = hook.poolKey();
        assertEq(Currency.unwrap(k.currency0), address(0), "Q is native ETH, currency0");
        assertEq(Currency.unwrap(k.currency1), a.token, "T is currency1");
        assertEq(k.fee, BoxSpecV1.LP_FEE, "static 1% fee");
        assertEq(k.tickSpacing, BoxSpecV1.TICK_SPACING, "spacing 60");
        assertEq(address(k.hooks), a.hook, "the key names this hook");
        assertEq(PoolId.unwrap(hook.poolId()), PoolId.unwrap(poolId), "poolId == keccak256(key)");
        assertEq(uint8(hook.kind()), uint8(BoxKind.Box0));
        assertEq(hook.token(), a.token);
        assertEq(hook.q(), address(0));
        assertEq(hook.coordinator(), a.coordinator);
        assertEq(hook.receiver(), a.receiver);
        assertEq(hook.launchRouter(), a.launchRouter);
        assertEq(address(hook.priceAverage()), a.executor, "box 0's average is FIT's executor");
        assertEq(hook.raise(), raise);
        assertEq(hook.raise(), coordinator.raise(), "one raise for hook and coordinator");
        (int24 lo, int24 hi, uint128 l) = hook.curve();
        assertEq(lo, curve.tickLower, "curve lower tick (P1)");
        assertEq(hi, curve.tickUpper, "curve upper tick (P0)");
        assertEq(l, curve.liquidity, "curve liquidity (launched)");
        assertEq(hook.openAt(), createdAt + AUDIT_OPEN_DELAY, "openAt is the spec's");
        assertEq(hook.windowEndsAt(), hook.openAt() + 384);
        assertEq(hook.deployBlock(), createdAtBlock);
        assertEq(hook.coordinatorImplementation(), impls.coordinator, "the version's coordinator implementation");
        assertEq(hook.extension(), impls.hookExtension, "the version's hook extension");
        assertEq(address(hook.poolManager()), address(pm));
        assertEq(hook.ARGS_LENGTH(), 203);
        assertEq(a.hook.code.length, 45 + 203, "EIP-1167 runtime plus 203 bytes of arguments");
        assertEq(hook.reserveCap(), raise * BoxSpecV1.GRADUATION_REWARD_CAP_BPS / 10_000, "D6: 0.1% of R");
        assertEq(hook.minAdd(), raise * 50 / 10_000, "MIN_ADD: 0.5% of R");
        assertEq(hook.deepenTipCap(), BoxSpecV1.FEE_BATCH_TIP_MAX_ETH);
        // The clone's storage at creation (BC-012 for the hook): one word, launched, deploy block, open time; no
        // reserve minted; nothing else.
        uint256 w = _word();
        assertEq(w & 1, 1, "launched bit");
        assertEq((w >> 8) & ((1 << 40) - 1), createdAtBlock, "deployBlock field");
        assertEq((w >> 48) & ((1 << 40) - 1), hook.openAt(), "openAt field");
        assertEq(w >> 88, 0, "closed, migrated, deepen and position bits all clear");
        assertEq(uint256(vm.load(a.hook, bytes32(uint256(1)))), 0, "reserveMinted 0");
        assertEq(uint256(vm.load(a.hook, bytes32(uint256(2)))), 0, "no third slot");
    }

    /// P3.17: the five position keys (curve salt 0; ask, bid, sentinel salt 1; the pair salt 3) are pairwise distinct,
    /// and the removed rungs' salt 2 names none of them.
    function testProperty_AUDIT_U3_positionSaltsNeverCoincide() public view {
        bytes32[6] memory keys = [
            _posKey(curve.tickLower, curve.tickUpper, SALT_CURVE),
            _posKey(MIN_T, curve.tickLower, SALT_L7),
            _posKey(curve.tickLower, MAX_T, SALT_L7),
            _posKey(curve.tickUpper, MAX_T, SALT_L7),
            _posKey(MIN_T, MAX_T, SALT_PAIR),
            _posKey(MIN_T, MAX_T, SALT_RUNGS_NEVER_USED)
        ];
        for (uint256 i; i < keys.length; ++i) {
            for (uint256 j = i + 1; j < keys.length; ++j) {
                assertTrue(keys[i] != keys[j], "position keys distinct");
            }
        }
        // A full-range position at salt 2 never exists, in any phase (BC-120).
        assertEq(_posL(MIN_T, MAX_T, SALT_RUNGS_NEVER_USED), 0);
    }

    function _posKey(int24 lower, int24 upper, bytes32 salt) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(a.hook, lower, upper, salt));
    }

    // ================================================================================================ L6: v4 facts

    /// P3.13: the mined address carries exactly the six flags (0x2AE0), no return-delta flag, no 0x91 prefix; the fee
    /// is static (no dynamic-fee flag); `getHookPermissions` agrees with the address; v4's own validation passes.
    function testProperty_AUDIT_U3_flagsExactly2AE0NoReturnDeltaStaticFee() public view {
        uint160 addr = uint160(a.hook);
        assertEq(addr & Hooks.ALL_HOOK_MASK, 0x2AE0, "flags exactly 0x2AE0");
        assertEq(hook.REQUIRED_FLAGS(), 0x2AE0);
        assertEq(hook.REQUIRED_FLAGS(), BoxSpecV1.HOOK_FLAGS);
        assertEq(addr & Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG, 0, "no beforeSwap return delta");
        assertEq(addr & Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG, 0, "no afterSwap return delta");
        assertEq(addr & Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG, 0);
        assertEq(addr & Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG, 0);
        assertTrue(addr >> 152 != BoxSpecV1.HOOK_FORBIDDEN_ADDRESS_PREFIX, "no 0x91 prefix");
        assertFalse(LPFeeLibrary.isDynamicFee(poolKey.fee), "static fee");
        assertTrue(Hooks.isValidHookAddress(IHooks(a.hook), poolKey.fee), "v4 accepts the address for a static fee");
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.beforeInitialize && p.beforeAddLiquidity && p.beforeRemoveLiquidity && p.beforeSwap);
        assertTrue(p.afterSwap && p.beforeDonate);
        assertFalse(p.afterInitialize || p.afterAddLiquidity || p.afterRemoveLiquidity || p.afterDonate);
        assertFalse(p.beforeSwapReturnDelta || p.afterSwapReturnDelta);
        assertFalse(p.afterAddLiquidityReturnDelta || p.afterRemoveLiquidityReturnDelta);
        Hooks.validateHookPermissions(IHooks(a.hook), p);
        (,,, uint24 lpFee) = pm.getSlot0(poolId);
        assertEq(lpFee, 10_000, "the pool's LP fee is the static 1%");
    }

    /// P3.13: the hook's `extsload` reads (slot0, the active liquidity, its positions' liquidity, v4's unlocked slot)
    /// agree with `StateLibrary`'s values in every phase: the views built on them equal StateLibrary's, the close
    /// (built on slot0) fires exactly when StateLibrary's price reaches √P1, and the unlocked slot the hook reads is
    /// the one an unlock sets.
    function testProperty_AUDIT_U3_extsloadReadsMatchStateLibrary() public {
        _assertViewsMatchState();
        _toBonding();
        _assertViewsMatchState();
        // The unlocked slot: set inside any unlock, clear outside; the hook reads the same slot (ForeignUnlock).
        assertEq(pm.exttload(0xc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab23), bytes32(0));
        (bytes4 cb, bytes4 dp, bytes4 cl) = outsider.probe(a.hook, a.receiver);
        assertEq(uint256(outsider.unlockedSlotSeen()), 1, "v4's unlocked slot reads 1 inside an unlock");
        assertEq(cb, IBoxHook.NotPoolManager.selector, "a foreign unlocker's direct callback");
        assertEq(dp, IBoxHook.ForeignUnlock.selector, "deepen from inside a foreign unlock");
        assertEq(cl, IBoxHook.ForeignUnlock.selector, "collect (harvest) from inside a foreign unlock");
        _toClosed();
        _assertViewsMatchState();
        _toGraduated();
        _assertViewsMatchState();
        (uint128 ask, uint128 bid, uint128 sentinel) = hook.graduatedLayout();
        assertGt(ask, 0);
        assertGt(bid, 0);
        assertGt(sentinel, 0);
        uint128 active = pm.getLiquidity(poolId);
        assertTrue(active == ask || active == bid, "the active liquidity at P1 is the ask's or the bid's");
    }

    function _assertViewsMatchState() internal view {
        uint128[5] memory l = _positions();
        (, , uint128 curveL) = hook.curve();
        assertEq(curveL, hook.migratedAtBlock() == 0 ? l[0] : 0, "curve() liquidity vs StateLibrary");
        (uint128 ask, uint128 bid, uint128 sentinel) = hook.graduatedLayout();
        assertEq(ask, l[1], "ask vs StateLibrary");
        assertEq(bid, l[2], "bid vs StateLibrary");
        assertEq(sentinel, l[3], "sentinel vs StateLibrary");
        assertEq(hook.pairedLiquidity(), l[4], "pair vs StateLibrary");
        (uint160 s,,,) = pm.getSlot0(poolId);
        if (hook.migratedAtBlock() == 0) {
            assertLe(s, curve.sqrtPriceUpperX96, "price never above the floor");
            assertEq(hook.closed(), s <= curve.sqrtPriceLowerX96, "closed exactly when StateLibrary's price <= P1");
        }
    }

    // ================================================================================================ L2: callers

    /// P3.5: `initialize` only from the coordinator clone, once; `launch` and `migrate` only by the coordinator, once;
    /// `harvest` only by the receiver; the extension refuses direct calls; the hook callbacks and `unlockCallback`
    /// refuse every caller but the PoolManager; the never-flagged callbacks refuse everyone.
    function testProperty_AUDIT_U3_callerRulesOnEveryEntryPoint() public {
        _toBonding();
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotCoordinator.selector, eoa[0]));
        hook.initialize();
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxHook.AlreadyInitialised.selector);
        hook.initialize();
        vm.prank(eoa[1]);
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotCoordinator.selector, eoa[1]));
        hook.launch();
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxHook.AlreadyLaunched.selector);
        hook.launch();
        vm.prank(eoa[2]);
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotCoordinator.selector, eoa[2]));
        hook.migrate(0);
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxHook.NotClosed.selector);
        hook.migrate(0);
        vm.prank(eoa[3]);
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotReceiver.selector, eoa[3]));
        hook.harvest();
        vm.prank(a.coordinator);
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotReceiver.selector, a.coordinator));
        hook.harvest();
        // The receiver itself may harvest (the receiver's claims grow; an inside move).
        _buy(eoa[3], 0.1 ether);
        vm.prank(a.receiver);
        (uint256 fq,,) = hook.harvest();
        assertGt(fq, 0, "the buy left Q fees on the curve");

        BoxHookExtension ext = BoxHookExtension(hook.extension());
        vm.expectRevert(BoxHookExtension.NotDelegated.selector);
        ext.launch();
        vm.expectRevert(BoxHookExtension.NotDelegated.selector);
        ext.migrate(0);
        vm.expectRevert(BoxHookExtension.NotDelegated.selector);
        ext.deepen(eoa[0]);
        vm.expectRevert(BoxHookExtension.NotDelegated.selector);
        ext.unlockCallback(abi.encode(uint8(4), bytes("")));
        vm.prank(address(pm));
        vm.expectRevert(BoxHookExtension.NotDelegated.selector);
        ext.unlockCallback(abi.encode(uint8(4), bytes("")));

        SwapParams memory sp = _buyParams(1, TickMath.MIN_SQRT_PRICE + 1);
        ModifyLiquidityParams memory mp = ModifyLiquidityParams(MIN_T, MAX_T, 1, bytes32(0));
        vm.expectRevert(IBoxHook.NotPoolManager.selector);
        hook.beforeInitialize(eoa[0], poolKey, curve.sqrtPriceUpperX96);
        vm.expectRevert(IBoxHook.NotPoolManager.selector);
        hook.beforeAddLiquidity(eoa[0], poolKey, mp, "");
        vm.expectRevert(IBoxHook.NotPoolManager.selector);
        hook.beforeRemoveLiquidity(eoa[0], poolKey, mp, "");
        vm.expectRevert(IBoxHook.NotPoolManager.selector);
        hook.beforeDonate(eoa[0], poolKey, 1, 1, "");
        vm.expectRevert(IBoxHook.NotPoolManager.selector);
        hook.beforeSwap(eoa[0], poolKey, sp, "");
        vm.expectRevert(IBoxHook.NotPoolManager.selector);
        hook.afterSwap(eoa[0], poolKey, sp, BalanceDelta.wrap(0), "");
        vm.expectRevert(IBoxHook.NotPoolManager.selector);
        hook.unlockCallback(abi.encode(uint256(3), bytes("")));
        vm.expectRevert(IBoxHook.HookNotImplemented.selector);
        hook.afterInitialize(eoa[0], poolKey, curve.sqrtPriceUpperX96, 0);
        vm.expectRevert(IBoxHook.HookNotImplemented.selector);
        hook.afterAddLiquidity(eoa[0], poolKey, mp, BalanceDelta.wrap(0), BalanceDelta.wrap(0), "");
        vm.expectRevert(IBoxHook.HookNotImplemented.selector);
        hook.afterRemoveLiquidity(eoa[0], poolKey, mp, BalanceDelta.wrap(0), BalanceDelta.wrap(0), "");
        vm.expectRevert(IBoxHook.HookNotImplemented.selector);
        hook.afterDonate(eoa[0], poolKey, 1, 1, "");
        // As the PoolManager (what v4 would send): the refusals are the hook's own, and a harvest callback outside
        // an unlock cannot do anything (v4 is locked).
        vm.prank(address(pm));
        vm.expectRevert(IBoxHook.ForeignInitialize.selector);
        hook.beforeInitialize(eoa[0], poolKey, curve.sqrtPriceUpperX96);
        vm.prank(address(pm));
        vm.expectRevert(IBoxHook.LiquidityLocked.selector);
        hook.beforeAddLiquidity(eoa[0], poolKey, mp, "");
        vm.prank(address(pm));
        vm.expectRevert(IBoxHook.LiquidityLocked.selector);
        hook.beforeRemoveLiquidity(eoa[0], poolKey, mp, "");
        vm.prank(address(pm));
        vm.expectRevert(IBoxHook.DonationsDisabled.selector);
        hook.beforeDonate(eoa[0], poolKey, 1, 1, "");
        vm.prank(address(pm));
        vm.expectRevert(IPoolManager.ManagerLocked.selector);
        hook.unlockCallback(abi.encode(uint256(3), bytes("")));

        // `deepen` before graduation (bonding, then closed): the first guard, nothing written, no poke of the ring.
        _assertDeepenNotGraduated();
        _toClosed();
        _assertDeepenNotGraduated();
        _toGraduated();
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxHook.AlreadyMigrated.selector);
        hook.migrate(0);
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxHook.AlreadyLaunched.selector);
        hook.launch();
        _assertGhostLedger();
    }

    function _assertDeepenNotGraduated() internal {
        uint256 w0 = _word();
        int24 sample0 = executor.latestSampleTick();
        vm.record();
        (DepthKind kind, DeepenSkip skip, uint256 q, uint256 t, uint256 tip) = _deepen(eoa[4], eoa[4]);
        (, bytes32[] memory writes) = vm.accesses(a.hook);
        assertEq(uint8(skip), uint8(DeepenSkip.NotGraduated), "NotGraduated before migrate");
        assertEq(uint8(kind), uint8(DepthKind.None));
        assertEq(q | t | tip, 0);
        assertEq(writes.length, 0, "a skip writes nothing");
        assertEq(_word(), w0);
        assertEq(executor.latestSampleTick(), sample0, "the ring is not poked before the cooldown guard");
    }

    /// P3.6 (BC-031, BC-032): in every phase (created, window, bonding, closed, graduated) a second initialisation
    /// of a pool keyed to this hook (the same key or another fee), an outside add (1 wei and large, full range and
    /// on the curve), an outside removal or zero-liquidity poke, and a donation all revert in the hook.
    function testProperty_AUDIT_U3_poolClosedToOutsidersInEveryPhase() public {
        _assertClosedPool("created");
        _toWindow();
        _assertClosedPool("window");
        _toBonding();
        _assertClosedPool("bonding");
        _toClosed();
        _assertClosedPool("closed");
        _toGraduated();
        _assertClosedPool("graduated");
        _assertGhostLedger();
    }

    function _assertClosedPool(string memory phase) internal {
        bytes memory foreignInit =
            _hookRevert(IHooks.beforeInitialize.selector, abi.encodeWithSelector(IBoxHook.ForeignInitialize.selector));
        vm.prank(eoa[0]);
        vm.expectRevert(foreignInit);
        pm.initialize(poolKey, curve.sqrtPriceUpperX96);
        PoolKey memory other = poolKey;
        other.fee = 3_000;
        vm.prank(eoa[0]);
        vm.expectRevert(foreignInit);
        pm.initialize(other, curve.sqrtPriceUpperX96);
        other = poolKey;
        other.tickSpacing = 10;
        vm.prank(eoa[0]);
        vm.expectRevert(foreignInit);
        pm.initialize(other, TickMath.MIN_SQRT_PRICE + 1);

        bytes memory lockedAdd =
            _hookRevert(IHooks.beforeAddLiquidity.selector, abi.encodeWithSelector(IBoxHook.LiquidityLocked.selector));
        bytes memory lockedRemove = _hookRevert(
            IHooks.beforeRemoveLiquidity.selector, abi.encodeWithSelector(IBoxHook.LiquidityLocked.selector)
        );
        vm.deal(address(outsider), 100 ether);
        vm.expectRevert(lockedAdd);
        outsider.modify(poolKey, MIN_T, MAX_T, 1);
        vm.expectRevert(lockedAdd);
        outsider.modify(poolKey, curve.tickLower, curve.tickUpper, int256(uint256(curve.liquidity)));
        vm.expectRevert(lockedAdd);
        outsider.modify(poolKey, curve.tickLower - 60, curve.tickLower, 1e18);
        vm.expectRevert(lockedRemove);
        outsider.modify(poolKey, curve.tickLower, curve.tickUpper, -1);
        vm.expectRevert(lockedRemove);
        outsider.modify(poolKey, curve.tickLower, curve.tickUpper, 0);
        vm.expectRevert(lockedRemove);
        outsider.modify(poolKey, MIN_T, MAX_T, 0);
        bytes memory noDonation =
            _hookRevert(IHooks.beforeDonate.selector, abi.encodeWithSelector(IBoxHook.DonationsDisabled.selector));
        vm.expectRevert(noDonation);
        outsider.donate(poolKey, 1, 0);
        vm.expectRevert(noDonation);
        outsider.donate(poolKey, 0, 1);
        vm.expectRevert(noDonation);
        outsider.donate(poolKey, 1 ether, 1e24);
        assertEq(bytes(phase).length > 0, true);
    }

    /// P3.7: the gate per phase for every swap shape (exact-in buy, exact-out buy, exact-in sell, exact-out sell)
    /// through a Universal-Router-like caller: before the open everything is refused, in the creation block too; in
    /// the window buys are refused and sells pass until the window's last second; after it everything passes; closed,
    /// everything is refused until `graduate()`; after it the callbacks only return and write nothing.
    function testProperty_AUDIT_U3_swapGatePerPhaseAndShape() public {
        bytes memory notOpen = abi.encodeWithSelector(IBoxHook.TradingNotOpen.selector, hook.openAt());
        assertEq(vm.getBlockNumber(), createdAtBlock, "still the creation block");
        _everyShapeReverts(eoa[0], notOpen);
        _advance(1);
        _everyShapeReverts(eoa[0], notOpen);
        _warpTo(hook.openAt() - 1);
        _everyShapeReverts(eoa[0], notOpen);

        _toWindow();
        bytes memory viaRouter =
            abi.encodeWithSelector(IBoxHook.BuyThroughLaunchRouter.selector, a.launchRouter, hook.windowEndsAt());
        bytes memory viaRouterWrapped = _hookRevert(IHooks.beforeSwap.selector, viaRouter);
        _swapExpect(eoa[2], _buyParams(0.01 ether, TickMath.MIN_SQRT_PRICE + 1), 0.01 ether, viaRouterWrapped);
        _swapExpect(eoa[2], _buyOutParams(1e18, TickMath.MIN_SQRT_PRICE + 1), 0.01 ether, viaRouterWrapped);
        _swapExpect(eoa[2], _buyParams(1, TickMath.MIN_SQRT_PRICE + 1), 1, viaRouterWrapped);
        // Sells pass in the window (eoa[0] bought through the router): exact input and exact output.
        uint256 t0 = token.balanceOf(eoa[0]);
        _sell(eoa[0], t0 / 10);
        _sellExactOut(eoa[0], 0.0001 ether);
        assertLt(token.balanceOf(eoa[0]), t0);
        _warpTo(hook.windowEndsAt() - 1);
        _swapExpect(eoa[2], _buyParams(0.01 ether, TickMath.MIN_SQRT_PRICE + 1), 0.01 ether, viaRouterWrapped);
        assertEq(uint8(hook.phase()), uint8(BoxPhase.Window));
        _warpTo(hook.windowEndsAt());
        assertEq(uint8(hook.phase()), uint8(BoxPhase.Bonding));
        assertGt(_buy(eoa[2], 0.01 ether), 0, "the first second after the window buys through any route");
        _buyExactOut(eoa[2], 1e18, 0.01 ether);
        _sell(eoa[2], token.balanceOf(eoa[2]) / 2);
        _sellExactOut(eoa[2], 1);

        _toClosed();
        bytes memory closedReason = abi.encodeWithSelector(IBoxHook.CurveIsClosed.selector, hook.closedAtBlock());
        _everyShapeReverts(eoa[2], closedReason);
        _advance(100);
        _everyShapeReverts(eoa[2], closedReason);
        _everyShapeReverts(address(contractDrawer), closedReason);

        _toGraduated();
        vm.record();
        assertGt(_buy(eoa[2], 0.01 ether), 0);
        _buyExactOut(eoa[2], 1e18, 0.01 ether);
        _sell(eoa[2], 1e18);
        _sellExactOut(eoa[2], 1);
        (, bytes32[] memory writes) = vm.accesses(a.hook);
        assertEq(writes.length, 0, "after graduation no swap writes a hook slot (BC-018)");
        // The callbacks as v4 sends them: only return.
        SwapParams memory sp = _buyParams(1, TickMath.MIN_SQRT_PRICE + 1);
        vm.prank(address(pm));
        (bytes4 sel, BeforeSwapDelta d, uint24 feeOverride) = hook.beforeSwap(eoa[0], poolKey, sp, "");
        assertEq(sel, IHooks.beforeSwap.selector);
        assertEq(BeforeSwapDelta.unwrap(d), BeforeSwapDelta.unwrap(BeforeSwapDeltaLibrary.ZERO_DELTA));
        assertEq(feeOverride, 0);
        vm.prank(address(pm));
        (bytes4 sel2, int128 delta) = hook.afterSwap(eoa[0], poolKey, sp, BalanceDelta.wrap(0), "");
        assertEq(sel2, IHooks.afterSwap.selector);
        assertEq(delta, 0);
        _assertGhostLedger();
    }

    /// X17 for the hook: through its whole life (creation, window, bonding, batches, close, graduation, a depth add
    /// attempt) the hook writes only its two storage slots (the state word and `reserveMinted`), and the state word's
    /// fixed fields (launched, deployBlock, openAt) never change.
    function testProperty_AUDIT_U3_storageFootprintIsTwoSlotsAndFixedFieldsNeverChange() public {
        uint256 fixedBits = _word() & ((1 << 88) - 1);
        vm.record();
        _toGraduated();
        vm.prank(a.receiver);
        hook.harvest();
        (DepthKind kind, DeepenSkip skip,,,) = _deepen(keeper, keeper);
        assertEq(uint8(kind), uint8(DepthKind.None));
        assertEq(uint8(skip), uint8(DeepenSkip.Cooldown), "the first add counts from the migration");
        (, bytes32[] memory writes) = vm.accesses(a.hook);
        assertGt(writes.length, 0);
        for (uint256 i; i < writes.length; ++i) {
            assertTrue(uint256(writes[i]) <= 1, "only slots 0 and 1 are ever written");
        }
        assertEq(_word() & ((1 << 88) - 1), fixedBits, "launched, deployBlock and openAt never change");
        uint256 w = _word();
        assertEq((w >> 88) & ((1 << 40) - 1), hook.closedAtBlock());
        assertEq((w >> 128) & ((1 << 40) - 1), hook.migratedAtBlock());
        assertEq((w >> 168) & ((1 << 40) - 1), hook.lastDeepenBlock());
        assertEq((w >> 208) & ((1 << 24) - 1), 0, "the removed rungs' bits stay clear (F77)");
        assertEq((w >> 232) & 7, 7, "ask, bid and sentinel exist");
        assertEq((w >> 235) & 1, 0, "no pair yet");
        assertEq(w >> 236, 0, "nothing above the position bits");
        assertEq(uint256(vm.load(a.hook, bytes32(uint256(1)))), hook.reserveMinted());
        _assertGhostLedger();
    }
}
