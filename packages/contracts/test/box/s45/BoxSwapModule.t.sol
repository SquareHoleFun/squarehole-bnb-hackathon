// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {FitBuybackExecutor} from "../../../src/box/FitBuybackExecutor.sol";
import {IBoxPriceAverage} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxSwapModule} from "../../../src/box/interfaces/IBoxSwapModule.sol";
import {FeeBatch} from "../../../src/box/interfaces/BoxTypes.sol";
import {CodeScan} from "../conformance/CodeScan.sol";
import {BoxSwapModuleBase} from "./BoxSwapModuleBase.sol";

/// @notice S5.M2, the swap module's engine (docs/design/swap-module-v1.md § 4.3-4.8): `BuyBurn` and `SellForFit` on a
/// real `BoxSwapModule` clone, the box's price sampler and the box's own graduated pool. BC-129 (every step bounded both
/// ways, the sandwich), BC-131 (W4 end to end, with box 0's real FIT executor), BC-132 (the module spends only what it
/// was handed) and BC-133 (its own fee notes, from its swaps' fee growth).
contract BoxSwapModuleTest is BoxSwapModuleBase {
    using StateLibrary for IPoolManager;

    IBoxSwapModule.Action internal constant BUY = IBoxSwapModule.Action.BuyBurn;
    IBoxSwapModule.Action internal constant SELL = IBoxSwapModule.Action.SellForFit;

    function setUp() public {
        _setUpModuleWorld();
    }

    /// The default box graduated with both budgets (1 ETH of buy-back Q, 600,000 T of FIT's share) and the average
    /// ready at P1.
    function _readyBox() internal returns (Box memory b) {
        b = _graduatedBox(_defaultParams());
        _feedQ(b, 1.5 ether);
        _feedT(b, 3_000_000e18);
        _readyAverage(b);
    }

    // ============================================================================================================
    // BC-129: every step is bounded, both ways

    function test_BC129_aBuyBurnStepIsBoundedAndBurnsWhatItBought() public {
        Box memory b = _readyBox();
        uint160 s0 = _sqrtP(b);
        int24 t0 = _spotTick(b);
        uint256 supply0 = b.t.totalSupply();
        (uint256 owedQ,,,,,,) = b.receiver.moduleOwed();
        uint256 keeper0 = keeper.balance;
        _roll(1);
        Result memory r = _step(b, BUY, keeper);
        assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.None), "a step ran");
        int24 ref = _ref(b, true);
        uint160 limit = _limit(true, s0, ref);
        uint160 s1 = _sqrtP(b);
        assertGe(s1, limit, "never beyond the limit");
        assertGe(uint256(s1), _impactSqrt(true, s0), "at most 49 ticks of impact");
        assertGe(s1, _bandSqrt(true, ref), "never beyond the reference - 99 ticks");
        assertGe(_spotTick(b), t0 - IMPACT - 1, "the tick moved at most 49 (+1 for the tick's floor)");
        assertGt(r.amountIn, 0.009 ether, "a full step at graduation's depth: about 0.0099 ETH");
        assertGe(r.amountOut, _minOut(true, r.amountIn, limit), "output at least the minimum at the limit price");
        // What it bought is burned, less the 1 raw unit its T balance keeps (swap-module § 6).
        assertEq(supply0 - b.t.totalSupply(), r.amountOut - 1, "bought T burned (1 raw unit kept)");
        (uint256 qBurn,, uint256 tBurn) = _budgets(b);
        assertEq(tBurn, 1, "1 raw unit of T held");
        assertEq(qBurn, owedQ - 1 - r.amountIn - r.tip, "the ledger: what was handed less input and tip");
        assertLe(r.amountIn + r.tip, owedQ - 1 - 1, "never its last raw unit");
        assertEq(r.tip, _tipOf(r.amountIn), "tip: 5% of the input under the cap");
        assertEq(keeper.balance - keeper0, r.tip, "paid to tipTo in Q");
        (uint256 noteQ, uint256 noteT) = b.receiver.moduleFeesPending();
        assertEq(noteQ, r.amountIn / 100 - 2 * SLACK, "REV-16: 1% of the input less the slack, noted");
        assertEq(noteT, 0);
        _assertLedgersAreClaims(b);
    }

    function test_BC129_aSellForFitStepIsBoundedAndBooksItsQToFit() public {
        Box memory b = _readyBox();
        uint160 s0 = _sqrtP(b);
        int24 t0 = _spotTick(b);
        uint256 fit0 = b.receiver.fitOwed();
        (, uint256 tFit0,) = _budgets(b);
        uint256 waiting0 = b.receiver.fitWaitingT();
        _roll(1);
        Result memory r = _step(b, SELL, keeper);
        assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.None), "a step ran");
        int24 ref = _ref(b, false);
        uint160 limit = _limit(false, s0, ref);
        uint160 s1 = _sqrtP(b);
        assertLe(s1, limit, "never beyond the limit");
        assertLe(uint256(s1), _impactSqrt(false, s0), "at most 49 ticks of impact");
        assertLe(s1, _bandSqrt(false, ref), "never beyond the reference + 99 ticks");
        assertLe(_spotTick(b), t0 + IMPACT, "the tick moved at most 49");
        assertGe(r.amountOut, _minOut(false, r.amountIn, limit), "output at least the minimum at the limit price");
        assertEq(r.tip, _tipOf(r.amountOut), "tip: 5% of the output under the cap");
        assertEq(b.receiver.fitOwed() - fit0, r.amountOut - r.tip, "its Q booked to FIT (moduleProceeds, FitQ)");
        (, uint256 tFit1,) = _budgets(b);
        assertEq(tFit1, tFit0 + waiting0 - 1 - r.amountIn, "T sold from FIT's ledger, handed less the kept unit");
        (uint256 noteQ, uint256 noteT) = b.receiver.moduleFeesPending();
        assertEq(noteQ, 0);
        assertEq(noteT, r.amountIn / 100 - 2 * SLACK, "REV-16 in T");
        _assertLedgersAreClaims(b);
    }

    /// With nobody else trading, steps every block: each within 49 ticks and the band of its own reference; the band
    /// follows the average, so the box moves its price about the band per window (swap-module § 4.4 "Cooldown").
    function test_BC129_manyStepsNeverLeaveTheBand() public {
        Box memory b = _readyBox();
        _feedQ(b, 15 ether);
        int24 start = _spotTick(b);
        uint256 ran;
        uint256 atBand;
        for (uint256 i; i < 60; ++i) {
            _roll(1);
            uint160 s0 = _sqrtP(b);
            Result memory r = _step(b, BUY, keeper);
            if (r.stop == IBoxSwapModule.Stop.AtBand) {
                ++atBand;
                continue;
            }
            assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.None));
            ++ran;
            int24 ref = _ref(b, true);
            assertGe(_sqrtP(b), _bandSqrt(true, ref), "never beyond its reference - 99");
            assertGe(uint256(_sqrtP(b)), _impactSqrt(true, s0), "never more than 49 ticks");
            (, int24 avg,) = IBoxPriceAverage(b.average).twap();
            assertGe(_spotTick(b), avg - BAND - 1, "never more than 99 ticks below the 1-hour average");
        }
        assertGt(ran, 1);
        assertGt(atBand, 0, "steps wait at the band until the average follows");
        // 60 blocks = 12 minutes: the average lags, so the price moved about the band, not 60 steps of 49 ticks.
        assertLt(start - _spotTick(b), 3 * BAND, "about the band per window, not unbounded");
        emit log_named_int("S5M2|ticks moved by 60 blocks of buy-back steps", start - _spotTick(b));
        emit log_named_uint("S5M2|steps that ran / waited at the band", ran * 1000 + atBand);
    }

    /// One step per block per box, across all actions (EXECUTOR_MAX_CHUNKS_PER_BLOCK's rule).
    function test_BC129_oneStepPerBlockAcrossActions() public {
        Box memory b = _readyBox();
        _roll(1);
        assertEq(uint256(_step(b, BUY, keeper).stop), uint256(IBoxSwapModule.Stop.None));
        assertEq(uint256(_step(b, SELL, keeper).stop), uint256(IBoxSwapModule.Stop.BlockLimit), "the other action");
        assertEq(uint256(_step(b, BUY, keeper).stop), uint256(IBoxSwapModule.Stop.BlockLimit), "the same action");
        assertEq(_m(b).lastStepBlock(), block.number);
        _roll(1);
        assertEq(uint256(_step(b, SELL, keeper).stop), uint256(IBoxSwapModule.Stop.None), "the next block");
    }

    /// The sandwich of swap-module § 4.5 at graduation's depth, against an identical box stepped alone: the attacker
    /// pushes `push` ticks the step's way in the step's block (nobody sampled before it), the step runs, the attacker
    /// unwinds. It loses (two 1% fees against at most the step's own move), its fees go to the box's own positions, and
    /// the box's step is never priced beyond its band: the loss bound is the reference − 99 ticks at the 1% fee.
    function test_BC129_aSandwichNeverPaysAndTheBoxsLossIsBounded() public {
        _sandwich(true, 50);
        _sandwich(false, 50);
        _sandwich(true, 98);
        _sandwich(false, 98);
    }

    function _sandwich(bool buy, uint256 push) internal {
        Box memory alone = _readyBox();
        Box memory hit = _readyBox();
        // Both batches cleared, so the next collect of `hit` holds only the sandwich's fees (and 0.01 minted).
        _mintQ(alone, 0.01 ether);
        alone.receiver.collect(keeper);
        _mintQ(hit, 0.01 ether);
        hit.receiver.collect(keeper);
        _roll(1);
        Result memory r0 = _step(alone, buy ? BUY : SELL, keeper);
        (uint256 attackerIn, uint256 got) = _push(hit, buy, push, _attacker());
        Result memory r1 = _step(hit, buy ? BUY : SELL, keeper);
        uint256 back = _unwind(hit, buy, got, _attacker());
        string memory label = string.concat("S5M2|sandwich ", buy ? "buy" : "sell", " push ", vm.toString(push));
        // The attacker never profits: a buy sandwich gets back less Q than it paid, a sell sandwich less T than it
        // sold.
        assertLt(back, attackerIn, string.concat(label, ": the attacker loses"));
        emit log_named_uint(string.concat(label, "|attacker in"), attackerIn);
        emit log_named_uint(string.concat(label, "|attacker back"), back);
        if (r1.stop == IBoxSwapModule.Stop.None) {
            // The box's price: never beyond its band, whatever the push; the reference never loosened past the average.
            int24 ref = _ref(hit, buy);
            uint160 band = _bandSqrt(buy, ref);
            (, int24 avg,) = IBoxPriceAverage(hit.average).twap();
            assertGe(r1.amountOut, _minOut(buy, r1.amountIn, band), "the box's step priced within its band");
            if (buy) assertGe(ref, avg, "a same-block push never lowers a buy's reference below the average");
            else assertLe(ref, avg, "a same-block push never raises a sell's reference above the average");
            emit log_named_uint(string.concat(label, "|box out alone"), r0.amountOut);
            emit log_named_uint(string.concat(label, "|box out sandwiched"), r1.amountOut);
            emit log_named_uint(string.concat(label, "|box in alone"), r0.amountIn);
            emit log_named_uint(string.concat(label, "|box in sandwiched"), r1.amountIn);
        } else {
            assertEq(uint256(r1.stop), uint256(IBoxSwapModule.Stop.AtBand), "pushed past the band: the step waits");
        }
        // Closed pool (D3): the attacker's fees accrue to the box's own positions, its next batch.
        _mintQ(hit, 0.01 ether);
        FeeBatch memory fb = hit.receiver.collect(keeper);
        if (buy) assertGe(fb.q - 0.01 ether, attackerIn / 100, "the front-run's 1% in Q to the box");
        else assertGe(fb.t, attackerIn / 100, "the front-run's 1% in T to the box");
    }

    // ============================================================================================================
    // BC-131: W4 end to end, with box 0's real FIT executor

    /// A default Standard box (BUYBACK_BURN_T, BURN_T) beside box 0: real trades make its sellers' fees; FIT's 3/15
    /// (in T) reaches FIT only as Q from the module's sells, booked to fitOwed, paid by payFit() into FIT's executor's
    /// fundBudget(); FIT is bought (and burned) only by FIT's executor; T sold + T pending == T credited, to the unit.
    function _attacker() internal pure returns (address) {
        return address(uint160(uint256(keccak256("s5m2.attacker"))));
    }

    function test_BC131_w4SellersFitShareReachesFitOnlyAsQFromTheModulesSells() public {
        Box memory z = _buildAndLaunch(_box0Params());
        _skipWindow(z);
        _closeAndGraduate(z);
        FitBuybackExecutor ex = FitBuybackExecutor(payable(z.executor));
        Params memory p = _defaultParams();
        p.executor = z.executor;
        Box memory b = _graduatedBox(p);
        W4 memory w;
        w.base = b.receiver.fitWaitingT();
        w.credited = _roundTrips(b, 3);
        assertGt(w.credited, 0, "FIT's 3/15 of the sellers' fees, in T");
        // Both averages ready: the box's sampler, and FIT's executor's ring (box 0's pool).
        IBoxPriceAverage(b.average).poke();
        for (uint256 i; i < 600; ++i) {
            _roll(1);
            ex.poke();
        }
        w.fitPool0 = _sqrtP(z);
        w.fitOwed0 = b.receiver.fitOwed();
        _sellFitShare(b, z, ex, w);
        assertGt(w.sold, 0, "the module sold FIT's T share");
        (, uint256 tForFit,) = _budgets(b);
        (,,,,, uint256 tBack,) = b.receiver.moduleOwed();
        assertEq(tBack, 0, "no fee returned in this run (no collect after the steps)");
        assertEq(w.sold + tForFit + b.receiver.fitWaitingT(), w.base + w.credited, "T sold + T pending == T credited");
        assertEq(b.receiver.fitOwed() - w.fitOwed0, w.toFit, "its Q booked to FIT, nothing else");
        _payFitAndBurn(b, z, ex, w);
        _assertLedgersAreClaims(b);
    }

    struct W4 {
        uint256 base;
        uint256 credited;
        uint256 sold;
        uint256 toFit;
        uint256 fitOwed0;
        uint160 fitPool0;
    }

    /// Buys and sells back `n` times after graduation, collecting each time: returns the T credited to FIT's share.
    function _roundTrips(Box memory b, uint256 n) internal returns (uint256 credited) {
        for (uint256 i; i < n; ++i) {
            (uint256 tOut,) = _buy(b, alice, 3 ether, 0);
            _sell(b, alice, tOut);
            uint256 w0 = b.receiver.fitWaitingT();
            b.receiver.collect(keeper);
            credited += b.receiver.fitWaitingT() - w0;
            _roll(1);
        }
    }

    function _sellFitShare(Box memory b, Box memory z, FitBuybackExecutor ex, W4 memory w) internal {
        for (uint256 i; i < 400; ++i) {
            _roll(1);
            ex.poke();
            Result memory r = _step(b, SELL, keeper);
            if (r.stop == IBoxSwapModule.Stop.None) {
                w.sold += r.amountIn;
                w.toFit += r.amountOut - r.tip;
            }
            assertEq(_sqrtP(z), w.fitPool0, "the module never trades in FIT's pool");
            if (r.stop == IBoxSwapModule.Stop.BelowStepMin || r.stop == IBoxSwapModule.Stop.NothingToDo) break;
        }
    }

    /// payFit sends FIT's owed Q to FIT's executor, which buys and burns FIT in its own bounded steps.
    function _payFitAndBurn(Box memory b, Box memory z, FitBuybackExecutor ex, W4 memory w) internal {
        uint256 budget0 = ex.budget();
        uint256 paid = b.receiver.payFit();
        assertEq(ex.budget() - budget0, paid, "fundBudget() received FIT's Q");
        assertGe(paid, w.toFit);
        uint256 fitSupply0 = z.t.totalSupply();
        (uint256 chunks,, uint256 burned) = ex.execute(5);
        assertEq(chunks, 1, "FIT's executor bought");
        assertGt(burned, 0);
        assertEq(fitSupply0 - z.t.totalSupply(), burned, "and burned FIT");
        assertLt(_sqrtP(z), w.fitPool0, "only FIT's executor moved FIT's pool");
    }

    /// SELL_FOR_Q's 10/15 joins FIT's 3/15 after graduation and is sold on the same ledger, its Q to FIT.
    function test_BC131_sellForQRewardIsSoldWithFitsShare() public {
        Box memory b = _graduatedBox(_mp(BoxSpecV1.Q_STREAM_ALL_TO_FIT, BoxSpecV1.T_STREAM_SELL_FOR_Q, false));
        uint256 w0 = b.receiver.fitWaitingT();
        uint256 supply0 = b.t.totalSupply();
        _feedT(b, 1_500_000e18);
        assertEq(b.receiver.fitWaitingT() - w0, 1_300_000e18, "13/15 of the T batch waits for the module's sells");
        assertEq(b.t.totalSupply(), supply0, "nothing of it burned after graduation");
        _readyAverage(b);
        uint256 fit0 = b.receiver.fitOwed();
        uint256 sold;
        uint256 toFit;
        for (uint256 i; i < 400; ++i) {
            _roll(1);
            Result memory r = _step(b, SELL, keeper);
            if (r.stop == IBoxSwapModule.Stop.None) {
                sold += r.amountIn;
                toFit += r.amountOut - r.tip;
            }
            if (r.stop == IBoxSwapModule.Stop.BelowStepMin || r.stop == IBoxSwapModule.Stop.NothingToDo) break;
        }
        assertGt(sold, 1_000_000e18, "most of it sold in bounded steps");
        assertEq(b.receiver.fitOwed() - fit0, toFit, "every Q to FIT");
        (, uint256 tForFit,) = _budgets(b);
        assertEq(sold + tForFit + b.receiver.fitWaitingT(), w0 + 1_300_000e18, "to the raw unit");
        _assertLedgersAreClaims(b);
    }

    // ============================================================================================================
    // BC-132: the module spends only what it was handed and takes nothing else

    function test_BC132_ledgersEqualItsClaimsThroughALife() public {
        Box memory b = _readyBox();
        for (uint256 i; i < 40; ++i) {
            _roll(1);
            if (i % 5 == 0) _feedQ(b, 0.3 ether);
            if (i % 7 == 0) _feedT(b, 1_000_000e18);
            if (i % 3 == 0) {
                _mintQ(b, 0.01 ether);
                b.receiver.collect(keeper);
            }
            _step(b, i % 2 == 0 ? BUY : SELL, keeper);
            _assertLedgersAreClaims(b);
            (,, uint256 tBurn) = _budgets(b);
            assertLe(tBurn, 1, "bought T is burned in the same step (1 raw unit kept)");
        }
        // The receiver's other ledgers move only by the module's proceeds, never by its spending.
        _assertCovered(b);
    }

    function _assertCovered(Box memory b) internal view {
        (uint256 qb, uint256 tb) = b.receiver.booked();
        assertGe(_claims(address(b.receiver), address(0)), qb, "the receiver's Q claims cover its ledgers");
        assertGe(_claims(address(b.receiver), address(b.t)), tb, "the receiver's T claims cover its ledgers");
    }

    /// No approval, operator, allowance, DELEGATECALL or SELFDESTRUCT in the module's code, and none on chain after a
    /// life of steps; only the PoolManager inside a step may call its callback; a stranger's clone stays inert.
    function test_BC132_noAllowanceOperatorOrDelegatePath() public {
        Box memory b = _readyBox();
        _roll(1);
        _step(b, BUY, keeper);
        _roll(1);
        _step(b, SELL, keeper);
        uint32[] memory words = CodeScan.pushedWords(address(moduleImpl).code);
        assertFalse(CodeScan.pushes(words, bytes4(0x095ea7b3)), "no approve(address,uint256)");
        assertFalse(CodeScan.pushes(words, bytes4(0xa22cb465)), "no setApprovalForAll(address,bool)");
        assertFalse(CodeScan.pushes(words, bytes4(0x426a8493)), "no ERC-6909 setOperator(address,bool)");
        assertFalse(CodeScan.hasOpcode(address(moduleImpl).code, CodeScan.OP_DELEGATECALL), "no DELEGATECALL");
        assertFalse(CodeScan.hasOpcode(address(moduleImpl).code, CodeScan.OP_SELFDESTRUCT), "no SELFDESTRUCT");
        address[4] memory others = [address(b.receiver), address(b.hook), keeper, address(b.coord)];
        for (uint256 i; i < others.length; ++i) {
            assertFalse(pm.isOperator(b.module, others[i]), "no operator from the module");
            assertFalse(pm.isOperator(others[i], b.module), "no operator to the module");
            assertEq(pm.allowance(b.module, others[i], 0), 0);
            assertEq(pm.allowance(others[i], b.module, 0), 0);
            assertEq(b.t.allowance(b.module, others[i]), 0);
        }
        // The callback: only the PoolManager, only inside the module's own step.
        vm.prank(address(pm));
        vm.expectRevert(IBoxSwapModule.NotPoolManager.selector);
        _m(b).unlockCallback(abi.encode(true, uint256(1), uint160(1), uint24(10_000), keeper));
        // A stranger's clone naming this box's receiver: never initialised, so it can do nothing.
        address stranger = makeAddr("s5m2.strangerClone");
        vm.etch(
            stranger,
            _clone(
                address(moduleImpl),
                abi.encodePacked(
                    address(b.receiver), address(b.hook), b.average, address(0), address(b.t), uint8(1), uint8(1)
                )
            )
        );
        vm.expectRevert(abi.encodeWithSelector(IBoxSwapModule.NotReceiver.selector, address(this)));
        IBoxSwapModule(stranger).initialize();
        vm.expectRevert(IBoxSwapModule.NotInitialised.selector);
        IBoxSwapModule(stranger).step(BUY, keeper);
        vm.expectRevert(IBoxSwapModule.NotInitialised.selector);
        moduleImpl.step(BUY, keeper);
    }

    /// No core path calls the module: graduation, collects, deepens, swaps, payouts run without it.
    function test_BC132_noCorePathCallsTheModule() public {
        Box memory b = _buildAndLaunch(_defaultParams());
        _skipWindow(b);
        vm.expectCall(b.module, bytes(""), 0);
        _closeAndGraduate(b);
        (uint256 t,) = _buy(b, alice, 1 ether, 0);
        _sell(b, alice, t / 2);
        b.receiver.collect(keeper);
        _roll(400);
        b.hook.deepen(keeper);
        b.receiver.fundFees{value: 0}();
    }

    // ============================================================================================================
    // BC-133: the real module's notes, from its swaps' fee growth; returned whole, never split

    function test_BC133_theModulesQNoteIsAtMostItsSwapsFeeAndComesBackWhole() public {
        Box memory b = _readyBox();
        // Clear the fees waiting from the setup, so the next batch holds only the step's own fee and the minted 0.01.
        _mintQ(b, 0.01 ether);
        b.receiver.collect(keeper);
        _roll(1);
        Result memory r = _step(b, BUY, keeper);
        (uint256 note,) = b.receiver.moduleFeesPending();
        _mintQ(b, 0.01 ether);
        (,,,, uint256 back0,,) = b.receiver.moduleOwed();
        FeeBatch memory fb = b.receiver.collect(keeper);
        uint256 earned = fb.q - 0.01 ether;
        assertLe(note, earned, "never more than the box's positions earned");
        assertLe(earned - note, 2 * SLACK + 8, "within the slack of the fee");
        assertGe(earned, r.amountIn / 100 - 1, "the positions earned the 1% of the step's input");
        (,,,, uint256 back1,,) = b.receiver.moduleOwed();
        assertEq(back1 - back0, note, "returned whole to moduleBackQ, never split");
        // The next pull hands it back into the burn-buy ledger, beside the batch's own 10/15.
        (uint256 q0,,) = _budgets(b);
        (uint256 owedQ,,,,,,) = b.receiver.moduleOwed();
        _m(b).sync();
        (uint256 q1,,) = _budgets(b);
        assertEq(q1 - q0, (owedQ - 1) + (back1 - 1), "handed back (each receiver ledger keeps 1 raw unit)");
        _assertLedgersAreClaims(b);
    }

    function test_BC133_theModulesTNoteIsAtMostItsSwapsFeeAndComesBackWhole() public {
        Box memory b = _readyBox();
        _mintQ(b, 0.01 ether);
        b.receiver.collect(keeper);
        _roll(1);
        Result memory r = _step(b, SELL, keeper);
        (, uint256 note) = b.receiver.moduleFeesPending();
        _mintQ(b, 0.01 ether);
        FeeBatch memory fb = b.receiver.collect(keeper);
        assertLe(note, fb.t, "never more than the box's positions earned in T");
        assertLe(fb.t - note, 2 * SLACK + 8, "within the slack");
        assertGe(fb.t, r.amountIn / 100 - 1);
        (,,,,, uint256 tBack,) = b.receiver.moduleOwed();
        assertEq(tBack, note, "returned whole to moduleBackT (its first return: the ledger was 0)");
        (, uint256 t0,) = _budgets(b);
        uint256 waiting = b.receiver.fitWaitingT();
        _m(b).sync();
        (, uint256 t1,) = _budgets(b);
        assertEq(t1 - t0, (waiting > 1 ? waiting - 1 : 0) + (tBack - 1), "handed back into the sell-for-FIT ledger");
        _assertLedgersAreClaims(b);
    }

    /// Another address's identical swap pays the box's split as usual: only the module's own notes come back.
    function test_BC133_anotherAddresssIdenticalSwapIsSplitAsUsual() public {
        Box memory a = _readyBox();
        Box memory c = _readyBox();
        _mintQ(a, 0.01 ether);
        a.receiver.collect(keeper);
        _mintQ(c, 0.01 ether);
        c.receiver.collect(keeper);
        _roll(1);
        Result memory r = _step(a, BUY, keeper);
        _buy(c, alice, r.amountIn, 0);
        (uint256 noteC,) = c.receiver.moduleFeesPending();
        assertEq(noteC, 0, "a stranger's swap notes nothing");
        _mintQ(a, 0.01 ether);
        _mintQ(c, 0.01 ether);
        uint256 fitA0 = a.receiver.fitOwed();
        uint256 fitC0 = c.receiver.fitOwed();
        a.receiver.collect(keeper);
        c.receiver.collect(keeper);
        assertGt(c.receiver.fitOwed() - fitC0, a.receiver.fitOwed() - fitA0, "the stranger's fee is split (FIT's 3/15)");
    }
}
