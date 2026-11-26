// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxSwapModule} from "../../../src/box/BoxSwapModule.sol";
import {IBoxPriceAverage} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxReceiver} from "../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxSwapModule, IBoxSwapModuleWiring} from "../../../src/box/interfaces/IBoxSwapModule.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxSwapModuleBase} from "./BoxSwapModuleBase.sol";
import {RefusingRecipient, SettablePriceAverage, SupplyFloorStandIn} from "./BoxS45Mocks.sol";

/// @notice TEST ONLY: a tip recipient that records the pool's √price when paid and tries to re-enter.
contract TipProbe {
    using StateLibrary for IPoolManager;

    IPoolManager public immutable pm;
    PoolKey internal key;
    address public module;
    address public receiver;
    uint160 public sqrtAtTip;
    uint256 public got;
    bool public reenteredStep;
    bool public collectedInside;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function aim(PoolKey memory k, address module_, address receiver_) external {
        (key, module, receiver) = (k, module_, receiver_);
    }

    receive() external payable {
        got += msg.value;
        (sqrtAtTip,,,) = pm.getSlot0(key.toId());
        (reenteredStep,) =
            module.call(abi.encodeCall(IBoxSwapModule.step, (IBoxSwapModule.Action.BuyBurn, address(this))));
        (collectedInside,) = receiver.call(abi.encodeWithSignature("collect(address)", address(this)));
    }
}

/// @notice TEST ONLY: a receiver and a hook standing in for a box whose pool has no liquidity (NoLiquidity can only be
/// reached this way: after `migrate` a box's L7 positions span every price).
contract StandInReceiver {
    uint8 public qStream = BoxSpecV1.Q_STREAM_BUYBACK_BURN_T;
    uint8 public tStream = BoxSpecV1.T_STREAM_BURN_T;
    uint256 public owedQ;

    function setOwed(uint256 q) external {
        owedQ = q;
    }

    function initModule(address m) external {
        IBoxSwapModuleWiring(m).initialize();
    }

    function pullForModule() external returns (uint256, uint256, uint256, uint256, uint256, uint256) {
        uint256 x = owedQ;
        owedQ = 0;
        return (x, 0, 0, 0, 0, 0);
    }
}

contract StandInHook {
    address public receiver;
    address public priceAverage;
    address public token;
    uint256 public migratedAtBlock = 1;

    constructor(address r, address a, address t) {
        (receiver, priceAverage, token) = (r, a, t);
    }
}

