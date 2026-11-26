// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {DeepenSkip, DepthKind, FeeBatch} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {AuditPhases} from "../common/AuditPhases.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU4ClaudeClaimGifter} from "./AuditU4ClaudeHelpers.sol";

/// @notice Everything box 0's receiver books, holds or moves, read in one go (raw units).
struct U4Books {
    uint256 claimsQ;
    uint256 claimsT;
    uint256 bookedQ;
    uint256 bookedT;
    uint256 fitOwed;
    uint256 platformOwed;
    uint256 platformHeld;
    uint256 depthHeldQ;
    uint256 depthHeldT;
    uint256 qCarry;
    uint256 tCarry;
    uint256 tBurnPending;
    uint256 moduleQPending;
    uint256 moduleTPending;
    uint256 hookFeesPending;
    uint256 hookClaimsQ;
    uint256 hookClaimsT;
    uint256 coordinatorClaimsQ;
    uint256 receiverT;
    uint256 streamT;
    uint256 tSupply;
    uint256 receiverEth;
    uint256 safeEth;
    uint256 executorEth;
    uint256 toFit;
    uint256 toPlatform;
    uint256 qToDepth;
    uint256 tToDepth;
    uint256 tBurned;
}

/// @notice What one batch should do, computed from the receiver's books before it (BoxReceiver.sol:158-181,
/// :632-705, :906-932).
struct U4Expected {
    uint256 newQ;
    uint256 back;
    uint256 hookBack;
    uint256 tip;
    uint256 u;
    uint256 qCarry;
    uint256 keep;
    uint256 excess;
    uint256 v;
    uint256 tCarry;
}

