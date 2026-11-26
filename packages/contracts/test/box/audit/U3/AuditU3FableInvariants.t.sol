// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxLaunchRouter} from "../../../../src/box/BoxLaunchRouter.sol";
import {BoxLayoutV1} from "../../../../src/box/BoxLayoutV1.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {BoxPhase, DeepenSkip, DepthKind} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {CoreBoxAddresses} from "../../conformance/core/CoreBox0Kit.sol";
import {AuditRouterSwapper} from "../common/AuditActors.sol";
import {AuditU3FableBase, AuditU3FableClaimsGift} from "./AuditU3FableBase.sol";

/// @title AuditU3FableHandler
/// @notice TEST ONLY (SH-AUDIT-B0 U3, Fable). Random actions on the factory's box 0 for the hook's invariant
/// campaigns, every one fail-safe (a refused action is an outcome, never an abort; `fail_on_revert` is on): window
/// buys through the launch router; swaps of every shape, direction, size and price limit through the Universal Router
/// stand-in (limits that land exactly on √P1, √P0, one unit beside them, or anywhere); `collect`; `graduate` at
/// random; `deepen` (the real executor ring poked by the clock action); depth gifts of Q and T; FIT's executor's
/// `execute`; the clock. Ghosts record what must never happen: a swap that succeeds while the curve is closed and not
/// migrated, a price above √P0 before migration, a changed or unset close block, a phase going back, a shrunken
/// position, a `deepen` that reverts, acts under the cooldown, converts a sliver alone or pairs below the rule's
/// least add.
contract AuditU3FableHandler is CommonBase, StdCheats, StdUtils {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IPoolManager internal pm;
    AuditRouterSwapper internal swapper;
    AuditU3FableClaimsGift internal gift;
    BoxHook internal hook;
    BoxCoordinator internal coordinator;
    BoxReceiver internal receiver;
    BoxLaunchRouter internal router;
    FitBuybackExecutor internal executor;
    BoxToken internal token;
    PoolKey internal key;
    PoolId internal id;
    address internal hookAddr;
    address[] internal actors;
    int24 internal tickLower;
    int24 internal tickUpper;
    uint160 internal p1;
    uint160 internal p0;
    uint128 internal curveL;
    uint256 internal raise;

    // ------------------------------------------------------------------ ghosts (what must never happen)
    uint256 public swapWhileClosed;
    uint256 public priceAboveP0;
    uint256 public closedBlockChanged;
    uint256 public closedUnset;
    uint256 public phaseRegressed;
    uint256 public deepenReverted;
    uint256 public deepenUnderCooldown;
    uint256 public convertSliver;
    uint256 public pairSliver;
    uint256 public pairOverCap;
    uint256 public budgetMismatch;
    uint256 public graduateRefusedWhenDue;
    uint256 public curveRemovedBeforeMigration;
    /// @notice A swap that succeeded after the close inside the same unlock (P3.9).
    uint256 public swapAfterCloseInUnlock;
    /// @notice The largest liquidity each of the five positions has shown (curve, ask, bid, sentinel, pair).
    uint128[5] public maxL;
    uint256 public closedBlockSeen;
    uint8 public lastPhase;
    uint256 public lastDeepenSeen;

    // ------------------------------------------------------------------ coverage
    uint256 public calls;
    uint256 public windowBuys;
    uint256 public swapsOk;
    uint256 public swapsRefused;
    uint256 public twoSwapsOk;
    uint256 public twoSwapsRefused;
    uint256 public closes;
    uint256 public collects;
    uint256 public graduations;
    uint256 public deepenPairs;
    /// @notice Calls that ended as a conversion alone (`DepthKind.Convert`).
    uint256 public deepenConverts;
    /// @notice Calls with a conversion (alone, or followed by the pair in the same unlock).
    uint256 public conversions;
    uint256 public deepenSkips;
    uint256 public executes;
    uint256 public gifts;

    constructor(
        IPoolManager pm_,
        CoreBoxAddresses memory a,
        AuditRouterSwapper swapper_,
        AuditU3FableClaimsGift gift_,
        address[] memory actors_,
        BoxLayoutV1.Curve memory curve,
        uint256 raise_
    ) {
        pm = pm_;
        swapper = swapper_;
        gift = gift_;
        hook = BoxHook(a.hook);
        hookAddr = a.hook;
        coordinator = BoxCoordinator(a.coordinator);
        receiver = BoxReceiver(payable(a.receiver));
        router = BoxLaunchRouter(payable(a.launchRouter));
        executor = FitBuybackExecutor(payable(a.executor));
        token = BoxToken(a.token);
        key = hook.poolKey();
        id = key.toId();
        actors = actors_;
        tickLower = curve.tickLower;
        tickUpper = curve.tickUpper;
        p1 = curve.sqrtPriceLowerX96;
        p0 = curve.sqrtPriceUpperX96;
        curveL = curve.liquidity;
        raise = raise_;
        for (uint256 i; i < actors.length; ++i) {
            vm.prank(actors[i]);
            token.approve(address(swapper), type(uint256).max);
        }
        lastPhase = uint8(hook.phase());
        closedBlockSeen = hook.closedAtBlock();
        lastDeepenSeen = hook.lastDeepenBlock();
        _track();
    }

    // ================================================================================================ actions

    function windowBuy(uint256 who, uint256 amount) external {
        address w = _actor(who);
        amount = bound(amount, 0.001 ether, 1 ether);
        vm.deal(w, w.balance + amount);
        vm.prank(w);
        try router.buy{value: amount}(amount, 1, w, block.timestamp) {
            ++windowBuys;
        } catch {}
        _after();
    }

    /// @param shape 0 exact-in buy, 1 exact-out buy, 2 exact-in sell, 3 exact-out sell (a sell by a holder of no T is
    /// an exact-in buy).
    /// @param limitSeed 0: the extreme price; 1: exactly √P1; 2: one unit above √P1; 3: one unit below √P1; 4:
    /// exactly √P0; 5: one unit above √P0; else a random price between spot and the extreme.
    function swapAny(uint256 who, uint8 shape, uint256 amount, uint256 limitSeed) external {
        address w = _actor(who);
        (SwapParams memory p, uint256 value) = _params(w, shape, amount, limitSeed);
        if (value != 0) vm.deal(w, w.balance + value);
        bool closedBefore = hook.closed();
        bool migratedBefore = hook.migratedAtBlock() != 0;
        vm.prank(w);
        try swapper.swapOne{value: value}(key, p, "", w) {
            ++swapsOk;
            if (closedBefore && !migratedBefore) ++swapWhileClosed;
            if (!closedBefore && hook.closed()) ++closes;
        } catch {
            ++swapsRefused;
        }
        _after();
    }

    /// @notice Two swaps in one unlock by a router-like caller (P3.9): the first of `shapeA` limited by `limitSeed`,
    /// the second of `shapeB` to its extreme. Ghost: in a successful unlock no swap follows a `CurveClosed` (the close
    /// is the unlock's last swap, or the whole unlock fails).
    function swapTwo(uint256 who, uint8 shapeA, uint8 shapeB, uint256 amountA, uint256 amountB, uint256 limitSeed)
        external
    {
        address w = _actor(who);
        AuditRouterSwapper.Call[] memory calls = new AuditRouterSwapper.Call[](2);
        (SwapParams memory pa, uint256 va) = _params(w, shapeA, amountA, limitSeed);
        (SwapParams memory pb, uint256 vb) = _params(w, shapeB, amountB, 0);
        calls[0] = AuditRouterSwapper.Call({key: key, params: pa, hookData: ""});
        calls[1] = AuditRouterSwapper.Call({key: key, params: pb, hookData: ""});
        uint256 value = va + vb;
        if (value != 0) vm.deal(w, w.balance + value);
        bool closedBefore = hook.closed();
        bool migratedBefore = hook.migratedAtBlock() != 0;
        vm.recordLogs();
        vm.prank(w);
        try swapper.swap{value: value}(calls, w) {
            ++twoSwapsOk;
            if (closedBefore && !migratedBefore) ++swapWhileClosed;
            if (!closedBefore && hook.closed()) {
                ++closes;
                if (_swapAfterClose()) ++swapAfterCloseInUnlock;
            }
        } catch {
            ++twoSwapsRefused;
        }
        _after();
    }

    function _params(address w, uint8 shape, uint256 amount, uint256 limitSeed)
        internal
        view
        returns (SwapParams memory p, uint256 value)
    {
        shape = uint8(bound(shape, 0, 3));
        if (shape >= 2 && token.balanceOf(w) == 0) shape = 0;
        bool buy = shape < 2;
        (uint160 spot,,,) = pm.getSlot0(id);
        uint160 limit = _limit(buy, spot, limitSeed);
        int256 specified;
        if (shape == 0) {
            value = bound(amount, 1, 3 * raise);
            specified = -int256(value);
        } else if (shape == 1) {
            specified = int256(bound(amount, 1, 5e26));
            value = 3 * raise;
        } else if (shape == 2) {
            specified = -int256(bound(amount, 1, token.balanceOf(w)));
        } else {
            specified = int256(bound(amount, 1, raise));
        }
        p = SwapParams(buy, specified, limit);
    }

    /// @dev In the recorded logs, a PoolManager `Swap` after the hook's `CurveClosed`.
    function _swapAfterClose() internal returns (bool) {
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        bool closedSeen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == hookAddr && logs[i].topics[0] == IBoxHook.CurveClosed.selector) closedSeen = true;
            else if (closedSeen && logs[i].emitter == address(pm) && logs[i].topics[0] == IPoolManager.Swap.selector) {
                return true;
            }
        }
        return false;
    }

    function collect(uint256 who) external {
        address w = _actor(who);
        vm.prank(w);
        try receiver.collect(w) {
            ++collects;
        } catch {}
        _after();
    }

    function graduate(uint256 who) external {
        address w = _actor(who);
        bool due = hook.closed() && hook.migratedAtBlock() == 0;
        vm.prank(w);
        try coordinator.graduate() {
            ++graduations;
        } catch {
            if (due) ++graduateRefusedWhenDue;
        }
        _after();
    }

    struct DeepenSnap {
        uint256 q0;
        uint256 t0;
        uint256 last0;
        uint256 migrated;
        uint128[5] l0;
        DepthKind kind;
        DeepenSkip skip;
        uint256 qUsed;
        uint256 tUsed;
        uint256 tip;
        bool reverted;
    }

    function deepen(uint256 who) external {
        address w = _actor(who);
        DeepenSnap memory d;
        d.q0 = pm.balanceOf(hookAddr, 0);
        d.t0 = pm.balanceOf(hookAddr, uint256(uint160(address(token))));
        d.last0 = hook.lastDeepenBlock();
        d.migrated = hook.migratedAtBlock();
        d.l0 = _positions();
        vm.recordLogs();
        vm.prank(w);
        try hook.deepen(w) returns (DepthKind kind, DeepenSkip skip, uint256 qUsed, uint256 tUsed, uint256 tip) {
            (d.kind, d.skip, d.qUsed, d.tUsed, d.tip) = (kind, skip, qUsed, tUsed, tip);
        } catch {
            d.reverted = true;
            ++deepenReverted;
        }
        if (!d.reverted) _judgeDeepen(d);
        _after();
    }

    function _judgeDeepen(DeepenSnap memory d) internal {
        uint256 q1 = pm.balanceOf(hookAddr, 0);
        uint256 t1 = pm.balanceOf(hookAddr, uint256(uint160(address(token))));
        if (d.skip != DeepenSkip.None) {
            ++deepenSkips;
            if (q1 != d.q0 || t1 != d.t0 || hook.lastDeepenBlock() != d.last0) ++budgetMismatch;
            return;
        }
        if (block.number < (d.last0 == 0 ? d.migrated : d.last0) + 300) ++deepenUnderCooldown;
        if (d.q0 - q1 != d.qUsed + d.tip) ++budgetMismatch;
        (bool conv, uint256 qIn, uint256 tOut) = _converted();
        if (conv) ++conversions;
        if (d.kind == DepthKind.Convert) {
            ++deepenConverts;
            if (!conv || t1 != d.t0 + tOut || d.tUsed != 0) ++budgetMismatch;
            if (qIn + 16 < BoxSpecV1.DEPTH_CONVERT_MIN_Q) ++convertSliver;
            return;
        }
        ++deepenPairs;
        if (d.t0 + (conv ? tOut : 0) - t1 != d.tUsed) ++budgetMismatch;
        uint256 cap = _coreQNear(_tRef(), d.l0) * 10 / 100;
        uint256 pairQ = d.qUsed - (conv ? qIn : 0);
        if (pairQ > cap + 1) ++pairOverCap;
        uint256 least = hook.minAdd() - _tipOf(d.q0);
        if (cap < least) least = cap;
        if (pairQ + 2 < least) ++pairSliver;
    }

    function fundDepth(uint256 who, uint256 amount) external {
        address w = _actor(who);
        amount = bound(amount, 1, 5 ether);
        vm.deal(w, w.balance + amount);
        vm.prank(w);
        try receiver.fundDepth{value: amount}() {
            ++gifts;
        } catch {}
        _after();
    }

    /// @notice A stranger's gift of T claims to the hook: at most T worth 0.004 ETH at spot (a fifth of MIN_ADD), so
    /// the T side moves across MIN_ADD and both depth paths (a pair, a conversion) occur.
    function giftT(uint256 who, uint256 amount) external {
        address w = _actor(who);
        uint256 t = token.balanceOf(w);
        if (t == 0) {
            _after();
            return;
        }
        (uint160 s,,,) = pm.getSlot0(id);
        uint256 most = FullMath.mulDiv(FullMath.mulDiv(0.004 ether, s, 1 << 96), s, 1 << 96);
        if (most < t) t = most;
        if (t == 0) t = 1;
        amount = bound(amount, 1, t);
        vm.prank(w);
        token.transfer(address(gift), amount);
        try gift.giftT(address(token), hookAddr, amount) {
            ++gifts;
        } catch {}
        _after();
    }

    function payFitAndExecute(uint256 chunks) external {
        try receiver.payFit() {} catch {}
        try executor.execute(bound(chunks, 1, 3)) {
            ++executes;
        } catch {}
        _after();
    }

    /// @notice `blocks` blocks of 12 s; the executor ring poked at the end (one sample, at most 100 ticks nearer).
    function advance(uint256 blocks) external {
        blocks = bound(blocks, 1, 310);
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + 12 * blocks);
        try executor.poke() {} catch {}
        _after();
    }

    /// @notice An hour of samples a block apart: the ring catches up and the average follows the price.
    function catchUp() external {
        for (uint256 i; i < 310; ++i) {
            vm.roll(block.number + 1);
            vm.warp(block.timestamp + 12);
            try executor.poke() {} catch {}
        }
        _after();
    }

    // ================================================================================================ ghosts

    function _after() internal {
        ++calls;
        (uint160 spot,,,) = pm.getSlot0(id);
        if (hook.migratedAtBlock() == 0 && spot > p0) ++priceAboveP0;
        uint256 cb = hook.closedAtBlock();
        if (closedBlockSeen != 0 && cb != closedBlockSeen) ++closedBlockChanged;
        if (closedBlockSeen != 0 && cb == 0) ++closedUnset;
        if (cb != 0) closedBlockSeen = cb;
        uint8 ph = uint8(hook.phase());
        if (ph < lastPhase) ++phaseRegressed;
        lastPhase = ph;
        uint256 ld = hook.lastDeepenBlock();
        if (ld < lastDeepenSeen) ++budgetMismatch;
        lastDeepenSeen = ld;
        _track();
    }

    function _track() internal {
        uint128[5] memory l = _positions();
        bool migrated = hook.migratedAtBlock() != 0;
        if (!migrated && l[0] < maxL[0]) ++curveRemovedBeforeMigration;
        for (uint256 i; i < 5; ++i) {
            if (l[i] > maxL[i]) maxL[i] = l[i];
        }
    }

    function _positions() internal view returns (uint128[5] memory l) {
        l[0] = _posL(tickLower, tickUpper, bytes32(0));
        l[1] = _posL(BoxSpecV1.MIN_USABLE_TICK, tickLower, bytes32(uint256(1)));
        l[2] = _posL(tickLower, BoxSpecV1.MAX_USABLE_TICK, bytes32(uint256(1)));
        l[3] = _posL(tickUpper, BoxSpecV1.MAX_USABLE_TICK, bytes32(uint256(1)));
        l[4] = _posL(BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, bytes32(uint256(3)));
    }

    function positions() external view returns (uint128[5] memory) {
        return _positions();
    }

    function _posL(int24 lower, int24 upper, bytes32 salt) internal view returns (uint128 l) {
        (l,,) = pm.getPositionInfo(id, hookAddr, lower, upper, salt);
    }

    function _tRef() internal view returns (int24) {
        (, int24 avg,) = executor.twap();
        int24 sample = executor.latestSampleTick();
        return sample > avg ? sample : avg;
    }

    /// @dev The add cap's base with the positions as they were before the call (BoxHookExtension `_coreQNearPrice`).
    function _coreQNear(int24 tRef, uint128[5] memory l) internal view returns (uint256 q) {
        int24 bandHi = tRef + 953;
        if (bandHi > BoxSpecV1.MAX_USABLE_TICK) bandHi = BoxSpecV1.MAX_USABLE_TICK;
        if (tRef < BoxSpecV1.MIN_USABLE_TICK || tRef >= bandHi) return 0;
        uint160 lo = TickMath.getSqrtPriceAtTick(tRef);
        uint160 hi = TickMath.getSqrtPriceAtTick(bandHi);
        q += _q0In(BoxSpecV1.MIN_USABLE_TICK, tickLower, l[1], lo, hi);
        q += _q0In(tickLower, BoxSpecV1.MAX_USABLE_TICK, l[2], lo, hi);
        q += _q0In(tickUpper, BoxSpecV1.MAX_USABLE_TICK, l[3], lo, hi);
        q += _q0In(BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, l[4], lo, hi);
    }

    function _q0In(int24 lower, int24 upper, uint128 l, uint160 bLo, uint160 bHi) internal pure returns (uint256) {
        if (l == 0) return 0;
        uint160 lo = TickMath.getSqrtPriceAtTick(lower);
        uint160 hi = TickMath.getSqrtPriceAtTick(upper);
        if (lo < bLo) lo = bLo;
        if (hi > bHi) hi = bHi;
        if (lo >= hi) return 0;
        return SqrtPriceMath.getAmount0Delta(lo, hi, l, false);
    }

    function _converted() internal returns (bool found, uint256 qIn, uint256 tOut) {
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == hookAddr && logs[i].topics[0] == IBoxHook.DepthConverted.selector) {
                (qIn, tOut,,,,) = abi.decode(logs[i].data, (uint256, uint256, int24, uint160, uint160, uint160));
                found = true;
            }
        }
    }

    function _tipOf(uint256 amount) internal pure returns (uint256) {
        uint256 tip = amount * 500 / 10_000;
        return tip < BoxSpecV1.FEE_BATCH_TIP_MAX_ETH ? tip : BoxSpecV1.FEE_BATCH_TIP_MAX_ETH;
    }

    function _limit(bool buy, uint160 spot, uint256 seed) internal view returns (uint160) {
        uint256 k = seed % 8;
        uint160 extreme = buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        uint160 want;
        if (k == 0) want = extreme;
        else if (k == 1) want = p1;
        else if (k == 2) want = p1 + 1;
        else if (k == 3) want = p1 - 1;
        else if (k == 4) want = p0;
        else if (k == 5) want = p0 + 1;
        else if (buy) {
            // After an overshoot close the price can sit at the extreme itself: no room below (bound needs min <= max).
            want = spot > TickMath.MIN_SQRT_PRICE + 2
                ? uint160(bound(seed >> 8, TickMath.MIN_SQRT_PRICE + 1, spot - 1))
                : TickMath.MIN_SQRT_PRICE + 1;
        } else {
            want = spot < TickMath.MAX_SQRT_PRICE - 2
                ? uint160(bound(seed >> 8, spot + 1, TickMath.MAX_SQRT_PRICE - 1))
                : TickMath.MAX_SQRT_PRICE - 1;
        }
        // A limit on the wrong side of spot would be refused by v4 before the hook: keep it on the swap's side (at
        // the extreme itself v4 refuses every swap in that direction: a refused outcome, counted, never an abort).
        if (buy && want >= spot) want = spot > TickMath.MIN_SQRT_PRICE + 1 ? spot - 1 : TickMath.MIN_SQRT_PRICE + 1;
        if (!buy && want <= spot) want = spot < TickMath.MAX_SQRT_PRICE - 1 ? spot + 1 : TickMath.MAX_SQRT_PRICE - 1;
        return want;
    }

    function _actor(uint256 who) internal view returns (address) {
        return actors[who % actors.length];
    }
}

