// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {ProtocolFeeLibrary} from "v4-core/src/libraries/ProtocolFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {Slot0} from "v4-core/src/types/Slot0.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {DeepenSkip, DepthKind} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {BoxSwapBounds} from "../../../../src/box/libraries/BoxSwapBounds.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU3FableBase, AuditU3FableTipProbe} from "./AuditU3FableBase.sol";

/// @notice SH-AUDIT-B0 U3 (Fable): the depth budget and `deepen()` on the factory's box 0 with FIT's real executor
/// as the price average (L1: P3.1, P3.4; L3: P3.8; L4: P3.10; L5: BC-122; L6: a protocol fee; L7: P3.16, the BC-118
/// residue). Sources: `BoxHookExtension.sol:95-126` (deepen), `:249-319` (the guards and the conversion plan),
/// `:325-350` (the price guards), `:356-376` (the step), `:386-408` (the conversion), `:445-492` (the pair add, the
/// tip), `BoxHookBase.sol:190-215`; BC-119 to BC-122, BC-133, BC-137, BC-142; F59, F72 (B), F77;
/// `docs/design/dynamic-pool-share.md:108-114`.
/// forge-config: default.evm_version = "osaka"
contract AuditU3FableDepthTest is AuditU3FableBase {
    using StateLibrary for IPoolManager;

    uint256 internal constant WARM_BLOCKS = 320;

    struct Act {
        uint256 q0;
        uint256 t0;
        uint256 cap;
        uint256 last0;
        uint128 pair0;
        DepthKind kind;
        DeepenSkip skip;
        uint256 qUsed;
        uint256 tUsed;
        uint256 tip;
        bool conv;
        uint256 qIn;
        uint256 tOut;
    }


    function setUp() public override {
        super.setUp();
        _toGraduated();
        _warmRing(WARM_BLOCKS);
        (bool ready, int24 avg,) = executor.twap();
        require(ready, "u3: the executor ring is ready after an hour of pokes");
        require(avg == executor.latestSampleTick(), "u3: the ring sits at one tick");
    }

    // ================================================================================================ P3.1

    /// P3.1 (`BoxHook.sol:39-41`, `IBoxHook.sol:89-91`): between calls the hook holds no ETH and no T, its claims are
    /// the depth budget, and claims that reach it by any outside path (the receiver's `fundDepth` gift, a stranger's
    /// ERC-6909 mint, a stranger's T claims) only enlarge the budget. ETH cannot be sent to it (no `receive`); a plain
    /// T transfer lands and stays (the accepted M01/M25 class), outside its claims.
    function testProperty_AUDIT_U3_hookHoldsOnlyClaimsAndGiftsOnlyEnlargeTheBudget() public {
        _assertHookHoldsOnlyClaims();
        (uint256 q0, uint256 t0) = _hookClaims();
        _fundDepth(eoa[5], 0.3 ether);
        _giftQ(eoa[4], 0.2 ether);
        uint256 tGift = token.balanceOf(eoa[2]) / 10;
        _giftT(eoa[2], tGift);
        (uint256 q1, uint256 t1) = _hookClaims();
        assertEq(q1, q0 + 0.5 ether, "Q gifts enlarge the Q budget exactly");
        assertEq(t1, t0 + tGift, "a T claims gift enlarges the T budget exactly");
        _assertHookHoldsOnlyClaims();
        (bool ok,) = a.hook.call{value: 1}("");
        assertFalse(ok, "the hook refuses ETH (no receive, no fallback)");
        (ok,) = a.hook.call{value: 0}(hex"deadbeef");
        assertFalse(ok, "no fallback");
        _assertGhostLedger();
        // A plain T transfer cannot be refused by an ERC-20 holder: it stays, outside the budget (M25, accepted).
        _transferT(eoa[2], a.hook, 1);
        assertEq(token.balanceOf(a.hook), 1, "a plain T transfer to the hook has no exit (accepted M01/M25)");
        (uint256 qb, uint256 tb) = hook.depthBudget();
        assertEq(qb, q1);
        assertEq(tb, t1, "the stray T is not in the budget");
        _assertGhostLedger();
    }

    // ================================================================================================ P3.4 / BC-120

    /// BC-120, BC-121 (F72 (B)): a pair add spends exactly the principal on both sides and the tip, into the one
    /// full-range position at salt 3; the Q side is within the 10% cap of the core's Q near t_ref; the tip is 5%
    /// capped; the cooldown is 300 blocks from the add; a later add only grows the position.
    function testProperty_AUDIT_U3_pairAddSpendsThePrincipalAndTheTipExactly() public {
        _fundDepth(eoa[5], 0.5 ether);
        _giftT(eoa[2], _tForQ(0.5 ether, _sqrtP()));
        Act memory x;
        (x.q0, x.t0) = _hookClaims();
        x.cap = _coreQNear(_tRef()) * 10 / 100;
        emit log_named_decimal_uint("U3F|add cap at 1x (ETH)", x.cap, 18);
        assertGt(x.cap, 0);
        uint256 kb = keeper.balance;
        (x.kind, x.skip, x.qUsed, x.tUsed, x.tip) = _deepen(keeper, keeper);
        assertEq(uint8(x.skip), uint8(DeepenSkip.None));
        assertEq(uint8(x.kind), uint8(DepthKind.Pair));
        assertEq(keeper.balance - kb, x.tip, "the tip reached its recipient");
        _checkPairAdd(x);
        uint128 pairL = hook.pairedLiquidity();
        assertEq(hook.lastDeepenBlock(), vm.getBlockNumber());
        assertEq(_posL(MIN_T, MAX_T, SALT_RUNGS_NEVER_USED), 0, "no salt-2 position");
        (, x.skip,,,) = _deepen(keeper, keeper);
        assertEq(uint8(x.skip), uint8(DeepenSkip.Cooldown), "same block");
        _advance(299);
        (, x.skip,,,) = _deepen(keeper, keeper);
        assertEq(uint8(x.skip), uint8(DeepenSkip.Cooldown), "299 blocks");
        _advance(1);
        (x.kind, x.skip,,,) = _deepen(keeper, keeper);
        assertEq(uint8(x.skip), uint8(DeepenSkip.None), "300 blocks");
        assertEq(uint8(x.kind), uint8(DepthKind.Pair));
        assertGt(hook.pairedLiquidity(), pairL, "the pair only grows");
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
    }

    function _checkPairAdd(Act memory x) internal view {
        (uint256 q1, uint256 t1) = _hookClaims();
        assertEq(x.q0 - q1, x.qUsed + x.tip, "the Q budget falls by exactly the principal and the tip");
        assertEq(x.t0 - t1, x.tUsed, "the T budget falls by exactly the T paired");
        assertEq(x.tip, _tipOf(x.qUsed), "tip: 5% of the Q spent, capped");
        assertLe(x.tip, hook.deepenTipCap());
        assertLe(x.qUsed, x.cap, "at most 10% of the core's Q within 953 ticks of t_ref");
        uint256 smaller = _min(x.q0 - _tipOf(x.q0), _tInQ(x.t0, _sqrtP()));
        assertGe(x.qUsed + 2, _min(x.cap, smaller), "sized by the smaller side, else the cap");
        uint128 pairL = hook.pairedLiquidity();
        assertGt(pairL, 0);
        (uint256 pq, uint256 pt) = _principal(MIN_T, MAX_T, pairL);
        assertApproxEqAbs(pq, x.qUsed, 1, "the pair's Q principal is what the add took");
        assertApproxEqAbs(pt, x.tUsed, 1, "the pair's T principal is what the add took");
    }

    /// BC-121: an add into a pair that has accrued fees first pokes it and mints its fees to the receiver as ordinary
    /// fees, then spends exactly the principal; the budget falls by exactly that and the tip.
    function testProperty_AUDIT_U3_addIntoThePairWithFeesSpendsOnlyPrincipal() public {
        _firstPair();
        _buy(eoa[3], 0.3 ether);
        _sell(eoa[3], token.balanceOf(eoa[3]) / 2);
        // The trades moved the price by more than one sample's 100 ticks: the ring needs an hour to catch up and
        // the average to follow (a single poke would leave `AverageNotCaughtUp`, 320 blocks `Deviation`: the window
        // reaches back up to 4,115 s); at least 300 blocks also pass the cooldown.
        _catchUp(300);
        (uint256 feeQ, uint256 feeT) = _uncollected(MIN_T, MAX_T, SALT_PAIR);
        assertGt(feeQ, 0, "fixture: the pair earned Q fees");
        uint256 recvQ0 = pm.balanceOf(a.receiver, 0);
        uint256 recvT0 = pm.balanceOf(a.receiver, uint256(uint160(a.token)));
        (uint256 q0, uint256 t0) = _hookClaims();
        uint128 l0 = hook.pairedLiquidity();
        (uint256 pq0, uint256 pt0) = _principal(MIN_T, MAX_T, l0);
        (DepthKind kind, DeepenSkip skip, uint256 qUsed, uint256 tUsed, uint256 tip) = _deepen(keeper, keeper);
        assertEq(uint8(skip), uint8(DeepenSkip.None));
        assertEq(uint8(kind), uint8(DepthKind.Pair));
        assertEq(pm.balanceOf(a.receiver, 0) - recvQ0, feeQ, "the pair's Q fees went to the receiver");
        assertEq(pm.balanceOf(a.receiver, uint256(uint160(a.token))) - recvT0, feeT, "and its T fees");
        (uint256 q1, uint256 t1) = _hookClaims();
        assertEq(q0 - q1, qUsed + tip, "principal and tip only");
        assertEq(t0 - t1, tUsed);
        (uint256 pq1, uint256 pt1) = _principal(MIN_T, MAX_T, hook.pairedLiquidity());
        assertApproxEqAbs(pq1 - pq0, qUsed, 2, "the position grew by the principal (Q)");
        assertApproxEqAbs(pt1 - pt0, tUsed, 2, "the position grew by the principal (T)");
        (uint256 leftQ, uint256 leftT) = _uncollected(MIN_T, MAX_T, SALT_PAIR);
        assertEq(leftQ | leftT, 0, "no pair fee left behind by the add");
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
    }

    /// P3.4 (F59, BC-118, BC-133): what reaches the depth budget from a fee batch after graduation is exactly the
    /// receiver's depth parts (`DepthFunded`) plus the hook's own conversion fee returned (`ModuleFeesReturned`);
    /// nothing else of the batch (FIT's 11/15, the platform's 2/15, the burned/streamed T) enters it.
    function testProperty_AUDIT_U3_onlyDepthPartsAndFeeReturnsEnterTheBudget() public {
        _buy(eoa[3], 0.6 ether);
        _sell(eoa[3], token.balanceOf(eoa[3]) / 2);
        _buy(eoa[4], 0.4 ether);
        (uint256 q0, uint256 t0) = _hookClaims();
        vm.recordLogs();
        _collect(keeper, keeper);
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        (uint256 dq, uint256 dt) = _depthFunded(logs);
        uint256 back = _hookBack(logs);
        (uint256 q1, uint256 t1) = _hookClaims();
        assertGt(dq, 0, "fixture: the batch had a Q depth part");
        assertEq(q1 - q0, dq + back, "Q budget grew by the depth part and the fee return only");
        assertEq(t1 - t0, dt, "T budget grew by the T depth part only");
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
    }

    // ================================================================================================ P3.16 / BC-137

    /// BC-137, BC-142, BC-133 (S5.M5): with Q only, `deepen()` converts one capped step: at most half the unpaired
    /// Q, at most the budget less the tip, never below its limit (the nearer of 49 ticks and t_ref − 99), at least the
    /// minimum output, at least DEPTH_CONVERT_MIN_Q spent; the T bought stays as the hook's claims; the Q spent and
    /// the tip leave the budget; its LP fee is noted to the receiver and comes back whole with the next batch; the
    /// cooldown starts.
    struct Conv {
        uint256 q0;
        uint256 t0;
        uint160 s0;
        uint256 tValue;
        int24 tickBefore;
        uint256 pending0;
        uint256 qUsed;
        uint256 tUsed;
        uint256 tip;
        uint256 qIn;
        uint256 tOut;
        int24 tRef;
        uint160 before;
        uint160 after_;
        uint160 limit;
    }

    function testProperty_AUDIT_U3_conversionStaysWithinItsBoundsAndItsFeeReturns() public {
        _fundDepth(eoa[5], 0.5 ether);
        Conv memory c;
        (c.q0, c.t0) = _hookClaims();
        c.s0 = _sqrtP();
        c.tValue = _tInQ(c.t0, c.s0);
        assertLt(c.tValue, hook.minAdd(), "fixture: the T side is below MIN_ADD");
        assertGe(c.q0, hook.minAdd());
        c.tickBefore = _tick();
        c.pending0 = receiver.hookFeesPending();
        vm.recordLogs();
        DepthKind kind;
        DeepenSkip skip;
        (kind, skip, c.qUsed, c.tUsed, c.tip) = _deepen(keeper, keeper);
        assertEq(uint8(skip), uint8(DeepenSkip.None));
        assertEq(uint8(kind), uint8(DepthKind.Convert), "a conversion alone: the T side stays below MIN_ADD");
        bool found;
        (found, c.qIn, c.tOut, c.tRef, c.before, c.after_, c.limit) = _lastConverted(vm.getRecordedLogs());
        assertTrue(found);
        _checkConversionBounds(c);
        _checkConversionAccounting(c);
        // BC-133: the note comes back whole with the next batch, never split.
        uint256 note = bounds.feeNote(c.qIn, 10_000);
        _buy(eoa[3], 0.5 ether);
        _sell(eoa[3], token.balanceOf(eoa[3]) / 3);
        (uint256 q2,) = _hookClaims();
        vm.recordLogs();
        _collect(keeper, keeper);
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        (uint256 dq,) = _depthFunded(logs);
        uint256 back = _hookBack(logs);
        assertEq(back, note + c.pending0, "the whole note returned");
        assertEq(receiver.hookFeesPending(), 0);
        (uint256 q3,) = _hookClaims();
        assertEq(q3 - q2, dq + back, "the budget grew by the return and the batch's depth part");
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
    }

    function _checkConversionBounds(Conv memory c) internal view {
        assertEq(c.tUsed, 0);
        assertEq(c.qIn, c.qUsed, "qUsed is the conversion's input");
        assertEq(c.before, c.s0);
        assertEq(c.tRef, _tRef(), "t_ref: the higher of the average and the sample");
        assertLe(c.qIn, (c.q0 - c.tValue) * BoxSpecV1.DEPTH_CONVERT_SHARE_BPS / 10_000, "at most half the unpaired Q");
        assertLe(c.qIn, c.q0 - _tipOf(c.q0), "at most the budget less the tip");
        assertGe(c.qIn + 16, BoxSpecV1.DEPTH_CONVERT_MIN_Q, "a conversion alone spends at least DEPTH_CONVERT_MIN_Q");
        assertEq(c.limit, bounds.stepLimit(true, c.s0, c.tRef), "the limit is BoxSwapBounds'");
        assertGe(c.after_, c.limit, "never beyond the limit");
        assertGe(
            c.limit, uint160(FullMath.mulDivRoundingUp(c.s0, BoxSwapBounds.SQRT_IMPACT_DOWN_X96, Q96)), "<= 49 ticks"
        );
        assertGe(c.limit, TickMath.getSqrtPriceAtTick(c.tRef - 99), ">= t_ref - 99");
        assertGe(_tick(), c.tickBefore - 49, "the tick moved at most 49");
        assertGe(c.tOut, bounds.minOut(true, c.qIn, c.limit, 10_000), "at least the minimum output");
    }

    function _checkConversionAccounting(Conv memory c) internal view {
        (uint256 q1, uint256 t1) = _hookClaims();
        assertEq(t1, c.t0 + c.tOut, "the T bought is the hook's claims");
        assertEq(c.q0 - q1, c.qIn + c.tip, "the Q spent and the tip left the budget");
        assertEq(c.tip, _tipOf(c.qIn), "one tip on the conversion's input");
        uint256 note = bounds.feeNote(c.qIn, 10_000);
        assertEq(receiver.hookFeesPending() - c.pending0, note, "REV-16: the LP fee less 2 units a possible step, noted");
        assertEq(hook.lastDeepenBlock(), vm.getBlockNumber(), "a conversion starts the cooldown");
    }

    /// BC-118 / BC-133 residue (the case says "to the wei", the check "within 30 wei"): what one conversion's LP fee
    /// nominally is (1% of its input), what the hook's positions actually earned from it (v4 floors fee growth per
    /// position), and what the hook noted (the nominal less 2 raw units a possible step). Pins the measured residues.
    function testProperty_AUDIT_U3_conversionFeeResidueMeasured() public {
        _fundDepth(eoa[5], 0.5 ether);
        (uint256 owedBefore,) = _allUncollected();
        vm.recordLogs();
        _deepen(keeper, keeper);
        (bool found, uint256 qIn,,,,,) = _lastConverted(vm.getRecordedLogs());
        assertTrue(found);
        (uint256 owedAfter,) = _allUncollected();
        uint256 earned = owedAfter - owedBefore;
        uint256 nominal = qIn * 10_000 / 1_000_000;
        uint256 noted = receiver.hookFeesPending();
        emit log_named_uint("U3F|conversion input (wei)", qIn);
        emit log_named_uint("U3F|nominal 1% LP fee (wei)", nominal);
        emit log_named_uint("U3F|earned by the positions (wei)", earned);
        emit log_named_uint("U3F|noted to the receiver (wei)", noted);
        emit log_named_uint("U3F|residue nominal - earned (wei)", nominal - earned);
        emit log_named_uint("U3F|residue earned - noted (wei)", earned - noted);
        assertLe(earned, nominal, "the positions never earn more than the nominal fee");
        assertLe(noted, earned, "the note never exceeds what the positions earned (BC-133)");
        assertLe(nominal - earned, 30, "the residue is within the check's 30 wei");
        assertEq(noted, nominal - 8, "the note is the nominal less 2 x SLACK (4)");
        _assertGhostLedger();
    }

    /// The add cap's base follows the price (dynamic-pool-share § 1.3 "~ 0.021 ETH at 1x, 0.21 ETH at 100x"): after
    /// a 100x rally the ask's Q near t_ref is about ten times larger, and `deepen()` adds up to the larger cap.
    function testProperty_AUDIT_U3_addCapGrowsTenfoldAtAHundredX() public {
        uint256 cap1x = _coreQNear(_tRef()) * 10 / 100;
        int24 target = _tick() - 46_052; // 1.0001^46052 ≈ 100
        _pushDownTo(eoa[5], target);
        _warmRing(WARM_BLOCKS + 480);
        (bool ready, int24 avg,) = executor.twap();
        assertTrue(ready);
        assertLe(_absDiff(avg, _tick()), 99, "the ring caught up and the hour average is at the new price");
        uint256 cap100x = _coreQNear(_tRef()) * 10 / 100;
        emit log_named_decimal_uint("U3F|add cap at 1x (ETH)", cap1x, 18);
        emit log_named_decimal_uint("U3F|add cap at 100x (ETH)", cap100x, 18);
        assertGt(cap100x, cap1x * 9, "about ten times the cap at 1x");
        assertLt(cap100x, cap1x * 11);
        _fundDepth(eoa[5], 3 ether);
        _giftT(eoa[5], _tForQ(3 ether, _sqrtP()));
        (DepthKind kind, DeepenSkip skip, uint256 qUsed,,) = _deepen(keeper, keeper);
        assertEq(uint8(skip), uint8(DeepenSkip.None));
        assertEq(uint8(kind), uint8(DepthKind.Pair));
        assertLe(qUsed, cap100x);
        assertGt(qUsed, cap1x * 5, "the add used the larger cap");
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
    }

    // ================================================================================================ P3.10 / L4

    /// P3.10 (BC-119; S5 review #2 across the boundary) with FIT's real executor ring: a same-block push of 98, 99,
    /// 100 or 101 ticks either way right before `deepen()` either makes it skip without starting the cooldown (100
    /// and 101: `Deviation`) or act within the bounds (98 and 99: a pair at the pushed price within the cap); with Q
    /// only, a 99-tick push down leaves no room (`ConvertBelowMin`, no cooldown) and a 99-tick push up converts
    /// within 49 ticks. Never a cooldown with nothing added.
    function testProperty_AUDIT_U3_pushesAtTheDeviationBoundaryNeverStartAnEmptyCooldown() public {
        int24 fair = executor.latestSampleTick();
        assertEq(fair, _tick(), "fixture: the ring sits at spot");
        uint256 base = vm.snapshotState();
        int24[4] memory ks = [int24(98), 99, 100, 101];
        for (uint256 i; i < 4; ++i) {
            for (uint256 dir; dir < 2; ++dir) {
                vm.revertToState(base);
                _pushCase(fair, ks[i], dir == 0);
            }
        }
        // Q only: at 99 ticks down the band leaves no room (a skip, no cooldown); at 99 up it converts within bounds.
        vm.revertToState(base);
        _fundDepth(eoa[5], 0.5 ether);
        _advance(1);
        _pushDownTo(eoa[4], fair - 99);
        uint256 lastBefore = hook.lastDeepenBlock();
        (, DeepenSkip sk,,,) = _deepen(keeper, keeper);
        assertEq(uint8(sk), uint8(DeepenSkip.ConvertBelowMin), "no room before the band: a skip");
        assertEq(hook.lastDeepenBlock(), lastBefore, "no cooldown");
        vm.revertToState(base);
        _fundDepth(eoa[5], 0.5 ether);
        _advance(1);
        _pushUpTo(eoa[2], fair + 99);
        _convertCaseAt(fair + 99);
        _assertHookHoldsOnlyClaims();
    }

    function _pushCase(int24 fair, int24 k, bool down) internal {
        _fundDepth(eoa[5], 0.5 ether);
        _giftT(eoa[2], _tForQ(0.5 ether, _sqrtP()));
        _advance(1);
        if (down) _pushDownTo(eoa[4], fair - k);
        else _pushUpTo(eoa[2], fair + k);
        assertEq(_absDiff(_tick(), fair), k, "fixture: pushed exactly k ticks");
        Act memory x;
        x.last0 = hook.lastDeepenBlock();
        (x.q0, x.t0) = _hookClaims();
        x.cap = _coreQNear(down ? fair : fair + k) * 10 / 100;
        (x.kind, x.skip, x.qUsed, x.tUsed, x.tip) = _deepen(keeper, keeper);
        if (k >= 100) {
            assertEq(uint8(x.skip), uint8(DeepenSkip.Deviation), "100 or 101 ticks: a skip");
            assertEq(hook.lastDeepenBlock(), x.last0, "no cooldown started");
            assertEq(x.qUsed | x.tUsed | x.tip, 0);
        } else {
            assertEq(uint8(x.skip), uint8(DeepenSkip.None), "98 or 99 ticks: the guards pass");
            assertEq(uint8(x.kind), uint8(DepthKind.Pair));
            assertEq(hook.lastDeepenBlock(), vm.getBlockNumber());
            assertLe(x.qUsed, x.cap, "within the cap at t_ref");
            assertGe(x.qUsed + 2, _min(x.cap, hook.minAdd() - _tipOf(x.q0)), "never a cooldown for less than the rule's add");
            (uint256 q1, uint256 t1) = _hookClaims();
            assertEq(x.q0 - q1, x.qUsed + x.tip);
            assertEq(x.t0 - t1, x.tUsed);
        }
        _assertHookHoldsOnlyClaims();
    }

    function _convertCaseAt(int24 pushedTick) internal {
        int24 t0 = _tick();
        vm.recordLogs();
        (DepthKind kd, DeepenSkip sk2, uint256 qIn,,) = _deepen(keeper, keeper);
        assertEq(uint8(sk2), uint8(DeepenSkip.None));
        assertEq(uint8(kd), uint8(DepthKind.Convert));
        assertGe(qIn + 16, BoxSpecV1.DEPTH_CONVERT_MIN_Q);
        assertGe(_tick(), t0 - 49, "the conversion moved at most 49 ticks");
        (bool found,,, int24 tRef,,, uint160 limit) = _lastConverted(vm.getRecordedLogs());
        assertTrue(found);
        assertEq(tRef, pushedTick, "t_ref is the pushed sample (the higher tick)");
        assertEq(limit, bounds.stepLimit(true, TickMath.getSqrtPriceAtTick(pushedTick), pushedTick));
    }

    /// BC-122: `collect()` works while `deepen()` is blocked (cooldown, a 100-tick push) and pokes at most four
    /// positions in one batch, the pair's fees included.
    function testProperty_AUDIT_U3_collectWorksWhileDeepenIsBlockedAndPokesAtMostFour() public {
        _firstPair();
        // Enough fees for a batch (the receiver's minimum is 0.005 ETH of Q): a round trip of 0.8 ETH pays 1%.
        _buy(eoa[3], 0.8 ether);
        _sell(eoa[3], token.balanceOf(eoa[3]) / 2);
        _catchUp(300);
        // The push is measured from the hour average (what the Deviation guard compares; `_catchUp` leaves it within
        // one tick of spot): 100 ticks below it. deepen's own poke moves the sample to within a tick of spot (caught
        // up); the average stays where it was.
        (, int24 avg,) = executor.twap();
        _advance(1);
        _pushDownTo(eoa[4], avg - 100);
        assertEq(_absDiff(_tick(), avg), 100, "fixture: 100 ticks from the hour average");
        (, DeepenSkip skip,,,) = _deepen(keeper, keeper);
        assertEq(uint8(skip), uint8(DeepenSkip.Deviation), "deepen is blocked by the 100-tick push");
        (uint256 pairQ,) = _uncollected(MIN_T, MAX_T, SALT_PAIR);
        assertGt(pairQ, 0, "fixture: the pair earned from the trades");
        vm.recordLogs();
        _collect(keeper, keeper);
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        uint256 pokes = _countTopic(logs, address(pm), keccak256("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)"));
        assertLe(pokes, 4, "at most four positions poked");
        assertEq(pokes, 4, "all four exist here: ask, bid, sentinel, pair");
        (uint256 leftQ, uint256 leftT) = _allUncollected();
        assertEq(leftQ | leftT, 0, "the batch took every position's fees");
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
    }

    // ================================================================================================ P3.8 / L3

    /// P3.8, L3: a tip recipient whose code runs inside `deepen()`'s own unlock (the tip is paid last) cannot re-enter
    /// `deepen` or `collect` (`ForeignUnlock`), and whatever it does with the unlocked PoolManager (a swap of its own,
    /// which v4 permits inside any unlock, settled by itself) changes nothing of the add already made: the budget
    /// fell by exactly the principal and the tip, the event's figures are the call's. Hostile recipients (all gas
    /// burned, ETH refused, the receiver, the hook itself) revert the whole call and leave the budget untouched.
    function testProperty_AUDIT_U3_tipRecipientInsideTheUnlockChangesNothing() public {
        AuditU3FableTipProbe probe = new AuditU3FableTipProbe(pm, IBoxHook(a.hook), IBoxReceiver(a.receiver), poolKey);
        vm.deal(address(probe), 1 ether);
        _ghostAddOutside(address(probe));
        _fundDepth(eoa[5], 0.5 ether);
        _giftT(eoa[2], _tForQ(0.5 ether, _sqrtP()));
        Act memory x;
        (x.q0, x.t0) = _hookClaims();
        probe.arm(true);
        uint256 pb0 = address(probe).balance;
        uint256 pt0 = token.balanceOf(address(probe));
        vm.recordLogs();
        vm.prank(keeper);
        (x.kind, x.skip, x.qUsed, x.tUsed, x.tip) = hook.deepen(address(probe));
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        assertEq(uint8(x.skip), uint8(DeepenSkip.None));
        assertEq(uint8(x.kind), uint8(DepthKind.Pair));
        assertEq(probe.tipsReceived(), x.tip);
        assertEq(probe.deepenSel(), IBoxHook.ForeignUnlock.selector, "a re-entrant deepen is refused");
        assertEq(probe.collectSel(), IBoxHook.ForeignUnlock.selector, "a re-entrant collect is refused");
        assertTrue(probe.innerSwapOk(), "observation: a swap of its own inside the hook's unlock is allowed by v4");
        _noteEthOut(EthOut.Tip, x.tip);
        _noteEthIn(EthIn.SwapIn, probe.innerSwapIn());
        _noteTOut(TOut.Buy, token.balanceOf(address(probe)) - pt0);
        assertEq(address(probe).balance, pb0 + x.tip - probe.innerSwapIn());
        _checkProbeOutcome(x, logs);
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
        _hostileRecipients();
        _assertGhostLedger();
    }

    function _checkProbeOutcome(Act memory x, VmSafe.Log[] memory logs) internal view {
        (uint256 q1, uint256 t1) = _hookClaims();
        assertEq(x.q0 - q1, x.qUsed + x.tip, "the budget fell by the principal and the tip only");
        assertEq(x.t0 - t1, x.tUsed);
        (uint128 evL, uint256 evQ, uint256 evT, uint256 evTip) = _deepened(logs);
        assertEq(evQ, x.qUsed);
        assertEq(evT, x.tUsed);
        assertEq(evTip, x.tip);
        assertEq(hook.pairedLiquidity(), evL, "the position is exactly the add's");
    }

    /// Hostile recipients: the whole call reverts, nothing moves; an honest keeper then adds.
    function _hostileRecipients() internal {
        _advance(300);
        _warmRing(1);
        (uint256 q0, uint256 t0) = _hookClaims();
        uint256 last = hook.lastDeepenBlock();
        address[4] memory hostile = [address(gasBurner), address(ethRefuser), a.receiver, a.hook];
        for (uint256 i; i < 4; ++i) {
            vm.prank(keeper);
            vm.expectRevert();
            hook.deepen(hostile[i]);
            (uint256 qx, uint256 tx) = _hookClaims();
            assertEq(qx, q0, "budget untouched by a reverted call");
            assertEq(tx, t0);
            assertEq(hook.lastDeepenBlock(), last, "no cooldown from a reverted call");
        }
        (, DeepenSkip skip,,,) = _deepen(keeper, keeper);
        assertEq(uint8(skip), uint8(DeepenSkip.None));
    }

    // ================================================================================================ L6

    /// L6 (Uniswap v4's protocol fee): with a protocol fee set on the pool by v4's controller, every bound and
    /// identity holds with the fees `BoxSwapBounds.fees` derives (the conversion's minimum output on the total swap
    /// fee, its note on the LPs' part), harvest mints exactly what the positions got, and the protocol's cut leaves
    /// through v4's own accounting, never through the hook.
    function testProperty_AUDIT_U3_protocolFeeChangesNoBoundOrIdentity() public {
        _setProtocolFee();
        (uint24 swapFee, uint24 lpShare) = bounds.fees(_slot0(), true);
        assertEq(swapFee, ProtocolFeeLibrary.calculateSwapFee(1_000, 10_000));
        assertEq(lpShare, swapFee - 1_000);
        _fundDepth(eoa[5], 0.5 ether);
        Act memory x;
        (x.q0, x.t0) = _hookClaims();
        vm.recordLogs();
        (x.kind, x.skip, x.qUsed, x.tUsed, x.tip) = _deepen(keeper, keeper);
        assertEq(uint8(x.skip), uint8(DeepenSkip.None));
        assertEq(uint8(x.kind), uint8(DepthKind.Convert));
        _checkProtocolFeeConversion(x, swapFee, lpShare);
        assertGt(pm.protocolFeesAccrued(Currency.wrap(address(0))), 0, "the protocol's cut is v4's, outside the hook");
        // Harvest: exactly what the positions were owed.
        _buy(eoa[3], 0.3 ether);
        _sell(eoa[3], token.balanceOf(eoa[3]) / 2);
        (uint256 owedQ, uint256 owedT) = _allUncollected();
        vm.prank(a.receiver);
        (uint256 fq, uint256 ft,) = hook.harvest();
        assertEq(fq, owedQ);
        assertEq(ft, owedT);
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
    }

    function _setProtocolFee() internal {
        address owner = makeAddr("core.pmOwner");
        address ctl = makeAddr("u3.protocolFeeController");
        vm.prank(owner);
        pm.setProtocolFeeController(ctl);
        uint24 fee = (uint24(1_000) << 12) | 1_000;
        vm.prank(ctl);
        pm.setProtocolFee(poolKey, fee);
    }

    function _checkProtocolFeeConversion(Act memory x, uint24 swapFee, uint24 lpShare) internal view {
        (bool found, uint256 qIn, uint256 tOut,,, uint160 after_, uint160 limit) = _lastConverted(vm.getRecordedLogs());
        assertTrue(found);
        assertEq(qIn, x.qUsed);
        assertGe(after_, limit);
        assertGe(tOut, bounds.minOut(true, qIn, limit, swapFee), "the minimum output on the total swap fee");
        assertEq(receiver.hookFeesPending(), bounds.feeNote(qIn, lpShare), "the note on the LPs' part only");
        (uint256 q1, uint256 t1) = _hookClaims();
        assertEq(x.q0 - q1, qIn + x.tip);
        assertEq(t1 - x.t0, tOut);
    }

    // ================================================================================================ fuzz

    /// BC-119 ("a skipped add returns a reason and keeps the budget") and BC-137 under any budget and price: for any
    /// Q and T gifts and any price move of up to 1,500 ticks either way (the ring then caught up and the hour
    /// average at the new price), `deepen()` never reverts; a skip changes nothing; a conversion alone spends at least
    /// DEPTH_CONVERT_MIN_Q (no sliver with a cooldown); a pair spends at least min(MIN_ADD − tip, the cap) and at
    /// most the cap; the budget falls by exactly the Q spent plus the tip and the T paired, less the T bought.
    function testFuzz_AUDIT_U3_deepenNeverRevertsAndSpendsWithinItsRules(uint256 qGift, uint256 tGift, int24 push)
        public
    {
        qGift = bound(qGift, 0, 30 ether);
        tGift = bound(tGift, 0, token.balanceOf(eoa[2]) / 2);
        push = int24(bound(push, -1_500, 1_500));
        if (qGift != 0) _giftQ(eoa[4], qGift);
        if (tGift != 0) _giftT(eoa[2], tGift);
        // Pushes are relative to the price's own tick (`_spotTick`): slot0's tick is one below it here (the close
        // crossed tickLower downward), so a +1 limit from slot0's tick would equal spot and be refused by v4.
        int24 fair = _spotTick();
        if (push < 0) _pushDownTo(eoa[5], fair + push);
        else if (push > 0) _pushUpTo(eoa[0], fair + push);
        // The ring caught up and the hour average at the pushed price (so most runs act; a skip is still a valid
        // outcome, checked as one).
        _catchUp(0);
        Act memory x;
        (x.q0, x.t0) = _hookClaims();
        x.cap = _coreQNear(_tRef()) * 10 / 100;
        x.last0 = hook.lastDeepenBlock();
        x.pair0 = hook.pairedLiquidity();
        vm.recordLogs();
        vm.prank(keeper);
        try hook.deepen(keeper) returns (DepthKind kind, DeepenSkip skip, uint256 qUsed, uint256 tUsed, uint256 tip) {
            (x.kind, x.skip, x.qUsed, x.tUsed, x.tip) = (kind, skip, qUsed, tUsed, tip);
        } catch (bytes memory reason) {
            emit log_named_bytes("deepen reverted", reason);
            fail();
        }
        (x.conv, x.qIn, x.tOut,,,,) = _lastConverted(vm.getRecordedLogs());
        if (x.skip != DeepenSkip.None) _checkSkip(x);
        else _checkAct(x);
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
    }

    function _checkSkip(Act memory x) internal view {
        (uint256 q1, uint256 t1) = _hookClaims();
        assertEq(uint8(x.kind), uint8(DepthKind.None));
        assertEq(x.qUsed | x.tUsed | x.tip, 0, "a skip spends nothing");
        assertEq(q1, x.q0, "a skip keeps the budget");
        assertEq(t1, x.t0);
        assertEq(hook.lastDeepenBlock(), x.last0, "a skip starts no cooldown");
        assertFalse(x.conv);
        DeepenSkip s = x.skip;
        assertTrue(
            s == DeepenSkip.Cooldown || s == DeepenSkip.AverageNotReady || s == DeepenSkip.AverageNotCaughtUp
                || s == DeepenSkip.Deviation || s == DeepenSkip.BudgetBelowMin || s == DeepenSkip.ConvertBelowMin,
            "a documented reason"
        );
    }

    function _checkAct(Act memory x) internal {
        _noteEthOut(EthOut.Tip, x.tip);
        (uint256 q1, uint256 t1) = _hookClaims();
        assertEq(hook.lastDeepenBlock(), vm.getBlockNumber(), "an act starts the cooldown");
        assertEq(x.q0 - q1, x.qUsed + x.tip, "Q: the spend and the tip");
        assertEq(x.tip, _tipOf(x.qUsed), "one tip on every Q spent");
        if (x.kind == DepthKind.Convert) {
            assertTrue(x.conv);
            assertEq(x.qUsed, x.qIn);
            assertEq(x.tUsed, 0);
            assertEq(t1, x.t0 + x.tOut, "T: the T bought");
            assertGe(x.qIn + 16, BoxSpecV1.DEPTH_CONVERT_MIN_Q, "a conversion alone is never a sliver");
            assertEq(hook.pairedLiquidity(), x.pair0);
        } else {
            assertEq(uint8(x.kind), uint8(DepthKind.Pair));
            assertEq(x.t0 + (x.conv ? x.tOut : 0) - t1, x.tUsed, "T: the T paired less the T bought");
            uint256 pairQ = x.qUsed - (x.conv ? x.qIn : 0);
            assertLe(pairQ, x.cap + 1, "the pair's Q within the cap");
            assertGe(pairQ + 2, _min(x.cap, hook.minAdd() - _tipOf(x.q0)), "the pair is never a sliver");
            assertGt(hook.pairedLiquidity(), x.pair0, "the pair grew");
        }
    }

    /// P3.14 (BoxSwapBounds `buyInput`, S5 review): for any price around the graduated layout (with or without the
    /// pair) and any reference within 200 ticks of spot, the one-step input estimate never over-states what the real
    /// exact-input swap to that limit takes (an over-statement would admit a sliver conversion), and under-states it
    /// by at most a few raw units; the real swap ends at the limit and moves at most 49 ticks.
    function testFuzz_AUDIT_U3_buyInputNeverOverstatesTheRealSwap(int24 push, int24 refOffset, bool withPair)
        public
    {
        push = int24(bound(push, -3_000, 3_000));
        refOffset = int24(bound(refOffset, -200, 200));
        if (withPair) _firstPair();
        int24 fair = _spotTick();
        if (push < 0) _pushDownTo(eoa[5], fair + push);
        else if (push > 0) _pushUpTo(eoa[0], fair + push);
        Slot0 s0 = _slot0();
        uint160 spot = s0.sqrtPriceX96();
        int24 tickBefore = s0.tick();
        uint160 limit = bounds.stepLimit(true, spot, tickBefore + refOffset);
        vm.assume(limit != 0);
        (uint24 swapFee,) = bounds.fees(s0, true);
        uint256 est = bounds.buyInput(pm, _stateSlot(), s0, limit, swapFee);
        vm.assume(est > 1_000);
        BalanceDelta d = _swap(eoa[5], _buyParams(est + 1 ether, limit), est + 1 ether);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 qIn = uint256(uint128(-d.amount0()));
        assertEq(_sqrtP(), limit, "the swap reached the limit");
        assertLe(est, qIn, "the estimate never over-states the real input");
        assertLe(qIn - est, 8, "and under-states it by a few raw units at most");
        assertGe(_tick(), tickBefore - 49, "at most 49 ticks");
        _assertGhostLedger();
    }

    // ================================================================================================ helpers

    function _firstPair() internal {
        _fundDepth(eoa[5], 0.5 ether);
        _giftT(eoa[2], _tForQ(0.5 ether, _sqrtP()));
        (DepthKind kind, DeepenSkip skip,,,) = _deepen(keeper, keeper);
        require(skip == DeepenSkip.None && kind == DepthKind.Pair, "u3: the first pair");
    }

    function _deepened(VmSafe.Log[] memory logs)
        internal
        view
        returns (uint128 liquidity, uint256 qUsed, uint256 tUsed, uint256 tip)
    {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.hook && logs[i].topics[0] == IBoxHook.Deepened.selector) {
                (, , , liquidity, qUsed, tUsed, tip) =
                    abi.decode(logs[i].data, (uint8, int24, int24, uint128, uint256, uint256, uint256));
            }
        }
    }

    function _min(uint256 x, uint256 y) internal pure returns (uint256) {
        return x < y ? x : y;
    }
}
