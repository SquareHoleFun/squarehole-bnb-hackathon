// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TicketPhase} from "../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../src/box/interfaces/IBoxTickets.sol";
import {BoxBackedSource} from "../../../src/box/randomness/BoxBackedSource.sol";
import {CoreBox0BackupBase} from "./CoreBox0BackupBase.sol";

/// @title BackupReviewBox0Test (the security review of sh-box0-backup-source at bdb9a07da, on box 0)
/// @notice Box 0 as factory v1 creates it (CoreBox0Kit). F1 inverted into guards: a start 40 minutes before the
/// consumers' deadline, which before the review made a timely drand post worthless and put box 0 into terminal mode,
/// is refused (`BackupTooLate`), and the timely post saves the graduation word and a draw head. F2's residual (a start
/// just before a header-format fork) is pinned as documented.
/// forge-config: default.evm_version = "osaka"
contract BackupReviewBox0Test is CoreBox0BackupBase {
    /// GUARD (F1) on box 0's graduation word: drand is alive, nobody posted it for almost 7 days. A start 40 minutes
    /// before the deadline is refused, by anyone; the post 30 minutes before the deadline saves the box, as on rc7.
    function test_guard_box0_lateStartRefused_timelyDrandPostSaves() public {
        uint256 requestedAt = _graduate();
        uint256 deadline = requestedAt + 7 days;
        vm.warp(deadline - 40 minutes);
        bytes memory p = _parent();
        vm.prank(makeAddr("late.starter"));
        vm.expectRevert(
            abi.encodeWithSelector(BoxBackedSource.BackupTooLate.selector, r0, src.roundTime(r0) + src.LATEST_START())
        );
        src.startBackup(r0, block.number - 1, p);
        _advance(50);
        assertLt(block.timestamp, deadline);
        drand.postRound(r0, _localSig(0));
        tickets.acceptGraduationWord();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Drawing), "the timely post saves box 0");
    }

    /// GUARD (F1) on a draw head: the late start is refused, and the timely post the drawer's bounty pays settles it.
    function test_guard_box0_drawHead_lateStartRefused() public {
        _graduate();
        vm.warp(src.roundTime(r0));
        drand.postRound(r0, _localSig(0));
        tickets.acceptGraduationWord();
        vm.fee(0.5 gwei);
        (uint256 ticketId, uint256 requestedAt) = _drawOn(3, "review.drawer");
        uint256 deadline = requestedAt + 7 days;
        vm.warp(deadline - 40 minutes);
        bytes memory p = _parent();
        vm.expectRevert(
            abi.encodeWithSelector(
                BoxBackedSource.BackupTooLate.selector, r0 + 3, src.roundTime(r0 + 3) + src.LATEST_START()
            )
        );
        src.startBackup(r0 + 3, block.number - 1, p);
        _advance(50);
        address poster = makeAddr("review.poster");
        vm.prank(poster);
        drand.postRound(r0 + 3, _localSig(3));
        assertEq(drand.owedTo(poster), 600_000 * 0.5 gwei, "the drawer's bounty pays the post that counts");
        assertEq(tickets.settle(1), 1, "the head settles");
        assertGt(ticketId, 0);
        vm.warp(requestedAt + 30 days);
        vm.expectRevert(IBoxTickets.NothingPending.selector);
        tickets.enterTerminal();
    }

    /// RESIDUAL (F2) on box 0: a start whose header is RLP but whose target lies after a header-format fork; drand
    /// posts on day 6 and box 0 still enters terminal mode on day 7. Documented (S7's fork watch keeps box 0's rounds
    /// posted before day 5 when such a fork is scheduled); no on-chain fix without a restart.
    function test_residual_box0_startBeforeAFormatFork_terminal() public {
        uint256 requestedAt = _graduate();
        vm.warp(_startable(r0));
        uint256 target = _start(r0, makeAddr("starter"));
        _advance(257);
        vm.setBlockhash(target, keccak256("an ssz root, no RLP preimage"));
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.WrongHeader.selector, target));
        src.fixBackup(r0, _header(target, keccak256("mix")));
        vm.warp(src.roundTime(r0) + 6 days);
        drand.postRound(r0, _localSig(0));
        vm.expectRevert(IBoxTickets.WordNotReady.selector);
        tickets.acceptGraduationWord();
        vm.warp(requestedAt + 7 days + 1);
        tickets.enterTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal));
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract BackupReviewBox0AmsterdamTest is BackupReviewBox0Test {}
