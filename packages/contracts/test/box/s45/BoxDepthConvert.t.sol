// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {FitBuybackExecutor} from "../../../src/box/FitBuybackExecutor.sol";
import {IBoxPriceAverage} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxSwapModule} from "../../../src/box/interfaces/IBoxSwapModule.sol";
import {DeepenSkip, DepthKind, FeeBatch} from "../../../src/box/interfaces/BoxTypes.sol";
import {BoxDepthConvertBase} from "./BoxDepthConvertBase.sol";

/// @notice S5.M5: F76's depth conversions inside `deepen()` (docs/design/swap-module-v1.md § 8 as revised in § 15
/// finding 2; R F76; R F77, box0-like-others.md § 5.3): Q that cannot be paired buys T in small capped steps inside
/// the swap module's bounds (BoxSwapBounds), the T waits as the hook's claims, and the pair follows in the same unlock
/// once the T side reaches MIN_ADD. Every box, box 0 included (F77 reverses the design's "box 0 never converts").
/// BC-137, with BC-133's hook side (the conversion's own fee note).
contract BoxDepthConvertTest is BoxDepthConvertBase {
    using StateLibrary for IPoolManager;

    address internal attacker = makeAddr("s5m5.attacker");

    function setUp() public {
        _setUpConvertWorld();
    }

    // ============================================================================================================
    // BC-137: a conversion alone

    /// A Standard box with Q-only depth: one call buys T within 49 ticks (never beyond t_ref − 99), checks the minimum
    /// output on what it spent, keeps the T as the hook's claims, pays the tip from the Q it spent, notes its own fee,
    /// and starts the 300-block cooldown; no add below MIN_ADD.
    function test_BC137_aConversionAloneKeepsItsTAsClaimsAndStartsTheCooldown() public {
        Box memory b = _graduated(false, true);
        _fundQ(b, 1 ether);
        _toAddable(b);
        _convertsAlone(b);
    }

    /// F77: box 0 converts like every box. Its conversion's note goes to the hook's own pending ledger (back to its
    /// claims, depth), apart from FIT's executor's (back to FIT).
    function test_BC137_box0ConvertsLikeEveryBox() public {
        Box memory b = _graduated(true, true);
        _fundQ(b, 1 ether);
        _toAddable(b);
        (uint256 execQ0,) = b.receiver.moduleFeesPending();
        _convertsAlone(b);
        (uint256 execQ1,) = b.receiver.moduleFeesPending();
        assertEq(execQ1, execQ0, "nothing on the executor's ledger");
    }

    function _convertsAlone(Box memory b) internal {
        Budget memory b0 = _budget(b);
        assertEq(b0.t, 0, "fixture: Q only");
        uint160 s0 = _sqrtP(b);
        int24 ref = _ref(b);
        uint160 limit = _limitOf(s0, ref);
        assertGt(limit, 0, "fixture: room to buy");
        uint256 keeper0 = keeper.balance;
        uint256 note0 = b.receiver.hookFeesPending();
        uint256 supply0 = b.t.totalSupply();
        (Deep memory d, Conv memory c) = _deepen(b);
        assertEq(uint256(d.skip), uint256(DeepenSkip.None));
        assertEq(uint256(d.kind), uint256(DepthKind.Convert), "a conversion alone");
        assertEq(b.t.totalSupply(), supply0, "no T minted or burned: it moves from the pool to the hook's claims");
        assertEq(b.t.balanceOf(b.t.vault()), 0, "nothing reaches the vault");
        assertTrue(c.seen, "DepthConverted");
        assertEq(c.ref, ref, "t_ref: the cheaper-T of the average and the latest sample");
        assertEq(c.sqrtBefore, s0);
        assertEq(c.limit, limit, "the nearer of 49 ticks of impact and t_ref - 99");
        assertEq(c.sqrtAfter, _sqrtP(b));
        assertEq(c.sqrtAfter, limit, "a budget far above one step spends the whole 49 ticks, no further");
        assertLe(c.qIn, _ceiling(b0.q, 0), "at most half the unpaired Q");
        assertGe(c.qIn, MIN_Q, "fixture: a full step at graduation's depth");
        assertGe(c.tOut, _minOut(c.qIn, limit), "the minimum output, on what it spent");
        Budget memory b1 = _budget(b);
        assertEq(b0.q - b1.q, c.qIn + d.tip, "the Q budget fell by exactly the input and the tip");
        assertEq(b1.t - b0.t, c.tOut, "the T bought stays as the hook's claims");
        assertEq(d.q, c.qIn, "qUsed: the Q the call spent");
        assertEq(d.t, 0, "no T placed");
        assertEq(d.tip, _tipOf(c.qIn), "tip: min(5% of the Q spent, the cap)");
        assertEq(keeper.balance - keeper0, d.tip, "paid in Q, to tipTo");
        assertEq(b.hook.pairedLiquidity(), 0, "no add below MIN_ADD");
        assertLt(_tValue(b1.t, c.sqrtAfter), b.hook.minAdd(), "the T side still below MIN_ADD: a conversion alone");
        assertEq(b.receiver.hookFeesPending() - note0, _note(c.qIn), "REV-16: its own LP fee noted");
        _assertClaimsAreTheBudget(b);
        // The 300-block cooldown applies to a conversion as to an add.
        assertEq(b.hook.lastDeepenBlock(), block.number);
        (d,) = _deepen(b);
        assertEq(uint256(d.skip), uint256(DeepenSkip.Cooldown), "never two in a block");
        _roll(299);
        if (_isSettable(b)) _setAverage(b, 0, 0);
        (d,) = _deepen(b);
        assertEq(uint256(d.skip), uint256(DeepenSkip.Cooldown), "299 blocks");
        _roll(1);
        if (_isSettable(b)) _setAverage(b, 0, 0);
        (d, c) = _deepen(b);
        assertEq(uint256(d.skip), uint256(DeepenSkip.None), "300 blocks");
        assertTrue(c.seen, "the next conversion");
        _assertClaimsAreTheBudget(b);
    }

    // ============================================================================================================
    // BC-137: the bounds

    /// The limit is the nearer to spot of 49 ticks of impact and t_ref − 99: with the latest sample 70 ticks above
    /// spot (cheaper T), the band binds at 29 ticks and the conversion spends that room (above the minimum). With it 98
    /// above, one or two ticks of room are left: the S5 review's fix measures what the swap can spend there (below the
    /// minimum, and no pair in reach), so the call skips with `ConvertBelowMin`, no swap and no cooldown.
    function test_BC137_theLimitIsTheNearerOf49TicksAndTheBand() public {
        for (uint256 i; i < 2; ++i) {
            int24 offset = i == 0 ? int24(70) : int24(98);
            Box memory b = _graduated(i == 1, true);
            _fundQ(b, 1 ether);
            _toAddable(b);
            _setAverage(b, 0, offset);
            uint160 s0 = _sqrtP(b);
            int24 ref = _ref(b);
            assertEq(ref, _tick(b) + offset, "t_ref is the latest sample here (the cheaper-T reading)");
            uint160 band = TickMath.getSqrtPriceAtTick(ref - 99);
            uint256 last = b.hook.lastDeepenBlock();
            Budget memory b0 = _budget(b);
            (Deep memory d, Conv memory c) = _deepen(b);
            if (i == 1) {
                assertEq(uint256(d.skip), uint256(DeepenSkip.ConvertBelowMin), "a sliver of room: a skip");
                assertFalse(c.seen, "no swap");
                assertEq(_sqrtP(b), s0);
                assertEq(b.hook.lastDeepenBlock(), last, "no cooldown");
                assertEq(_budget(b).q, b0.q, "the budget stays");
                continue;
            }
            assertEq(uint256(d.kind), uint256(DepthKind.Convert));
            assertEq(c.limit, band, "the band is nearer than 49 ticks");
            assertEq(c.limit, _limitOf(s0, ref));
            assertEq(c.sqrtAfter, band, "the swap stops exactly at t_ref - 99");
            assertGe(c.tOut, _minOut(c.qIn, c.limit));
            assertGe(c.qIn, MIN_Q, "29 ticks of room at graduation's depth are above the minimum");
            _assertClaimsAreTheBudget(b);
        }
    }

    /// S5 review (finding 2), a push: the attacker pushes spot 98 ticks down in deepen()'s block (the average does not
    /// move, |average − spot| = 98 passes the guards, and one tick of room is left before t_ref − 99). The conversion
    /// would spend a sliver; it skips with `ConvertBelowMin` instead, starting no cooldown, so once the push is unwound
    /// the next block converts a full step. Real averages: the Standard box's sampler and box 0's FIT executor ring.
    function test_BC137_aPushToTheBandsEdgeSkipsWithNoCooldown() public {
        for (uint256 i; i < 2; ++i) {
            bool box0 = i == 1;
            Box memory b = _graduated(box0, false);
            _fundQ(b, 1 ether);
            _realAverageReadyAndAddable(b, box0);
            int24 fair = _spotTick(b);
            uint160 fairSqrt = _sqrtP(b);
            uint256 last = b.hook.lastDeepenBlock();
            Budget memory b0 = _budget(b);
            vm.deal(attacker, 100 ether);
            _buyToTick(b, attacker, fair - 98);
            (Deep memory d, Conv memory c) = _deepen(b);
            assertEq(uint256(d.skip), uint256(DeepenSkip.ConvertBelowMin), "the band's edge: a skip, not a sliver");
            assertFalse(c.seen, "no swap");
            assertEq(b.hook.lastDeepenBlock(), last, "no cooldown");
            assertEq(_budget(b).q, b0.q, "the budget stays");
            _toTick(b, attacker, fairSqrt);
            _roll(1);
            (d, c) = _deepen(b);
            assertEq(uint256(d.kind), uint256(DepthKind.Convert), "the next block converts");
            assertGe(c.qIn, MIN_Q, "a full step");
            assertEq(b.hook.lastDeepenBlock(), block.number);
            _assertClaimsAreTheBudget(b);
        }
    }

    /// S5 review (finding 2), no attacker: a default box's own buy-back (two BuyBurn steps in two blocks) walks spot to
    /// t_ref − 99; the next deepen() skips with `ConvertBelowMin` and no cooldown; once the average follows the price,
    /// deepen() converts a full step.
    function test_BC137_theBoxsOwnBuyBackBeforeDeepenSkipsWithNoCooldown() public {
        Params memory p = _standardParams(address(0));
        (p.qStream, p.realModule) = (BoxSpecV1.Q_STREAM_BUYBACK_BURN_T, true);
        Box memory b = _buildAndLaunch(p);
        _skipWindow(b);
        _closeAndGraduate(b);
        _fundQ(b, 1 ether);
        vm.deal(address(this), address(this).balance + 3 ether);
        b.receiver.fundFees{value: 3 ether}();
        IBoxPriceAverage(b.average).poke();
        uint256 from = b.hook.migratedAtBlock() + 301;
        if (block.number < from) _roll(from - block.number);
        IBoxPriceAverage(b.average).poke();
        int24 fair = _spotTick(b);
        for (uint256 j; j < 2; ++j) {
            _roll(1);
            (IBoxSwapModule.Stop st,,,) = IBoxSwapModule(b.module).step(IBoxSwapModule.Action.BuyBurn, keeper);
            assertEq(uint256(st), uint256(IBoxSwapModule.Stop.None), "fixture: the buy-back stepped");
        }
        assertLe(_spotTick(b), fair - 97, "fixture: the buy-back walked spot to the band's edge");
        _roll(1);
        uint256 last = b.hook.lastDeepenBlock();
        Budget memory b0 = _budget(b);
        (Deep memory d, Conv memory c) = _deepen(b);
        assertEq(uint256(d.skip), uint256(DeepenSkip.ConvertBelowMin), "a sliver of room: a skip");
        assertFalse(c.seen, "no swap");
        assertEq(b.hook.lastDeepenBlock(), last, "no cooldown");
        assertEq(_budget(b).q, b0.q);
        // The average follows the price (pokes over an hour), and the room comes back.
        for (uint256 j; j < 12; ++j) {
            _roll(25);
            IBoxPriceAverage(b.average).poke();
        }
        (d, c) = _deepen(b);
        assertEq(uint256(d.kind), uint256(DepthKind.Convert), "converts once the average followed");
        assertGe(c.qIn, MIN_Q, "a full step");
        _assertClaimsAreTheBudget(b);
    }

    /// The real average ready (the Standard box's sampler: its first poke, then the hour; box 0: FIT's executor ring
    /// poked over 600 blocks) and the cooldown since migration passed.
    function _realAverageReadyAndAddable(Box memory b, bool box0) internal {
        if (box0) {
            for (uint256 j; j < 600; ++j) {
                _roll(1);
                IBoxPriceAverage(b.average).poke();
            }
        } else {
            IBoxPriceAverage(b.average).poke();
        }
        uint256 last = b.hook.lastDeepenBlock();
        uint256 from = (last == 0 ? b.hook.migratedAtBlock() : last) + 300;
        if (block.number < from) _roll(from - block.number);
        _roll(1);
        IBoxPriceAverage(b.average).poke();
        _roll(1);
    }

    /// Half the unpaired Q is the ceiling: with the T side worth 0.015 ETH and 0.030 ETH of Q, the conversion spends
    /// exactly 0.0075 ETH (inside the 49-tick room), which brings both sides to MIN_ADD, so the pair follows in the
    /// same unlock at the re-read price.
    function test_BC137_halfTheUnpairedQ_thenThePairAtTheReReadPrice() public {
        Box memory b = _graduated(false, true);
        _toAddable(b);
        uint160 s0 = _sqrtP(b);
        _fundT(b, _tFor(0.015 ether, s0));
        uint256 tValue = _tValue(_budget(b).t, s0);
        _setQ(b, tValue + 0.015 ether);
        _pairsAfterAConversion(b, 0.0075 ether);
    }

    /// A conversion followed by a pair has no separate minimum: 0.003 ETH (below 0.005) runs because it brings the T
    /// side (worth 0.019 ETH) to MIN_ADD.
    function test_BC137_aConversionThatPairsHasNoSeparateMinimum() public {
        Box memory b = _graduated(true, true);
        _toAddable(b);
        uint160 s0 = _sqrtP(b);
        _fundT(b, _tFor(0.019 ether, s0));
        uint256 tValue = _tValue(_budget(b).t, s0);
        _setQ(b, tValue + 0.006 ether);
        _pairsAfterAConversion(b, 0.003 ether);
    }

    function _pairsAfterAConversion(Box memory b, uint256 x) internal {
        Budget memory b0 = _budget(b);
        uint256 minAdd = b.hook.minAdd();
        assertGe(b0.q, minAdd, "fixture: the Q side at MIN_ADD");
        assertLt(_tValue(b0.t, _sqrtP(b)), minAdd, "fixture: the T side below it");
        assertEq(_ceiling(b0.q, _tValue(b0.t, _sqrtP(b))), x, "fixture: half the unpaired Q");
        (Deep memory d, Conv memory c) = _deepen(b);
        assertEq(uint256(d.skip), uint256(DeepenSkip.None));
        assertTrue(c.seen, "a conversion first");
        assertEq(c.qIn, x, "exactly half the unpaired Q (inside the 49-tick room)");
        assertGt(c.sqrtAfter, c.limit, "it stopped before the limit");
        assertGe(c.tOut, _minOut(c.qIn, c.limit));
        assertEq(uint256(d.kind), uint256(DepthKind.Pair), "then the pair, in the same unlock");
        // Both sides reached MIN_ADD at the re-read price before the add (no add below MIN_ADD).
        assertGe(b0.q - c.qIn, minAdd, "the Q side after the conversion");
        assertGe(_tValue(b0.t + c.tOut, c.sqrtAfter), minAdd, "the T side after the conversion, at the re-read price");
        uint128 l = b.hook.pairedLiquidity();
        assertGt(l, 0);
        assertEq(_sqrtP(b), c.sqrtAfter, "the add does not move the price");
        Budget memory b1 = _budget(b);
        uint256 pairedQ = d.q - c.qIn;
        assertEq(b0.q - b1.q, d.q + d.tip, "the Q budget fell by every Q the call spent and the tip");
        assertEq(b0.t + c.tOut - b1.t, d.t, "the T budget: plus the T bought, less the T paired");
        assertEq(d.tip, _tipOf(d.q), "one tip for the call, on all the Q it spent");
        assertApproxEqRel(d.t, _tFor(pairedQ, c.sqrtAfter), 1e15, "the pair's ratio is the re-read price's");
        assertApproxEqAbs(pairedQ, _fullRangeQ(l, c.sqrtAfter), 2, "the pair holds its Q at the re-read price");
        _assertClaimsAreTheBudget(b);
    }

    /// A conversion alone needs x ≥ 0.005 ETH: one raw unit below it (and no pair in reach) skips with
    /// `ConvertBelowMin` and keeps everything (no swap, no cooldown); at exactly the minimum it runs alone.
    function test_BC137_aConversionAloneNeedsTheMinimum() public {
        Box memory b = _graduated(false, true);
        _toAddable(b);
        uint160 s0 = _sqrtP(b);
        _fundT(b, _tFor(0.012 ether, s0));
        uint256 tValue = _tValue(_budget(b).t, s0);
        _setQ(b, tValue + 2 * MIN_Q - 2);
        Budget memory b0 = _budget(b);
        assertEq(_ceiling(b0.q, tValue), MIN_Q - 1, "fixture: one raw unit below the minimum");
        uint256 last = b.hook.lastDeepenBlock();
        (Deep memory d, Conv memory c) = _deepen(b);
        assertEq(uint256(d.skip), uint256(DeepenSkip.ConvertBelowMin));
        assertEq(uint256(d.kind), uint256(DepthKind.None));
        assertFalse(c.seen, "no swap");
        assertEq(_sqrtP(b), s0);
        Budget memory b1 = _budget(b);
        assertEq(b1.q, b0.q, "the budget stays");
        assertEq(b1.t, b0.t);
        assertEq(b.hook.lastDeepenBlock(), last, "a skip starts no cooldown");
        _fundQ(b, 2);
        (d, c) = _deepen(b);
        assertEq(uint256(d.skip), uint256(DeepenSkip.None), "exactly the minimum runs");
        assertEq(uint256(d.kind), uint256(DepthKind.Convert), "alone: the T side stays below MIN_ADD");
        assertEq(c.qIn, MIN_Q);
        _assertClaimsAreTheBudget(b);
    }

    /// The Q side below MIN_ADD neither converts nor adds (BudgetBelowMin), whatever the T side.
    function test_BC137_theQSideBelowMinAddNeverConverts() public {
        Box memory b = _graduated(true, true);
        _toAddable(b);
        _setQ(b, b.hook.minAdd() - 1);
        Budget memory b0 = _budget(b);
        (Deep memory d, Conv memory c) = _deepen(b);
        assertEq(uint256(d.skip), uint256(DeepenSkip.BudgetBelowMin));
        assertFalse(c.seen);
        assertEq(_budget(b).q, b0.q);
    }

    /// The T side at MIN_ADD pairs as built: no conversion, no swap.
    function test_BC137_aTSideAtMinAddPairsWithoutAConversion() public {
        Box memory b = _graduated(false, true);
        _toAddable(b);
        uint160 s0 = _sqrtP(b);
        _fundQ(b, 1 ether);
        _fundT(b, _tFor(b.hook.minAdd() + 1e12, s0));
        (Deep memory d, Conv memory c) = _deepen(b);
        assertEq(uint256(d.kind), uint256(DepthKind.Pair));
        assertFalse(c.seen, "no conversion");
        assertEq(_sqrtP(b), s0, "no swap");
    }

    // ============================================================================================================
    // BC-137: sandwiches, and box 0's two FIT buyers sharing one band

    /// A same-block push of 1-150 ticks before the conversion: never loosens its limit past t_ref − 99 (the average
    /// does not move in the push's block), a push beyond the guards only delays it, and the attacker never profits.
    function testFuzz_BC137_aSameBlockPushNeverLoosensTheConversion(uint256 kSeed, bool down, bool box0) public {
        int24 k = int24(int256(bound(kSeed, 1, 150)));
        (int256 net, Deep memory d, Conv memory c, int24 fair) = _sandwich(box0, k, down);
        if (c.seen) {
            assertEq(c.ref, fair, "the push moved no reference");
            assertGe(c.sqrtAfter, TickMath.getSqrtPriceAtTick(fair - 99), "never past t_ref - 99");
            assertEq(c.limit, _limitOf(c.sqrtBefore, fair));
        } else {
            assertTrue(d.skip != DeepenSkip.None, "a push beyond the guards only delays it");
        }
        assertLt(net, 0, "the attacker loses: 1% each way exceeds what the conversion's step can give");
    }

    /// The attacker's best case over pushes of 2 to 98 ticks, both ways, on box 0 and a Standard box (logged for the
    /// evidence; each must lose). Each conversion runs, except where a push the conversion's way leaves less room
    /// before t_ref − 99 than the minimum: that call skips with `ConvertBelowMin` and starts no cooldown (S5 review).
    function test_BC137_sandwichSweepNeverPays() public {
        for (uint256 kind; kind < 2; ++kind) {
            int256 best = type(int256).min;
            int256 bestK;
            for (int24 k = 2; k <= 98; k += 12) {
                for (uint256 dir; dir < 2; ++dir) {
                    uint256 snap = vm.snapshotState();
                    (int256 net, Deep memory d, Conv memory c,) = _sandwich(kind == 0, k, dir == 0);
                    if (!c.seen) {
                        assertTrue(dir == 0 && k >= 62, "only a push the conversion's way, near the band, skips");
                        assertEq(uint256(d.skip), uint256(DeepenSkip.ConvertBelowMin));
                    }
                    assertLt(net, 0, "every push loses");
                    if (net > best) (best, bestK) = (net, dir == 0 ? -int256(k) : int256(k));
                    vm.revertToState(snap);
                }
            }
            string memory label = kind == 0 ? "box 0" : "standard";
            emit log_named_int(string.concat("S5M5W|", label, "|best attacker net over pushes (wei)"), best);
            emit log_named_int(string.concat("S5M5W|", label, "|at push (ticks, - = bought first)"), bestK);
        }
    }

    /// A push of `k` ticks (`down`: the attacker buys T first, the conversion's way), the conversion, and the unwind to
    /// the fair price; the attacker's net in Q with its T leg valued at the fair price.
    function _sandwich(bool box0, int24 k, bool down)
        internal
        returns (int256 net, Deep memory d, Conv memory c, int24 fair)
    {
        Box memory b = _graduated(box0, true);
        _fundQ(b, 3 ether);
        _toAddable(b);
        // The tick of the √price (Slot0's reads one lower right after migrate's walk to P1).
        fair = _spotTick(b);
        SettablePriceAverageLike(b.average).set(true, fair, fair);
        deal(address(b.t), attacker, 1e27);
        vm.deal(attacker, 2000 ether);
        uint256 e0 = attacker.balance;
        uint256 t0 = b.t.balanceOf(attacker);
        uint160 fairSqrt = _sqrtP(b);
        if (down) _buyToTick(b, attacker, fair - k);
        else _sellToTick(b, attacker, fair + k);
        (d, c) = _deepen(b);
        _toTick(b, attacker, fairSqrt);
        net = (int256(attacker.balance) - int256(e0)) + _qAt(int256(b.t.balanceOf(attacker)) - int256(t0), fairSqrt);
    }

    /// Box 0 (F77): FIT's executor and the hook's conversion buy FIT in one pool, each at most 49 ticks a step, both
    /// stopping at the same t_ref − 99 of the same ring. In one block, in either order, after any small push, the price
    /// never passes the shared band.
    function testFuzz_BC137_box0TwoFitBuyersInOneBlockShareOneBand(uint256 kSeed, bool executorFirst) public {
        (Box memory b, FitBuybackExecutor ex) = _box0WithItsRing();
        _roll(1);
        int24 fair = _tick(b);
        int24 k = int24(int256(bound(kSeed, 0, 60)));
        vm.deal(attacker, 2000 ether);
        if (k > 0) _buyToTick(b, attacker, fair - k);
        if (executorFirst) {
            ex.execute(1);
            _deepen(b);
        } else {
            _deepen(b);
            ex.execute(1);
        }
        int24 ref = _ref(b);
        assertGe(_sqrtP(b), TickMath.getSqrtPriceAtTick(ref - 99), "never past the shared band");
        _assertClaimsAreTheBudget(b);
    }

    /// Both buyers run in one block; each fee note returns to its own ledger at the next collect: the executor's to
    /// FIT's budget (fitOwed), the hook's to its claims (depth), neither split nor crossed.
    function test_BC137_box0TwoFitBuyersNotesReturnApart() public {
        (Box memory b, FitBuybackExecutor ex) = _box0WithItsRing();
        _roll(1);
        (uint256 chunks,,) = ex.execute(1);
        assertEq(chunks, 1, "fixture: the executor bought");
        (Deep memory d, Conv memory c) = _deepen(b);
        assertEq(uint256(d.kind), uint256(DepthKind.Convert), "fixture: the hook converted in the same block");
        assertGe(_sqrtP(b), TickMath.getSqrtPriceAtTick(_ref(b) - 99));
        (uint256 e,) = b.receiver.moduleFeesPending();
        uint256 h = b.receiver.hookFeesPending();
        assertGt(e, 0, "the executor's note");
        assertEq(h, _note(c.qIn), "the hook's note");
        _mintQ(b, 0.3 ether);
        uint256 fit0 = b.receiver.fitOwed();
        (uint256 c0,) = b.receiver.carried();
        Budget memory h0 = _budget(b);
        FeeBatch memory fb = b.receiver.collect(keeper);
        uint256 unit = (fb.q - e - h - fb.tip + c0) / 15;
        assertEq(b.receiver.fitOwed() - fit0, e + unit * 11, "the executor's fee back to FIT, then 11/15");
        assertEq(_budget(b).q - h0.q, h + unit * 2, "the hook's fee back to its claims, then 2/15");
        assertEq(b.receiver.hookFeesPending(), 0);
    }

    // ============================================================================================================
    // BC-133 (the hook's side): its conversion's note is at most the fee its swap paid the box's positions, and
    // comes back whole to the depth budget, never split

    function test_BC133_theHooksConversionNoteIsAtMostItsSwapsFeeAndComesBackWhole() public {
        for (uint256 i; i < 2; ++i) {
            Box memory b = _graduated(i == 0, true);
            // Clear what waits from graduation, so the next batch holds only the conversion's fee and the minted 0.01.
            _mintQ(b, 0.01 ether);
            b.receiver.collect(keeper);
            _fundQ(b, 1 ether);
            _toAddable(b);
            (, Conv memory c) = _deepen(b);
            uint256 note = b.receiver.hookFeesPending();
            assertEq(note, _note(c.qIn));
            _mintQ(b, 0.01 ether);
            (uint256 c0,) = b.receiver.carried();
            Budget memory h0 = _budget(b);
            FeeBatch memory fb = b.receiver.collect(keeper);
            uint256 earned = fb.q - 0.01 ether;
            assertLe(note, earned, "never more than the box's positions earned");
            assertLe(earned - note, 2 * SLACK + 8, "within the slack of the fee");
            assertGe(earned, c.qIn / 100 - 1, "the positions earned the 1% of the conversion's input");
            uint256 unit = (fb.q - note - fb.tip + c0) / 15;
            assertEq(_budget(b).q - h0.q, note + unit * 2, "returned whole to the hook's claims, then the 2/15");
            assertEq(b.receiver.hookFeesPending(), 0);
            _assertClaimsAreTheBudget(b);
        }
    }

    // ============================================================================================================
    // Helpers

    /// Box 0 with its real average (FIT's executor ring, caught up from its seed: about 269 samples, then an hour),
    /// Q-only depth and an executor budget above its batch.
    function _box0WithItsRing() internal returns (Box memory b, FitBuybackExecutor ex) {
        b = _graduated(true, false);
        ex = FitBuybackExecutor(payable(b.executor));
        for (uint256 i; i < 600; ++i) {
            _roll(1);
            ex.poke();
        }
        _fundQ(b, 3 ether);
        vm.deal(address(this), address(this).balance + 1 ether);
        (bool ok,) = address(ex).call{value: 1 ether}("");
        assertTrue(ok);
        assertGe(ex.budget(), ex.batchThreshold(), "fixture: the executor's budget above its batch");
    }

    function _qAt(int256 tAmount, uint160 sqrtP) internal pure returns (int256) {
        uint256 abs = tAmount < 0 ? uint256(-tAmount) : uint256(tAmount);
        uint256 v = _tValue(abs, sqrtP);
        return tAmount < 0 ? -int256(v) : int256(v);
    }

    /// Trades the price back to exactly `target` from either side.
    function _toTick(Box memory b, address who, uint160 target) internal {
        uint160 s = _sqrtP(b);
        if (s == target) return;
        if (s > target) {
            uint256 v = who.balance;
            vm.prank(who);
            // forge-lint: disable-next-line(unsafe-typecast)
            swapper.swap{value: v}(b.key, true, -int256(v), target);
        } else {
            vm.startPrank(who);
            b.t.approve(address(swapper), type(uint256).max);
            swapper.swap(b.key, false, -int256(b.t.balanceOf(who)), target);
            vm.stopPrank();
        }
    }

    function _sellToTick(Box memory b, address who, int24 tick) internal {
        vm.startPrank(who);
        b.t.approve(address(swapper), type(uint256).max);
        swapper.swap(b.key, false, -int256(b.t.balanceOf(who)), TickMath.getSqrtPriceAtTick(tick));
        vm.stopPrank();
    }

    function _buyToTick(Box memory b, address who, int24 tick) internal {
        uint256 v = who.balance;
        vm.prank(who);
        // forge-lint: disable-next-line(unsafe-typecast)
        swapper.swap{value: v}(b.key, true, -int256(v), TickMath.getSqrtPriceAtTick(tick));
    }
}

interface SettablePriceAverageLike {
    function set(bool ready_, int24 avgTick_, int24 sample_) external;
}