/// @title AuditU4ClaudeBase
/// @notice TEST ONLY (SH-AUDIT-B0 U4, Claude auditor). The shared world's box 0 (`AuditPhases`, R0-A, read-only) plus
/// what the receiver and royalty router properties need: a snapshot of the receiver's books, the expected split of a
/// batch from the books before it (an independent model of BoxReceiver.sol `collect`, `_returnFees`, `_split`,
/// `_capPlatform`), claim gifts as any account can make them, the PoolManager's open deltas, epochs and a late
/// settlement made by a failing graduation poke (a harness: `vm.mockCallRevert` on the receiver's `onGraduation`
/// for the one `graduate()` call, as the money review's M31 etched a gas sink there).
abstract contract AuditU4ClaudeBase is AuditPhases {
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    uint256 internal constant CAP = BoxSpecV1.PLATFORM_CAP_WEI;
    uint256 internal constant EPOCH = BoxSpecV1.PLATFORM_EPOCH_SECONDS;
    uint256 internal constant BATCH_MIN = BoxSpecV1.FEE_BATCH_MIN_ETH;
    uint256 internal constant TIP_MAX = BoxSpecV1.FEE_BATCH_TIP_MAX_ETH;
    uint256 internal constant TIP_BPS = BoxSpecV1.FEE_BATCH_TIP_BPS;
    uint256 internal constant FIFTEEN = BoxSpecV1.FEE_SHARE_DENOMINATOR;
    /// @dev `TransientReentrancyGuard.Reentrancy()`.
    bytes4 internal constant REENTRANCY = 0xab143c06;

    AuditU4ClaudeClaimGifter internal gifter;

    function setUp() public virtual override {
        super.setUp();
        gifter = new AuditU4ClaudeClaimGifter(pm);
        vm.label(address(gifter), "audit.u4.gifter");
        _ghostAddOutside(address(gifter));
    }

    // ================================================================================================ reads

    function _claims(address who, address asset) internal view returns (uint256) {
        return pm.balanceOf(who, uint256(uint160(asset)));
    }

    function _books() internal view returns (U4Books memory b) {
        b.claimsQ = _claims(a.receiver, address(0));
        b.claimsT = _claims(a.receiver, a.token);
        (b.bookedQ, b.bookedT) = receiver.booked();
        b.fitOwed = receiver.fitOwed();
        b.platformOwed = receiver.platformOwed();
        b.platformHeld = receiver.platformHeld();
        (b.depthHeldQ, b.depthHeldT) = receiver.depthHeld();
        (b.qCarry, b.tCarry) = receiver.carried();
        b.tBurnPending = receiver.tBurnPending();
        (b.moduleQPending, b.moduleTPending) = receiver.moduleFeesPending();
        b.hookFeesPending = receiver.hookFeesPending();
        b.hookClaimsQ = _claims(a.hook, address(0));
        b.hookClaimsT = _claims(a.hook, a.token);
        b.coordinatorClaimsQ = _claims(a.coordinator, address(0));
        b.receiverT = token.balanceOf(a.receiver);
        b.streamT = token.balanceOf(a.itemStream);
        b.tSupply = token.totalSupply();
        b.receiverEth = a.receiver.balance;
        b.safeEth = safe.balance;
        b.executorEth = a.executor.balance;
        (b.toFit, b.toPlatform, b.qToDepth, b.tToDepth, b.tBurned,,) = receiver.totals();
    }

    /// @notice The receiver's claims in no ledger: the next batch (BoxReceiver.sol:1024-1029).
    function _unbooked() internal view returns (uint256 q, uint256 t) {
        U4Books memory b = _books();
        return (b.claimsQ - b.bookedQ, b.claimsT - b.bookedT);
    }

    function _epochNow() internal view returns (uint256) {
        return (vm.getBlockTimestamp() - coordinator.graduatedAt()) / EPOCH;
    }

    /// @notice The PoolManager is locked and has no open delta (L6: every receiver unlock settled to zero).
    function _assertNoOpenDelta() internal view {
        assertFalse(pm.isUnlocked(), "the PoolManager is locked again");
        assertEq(pm.getNonzeroDeltaCount(), 0, "no currency delta left open");
        assertEq(pm.currencyDelta(a.receiver, Currency.wrap(address(0))), 0, "the receiver's ETH delta");
        assertEq(pm.currencyDelta(a.receiver, Currency.wrap(a.token)), 0, "the receiver's T delta");
    }

    // ================================================================================================ the model

    /// @notice The batch `collect()` makes of `newQ` and `newT` new claims, from the books before it, with the cap's
    /// room `room` (platformEpoch's `remaining` read before the call). `graduated` decides whether P is capped;
    /// `asCollect` adds collect's REV-16 returns and tip (`fundFees` and the settlement have no tip).
    function _expect(U4Books memory b0, uint256 newQ, uint256 newT, uint256 room, bool graduated, bool asCollect)
        internal
        pure
        returns (U4Expected memory e)
    {
        e.newQ = newQ;
        if (asCollect) {
            e.back = b0.moduleQPending < newQ ? b0.moduleQPending : newQ;
            uint256 left = newQ - e.back;
            e.hookBack = b0.hookFeesPending < left ? b0.hookFeesPending : left;
        }
        uint256 restQ = newQ - e.back - e.hookBack;
        if (asCollect) {
            e.tip = newQ * TIP_BPS / 10_000;
            if (e.tip > TIP_MAX) e.tip = TIP_MAX;
            if (e.tip > restQ) e.tip = restQ;
        }
        uint256 qTotal = restQ - e.tip + b0.qCarry;
        e.u = qTotal / FIFTEEN;
        e.qCarry = qTotal % FIFTEEN;
        uint256 p = 2 * e.u;
        if (graduated) {
            e.keep = p < room ? p : room;
            e.excess = p - e.keep;
        }
        uint256 tTotal = newT + b0.tCarry;
        e.v = tTotal / FIFTEEN;
        e.tCarry = tTotal % FIFTEEN;
    }

    /// @notice A graduated batch did exactly what the model says (P4.1, P4.2, P4.17; IBoxReceiver.sol:62-64).
    function _assertGraduatedBatch(U4Books memory b0, U4Books memory b1, U4Expected memory e, uint256 tipPaid)
        internal
        pure
    {
        assertEq(tipPaid, e.tip, "tip = min(10%, 0.0005 ETH, the rest)");
        assertEq(b1.fitOwed - b0.fitOwed, 11 * e.u + e.back, "FIT: 11/15 plus the executor's returned notes");
        assertEq(b1.platformOwed - b0.platformOwed, e.keep, "the Safe: keep = min(P, room)");
        assertEq(b1.hookClaimsQ - b0.hookClaimsQ, 2 * e.u + e.excess + e.hookBack, "depth: 2/15 + excess + hook notes");
        assertEq(b1.qCarry, e.qCarry, "Q carry");
        assertEq(b0.moduleQPending - b1.moduleQPending, e.back, "the executor's notes consumed");
        assertEq(b0.hookFeesPending - b1.hookFeesPending, e.hookBack, "the hook's notes consumed");
        // The per-batch identity: every wei of the batch (and the carry in) in exactly one place.
        assertEq(
            e.newQ + b0.qCarry,
            (11 * e.u + e.back) + e.keep + (2 * e.u + e.excess + e.hookBack) + e.tip + e.qCarry,
            "Q: batch + carry in == FIT + platform + depth + tip + carry out"
        );
        assertEq(_streamIn(b0, b1), 13 * e.v, "T: 13/15 to the stream");
        assertEq(b1.hookClaimsT - b0.hookClaimsT, 2 * e.v, "T: 2/15 to depth");
        assertEq(b1.tCarry, e.tCarry, "T carry");
        assertEq(b1.claimsQ - b1.bookedQ, 0, "Q: nothing left unbooked after the batch");
        assertEq(b1.claimsT - b1.bookedT, 0, "T: nothing left unbooked after the batch");
        assertEq(b1.safeEth, b0.safeEth, "a batch pays the Safe nothing");
        assertEq(b1.executorEth, b0.executorEth, "a batch pays the executor nothing");
    }

    // ================================================================================================ actions

    /// @notice `amount` of ETH claims gifted to `to` by an outside account (booked: ETH into the PoolManager).
    function _giftEth(address to, uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        uint256 pm0 = address(pm).balance;
        gifter.giftEth{value: amount}(to);
        assertEq(address(pm).balance - pm0, amount, "u4: the gift reached the PoolManager");
        _noteEthIn(EthIn.Other, amount);
    }

    /// @notice T the stream received in a call: its balance change plus what it burned at once (its notice burns the
    /// share of the items inside the vault), less any burn by the receiver itself (`tBurned` totals).
    function _streamIn(U4Books memory b0, U4Books memory b1) internal pure returns (uint256) {
        return (b1.streamT - b0.streamT) + (b0.tSupply - b1.tSupply) - (b1.tBurned - b0.tBurned);
    }

    /// @notice `amount` of T claims gifted to `to`, the T bought first by `buyer` (booked as T into the system).
    function _giftT(address buyer, address to, uint256 amount) internal {
        uint256 t0 = token.balanceOf(buyer);
        vm.prank(buyer);
        require(token.transfer(address(gifter), amount), "u4: T to the gifter");
        gifter.giftToken(a.token, to, amount);
        _noteTChange(t0, token.balanceOf(buyer), TIn.Other, TOut.Other);
    }

    /// @notice `collect(tipTo)` by `caller`, returning the batch and what `tipTo` received.
    function _collectMeasured(address caller, address tipTo) internal returns (FeeBatch memory b, uint256 tipPaid) {
        uint256 e0 = tipTo.balance;
        b = _collect(caller, tipTo);
        tipPaid = tipTo.balance - e0;
    }

    /// @notice A batch of exactly `q` new Q claims (graduated: no harvest since the last batch adds none unless trades
    /// ran), gifted to the receiver.
    function _batchOf(uint256 q) internal {
        _giftEth(a.receiver, q);
    }

    /// @notice A buy of `q` by eoa[3] and a sell of half the T it got: Q and T fees in the positions for the next
    /// collect.
    function _tradeBothSides(uint256 q) internal {
        uint256 tOut = _buy(eoa[3], q);
        _advance(1);
        _sell(eoa[3], tOut / 2);
        _advance(1);
    }

    /// @notice Builds box 0's depth pair as the money review's M20 does: 0.3 ETH of depth (fundDepth) and T claims of
    /// the same value at the current price given to the hook, an hour of samples, then deepen() once the cooldown
    /// allows. Afterwards collect pokes four positions (the ask, the bid, the sentinel and the pair).
    function _makePair() internal {
        _fundDepth(eoa[1], 0.3 ether);
        (uint160 sqrtP,,,) = pm.getSlot0(hook.poolId());
        uint256 tAmount = FullMath.mulDiv(FullMath.mulDiv(0.3 ether, sqrtP, 1 << 96), sqrtP, 1 << 96);
        uint256 have = token.balanceOf(eoa[0]);
        require(have >= tAmount, "u4: eoa[0] holds the T for the pair");
        _giftT(eoa[0], a.hook, tAmount);
        vm.warp(vm.getBlockTimestamp() + 3600);
        vm.roll(
            hook.migratedAtBlock() + 300 > vm.getBlockNumber() ? hook.migratedAtBlock() + 300 : vm.getBlockNumber() + 1
        );
        (DepthKind kind, DeepenSkip skip,,,) = _deepen(keeper, keeper);
        assertEq(uint256(skip), uint256(DeepenSkip.None), "deepen ran");
        assertEq(uint256(kind), uint256(DepthKind.Pair), "the pair exists");
    }

    /// @notice Box 0 graduated with the receiver's graduation poke failing (the harness of the money review's M31):
    /// the receiver is not settled until its first later call. Every other effect of `graduate()` happens.
    function _toGraduatedLate() internal returns (uint256 pokeFailures) {
        _toClosed();
        _warpTo(_requestTimeFor(r0));
        vm.mockCallRevert(a.receiver, abi.encodeWithSelector(IBoxReceiver.onGraduation.selector), "");
        (graduationReward, pokeFailures) = _graduate(keeper);
        vm.clearMockedCalls();
        graduationPokeFailures = pokeFailures;
        reached = AuditPhase.Graduated;
        assertFalse(receiver.graduationSettled(), "harness: the settlement waits");
        _assertGhostLedger();
    }

    /// @notice Warps to graduatedAt + `epoch` × 30 days + `offset` seconds (offset may be negative), one block on.
    function _warpToEpoch(uint256 epoch, int256 offset) internal {
        uint256 t = coordinator.graduatedAt() + epoch * EPOCH;
        t = offset < 0 ? t - uint256(-offset) : t + uint256(offset);
        require(t >= vm.getBlockTimestamp(), "u4: the clock never goes back");
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(t);
    }

    /// @notice Σ `kept` of the receiver's PlatformCredited events in `logs`, per the epoch each names.
    function _creditedIn(VmSafe.Log[] memory logs, uint256 epoch) internal view returns (uint256 kept) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != a.receiver || logs[i].topics[0] != IBoxReceiver.PlatformCredited.selector) continue;
            if (uint256(logs[i].topics[1]) != epoch) continue;
            (uint256 k,,) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            kept += k;
        }
    }
}
