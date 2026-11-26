// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU3ClaudeBase, AuditU3ClaudeTipTaker} from "./AuditU3ClaudeBase.sol";
import {AuditU3ClaudeDeepenWatch, AuditU3DeepenRec} from "./AuditU3ClaudeDeepenWatch.sol";

/// @title AuditU3ClaudeInvariantBase
/// @notice TEST ONLY (SH-AUDIT-B0-U3, Claude). What both of U3's invariant campaigns share. The campaign's handler is
/// the test contract itself (explicitly targeted, selectors listed), so every action uses the world's own booking
/// helpers (`AuditBox0World`) and the ghost ledger lives in one place. Every handler swallows its action's revert
/// (the default profile's `fail_on_revert` is on) and decides itself whether the outcome breaks a documented rule; the
/// first rule broken is kept in `violation` / `violationWhy`, which one invariant asserts is empty after every call.
/// The state invariants read the chain directly (v4's StateLibrary, never the hook's own views alone).
abstract contract AuditU3ClaudeInvariantBase is AuditU3ClaudeBase {
    /// @notice The first rule a call broke (0: none) and why.
    uint256 public violation;
    string public violationWhy;

    AuditU3ClaudeDeepenWatch internal watch;
    AuditU3ClaudeTipTaker internal taker;

    // Ghosts of the graduated layout: the L7 positions as the migration seeded them, the pair's high-water mark.
    uint128 internal gAsk;
    uint128 internal gBid;
    uint128 internal gSentinel;
    uint128 internal gPair;
    uint256 internal gMigratedAt;
    uint256 internal gLastDeepen;

    // Coverage counters (logged by the campaigns' summary test).
    uint256 public nDeepenActs;
    uint256 public nDeepenSkips;
    uint256 public nPairs;
    uint256 public nConversions;
    uint256 public nCollects;
    uint256 public nTakerTips;

    function _fail(uint256 code, string memory why) internal {
        if (violation == 0) {
            violation = code;
            violationWhy = why;
        }
    }

    /// @notice The liquidity of the hook's positions that are in range at Slot0's tick (v4's own convention: a position
    /// [lower, upper) is active when lower <= tick < upper).
    function _hookActiveL() internal view returns (uint256 l) {
        int24 t = _tickNow();
        if (curve.tickLower <= t && t < curve.tickUpper) l += _curveL();
        if (MIN_T <= t && t < curve.tickLower) l += _askL();
        if (curve.tickLower <= t && t < MAX_T) l += _bidL();
        if (curve.tickUpper <= t && t < MAX_T) l += _sentinelL();
        if (MIN_T <= t && t < MAX_T) l += _pairL();
    }

    /// @notice The hook's views equal what StateLibrary reads for every position it reports (P3.13).
    function _assertViewsAreStateLibrarys() internal view {
        (int24 lo, int24 hi, uint128 l) = hook.curve();
        assertEq(lo, curve.tickLower);
        assertEq(hi, curve.tickUpper);
        assertEq(l, _curveL(), "curve(): the curve position's liquidity");
        (uint128 ask, uint128 bid, uint128 sentinel) = hook.graduatedLayout();
        assertEq(ask, _askL(), "graduatedLayout(): ask");
        assertEq(bid, _bidL(), "graduatedLayout(): bid");
        assertEq(sentinel, _sentinelL(), "graduatedLayout(): sentinel");
        assertEq(hook.pairedLiquidity(), _pairL(), "pairedLiquidity()");
        (uint256 qb, uint256 tb) = hook.depthBudget();
        (uint256 q, uint256 t) = _hookClaims();
        assertEq(qb, q, "depthBudget(): the hook's Q claims");
        assertEq(tb, t, "depthBudget(): the hook's T claims");
    }

    /// @notice One `deepen()` through the watch, its tip to the keeper or to the re-entering taker; books the tip
    /// recipient's ETH and T; records the first rule it broke; a revert is itself a broken rule (BC-119: a skip, never
    /// a revert, outside a foreign unlock).
    function _deepenWatched(bool viaTaker) internal returns (AuditU3DeepenRec memory r, bool done) {
        address tipTo = viaTaker ? address(taker) : keeper;
        if (viaTaker) {
            uint256 have = token.balanceOf(address(taker));
            taker.arm(have / 4);
        }
        (uint256 e0, uint256 t0) = (tipTo.balance, token.balanceOf(tipTo));
        try watch.deepenAs(keeper, tipTo) returns (AuditU3DeepenRec memory rec) {
            r = rec;
            done = true;
        } catch {
            _fail(30, "deepen() reverted outside a foreign unlock");
        }
        if (viaTaker) taker.disarm();
        _noteEthChange(e0, tipTo.balance, EthIn.Other, EthOut.Tip);
        _noteTChange(t0, token.balanceOf(tipTo), TIn.Sell, TOut.Buy);
        if (!done) return (r, done);
        (uint8 code, string memory why) = watch.violation(r);
        if (code != 0) _fail(100 + code, why);
        if (r.skip == 0) {
            ++nDeepenActs;
            if (r.kind == 1) ++nPairs;
            if (r.converted) ++nConversions;
            if (viaTaker && r.tip != 0) {
                ++nTakerTips;
                if (taker.tipReceived() != r.tip) _fail(31, "the tip did not reach the recipient whole");
                if (taker.deepenOk() || taker.collectOk() || taker.harvestOk() || taker.unlockOk()) {
                    _fail(32, "the tip recipient deepened, collected, harvested or unlocked inside the hook's unlock");
                }
            }
            uint256 from = gLastDeepen == 0 ? gMigratedAt : gLastDeepen;
            if (vm.getBlockNumber() < from + hook.DEEPEN_COOLDOWN_BLOCKS()) _fail(33, "two acts within 300 blocks");
            gLastDeepen = vm.getBlockNumber();
        } else {
            ++nDeepenSkips;
        }
    }

    /// @notice `collect()` as the keeper with the batch's logs: the pokes (zero-liquidity ModifyLiquidity of the hook)
    /// and the claims the receiver moved to the hook (DepthFunded, ModuleFeesReturned's hook part).
    function _collectCounted() internal returns (bool ok, bytes4 reason, uint256 pokes, uint256 others) {
        (uint256 q0, uint256 t0) = _hookClaims();
        vm.recordLogs();
        try this.collectAsKeeper() {
            ok = true;
        } catch (bytes memory err) {
            if (err.length >= 4) reason = bytes4(err);
        }
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        if (!ok) return (ok, reason, 0, 0);
        ++nCollects;
        bytes32 sig = keccak256("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)");
        uint256 dq;
        uint256 dt;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(pm) && logs[i].topics[0] == sig) {
                (,, int256 delta,) = abi.decode(logs[i].data, (int24, int24, int256, bytes32));
                if (delta == 0 && logs[i].topics[2] == bytes32(uint256(uint160(a.hook)))) ++pokes;
                else ++others;
            } else if (logs[i].emitter == a.receiver && logs[i].topics[0] == IBoxReceiver.DepthFunded.selector) {
                (uint256 q, uint256 t) = abi.decode(logs[i].data, (uint256, uint256));
                (dq, dt) = (dq + q, dt + t);
            } else if (logs[i].emitter == a.receiver && logs[i].topics[0] == IBoxReceiver.ModuleFeesReturned.selector) {
                (,, uint256 hq) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                dq += hq;
            }
        }
        (uint256 q1, uint256 t1) = _hookClaims();
        if (q1 != q0 + dq || t1 != t0 + dt) {
            _fail(34, "a batch moved the hook's claims by other than its depth parts and notes");
        }
    }

    /// @notice The keeper's collect (external so its revert can be caught; only this contract may call it).
    function collectAsKeeper() external {
        require(msg.sender == address(this), "self only");
        _collect(keeper, keeper);
    }

    /// @notice The number of positions the hook has (a poke needs a position with liquidity).
    function _positionsHeld() internal view returns (uint256 n) {
        if (_curveL() != 0) ++n;
        if (_askL() != 0) ++n;
        if (_bidL() != 0) ++n;
        if (_sentinelL() != 0) ++n;
        if (_pairL() != 0) ++n;
    }

    /// @notice After every call: the L7 positions as seeded, the pair never below its high-water mark.
    function _checkPositions() internal {
        if (hook.migratedAtBlock() == 0) return;
        if (_askL() != gAsk || _bidL() != gBid || _sentinelL() != gSentinel) _fail(40, "an L7 position changed");
        uint128 p = _pairL();
        if (p < gPair) _fail(41, "the pair shrank");
        gPair = p;
    }
}
