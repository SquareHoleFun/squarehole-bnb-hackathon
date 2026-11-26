// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../src/box/BoxTickets.sol";
import {DrawStatus, TicketPhase} from "../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../src/box/interfaces/IBoxTickets.sol";
import {BoxBackedSource} from "../../../src/box/randomness/BoxBackedSource.sol";
import {CoreBox0BackupBase} from "./CoreBox0BackupBase.sol";
import {HeaderVectors} from "./HeaderVectors.sol";

/// @title CoreBox0BackupTest (F143)
/// @notice Box 0 on its BoxBackedSource, as factory v1 creates it: drand first, as before; the RANDAO backup by an
/// on-chain rule anyone can trigger from 5 days (F143 (2)) to 5 days 18 hours (the security review's F1) after an
/// unposted round's time, one target per round, the start proving a recent block's header; BoxTickets' fixed 7 days
/// decide, unchanged. Each check runs under the default
/// EVM (Osaka) and under Amsterdam (`CoreBox0BackupAmsterdamTest`).
/// The design study's prototype tests (backup-rng/rc7, `CoreBox0Backup.t.sol`) and the review's (`review/
/// BackupReview.t.sol`) are here, moved to the reviewed rule: the prototype's restart test is inverted into a guard
/// (`test_guard_noRestart_oneWordPerRound`), and the review's unprovable-header case is a guard too.
/// forge-config: default.evm_version = "osaka"
contract CoreBox0BackupTest is CoreBox0BackupBase {
    /// drand first: the normal path is unchanged; the word is the wrapper's domain-separated one.
    function test_drandFirst_graduationWordAsBefore() public {
        _graduate();
        vm.warp(src.roundTime(r0));
        drand.postRound(r0, _localSig(0));
        tickets.acceptGraduationWord();
        (bytes32 randomness,) = drand.beaconOf(r0);
        assertEq(tickets.graduationWord(), _word(src.DRAND_TAG(), randomness, 0));
        // A round that drand answered can never fall back.
        vm.warp(_startable(r0));
        bytes memory p = _parent();
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.RoundAlreadyPosted.selector, r0));
        src.startBackup(r0, block.number - 1, p);
    }

    /// drand silent: the backup saves the graduation word from day 5, by anyone, and terminal mode never opens.
    function test_backup_savesGraduationWord_noTerminal() public {
        uint256 requestedAt = _graduate();
        uint256 at = src.roundTime(r0) + 5 days;
        bytes memory p = _parent();
        vm.warp(src.roundTime(r0) + 3 days + 1); // the design study's 3 days are not enough (F143 (2))
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupTooEarly.selector, r0, at));
        src.startBackup(r0, block.number - 1, p);
        vm.warp(at);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupTooEarly.selector, r0, at));
        src.startBackup(r0, block.number - 1, p);
        vm.warp(at + 1);
        uint256 target = _start(r0, makeAddr("stranger"));
        // Not before its block exists, and only with that block's own header.
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.HeaderUnavailable.selector, target));
        src.fixBackup(r0, _header(target, bytes32(uint256(1))));
        _advance(src.TARGET_BLOCKS() + 1);
        bytes memory h = _mine(target, keccak256("the mix"));
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.WrongHeader.selector, target));
        src.fixBackup(r0, _header(target, keccak256("another mix")));
        assertEq(src.fixBackup(r0, h), keccak256("the mix"));
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupAlreadyFixed.selector, r0));
        src.fixBackup(r0, h);

        tickets.acceptGraduationWord();
        assertEq(tickets.graduationWord(), _word(src.BACKUP_TAG(), keccak256("the mix"), 0));
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Drawing));
        assertFalse(src.isSilent(a.tickets, 0));
        vm.warp(requestedAt + 60 days);
        vm.expectRevert(IBoxTickets.NothingPending.selector);
        tickets.enterTerminal();
    }

    /// Once the backup started, a late drand post is ignored for good: nobody can choose between the two words.
    function test_lateDrandPostAfterBackupStart_isIgnored() public {
        _graduate();
        vm.warp(_startable(r0));
        uint256 target = _start(r0, address(this));
        drand.postRound(r0, _localSig(0)); // drand comes back, or someone held the signature back
        (bytes32 w, uint64 readyAt) = src.wordOf(a.tickets, 0);
        assertEq(w, bytes32(0), "the drand word does not count after the start");
        assertEq(readyAt, 0);
        vm.expectRevert(IBoxTickets.WordNotReady.selector);
        tickets.acceptGraduationWord();
        _advance(src.TARGET_BLOCKS() + 1);
        src.fixBackup(r0, _mine(target, keccak256("mix")));
        tickets.acceptGraduationWord();
        assertEq(tickets.graduationWord(), _word(src.BACKUP_TAG(), keccak256("mix"), 0));
    }

    /// GUARD (the review's four-word finding, inverted): one target per round, never another. The prototype let the
    /// only fixer skip each target's public mix and restart after 8,191 blocks (four words inside the 7 days). Here a
    /// second start is refused at once, after the target's window and at every later block, and the round's only word
    /// is its first target's; a target nobody proves leaves the round silent (terminal mode at 7 days).
    function test_guard_noRestart_oneWordPerRound() public {
        uint256 requestedAt = _graduate();
        vm.warp(_startable(r0));
        uint256 target = _start(r0, makeAddr("sole.fixer"));
        uint256 reachable = 1;
        bytes memory p = _parent();
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupAlreadyStarted.selector, r0));
        src.startBackup(r0, block.number - 1, p);
        for (uint256 i; i < 4; ++i) {
            _advance(src.TARGET_BLOCKS() + src.HISTORY_WINDOW() + 1); // the old target's mix is public and gone
            p = _parent();
            (bool ok,) = address(src).call(abi.encodeCall(BoxBackedSource.startBackup, (r0, block.number - 1, p)));
            if (ok) ++reachable;
        }
        assertEq(reachable, 1, "one word per round: the sole fixer cannot pick among public mixes");
        (uint64 startedAt, uint64 targetBlock, uint64 fixedAt,) = src.backupOf(r0);
        assertEq(targetBlock, target, "the first target stays");
        assertGt(startedAt, 0);
        assertEq(fixedAt, 0);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.HeaderUnavailable.selector, target));
        src.fixBackup(r0, _header(target, bytes32(uint256(1))));
        assertGt(block.timestamp, requestedAt + 7 days);
        assertTrue(src.isSilent(a.tickets, 0), "silent, as a round nobody posts");
        tickets.enterTerminal(); // the price: one missed 27-hour proof window means terminal, as a missed post does
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal));
    }

    /// The proof also works through EIP-2935's history contract (older than BLOCKHASH's 256 blocks), its real code.
    function test_fixThroughTheHistoryContract() public {
        _graduate();
        vm.warp(_startable(r0));
        uint256 target = _start(r0, address(this));
        _advance(src.TARGET_BLOCKS() + 1000);
        assertEq(blockhash(target), bytes32(0), "past BLOCKHASH's reach");
        bytes memory h = _mine(target, keccak256("late mix"));
        src.fixBackup(r0, h);
        tickets.acceptGraduationWord();
        (,, uint64 fixedAt, bytes32 mix) = src.backupOf(r0);
        assertEq(mix, keccak256("late mix"));
        assertLe(fixedAt, tickets.status().wordRequestedAt + 7 days, "inside BoxTickets' 7-day window");
    }

    /// The platform Safe has no special way in: before the rule allows it, its call fails like anyone's.
    function test_platformSafe_hasNoPrivilege() public {
        _graduate();
        vm.warp(src.roundTime(r0) + 4 days);
        bytes memory p = _parent();
        vm.prank(BoxSpecV1.PLATFORM_SAFE_MAINNET);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupTooEarly.selector, r0, src.roundTime(r0) + 5 days));
        src.startBackup(r0, block.number - 1, p);
    }

    /// A draw head whose round drand never answers settles on the backup within its own 7 days.
    function test_backup_drawHeadSettles() public {
        _graduate();
        vm.warp(src.roundTime(r0));
        drand.postRound(r0, _localSig(0));
        tickets.acceptGraduationWord();
        vm.fee(0.5 gwei); // the draw pays DRAND_BOUNTY_GAS x the base fee into the round's pot
        (uint256 ticketId, uint256 requestedAt) = _drawOn(3, "drawer.one");
        assertEq(address(src).balance, 0, "no ETH stays in the backed source");
        assertEq(drand.bountyOf(r0 + 3), 600_000 * 0.5 gwei, "the draw's bounty is in DrandSource's pot");
        assertEq(src.bountyOf(r0 + 3), drand.bountyOf(r0 + 3), "read through the wrapper");
        vm.warp(_startable(r0 + 3));
        _backup(r0 + 3, keccak256("draw mix"), makeAddr("keeper"));
        assertEq(tickets.settle(8), 1);
        assertEq(uint8(tickets.drawTicket(ticketId).status), uint8(DrawStatus.Settled));
        vm.warp(requestedAt + 30 days);
        vm.expectRevert(IBoxTickets.NothingPending.selector);
        tickets.enterTerminal();
    }

    /// Two real headers (mainnet and Sepolia, 2026-10-20): field 13 is the block's mixHash (prevRandao).
    function test_realHeaders_prevRandaoParsed() public {
        _graduate();
        vm.warp(_startable(r0));
        uint256 target = _start(r0, address(this));
        _advance(src.TARGET_BLOCKS() + 1);
        assertEq(keccak256(HeaderVectors.MAINNET), HeaderVectors.MAINNET_HASH);
        vm.setBlockhash(target, HeaderVectors.MAINNET_HASH);
        assertEq(src.fixBackup(r0, HeaderVectors.MAINNET), HeaderVectors.MAINNET_MIX, "mainnet");

        tickets.acceptGraduationWord();
        _drawOn(3, "drawer.s");
        vm.warp(_startable(r0 + 3));
        target = _start(r0 + 3, address(this));
        _advance(src.TARGET_BLOCKS() + 1);
        assertEq(keccak256(HeaderVectors.SEPOLIA), HeaderVectors.SEPOLIA_HASH);
        vm.setBlockhash(target, HeaderVectors.SEPOLIA_HASH);
        assertEq(src.fixBackup(r0 + 3, HeaderVectors.SEPOLIA), HeaderVectors.SEPOLIA_MIX, "sepolia");
    }

    /// GUARD (the design review's header-format finding): once headers stop being keccak(RLP) (an SSZ fork already
    /// active), the start itself fails, so it cannot turn a live drand round into a dead one; a drand post on day 6
    /// still saves it. (A fork still ahead is the residual in BackupReviewLight.t.sol, F2.)
    function test_guard_unprovableHeader_startRefused_drandStillSaves() public {
        _graduate();
        vm.warp(_startable(r0));
        vm.setBlockhash(block.number - 1, keccak256("an ssz root, no RLP preimage"));
        vm.prank(makeAddr("griefer"));
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.WrongHeader.selector, block.number - 1));
        src.startBackup(r0, block.number - 1, HeaderVectors.MAINNET);
        vm.warp(src.roundTime(r0) + 6 days);
        drand.postRound(r0, _localSig(0));
        tickets.acceptGraduationWord();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Drawing));
    }

    /// A parent "header" that hashes right but is not one (a list among the first 13 fields, a short or empty input,
    /// a short list) is refused.
    function test_guard_startRefusesNonHeaders() public {
        _graduate();
        vm.warp(_startable(r0));
        bytes[4] memory junk;
        junk[0] = bytes.concat(hex"f90104c0c0c0", new bytes(0x104 - 3));
        junk[1] = hex"";
        junk[2] = hex"c0";
        junk[3] = bytes.concat(hex"f838", new bytes(0x38));
        for (uint256 i; i < junk.length; ++i) {
            vm.setBlockhash(block.number - 1, keccak256(junk[i]));
            vm.expectRevert(BoxBackedSource.BadHeader.selector);
            src.startBackup(r0, block.number - 1, junk[i]);
        }
        (uint64 startedAt,,,) = src.backupOf(r0);
        assertEq(startedAt, 0, "nothing started");
    }

    /// A timely backup word cannot be starved by the caller's gas (the never-stuck test, on the wrapper).
    function test_timelyBackupWord_cannotBeStarved() public {
        uint256 requestedAt = _graduate();
        vm.warp(_startable(r0));
        _backup(r0, keccak256("m"), address(this));
        vm.warp(requestedAt + 8 days);
        bytes memory headNotDead = abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, 0, requestedAt + 7 days);
        uint256 firstRead;
        for (uint256 g = 40_000; g <= 200_000; g += 100) {
            vm.cool(address(src));
            vm.cool(address(drand));
            vm.cool(a.tickets);
            vm.cool(a.vault);
            (bool ok, bytes memory ret) = a.tickets.call{gas: g}(abi.encodeCall(BoxTickets.enterTerminal, ()));
            assertFalse(ok, "enterTerminal must never pass on a timely word");
            if (firstRead == 0 && keccak256(ret) == keccak256(headNotDead)) firstRead = g;
        }
        assertGt(firstRead, 0);
        emit log_named_uint("first gas limit that reads the word", firstRead);
    }
}

/// The same under Amsterdam (Glamsterdam's repricing).
/// forge-config: default.evm_version = "amsterdam"
contract CoreBox0BackupAmsterdamTest is CoreBox0BackupTest {}