/// @notice The shared part of the two campaigns: the handler, and a fixed pseudo-random drive of it that reports which
/// success paths the handler reaches (plan § 3.2's coverage rule, measured once per campaign start; the campaign's own
/// call counts are Foundry's metrics table).
abstract contract AuditU3FableCampaignBase is AuditU3FableBase {
    AuditU3FableHandler internal h;

    /// @dev `n` handler calls chosen by a fixed hash chain (the same sequence every run).
    function _drive(uint256 n) internal {
        bytes32 r = keccak256("u3.fable.coverage");
        for (uint256 i; i < n; ++i) {
            r = keccak256(abi.encode(r, i));
            uint256 k = uint256(r);
            uint256 act = k % 11;
            if (act == 0) h.windowBuy(k, k >> 8);
            else if (act == 1) h.swapAny(k, uint8(k >> 8), k >> 16, k >> 24);
            else if (act == 2) h.swapTwo(k, uint8(k >> 8), uint8(k >> 16), k >> 24, k >> 32, k >> 40);
            else if (act == 3) h.collect(k);
            else if (act == 4) h.graduate(k);
            else if (act == 5) h.deepen(k);
            else if (act == 6) h.fundDepth(k, k >> 8);
            else if (act == 7) h.giftT(k, k >> 8);
            else if (act == 8) h.payFitAndExecute(k);
            else if (act == 9) h.advance(k);
            else h.catchUp();
        }
    }

    function _logCoverage(string memory campaign) internal {
        emit log_named_string("U3F|coverage campaign", campaign);
        emit log_named_uint("U3F|coverage calls", h.calls());
        emit log_named_uint("U3F|coverage windowBuys", h.windowBuys());
        emit log_named_uint("U3F|coverage swapsOk", h.swapsOk());
        emit log_named_uint("U3F|coverage swapsRefused", h.swapsRefused());
        emit log_named_uint("U3F|coverage twoSwapsOk", h.twoSwapsOk());
        emit log_named_uint("U3F|coverage twoSwapsRefused", h.twoSwapsRefused());
        emit log_named_uint("U3F|coverage closes", h.closes());
        emit log_named_uint("U3F|coverage graduations", h.graduations());
        emit log_named_uint("U3F|coverage collects", h.collects());
        emit log_named_uint("U3F|coverage deepenPairs", h.deepenPairs());
        emit log_named_uint("U3F|coverage deepenConverts (alone)", h.deepenConverts());
        emit log_named_uint("U3F|coverage conversions (alone or with the pair)", h.conversions());
        emit log_named_uint("U3F|coverage deepenSkips", h.deepenSkips());
        emit log_named_uint("U3F|coverage executes", h.executes());
        emit log_named_uint("U3F|coverage gifts", h.gifts());
    }
}

