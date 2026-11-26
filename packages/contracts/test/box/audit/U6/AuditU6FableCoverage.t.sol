// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditU6FableChecks} from "./AuditU6FableChecks.sol";

/// Coverage of the campaign's handler: a seeded pseudo-random walk over the same actions must reach every action at
/// least once (the fuzzer then samples the same handler; a run's counters reset with its snapshot, so the campaign's
/// own logs show only its last run).
abstract contract AuditU6FableWalk is AuditU6FableChecks {
    uint256 internal constant STEPS = 400;

    function _logCoverage() internal {
        emit log_named_uint("steps", STEPS);
        emit log_named_uint("takes", okTakes);
        emit log_named_uint("hand-backs", okHandBacks);
        emit log_named_uint("transfers", okTransfers);
        emit log_named_uint("operator moves", okOperatorMoves);
        emit log_named_uint("close", okClose);
        emit log_named_uint("graduate", okGraduate);
        emit log_named_uint("request word", okRequestWord);
        emit log_named_uint("accept word", okAcceptWord);
        emit log_named_uint("draws", okDraws);
        emit log_named_uint("refused draws", refusedDraws);
        emit log_named_uint("  QueueDead", refusedQueueDead);
        emit log_named_uint("  TerminalMode", refusedTerminal);
        emit log_named_uint("  BountyTooLow", refusedBounty);
        emit log_named_uint("  other", refusedOther);
        emit log_named_uint("settles", okSettles);
        emit log_named_uint("settled draws", settledDraws);
        emit log_named_uint("opens", okOpens);
        emit log_named_uint("draw opens", okOpenDraws);
        emit log_named_uint("posts", okPosts);
        emit log_named_uint("backup starts", okStarts);
        emit log_named_uint("backup fixes", okFixes);
        emit log_named_uint("terminal", okTerminal);
        emit log_named_uint("cancels", okCancels);
        emit log_named_uint("takes by number", okTakesByNumber);
        emit log_named_uint("bounties", okBounties);
        emit log_named_uint("withdrawals", okWithdrawals);
        emit log_named_uint("buys", okBuys);
        emit log_named_uint("warps", warps);
        assertEq(badTerminal + badDrawGate + badOperatorMove + doubleDelivery + settledOutOfOrder, 0, "ghosts");
        this.check_AUDIT_U6_all();
    }

    /// @dev The actions in a fixed order of kinds (every selector of the campaign), arguments from the seed.
    function _walk(bytes32 seed) internal {
        for (uint256 i; i < STEPS; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 kind = r % 23;
            uint256 x = r >> 8;
            uint256 y = r >> 64;
            uint256 z = r >> 128;
            if (kind == 0) this.act_take(x, y);
            else if (kind == 1) this.act_handBack(x, y);
            else if (kind == 2) this.act_transfer(x, y, z, z % 2 == 0);
            else if (kind == 3) this.act_approve(x, y, z, z % 2 == 0);
            else if (kind == 4) this.act_operatorMove(x, y, z);
            else if (kind == 5) this.act_close();
            else if (kind == 6) this.act_graduate(z % 2 == 0);
            else if (kind == 7) this.act_requestWord(x, y);
            else if (kind == 8) this.act_acceptWord(x);
            else if (kind == 9) this.act_draw(x, y);
            else if (kind == 10) this.act_settle(x, y);
            else if (kind == 11) this.act_open(x, y, z % 2 == 0);
            else if (kind == 12) this.act_openDraw(x, y, z, z % 3 != 0);
            else if (kind == 13) this.act_enterTerminal(x);
            else if (kind == 14) this.act_cancel(x, y);
            else if (kind == 15) this.act_takeByNumber(x, y, z % 2 == 0);
            else if (kind == 16) this.act_post(x);
            else if (kind == 17) this.act_startBackup(x, y);
            else if (kind == 18) this.act_fixBackup(x, y, z);
            else if (kind == 19) this.act_addBounty(x, y, z, z % 2 == 0);
            else if (kind == 20) this.act_withdrawBounty(x, y);
            else if (kind == 21) this.act_buyT(x, y);
            else this.act_warp(x);
            this.check_AUDIT_U6_all();
        }
    }
}

/// The walk from graduation: draws, posts, backups, settles, opens, terminal mode, cancels, takes by number.
/// forge-config: default.evm_version = "osaka"
contract AuditU6FableCoverageTest is AuditU6FableWalk {
    function _startPhase() internal override {
        _toGraduated();
    }

    function testProperty_AUDIT_U6_handlerReachesEveryAction() public {
        _walk(keccak256("audit.u6.fable coverage"));
        _logCoverage();
        assertGe(okAcceptWord, 1, "accept word");
        assertGe(okDraws, 8, "draws");
        assertGe(okSettles, 3, "settles");
        assertGe(settledDraws, 4, "settled draws");
        assertGe(okOpens, 1, "opens");
        assertGe(okOpenDraws, 2, "draw opens");
        assertGe(okPosts, 1, "posts");
        assertGe(okStarts, 1, "backup starts");
        assertGe(okFixes, 1, "backup fixes");
        assertGe(okTerminal, 1, "terminal");
        assertGe(okCancels, 1, "cancels");
        assertGe(okTakesByNumber, 1, "takes by number");
        assertGe(okTransfers, 1, "transfers");
        assertGe(okBounties, 1, "bounties");
        assertGe(okBuys, 1, "buys");
    }
}

/// The walk from the curve: takes, hand-backs, transfers, operator moves per the era rule, the close, graduation, the
/// word and the first draws.
/// forge-config: default.evm_version = "osaka"
contract AuditU6FableCurveCoverageTest is AuditU6FableWalk {
    function _startPhase() internal override {
        _toBonding();
    }

    function testProperty_AUDIT_U6_curveHandlerReachesEveryAction() public {
        _walk(keccak256("audit.u6.fable curve coverage"));
        _logCoverage();
        assertGe(okTakes, 2, "takes");
        assertGe(okHandBacks, 1, "hand-backs");
        assertGe(okTransfers, 1, "transfers");
        assertGe(okOperatorMoves, 1, "operator moves");
        assertGe(okClose, 1, "close");
        assertGe(okGraduate, 1, "graduate");
        assertGe(okAcceptWord + okRequestWord, 1, "the word");
        assertGe(okDraws, 1, "draws");
        assertGe(okWithdrawals, 1, "withdrawals");
    }
}
