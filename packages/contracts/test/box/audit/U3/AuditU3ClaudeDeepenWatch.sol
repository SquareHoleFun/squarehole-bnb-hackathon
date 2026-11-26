// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm, VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Slot0} from "v4-core/src/types/Slot0.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {DeepenSkip, DepthKind} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {BoxSwapBounds} from "../../../../src/box/libraries/BoxSwapBounds.sol";

/// @notice One observed `deepen()`: what it returned and emitted, and the state around it.
struct AuditU3DeepenRec {
    uint8 kind;
    uint8 skip;
    uint256 qUsed;
    uint256 tUsed;
    uint256 tip;
    uint128 liquidity;
    bool converted;
    uint256 qIn;
    uint256 tOut;
    int24 ref;
    uint160 sAfter;
    uint160 limit;
    uint256 q0;
    uint256 t0;
    uint256 last0;
    uint128 pair0;
    int24 spot0;
    uint160 sqrt0;
    bool ready;
    int24 avg;
    int24 sample;
    uint256 note0;
    uint256 migrated;
    uint256 blockNo;
    uint256 capBase;
    uint256 q1;
    uint256 t1;
    uint256 last1;
    uint128 pair1;
    uint256 note1;
}

/// @title AuditU3ClaudeDeepenWatch
/// @notice TEST ONLY (SH-AUDIT-B0-U3, Claude). Calls box 0's `deepen()` as any caller and checks the result against
/// every documented rule, computed independently of the hook's code (v4's StateLibrary for the pool, the executor's own
/// views for the average, BoxSwapBounds for the bounds the docs name): the guards (`IBoxHook.sol:65-72`, BC-119:
/// graduated, 300 blocks, average ready and caught up, |spot − average| ≤ 99, Q budget ≥ MIN_ADD); a skip changes
/// nothing and starts no cooldown; an action starts the cooldown and moves the hook's claims by exactly what it reports
/// (Q by qUsed + tip, T by tOut − tUsed); the tip is min(5% of the Q spent, the cap) (`IBoxHook.sol:85-87`); a
/// conversion spends at most half the unpaired Q less the tip, to the nearer of 49 ticks and t_ref − 99, with its
/// minimum output, t_ref the higher of sample and average, and notes exactly BoxSwapBounds.feeNote of its input
/// (BC-137, BC-133); a conversion alone spends at least DEPTH_CONVERT_MIN_Q (the S5 review's rule: no cooldown for a
/// sliver); a pair adds liquidity, its Q side at most 10% of the core's Q within 953 ticks above t_ref (BC-120) and
/// only with both sides at MIN_ADD (BC-119, BC-137); the price it acts at is never below t_ref − 99 (BC-142). The
/// `violation` code names the first rule broken (0: none).
contract AuditU3ClaudeDeepenWatch {
    using StateLibrary for IPoolManager;

    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    IPoolManager public immutable pm;
    BoxHook public immutable hook;
    FitBuybackExecutor public immutable executor;
    BoxReceiver public immutable receiver;
    PoolId public immutable id;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;

    constructor(IPoolManager pm_, BoxHook hook_, FitBuybackExecutor executor_, BoxReceiver receiver_) {
        pm = pm_;
        hook = hook_;
        executor = executor_;
        receiver = receiver_;
        id = hook_.poolId();
        (tickLower, tickUpper,) = hook_.curve();
    }

    // ------------------------------------------------------------------------------------------------ observe

    /// @notice `deepen(tipTo)` called by `caller`, observed.
    function deepenAs(address caller, address tipTo) external returns (AuditU3DeepenRec memory r) {
        _before(r);
        vm.recordLogs();
        vm.prank(caller);
        (DepthKind k, DeepenSkip s, uint256 qUsed, uint256 tUsed, uint256 tip) = hook.deepen(tipTo);
        (r.kind, r.skip, r.qUsed, r.tUsed, r.tip) = (uint8(k), uint8(s), qUsed, tUsed, tip);
        _logs(r, vm.getRecordedLogs());
        _after(r);
    }

    function _before(AuditU3DeepenRec memory r) internal view {
        (r.q0, r.t0) = _claims();
        r.last0 = hook.lastDeepenBlock();
        r.pair0 = hook.pairedLiquidity();
        (r.sqrt0, r.spot0,,) = pm.getSlot0(id);
        (r.ready, r.avg,) = executor.twap();
        r.sample = _sampleAfterPoke(r.spot0);
        r.note0 = receiver.hookFeesPending();
        r.migrated = hook.migratedAtBlock();
        r.blockNo = block.number;
        int24 tRef = r.sample > r.avg ? r.sample : r.avg;
        r.capBase = coreQNearPrice(tRef);
    }

    function _after(AuditU3DeepenRec memory r) internal view {
        (r.q1, r.t1) = _claims();
        r.last1 = hook.lastDeepenBlock();
        r.pair1 = hook.pairedLiquidity();
        r.note1 = receiver.hookFeesPending();
        (uint160 s,,,) = pm.getSlot0(id);
        if (!r.converted) r.sAfter = s;
    }

    function _logs(AuditU3DeepenRec memory r, VmSafe.Log[] memory logs) internal view {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(hook)) continue;
            bytes32 t0 = logs[i].topics[0];
            if (t0 == IBoxHook.DepthConverted.selector) {
                r.converted = true;
                (r.qIn, r.tOut, r.ref,, r.sAfter, r.limit) =
                    abi.decode(logs[i].data, (uint256, uint256, int24, uint160, uint160, uint160));
            } else if (t0 == IBoxHook.Deepened.selector) {
                (,,, r.liquidity,,,) =
                    abi.decode(logs[i].data, (DepthKind, int24, int24, uint128, uint256, uint256, uint256));
            }
        }
    }

    // ------------------------------------------------------------------------------------------------ check

    /// @notice The first documented rule `r` breaks (0: none) and why.
    function violation(AuditU3DeepenRec memory r) public view returns (uint8 code, string memory why) {
        if (r.skip != uint8(DeepenSkip.None)) return _skipRules(r);
        (code, why) = _guardRules(r);
        if (code != 0) return (code, why);
        (code, why) = _moneyRules(r);
        if (code != 0) return (code, why);
        if (r.converted) {
            (code, why) = _conversionRules(r);
            if (code != 0) return (code, why);
        }
        if (r.kind == uint8(DepthKind.Convert)) {
            if (!r.converted) return (14, "a Convert without a conversion");
            if (r.qIn < BoxSpecV1.DEPTH_CONVERT_MIN_Q) return (15, "a conversion alone below DEPTH_CONVERT_MIN_Q");
            if (r.qUsed != r.qIn || r.pair1 != r.pair0) return (16, "a conversion alone moved the pair");
        } else if (r.kind == uint8(DepthKind.Pair)) {
            (code, why) = _pairRules(r);
            if (code != 0) return (code, why);
        } else {
            return (17, "acted with no kind");
        }
        // BC-142: whatever it did, it acted at a price no lower than t_ref - 99 (the conversion's end, or spot).
        int24 tRef = r.sample > r.avg ? r.sample : r.avg;
        if (r.sAfter < TickMath.getSqrtPriceAtTick(tRef - BoxSpecV1.EXECUTOR_TWAP_BAND_TICKS)) {
            return (18, "acted below t_ref - 99");
        }
    }

    function _skipRules(AuditU3DeepenRec memory r) internal pure returns (uint8, string memory) {
        if (r.kind != 0) return (20, "a skip with a kind");
        if (r.q1 != r.q0 || r.t1 != r.t0) return (21, "a skip moved the budget");
        if (r.last1 != r.last0) return (22, "a skip started the cooldown");
        if (r.pair1 != r.pair0) return (23, "a skip changed the pair");
        if (r.note1 != r.note0) return (24, "a skip noted fees");
        return (0, "");
    }

    function _guardRules(AuditU3DeepenRec memory r) internal view returns (uint8, string memory) {
        if (r.migrated == 0) return (1, "acted before graduation");
        uint256 from = r.last0 == 0 ? r.migrated : r.last0;
        if (r.blockNo < from + hook.DEEPEN_COOLDOWN_BLOCKS()) return (2, "acted inside the cooldown");
        if (!r.ready) return (3, "acted with the average not ready");
        if (_absDiff(r.sample, r.spot0) > 99) return (4, "acted with the average not caught up");
        if (_absDiff(r.avg, r.spot0) > 99) return (5, "acted more than 99 ticks from the average");
        if (r.q0 < hook.minAdd()) return (6, "acted with the Q budget below MIN_ADD");
        if (r.last1 != r.blockNo) return (7, "acted without starting the cooldown");
        return (0, "");
    }

    function _moneyRules(AuditU3DeepenRec memory r) internal view returns (uint8, string memory) {
        if (r.q1 + r.qUsed + r.tip != r.q0) return (8, "the Q claims fell by other than qUsed + tip");
        if (r.t1 + r.tUsed != r.t0 + r.tOut) return (9, "the T claims moved by other than tOut - tUsed");
        uint256 tip = r.qUsed * BoxSpecV1.DEPTH_TIP_BPS / 10_000;
        if (tip > hook.deepenTipCap()) tip = hook.deepenTipCap();
        if (r.tip != tip) return (10, "the tip is not min(5% of the Q spent, the cap)");
        return (0, "");
    }

    function _conversionRules(AuditU3DeepenRec memory r) internal view returns (uint8, string memory) {
        int24 tRef = r.sample > r.avg ? r.sample : r.avg;
        if (r.ref != tRef) return (30, "t_ref is not the higher of sample and average");
        uint256 tValue0 = tInQ(r.t0, r.sqrt0);
        uint256 tipReserve = r.q0 * BoxSpecV1.DEPTH_TIP_BPS / 10_000;
        if (tipReserve > hook.deepenTipCap()) tipReserve = hook.deepenTipCap();
        uint256 x = (r.q0 - tValue0) * BoxSpecV1.DEPTH_CONVERT_SHARE_BPS / 10_000;
        if (x > r.q0 - tipReserve) x = r.q0 - tipReserve;
        if (r.qIn > x) return (31, "a conversion above half the unpaired Q");
        if (r.limit != BoxSwapBounds.stepLimit(true, r.sqrt0, tRef)) {
            return (32, "the limit is not the nearer of 49 and band");
        }
        if (r.sAfter < r.limit) return (33, "the conversion ended past its limit");
        (uint24 swapFee, uint24 lpShare) = BoxSwapBounds.fees(Slot0.wrap(pm.extsload(_stateSlot())), true);
        if (r.tOut < BoxSwapBounds.minOut(true, r.qIn, r.limit, swapFee)) return (34, "below the minimum output");
        if (r.note1 - r.note0 != BoxSwapBounds.feeNote(r.qIn, lpShare)) {
            return (35, "the fee note is not feeNote(qIn)");
        }
        return (0, "");
    }

    function _pairRules(AuditU3DeepenRec memory r) internal view returns (uint8, string memory) {
        if (r.liquidity == 0) return (40, "a pair that added nothing");
        if (r.pair1 != r.pair0 + r.liquidity) return (41, "the pair grew by other than the add");
        uint256 pairQ = r.qUsed - r.qIn;
        if (pairQ > r.capBase * 10 / 100) return (42, "the pair's Q above 10% of the core's Q near t_ref");
        uint256 minAdd = hook.minAdd();
        if (r.q0 - r.qIn < minAdd) return (43, "a pair with the Q side below MIN_ADD");
        uint160 s = r.converted ? r.sAfter : r.sqrt0;
        if (tInQ(r.t0 + r.tOut, s) < minAdd) return (44, "a pair with the T side below MIN_ADD");
        return (0, "");
    }

    // ------------------------------------------------------------------------------------------------ reads

    function _claims() internal view returns (uint256 q, uint256 t) {
        q = pm.balanceOf(address(hook), 0);
        t = pm.balanceOf(address(hook), uint256(uint160(hook.token())));
    }

    function _stateSlot() internal view returns (bytes32) {
        return StateLibrary._getPoolStateSlot(id);
    }

    /// @notice The sample deepen's own poke leaves (FitBuybackExecutor._observe): the last one if the executor sampled
    /// at this timestamp or the pool has no active liquidity, else spot clamped to ±100 of the last.
    function _sampleAfterPoke(int24 spot) internal view returns (int24) {
        int24 last = executor.latestSampleTick();
        if (uint256(executor.oracle().time) == block.timestamp || pm.getLiquidity(id) == 0) return last;
        int24 step = BoxSpecV1.EXECUTOR_MAX_OBSERVATION_STEP;
        return spot < last - step ? last - step : (spot > last + step ? last + step : spot);
    }

    /// @notice BC-120's base read from v4's StateLibrary: the Q (token0) the hook's positions span over [t_ref, t_ref +
    /// 953] ticks (clamped to MAX_USABLE_TICK) as if the price stood at t_ref (rounded down per position).
    function coreQNearPrice(int24 tRef) public view returns (uint256 q) {
        int24 bandHi = tRef + BoxSpecV1.DEPTH_CAP_BAND_TICKS;
        if (bandHi > BoxSpecV1.MAX_USABLE_TICK) bandHi = BoxSpecV1.MAX_USABLE_TICK;
        if (tRef < BoxSpecV1.MIN_USABLE_TICK || tRef >= bandHi) return 0;
        uint160 lo = TickMath.getSqrtPriceAtTick(tRef);
        uint160 hi = TickMath.getSqrtPriceAtTick(bandHi);
        int24 mn = BoxSpecV1.MIN_USABLE_TICK;
        int24 mx = BoxSpecV1.MAX_USABLE_TICK;
        q += _q0In(lo, hi, mn, tickLower, bytes32(uint256(1)));
        q += _q0In(lo, hi, tickLower, mx, bytes32(uint256(1)));
        q += _q0In(lo, hi, tickUpper, mx, bytes32(uint256(1)));
        q += _q0In(lo, hi, mn, mx, bytes32(uint256(3)));
    }

    function _q0In(uint160 bandLo, uint160 bandHi, int24 lower, int24 upper, bytes32 salt)
        internal
        view
        returns (uint256)
    {
        uint128 l = pm.getPositionLiquidity(id, keccak256(abi.encodePacked(address(hook), lower, upper, salt)));
        if (l == 0) return 0;
        uint160 lo = TickMath.getSqrtPriceAtTick(lower);
        uint160 hi = TickMath.getSqrtPriceAtTick(upper);
        if (lo < bandLo) lo = bandLo;
        if (hi > bandHi) hi = bandHi;
        if (lo >= hi) return 0;
        return SqrtPriceMath.getAmount0Delta(lo, hi, l, false);
    }

    /// @notice `t` valued in Q at √price `s` (T per Q = (s / 2^96)^2), rounded down.
    function tInQ(uint256 t, uint160 s) public pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(t, 1 << 96, s), 1 << 96, s);
    }

    function _absDiff(int24 x, int24 y) internal pure returns (uint256) {
        int256 d = int256(x) - int256(y);
        // casting to 'uint256' is safe because the value is non-negative on both branches
        // forge-lint: disable-next-line(unsafe-typecast)
        return d >= 0 ? uint256(d) : uint256(-d);
    }
}