/// @notice S5.M2: a step that cannot run returns a reason and keeps its budget (BC-134); the caller's tip (BC-135); the
/// module's own `initialize` checks (it refuses the creator conversions until S5.M3, and a wiring the receiver cannot
/// see).
contract BoxSwapModuleSkipsTest is BoxSwapModuleBase {
    using StateLibrary for IPoolManager;

    IBoxSwapModule.Action internal constant BUY = IBoxSwapModule.Action.BuyBurn;
    IBoxSwapModule.Action internal constant SELL = IBoxSwapModule.Action.SellForFit;

    function setUp() public {
        _setUpModuleWorld();
    }

    function _stopOf(Box memory b, IBoxSwapModule.Action a) internal returns (IBoxSwapModule.Stop) {
        return _step(b, a, keeper).stop;
    }

    function _assertStop(Box memory b, IBoxSwapModule.Action a, IBoxSwapModule.Stop want, string memory why) internal {
        (uint256 q0, uint256 t0,) = _budgets(b);
        uint160 s0 = _sqrtP(b);
        vm.recordLogs();
        assertEq(uint256(_stopOf(b, a)), uint256(want), why);
        (uint256 q1, uint256 t1,) = _budgets(b);
        // The pull may add to a budget; a skip never spends one, and nothing trades.
        assertGe(q1, q0, "the Q budget is kept");
        assertGe(t1, t0, "the T budget is kept");
        assertEq(_sqrtP(b), s0, "no trade");
        _assertLedgersAreClaims(b);
    }

    // ============================================================================================================
    // BC-134: skips, not reverts

    function test_BC134_beforeGraduationNothingConverts() public {
        Box memory b = _buildAndLaunch(_defaultParams());
        _skipWindow(b);
        _feedQ(b, 1.5 ether);
        (uint256 heldQ,,,,,, bool held) = b.receiver.moduleOwed();
        assertTrue(held);
        _assertStop(b, BUY, IBoxSwapModule.Stop.NotGraduated, "before graduation");
        _assertStop(b, SELL, IBoxSwapModule.Stop.NotGraduated, "before graduation, a sell");
        (uint256 q,,) = _budgets(b);
        assertEq(q, 0, "the module was handed nothing");
        (uint256 stillHeld,,,,,,) = b.receiver.moduleOwed();
        assertEq(stillHeld, heldQ, "the buy-back Q waits in the receiver");
        assertFalse(_m(b).graduationSeen());
    }

    function test_BC134_theAverageNotReadyOrFailing() public {
        // The sampler: graduate() pokes it not, the step's own poke seeds P1, the window needs an hour.
        Box memory b = _graduatedBox(_defaultParams());
        _feedQ(b, 1.5 ether);
        _assertStop(b, BUY, IBoxSwapModule.Stop.AverageNotReady, "no full window yet");
        _roll(150);
        _assertStop(b, BUY, IBoxSwapModule.Stop.AverageNotReady, "half an hour later");
        _roll(160);
        assertEq(uint256(_stopOf(b, BUY)), uint256(IBoxSwapModule.Stop.None), "an hour after the first poke: runs");
        // A failing average reads as not ready, never as a revert.
        Box memory c = _graduatedBox(_mp(BoxSpecV1.Q_STREAM_BUYBACK_BURN_T, BoxSpecV1.T_STREAM_BURN_T, true));
        _feedQ(c, 1.5 ether);
        _readyAverage(c);
        SettablePriceAverage(c.average).setRevert(true);
        _assertStop(c, BUY, IBoxSwapModule.Stop.AverageNotReady, "a reverting poke");
        SettablePriceAverage(c.average).setRevert(false);
        int24 t = _spotTick(c);
        SettablePriceAverage(c.average).set(false, t, t);
        _assertStop(c, BUY, IBoxSwapModule.Stop.AverageNotReady, "not ready");
        (bool ready,,) = _m(c).bounds(BUY);
        assertFalse(ready, "bounds() agrees");
    }

    /// Spot more than 99 ticks the step's way from the reference: no room left, the step waits (a push in the step's
    /// block, after the block's sample, cannot loosen it).
    function test_BC134_atTheBand() public {
        Box memory b = _graduatedBox(_defaultParams());
        _feedQ(b, 1.5 ether);
        _feedT(b, 3_000_000e18);
        _readyAverage(b);
        _roll(1);
        IBoxPriceAverage(b.average).poke(); // the block's sample is taken: a later push cannot move it
        _buy(b, alice, 50 ether, TickMath.getSqrtPriceAtTick(_spotTick(b) - 120));
        _assertStop(b, BUY, IBoxSwapModule.Stop.AtBand, "a buy 120 ticks below its reference");
        (bool ready, int24 ref, uint160 limit) = _m(b).bounds(BUY);
        assertFalse(ready);
        assertEq(limit, 0);
        assertEq(ref, _ref(b, true));
        // The same block, the other way: a sell still has room (T is dear now: selling is the box's good side), and a
        // skipped buy used no step of the block.
        assertEq(uint256(_stopOf(b, SELL)), uint256(IBoxSwapModule.Stop.None), "a sell when T is dear runs");
        // Mirrored: T pushed 120 ticks cheaper than a sell's reference.
        Box memory c = _graduatedBox(_defaultParams());
        _feedT(c, 3_000_000e18);
        _readyAverage(c);
        _roll(1);
        IBoxPriceAverage(c.average).poke();
        deal(address(c.t), alice, 100_000_000e18);
        vm.startPrank(alice);
        c.t.approve(address(swapper), type(uint256).max);
        // forge-lint: disable-next-line(unsafe-typecast)
        swapper.swap(c.key, false, -int256(100_000_000e18), TickMath.getSqrtPriceAtTick(_spotTick(c) + 120));
        vm.stopPrank();
        _assertStop(c, SELL, IBoxSwapModule.Stop.AtBand, "a sell 120 ticks above its reference");
    }

    function test_BC134_belowTheStepMinimum() public {
        Box memory b = _graduatedBox(_defaultParams());
        _readyAverage(b);
        // FIT's T share below 0.005 ETH at the reference tick: 200,000 T is about 0.004 ETH at P1.
        _feedT(b, 1_000_000e18);
        _roll(1);
        _assertStop(b, SELL, IBoxSwapModule.Stop.BelowStepMin, "200,000 T, about 0.004 ETH at P1");
        // The buy-back budget (the settlement's split of the curve's last fees is above the minimum, so the boundary is
        // set exactly): 0.004 ETH waits; 1 raw unit below the minimum waits; exactly the minimum runs.
        _setQBudget(b, 0.004 ether + 1);
        _assertStop(b, BUY, IBoxSwapModule.Stop.BelowStepMin, "a buy budget of 0.004 ETH");
        _setQBudget(b, BoxSpecV1.SWAP_STEP_MIN_Q);
        _assertStop(b, BUY, IBoxSwapModule.Stop.BelowStepMin, "1 raw unit below the minimum (1 is kept)");
        _setQBudget(b, BoxSpecV1.SWAP_STEP_MIN_Q + 1);
        Result memory r = _step(b, BUY, keeper);
        assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.None), "exactly the minimum (+ the kept unit) runs");
        (uint256 q,,) = _budgets(b);
        assertEq(q, BoxSpecV1.SWAP_STEP_MIN_Q + 1 - r.amountIn - r.tip);
        assertGe(q, 1, "the kept unit stays");
    }

    /// Sets the module's buy-back ledger (and its claims) to exactly `real` raw units (a boundary test only: the
    /// ledger is stored plus 1 in the low half of slot 1).
    function _setQBudget(Box memory b, uint256 real) internal {
        (uint256 q,,) = _budgets(b);
        if (real > q) {
            vm.deal(address(this), address(this).balance + real - q);
            minter.mintTo{value: real - q}(b.module);
        } else {
            vm.prank(b.module);
            pm.transfer(address(0xdead), 0, q - real);
        }
        bytes32 slot1 = vm.load(b.module, bytes32(uint256(1)));
        bytes32 hi = slot1 & bytes32(~uint256(type(uint128).max));
        vm.store(b.module, bytes32(uint256(1)), hi | bytes32(real + 1));
        (uint256 q1,,) = _budgets(b);
        assertEq(q1, real);
        _assertLedgersAreClaims(b);
    }

    function test_BC134_aSecondStepInABlock() public {
        Box memory b = _graduatedBox(_defaultParams());
        _feedQ(b, 1.5 ether);
        _feedT(b, 3_000_000e18);
        _readyAverage(b);
        _roll(1);
        assertEq(uint256(_stopOf(b, BUY)), uint256(IBoxSwapModule.Stop.None));
        _assertStop(b, BUY, IBoxSwapModule.Stop.BlockLimit, "the same action again");
        _assertStop(b, SELL, IBoxSwapModule.Stop.BlockLimit, "any action");
    }

    function test_BC134_nothingToDo() public {
        // ALL_TO_FIT: no buy-back ledger is ever filled; a fresh box's T share is empty.
        Box memory b = _graduatedBox(_mp(BoxSpecV1.Q_STREAM_ALL_TO_FIT, BoxSpecV1.T_STREAM_BURN_T, false));
        _feedQ(b, 1.5 ether);
        _readyAverage(b);
        _assertStop(b, BUY, IBoxSwapModule.Stop.NothingToDo, "no buy-back on this box");
        _assertStop(b, SELL, IBoxSwapModule.Stop.NothingToDo, "no T share yet");
        // S5.M3: the creator actions skip like the others (no creator ledger on this box).
        _assertStop(b, IBoxSwapModule.Action.BuyForCreator, IBoxSwapModule.Stop.NothingToDo, "no creator-buy ledger");
        _assertStop(b, IBoxSwapModule.Action.SellForCreator, IBoxSwapModule.Stop.NothingToDo, "no creator-sell ledger");
    }

    /// A pool with no active liquidity (a stand-in world: a real box's L7 positions span every price).
    function test_BC134_noLiquidity() public {
        if (address(moduleImpl) == address(0)) moduleImpl = new BoxSwapModule(pm);
        StandInReceiver r = new StandInReceiver();
        SettablePriceAverage avg = new SettablePriceAverage();
        avg.set(true, 0, 0);
        address t = makeAddr("s5m2.standInT");
        StandInHook h = new StandInHook(address(r), address(avg), t);
        address m = makeAddr("s5m2.standInModule");
        vm.etch(
            m,
            _clone(
                address(moduleImpl),
                abi.encodePacked(address(r), address(h), address(avg), address(0), t, uint8(1), uint8(1))
            )
        );
        r.initModule(m);
        vm.deal(address(this), 1 ether);
        minter.mintTo{value: 1 ether}(m);
        r.setOwed(1 ether);
        (IBoxSwapModule.Stop stop,,,) = IBoxSwapModule(m).step(BUY, keeper);
        assertEq(uint256(stop), uint256(IBoxSwapModule.Stop.NoLiquidity));
        (uint256 q,,,,) = IBoxSwapModule(m).budgets();
        assertEq(q, 1 ether, "the budget is kept");
    }

    /// The vault's supply floor refuses the burn: the bought T waits, never counted as burned; anyone burns it later.
    function test_BC134_aRefusedBurnWaits() public {
        Box memory b = _graduatedBox(_defaultParams());
        _feedQ(b, 1.5 ether);
        _readyAverage(b);
        SupplyFloorStandIn floor = new SupplyFloorStandIn();
        address vaultAddr = b.t.vault();
        vm.etch(vaultAddr, address(floor).code);
        SupplyFloorStandIn(vaultAddr).setFloor(type(uint256).max);
        uint256 supply0 = b.t.totalSupply();
        _roll(1);
        Result memory r = _step(b, BUY, keeper);
        assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.None), "the step itself runs");
        assertEq(b.t.totalSupply(), supply0, "refused: nothing burned");
        (,, uint256 tBurn) = _budgets(b);
        assertEq(tBurn, r.amountOut, "the bought T waits");
        assertEq(_m(b).burnPending(), 0, "still refused");
        SupplyFloorStandIn(vaultAddr).setFloor(0);
        assertEq(_m(b).burnPending(), r.amountOut - 1, "anyone burns it once the floor allows (1 raw unit kept)");
        assertEq(supply0 - b.t.totalSupply(), r.amountOut - 1);
        _assertLedgersAreClaims(b);
    }

    // ============================================================================================================
    // BC-135: tips

    function test_BC135_aBuysTipIsFivePercentOfItsInputPaidLast() public {
        Box memory b = _graduatedBox(_defaultParams());
        _feedQ(b, 1.5 ether);
        _readyAverage(b);
        TipProbe probe = new TipProbe(pm);
        probe.aim(b.key, b.module, address(b.receiver));
        _roll(1);
        Result memory r = _step(b, BUY, address(probe));
        assertEq(r.tip, _tipOf(r.amountIn), "min(5% of the input, 0.0005 ETH)");
        // A full step at graduation's depth spends about 0.0100 ETH (0.0099 moved plus the 1% fee): 5% of it is at the
        // cap already.
        assertApproxEqRel(r.amountIn, 0.01 ether, 0.02e18, "about 0.01 ETH of input");
        assertLe(r.tip, 0.0005 ether);
        assertEq(probe.got(), r.tip);
        assertEq(probe.sqrtAtTip(), _sqrtP(b), "paid after the trade, inside the unlock");
        assertFalse(probe.reenteredStep(), "the tip recipient cannot re-enter the module");
        assertFalse(probe.collectedInside(), "nor run the receiver's collect inside the step");
    }

    function test_BC135_aSellsTipComesFromItsOutput() public {
        Box memory b = _graduatedBox(_defaultParams());
        _feedT(b, 3_000_000e18);
        _readyAverage(b);
        uint256 fit0 = b.receiver.fitOwed();
        uint256 k0 = keeper.balance;
        _roll(1);
        Result memory r = _step(b, SELL, keeper);
        assertEq(r.tip, _tipOf(r.amountOut), "min(5% of the output, 0.0005 ETH)");
        assertEq(keeper.balance - k0, r.tip);
        assertEq(b.receiver.fitOwed() - fit0, r.amountOut - r.tip, "FIT gets the rest");
    }

    /// Deeper in the pool (the price raised by a buy), a 49-tick step is larger than 0.01 ETH: the tip is capped.
    function test_BC135_theTipIsCappedAtTheBatchTipMax() public {
        Box memory b = _graduatedBox(_mp(BoxSpecV1.Q_STREAM_BUYBACK_BURN_T, BoxSpecV1.T_STREAM_BURN_T, true));
        _feedQ(b, 3 ether);
        _buy(b, alice, 2 ether, 0);
        _readyAverage(b);
        _roll(1);
        Result memory r = _step(b, BUY, keeper);
        assertGt(r.amountIn * 500 / 10_000, 0.0005 ether, "5% of this step is above the cap");
        assertEq(r.tip, 0.0005 ether, "FEE_BATCH_TIP_MAX_ETH");
    }

    /// The caller picks no size: a step takes all it may within the bounds, the next waits a block, and tips over
    /// many steps never exceed 5% of what they converted; no tip recipient keeps the tip in the budget.
    function test_BC135_splittingABudgetNeverEarnsMoreTip() public {
        Box memory b = _graduatedBox(_defaultParams());
        _feedQ(b, 3 ether);
        _readyAverage(b);
        uint256 tips;
        uint256 converted;
        for (uint256 i; i < 30; ++i) {
            _roll(1);
            Result memory r = _step(b, BUY, keeper);
            if (r.stop == IBoxSwapModule.Stop.None) {
                assertEq(uint256(_stopOf(b, BUY)), uint256(IBoxSwapModule.Stop.BlockLimit), "one step per block");
            }
            tips += r.tip;
            converted += r.amountIn;
            assertLe(r.tip, 0.0005 ether);
        }
        assertLe(tips, converted * 500 / 10_000, "never more than 5% of what was converted");
        // No recipient: no tip, it stays in the budget.
        (uint256 q0,,) = _budgets(b);
        _roll(400);
        Result memory n = _step(b, BUY, address(0));
        assertEq(n.tip, 0);
        (uint256 q1,,) = _budgets(b);
        assertEq(q0 - q1, n.amountIn, "only the input left the budget");
    }

    function test_BC135_aRevertingTipRecipientRevertsOnlyItsOwnStep() public {
        Box memory b = _graduatedBox(_defaultParams());
        _feedQ(b, 1.5 ether);
        _readyAverage(b);
        RefusingRecipient bad = new RefusingRecipient();
        _roll(1);
        (uint256 q0,,) = _budgets(b);
        vm.expectRevert();
        _m(b).step(BUY, address(bad));
        (uint256 q1,,) = _budgets(b);
        assertEq(q1, q0, "nothing spent");
        assertEq(uint256(_stopOf(b, BUY)), uint256(IBoxSwapModule.Stop.None), "another caller's step runs");
    }

    // ============================================================================================================
    // The module's own initialize (swap-module § 4.2, § 6; SH-S5-swap M1 decision 3)

    /// S5.M3 builds the creator conversions: the module takes a box with CREATOR_IN_T or CREATOR_IN_Q (M2 refused it).
    function test_module_initializeTakesTheCreatorConversions() public {
        Params memory p = _mp(BoxSpecV1.Q_STREAM_CREATOR_IN_T, BoxSpecV1.T_STREAM_BURN_T, false);
        p.payee = carol;
        Box memory b = _build(p);
        vm.prank(address(b.coord));
        b.receiver.initialize();
        assertEq(_m(b).lastStepBlock(), 0);
        (uint8 qa, uint8 ta) = _m(b).actions();
        assertEq(qa, BoxSpecV1.Q_STREAM_CREATOR_IN_T);
        assertEq(ta, BoxSpecV1.T_STREAM_BURN_T);
        p = _mp(BoxSpecV1.Q_STREAM_TO_CREATOR, BoxSpecV1.T_STREAM_CREATOR_IN_Q, false);
        p.payee = carol;
        b = _build(p);
        vm.prank(address(b.coord));
        b.receiver.initialize();
        (uint256 qFee, uint256 tFee) = _m(b).creatorFeesPending();
        assertEq(qFee + tFee, 0, "no creator fee pending at creation");
    }

    function test_module_initializeChecksTheWiringAndRunsOnce() public {
        Box memory b = _build(_defaultParams());
        // Its actions must be the receiver's streams; its price average the hook's.
        Params memory p = _defaultParams();
        vm.etch(
            b.module,
            _clone(
                address(moduleImpl),
                abi.encodePacked(
                    address(b.receiver), address(b.hook), b.average, address(0), address(b.t), uint8(2), p.tStream
                )
            )
        );
        vm.prank(address(b.coord));
        vm.expectRevert(IBoxSwapModule.WiringMismatch.selector);
        b.receiver.initialize();
        vm.etch(
            b.module,
            _clone(
                address(moduleImpl),
                abi.encodePacked(
                    address(b.receiver),
                    address(b.hook),
                    makeAddr("s5m2.otherAverage"),
                    address(0),
                    address(b.t),
                    p.qStream,
                    p.tStream
                )
            )
        );
        vm.prank(address(b.coord));
        vm.expectRevert(IBoxSwapModule.WiringMismatch.selector);
        b.receiver.initialize();
        vm.etch(b.module, _clone(address(moduleImpl), _moduleArgs(b, p, address(b.hook), address(b.receiver))));
        vm.prank(address(b.coord));
        b.receiver.initialize();
        (uint256 q, uint256 qc, uint256 t, uint256 tc, uint256 tb) = _m(b).budgets();
        assertEq(q + qc + t + tc + tb, 0, "every ledger starts at zero (stored plus 1: no slot from zero later)");
        for (uint256 slot = 1; slot < 4; ++slot) {
            assertTrue(vm.load(b.module, bytes32(slot)) != bytes32(0), "initialize wrote the ledger slots");
        }
        vm.prank(address(b.receiver));
        vm.expectRevert(IBoxSwapModule.AlreadyInitialised.selector);
        _m(b).initialize();
        vm.expectRevert(abi.encodeWithSelector(IBoxSwapModule.NotReceiver.selector, address(this)));
        _m(b).initialize();
        (address r, address q_, address t_, address h) = _m(b).wiring();
        assertEq(r, address(b.receiver));
        assertEq(q_, address(0));
        assertEq(t_, address(b.t));
        assertEq(h, address(b.hook));
        assertEq(address(_m(b).priceAverage()), b.average);
        (uint8 qa, uint8 ta) = _m(b).actions();
        assertEq(qa, p.qStream);
        assertEq(ta, p.tStream);
        assertEq(b.module.code.length, 45 + 102, "the clone: proxy + 102 argument bytes");
        assertEq(IBoxReceiver(address(b.receiver)).swapModule(), b.module);
    }
}
