// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {DrawStatus, ItemReveal, TicketPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {AuditU6ClaudeBase} from "./AuditU6ClaudeBase.sol";

/// @notice U6 lens L5 (gas, liveness and bounded cost) on the factory's box 0: P6.12 (never stuck: with drand silent,
/// backup or not, every draw is settled, opened or cancellable within 7 days of its request plus a bounded number of
/// public calls; a dead head holds the queue only until terminal entry; `BoxTickets.sol:42-44, 224-236, 329-340`;
/// F61 R4 as amended by F143) and P6.13 (settle(k) linear in k, draw and openDraw gas bounded and measured, BoxTickets
/// at least 1,000 bytes under EIP-170: BC-069). Gas is measured from cold state (`vm.cool`) on Osaka and Amsterdam.
/// forge-config: default.evm_version = "osaka"
contract AuditU6ClaudeLivenessTest is AuditU6ClaudeBase {
    /// BC-069: the tickets implementation's runtime keeps at least 1,000 bytes of EIP-170 margin.
    function testProperty_AUDIT_U6_codeSizeMargin() public {
        uint256 size = kit.impls().tickets.code.length;
        emit log_named_uint("BoxTickets runtime bytes", size);
        emit log_named_uint("EIP-170 margin", 24_576 - size);
        assertLe(size + 1_000, 24_576, "at least 1,000 bytes below EIP-170");
    }

    /// P6.13: settle(k) for k = 1 … 12 heads of one round, each from the same cold state: the cost is linear in k
    /// (every increment within 40,000 gas of the mean slope), the slope and base pinned per fork.
    function testProperty_AUDIT_U6_settleGasLinearInK() public {
        _toWordAccepted();
        address[6] memory who = [eoa[3], eoa[4], eoa[5], eoa7702, eoa[0], eoa[1]];
        for (uint256 i; i < 12; ++i) {
            _draw(who[i % 6], AUDIT_DRAW_VALUE);
        }
        _advance(1);
        _post(r0 + 4);
        uint256[13] memory g;
        for (uint256 k = 1; k <= 12; ++k) {
            uint256 snap = vm.snapshotState();
            _coolAll();
            uint256 g0 = gasleft();
            tickets.settle(k);
            g[k] = g0 - gasleft();
            vm.revertToState(snap);
        }
        uint256 slope = (g[12] - g[1]) / 11;
        uint256 maxDev;
        for (uint256 k = 2; k <= 12; ++k) {
            uint256 d = g[k] - g[k - 1];
            uint256 dev = d > slope ? d - slope : slope - d;
            if (dev > maxDev) maxDev = dev;
        }
        emit log_named_string("evm", vm.getEvmVersion());
        emit log_named_uint("settle(1) gas, cold", g[1]);
        emit log_named_uint("settle(12) gas, cold", g[12]);
        emit log_named_uint("slope per settled draw", slope);
        emit log_named_uint("largest deviation of one step from the slope", maxDev);
        assertLt(maxDev, 40_000, "linear in k");
        if (_isAmsterdam()) {
            assertLt(slope, 250_000, "amsterdam: per-draw settle cost");
            assertLt(g[1], 450_000, "amsterdam: settle(1)");
        } else {
            assertLt(slope, 90_000, "osaka: per-draw settle cost");
            assertLt(g[1], 160_000, "osaka: settle(1)");
        }
        // 12 settles fit far inside a 30M-gas block on both forks
        assertLt(g[12], 3_500_000);
    }

    /// P6.13: `draw` from cold state: the first of a round (pays the pot), a later one of the same round, and one that
    /// also requests the graduation word (graduation's poke failed); every case bounded and pinned per fork.
    function testProperty_AUDIT_U6_drawGasBounded() public {
        _toWordAccepted();
        uint256 deadline = vm.getBlockTimestamp();
        _approveT(eoa[3], a.tickets);
        _approveT(eoa[4], a.tickets);
        vm.deal(eoa[3], 1 ether);
        vm.deal(eoa[4], 1 ether);
        _coolAll();
        uint256 g0 = gasleft();
        vm.prank(eoa[3]);
        tickets.draw{value: AUDIT_DRAW_VALUE}(type(uint256).max, deadline);
        uint256 first = g0 - gasleft();
        _coolAll();
        g0 = gasleft();
        vm.prank(eoa[4]);
        tickets.draw{value: AUDIT_DRAW_VALUE}(type(uint256).max, deadline);
        uint256 later = g0 - gasleft();
        emit log_named_string("evm", vm.getEvmVersion());
        emit log_named_uint("draw gas, first of a round", first);
        emit log_named_uint("draw gas, later in the round", later);
        if (_isAmsterdam()) {
            assertLt(first, 1_100_000, "amsterdam: first draw");
            assertLt(later, 950_000, "amsterdam: later draw");
        } else {
            assertLt(first, 500_000, "osaka: first draw");
            assertLt(later, 450_000, "osaka: later draw");
        }
        assertLt(later, first, "a later draw writes no pot");
    }

    /// P6.13: `openDraw` from cold state: a settled draw with its reveal (proof depth 11 at N 1,969), and one that
    /// first settles five earlier draws; the settling part costs settle's slope per draw.
    function testProperty_AUDIT_U6_openDrawGasBounded() public {
        _toWordAccepted();
        uint256[6] memory ids;
        address[6] memory who = [eoa[3], eoa[4], eoa[5], eoa7702, eoa[0], eoa[1]];
        for (uint256 i; i < 6; ++i) {
            ids[i] = _draw(who[i], AUDIT_DRAW_VALUE);
        }
        _advance(1);
        _post(r0 + 4);
        uint256[] memory want = _replayItems(6);
        uint256 snap = vm.snapshotState();
        // the last ticket, settling the five before it
        ItemReveal memory r6 = _reveal(want[6]);
        _coolAll();
        uint256 g0 = gasleft();
        vm.prank(eoa[1]);
        tickets.openDraw(ids[5], eoa[1], r6);
        uint256 withSettles = g0 - gasleft();
        vm.revertToState(snap);
        // the same ticket once everything is settled
        tickets.settle(6);
        _coolAll();
        g0 = gasleft();
        vm.prank(eoa[1]);
        tickets.openDraw(ids[5], eoa[1], r6);
        uint256 settled = g0 - gasleft();
        emit log_named_string("evm", vm.getEvmVersion());
        emit log_named_uint("openDraw gas, settled, with its reveal", settled);
        emit log_named_uint("openDraw gas, settling 6 first", withSettles);
        if (_isAmsterdam()) {
            assertLt(settled, 1_500_000, "amsterdam: openDraw");
        } else {
            assertLt(settled, 650_000, "osaka: openDraw");
        }
        assertGt(withSettles, settled);
        assertEq(collection.ownerOf(want[6]), eoa[1]);
    }

    /// P6.12 without a backup: drand silent for draw C's round. Until 7 days after C's request the head is not dead
    /// (draws still accepted, terminal refused); one second later new draws are refused (QueueDead) until anyone enters
    /// terminal mode (one call), then C is cancellable (one call), and takes by number start 3 days later.
    function testProperty_AUDIT_U6_neverStuckDrandSilentNoBackup() public {
        _toSilent();
        uint256 deadline = tickets.drawTicket(drawC).requestedAt + tickets.SILENCE();
        _warpTo(deadline);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, drawC, deadline));
        tickets.enterTerminal();
        uint256 late = _draw(eoa[4], AUDIT_DRAW_VALUE);
        assertEq(uint8(tickets.drawTicket(late).status), uint8(DrawStatus.Requested), "accepted at the deadline");
        _warpTo(deadline + 1);
        _approveT(eoa[5], a.tickets);
        vm.deal(eoa[5], AUDIT_DRAW_VALUE);
        uint256 t = vm.getBlockTimestamp();
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.QueueDead.selector, drawC, deadline));
        tickets.draw{value: AUDIT_DRAW_VALUE}(type(uint256).max, t);
        vm.prank(eoa[2]);
        tickets.enterTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal));
        assertGt(_cancelDraw(eoa[2], drawC), 0, "C cancellable at once");
        assertGt(_cancelDraw(eoa[2], late), 0, "and the draw behind it");
        _assertSlotsAndTickets();
        _assertTicketsHoldNothing();
        _assertGhostLedger();
    }

    /// P6.12 with the backup: drand silent, the backup started 5 days and 1 second after the round (the first moment),
    /// fixed 257 blocks later: C settles and opens about 5 days after its request (three public calls).
    function testProperty_AUDIT_U6_neverStuckWithTheBackup() public {
        _toSilent();
        uint256 requestedAt = tickets.drawTicket(drawC).requestedAt;
        _backup(silentRound, MIX, eoa[5]);
        assertLt(vm.getBlockTimestamp(), requestedAt + 6 days);
        uint256 item = _replayItems(drawC)[drawC];
        ItemReveal memory r = _reveal(item);
        vm.prank(eoa[2]);
        tickets.openDraw(drawC, eoa[2], r);
        assertEq(collection.ownerOf(item), eoa7702, "settled and opened, to its drawer");
        _assertGhostLedger();
    }

    /// P6.12 at the backup's latest start (5 days 18 hours after the round): still fixed and settled inside the 7 days;
    /// one second later the start is refused and only terminal mode remains.
    function testProperty_AUDIT_U6_neverStuckAtTheLatestStart() public {
        _toSilent();
        uint256 requestedAt = tickets.drawTicket(drawC).requestedAt;
        uint256 latest = src.roundTime(silentRound) + src.LATEST_START();
        uint256 snap = vm.snapshotState();
        _warpTo(latest + 1);
        bytes memory h = _parentHeader();
        uint256 parent = vm.getBlockNumber() - 1;
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupTooLate.selector, silentRound, latest));
        src.startBackup(silentRound, parent, h);
        vm.revertToState(snap);
        _warpTo(latest);
        _startBackup(silentRound, eoa[5]);
        _advance(src.TARGET_BLOCKS() + 1);
        _fixBackup(silentRound, MIX, poster);
        assertLt(vm.getBlockTimestamp(), requestedAt + 7 days, "fixed inside the 7 days");
        assertEq(_settle(keeper, 1), 1);
    }

    /// P6.12 with a queue: three draws on three silent rounds; backups for the first and the third only. The first
    /// settles; the second is the dead head 7 days after its request; one call enters terminal mode and both remaining
    /// draws are cancellable then, inside the third's own 7 days (its timely word cannot jump the queue).
    function testProperty_AUDIT_U6_neverStuckQueueOfSilentRounds() public {
        _toDrawing();
        uint256[3] memory ids;
        uint256[3] memory rounds;
        address[3] memory who = [eoa[3], eoa[4], eoa[5]];
        for (uint256 i; i < 3; ++i) {
            _advance(1);
            ids[i] = _draw(who[i], AUDIT_DRAW_VALUE);
            (, uint64 r) = src.requestOf(a.tickets, ids[i]);
            rounds[i] = r;
            assertFalse(_committed(r), "silent rounds");
        }
        _warpTo(src.roundTime(rounds[2]) + src.BACKUP_AFTER() + 1);
        _startBackup(rounds[0], eoa[6]);
        _startBackup(rounds[2], eoa[6]);
        _advance(src.TARGET_BLOCKS() + 1);
        _fixBackup(rounds[0], keccak256("u6.m0"), poster);
        _fixBackup(rounds[2], keccak256("u6.m2"), poster);
        assertEq(_settle(keeper, 3), 1, "only the first: the second has no word");
        uint256 deadline1 = tickets.drawTicket(ids[1]).requestedAt + tickets.SILENCE();
        uint256 deadline2 = tickets.drawTicket(ids[2]).requestedAt + tickets.SILENCE();
        _warpTo(deadline1 + 1);
        assertLe(vm.getBlockTimestamp(), deadline2, "still inside the third's own 7 days");
        tickets.enterTerminal();
        assertGt(_cancelDraw(eoa[7], ids[1]), 0);
        assertGt(_cancelDraw(eoa[7], ids[2]), 0, "the third's timely word never jumps the queue");
        uint256 item0 = tickets.drawTicket(ids[0]).itemId;
        _openDraw(eoa[3], ids[0], eoa[3], true);
        assertEq(collection.ownerOf(item0), eoa[3], "the settled draw opens in terminal mode");
        _assertSlotsAndTickets();
        _assertGhostLedger();
    }

    function _coolAll() internal {
        vm.cool(address(src));
        vm.cool(address(drand));
        vm.cool(a.tickets);
        vm.cool(a.vault);
        vm.cool(a.collection);
        vm.cool(a.itemStream);
        vm.cool(a.token);
    }

    function _isAmsterdam() internal view returns (bool) {
        return keccak256(bytes(vm.getEvmVersion())) == keccak256("amsterdam");
    }
}

/// The same under Amsterdam (Glamsterdam's repricing).
/// forge-config: default.evm_version = "amsterdam"
contract AuditU6ClaudeLivenessAmsterdamTest is AuditU6ClaudeLivenessTest {}
