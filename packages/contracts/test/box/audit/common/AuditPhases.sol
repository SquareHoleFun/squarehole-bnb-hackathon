// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditBox0World} from "./AuditBox0World.sol";

/// @title AuditPhases
/// @notice TEST ONLY (SH-AUDIT-B0 R0-A). Brings the world's box 0 to a phase of its life, each driver running the ones
/// before it if they have not run (calling a driver for a phase already passed does nothing). Every driver ends with
/// the ghost ledger checked. What each leaves (the smoke tests in `AuditWorldSmoke.t.sol` assert it):
/// - **Window**: three 12-s steps into the 384-s window: eoa[0] bought 0.02 ETH through the launch router (step 3),
///   eoa[1] 0.05 ETH (step 4); their tax unswept in the router.
/// - **Bonding**: after the window, through the Universal Router stand-in: exact-input buys by eoa[0] (0.6 ETH), eoa[1]
///   (0.4), eoa[3] (0.3), eoa[4] (0.2), the contract drawer and the EIP-7702 EOA (0.3 each), an exact-output buy by
///   eoa[5], a sell of a third of eoa[0]'s T; placeholders 1-3 taken by eoa[0], 4-5 by eoa[1]; one fee batch
///   collected by the keeper (tip to it). The PoolManager then holds 1.883 ETH (R = 4.207 ETH), the launch router
///   0.0635 ETH of tax (measured by `test_smoke_bonding`).
/// - **Closed**: eoa[2]'s exact-input buy of 3 × R limited at √P1 closed the curve in its own afterSwap (the rest
///   refunded; the PoolManager holds 4.252 ETH); nobody has called `graduate()`.
/// - **Graduated**: `graduate()` by the keeper 12 s before r0's time (every poke succeeded: `graduationPokeFailures`
///   0), so the graduation word is round r0 (required: a clock already past r0's request time reverts; requested, not
///   posted: tickets AwaitingWord); the reward (0.1% of R,
///   0.004207 ETH) is credited to the keeper, not claimed; the tax is not swept.
/// - **Drawing**: on the next 12-s blocks: r0 posted and the word accepted; draw A by eoa[3] (round r0 + 4), posted,
///   settled and opened by its drawer with its reveal (`itemA`); draw B by the contract drawer (round r0 + 8), posted
///   and settled, not opened (`itemB`; a contract drawer opens first for 30 days); placeholder 1 opened by eoa[0] with
///   its reveal (`itemP1`). Every committed round the drivers use is posted by `poster`; the queue is empty.
/// - **Silent**: one block later draw C by the EIP-7702 EOA fixes round r0 + 16, which has no committed signature:
///   drand is silent for it. The clock is 5 days and 1 s past that round's time: `startBackup` is allowed now (until 5
///   days 18 hours), nothing is started, the word is not ready, the head is not dead.
/// - **Terminal**: nobody started the backup; 7 days and 1 s after draw C's request `enterTerminal()` (by eoa[5]):
///   tickets Terminal, draw C cancellable, takes by number from 3 days on.
/// `_toSilentFromGraduation` is the other silent start (plan § 3.2 shard S3): graduated, r0 never posted, the clock 5
/// days and 1 s past r0's time; `_toTerminal` after it enters terminal mode on the graduation word.
abstract contract AuditPhases is AuditBox0World {
    enum AuditPhase {
        Created,
        Window,
        Bonding,
        Closed,
        Graduated,
        Drawing,
        Silent,
        Terminal
    }

    AuditPhase internal reached;
    /// @notice Set by `_toSilentFromGraduation`: the silent round is the graduation word's (key 0).
    bool internal silentFromGraduation;

    uint256 internal graduationReward;
    uint256 internal graduationPokeFailures;
    uint256 internal drawA;
    uint256 internal drawB;
    uint256 internal drawC;
    uint256 internal itemA;
    uint256 internal itemB;
    uint256 internal itemP1;
    /// @notice The round drand never answers (draw C's, or r0 after `_toSilentFromGraduation`).
    uint256 internal silentRound;

    function _toPhase(AuditPhase p) internal {
        if (p == AuditPhase.Window) _toWindow();
        else if (p == AuditPhase.Bonding) _toBonding();
        else if (p == AuditPhase.Closed) _toClosed();
        else if (p == AuditPhase.Graduated) _toGraduated();
        else if (p == AuditPhase.Drawing) _toDrawing();
        else if (p == AuditPhase.Silent) _toSilent();
        else if (p == AuditPhase.Terminal) _toTerminal();
    }

    function _toWindow() internal {
        if (reached >= AuditPhase.Window) return;
        _warpTo(hook.openAt() + 3 * SLOT);
        _windowBuy(eoa[0], 0.02 ether);
        _advance(1);
        _windowBuy(eoa[1], 0.05 ether);
        reached = AuditPhase.Window;
        _assertGhostLedger();
    }

    function _toBonding() internal {
        if (reached >= AuditPhase.Bonding) return;
        _toWindow();
        _warpTo(hook.windowEndsAt());
        _buy(eoa[0], 0.6 ether);
        _buy(eoa[1], 0.4 ether);
        _advance(1);
        _sell(eoa[0], token.balanceOf(eoa[0]) / 3);
        _buy(eoa[3], 0.3 ether);
        _buy(eoa[4], 0.2 ether);
        _buyExactOut(eoa[5], token.balanceOf(eoa[4]) / 2, 0.2 ether);
        _buy(address(contractDrawer), 0.3 ether);
        _buy(eoa7702, 0.3 ether);
        _advance(1);
        _take(eoa[0], 3);
        _take(eoa[1], 2);
        _advance(12);
        _collect(keeper, keeper);
        _advance(12);
        reached = AuditPhase.Bonding;
        _assertGhostLedger();
    }

    function _toClosed() internal {
        if (reached >= AuditPhase.Closed) return;
        _toBonding();
        _buyTo(eoa[2], 3 * raise, curve.sqrtPriceLowerX96);
        require(hook.closed(), "AuditPhases: the closing buy closed the curve");
        reached = AuditPhase.Closed;
        _assertGhostLedger();
    }

    function _toGraduated() internal {
        if (reached >= AuditPhase.Graduated) return;
        _toClosed();
        // A request now fixes r0, the first committed local round (the source takes the first round ≥ now + 12 s).
        _warpTo(_requestTimeFor(r0));
        (graduationReward, graduationPokeFailures) = _graduate(keeper);
        // The later phases rely on it (a clock already past r0's request time would fix a later round silently).
        (, uint64 wordRound) = src.requestOf(a.tickets, 0);
        require(wordRound == r0, "AuditPhases: the graduation word is round r0");
        reached = AuditPhase.Graduated;
        _assertGhostLedger();
    }

    function _toDrawing() internal {
        require(!silentFromGraduation, "AuditPhases: the graduation word's round was left silent");
        if (reached >= AuditPhase.Drawing) return;
        _toGraduated();
        _advance(1);
        _post(r0);
        vm.prank(keeper);
        tickets.acceptGraduationWord();
        drawA = _draw(eoa[3], AUDIT_DRAW_VALUE);
        _advance(1);
        _post(r0 + 4);
        _settle(keeper, 1);
        itemA = _openDraw(eoa[3], drawA, eoa[3], true);
        drawB = _draw(address(contractDrawer), AUDIT_DRAW_VALUE);
        _advance(1);
        _post(r0 + 8);
        _settle(keeper, 1);
        itemB = tickets.drawTicket(drawB).itemId;
        itemP1 = _open(eoa[0], 1, true);
        reached = AuditPhase.Drawing;
        _assertGhostLedger();
    }

    function _toSilent() internal {
        if (reached >= AuditPhase.Silent) return;
        _toDrawing();
        _advance(1);
        drawC = _draw(eoa7702, AUDIT_DRAW_VALUE);
        (, uint64 round) = src.requestOf(a.tickets, drawC);
        silentRound = round;
        require(!_committed(silentRound), "AuditPhases: the silent round has no committed signature");
        _warpTo(src.roundTime(silentRound) + src.BACKUP_AFTER() + 1);
        reached = AuditPhase.Silent;
        _assertGhostLedger();
    }

    /// @notice Graduated with drand silent from the start: r0 never posted, the clock where its backup may start.
    function _toSilentFromGraduation() internal {
        _toGraduated();
        require(reached == AuditPhase.Graduated, "AuditPhases: past graduation already");
        silentFromGraduation = true;
        silentRound = r0;
        _warpTo(src.roundTime(r0) + src.BACKUP_AFTER() + 1);
        reached = AuditPhase.Silent;
        _assertGhostLedger();
    }

    function _toTerminal() internal {
        if (reached >= AuditPhase.Terminal) return;
        _toSilent();
        uint256 requestedAt =
            silentFromGraduation ? uint256(tickets.status().wordRequestedAt) : tickets.drawTicket(drawC).requestedAt;
        _warpTo(requestedAt + tickets.SILENCE() + 1);
        vm.prank(eoa[5]);
        tickets.enterTerminal();
        reached = AuditPhase.Terminal;
        _assertGhostLedger();
    }
}
