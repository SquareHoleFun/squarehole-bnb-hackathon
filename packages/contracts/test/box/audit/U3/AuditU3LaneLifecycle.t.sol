// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import "./AuditU3LaneBase.sol";
import {NativeLiquidityHelper} from "../../../v2/utils/NativeV4Callers.sol";

contract AuditU3LaneLifecycle is AuditU3LaneBase {
    using StateLibrary for IPoolManager;

    function testProperty_AUDIT_U3_authorityAndDelegation() public {
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotCoordinator.selector, address(this)));
        hook.initialize();
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotCoordinator.selector, address(this)));
        hook.launch();
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotCoordinator.selector, address(this)));
        hook.migrate(0);
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotReceiver.selector, address(this)));
        hook.harvest();
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxHook.AlreadyInitialised.selector);
        hook.initialize();
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxHook.AlreadyLaunched.selector);
        hook.launch();
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxHook.NotClosed.selector);
        hook.migrate(0);
        assertTrue(BoxClones.isCloneOf(a.coordinator, impls.coordinator));
        // A counterfeit clone with an EOA or a different version's implementation named as coordinator.
        _badInitializer(trader);
        _badInitializer(BoxClones.create(BoxClones.initCode(impls.receiver, "")));
        BoxHookExtension ext = BoxHookExtension(impls.hookExtension);
        vm.expectRevert(BoxHookExtension.NotDelegated.selector);
        ext.launch();
        vm.expectRevert(BoxHookExtension.NotDelegated.selector);
        ext.migrate(0);
        vm.expectRevert(BoxHookExtension.NotDelegated.selector);
        ext.deepen(keeper);
        vm.expectRevert(BoxHookExtension.NotDelegated.selector);
        ext.unlockCallback("");
        _graduate();
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxHook.AlreadyMigrated.selector);
        hook.migrate(0);
        _assertWord();
    }

    function _badInitializer(address bad) internal {
        bytes memory args = abi.encodePacked(
            address(0),
            a.token,
            curve.sqrtPriceLowerX96,
            curve.sqrtPriceUpperX96,
            a.launchRouter,
            uint8(0),
            curve.tickLower,
            curve.tickUpper,
            uint32(hook.openAt()),
            curve.liquidity,
            uint128(hook.raise()),
            bad,
            a.receiver,
            a.executor
        );
        address counterfeit = BoxClones.create(BoxClones.initCode(impls.hook, args));
        vm.prank(bad);
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotCoordinator.selector, bad));
        BoxHook(counterfeit).initialize();
        assertEq(BoxHook(counterfeit).deployBlock(), 0);
    }

    function testProperty_AUDIT_U3_onlyOwnUnlockAndSharedWord() public {
        ForeignUnlocker foreign = new ForeignUnlocker(pm);
        for (uint8 action = 1; action <= 4; ++action) {
            bytes memory data = abi.encodeCall(hook.unlockCallback, (abi.encode(action, bytes(""))));
            vm.expectRevert(IBoxHook.NotPoolManager.selector);
            foreign.callInside(a.hook, data);
        }
        vm.expectRevert(IBoxHook.ForeignUnlock.selector);
        foreign.callInside(a.hook, abi.encodeCall(hook.deepen, (keeper)));
        vm.expectRevert(IBoxHook.ForeignUnlock.selector);
        foreign.callInside(a.receiver, abi.encodeCall(receiver.collect, (keeper)));
        _assertWord();
        uint256 initial = uint256(vm.load(a.hook, bytes32(0)));
        vm.prank(a.receiver);
        hook.harvest();
        assertEq(uint256(vm.load(a.hook, bytes32(0))), initial);
        _close(true);
        uint256 closedWord = uint256(vm.load(a.hook, bytes32(0)));
        assertEq(closedWord, initial | (block.number << 88));
        coord.graduate();
        uint256 migratedWord = uint256(vm.load(a.hook, bytes32(0)));
        assertEq(migratedWord, closedWord | (block.number << 128) | (7 << 232));
        _fundQ(1 ether);
        _fundT(_tValue(1 ether));
        _hold(600);
        hook.deepen(keeper);
        assertEq(uint256(vm.load(a.hook, bytes32(0))), migratedWord | (block.number << 168) | (1 << 235));
        assertEq(uint256(vm.load(impls.hookExtension, bytes32(0))), 0, "delegate target storage untouched");
        _assertWord();
    }

    function testFuzz_AUDIT_U3_foreignClaimsEnlargeBudget(uint96 seed) public {
        uint256 amount = bound(uint256(seed), 1, 100 ether);
        (uint256 beforeQ,) = hook.depthBudget();
        minter.mintTo{value: amount}(trader);
        vm.prank(trader);
        pm.transfer(a.hook, 0, amount);
        (uint256 afterQ,) = hook.depthBudget();
        assertEq(afterQ, beforeQ + amount);
        assertEq(_claims(trader, address(0)), 0);
        _assertBalances();
    }

    function testProperty_AUDIT_U3_reserveBeforeGraduationOnly() public {
        _bonding();
        _harvestAndCheck(true);
        kit.buy(trader, 0.1 ether, 0);
        _harvestAndCheck(true);
        assertLt(hook.reserveMinted(), hook.reserveCap());
        kit.buy(trader, 1 ether, 0);
        kit.sell(trader, token.balanceOf(trader) / 10);
        _harvestAndCheck(true);
        assertEq(hook.reserveMinted(), hook.reserveCap());
        kit.buy(trader, 0.1 ether, 0);
        _harvestAndCheck(true);
        kit.buy(trader, 10 ether, curve.sqrtPriceLowerX96);
        _harvestAndCheck(true);
        coord.graduate();
        kit.buy(trader, 0.1 ether, 0);
        kit.sell(trader, token.balanceOf(trader) / 100);
        _harvestAndCheck(false);
    }

    function _harvestAndCheck(bool beforeGraduation) internal {
        uint256 cq = _claims(a.coordinator, address(0));
        uint256 rq = _claims(a.receiver, address(0));
        uint256 rt = _claims(a.receiver, a.token);
        uint256 minted = hook.reserveMinted();
        vm.prank(a.receiver);
        (uint256 q, uint256 t, uint256 reserve) = hook.harvest();
        uint256 room = beforeGraduation ? hook.reserveCap() - minted : 0;
        assertEq(reserve, q < room ? q : room);
        assertEq(_claims(a.coordinator, address(0)) - cq, reserve);
        assertEq(_claims(a.receiver, address(0)) - rq, q - reserve);
        assertEq(_claims(a.receiver, a.token) - rt, t);
        assertEq(hook.reserveMinted(), minted + reserve);
        _assertBalances();
    }

    function testFuzz_AUDIT_U3_migrationConservesExactLayout(bool overshoot) public {
        _close(overshoot);
        _harvestAndCheck(true); // isolate migration principal/dust from all accrued fees
        uint256 budget = token.balanceOf(a.coordinator);
        uint256 receiverQ = _claims(a.receiver, address(0));
        // Real coordinator clone as caller; call the hook alone so receiver.collect cannot consume its dust.
        vm.prank(a.coordinator);
        (uint256 q, uint256 t, uint256 pulled, uint256 dust) = hook.migrate(budget);
        (uint128 ask, uint128 bid, uint128 sentinel) = hook.graduatedLayout();
        assertEq(q, hook.raise());
        assertEq(t, 0);
        assertEq(_sqrt(), curve.sqrtPriceLowerX96);
        assertEq(ask, bid);
        uint160 max = TickMath.getSqrtPriceAtTick(BoxSpecV1.MAX_USABLE_TICK);
        uint256 spentQ = SqrtPriceMath.getAmount0Delta(curve.sqrtPriceLowerX96, max, bid, true)
            + SqrtPriceMath.getAmount0Delta(curve.sqrtPriceUpperX96, max, sentinel, true);
        uint256 spentT = SqrtPriceMath.getAmount1Delta(
            TickMath.getSqrtPriceAtTick(BoxSpecV1.MIN_USABLE_TICK), curve.sqrtPriceLowerX96, ask, true
        );
        assertEq(q, spentQ + dust);
        assertEq(pulled + t, spentT);
        assertEq(token.balanceOf(a.coordinator), budget - pulled);
        assertEq(_claims(a.receiver, address(0)) - receiverQ, dust);
        assertEq(_position(curve.tickLower, curve.tickUpper, 0), 0);
        assertEq(ask, _position(BoxSpecV1.MIN_USABLE_TICK, curve.tickLower, 1));
        assertEq(bid, _position(curve.tickLower, BoxSpecV1.MAX_USABLE_TICK, 1));
        assertEq(sentinel, _position(curve.tickUpper, BoxSpecV1.MAX_USABLE_TICK, 1));
        _assertBalances();
        _assertWord();
    }

    function testProperty_AUDIT_U3_foreignPoolActionsEveryPhase() public {
        NativeLiquidityHelper lp = new NativeLiquidityHelper(pm);
        ForeignUnlocker foreign = new ForeignUnlocker(pm);
        for (uint256 phase; phase < 5; ++phase) {
            _phase(phase);
            vm.expectRevert(
                _wrapped(IHooks.beforeAddLiquidity.selector, abi.encodeWithSelector(IBoxHook.LiquidityLocked.selector))
            );
            lp.modify(key, curve.tickLower, curve.tickUpper, 1);
            vm.expectRevert(
                _wrapped(
                    IHooks.beforeRemoveLiquidity.selector, abi.encodeWithSelector(IBoxHook.LiquidityLocked.selector)
                )
            );
            lp.modify(key, curve.tickLower, curve.tickUpper, -1);
            vm.expectRevert(
                _wrapped(
                    IHooks.beforeRemoveLiquidity.selector, abi.encodeWithSelector(IBoxHook.LiquidityLocked.selector)
                )
            );
            lp.modify(key, curve.tickLower, curve.tickUpper, 0);
            vm.expectRevert(
                _wrapped(IHooks.beforeDonate.selector, abi.encodeWithSelector(IBoxHook.DonationsDisabled.selector))
            );
            foreign.donate(key);
            vm.expectRevert(
                _wrapped(IHooks.beforeInitialize.selector, abi.encodeWithSelector(IBoxHook.ForeignInitialize.selector))
            );
            pm.initialize(key, curve.sqrtPriceUpperX96);
            PoolKey memory other = key;
            other.tickSpacing = 120;
            vm.expectRevert(
                _wrapped(IHooks.beforeInitialize.selector, abi.encodeWithSelector(IBoxHook.ForeignInitialize.selector))
            );
            pm.initialize(other, curve.sqrtPriceUpperX96);
            assertEq(uint160(a.hook) & Hooks.ALL_HOOK_MASK, 0x2ae0);
            assertEq(hook.REQUIRED_FLAGS(), 0x2ae0);
            assertEq(key.fee, 10_000);
            assertEq(key.tickSpacing, 60);
            (uint160 sqrt, int24 tick, uint24 protocol, uint24 fee) = pm.getSlot0(key.toId());
            bytes32 slot = keccak256(abi.encode(PoolId.unwrap(key.toId()), uint256(6)));
            Slot0 packed = Slot0.wrap(pm.extsload(slot));
            assertEq(packed.sqrtPriceX96(), sqrt);
            assertEq(packed.tick(), tick);
            assertEq(packed.protocolFee(), protocol);
            assertEq(packed.lpFee(), fee);
            assertEq(uint128(uint256(pm.extsload(bytes32(uint256(slot) + 3)))), pm.getLiquidity(key.toId()));
            assertEq(
                uint160(a.hook)
                    & (Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                        | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
                        | Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG
                        | Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG),
                0
            );
        }
    }

    function _phase(uint256 phase) internal {
        if (phase == 1) {
            vm.roll(block.number + 300);
            vm.warp(hook.openAt());
        }
        if (phase == 2) _bonding();
        if (phase == 3) kit.buy(trader, 10 ether, curve.sqrtPriceLowerX96);
        if (phase == 4) coord.graduate();
    }

    function testProperty_AUDIT_U3_phaseGateAndPostMigrationNoops() public {
        SwapParams memory buy = SwapParams(true, -1, curve.sqrtPriceLowerX96);
        SwapParams memory sell = SwapParams(false, -1, curve.sqrtPriceUpperX96);
        _callbackAllowed(a.launchRouter, buy);
        _callbackDenied(address(swapper), buy, abi.encodeWithSelector(IBoxHook.TradingNotOpen.selector, hook.openAt()));
        vm.roll(block.number + 1);
        _callbackDenied(a.launchRouter, buy, abi.encodeWithSelector(IBoxHook.TradingNotOpen.selector, hook.openAt()));
        _callbackDenied(a.launchRouter, sell, abi.encodeWithSelector(IBoxHook.TradingNotOpen.selector, hook.openAt()));
        vm.warp(hook.openAt());
        _callbackAllowed(a.launchRouter, buy);
        _callbackAllowed(address(swapper), sell);
        _callbackDenied(
            address(swapper),
            buy,
            abi.encodeWithSelector(IBoxHook.BuyThroughLaunchRouter.selector, a.launchRouter, hook.windowEndsAt())
        );
        vm.deal(trader, 10 ether);
        vm.prank(trader);
        BoxLaunchRouter(payable(a.launchRouter)).buy{value: 0.1 ether}(0.1 ether, 0, trader, block.timestamp);
        kit.sell(trader, token.balanceOf(trader) / 10);
        _bonding();
        kit.buy(trader, 10 ether, curve.sqrtPriceLowerX96);
        _callbackDenied(a.launchRouter, buy, abi.encodeWithSelector(IBoxHook.CurveIsClosed.selector, block.number));
        _callbackDenied(address(swapper), sell, abi.encodeWithSelector(IBoxHook.CurveIsClosed.selector, block.number));
        coord.graduate();
        bytes32 w = vm.load(a.hook, bytes32(0));
        _callbackAllowed(address(swapper), buy);
        _callbackAllowed(address(swapper), sell);
        vm.prank(address(pm));
        (bytes4 selector, int128 delta) = hook.afterSwap(trader, key, buy, BalanceDelta.wrap(0), "");
        assertEq(selector, IHooks.afterSwap.selector);
        assertEq(delta, 0);
        assertEq(vm.load(a.hook, bytes32(0)), w);
        kit.buy(trader, 0.01 ether, 0);
    }

    function _callbackAllowed(address sender, SwapParams memory params) internal {
        vm.prank(address(pm));
        (bytes4 selector,, uint24 fee) = hook.beforeSwap(sender, key, params, "");
        assertEq(selector, IHooks.beforeSwap.selector);
        assertEq(fee, 0);
    }

    function _callbackDenied(address sender, SwapParams memory params, bytes memory reason) internal {
        vm.prank(address(pm));
        vm.expectRevert(reason);
        hook.beforeSwap(sender, key, params, "");
    }

    function testFuzz_AUDIT_U3_closeInsideUnlock(
        bool exactOutput,
        bool overshoot,
        bool secondBuy,
        bool secondOutput,
        uint256 seed
    ) public {
        _bonding();
        AuditU3LaneUnlocker driver = new AuditU3LaneUnlocker(pm);
        vm.deal(address(driver), 20 ether);
        uint160 end = overshoot ? TickMath.MIN_SQRT_PRICE + 1 : curve.sqrtPriceLowerX96;
        uint256 amount = exactOutput ? BoxSpecV1.ISSUANCE : 3 * hook.raise();
        SwapParams memory first = SwapParams(true, exactOutput ? int256(amount) : -int256(amount), end);
        uint256 n = bound(seed, 1, 4 ether);
        SwapParams memory second = SwapParams(
            secondBuy,
            secondOutput ? int256(n) : -int256(n),
            secondBuy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        );
        // The atomic route reverts the entire close, not merely the returning swap.
        vm.expectRevert(
            _wrapped(IHooks.beforeSwap.selector, abi.encodeWithSelector(IBoxHook.CurveIsClosed.selector, block.number))
        );
        driver.two(key, first, second, true);
        assertFalse(hook.closed());
        driver.two(key, first, second, false);
        assertEq(driver.closedInside(), block.number, "closed before the unlock returned");
        assertFalse(driver.secondSucceeded());
        assertEq(
            driver.secondReason(),
            _wrapped(IHooks.beforeSwap.selector, abi.encodeWithSelector(IBoxHook.CurveIsClosed.selector, block.number))
        );
        assertEq(hook.closedAtBlock(), block.number);
        _assertBalances();
    }

    function testFuzz_AUDIT_U3_priceFloorAndClose(uint256 sizeSeed, uint256 limitSeed, bool buy, bool exactOutput)
        public
    {
        _bonding();
        kit.buy(trader, 1 ether, 0);
        uint160 before_ = _sqrt();
        uint160 limit = buy
            ? uint160(bound(limitSeed, TickMath.MIN_SQRT_PRICE + 1, before_ - 1))
            : uint160(bound(limitSeed, uint256(before_) + 1, TickMath.MAX_SQRT_PRICE - 1));
        uint256 max = buy == exactOutput ? BoxSpecV1.ISSUANCE : 3 * hook.raise();
        uint256 amount = bound(sizeSeed, 1, max);
        vm.deal(trader, 20 ether);
        uint256 close0 = hook.closedAtBlock();
        vm.recordLogs();
        vm.prank(trader);
        try swapper.swap{value: buy ? 20 ether : 0}(
            key, buy, exactOutput ? int256(amount) : -int256(amount), limit
        ) returns (
            BalanceDelta
        ) {
            assertLe(_sqrt(), curve.sqrtPriceUpperX96);
            if (_sqrt() <= curve.sqrtPriceLowerX96) assertEq(hook.closedAtBlock(), block.number);
            else assertEq(hook.closedAtBlock(), close0);
        } catch {
            assertEq(_sqrt(), before_, "failed swap rolled back");
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 closes;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.hook && logs[i].topics[0] == IBoxHook.CurveClosed.selector) ++closes;
        }
        assertLe(closes, 1);
        _assertBalances();
    }

    function testFuzz_AUDIT_U3_closedRejectsAnySwap(uint256 sizeSeed, uint160 limitSeed, bool buy, bool output) public {
        _close(false);
        uint256 closedAt = hook.closedAtBlock();
        uint256 amount = bound(sizeSeed, 1, buy == output ? BoxSpecV1.ISSUANCE : 3 * hook.raise());
        uint160 limit = uint160(bound(uint256(limitSeed), TickMath.MIN_SQRT_PRICE + 1, TickMath.MAX_SQRT_PRICE - 1));
        vm.roll(block.number + 1);
        vm.deal(trader, 20 ether);
        vm.prank(trader);
        vm.expectRevert(
            _wrapped(IHooks.beforeSwap.selector, abi.encodeWithSelector(IBoxHook.CurveIsClosed.selector, closedAt))
        );
        swapper.swap{value: buy ? 20 ether : 0}(key, buy, output ? int256(amount) : -int256(amount), limit);
        assertEq(hook.closedAtBlock(), closedAt);
        assertEq(_sqrt(), curve.sqrtPriceLowerX96);
    }

    function testProperty_AUDIT_U3_forcingCostMainnet() public {
        _bonding();
        uint256[3] memory fills = [uint256(207_000), 701_000, 981_000];
        uint256[3] memory costs = [uint256(0.67 ether), 0.121 ether, 0.0019 ether];
        for (uint256 i; i < 3; ++i) {
            uint256 snap = vm.snapshotState();
            uint256 held = SqrtPriceMath.getAmount0Delta(_sqrt(), curve.sqrtPriceUpperX96, curve.liquidity, false);
            uint256 target = hook.raise() * fills[i] / 1e6;
            uint160 limit = SqrtPriceMath.getNextSqrtPriceFromInput(_sqrt(), curve.liquidity, target - held, true);
            kit.buy(trader, 10 ether, limit);
            address forcer = makeAddr("audit.u3.forcer");
            vm.deal(forcer, 10 ether);
            uint256 t = kit.buy(forcer, 10 ether, curve.sqrtPriceLowerX96);
            uint256 paid = 20 ether - forcer.balance; // kit adds the offered 10 ETH
            vm.prank(forcer);
            coord.graduate();
            uint256 received = kit.sell(forcer, t);
            assertGe(paid - received, costs[i]);
            emit log_named_uint(string.concat("forcing wei at ppm ", vm.toString(fills[i])), paid - received);
            vm.revertToState(snap);
        }
    }
}