/// @notice The curve campaign (plan § 3.2 S1's hook slice): from the window through the close and graduation, under
/// random window buys, swaps of every shape and limit (single and two in one unlock), batches, graduations, depth
/// calls and the clock. Invariants (X05, X09, X16; P3.1, P3.9, P3.15; BC-025, BC-031, BC-032): the price never above
/// √P0 before migration; the curve closes exactly once, in the swap's own block, and stays closed; no swap succeeds
/// while closed and not migrated, nor after the close inside its own unlock; the phases never go back; the hook holds
/// only claims and they are its budget; reserveMinted ≤ cap; no position ever shrinks but the curve's single removal in
/// `migrate`; `graduate()` is never refused once due.
/// forge-config: default.evm_version = "osaka"
contract AuditU3FableCurveInvariants is AuditU3FableCampaignBase {
    function setUp() public override {
        super.setUp();
        _toWindow();
        h = new AuditU3FableHandler(pm, a, routerSwapper, gift, _actors(), curve, raise);
        vm.label(address(h), "u3.handler");
        targetContract(address(h));
    }

    /// Coverage of the curve campaign's success paths on a fixed 1,100-call drive: swaps of both kinds succeed, the
    /// curve closes once and graduates once, batches collect, depth calls act (pairs or conversions) after graduation.
    function testProperty_AUDIT_U3_curveHandlerReachesEverySuccessPath() public {
        _drive(1_100);
        _logCoverage("curve");
        assertGt(h.swapsOk(), 0);
        assertGt(h.twoSwapsOk(), 0);
        assertEq(h.closes(), 1, "the drive closed the curve once");
        assertEq(h.graduations(), 1, "and graduated once");
        assertGt(h.collects(), 0);
        assertGt(h.deepenPairs() + h.deepenConverts(), 0, "depth calls acted after graduation");
        assertGt(h.gifts(), 0);
        assertEq(h.swapAfterCloseInUnlock(), 0);
        assertEq(h.swapWhileClosed(), 0);
        assertEq(h.priceAboveP0(), 0);
        assertEq(h.deepenReverted() + h.budgetMismatch() + h.pairSliver() + h.convertSliver() + h.pairOverCap(), 0);
    }

    function _actors() internal view returns (address[] memory list) {
        list = new address[](8);
        for (uint256 i; i < 6; ++i) {
            list[i] = eoa[i];
        }
        list[6] = address(contractDrawer);
        list[7] = eoa7702;
    }

    function invariant_AUDIT_U3_priceFloorAndCloseOnce() public view {
        assertEq(h.priceAboveP0(), 0, "price above sqrt(P0) before migration");
        assertEq(h.swapWhileClosed(), 0, "a swap succeeded while the curve was closed");
        assertEq(h.swapAfterCloseInUnlock(), 0, "a swap followed the close inside its own unlock (P3.9)");
        assertEq(h.closedBlockChanged(), 0, "closedAtBlock changed after the close");
        assertEq(h.closedUnset(), 0, "the close was undone");
        assertEq(h.phaseRegressed(), 0, "a phase went back");
        if (hook.migratedAtBlock() == 0) assertLe(_sqrtP(), curve.sqrtPriceUpperX96, "live: price <= sqrt(P0)");
        if (hook.closed()) assertGt(hook.closedAtBlock(), 0);
        if (hook.migratedAtBlock() != 0) assertTrue(hook.closed(), "migrated implies closed");
        assertLe(h.closes(), 1, "at most one close in a run");
    }

    function invariant_AUDIT_U3_hookHoldsOnlyClaimsAndReserveWithinCap() public view {
        _assertHookHoldsOnlyClaims();
        assertLe(hook.reserveMinted(), hook.reserveCap(), "reserveMinted <= cap");
        assertEq(h.budgetMismatch(), 0, "a deepen moved the budget other than by its figures");
    }

    function invariant_AUDIT_U3_positionsNeverShrink() public view {
        uint128[5] memory l = h.positions();
        bool migrated = hook.migratedAtBlock() != 0;
        assertEq(h.curveRemovedBeforeMigration(), 0, "the curve shrank before migration");
        if (migrated) assertEq(l[0], 0, "the curve is removed once, in migrate");
        else assertEq(l[0], curve.liquidity, "the curve keeps its liquidity until migrate");
        for (uint256 i = 1; i < 5; ++i) {
            assertGe(l[i], h.maxL(i), "an L7 or pair position shrank");
        }
        assertEq(_posL(MIN_T, MAX_T, SALT_RUNGS_NEVER_USED), 0, "no salt-2 position");
    }

    function invariant_AUDIT_U3_livenessAndDeepenRules() public view {
        assertEq(h.graduateRefusedWhenDue(), 0, "graduate() refused once closed and not migrated");
        assertEq(h.deepenReverted(), 0, "deepen reverted");
        assertEq(h.deepenUnderCooldown(), 0, "deepen acted under the cooldown");
        assertEq(h.convertSliver(), 0, "a conversion alone below DEPTH_CONVERT_MIN_Q started the cooldown");
        assertEq(h.pairSliver(), 0, "a pair below the rule's least add started the cooldown");
        assertEq(h.pairOverCap(), 0, "a pair above the 10% cap");
    }
}

