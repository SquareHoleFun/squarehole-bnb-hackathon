// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {stdError} from "forge-std/StdError.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {BoxPhase, DeepenSkip, DepthKind} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {CoreImpls} from "../../conformance/core/CoreBox0Kit.sol";
import {EthOut} from "../common/AuditGhostLedger.sol";
import {AuditU3FableBase} from "./AuditU3FableBase.sol";

/// @title AuditU3FableClaimsThief
/// @notice TEST ONLY (SH-AUDIT-B0 U3, Fable). Inside its own PoolManager unlock, tries to move or burn another
/// account's ERC-6909 claims (the hook's depth budget): `transferFrom` (what 1) or `burn` (what 2). Nothing is caught:
/// the PoolManager's revert reaches the test as it is.
contract AuditU3FableClaimsThief is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function steal(address victim, uint256 id, uint256 amount, uint8 what) external {
        pm.unlock(abi.encode(victim, id, amount, what));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "thief: pm");
        (address victim, uint256 id, uint256 amount, uint8 what) = abi.decode(data, (address, uint256, uint256, uint8));
        if (what == 1) pm.transferFrom(victim, address(this), id, amount);
        else pm.burn(victim, id, amount);
        return "";
    }
}

/// @title AuditU3FableInsideProbe
/// @notice TEST ONLY. A `deepen()` tip recipient whose `receive` runs inside the hook's own unlock (the tip is paid
/// last, by `PoolManager.take` with all the gas): once armed it tries every other state-changing entry point of box 0
/// that could matter there (the receiver's `fundDepth`, FIT's executor's `execute` and `poke`, the coordinator's
/// `graduate`) and records each outcome (the revert selector, 0 for a success) without reverting itself. Its storage
/// write in `receive` (22,100 gas from zero) also shows the tip is not a 2,300-gas stipend.
contract AuditU3FableInsideProbe {
    BoxReceiver internal immutable receiver;
    BoxCoordinator internal immutable coordinator;
    FitBuybackExecutor internal immutable executor;

    uint256 public tipsReceived;
    bytes4 public fundDepthSel;
    bytes4 public executeSel;
    bytes4 public graduateSel;
    bytes4 public pokeSel;
    bool public armed;

    constructor(address receiver_, address coordinator_, address executor_) {
        receiver = BoxReceiver(payable(receiver_));
        coordinator = BoxCoordinator(coordinator_);
        executor = FitBuybackExecutor(payable(executor_));
    }

    function arm() external {
        armed = true;
    }

    receive() external payable {
        tipsReceived += msg.value;
        if (!armed) return;
        armed = false;
        fundDepthSel = _sel(address(receiver), abi.encodeCall(BoxReceiver.fundDepth, ()), 1);
        executeSel = _sel(address(executor), abi.encodeCall(FitBuybackExecutor.execute, (1)), 0);
        graduateSel = _sel(address(coordinator), abi.encodeCall(BoxCoordinator.graduate, ()), 0);
        pokeSel = _sel(address(executor), abi.encodeCall(FitBuybackExecutor.poke, ()), 0);
    }

    function _sel(address target, bytes memory call, uint256 value) private returns (bytes4 sel) {
        (bool ok, bytes memory ret) = target.call{value: value}(call);
        if (ok) return bytes4(0);
        if (ret.length >= 4) sel = bytes4(ret);
        else sel = 0xffffffff;
    }
}

