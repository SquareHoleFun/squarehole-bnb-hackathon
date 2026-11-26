// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxHookBase} from "../../../../src/box/BoxHookBase.sol";
import {BoxHookExtension} from "../../../../src/box/BoxHookExtension.sol";
import {BoxLayoutV1} from "../../../../src/box/BoxLayoutV1.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxKind, BoxPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {AuditU3ClaudeActor, AuditU3ClaudeBase} from "./AuditU3ClaudeBase.sol";

/// @notice SH-AUDIT-B0-U3 (Claude), lenses L2, L6 and L8 on the factory's box 0 (mainnet build, Osaka): who may call
/// each hook entry point (P3.5), the pool closed to outside liquidity, donations and a second pool in every phase
/// (P3.6), the swap gate per phase through a router-like caller (P3.7), the v4 surface the hook promises (P3.13) and
/// the clone arguments and position keys (P3.17). Sources: `IBoxHook.sol:44-92`, `BoxHook.sol:104-228`,
/// `BoxHookExtension.sol: 37-142`, `BoxHookBase.sol:24-46`, BC-031, BC-032, BC-100, F80.
/// forge-config: default.evm_version = "osaka"
contract AuditU3ClaudeCurveTest is AuditU3ClaudeBase {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    address internal stranger = makeAddr("audit.u3.stranger");

    // ============================================================================================================
    // L6 · P3.13: the v4 surface

    /// Flags exactly 0x2AE0 in the address and in `getHookPermissions`, no return-delta flag, no 0x91 prefix, a static
    /// 1% fee, spacing 60, the pool's LP fee 1% (BC-031; `IBoxHook.sol:38-39`, `BoxHook.sol:52-56`).
    function testProperty_AUDIT_U3_flagsFeeSpacingNoReturnDelta() public view {
        assertEq(uint160(a.hook) & Hooks.ALL_HOOK_MASK, 0x2AE0, "the address carries exactly 0x2AE0");
        assertEq(hook.REQUIRED_FLAGS(), 0x2AE0);
        assertEq(uint256(BoxSpecV1.HOOK_FLAGS), 0x2AE0);
        assertTrue(uint160(a.hook) >> 152 != BoxSpecV1.HOOK_FORBIDDEN_ADDRESS_PREFIX, "no 0x91 prefix");
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.beforeInitialize && p.beforeAddLiquidity && p.beforeRemoveLiquidity && p.beforeSwap);
        assertTrue(p.afterSwap && p.beforeDonate);
        assertFalse(p.afterInitialize || p.afterAddLiquidity || p.afterRemoveLiquidity || p.afterDonate);
        assertFalse(p.beforeSwapReturnDelta || p.afterSwapReturnDelta, "no swap return delta");
        assertFalse(p.afterAddLiquidityReturnDelta || p.afterRemoveLiquidityReturnDelta, "no liquidity return delta");
        assertFalse(Hooks.hasPermission(IHooks(a.hook), Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG));
        assertFalse(Hooks.hasPermission(IHooks(a.hook), Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG));
        assertEq(poolKey.fee, 10_000, "static 1%");
        assertFalse(LPFeeLibrary.isDynamicFee(poolKey.fee));
        assertEq(poolKey.tickSpacing, 60);
        assertEq(address(poolKey.hooks), a.hook);
        assertEq(Currency.unwrap(poolKey.currency0), address(0), "Q (native ETH) is currency0");
        assertEq(Currency.unwrap(poolKey.currency1), a.token);
        (,, uint24 protocolFee, uint24 lpFee) = pm.getSlot0(poolKey.toId());
        assertEq(lpFee, 10_000);
        assertEq(protocolFee, 0);
        assertEq(hook.poolKey().fee, 10_000);
        assertEq(PoolId.unwrap(hook.poolKey().toId()), PoolId.unwrap(poolKey.toId()), "the hook's key is the pool's");
        assertEq(PoolId.unwrap(hook.poolId()), PoolId.unwrap(poolKey.toId()));
    }

    /// The hook's callbacks never change a trader's amounts: `beforeSwap` returns (selector, ZERO_DELTA, 0) and
    /// `afterSwap` (selector, 0), in the bonding phase (a sell, which the gate passes) and after graduation (BC-031
    /// "no hook call changes a trader's amounts").
    function testProperty_AUDIT_U3_callbacksReturnNoDelta() public {
        _toBonding();
        SwapParams memory sell = SwapParams(false, -1e18, TickMath.MAX_SQRT_PRICE - 1);
        BalanceDelta none;
        vm.startPrank(address(pm));
        (bytes4 s1, BeforeSwapDelta d1, uint24 fee1) = hook.beforeSwap(stranger, poolKey, sell, "");
        (bytes4 s2, int128 d2) = hook.afterSwap(stranger, poolKey, sell, none, "");
        vm.stopPrank();
        assertEq(s1, IHooks.beforeSwap.selector);
        assertEq(BeforeSwapDelta.unwrap(d1), BeforeSwapDelta.unwrap(BeforeSwapDeltaLibrary.ZERO_DELTA));
        assertEq(fee1, 0);
        assertEq(s2, IHooks.afterSwap.selector);
        assertEq(d2, 0);
        _toGraduated();
        SwapParams memory buy = SwapParams(true, -1e18, TickMath.MIN_SQRT_PRICE + 1);
        uint256 w0 = uint256(vm.load(a.hook, bytes32(0)));
        vm.startPrank(address(pm));
        (s1, d1, fee1) = hook.beforeSwap(stranger, poolKey, buy, "");
        (s2, d2) = hook.afterSwap(stranger, poolKey, buy, none, "");
        vm.stopPrank();
        assertEq(BeforeSwapDelta.unwrap(d1), 0);
        assertEq(fee1, 0);
        assertEq(d2, 0);
        assertEq(uint256(vm.load(a.hook, bytes32(0))), w0, "after migration the callbacks write nothing");
    }

    /// The hook's `extsload` reads equal v4's StateLibrary for the slots it reads (P3.13): every position view
    /// (curve, ask, bid, sentinel, pair) in every phase, the transient unlocked slot (Lock.IS_UNLOCKED_SLOT,
    /// `BoxHookBase.sol:80-81`) and the price a swap's `afterSwap` reads (a close at exactly P1 is seen).
    function testProperty_AUDIT_U3_extsloadReadsEqualStateLibrary() public {
        (int24 lo, int24 hi, uint128 l) = hook.curve();
        assertEq(lo, curve.tickLower);
        assertEq(hi, curve.tickUpper);
        assertEq(l, _curveL(), "curve liquidity: the argument equals the position v4 holds");
        assertEq(l, curve.liquidity);
        (uint128 ask, uint128 bid, uint128 sentinel) = hook.graduatedLayout();
        assertEq(ask | bid | sentinel, 0, "no L7 position before graduation");
        assertEq(hook.pairedLiquidity(), 0);
        assertEq(
            bytes32(uint256(keccak256("Unlocked")) - 1),
            0xc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab23,
            "Lock.IS_UNLOCKED_SLOT as the hook hard-codes it"
        );
        _toGraduated();
        (ask, bid, sentinel) = hook.graduatedLayout();
        assertEq(ask, _askL());
        assertEq(bid, _bidL());
        assertEq(sentinel, _sentinelL());
        assertEq(_curveL(), 0, "the curve position is gone");
        (,, l) = hook.curve();
        assertEq(l, 0, "and the view says so");
        assertEq(_sqrtP(), curve.sqrtPriceLowerX96, "graduation leaves the price at exactly P1 (BC-025)");
        // The transient slot reads non-zero only inside an unlock: deepen from inside one names it.
        (bool ok, bytes memory ret) = u3actor.callInside(a.hook, abi.encodeCall(IBoxHook.deepen, (stranger)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(IBoxHook.ForeignUnlock.selector), "ForeignUnlock, not AlreadyUnlocked");
    }

    // ============================================================================================================
    // L2 · P3.5: who may call what

    /// `initialize` only from the coordinator argument that is a clone of the version's coordinator, once (BC-100):
    /// anyone else is refused, the coordinator itself is refused the second time; the implementation is never a box.
    function testFuzz_AUDIT_U3_initializeOnlyCoordinatorCloneOnce(address caller) public {
        vm.assume(caller != a.coordinator);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotCoordinator.selector, caller));
        hook.initialize();
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxHook.AlreadyInitialised.selector);
        hook.initialize();
        BoxHook impl = BoxHook(_implementationOf(a.hook));
        assertEq(impl.deployBlock(), 1, "the implementation is marked initialised at deploy block 1");
        vm.prank(a.coordinator);
        vm.expectRevert();
        impl.initialize();
    }

    /// `launch` and `migrate` only by the coordinator, once each; `migrate` only after the close (`IBoxHook.sol:
    /// 172-179`). `harvest` only by the receiver (`BoxHook.sol:136`).
    function testFuzz_AUDIT_U3_launchMigrateHarvestCallers(address caller) public {
        vm.assume(caller != a.coordinator && caller != a.receiver);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotCoordinator.selector, caller));
        hook.launch();
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxHook.AlreadyLaunched.selector);
        hook.launch();
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotCoordinator.selector, caller));
        hook.migrate(1);
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxHook.NotClosed.selector);
        hook.migrate(1);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotReceiver.selector, caller));
        hook.harvest();
        _toGraduated();
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxHook.AlreadyMigrated.selector);
        hook.migrate(1);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotReceiver.selector, caller));
        hook.harvest();
        vm.prank(a.receiver);
        (uint256 q,,) = hook.harvest();
        q;
    }

    /// Every extension entry point reverts `NotDelegated` when called directly, from anyone, in every phase
    /// (`BoxHookExtension.sol:37-39`, `:140-142`); its storage is never written.
    function testProperty_AUDIT_U3_extensionRevertsUnlessDelegated() public {
        BoxHookExtension ext = BoxHookExtension(hook.extension());
        bytes[4] memory calls = [
            abi.encodeCall(BoxHookExtension.launch, ()),
            abi.encodeCall(BoxHookExtension.migrate, (uint256(1))),
            abi.encodeCall(BoxHookExtension.deepen, (stranger)),
            abi.encodeCall(BoxHookExtension.unlockCallback, (abi.encode(uint8(4), bytes(""))))
        ];
        address[3] memory callers = [stranger, a.coordinator, address(pm)];
        for (uint256 round; round < 2; ++round) {
            for (uint256 i; i < calls.length; ++i) {
                for (uint256 j; j < callers.length; ++j) {
                    vm.prank(callers[j]);
                    (bool ok, bytes memory ret) = address(ext).call(calls[i]);
                    assertFalse(ok, "a direct call to the extension");
                    assertEq(ret, abi.encodeWithSelector(BoxHookExtension.NotDelegated.selector));
                }
            }
            if (round == 0) _toGraduated();
        }
        assertEq(vm.load(address(ext), bytes32(0)), bytes32(0), "the extension's own storage stays empty");
        assertEq(vm.load(address(ext), bytes32(uint256(1))), bytes32(0));
    }

    /// Every PoolManager callback and `unlockCallback` refuse any caller but the PoolManager; the unused callbacks
    /// revert for everyone (`BoxHook.sol:144-259`).
    function testFuzz_AUDIT_U3_callbacksOnlyFromThePoolManager(address caller) public {
        vm.assume(caller != address(pm));
        _toBonding();
        SwapParams memory sp = SwapParams(false, -1, TickMath.MAX_SQRT_PRICE - 1);
        ModifyLiquidityParams memory mp = ModifyLiquidityParams(-60, 60, 1, bytes32(0));
        BalanceDelta none;
        bytes memory np = abi.encodeWithSelector(IBoxHook.NotPoolManager.selector);
        bytes[7] memory calls = [
            abi.encodeCall(IHooks.beforeInitialize, (caller, poolKey, uint160(1 << 96))),
            abi.encodeCall(IHooks.beforeAddLiquidity, (caller, poolKey, mp, "")),
            abi.encodeCall(IHooks.beforeRemoveLiquidity, (caller, poolKey, mp, "")),
            abi.encodeCall(IHooks.beforeDonate, (caller, poolKey, 1, 1, "")),
            abi.encodeCall(IHooks.beforeSwap, (caller, poolKey, sp, "")),
            abi.encodeCall(IHooks.afterSwap, (caller, poolKey, sp, none, "")),
            abi.encodeCall(BoxHook.unlockCallback, (abi.encode(uint8(3), bytes(""))))
        ];
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(caller);
            (bool ok, bytes memory ret) = a.hook.call(calls[i]);
            assertFalse(ok);
            assertEq(ret, np, "NotPoolManager");
        }
        bytes memory nope = abi.encodeWithSelector(IBoxHook.HookNotImplemented.selector);
        bytes[4] memory unused = [
            abi.encodeCall(IHooks.afterInitialize, (caller, poolKey, uint160(1 << 96), int24(0))),
            abi.encodeCall(IHooks.afterAddLiquidity, (caller, poolKey, mp, none, none, "")),
            abi.encodeCall(IHooks.afterRemoveLiquidity, (caller, poolKey, mp, none, none, "")),
            abi.encodeCall(IHooks.afterDonate, (caller, poolKey, 1, 1, ""))
        ];
        for (uint256 i; i < unused.length; ++i) {
            vm.prank(i % 2 == 0 ? caller : address(pm));
            (bool ok, bytes memory ret) = a.hook.call(unused[i]);
            assertFalse(ok);
            assertEq(ret, nope, "HookNotImplemented");
        }
    }

    // ============================================================================================================
    // L2 · P3.6: the pool stays closed in every phase

    /// In every phase (Upcoming in the creation block, Upcoming later, Window, Bonding, Closed, Graduated) an outside
    /// add of 1 wei and of 1e18 liquidity, a removal, a zero-liquidity poke (any salt), a donation and a second pool on
    /// this hook (static and dynamic fee, any spacing) all revert with the hook's reason (BC-031, BC-032, D3).
    function testProperty_AUDIT_U3_poolClosedToOutsidersInEveryPhase() public {
        for (uint256 phase; phase < 6; ++phase) {
            if (phase == 1) _advance(1);
            else if (phase == 2) _toWindow();
            else if (phase == 3) _toBonding();
            else if (phase == 4) _toClosed();
            else if (phase == 5) _toGraduated();
            _assertClosedToOutsiders();
        }
    }

    function _assertClosedToOutsiders() internal {
        _fund(address(u3actor), 1 ether);
        int256[4] memory deltas = [int256(1), 1e18, -1, 0];
        bytes32[2] memory salts = [bytes32(0), SALT_PAIR];
        for (uint256 i; i < deltas.length; ++i) {
            for (uint256 j; j < salts.length; ++j) {
                bytes4 cb = deltas[i] > 0 ? IHooks.beforeAddLiquidity.selector : IHooks.beforeRemoveLiquidity.selector;
                vm.expectRevert(_hookRevert(cb, abi.encodeWithSelector(IBoxHook.LiquidityLocked.selector)));
                u3actor.modify(poolKey, ModifyLiquidityParams(MIN_T, MAX_T, deltas[i], salts[j]), stranger);
            }
        }
        vm.expectRevert(
            _hookRevert(IHooks.beforeDonate.selector, abi.encodeWithSelector(IBoxHook.DonationsDisabled.selector))
        );
        u3actor.donate(poolKey, 1, 0, stranger);
        uint24[3] memory fees = [uint24(10_000), 3_000, LPFeeLibrary.DYNAMIC_FEE_FLAG];
        int24[3] memory spacings = [int24(60), 1, 200];
        for (uint256 i; i < fees.length; ++i) {
            for (uint256 j; j < spacings.length; ++j) {
                vm.expectRevert(
                    _hookRevert(
                        IHooks.beforeInitialize.selector, abi.encodeWithSelector(IBoxHook.ForeignInitialize.selector)
                    )
                );
                vm.prank(stranger);
                pm.initialize(_keyWith(fees[i], spacings[j], a.hook), uint160(1 << 96));
            }
        }
        u3actor.sweepTo(stranger);
    }

    /// No second pool can carry this hook: `initialize` of any key naming it (any currencies, fee, spacing and start
    /// price), by anyone, reverts, by v4's own checks or by the hook's `ForeignInitialize`; box 0's own key is already
    /// initialised (BC-031, BC-032; IBoxHook.sol:58-59, BoxHook.sol:144-148).
    function testFuzz_AUDIT_U3_noSecondPoolForAnyKey(
        address c0,
        address c1,
        uint24 fee,
        int24 spacing,
        uint160 sqrtPrice,
        address caller
    ) public {
        PoolKey memory k = PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, spacing, IHooks(a.hook));
        vm.prank(caller);
        try pm.initialize(k, sqrtPrice) returns (int24) {
            assertTrue(false, "a second pool initialised with box 0's hook");
        } catch {}
        vm.prank(caller);
        try pm.initialize(poolKey, sqrtPrice) returns (int24) {
            assertTrue(false, "box 0's own pool initialised twice");
        } catch {}
    }

    /// A stranger's clone of the BoxHook implementation (EIP-1167 to it, any 203 argument bytes: here box 0's with the
    /// stranger as the coordinator) stays inert (BC-100; `BoxHook.sol:111-115`): `initialize` refuses the stranger
    /// (not a clone of the version's coordinator), and the uninitialised clone refuses `launch`, `migrate`, `deepen`
    /// and `harvest` (`NotInitialised`) and every callback but from the PoolManager.
    function testProperty_AUDIT_U3_strangerHookCloneStaysInert() public {
        address impl = _implementationOf(a.hook);
        bytes memory args = new bytes(203);
        bytes memory code = a.hook.code;
        for (uint256 i; i < 203; ++i) {
            args[i] = code[45 + i];
        }
        bytes20 s = bytes20(stranger);
        for (uint256 i; i < 20; ++i) {
            args[143 + i] = s[i];
        }
        address clone = makeAddr("audit.u3.strangerHookClone");
        vm.etch(
            clone, bytes.concat(hex"363d3d373d3d3d363d73", bytes20(impl), hex"5af43d82803e903d91602b57fd5bf3", args)
        );
        BoxHook h = BoxHook(clone);
        assertEq(h.coordinator(), stranger, "the stranger's clone names the stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotCoordinator.selector, stranger));
        h.initialize();
        vm.startPrank(stranger);
        vm.expectRevert(IBoxHook.NotInitialised.selector);
        h.launch();
        vm.expectRevert(IBoxHook.NotInitialised.selector);
        h.migrate(1);
        vm.expectRevert(IBoxHook.NotInitialised.selector);
        h.deepen(stranger);
        vm.expectRevert(IBoxHook.NotInitialised.selector);
        h.harvest();
        vm.expectRevert(IBoxHook.NotPoolManager.selector);
        h.beforeSwap(stranger, poolKey, SwapParams(true, -1, TickMath.MIN_SQRT_PRICE + 1), "");
        vm.stopPrank();
        assertEq(h.deployBlock(), 0, "never initialised");
        assertEq(uint8(h.phase()), uint8(BoxPhase.None));
    }

    // ============================================================================================================
    // L2 · P3.7: the swap gate per phase, through a router-like caller

    /// Before the open, in the creation block and later: every swap from anyone but the launch router reverts
    /// `TradingNotOpen(openAt)`, buys and sells, exact input and output (`BoxHook.sol:192-195`; F80).
    function testProperty_AUDIT_U3_gateBeforeOpen() public {
        assertEq(vm.getBlockNumber(), createdAtBlock, "still the creation block");
        uint256 open = hook.openAt();
        bytes memory refused =
            _hookRevert(IHooks.beforeSwap.selector, abi.encodeWithSelector(IBoxHook.TradingNotOpen.selector, open));
        for (uint256 b; b < 3; ++b) {
            for (uint256 k; k < 4; ++k) {
                bool zeroForOne = k < 2;
                int256 amount = k % 2 == 0 ? int256(-1e15) : int256(1e15);
                uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
                AuditU3ClaudeActor.Leg[] memory legs = new AuditU3ClaudeActor.Leg[](1);
                legs[0] = _leg(zeroForOne, amount, limit, false);
                _fund(address(this), 1 ether);
                vm.expectRevert(refused);
                u3actor.swaps{value: 0.01 ether}(poolKey, legs, address(this), address(this));
            }
            if (b == 0) _advance(1);
            else _warpTo(open - 1);
        }
        assertLt(vm.getBlockTimestamp(), open);
    }

    /// In the window: a buy (`zeroForOne`) from anyone but the launch router reverts `BuyThroughLaunchRouter`, exact
    /// input or output, whatever its limit; sells pass through any route; the launch router's buy passes
    /// (`BoxHook.sol:196-198`).
    function testProperty_AUDIT_U3_gateWindow() public {
        _toWindow();
        bytes memory refused = _hookRevert(
            IHooks.beforeSwap.selector,
            abi.encodeWithSelector(IBoxHook.BuyThroughLaunchRouter.selector, a.launchRouter, hook.windowEndsAt())
        );
        uint160[2] memory limits = [TickMath.MIN_SQRT_PRICE + 1, curve.sqrtPriceLowerX96];
        for (uint256 k; k < 4; ++k) {
            AuditU3ClaudeActor.Leg[] memory legs = new AuditU3ClaudeActor.Leg[](1);
            legs[0] = _leg(true, k % 2 == 0 ? int256(-1e15) : int256(1e20), limits[k / 2], false);
            _fund(address(this), 1 ether);
            vm.expectRevert(refused);
            u3actor.swaps{value: 0.01 ether}(poolKey, legs, address(this), address(this));
        }
        // A sell through the router-like caller passes (exact input, then exact output).
        uint256 t = token.balanceOf(eoa[0]);
        vm.prank(eoa[0]);
        token.approve(address(u3actor), type(uint256).max);
        AuditU3ClaudeActor.Leg[] memory sells = new AuditU3ClaudeActor.Leg[](2);
        sells[0] = _leg(false, -int256(t / 4), TickMath.MAX_SQRT_PRICE - 1, false);
        sells[1] = _leg(false, int256(1e12), TickMath.MAX_SQRT_PRICE - 1, false);
        vm.prank(eoa[0]);
        (bool[] memory ok,,) = u3actor.swaps(poolKey, sells, eoa[0], eoa[0]);
        assertTrue(ok[0] && ok[1], "sells pass in the window");
        // The launch router's buy passes in the same block.
        assertGt(_windowBuy(eoa[3], 0.01 ether), 0, "the launch router's buy");
        assertEq(uint8(hook.phase()), uint8(BoxPhase.Window));
    }

    /// From the window's end every route buys and sells (bonding), and the window ends exactly at openAt + 384 s
    /// (the hook's view and gate agree at the boundary second).
    function testProperty_AUDIT_U3_gateEndsExactlyAtTheWindowEnd() public {
        _toWindow();
        uint256 end = hook.windowEndsAt();
        assertEq(end, hook.openAt() + 384);
        vm.warp(end - 1);
        assertEq(uint8(hook.phase()), uint8(BoxPhase.Window));
        AuditU3ClaudeActor.Leg[] memory legs = new AuditU3ClaudeActor.Leg[](1);
        legs[0] = _leg(true, -1e15, TickMath.MIN_SQRT_PRICE + 1, true);
        _fund(address(this), 1 ether);
        (bool[] memory ok,, bytes memory err) =
            u3actor.swaps{value: 0.01 ether}(poolKey, legs, address(this), address(this));
        assertFalse(ok[0], "one second before the end: refused");
        assertEq(_hookReason(err), IBoxHook.BuyThroughLaunchRouter.selector);
        vm.warp(end);
        assertEq(uint8(hook.phase()), uint8(BoxPhase.Bonding));
        (ok,,) = u3actor.swaps{value: 0.01 ether}(poolKey, legs, address(this), address(this));
        assertTrue(ok[0], "at the end second: any route buys");
        u3actor.sweepTo(address(this));
    }

    /// Closed: every swap reverts `CurveIsClosed(closedAtBlock)`, in the closing block and later, buys and sells, exact
    /// input and output, any limit, until `graduate()`; after it every shape passes and the callbacks write nothing.
    function testProperty_AUDIT_U3_gateClosedThenGraduated() public {
        _toClosed();
        uint256 closedAt = hook.closedAtBlock();
        bytes memory refused =
            _hookRevert(IHooks.beforeSwap.selector, abi.encodeWithSelector(IBoxHook.CurveIsClosed.selector, closedAt));
        uint256 t = token.balanceOf(eoa[1]);
        vm.prank(eoa[1]);
        token.approve(address(u3actor), type(uint256).max);
        for (uint256 b; b < 2; ++b) {
            for (uint256 k; k < 4; ++k) {
                bool zeroForOne = k < 2;
                int256 amount = k % 2 == 0 ? -int256(t / 8) : int256(1e12);
                if (zeroForOne) amount = k % 2 == 0 ? int256(-1e15) : int256(1e20);
                uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
                AuditU3ClaudeActor.Leg[] memory legs = new AuditU3ClaudeActor.Leg[](1);
                legs[0] = _leg(zeroForOne, amount, limit, false);
                _fund(eoa[1], 1 ether);
                vm.expectRevert(refused);
                vm.prank(eoa[1]);
                u3actor.swaps{value: 0.01 ether}(poolKey, legs, eoa[1], eoa[1]);
            }
            _advance(5);
        }
        assertEq(hook.closedAtBlock(), closedAt, "closed once, never rewritten");
        _toGraduated();
        uint256 w0 = uint256(vm.load(a.hook, bytes32(0)));
        AuditU3ClaudeActor.Leg[] memory any = new AuditU3ClaudeActor.Leg[](4);
        any[0] = _leg(true, -1e15, TickMath.MIN_SQRT_PRICE + 1, false);
        any[1] = _leg(true, 1e20, TickMath.MIN_SQRT_PRICE + 1, false);
        any[2] = _leg(false, -int256(t / 8), TickMath.MAX_SQRT_PRICE - 1, false);
        any[3] = _leg(false, int256(1e12), TickMath.MAX_SQRT_PRICE - 1, false);
        _fund(eoa[1], 1 ether);
        vm.prank(eoa[1]);
        (bool[] memory ok,,) = u3actor.swaps{value: 0.1 ether}(poolKey, any, eoa[1], eoa[1]);
        assertTrue(ok[0] && ok[1] && ok[2] && ok[3], "after migration every shape passes");
        assertEq(uint256(vm.load(a.hook, bytes32(0))), w0, "and the hook's storage word is untouched");
        u3actor.sweepTo(eoa[1]);
    }

    // ============================================================================================================
    // L8 · P3.17: the clone's arguments and the positions' keys

    /// The hook clone is EIP-1167 to the version's BoxHook implementation followed by exactly the planner's 203
    /// argument bytes (`BoxFactoryV1Planner.sol:172-187`, `BoxHookBase.sol:24-41`): Q = native ETH, T, √P1, √P0, the
    /// launch router, kind Box0, the curve's ticks, the spec's openAt, the curve liquidity, R, the coordinator, the
    /// receiver and FIT's executor as the price average; the curve is BoxLayoutV1.curve(R, Q as currency0).
    function testProperty_AUDIT_U3_cloneArgumentsAreThePlannersExactly() public view {
        bytes memory code = a.hook.code;
        assertEq(code.length, 45 + hook.ARGS_LENGTH(), "EIP-1167 runtime plus 203 argument bytes");
        assertEq(hook.ARGS_LENGTH(), 203);
        BoxLayoutV1.Curve memory c = BoxLayoutV1.curve(raise, false);
        uint32 openArg = uint32(hook.openAt());
        bytes memory want = bytes.concat(
            abi.encodePacked(address(0), a.token, c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, a.launchRouter),
            abi.encodePacked(uint8(BoxKind.Box0), c.tickLower, c.tickUpper, openArg, c.liquidity, uint128(raise)),
            abi.encodePacked(a.coordinator, a.receiver, a.executor)
        );
        bytes memory args = new bytes(203);
        for (uint256 i; i < 203; ++i) {
            args[i] = code[45 + i];
        }
        assertEq(args, want, "the clone's arguments");
        assertEq(c.tickLower, curve.tickLower);
        assertEq(c.liquidity, curve.liquidity);
        assertEq(hook.q(), address(0));
        assertEq(hook.token(), a.token);
        assertEq(hook.launchRouter(), a.launchRouter);
        assertEq(hook.coordinator(), a.coordinator);
        assertEq(hook.receiver(), a.receiver);
        assertEq(address(hook.priceAverage()), a.executor, "box 0's average is FIT's executor");
        assertEq(uint8(hook.kind()), uint8(BoxKind.Box0));
        assertEq(hook.raise(), raise);
        assertEq(hook.reserveCap(), raise / 1_000, "0.1% of R");
        assertEq(hook.minAdd(), raise * 50 / 10_000, "0.5% of R");
        assertEq(hook.minAdd(), 21_034_900_425_000_000, "BC-119's 0.021034900425 ETH");
        assertEq(hook.deepenTipCap(), BoxSpecV1.FEE_BATCH_TIP_MAX_ETH);
        assertEq(hook.coordinatorImplementation(), _implementationOf(a.coordinator), "the version's coordinator");
        assertEq(hook.openAt(), createdAt + AUDIT_OPEN_DELAY, "the spec's openAt (a time after creation)");
        assertEq(hook.deployBlock(), createdAtBlock);
    }

    /// The positions' keys (owner, ticks, salt) are pairwise distinct: curve salt 0, ask/bid/sentinel salt 1 on three
    /// distinct ranges, the pair salt 3 (salt 2 never used, F77); after graduation each key holds exactly the liquidity
    /// its view reports, and no position exists at salt 2 or at the pair's range with salt 1 (BC-120).
    function testProperty_AUDIT_U3_positionKeysNeverCoincide() public {
        bytes32[5] memory keys = [
            keccak256(abi.encodePacked(a.hook, curve.tickLower, curve.tickUpper, SALT_CURVE)),
            keccak256(abi.encodePacked(a.hook, MIN_T, curve.tickLower, SALT_L7)),
            keccak256(abi.encodePacked(a.hook, curve.tickLower, MAX_T, SALT_L7)),
            keccak256(abi.encodePacked(a.hook, curve.tickUpper, MAX_T, SALT_L7)),
            keccak256(abi.encodePacked(a.hook, MIN_T, MAX_T, SALT_PAIR))
        ];
        for (uint256 i; i < keys.length; ++i) {
            for (uint256 j = i + 1; j < keys.length; ++j) {
                assertTrue(keys[i] != keys[j], "distinct position keys");
            }
        }
        _toGraduated();
        (uint128 ask, uint128 bid, uint128 sentinel) = hook.graduatedLayout();
        assertEq(pm.getPositionLiquidity(poolKey.toId(), keys[1]), ask);
        assertEq(pm.getPositionLiquidity(poolKey.toId(), keys[2]), bid);
        assertEq(pm.getPositionLiquidity(poolKey.toId(), keys[3]), sentinel);
        assertEq(_posL(MIN_T, MAX_T, bytes32(uint256(2))), 0, "salt 2 never used");
        assertEq(_posL(MIN_T, MAX_T, SALT_L7), 0);
        assertGt(ask, 0);
        assertGt(bid, 0);
        assertGt(sentinel, 0);
    }

    // ------------------------------------------------------------------------------------------------ helpers

    /// @dev The implementation an EIP-1167 clone delegates to (runtime bytes 10..29).
    function _implementationOf(address clone) internal view returns (address impl) {
        bytes memory code = clone.code;
        require(code.length >= 45, "not a clone");
        assembly ("memory-safe") {
            impl := shr(96, mload(add(add(code, 0x20), 10)))
        }
    }
}