/// @notice The depth campaign (plan § 3.2 S2's hook slice): graduated, FIT's executor ring ready, under random swaps
/// and pushes, depth gifts on both sides, `deepen`, batches, the executor's buys and the clock. Invariants (X09,
/// X16; P3.1, P3.4, P3.10, P3.16; BC-119 to BC-121, BC-137): the hook holds only claims and they are its budget;
/// every `deepen` either skips and changes nothing or acts after the cooldown with the budget falling by exactly its
/// figures, a conversion alone never a sliver, a pair never below the rule's least add nor above the cap; the L7
/// positions and the pair never shrink; salt 2 never exists; the close and migration blocks and the reserve never
/// change after graduation.
/// forge-config: default.evm_version = "osaka"
contract AuditU3FableDepthInvariants is AuditU3FableCampaignBase {
    uint256 internal closedAt;
    uint256 internal migratedAt;
    uint256 internal reserve;

    function setUp() public override {
        super.setUp();
        _toGraduated();
        _warmRing(320);
        closedAt = hook.closedAtBlock();
        migratedAt = hook.migratedAtBlock();
        reserve = hook.reserveMinted();
        address[] memory list = new address[](7);
        for (uint256 i; i < 6; ++i) {
            list[i] = eoa[i];
        }
        list[6] = address(contractDrawer);
        h = new AuditU3FableHandler(pm, a, routerSwapper, gift, list, curve, raise);
        vm.label(address(h), "u3.handler");
        targetContract(address(h));
    }

    /// Coverage of the depth campaign's success paths on a fixed 1,100-call drive: pairs and conversions both happen,
    /// skips too, batches collect, FIT's executor buys, swaps of both kinds succeed.
    function testProperty_AUDIT_U3_depthHandlerReachesEverySuccessPath() public {
        _drive(1_100);
        _logCoverage("depth");
        assertGt(h.swapsOk(), 0);
        assertGt(h.twoSwapsOk(), 0);
        assertGt(h.collects(), 0);
        assertGt(h.deepenPairs(), 0, "pairs happened");
        assertGt(h.conversions(), 0, "conversions happened (alone or followed by the pair)");
        assertGt(h.deepenSkips(), 0);
        assertGt(h.executes(), 0, "FIT's executor bought");
        assertGt(h.gifts(), 0);
        assertEq(h.deepenReverted() + h.budgetMismatch() + h.pairSliver() + h.convertSliver() + h.pairOverCap(), 0);
        assertEq(h.deepenUnderCooldown(), 0);
    }

    function invariant_AUDIT_U3_hookHoldsOnlyClaimsAfterGraduation() public view {
        _assertHookHoldsOnlyClaims();
        assertEq(hook.reserveMinted(), reserve, "the reserve never changes after graduation");
        assertEq(hook.closedAtBlock(), closedAt);
        assertEq(hook.migratedAtBlock(), migratedAt);
        assertEq(uint8(hook.phase()), uint8(BoxPhase.Graduated));
        assertEq(h.budgetMismatch(), 0, "a deepen moved the budget other than by its figures");
    }

    function invariant_AUDIT_U3_depthPositionsNeverShrink() public view {
        uint128[5] memory l = h.positions();
        assertEq(l[0], 0, "no curve after migration");
        for (uint256 i = 1; i < 5; ++i) {
            assertGe(l[i], h.maxL(i), "an L7 or pair position shrank");
        }
        assertEq(_posL(MIN_T, MAX_T, SALT_RUNGS_NEVER_USED), 0, "no salt-2 position");
    }

    function invariant_AUDIT_U3_deepenRulesUnderPushes() public view {
        assertEq(h.deepenReverted(), 0, "deepen reverted");
        assertEq(h.deepenUnderCooldown(), 0, "deepen acted under the cooldown");
        assertEq(h.convertSliver(), 0, "a conversion alone below DEPTH_CONVERT_MIN_Q started the cooldown");
        assertEq(h.pairSliver(), 0, "a pair below the rule's least add started the cooldown");
        assertEq(h.pairOverCap(), 0, "a pair above the 10% cap");
        assertEq(h.swapWhileClosed(), 0);
        assertEq(h.phaseRegressed(), 0);
    }
}