/// @notice SH-AUDIT-B0 U3 (Fable): the adversarial pins beyond the property suites, on the factory's box 0 (mainnet
/// build), under Osaka and Amsterdam. L1: nobody but the hook can move its claims; forced ETH on the hook changes
/// nothing and has no exit (the accepted no-exit class). L2 (BC-100): the implementation and a byte-identical twin
/// clone of the hook stay inert for strangers, and no pool can be keyed to the twin. L3: a tip recipient inside the
/// hook's unlock reaches no other state change. L5: the EIP-7702 tip is paid with all the gas; `graduate()` after a
/// close at the extreme price (the longest walk back to P1) stays under EIP-7825's cap; the cost to a third party of
/// delaying `deepen()` by one block. L6: the hook's own pool calls never reach its callbacks (v4 `noSelfCall`). L4:
/// proof test 25 (a same-block push up moves the add cap, which `_coreQNearPrice`'s note says it cannot).
abstract contract AuditU3FableAdversarialBase is AuditU3FableBase {
    using StateLibrary for IPoolManager;

    uint256 internal constant WARM_BLOCKS = 320;
    /// EIP-7825's transaction gas cap (2^24), in force from Osaka.
    uint256 internal constant TX_GAS_CAP = 16_777_216;

    function _graduatedAndWarm() internal {
        _toGraduated();
        _warmRing(WARM_BLOCKS);
        (bool ready, int24 avg,) = executor.twap();
        require(ready && avg == executor.latestSampleTick(), "u3: the ring is ready and at one tick");
    }

    function _bothSides(uint256 q) internal {
        _fundDepth(eoa[5], q);
        _giftT(eoa[2], _tForQ(q, _sqrtP()));
    }

    // ================================================================================================ L1

    /// P3.1, X09 (`IBoxHook.sol:89-91`, `BoxHook.sol:39-41`): the depth budget is the hook's own ERC-6909 claims and
    /// only the hook's own code moves them: a stranger's `transferFrom` or `burn` of the hook's Q or T claims, outside
    /// or inside an unlock, reverts on the allowance the hook never grants; the hook names no operator and no allowance
    /// for anyone, box 0's own contracts included.
    function testProperty_AUDIT_U3_nobodyButTheHookMovesItsClaims() public {
        _graduatedAndWarm();
        _fundDepth(eoa[5], 0.3 ether);
        _giftT(eoa[2], 1e24);
        (uint256 q0, uint256 t0) = _hookClaims();
        assertGt(q0, 0);
        assertGt(t0, 0);
        uint256 tId = uint256(uint160(a.token));
        AuditU3FableClaimsThief thief = new AuditU3FableClaimsThief(pm);
        // Outside an unlock: a transfer needs an operator or an allowance (ERC-6909); a burn needs an unlock.
        vm.prank(eoa[0]);
        vm.expectRevert(stdError.arithmeticError);
        pm.transferFrom(a.hook, eoa[0], 0, 1);
        vm.prank(eoa[0]);
        vm.expectRevert(stdError.arithmeticError);
        pm.transferFrom(a.hook, eoa[0], tId, 1);
        vm.prank(eoa[0]);
        vm.expectRevert(IPoolManager.ManagerLocked.selector);
        pm.burn(a.hook, 0, 1);
        // Inside the thief's own unlock: the same allowance check, for a transfer and for a burn, Q and T.
        vm.expectRevert(stdError.arithmeticError);
        thief.steal(a.hook, 0, 1, 1);
        vm.expectRevert(stdError.arithmeticError);
        thief.steal(a.hook, tId, 1, 1);
        vm.expectRevert(stdError.arithmeticError);
        thief.steal(a.hook, 0, 1, 2);
        vm.expectRevert(stdError.arithmeticError);
        thief.steal(a.hook, tId, 1, 2);
        address[7] memory who =
            [a.receiver, a.coordinator, a.launchRouter, a.executor, address(pm), eoa[0], address(thief)];
        for (uint256 i; i < who.length; ++i) {
            assertFalse(pm.isOperator(a.hook, who[i]), "the hook names no operator");
            assertEq(pm.allowance(a.hook, who[i], 0), 0, "no Q allowance");
            assertEq(pm.allowance(a.hook, who[i], tId), 0, "no T allowance");
        }
        (uint256 q1, uint256 t1) = _hookClaims();
        assertEq(q1, q0, "Q claims untouched");
        assertEq(t1, t0, "T claims untouched");
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
    }

    /// X01's "forced ETH" class on the hook (map § 6 item 10; M25/M27's class, accepted): ETH forced onto the hook
    /// (SELFDESTRUCT; `vm.deal` here) is not in the budget, changes nothing of `deepen()` or a batch (both spend claims),
    /// and has no exit (no `receive`, no rescue: F23 C2). Pinned as the accepted behaviour, not reported.
    function testProperty_AUDIT_U3_forcedEthOnTheHookChangesNothingAndHasNoExit() public {
        _graduatedAndWarm();
        _bothSides(0.5 ether);
        (uint256 q0, uint256 t0) = _hookClaims();
        _forceEth(a.hook, 1 ether);
        (uint256 qb, uint256 tb) = hook.depthBudget();
        assertEq(qb, q0, "forced ETH is not in the Q budget");
        assertEq(tb, t0);
        (DepthKind kind, DeepenSkip skip, uint256 qUsed,, uint256 tip) = _deepen(keeper, keeper);
        assertEq(uint8(skip), uint8(DeepenSkip.None));
        assertEq(uint8(kind), uint8(DepthKind.Pair));
        (uint256 q1,) = _hookClaims();
        assertEq(q0 - q1, qUsed + tip, "the add and the tip came from the claims");
        assertEq(a.hook.balance, 1 ether, "the forced ETH stays");
        // Enough fees for a batch (the receiver's minimum is 0.005 ETH of Q): a round trip of 0.8 ETH pays 1%.
        _buy(eoa[3], 0.8 ether);
        _sell(eoa[3], token.balanceOf(eoa[3]) / 2);
        _collect(keeper, keeper);
        assertEq(a.hook.balance, 1 ether, "no batch moves it: no exit (accepted class)");
        (uint256 q2, uint256 t2) = _hookClaims();
        (qb, tb) = hook.depthBudget();
        assertEq(q2, qb);
        assertEq(t2, tb);
        _assertGhostLedger();
    }

    // ================================================================================================ L2

    /// P3.5, BC-100 (`BoxHook.sol:69-70`, `:81-82`; `IBoxHook.sol:168-171`): the hook implementation itself and a
    /// byte-identical twin clone (the same 203 arguments, the right flags, deployed by a stranger) stay inert: on the
    /// implementation `deepen` returns a skip and writes nothing, every other entry point refuses the caller; on the
    /// twin every entry point but `initialize` refuses an uninitialised clone and `initialize` refuses everyone but
    /// box 0's coordinator (which names one hook); no pool can be initialised with the twin as its hook
    /// (`ForeignInitialize`, as for the real hook).
    function testProperty_AUDIT_U3_implementationAndATwinCloneStayInert() public {
        _toBonding();
        CoreImpls memory impls = kit.impls();
        BoxHook impl = BoxHook(impls.hook);
        vm.record();
        vm.prank(eoa[0]);
        (DepthKind kind, DeepenSkip skip, uint256 q, uint256 t, uint256 tip) = impl.deepen(eoa[0]);
        (, bytes32[] memory writes) = vm.accesses(impls.hook);
        assertEq(uint8(skip), uint8(DeepenSkip.NotGraduated), "the implementation: a skip");
        assertEq(uint8(kind), uint8(DepthKind.None));
        assertEq(q | t | tip, 0);
        assertEq(writes.length, 0, "the implementation writes nothing");
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotReceiver.selector, eoa[0]));
        impl.harvest();
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotCoordinator.selector, eoa[0]));
        impl.launch();
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotCoordinator.selector, eoa[0]));
        impl.migrate(0);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotCoordinator.selector, eoa[0]));
        impl.initialize();
        assertEq(uint8(impl.phase()), uint8(BoxPhase.Upcoming), "deploy block 1, never launched");

        // The twin: the hook's exact code (EIP-1167 runtime plus the arguments) at an address with the same flags.
        address twin = address(
            uint160(uint256(keccak256("u3.fable.twin")) & ~uint256(Hooks.ALL_HOOK_MASK)) | BoxSpecV1.HOOK_FLAGS
        );
        vm.etch(twin, a.hook.code);
        BoxHook tw = BoxHook(twin);
        assertEq(twin.code.length, a.hook.code.length);
        assertEq(tw.coordinator(), a.coordinator, "the twin names box 0's coordinator");
        assertEq(uint160(twin) & Hooks.ALL_HOOK_MASK, 0x2AE0);
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxHook.NotInitialised.selector);
        tw.launch();
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxHook.NotInitialised.selector);
        tw.deepen(eoa[0]);
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxHook.NotInitialised.selector);
        tw.harvest();
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxHook.NotInitialised.selector);
        tw.migrate(0);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotCoordinator.selector, eoa[0]));
        tw.initialize();
        vm.prank(a.receiver);
        vm.expectRevert(IBoxHook.NotInitialised.selector);
        tw.harvest();
        PoolKey memory twinKey = poolKey;
        twinKey.hooks = IHooks(twin);
        vm.prank(eoa[0]);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                twin,
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(IBoxHook.ForeignInitialize.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        pm.initialize(twinKey, curve.sqrtPriceUpperX96);
        assertEq(uint8(tw.phase()), uint8(BoxPhase.None), "never initialised");
        _assertGhostLedger();
    }

    // ================================================================================================ L3

    /// P3.8, L3: a tip recipient's code inside `deepen()`'s own unlock reaches no other state change of box 0: the
    /// receiver's `fundDepth` and FIT's `execute` open their own unlock (refused: `AlreadyUnlocked`), `graduate` is
    /// done, a `poke` is a no-op (this block's sample exists); the add and the budget are exactly the call's figures.
    function testProperty_AUDIT_U3_tipRecipientReachesNoOtherStateChangeInsideTheUnlock() public {
        _graduatedAndWarm();
        _fundBudget(eoa[5], 1 ether);
        assertGe(a.executor.balance, 1 ether, "fixture: FIT's executor holds a budget above its batch threshold");
        AuditU3FableInsideProbe probe = new AuditU3FableInsideProbe(a.receiver, a.coordinator, a.executor);
        _ghostAddOutside(address(probe));
        _bothSides(0.5 ether);
        (uint256 q0, uint256 t0) = _hookClaims();
        uint256 budget0 = a.executor.balance;
        int24 sample0 = executor.latestSampleTick();
        probe.arm();
        vm.prank(keeper);
        (DepthKind kind, DeepenSkip skip, uint256 qUsed, uint256 tUsed, uint256 tip) = hook.deepen(address(probe));
        _noteEthOut(EthOut.Tip, tip);
        assertEq(uint8(skip), uint8(DeepenSkip.None));
        assertEq(uint8(kind), uint8(DepthKind.Pair));
        assertGt(tip, 0);
        assertEq(probe.tipsReceived(), tip, "the tip arrived with enough gas for a storage write");
        assertEq(address(probe).balance, tip, "the 1 wei sent with the refused fundDepth came back");
        assertFalse(probe.armed(), "the probe ran inside the unlock");
        assertEq(probe.fundDepthSel(), IPoolManager.AlreadyUnlocked.selector, "fundDepth needs its own unlock");
        assertEq(probe.executeSel(), IPoolManager.AlreadyUnlocked.selector, "execute needs its own unlock");
        assertEq(probe.graduateSel(), IBoxCoordinator.AlreadyGraduated.selector, "graduate is done");
        assertEq(probe.pokeSel(), bytes4(0), "a poke inside is a no-op");
        assertEq(executor.latestSampleTick(), sample0, "the sample is this block's already");
        assertEq(a.executor.balance, budget0, "the executor's budget is untouched");
        (uint256 q1, uint256 t1) = _hookClaims();
        assertEq(q0 - q1, qUsed + tip, "the budget fell by the principal and the tip only");
        assertEq(t0 - t1, tUsed);
        assertEq(hook.lastDeepenBlock(), vm.getBlockNumber());
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
    }

    // ================================================================================================ L6

    /// L6 (v4 `Hooks.noSelfCall`, `Hooks.sol:171`; `BoxHook.sol:150`, `IBoxHook.sol:59`): the hook's own pool calls
    /// never reach its callbacks: a `deepen()` that converts (the hook's own swap) and pairs (its own add), then a
    /// harvest (four zero-liquidity pokes) make no call to `beforeSwap`, `afterSwap`, `beforeAddLiquidity` or
    /// `beforeRemoveLiquidity` on the hook (any of the last two would revert `LiquidityLocked`).
    function testProperty_AUDIT_U3_hooksOwnPoolCallsNeverReachItsCallbacks() public {
        _graduatedAndWarm();
        _fundDepth(eoa[5], 0.5 ether);
        // The T side (the graduation's own T depth part included) brought to 95% of MIN_ADD: a conversion first, then
        // the pair in the same unlock.
        (, uint256 tHave) = _hookClaims();
        uint256 want = hook.minAdd() * 95 / 100;
        uint256 have = _tInQ(tHave, _sqrtP());
        if (want > have) _giftT(eoa[2], _tForQ(want - have, _sqrtP()));
        (, tHave) = _hookClaims();
        assertLt(_tInQ(tHave, _sqrtP()), hook.minAdd(), "fixture: the T side below MIN_ADD");
        vm.expectCall(a.hook, abi.encodeWithSelector(IHooks.beforeSwap.selector), 0);
        vm.expectCall(a.hook, abi.encodeWithSelector(IHooks.afterSwap.selector), 0);
        vm.expectCall(a.hook, abi.encodeWithSelector(IHooks.beforeAddLiquidity.selector), 0);
        vm.expectCall(a.hook, abi.encodeWithSelector(IHooks.beforeRemoveLiquidity.selector), 0);
        vm.recordLogs();
        (DepthKind kind, DeepenSkip skip, uint256 qUsed,,) = _deepen(keeper, keeper);
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        assertEq(uint8(skip), uint8(DeepenSkip.None));
        assertEq(uint8(kind), uint8(DepthKind.Pair), "the pair followed the conversion");
        (bool conv, uint256 qIn,,,,,) = _lastConverted(logs);
        assertTrue(conv, "the hook swapped in its own pool");
        assertGt(qUsed, qIn, "and added the pair");
        assertEq(_countTopic(logs, address(pm), IPoolManager.Swap.selector), 1, "one swap: the hook's own");
        uint256 w = _word();
        assertEq((w >> 168) & ((1 << 40) - 1), vm.getBlockNumber(), "lastDeepenBlock written before the unlock");
        assertEq((w >> 235) & 1, 1, "the pair bit set inside it: one consistent word (P3.8)");
        vm.recordLogs();
        vm.prank(a.receiver);
        hook.harvest();
        logs = vm.getRecordedLogs();
        assertEq(
            _countTopic(logs, address(pm), keccak256("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)")),
            4,
            "four pokes, none through beforeRemoveLiquidity"
        );
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
    }

    // ================================================================================================ L5

    /// L5 (wave-1 fact: a 2,300-gas stipend fails on an EIP-7702 account under Amsterdam): the hook's only ETH send,
    /// the tip, goes through `PoolManager.take` (v4 `CurrencyLibrary.transfer`: `call(gas(), …)`, all the gas), so a
    /// delegated EOA, a contract and a plain EOA are all paid, under Osaka and Amsterdam alike.
    function testProperty_AUDIT_U3_tipToADelegatedEoaIsPaidWithAllTheGas() public {
        _graduatedAndWarm();
        _bothSides(0.5 ether);
        uint256 b0 = eoa7702.balance;
        (DepthKind kind, DeepenSkip skip,,, uint256 tip) = _deepen(eoa7702, eoa7702);
        assertEq(uint8(skip), uint8(DeepenSkip.None));
        assertEq(uint8(kind), uint8(DepthKind.Pair));
        assertGt(tip, 0);
        assertEq(eoa7702.balance - b0, tip, "the delegated EOA got the tip through its delegate's receive");
        _advance(300);
        _warmRing(1);
        b0 = address(contractDrawer).balance;
        (kind, skip,,, tip) = _deepen(eoa[1], address(contractDrawer));
        assertEq(uint8(skip), uint8(DeepenSkip.None));
        assertEq(address(contractDrawer).balance - b0, tip, "a contract recipient");
        _advance(300);
        _warmRing(1);
        b0 = eoa[1].balance;
        (kind, skip,,, tip) = _deepen(eoa[1], eoa[1]);
        assertEq(uint8(skip), uint8(DeepenSkip.None));
        assertEq(eoa[1].balance - b0, tip, "a plain EOA");
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
    }

    /// X18, BC-025 (`launch-pipeline-v1.md:203-206`: "an exact-input close through the Universal Router runs past P1
    /// to its own limit across empty ticks … `graduate()` then walks the price back to exactly P1"): the longest walk,
    /// after a close at the extreme limit (√price MIN + 1, tick MIN_TICK), costs the closer nothing beyond the exact
    /// close (no liquidity below P1), and `graduate()` still succeeds under EIP-7825's transaction cap, under Osaka
    /// and Amsterdam, leaving exactly P1 and the library's layout; its gas against an exact close's is logged.
    function testProperty_AUDIT_U3_closeAtTheExtremeThenGraduateWithinTheGasCap() public {
        _toBonding();
        _fillTo(500_000);
        uint256 base = vm.snapshotState();
        uint256 tLeft = _curveTLeft();
        uint256 paidExact = _closeCost(curve.sqrtPriceLowerX96);
        _warpTo(_requestTimeFor(r0));
        uint256 gasExact = _graduateFrame(keeper);
        vm.revertToState(base);
        uint256 paidExtreme = _closeCost(TickMath.MIN_SQRT_PRICE + 1);
        assertEq(_sqrtP(), TickMath.MIN_SQRT_PRICE + 1, "the price sits at the extreme limit");
        assertEq(_tick(), TickMath.MIN_TICK);
        assertTrue(hook.closed());
        assertEq(hook.closedAtBlock(), vm.getBlockNumber());
        assertApproxEqAbs(token.balanceOf(eoa[2]), tLeft, 2, "the closer got the curve's T, nothing more");
        assertEq(paidExtreme, paidExact, "an overshoot to the extreme costs exactly the exact close");
        _warpTo(_requestTimeFor(r0));
        uint256 gasExtreme = _graduateFrame(keeper);
        emit log_named_uint("U3F|gas graduate() frame after an exact close at P1", gasExact);
        emit log_named_uint("U3F|gas graduate() frame after a close at the extreme price (the longest walk)", gasExtreme);
        emit log_named_uint("U3F|gas of the walk from MIN_TICK to P1 (difference)", gasExtreme - gasExact);
        assertGt(gasExtreme, gasExact, "the walk costs");
        assertLt(gasExtreme, TX_GAS_CAP, "graduate() after the longest walk fits EIP-7825's 2^24");
        assertEq(_sqrtP(), curve.sqrtPriceLowerX96, "graduate() walked the price back to exactly P1");
        assertEq(_tick(), curve.tickLower, "walked up: slot0's tick is tickLower");
        uint128[5] memory l = _positions();
        (uint128 ask, uint128 bid, uint128 sentinel) = hook.graduatedLayout();
        assertEq(l[0], 0, "the curve is gone");
        assertTrue(l[1] == ask && l[2] == bid && l[3] == sentinel && ask > 0 && bid > 0 && sentinel > 0);
        assertEq(pm.getLiquidity(poolId), bid, "the bid is active at P1 after a walk up");
        assertGt(_buy(eoa[3], 0.01 ether), 0, "trading resumed");
        _sell(eoa[2], token.balanceOf(eoa[2]) / 2);
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
    }

    /// @dev eoa[2]'s exact-input buy of 3 × R limited at `limit`; returns what it paid (the rest refunded).
    function _closeCost(uint160 limit) internal returns (uint256 paid) {
        uint256 e0 = eoa[2].balance;
        _buyTo(eoa[2], 3 * raise, limit);
        paid = e0 + 3 * raise - eoa[2].balance;
        require(hook.closed(), "u3: the close");
    }

    function _graduateFrame(address caller) internal returns (uint256 gas) {
        vm.prank(caller);
        coordinator.graduate();
        gas = vm.lastFrameGas().gasTotalUsed;
        reached = AuditPhase.Graduated;
    }

    /// L5 (no stated bound; measured for the founder): a third party can make an honest `deepen()` skip by pushing the
    /// price 100 ticks from the hour average in the call's block, at the cost of its own fees on the push and the
    /// unwind; the skip starts no cooldown and the next block's call acts. The griefer's cost per delayed block is
    /// logged (the box keeps every fee it pays).
    function testProperty_AUDIT_U3_delayingDeepenCostsTheGrieferFeesEveryBlock() public {
        _graduatedAndWarm();
        _bothSides(0.5 ether);
        (, int24 avg,) = executor.twap();
        _advance(1);
        address griefer = eoa[4];
        uint256 e0 = griefer.balance;
        uint256 t0 = token.balanceOf(griefer);
        uint256 last0 = hook.lastDeepenBlock();
        (uint256 q0, uint256 t0h) = _hookClaims();
        _pushDownTo(griefer, avg - 100);
        (, DeepenSkip skip,,,) = _deepen(keeper, keeper);
        assertEq(uint8(skip), uint8(DeepenSkip.Deviation), "the honest call skips");
        assertEq(hook.lastDeepenBlock(), last0, "no cooldown");
        (uint256 q1, uint256 t1h) = _hookClaims();
        assertEq(q1, q0);
        assertEq(t1h, t0h);
        _sell(griefer, token.balanceOf(griefer) - t0);
        uint256 cost = e0 + 200 ether - griefer.balance;
        emit log_named_decimal_uint("U3F|griefer's cost of one delayed block, push 100 ticks and unwind (ETH)", cost, 18);
        assertGt(cost, 0, "the push is not free");
        _advance(1);
        (DepthKind kind2, DeepenSkip skip2,,,) = _deepen(keeper, keeper);
        assertEq(uint8(skip2), uint8(DeepenSkip.None), "the next block's honest call acts");
        assertEq(uint8(kind2), uint8(DepthKind.Pair));
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
    }

    // ================================================================================================ L4: proof 25

    // W2-U3-1, accepted as built (FQ-16, F147): a same-block push moves the add cap under 1%; the NatSpec says so.
    /// @notice PROOF TEST (SH-AUDIT-B0 U3, Fable, 25; severity: Note).
    /// Property: "It reads no spot price, so a same-block push does not move the cap" (`BoxHookExtension.sol:494-497`,
    /// `_coreQNearPrice`'s note on the add cap's base; dynamic-pool-share.md § 1.3; BC-120).
    /// Expected: the add cap of one `deepen()` call is the same whether or not the price was pushed in that block.
    /// Observed: t_ref is the higher of the hour average and the latest sample (`_priceGuards`, `:348`), and `deepen()`
    /// pokes the average first (`:327`), so a same-block push UP of k ≤ 99 ticks (a sell) moves the sample, t_ref and
    /// the band [t_ref, t_ref + 953] up by k, and the cap down by 1 − 1.0001^(−k/2): −0.49% at 99 ticks; a push down
    /// leaves t_ref at the average and the cap unchanged. The move only tightens the cap (never loosens it): no value
    /// effect; the note overstates. Steps: graduated, the ring warm at P1, Q 0.5 ETH and T worth 0.5 ETH in the budget
    /// (so the pair is cap-sized); (a) `deepen()` with no push: the pair's Q is cap(t_ref = fair); (b) from the same
    /// state, a 99-tick sell push in the call's block, then `deepen()`: the pair's Q is cap(fair + 99) < cap(fair).
    /// Amounts (mainnet build, logged): cap(fair) 0.018983 ETH, cap(fair + 99) ≈ 0.018889 ETH.
    function testAccepted_AUDIT_U3_25_sameBlockPushUpShrinksTheAddCap() public {
        _graduatedAndWarm();
        _bothSides(0.5 ether);
        int24 fair = executor.latestSampleTick();
        (, int24 avg,) = executor.twap();
        assertEq(fair, avg, "fixture: the ring at one tick");
        assertEq(fair, _tick(), "fixture: at spot");
        uint256 base = vm.snapshotState();
        _advance(1);
        uint256 capA = _coreQNear(fair) * 10 / 100;
        (DepthKind kA, DeepenSkip sA, uint256 qA,,) = _deepen(keeper, keeper);
        assertEq(uint8(sA), uint8(DeepenSkip.None));
        assertEq(uint8(kA), uint8(DepthKind.Pair));
        assertEq(_tRef(), fair, "no push: t_ref is the average");
        assertLe(qA, capA);
        assertGe(qA + 2, capA, "no push: the pair's Q is the cap at t_ref = fair");
        vm.revertToState(base);
        _advance(1);
        _pushUpTo(eoa[2], fair + 99);
        assertEq(_tick(), fair + 99, "fixture: pushed 99 ticks up in this block");
        uint256 capB = _coreQNear(fair + 99) * 10 / 100;
        (DepthKind kB, DeepenSkip sB, uint256 qB,,) = _deepen(keeper, keeper);
        assertEq(uint8(sB), uint8(DeepenSkip.None), "99 ticks: the guards pass");
        assertEq(uint8(kB), uint8(DepthKind.Pair));
        assertEq(_tRef(), fair + 99, "t_ref followed the same-block push (the sample)");
        assertLe(qB, capB);
        assertGe(qB + 2, capB, "pushed: the pair's Q is the cap at t_ref = fair + 99");
        emit log_named_decimal_uint("U3F|proof 25: add cap with no push (ETH)", capA, 18);
        emit log_named_decimal_uint("U3F|proof 25: add cap after a same-block 99-tick push up (ETH)", capB, 18);
        emit log_named_uint("U3F|proof 25: the cap fell by (ppm)", (capA - capB) * 1_000_000 / capA);
        assertLt(capB, capA, "the same-block push moved the cap (the note says it cannot)");
        assertLt(qB, qA, "and the add with it");
        assertGt(capB * 1_000, capA * 994, "by about 0.5% at most: the band shifted 99 ticks up");
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU3FableAdversarialTest is AuditU3FableAdversarialBase {}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU3FableAdversarialAmsterdamTest is AuditU3FableAdversarialBase {}
