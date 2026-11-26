// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {DeepenSkip, DepthKind, FeeBatch} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU3ClaudeBase} from "./AuditU3ClaudeBase.sol";
import {AuditU3ClaudeDeepenWatch, AuditU3DeepenRec} from "./AuditU3ClaudeDeepenWatch.sol";

/// @notice SH-AUDIT-B0-U3 (Claude), lenses L1, L4, L5 and L7 on `deepen()` (P3.4, P3.10, P3.11, P3.16) on the factory's
/// box 0 with the real FitBuybackExecutor as its 1-hour average: graduated, the launch tax swept into the hook's
/// claims, 300 blocks on (the first add counts from the migration). Every `deepen()` goes through
/// `AuditU3ClaudeDeepenWatch`, which checks it against every documented rule (`IBoxHook.sol:65-87`, BC-119, BC-120,
/// BC-121, BC-133, BC-137, BC-142); a test then pins what the rule leaves open (the push table, the sliver, the add
/// cap's value at P1).
/// forge-config: default.evm_version = "osaka"
contract AuditU3ClaudeDepthTest is AuditU3ClaudeBase {
    using StateLibrary for IPoolManager;

    AuditU3ClaudeDeepenWatch internal watch;
    address internal giver = makeAddr("audit.u3.giver");

    function setUp() public virtual override {
        super.setUp();
        _ghostAddOutside(giver);
        _toBonding();
        // The whale holds T bought on the curve: it moves the price up (sells) after graduation.
        _buy(whale, 0.5 ether);
        _toGraduated();
        vm.prank(keeper);
        launchRouter.sweep();
        _advance(300);
        watch = new AuditU3ClaudeDeepenWatch(pm, hook, executor, receiver);
        vm.label(address(watch), "audit.u3.deepenWatch");
    }

    /// @notice One observed deepen by the keeper (tip to the keeper), booked on the ghost ledger, checked.
    function _watched() internal returns (AuditU3DeepenRec memory r) {
        uint256 e0 = keeper.balance;
        r = watch.deepenAs(keeper, keeper);
        _noteEthChange(e0, keeper.balance, EthIn.Other, EthOut.Tip);
        (uint8 code, string memory why) = watch.violation(r);
        assertEq(code, 0, why);
    }

    // ============================================================================================================
    // P3.4 / P3.16: the conversion, then the pair

    /// The first deepen after graduation: the hook holds only Q-side depth (the tax, the settlement's 2/15) and a T
    /// side below MIN_ADD, so it converts: at most half the unpaired Q, to the nearer of 49 ticks and t_ref − 99, the
    /// minimum output met, at least DEPTH_CONVERT_MIN_Q spent, the fee noted, the cooldown started, the claims moved by
    /// exactly what it reports; the tip is 5% capped (BC-137, BC-142, BC-133).
    function testProperty_AUDIT_U3_firstDeepenConvertsWithinItsBounds() public {
        AuditU3DeepenRec memory r = _watched();
        assertEq(r.kind, uint8(DepthKind.Convert));
        assertTrue(r.converted);
        assertGe(r.qIn, BoxSpecV1.DEPTH_CONVERT_MIN_Q);
        assertEq(r.tip, r.qIn * 5 / 100 > hook.deepenTipCap() ? hook.deepenTipCap() : r.qIn * 5 / 100);
        int24 moved = TickMath.getTickAtSqrtPrice(r.sqrt0) - TickMath.getTickAtSqrtPrice(r.sAfter);
        assertLe(moved, 49, "at most 49 ticks");
        emit log_named_uint("conversion: Q in (wei)", r.qIn);
        emit log_named_uint("conversion: T out (raw)", r.tOut);
        emit log_named_int("conversion: ticks moved", moved);
        emit log_named_uint("conversion: fee noted (wei)", r.note1 - r.note0);
        emit log_named_uint("tip (wei)", r.tip);
        _assertGhostLedger();
    }

    /// The second deepen 300 blocks later: a conversion brings the T side to MIN_ADD and the pair follows in the same
    /// unlock at the re-read price, its Q side capped at 10% of the core's Q within 953 ticks of t_ref (BC-120); the
    /// pair is a full-range position at salt 3 that no call shrinks.
    function testProperty_AUDIT_U3_conversionThenPairWithinBounds() public {
        _watched();
        _advance(300);
        AuditU3DeepenRec memory r = _watched();
        assertEq(r.kind, uint8(DepthKind.Pair), "the pair follows");
        assertGt(_pairL(), 0);
        assertEq(_pairL(), hook.pairedLiquidity());
        uint256 pairQ = r.qUsed - r.qIn;
        emit log_named_uint("pair: Q placed (wei)", pairQ);
        emit log_named_uint("pair: T placed (raw)", r.tUsed);
        emit log_named_uint("pair: cap, 10% of the core's Q near t_ref (wei)", r.capBase / 10);
        emit log_named_uint("MIN_ADD (wei)", hook.minAdd());
        // Pinned for the founder (evidence, Questions): at 1x the cap binds, and it is below MIN_ADD, so the pair's Q
        // side is 0.018983 ETH while MIN_ADD (BC-119, BC-137) is 0.021035 ETH: MIN_ADD gates the budget, not the add.
        assertEq(pairQ, r.capBase * 10 / 100, "the pair's Q is the cap (computed from StateLibrary)");
        assertEq(pairQ, 18_983_101_111_604_053, "measured: 0.018983101111604053 ETH");
        assertLt(pairQ, hook.minAdd(), "below MIN_ADD at 1x");
        _assertGhostLedger();
    }

    // ============================================================================================================
    // P3.10: pushes before deepen, with the real executor's average

    /// The push table: from the conversion state and from a pair state (T side gifted to MIN_ADD), the spot pushed 98,
    /// 99, 100 and 101 ticks above and below the 1-hour average in deepen's own block (the executor not yet sampled in
    /// it, so deepen's poke samples the pushed price): at 98 and 99 it either acts within every bound (the watch's
    /// rules) or skips `ConvertBelowMin` with no cooldown (the room to t_ref − 99 is a sliver); at 100 and 101 it skips
    /// `Deviation` with no cooldown. Never a cooldown on a sliver (S5 review #2 across the boundary).
    function testProperty_AUDIT_U3_pushTable98To101() public {
        uint256 snap = vm.snapshotState();
        for (uint256 pairState; pairState < 2; ++pairState) {
            for (uint256 k; k < 8; ++k) {
                vm.revertToState(snap);
                if (pairState == 1) _giftT(hook.minAdd() * 2);
                int24 d = int24(int256(98 + k / 2));
                if (k % 2 == 1) d = -d;
                (, int24 avg,) = _avgNow();
                _land(_sqrtAt(avg + d));
                AuditU3DeepenRec memory r = _watched();
                emit log_named_int(pairState == 1 ? "pair state, push (ticks)" : "convert state, push (ticks)", d);
                emit log_named_uint("  kind", r.kind);
                emit log_named_uint("  skip", r.skip);
                emit log_named_uint("  Q spent", r.qUsed);
                if (d > 99 || d < -99) {
                    assertEq(r.skip, uint8(DeepenSkip.Deviation), "beyond 99 ticks: Deviation");
                    assertEq(r.last1, r.last0, "no cooldown");
                } else if (r.skip != 0) {
                    assertEq(r.skip, uint8(DeepenSkip.ConvertBelowMin), "within 99: acts or skips a sliver");
                    assertEq(r.last1, r.last0, "no cooldown");
                } else {
                    assertEq(r.last1, vm.getBlockNumber());
                }
            }
        }
    }

    /// Any push (−130 … +130 ticks from the average, landing anywhere inside the tick), with or without the executor
    /// sampled earlier in the block, from the conversion state or a pair state: deepen breaks none of the watch's rules
    /// (it never acts more than 99 ticks from the average or its sample, never starts a cooldown on a skip or on a
    /// conversion alone below DEPTH_CONVERT_MIN_Q, never places a pair above the cap or below MIN_ADD's budget).
    function testFuzz_AUDIT_U3_pushThenDeepenKeepsEveryRule(int256 dSeed, uint256 frac, bool pokeFirst, bool pairState)
        public
    {
        if (pairState) _giftT(hook.minAdd() * 2);
        if (pokeFirst) executor.poke();
        (, int24 avg,) = _avgNow();
        int24 d = int24(bound(dSeed, -130, 130));
        uint160 lo = _sqrtAt(avg + d);
        uint160 hi = _sqrtAt(avg + d + 1);
        _land(uint160(bound(frac, lo, hi - 1)));
        AuditU3DeepenRec memory r = _watched();
        int256 dev = int256(r.spot0) - int256(avg);
        if (dev > 99 || dev < -99) assertTrue(r.skip != 0, "never acts beyond 99 ticks");
        if (pokeFirst && _abs(int256(r.sample) - int256(r.spot0)) > 99) {
            assertTrue(r.skip != 0, "never acts with the sample lagging beyond 99 ticks");
        }
    }

    /// Push, poke, unwind, then deepen, all in one block (dynamic-pool-share § 1.4's push-poke-unwind): the pushed
    /// sample (at most 100 ticks from the last) is held for the block while the spot returns anywhere within 60 ticks
    /// of the average; from the conversion state or a pair state, deepen keeps every rule of the watch: it never acts
    /// with spot more than 99 ticks from the average or the held sample, never converts past the higher of them less
    /// 99, never starts a cooldown on a skip or on a conversion alone below DEPTH_CONVERT_MIN_Q (BC-119, BC-137,
    /// BC-142).
    function testFuzz_AUDIT_U3_pushPokeUnwindThenDeepen(int256 pushSeed, int256 backSeed, uint256 frac, bool pairState)
        public
    {
        if (pairState) _giftT(hook.minAdd() * 2);
        (, int24 avg,) = _avgNow();
        int24 d = int24(bound(pushSeed, -140, 140));
        if (d != 0) _land(_sqrtAt(avg + d));
        executor.poke();
        int24 held = executor.latestSampleTick();
        int24 e = int24(bound(backSeed, -60, 60));
        uint160 lo = _sqrtAt(avg + e);
        uint160 hi = _sqrtAt(avg + e + 1);
        _land(uint160(bound(frac, lo, hi - 1)));
        AuditU3DeepenRec memory r = _watched();
        assertEq(r.sample, held, "the held sample is the one deepen reads");
        if (r.skip == uint8(DeepenSkip.None)) {
            assertLe(_abs(int256(r.sample) - int256(r.spot0)), 99, "acted only with the sample within 99");
            assertLe(_abs(int256(r.avg) - int256(r.spot0)), 99, "acted only with the average within 99");
        }
    }

    /// Any budget mix (P3.10, P3.16): a Q backlog of 0-12 ETH given through fundDepth() on top of the tax, a T side
    /// from nothing to three times MIN_ADD (a fifth of the cases within 10% below MIN_ADD, where a conversion of a
    /// sliver may run only because the pair is expected to follow, `BoxHookExtension.sol:312-315`), and the spot
    /// anywhere within ±110 ticks of the average: deepen keeps every rule of the watch; in particular a conversion that
    /// spent less than DEPTH_CONVERT_MIN_Q always paired in the same call (BC-137, the S5 review's rule).
    function testFuzz_AUDIT_U3_anyBudgetMixKeepsEveryRule(uint256 qGift, uint256 tSeed, int256 dSeed, uint256 frac)
        public
    {
        uint256 q = bound(qGift, 0, 12 ether);
        if (q != 0) _fundDepth(giver, q);
        uint256 minAdd = hook.minAdd();
        uint256 m = tSeed % 5;
        uint256 tWorth = m == 0 ? bound(tSeed, minAdd * 9 / 10, minAdd) : bound(tSeed, 0, 3 * minAdd);
        if (tWorth != 0) _giftT(tWorth);
        (, int24 avg,) = _avgNow();
        int24 d = int24(bound(dSeed, -110, 110));
        // Half of the near-MIN_ADD cases pushed 85-99 ticks down: the conversion's room to t_ref − 99 is then a sliver.
        if (m == 0 && dSeed % 2 == 0) d = int24(bound(dSeed, -99, -85));
        _land(uint160(bound(frac, _sqrtAt(avg + d), _sqrtAt(avg + d + 1) - 1)));
        AuditU3DeepenRec memory r = _watched();
        if (r.converted && r.qIn < BoxSpecV1.DEPTH_CONVERT_MIN_Q) {
            assertEq(r.kind, uint8(DepthKind.Pair), "a sliver conversion only with the pair after it");
        }
    }

    /// The sample lags: the executor samples at the average earlier in the block, then the spot is pushed 100+ ticks;
    /// deepen's poke cannot resample in the same second, so it skips `AverageNotCaughtUp`, no cooldown.
    function testProperty_AUDIT_U3_samplePokedBeforeThePushBlocksTheAdd() public {
        executor.poke();
        (, int24 avg, int24 sample) = _avgNow();
        _land(_sqrtAt(sample + 101));
        AuditU3DeepenRec memory r = _watched();
        assertEq(r.sample, sample, "the sample stayed");
        assertEq(r.skip, uint8(DeepenSkip.AverageNotCaughtUp));
        assertEq(r.last1, r.last0);
        avg;
    }

    // ============================================================================================================
    // P3.11: collect while deepen is blocked; at most four pokes

    /// With the pair in place and deepen blocked (cooldown; then deviation), collect() succeeds and pokes exactly the
    /// four positions that exist (ask, bid, sentinel, pair), each once, with a zero-liquidity modifyLiquidity, and
    /// nothing else (BC-122).
    function testProperty_AUDIT_U3_collectWhileDeepenBlockedPokesAtMostFour() public {
        _watched();
        _advance(300);
        _watched();
        assertGt(_pairL(), 0, "a pair exists");
        // Trade through every position (round trips), then collect inside the cooldown.
        _roundTrip(eoa[3], 0.4 ether);
        _roundTrip(eoa[3], 0.4 ether);
        _advance(5);
        AuditU3DeepenRec memory blocked = watch.deepenAs(keeper, keeper);
        assertEq(blocked.skip, uint8(DeepenSkip.Cooldown));
        (uint256 pokes, uint256 others) = _collectCountingPokes();
        assertEq(pokes, 4, "ask, bid, sentinel and pair");
        assertEq(others, 0, "no other liquidity change");
        // Deviation: push 150 ticks; deepen skips; collect still runs.
        _advance(300);
        (, int24 avg,) = _avgNow();
        _land(_sqrtAt(avg + 150));
        blocked = watch.deepenAs(keeper, keeper);
        assertEq(blocked.skip, uint8(DeepenSkip.Deviation));
        _roundTrip(eoa[4], 0.4 ether);
        _roundTrip(eoa[4], 0.4 ether);
        (pokes, others) = _collectCountingPokes();
        assertEq(pokes, 4);
        assertEq(others, 0);
    }

    // ============================================================================================================
    // P3.1 / BC-118: who funds the depth budget

    /// ERC-6909 claims of Q and T that a third party mints and transfers to the hook only enlarge the depth budget (by
    /// exactly the amounts), cannot be taken back by anyone (no entry point moves the hook's claims but deepen), and
    /// the hook still holds no ETH and no T (`BoxHook.sol:39-41`, `IBoxHook.sol:89-91`).
    function testProperty_AUDIT_U3_claimGiftsOnlyEnlargeTheBudget() public {
        (uint256 q0, uint256 t0) = _hookClaims();
        _fund(giver, 1 ether);
        vm.prank(giver);
        u3actor.mintClaims{value: 0.25 ether}(Currency.wrap(address(0)), 0.25 ether, giver, a.hook);
        _noteEthIn(EthIn.FundDepth, 0.25 ether);
        uint256 tGift = token.balanceOf(whale) / 10;
        vm.prank(whale);
        token.approve(address(u3actor), type(uint256).max);
        uint256 w0 = token.balanceOf(whale);
        u3actor.mintClaims(Currency.wrap(a.token), tGift, whale, a.hook);
        _noteTChange(w0, token.balanceOf(whale), TIn.Other, TOut.Other);
        (uint256 q1, uint256 t1) = _hookClaims();
        assertEq(q1 - q0, 0.25 ether, "the Q gift, exactly");
        assertEq(t1 - t0, tGift, "the T gift, exactly");
        (uint256 qb, uint256 tb) = hook.depthBudget();
        assertEq(qb, q1);
        assertEq(tb, t1);
        assertEq(a.hook.balance, 0);
        assertEq(token.balanceOf(a.hook), 0);
        // Nobody can move the hook's claims: no operator, no allowance.
        assertFalse(pm.isOperator(a.hook, giver));
        assertEq(pm.allowance(a.hook, giver, 0), 0);
        vm.prank(giver);
        vm.expectRevert();
        pm.transferFrom(a.hook, giver, 0, 1);
        _assertGhostLedger();
    }

    /// fundDepth() gifts after graduation, from a stranger and from the platform Safe: the hook's Q claims grow by
    /// exactly the gift at once, the receiver keeps none of it (BC-118: "fundDepth() adds anyone's Q to the budget, the
    /// Safe's too, with no way out").
    function testProperty_AUDIT_U3_fundDepthGiftsReachTheHookWhole() public {
        address[2] memory givers = [giver, safe];
        for (uint256 i; i < 2; ++i) {
            (uint256 q0,) = _hookClaims();
            uint256 r0 = pm.balanceOf(a.receiver, 0);
            _fundDepth(givers[i], 0.07 ether);
            (uint256 q1,) = _hookClaims();
            assertEq(q1 - q0, 0.07 ether, "the whole gift into the hook's claims");
            assertEq(pm.balanceOf(a.receiver, 0), r0, "none kept by the receiver");
        }
        _assertGhostLedger();
    }

    /// The conversion's fee note (REV-16, BC-133): the hook's own swap paid its LP fee to the box's positions; the
    /// next collect returns exactly the note (at most what the positions earned from it) to the hook's claims, before
    /// the split, and nothing of it is split.
    function testProperty_AUDIT_U3_conversionFeeNoteComesBackWhole() public {
        AuditU3DeepenRec memory r = _watched();
        uint256 note = r.note1 - r.note0;
        assertGt(note, 0);
        uint256 lpFee = r.qIn / 100;
        assertLe(note, lpFee, "never more than the conversion's LP fee");
        _buy(eoa[3], 0.6 ether);
        _advance(2);
        (uint256 q0,) = _hookClaims();
        vm.recordLogs();
        FeeBatch memory b = _collect(keeper, keeper);
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        uint256 hookBack;
        uint256 qDepth;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != a.receiver) continue;
            if (logs[i].topics[0] == IBoxReceiver.ModuleFeesReturned.selector) {
                (,, hookBack) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            } else if (logs[i].topics[0] == IBoxReceiver.DepthFunded.selector) {
                (uint256 dq,) = abi.decode(logs[i].data, (uint256, uint256));
                qDepth += dq;
            }
        }
        (uint256 q1,) = _hookClaims();
        assertEq(hookBack, note, "the whole note back");
        assertEq(receiver.hookFeesPending(), 0);
        assertEq(q1 - q0, hookBack + qDepth, "the hook gained the note and the batch's depth parts only");
        assertGt(b.q, hookBack);
        _assertGhostLedger();
    }

    /// An add into a pair that earned fees spends exactly the principal (BC-121): the pair's fees are poked and minted
    /// to the receiver in the same call, and the hook's claims fall by exactly qUsed + tip (Q) and rise by tOut −
    /// tUsed.
    function testProperty_AUDIT_U3_addIntoThePairSpendsOnlyPrincipal() public {
        _watched();
        _advance(300);
        _watched();
        assertGt(_pairL(), 0);
        // Fees for the pair: round trips through it (the pair is always in range; the price comes back).
        _roundTrip(eoa[3], 0.3 ether);
        _roundTrip(eoa[3], 0.3 ether);
        _advance(300);
        _giftT(hook.minAdd() * 2);
        (uint256 rq0, uint256 rt0) = (pm.balanceOf(a.receiver, 0), pm.balanceOf(a.receiver, uint256(uint160(a.token))));
        AuditU3DeepenRec memory r = _watched();
        assertEq(r.kind, uint8(DepthKind.Pair));
        (uint256 rq1, uint256 rt1) = (pm.balanceOf(a.receiver, 0), pm.balanceOf(a.receiver, uint256(uint160(a.token))));
        assertGt(rq1 + rt1, rq0 + rt0, "the pair's fees minted to the receiver before the add");
        emit log_named_uint("pair fees to the receiver, Q (wei)", rq1 - rq0);
        emit log_named_uint("pair fees to the receiver, T (raw)", rt1 - rt0);
    }

    /// BC-137 on box 0: FIT's executor and the hook's conversion in one block, either order, share one t_ref and never
    /// take the price past t_ref − 99 between them.
    function testProperty_AUDIT_U3_executorAndConversionShareOneBand() public {
        _fundBudget(giver, 5 ether);
        uint256 snap = vm.snapshotState();
        for (uint256 order; order < 2; ++order) {
            vm.revertToState(snap);
            (, int24 avg,) = _avgNow();
            int24 sampleNow = _sampleAfterPoke();
            int24 tRef = sampleNow > avg ? sampleNow : avg;
            uint160 band = _sqrtAt(tRef - 99);
            if (order == 0) executor.execute(1);
            AuditU3DeepenRec memory r = _watched();
            if (order == 1) executor.execute(1);
            emit log_named_uint(order == 0 ? "executor first: deepen kind" : "deepen first: deepen kind", r.kind);
            emit log_named_int("  ticks below t_ref at the end", int256(tRef) - int256(_tickNow()));
            assertGe(_sqrtP(), band, "never past t_ref - 99");
        }
    }

    // ============================================================================================================
    // P3.16 / BC-118: the residue of the depth rule, measured

    /// What one run of the BC-118 comparison leaves in the receiver's totals and the stream.
    struct Split118 {
        uint256 toFit;
        uint256 toPlatform;
        uint256 qToDepth;
        uint256 tToDepth;
        uint256 tBurned;
        uint256 tToStream;
        uint256 conversions;
        uint256 pairs;
    }

    /// BC-118's comparison on the factory's box 0: the same trade sequence (six batches 300 blocks apart, fixed buys
    /// and fixed T sells, the executor poked every block) with the depth rule (deepen before each batch: here 3
    /// conversions and 1 pair) and without it. Measured: the T side (13/15 to the stream or burned, the 2/15 depth
    /// part) equal to the raw unit; the Q side above the baseline by a few wei per conversion (FIT +22, platform +4,
    /// depth +4 in this run), split 11/2/2 like any fee. The source is the conversions' fee notes: feeNote keeps back 2
    /// raw units per possible swap step (BC-133) and floors, so the part of each conversion's LP fee above its note is
    /// split as an ordinary fee. Pinned per conversion (at most 2 × SLACK + 4 = 12 wei of Q each, never below the
    /// baseline: depth never takes from burns or rewards, F59); BC-118's open question ("to the wei" against "30 wei")
    /// gets this figure.
    function testProperty_AUDIT_U3_BC118ResidueMeasured() public {
        uint256 snap = vm.snapshotState();
        Split118 memory withRule = _run118(true);
        vm.revertToState(snap);
        Split118 memory baseline = _run118(false);
        emit log_named_uint("rule on: conversions", withRule.conversions);
        emit log_named_uint("rule on: pairs", withRule.pairs);
        _log118("FIT 11/15 (wei)", withRule.toFit, baseline.toFit);
        _log118("platform 2/15 (wei)", withRule.toPlatform, baseline.toPlatform);
        _log118("Q depth parts (wei)", withRule.qToDepth, baseline.qToDepth);
        _log118("T depth parts (raw)", withRule.tToDepth, baseline.tToDepth);
        _log118("T burned (raw)", withRule.tBurned, baseline.tBurned);
        _log118("T to the stream (raw)", withRule.tToStream, baseline.tToStream);
        assertGt(withRule.conversions, 1, "the rule converted more than once");
        assertGt(withRule.pairs, 0, "and paired");
        assertEq(withRule.tToStream, baseline.tToStream, "T to the stream: equal");
        assertEq(withRule.tBurned, baseline.tBurned, "T burned: equal");
        assertEq(withRule.tToDepth, baseline.tToDepth, "T depth parts: equal");
        assertGe(withRule.toFit, baseline.toFit, "FIT never below the baseline");
        assertGe(withRule.toPlatform, baseline.toPlatform);
        assertGe(withRule.qToDepth, baseline.qToDepth);
        uint256 qResidue = (withRule.toFit - baseline.toFit) + (withRule.toPlatform - baseline.toPlatform)
            + (withRule.qToDepth - baseline.qToDepth);
        emit log_named_uint("Q residue in total (wei)", qResidue);
        assertLe(qResidue, withRule.conversions * 12, "at most 12 wei of Q per conversion");
        // The residue pinned (BC-118's open question, measured on this scripted run): 3 conversions, 1 pair; FIT +22,
        // the platform +4, the Q depth parts +4 wei, the T side 0.
        assertEq(withRule.conversions, 3);
        assertEq(withRule.pairs, 1);
        assertEq(withRule.toFit - baseline.toFit, 22, "FIT: +22 wei");
        assertEq(withRule.toPlatform - baseline.toPlatform, 4, "platform: +4 wei");
        assertEq(withRule.qToDepth - baseline.qToDepth, 4, "Q depth parts: +4 wei");
    }

    function _run118(bool rule) internal returns (Split118 memory r) {
        uint256 s0 = token.balanceOf(a.itemStream);
        // One trader: a 0.6 ETH buy, then a sale of a fixed T amount (85% of what 0.6 ETH buys at P1), the same in both
        // runs; FIT's executor poked every block (a keeper's ring), so the 1-hour average follows the price and deepen
        // acts every 300 blocks in the rule's run.
        uint256 tSell = _qToT(0.6 ether, curve.sqrtPriceLowerX96) * 85 / 100;
        for (uint256 i; i < 6; ++i) {
            if (rule) {
                AuditU3DeepenRec memory d = _watched();
                if (d.converted) ++r.conversions;
                if (d.kind == uint8(DepthKind.Pair)) ++r.pairs;
            }
            _buy(eoa[3], 0.6 ether);
            _swap(eoa[3], SwapParams(false, -int256(tSell), TickMath.MAX_SQRT_PRICE - 1), 0);
            _advance(2);
            _collect(keeper, keeper);
            for (uint256 b; b < 300; ++b) {
                _advance(1);
                executor.poke();
            }
        }
        (r.toFit, r.toPlatform, r.qToDepth, r.tToDepth, r.tBurned,,) = receiver.totals();
        r.tToStream = token.balanceOf(a.itemStream) - s0;
    }

    function _log118(string memory what, uint256 on, uint256 off) internal {
        emit log_named_string("BC-118", what);
        emit log_named_uint("  with the depth rule", on);
        emit log_named_uint("  baseline", off);
        emit log_named_int("  difference", int256(on) - int256(off));
    }

    // ------------------------------------------------------------------------------------------------ helpers

    /// @dev T claims worth `qWorth` at spot, gifted to the hook by the whale (a third party's claim transfer).
    function _giftT(uint256 qWorth) internal {
        uint256 t = _qToT(qWorth, _sqrtP());
        vm.prank(whale);
        token.approve(address(u3actor), type(uint256).max);
        uint256 w0 = token.balanceOf(whale);
        u3actor.mintClaims(Currency.wrap(a.token), t, whale, a.hook);
        _noteTChange(w0, token.balanceOf(whale), TIn.Other, TOut.Other);
    }

    /// @dev A buy of `eth` and the sale of all the T it bought: fees for the positions, the price back near where it
    /// was (so the 1-hour average stays caught up).
    function _roundTrip(address who, uint256 eth) internal {
        uint256 t = _buy(who, eth);
        _sell(who, t);
    }

    /// @dev Q worth `q` in T at √price `s` (T per Q = (s / 2^96)^2), rounded up.
    function _qToT(uint256 q, uint160 s) internal pure returns (uint256) {
        uint256 x = (q * uint256(s)) >> 96;
        return ((x * uint256(s)) >> 96) + 1;
    }

    /// @dev collect() by the keeper, counting the hook's zero-liquidity pokes and any other liquidity change.
    function _collectCountingPokes() internal returns (uint256 pokes, uint256 others) {
        vm.recordLogs();
        _collect(keeper, keeper);
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(pm) || logs[i].topics[0] != sig) continue;
            (,, int256 delta,) = abi.decode(logs[i].data, (int24, int24, int256, bytes32));
            if (delta == 0 && logs[i].topics[2] == bytes32(uint256(uint160(a.hook)))) ++pokes;
            else ++others;
        }
    }
}
