// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {TicketPhase} from "../../../src/box/interfaces/BoxTypes.sol";
import {BoxBackedSource} from "../../../src/box/randomness/BoxBackedSource.sol";
import {CoreBox0BackupBase} from "./CoreBox0BackupBase.sol";

/// @title BackupTimelineTest (F143 (2) and the security review's F1: the worst-case timeline)
/// @notice Every allowed start, the target 256 blocks ahead and the fix at the last block EIP-2935 still serves
/// complete inside BoxTickets' fixed 7 days. The worst case is the latest start the rule allows (`LATEST_START`,
/// 5 days 18 hours after the round's time): graduation's request 12 s before its round (the MARGIN rule allows up to
/// 15 s), 12-second blocks, and the fix at target + 8,191, read through EIP-2935's real code. Pinned: the fix lands at
/// request + 6 days 22 h 9 min 36 s at the latest (101,364 s of blocks after the start), 1 h 50 min 24 s before the
/// 7 days end (1 h 50 min 21 s with the 15-second gap); one block later the target is gone, and one second after the
/// latest start a start is refused. The spare allows an average block time up to 12.78 s (12 whole seconds) over those
/// 8,447 blocks (missed slots). The earliest start (5 days + 1 s) keeps its 19 h 50 min 23 s.
/// forge-config: default.evm_version = "osaka"
contract BackupTimelineTest is CoreBox0BackupBase {
    function _constants() internal view {
        assertEq(tickets.SILENCE(), 7 days, "BoxTickets' fixed window");
        assertEq(src.SILENCE(), 7 days);
        assertEq(src.BACKUP_AFTER(), BoxSpecV1.BACKUP_AFTER_SECONDS, "5 days, the spec's");
        assertEq(src.LATEST_START(), BoxSpecV1.BACKUP_LATEST_START_SECONDS, "5 days 18 hours, the spec's");
        assertEq(src.LATEST_START(), 5 days + 18 hours);
        assertEq(src.TARGET_BLOCKS(), BoxSpecV1.BACKUP_TARGET_BLOCKS, "256 blocks, the spec's");
    }

    function test_worstCase_latestStart_lastFixStillInsideSevenDays() public {
        uint256 requestedAt = _graduate();
        uint256 deadline = requestedAt + 7 days;
        _constants();
        uint256 until = src.roundTime(r0) + src.LATEST_START();
        uint256 snap0 = vm.snapshotState();
        // One second after the latest start, the rule refuses it.
        vm.warp(until + 1);
        bytes memory p = _parent();
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupTooLate.selector, r0, until));
        src.startBackup(r0, block.number - 1, p);
        vm.revertToState(snap0);
        vm.warp(until);
        uint256 startedAt = block.timestamp;
        uint256 target = _start(r0, makeAddr("starter"));
        _advance(src.TARGET_BLOCKS() + src.HISTORY_WINDOW()); // block.number = target + 8,191
        bytes memory h = _mine(target, keccak256("the last provable mix"));
        uint256 snap = vm.snapshotState();
        src.fixBackup(r0, h);
        (,, uint64 fixedAt,) = src.backupOf(r0);
        assertEq(fixedAt - startedAt, (256 + 8191) * 12, "8,447 blocks of 12 s after the start");
        assertEq(fixedAt - requestedAt, 12 + 5 days + 18 hours + 101_364, "6 d 22 h 9 min 36 s after the request");
        assertLe(fixedAt, deadline, "inside BoxTickets' 7 days");
        assertEq(deadline - fixedAt, 6624, "1 h 50 min 24 s to spare");
        tickets.acceptGraduationWord();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Drawing), "the word counts");
        // The worst request-to-round gap (15 s) still leaves the spare above 1 h 50 min.
        assertGe(deadline - fixedAt - 3, 1 hours + 50 minutes);
        // Average block time the spare allows over the 8,447 blocks: (7 d - 5 d 18 h - 15 s) / 8,447.
        assertEq(
            uint256(7 days - (5 days + 18 hours) - 15) / (256 + 8191), uint256(12), "up to 12 s a block on average"
        );
        assertGt(uint256(7 days - (5 days + 18 hours) - 15) * 100 / (256 + 8191), uint256(1277), "12.78 s");
        vm.revertToState(snap);
        // One block later EIP-2935 no longer serves the target: the round stays without a word.
        _advance(1);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.HeaderUnavailable.selector, target));
        src.fixBackup(r0, h);
    }

    function test_earliestStart_lastFixStillInsideSevenDays() public {
        uint256 requestedAt = _graduate();
        uint256 deadline = requestedAt + 7 days;
        _constants();
        vm.warp(_startable(r0));
        uint256 startedAt = block.timestamp;
        uint256 target = _start(r0, makeAddr("starter"));
        _advance(src.TARGET_BLOCKS() + src.HISTORY_WINDOW());
        src.fixBackup(r0, _mine(target, keccak256("the last provable mix")));
        (,, uint64 fixedAt,) = src.backupOf(r0);
        assertEq(fixedAt - startedAt, (256 + 8191) * 12);
        assertEq(fixedAt - requestedAt, 12 + 5 days + 1 + 101_364, "6 d 4 h 9 min 37 s after the request");
        assertEq(deadline - fixedAt, 71_423, "19 h 50 min 23 s to spare");
        tickets.acceptGraduationWord();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Drawing));
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract BackupTimelineAmsterdamTest is BackupTimelineTest {}
