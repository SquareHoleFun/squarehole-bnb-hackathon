// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {IBoxReceiver} from "../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxSwapModule} from "../../../src/box/interfaces/IBoxSwapModule.sol";
import {BoxSwapModuleBase} from "./BoxSwapModuleBase.sol";

/// @notice S5.M3, the creator conversions (docs/design/swap-module-v1.md § 4.1 items 1-3, § 4.3, § 4.8): `BuyForCreator`
/// (CREATOR_IN_T: the buyers' 10/15 in Q buys T for the payee) and `SellForCreator` (CREATOR_IN_Q: the sellers' 10/15 in
/// T is sold for Q for the payee) on a real `BoxSwapModule` clone, the box's sampler and its own graduated pool. BC-125
/// (bounded, after graduation, the payee's ledger only, the FIT and depth parts of a TO_CREATOR twin), BC-133 (REV-16:
/// returned fees go back to the creator ledger that paid them first) and BC-134 (the creator actions skip, never revert).
contract BoxSwapCreatorTest is BoxSwapModuleBase {
    IBoxSwapModule.Action internal constant BUY = IBoxSwapModule.Action.BuyBurn;
    IBoxSwapModule.Action internal constant BUY_C = IBoxSwapModule.Action.BuyForCreator;
    IBoxSwapModule.Action internal constant SELL = IBoxSwapModule.Action.SellForFit;
    IBoxSwapModule.Action internal constant SELL_C = IBoxSwapModule.Action.SellForCreator;

    function setUp() public {
        _setUpModuleWorld();
    }

    /// A Standard box with a creator kind (payee carol) and a real module.
    function _cp(uint8 qs, uint8 ts) internal view returns (Params memory p) {
        p = _mp(qs, ts, false);
        p.payee = carol;
    }

    /// Graduated, both budgets fed through the receiver's split (1 ETH of the buyers' 10/15, 2,000,000 T of the
    /// sellers' 10/15 and 600,000 T of FIT's 3/15), the average ready at P1.
    function _readyCreatorBox(uint8 qs, uint8 ts) internal returns (Box memory b) {
        b = _graduatedBox(_cp(qs, ts));
        _feedQ(b, 1.5 ether);
        _feedT(b, 3_000_000e18);
        _readyAverage(b);
    }

    function _creatorBudgets(Box memory b) internal view returns (uint256 qCreator, uint256 tForCreator) {
        (, qCreator,, tForCreator,) = _m(b).budgets();
    }

    // ============================================================================================================
    // BC-125: creator payouts in the other token, bought or sold within bounds, after graduation

    /// What a step's checks read before it.
    struct Before {
        uint160 sqrtP;
        int24 tick;
        uint256 owedQ;
        uint256 owedT;
        uint256 handed;
        uint256 supply;
        uint256 keeper;
        uint256 fit;
    }

    function _before(Box memory b, bool buy) internal view returns (Before memory x) {
        (x.sqrtP, x.tick) = (_sqrtP(b), _spotTick(b));
        (x.owedQ, x.owedT) = b.receiver.creatorOwed();
        (, uint256 qc,, uint256 tc,,,) = b.receiver.moduleOwed();
        x.handed = (buy ? qc : tc) - 1;
        (x.supply, x.keeper, x.fit) = (b.t.totalSupply(), keeper.balance, b.receiver.fitOwed());
    }

    /// § 4.4's bounds on one step, recomputed from TickMath (not the module's library).
    function _assertBounded(Box memory b, bool buy, Before memory x, Result memory r) internal view {
        assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.None), "a step ran");
        int24 ref = _ref(b, buy);
        uint160 limit = _limit(buy, x.sqrtP, ref);
        if (buy) {
            assertGe(_sqrtP(b), limit, "never beyond the limit");
            assertGe(uint256(_sqrtP(b)), _impactSqrt(true, x.sqrtP), "at most 49 ticks of impact");
            assertGe(_sqrtP(b), _bandSqrt(true, ref), "never beyond the reference - 99 ticks");
            assertGe(_spotTick(b), x.tick - IMPACT - 1, "the tick moved at most 49 (+1 for the tick's floor)");
            assertEq(r.tip, _tipOf(r.amountIn), "tip: 5% of the input under the cap");
        } else {
            assertLe(_sqrtP(b), limit, "never beyond the limit");
            assertLe(uint256(_sqrtP(b)), _impactSqrt(false, x.sqrtP), "at most 49 ticks of impact");
            assertLe(_sqrtP(b), _bandSqrt(false, ref), "never beyond the reference + 99 ticks");
            assertLe(_spotTick(b), x.tick + IMPACT, "the tick moved at most 49");
            assertEq(r.tip, _tipOf(r.amountOut), "tip: 5% of the output under the cap");
        }
        assertGe(r.amountOut, _minOut(buy, r.amountIn, limit), "output at least the minimum at the limit price");
        assertEq(keeper.balance - x.keeper, r.tip, "paid to tipTo in Q");
    }

    function test_BC125_buyForCreatorIsBoundedAndPaysThePayeeInT() public {
        Box memory b = _readyCreatorBox(BoxSpecV1.Q_STREAM_CREATOR_IN_T, BoxSpecV1.T_STREAM_BURN_T);
        Before memory x = _before(b, true);
        _roll(1);
        Result memory r = _step(b, BUY_C, keeper);
        _assertBounded(b, true, x, r);
        assertGt(r.amountIn, 0.009 ether, "a full step at graduation's depth");
        (uint256 cq1, uint256 ct1) = b.receiver.creatorOwed();
        assertEq(ct1 - x.owedT, r.amountOut, "every T bought owed to the payee (moduleProceeds, CreatorT)");
        assertEq(cq1, x.owedQ, "no Q to the payee");
        assertEq(b.t.totalSupply(), x.supply, "nothing burned");
        (uint256 qCreator,) = _creatorBudgets(b);
        assertEq(qCreator, x.handed - r.amountIn - r.tip, "the creator-buy ledger: handed less input and tip");
        (uint256 noteQ, uint256 noteT) = b.receiver.moduleFeesPending();
        assertEq(noteQ, r.amountIn / 100 - 2 * SLACK, "REV-16: 1% of the input less the slack, noted");
        assertEq(noteT, 0);
        (uint256 cfq, uint256 cft) = _m(b).creatorFeesPending();
        assertEq(cfq, noteQ, "the note is the creator-buy ledger's (swap-module 4.8)");
        assertEq(cft, 0);
        // The payee pulls it as T.
        uint256 carolT0 = b.t.balanceOf(carol);
        vm.prank(carol);
        (uint256 gq, uint256 gt) = b.receiver.claimCreator(carol);
        assertEq(gq, cq1);
        assertEq(gt, ct1);
        assertEq(b.t.balanceOf(carol) - carolT0, ct1, "claimCreator pays the T");
        _assertLedgersAreClaims(b);
    }

    function test_BC125_sellForCreatorIsBoundedAndPaysThePayeeInQ() public {
        Box memory b = _readyCreatorBox(BoxSpecV1.Q_STREAM_ALL_TO_FIT, BoxSpecV1.T_STREAM_CREATOR_IN_Q);
        Before memory x = _before(b, false);
        _roll(1);
        Result memory r = _step(b, SELL_C, keeper);
        _assertBounded(b, false, x, r);
        (uint256 cq1, uint256 ct1) = b.receiver.creatorOwed();
        assertEq(cq1 - x.owedQ, r.amountOut - r.tip, "its Q owed to the payee (moduleProceeds, CreatorQ)");
        assertEq(ct1, x.owedT, "no T to the payee");
        assertEq(b.receiver.fitOwed(), x.fit, "nothing of it to FIT");
        (, uint256 tForCreator) = _creatorBudgets(b);
        assertEq(tForCreator, x.handed - r.amountIn, "the creator-sell ledger: handed less the T sold");
        (uint256 noteQ, uint256 noteT) = b.receiver.moduleFeesPending();
        assertEq(noteQ, 0);
        assertEq(noteT, r.amountIn / 100 - 2 * SLACK, "REV-16 in T");
        (uint256 cfq, uint256 cft) = _m(b).creatorFeesPending();
        assertEq(cft, noteT, "the note is the creator-sell ledger's");
        assertEq(cfq, 0);
        uint256 carol0 = carol.balance;
        vm.prank(carol);
        (uint256 gq,) = b.receiver.claimCreator(carol);
        assertEq(gq, cq1);
        assertEq(carol.balance - carol0, cq1, "claimCreator pays the Q");
        _assertLedgersAreClaims(b);
    }

    /// Before graduation the creator's share is held in the module's ledgers, never swapped on the curve; the module
    /// skips NotGraduated and the pull hands nothing; after the settlement it converts.
    function test_BC125_heldUntilGraduationNeverSwappedOnTheCurve() public {
        Box memory b = _buildAndLaunch(_cp(BoxSpecV1.Q_STREAM_CREATOR_IN_T, BoxSpecV1.T_STREAM_CREATOR_IN_Q));
        _skipWindow(b);
        _feedQ(b, 1.5 ether);
        _feedT(b, 3_000_000e18);
        (, uint256 qc,, uint256 tc,,, bool held) = b.receiver.moduleOwed();
        assertTrue(held, "held until the settlement");
        assertGe(qc, 1 ether, "CREATOR_IN_T's Q in the creator-buy ledger");
        assertGe(tc, 2_000_000e18, "CREATOR_IN_Q's T in the creator-sell ledger");
        (uint256 hq, uint256 ht) = b.receiver.creatorHeld();
        assertEq(hq + ht, 0, "not creator credits: the module converts them");
        uint160 s0 = _sqrtP(b);
        _roll(1);
        assertEq(uint256(_step(b, BUY_C, keeper).stop), uint256(IBoxSwapModule.Stop.NotGraduated));
        _roll(1);
        assertEq(uint256(_step(b, SELL_C, keeper).stop), uint256(IBoxSwapModule.Stop.NotGraduated));
        assertEq(_sqrtP(b), s0, "no swap on the curve");
        (uint256 mq, uint256 mt) = _creatorBudgets(b);
        assertEq(mq + mt, 0, "nothing handed before the settlement");
        _closeAndGraduate(b);
        _readyAverage(b);
        _roll(1);
        assertEq(uint256(_step(b, BUY_C, keeper).stop), uint256(IBoxSwapModule.Stop.None), "converts after it");
        _roll(1);
        assertEq(uint256(_step(b, SELL_C, keeper).stop), uint256(IBoxSwapModule.Stop.None));
        _assertLedgersAreClaims(b);
    }

    /// The FIT 3/15 and depth 2/15 of a creator-conversion box equal its TO_CREATOR twin's to the wei, before and after
    /// graduation, and the twin's creator credits are exactly what the conversion box hands its module.
    function test_BC125_fitAndDepthPartsEqualTheToCreatorTwinsToTheWei() public {
        Box memory a = _buildAndLaunch(_cp(BoxSpecV1.Q_STREAM_CREATOR_IN_T, BoxSpecV1.T_STREAM_CREATOR_IN_Q));
        Box memory w = _buildAndLaunch(_cp(BoxSpecV1.Q_STREAM_TO_CREATOR, BoxSpecV1.T_STREAM_TO_CREATOR));
        _skipWindow(a);
        _skipWindow(w);
        _sameTrades(a, w, 1 ether);
        _closeAndGraduate(a);
        _closeAndGraduate(w);
        _sameTrades(a, w, 2 ether);
        _sameTrades(a, w, 0.8 ether);
        _assertTwins(a, w);
    }

    function _sameTrades(Box memory a, Box memory w, uint256 eth) internal {
        (uint256 ta,) = _buy(a, alice, eth, 0);
        (uint256 tw,) = _buy(w, bob, eth, 0);
        assertEq(ta, tw, "identical boxes, identical trades");
        _sell(a, alice, ta / 2);
        _sell(w, bob, tw / 2);
        a.receiver.collect(keeper);
        w.receiver.collect(keeper);
        _roll(1);
    }

    function _assertTwins(Box memory a, Box memory w) internal view {
        (uint256 aFit,, uint256 aQDepth, uint256 aTDepth, uint256 aBurned,,) = a.receiver.totals();
        (uint256 wFit,, uint256 wQDepth, uint256 wTDepth, uint256 wBurned,,) = w.receiver.totals();
        assertEq(aFit, wFit, "FIT's Q parts to the wei");
        assertEq(a.receiver.fitWaitingT(), w.receiver.fitWaitingT(), "FIT's T parts to the wei");
        assertEq(aQDepth, wQDepth, "Q depth parts to the wei");
        assertEq(aTDepth, wTDepth, "T depth parts to the wei");
        assertEq(aBurned, wBurned, "nothing burned on either");
        (, uint256 qc,, uint256 tc,,,) = a.receiver.moduleOwed();
        (uint256 wq, uint256 wt) = w.receiver.creatorOwed();
        assertEq(qc, wq, "CREATOR_IN_T's Q handed for its buy == the twin's TO_CREATOR Q");
        assertEq(tc, wt, "CREATOR_IN_Q's T sold for the payee == the twin's TO_CREATOR T");
    }

    /// The ledger is the role's: a handed-over payee claims everything, the previous one nothing.
    function test_BC125_onlyTheCurrentPayeeClaims() public {
        Box memory b = _readyCreatorBox(BoxSpecV1.Q_STREAM_CREATOR_IN_T, BoxSpecV1.T_STREAM_CREATOR_IN_Q);
        vm.prank(carol);
        b.receiver.proposeCreatorPayee(alice);
        vm.prank(alice);
        b.receiver.acceptCreatorPayee();
        _roll(1);
        Result memory rb = _step(b, BUY_C, keeper);
        _roll(1);
        Result memory rs = _step(b, SELL_C, keeper);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotPayee.selector, carol));
        b.receiver.claimCreator(carol);
        uint256 aliceQ0 = alice.balance;
        uint256 aliceT0 = b.t.balanceOf(alice);
        vm.prank(alice);
        (uint256 gq, uint256 gt) = b.receiver.claimCreator(alice);
        assertEq(gt, rb.amountOut, "the T the module bought, to the current payee");
        assertEq(gq, rs.amountOut - rs.tip, "the Q the module's sale paid, to the current payee");
        assertEq(alice.balance - aliceQ0, gq);
        assertEq(b.t.balanceOf(alice) - aliceT0, gt);
    }

    // ============================================================================================================
    // BC-133: returned fees go back to the creator ledger that paid them first (swap-module § 4.8)

    /// What the receiver owes the module (moduleOwed) and the module's ledgers (budgets), in one place.
    struct Owed {
        uint256 qBurn;
        uint256 qCreator;
        uint256 tFit;
        uint256 tCreator;
        uint256 qBack;
        uint256 tBack;
    }

    function _owedOf(Box memory b) internal view returns (Owed memory) {
        (uint256 a, uint256 c, uint256 d, uint256 e, uint256 f, uint256 g,) = b.receiver.moduleOwed();
        return Owed(a, c, d, e, f, g);
    }

    function _budgetsOf(Box memory b) internal view returns (Owed memory) {
        (uint256 a, uint256 c, uint256 d, uint256 e,) = _m(b).budgets();
        return Owed(a, c, d, e, 0, 0);
    }

    /// A CREATOR_IN_T box whose cap sent epoch 0's excess to the burn-buy ledger holds both kinds of buy Q; its
    /// CREATOR_IN_Q side and W4's 3/15 hold both kinds of sell T. In epoch 1 (room again, so the creator's T is sold)
    /// each step's fee comes back to the ledger that paid it.
    function test_BC133_returnedFeesGoBackToTheCreatorLedgerThatPaidThem() public {
        Params memory p = _cp(BoxSpecV1.Q_STREAM_CREATOR_IN_T, BoxSpecV1.T_STREAM_CREATOR_IN_Q);
        (p.creatorCap, p.capExcess) = (0.5 ether, BoxSpecV1.CAP_EXCESS_BURN);
        Box memory b = _graduatedBox(p);
        _feedQ(b, 3 ether);
        vm.warp(block.timestamp + 30 days);
        _feedT(b, 3_000_000e18);
        _readyAverage(b);
        Owed memory o = _owedOf(b);
        assertGt(o.qBurn, 1, "the cap's excess waits in the burn-buy ledger");
        assertGt(o.qCreator, 1);
        // Clear the fees waiting from the setup.
        _mintQ(b, 0.01 ether);
        b.receiver.collect(keeper);
        (uint256 qNoteCreator, uint256 tNoteCreator) = _fourSteps(b);
        // The next collect returns them whole (moduleBack*), the next pull hands them back.
        (uint256 noteQ, uint256 noteT) = b.receiver.moduleFeesPending();
        _mintQ(b, 0.01 ether);
        b.receiver.collect(keeper);
        o = _owedOf(b);
        assertEq(o.qBack, noteQ, "returned whole (the back ledgers' first return)");
        assertEq(o.tBack, noteT);
        Owed memory m0 = _budgetsOf(b);
        _m(b).sync();
        Owed memory m1 = _budgetsOf(b);
        // Each receiver ledger keeps 1 raw unit; the creator ledgers get their own fees first, the rest the others.
        assertEq(m1.qCreator - m0.qCreator, _handed(o.qCreator) + qNoteCreator, "the creator-buy ledger: its own fee");
        assertEq(
            m1.qBurn - m0.qBurn, _handed(o.qBurn) + _handed(o.qBack) - qNoteCreator, "the burn-buy ledger: the rest"
        );
        assertEq(m1.tCreator - m0.tCreator, _handed(o.tCreator) + tNoteCreator, "the creator-sell ledger: its own fee");
        assertEq(
            m1.tFit - m0.tFit, _handed(o.tFit) + _handed(o.tBack) - tNoteCreator, "the sell-for-FIT ledger: the rest"
        );
        (uint256 cfq, uint256 cft) = _m(b).creatorFeesPending();
        assertEq(cfq + cft, 0, "nothing more owed to the creator ledgers");
        _assertLedgersAreClaims(b);
    }

    /// One step of each action, in four blocks: returns the creator steps' fee notes (Q, T).
    function _fourSteps(Box memory b) internal returns (uint256 qNoteCreator, uint256 tNoteCreator) {
        IBoxSwapModule.Action[4] memory acts = [BUY_C, BUY, SELL_C, SELL];
        uint256[4] memory notes;
        for (uint256 i; i < 4; ++i) {
            _roll(1);
            Result memory r = _step(b, acts[i], keeper);
            assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.None), "each step ran");
            notes[i] = r.amountIn / 100 - 2 * SLACK;
        }
        (qNoteCreator, tNoteCreator) = (notes[0], notes[2]);
        (uint256 cfq, uint256 cft) = _m(b).creatorFeesPending();
        assertEq(cfq, qNoteCreator, "the creator-buy step's Q fee, pending");
        assertEq(cft, tNoteCreator, "the creator-sell step's T fee, pending");
        (uint256 noteQ, uint256 noteT) = b.receiver.moduleFeesPending();
        assertEq(noteQ, notes[0] + notes[1], "both buys' fees noted");
        assertEq(noteT, notes[2] + notes[3], "both sells' fees noted");
    }

    function _handed(uint256 owed) internal pure returns (uint256) {
        return owed > 1 ? owed - 1 : 0;
    }

    // ============================================================================================================
    // BC-134: the creator actions skip like the others

    function test_BC134_creatorActionsSkipNeverRevert() public {
        // No creator ledger on a default box: nothing to do.
        Box memory d = _graduatedBox(_defaultParams());
        _feedQ(d, 1.5 ether);
        _readyAverage(d);
        _assertStop(d, BUY_C, IBoxSwapModule.Stop.NothingToDo, "no creator-buy ledger");
        _assertStop(d, SELL_C, IBoxSwapModule.Stop.NothingToDo, "no creator-sell ledger");
        // A creator box: below the step minimum (200,000 T of creator T at P1, about 0.004 ETH), then a second step in
        // a block.
        Box memory b = _graduatedBox(_cp(BoxSpecV1.Q_STREAM_CREATOR_IN_T, BoxSpecV1.T_STREAM_CREATOR_IN_Q));
        _readyAverage(b);
        _feedT(b, 300_000e18);
        _assertStop(b, SELL_C, IBoxSwapModule.Stop.BelowStepMin, "below the minimum");
        _roll(1);
        assertEq(uint256(_step(b, BUY_C, keeper).stop), uint256(IBoxSwapModule.Stop.None), "the creator-buy runs");
        _assertStop(b, SELL_C, IBoxSwapModule.Stop.BlockLimit, "one step per block across all actions");
        // Action None is not an action.
        vm.expectRevert(
            abi.encodeWithSelector(
                IBoxSwapModule.ActionNotBuilt.selector, BoxSpecV1.Q_STREAM_CREATOR_IN_T, BoxSpecV1.T_STREAM_CREATOR_IN_Q
            )
        );
        _m(b).step(IBoxSwapModule.Action.None, keeper);
    }

    function _assertStop(Box memory b, IBoxSwapModule.Action a, IBoxSwapModule.Stop want, string memory why) internal {
        Owed memory m0 = _budgetsOf(b);
        uint160 s0 = _sqrtP(b);
        Result memory r = _step(b, a, keeper);
        assertEq(uint256(r.stop), uint256(want), why);
        Owed memory m1 = _budgetsOf(b);
        assertEq(_sqrtP(b), s0, "no trade");
        // The pull may add to a ledger; a skip never spends one.
        assertGe(m1.qBurn, m0.qBurn);
        assertGe(m1.qCreator, m0.qCreator);
        assertGe(m1.tFit, m0.tFit);
        assertGe(m1.tCreator, m0.tCreator);
    }
}
