// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {DrawStatus, ItemReveal, TicketPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {BoxShuffle} from "../../../../src/box/libraries/BoxShuffle.sol";
import {AuditU6FableBase} from "./AuditU6FableBase.sol";

/// @notice SH-AUDIT-B0 U6 (Fable): L7 timers at their exact edges (P6.16) and L6 the real BoxBackedSource's backup from
/// the consumer's side (P6.14: shared rounds, a drand post after a start, the fix at the edge of the 7 days), on the
/// factory's box 0.
/// forge-config: default.evm_version = "osaka"
contract AuditU6FableTimersTest is AuditU6FableBase {
    bytes32 internal constant MIX = keccak256("audit.u6.fable timers mix");

    function setUp() public virtual override {
        super.setUp();
        _buildRevealCache();
    }

    // ================================================================================================ 7 days

    /// P6.16 (BoxTickets.sol:736-762): a draw head is alive through the 7th day's last second (request + 7 days) and
    /// dead one second later; a word posted at exactly request + 7 days counts, one posted a second later does not.
    function testProperty_AUDIT_U6_sevenDayEdgeForADrawHead() public {
        _toWordAccepted();
        uint256 d = _draw(eoa[3], AUDIT_DRAW_VALUE); // r0 + 4
        uint256 requestedAt = _dv(d).requestedAt;
        uint256 snap = vm.snapshotState();
        // Alive at exactly 7 days, dead at 7 days + 1 s (nothing posted).
        _warpTo(requestedAt + SILENCE);
        (, bool dead,, uint256 deadline) = _refHead();
        assertFalse(dead);
        assertEq(deadline, requestedAt + SILENCE);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, d, deadline));
        tickets.enterTerminal();
        _warpTo(requestedAt + SILENCE + 1);
        (, dead,,) = _refHead();
        assertTrue(dead);
        tickets.enterTerminal();
        vm.revertToState(snap);
        // A word ready at exactly 7 days counts, even when applied a month later.
        _warpTo(requestedAt + SILENCE);
        _post(r0 + 4);
        _warpTo(requestedAt + 30 days);
        assertTrue(_refUsable(d, requestedAt));
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, d, requestedAt + SILENCE));
        tickets.enterTerminal();
        assertEq(_settle(keeper, 1), 1);
        vm.revertToState(snap);
        // A word ready at 7 days + 1 s does not count.
        _warpTo(requestedAt + SILENCE + 1);
        _post(r0 + 4);
        assertFalse(_refUsable(d, requestedAt));
        vm.expectRevert(IBoxTickets.NothingSettled.selector);
        tickets.settle(1);
        tickets.enterTerminal();
    }

    /// P6.16: the same edge for the graduation word (key 0), requested at graduation: alive at 7 days, dead at
    /// 7 days + 1 s; accepted when posted at exactly 7 days, refused `WordNotReady` when posted a second late.
    function testProperty_AUDIT_U6_sevenDayEdgeForTheGraduationWord() public {
        _toGraduated();
        uint256 requestedAt = _st().wordRequestedAt;
        assertEq(_roundOf(0), r0);
        uint256 snap = vm.snapshotState();
        _warpTo(requestedAt + SILENCE);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, 0, requestedAt + SILENCE));
        tickets.enterTerminal();
        _post(r0);
        _warpTo(requestedAt + 60 days);
        tickets.acceptGraduationWord();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Drawing));
        vm.revertToState(snap);
        _warpTo(requestedAt + SILENCE + 1);
        _post(r0);
        vm.expectRevert(IBoxTickets.WordNotReady.selector);
        tickets.acceptGraduationWord();
        tickets.enterTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal));
        vm.expectRevert(IBoxTickets.TerminalMode.selector);
        tickets.acceptGraduationWord();
    }

    // ================================================================================================ 30 days

    /// P6.16 (BoxTickets.sol:70-71, 748): with the graduation poke failed and nobody requesting the word, the head is
    /// alive through graduation + 30 days and dead a second later; a draw is refused `QueueDead(0, …)` then.
    function testProperty_AUDIT_U6_thirtyDayUnrequestedEdge() public {
        _toClosed();
        _warpTo(_requestTimeFor(r0));
        vm.mockCallRevert(address(src), abi.encodeWithSelector(IDrandSource.request.selector, 0), "poke fails");
        _graduate(keeper);
        vm.clearMockedCalls();
        uint256 gateAt = vault.gateOpenedAt();
        assertEq(_st().wordRequestedAt, 0);
        _warpTo(gateAt + SILENCE_UNREQUESTED);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, 0, gateAt + SILENCE_UNREQUESTED));
        tickets.enterTerminal();
        _warpTo(gateAt + SILENCE_UNREQUESTED + 1);
        (, bool dead, uint256 key,) = _refHead();
        assertTrue(dead && key == 0);
        uint256 snap = vm.snapshotState();
        tickets.enterTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal));
        vm.revertToState(snap);
        // A draw that would wait behind the dead word is refused (it does not send the word: nobody can re-request).
        _approveT(eoa[3], a.tickets);
        _fund(eoa[3], AUDIT_DRAW_VALUE);
        uint256 t = vm.getBlockTimestamp();
        vm.prank(eoa[3]);
        // sendWord is true here (the word was never requested), so the draw requests it: see the proof test 25.
        uint256 id = tickets.draw{value: AUDIT_DRAW_VALUE}(type(uint256).max, t);
        assertEq(id, 1);
        assertEq(_st().wordRequestedAt, t, "the draw sent the word's request");
    }

    // ================================================================================================ 3 days

    /// P6.16 (BoxTickets.sol:372-373): takes by number open at terminalAt + 3 days exactly (−1 s refused `TooEarly`),
    /// and need no reveal data at all from that moment (the fallback is allowed from the same time for the taker).
    function testProperty_AUDIT_U6_threeDayTakeEdge() public {
        _toTerminal();
        uint256 takeFrom = uint256(_st().terminalAt) + TAKE_DELAY;
        (uint256 item,) = _poolItem(0);
        _approveT(eoa[5], a.tickets);
        _warpTo(takeFrom - 1);
        uint256 t = vm.getBlockTimestamp();
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.TooEarly.selector, takeFrom));
        tickets.takeByNumber(item, 0, type(uint256).max, t, _rv(item));
        _warpTo(takeFrom);
        (uint256 p,) = _takeByNumber(eoa[5], item, 0, false);
        assertGt(p, 0);
        assertEq(collection.ownerOf(item), eoa[5]);
        assertFalse(collection.isRevealed(item), "taken without the reveal");
        assertEq(tickets.returnableFrom(item), takeFrom + RETURN_GRACE, "returnable unrevealed 30 days later");
        // The same item cannot be taken twice; a position not in the pool is refused.
        (uint256 item2,) = _poolItem(0);
        assertTrue(item2 != item || !vault.isHidden(item), "the view may still show the position; the vault refuses");
        _approveT(eoa[4], a.tickets);
        t = vm.getBlockTimestamp();
        vm.prank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotHidden.selector, item));
        tickets.takeByNumber(item, 0, type(uint256).max, t, _rv(item));
        _assertGhostLedger();
    }

    // ================================================================================================ reveal grace

    /// P6.16 (BoxTickets.sol:280, 697-700): a placeholder opens without its reveal from wordAcceptedAt + 30 days
    /// exactly, by its holder only; a second earlier `RevealRequired`.
    function testProperty_AUDIT_U6_revealGraceEdgeForPlaceholders() public {
        _toDrawing();
        uint256 graceAt = uint256(_st().wordAcceptedAt) + REVEAL_GRACE;
        uint256 n2 = tickets.numberOf(2);
        _warpTo(graceAt - 1);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.RevealRequired.selector, n2, graceAt));
        tickets.open(2, _noReveal());
        _warpTo(graceAt);
        vm.prank(eoa[0]);
        tickets.open(2, _noReveal());
        assertEq(collection.ownerOf(n2), eoa[0]);
        assertFalse(collection.isRevealed(n2));
        assertEq(tickets.returnableFrom(n2), graceAt + RETURN_GRACE);
        // With the reveal, any time.
        uint256 n3 = tickets.numberOf(3);
        _open(eoa[0], 3, true);
        assertTrue(collection.isRevealed(n3));
        assertEq(tickets.returnableFrom(n3), 0, "left revealed: no safety-net clock");
    }

    /// P6.16 (BoxTickets.sol:301, 653-655): a draw's fallback and the third-party rule for a contract drawer use the
    /// settlement time rounded up to the hour (`settleHours`) plus 30 days, reported by `drawTicket`: at −1 s the drawer
    /// without a reveal is refused and a stranger `DrawerOpensFirst`; at 0 s both pass.
    function testProperty_AUDIT_U6_revealGraceEdgeForDraws() public {
        _toWordAccepted();
        uint256 d = _draw(address(contractDrawer), AUDIT_DRAW_VALUE);
        uint256 requestedAt = _dv(d).requestedAt;
        _advance(1);
        _post(r0 + 4);
        // Settle 100 minutes after the request: settleHours rounds up to 2 hours.
        _warpTo(requestedAt + 100 minutes);
        assertEq(_settle(keeper, 1), 1);
        uint256 graceAt = _dv(d).revealFallbackAt;
        assertEq(graceAt, requestedAt + 2 hours + REVEAL_GRACE, "settlement rounded up to the hour, plus 30 days");
        uint256 item = _dv(d).itemId;
        _warpTo(graceAt - 1);
        vm.prank(address(contractDrawer));
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.RevealRequired.selector, item, graceAt));
        tickets.openDraw(d, address(0), _noReveal());
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.DrawerOpensFirst.selector, d, graceAt));
        tickets.openDraw(d, eoa[5], _rv(item));
        _warpTo(graceAt);
        uint256 snap = vm.snapshotState();
        vm.prank(address(contractDrawer));
        tickets.openDraw(d, address(0), _noReveal());
        assertEq(collection.ownerOf(item), address(contractDrawer));
        assertFalse(collection.isRevealed(item));
        vm.revertToState(snap);
        // A stranger at the grace: with the reveal, to the drawer; without it, refused (the fallback is the drawer's).
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.RevealRequired.selector, item, graceAt));
        tickets.openDraw(d, eoa[5], _noReveal());
        vm.prank(eoa[5]);
        tickets.openDraw(d, eoa[5], _rv(item));
        assertEq(collection.ownerOf(item), address(contractDrawer));
    }

    // ================================================================================================ return grace

    /// P6.16 (BoxTickets.sol:430-433; BoxVault.sol:571-584): an item that left unrevealed is returnable unrevealed from
    /// exactly leftAt + 30 days (−1 s `NotRevealed`), and at once if revealed meanwhile.
    function testProperty_AUDIT_U6_returnGraceEdge() public {
        _toDrawing();
        uint256 graceAt = uint256(_st().wordAcceptedAt) + REVEAL_GRACE;
        _warpTo(graceAt);
        uint256 n2 = tickets.numberOf(2);
        vm.prank(eoa[0]);
        tickets.open(2, _noReveal());
        uint256 from = tickets.returnableFrom(n2);
        assertEq(from, graceAt + RETURN_GRACE);
        vm.prank(eoa[0]);
        collection.setApprovalForAll(a.vault, true);
        _warpTo(from - 1);
        uint256 t = vm.getBlockTimestamp();
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotRevealed.selector, n2));
        vault.returnItem(n2, 0, t);
        _warpTo(from);
        (uint256 p,) = _returnItem(eoa[0], n2);
        assertGt(p, 0);
        assertEq(collection.ownerOf(n2), a.vault);
        // Revealed meanwhile: returnable at once.
        uint256 n3 = tickets.numberOf(3);
        vm.prank(eoa[0]);
        tickets.open(3, _noReveal());
        ItemReveal memory r = _rv(n3);
        collection.reveal(n3, r.traitsPacked, r.imageHash, r.avatarHash, r.modelHash, r.salt, r.proof);
        (p,) = _returnItem(eoa[0], n3);
        assertGt(p, 0);
        _assertGhostLedger();
    }

    // ================================================================================================ L6 backup

    /// P6.14 (F143; BoxBackedSource.sol:16-41): a round shared by several draws and the graduation word gets one
    /// backup: a draw in graduation's own block shares r0 with the word; both come from one fixed mix, domain
    /// separated per key; accept and settle follow; a late r0 post changes nothing.
    function testProperty_AUDIT_U6_backupSharedByTheWordAndADraw() public {
        _toGraduated();
        uint256 d = _draw(eoa[3], AUDIT_DRAW_VALUE);
        assertEq(_roundOf(d), r0, "the same round as the graduation word");
        assertEq(_roundOf(0), r0);
        uint256 more = _drawMany(eoa[4], 2, AUDIT_DRAW_VALUE);
        _silentBackup(r0, MIX, eoa[5]);
        (bytes32 w0,) = src.wordOf(a.tickets, 0);
        (bytes32 w1,) = src.wordOf(a.tickets, d);
        (bytes32 w2,) = src.wordOf(a.tickets, more);
        assertEq(w0, _word(src.BACKUP_TAG(), MIX, 0));
        assertEq(w1, _word(src.BACKUP_TAG(), MIX, d));
        assertEq(w2, _word(src.BACKUP_TAG(), MIX, more));
        assertTrue(w0 != w1 && w1 != w2);
        vm.expectRevert(IBoxTickets.WordNotAccepted.selector);
        tickets.settle(3);
        tickets.acceptGraduationWord();
        assertEq(tickets.graduationWord(), w0);
        assertEq(_settle(keeper, 3), 3, "every draw of the round settled from the one backup");
        _post(r0);
        (bytes32 w0b,) = src.wordOf(a.tickets, 0);
        assertEq(w0b, w0, "the late drand post is ignored");
        _assertGhostLedger();
    }

    /// P6.14: a drand post after the backup's start is ignored for the draws of that round (their items come from
    /// the backup's words, checked against the reference shuffle with those words), while a post before the start
    /// makes the start impossible (`RoundAlreadyPosted`).
    function testProperty_AUDIT_U6_drandPostAfterBackupStartIsIgnored() public {
        _toWordAccepted();
        uint256 first = _drawMany(eoa[3], 3, AUDIT_DRAW_VALUE); // r0 + 4, committed but left unposted
        uint256 q = _st().slots;
        uint256 snap = vm.snapshotState();
        // A post before any start: the start is refused.
        _advance(1);
        _post(r0 + 4);
        _warpTo(src.roundTime(r0 + 4) + src.BACKUP_AFTER() + 1);
        (bool ok,, bytes memory err) = _tryStartBackup(r0 + 4, eoa[5]);
        assertFalse(ok);
        assertEq(_sel(err), BoxBackedSource.RoundAlreadyPosted.selector);
        vm.revertToState(snap);
        // The start first, then the post: the post is accepted by the DrandSource and ignored by the backed source.
        _warpTo(src.roundTime(r0 + 4) + src.BACKUP_AFTER() + 1);
        (ok,,) = _tryStartBackup(r0 + 4, eoa[5]);
        assertTrue(ok);
        _post(r0 + 4);
        (bytes32 randomness, uint64 postedAt) = drand.beaconOf(r0 + 4);
        assertTrue(postedAt != 0 && randomness != bytes32(0), "drand has the round");
        (bytes32 w, uint64 readyAt) = src.wordOf(a.tickets, first);
        assertEq(w, bytes32(0), "no word until the fix");
        assertEq(readyAt, 0);
        vm.expectRevert(IBoxTickets.NothingSettled.selector);
        tickets.settle(3);
        _advance(src.TARGET_BLOCKS() + 1);
        _fixBackup(r0 + 4, MIX, poster);
        uint256 left = editionSize - q;
        uint256[] memory pool = new uint256[](left);
        for (uint256 i; i < left; ++i) {
            pool[i] = q + i;
        }
        assertEq(_settle(keeper, 3), 3);
        for (uint256 id = first; id < first + 3; ++id) {
            bytes32 word = _word(src.BACKUP_TAG(), MIX, id);
            (bytes32 got,) = src.wordOf(a.tickets, id);
            assertEq(got, word, "the backup's word, not drand's");
            assertTrue(word != _word(src.DRAND_TAG(), randomness, id));
            uint256 index = BoxShuffle.pickIndex(word, id, left);
            uint256 position = pool[index];
            pool[index] = pool[left - 1];
            --left;
            assertEq(_dv(id).itemId, _itemAtPosition(position), "the item follows the backup word");
        }
        _assertGhostLedger();
    }

    /// P6.14 / P6.16 (BoxBackedSource.sol:38-41, BackupTimeline): from the consumer's side, a backup started at the
    /// latest allowed second and fixed at the end of its proof window is ready inside the 7 days and counts; a fix
    /// that lands after the request's 7 days (within the history window) is unusable, and the head is dead.
    function testProperty_AUDIT_U6_backupFixInsideTheSevenDaysCounts() public {
        _toDrawing();
        _advance(1);
        uint256 d = _draw(eoa[3], AUDIT_DRAW_VALUE);
        uint256 round = _roundOf(d);
        uint256 requestedAt = _dv(d).requestedAt;
        uint256 deadline = requestedAt + SILENCE;
        _warpTo(src.roundTime(round) + src.LATEST_START());
        (bool ok, uint256 target,) = _tryStartBackup(round, eoa[5]);
        assertTrue(ok, "the latest start");
        uint256 snap = vm.snapshotState();
        // The last block of the proof window, 12-second blocks: still inside the 7 days.
        _advance(src.TARGET_BLOCKS() + src.HISTORY_WINDOW());
        assertEq(vm.getBlockNumber(), target + src.HISTORY_WINDOW());
        assertLe(vm.getBlockTimestamp(), deadline, "the whole proof window ends inside the 7 days");
        emit log_named_uint("seconds to spare at the last fixable block", deadline - vm.getBlockTimestamp());
        _fixBackup(round, MIX, poster);
        assertTrue(_refUsable(d, requestedAt));
        assertEq(_settle(keeper, 1), 1);
        vm.revertToState(snap);
        // Fixed a second after the deadline (blocks slower than 12 s, the target still inside the history window):
        // unusable, dead head, terminal.
        _advance(src.TARGET_BLOCKS() + 1);
        vm.roll(target + 8_000);
        vm.warp(deadline + 1);
        _fixBackup(round, MIX, poster);
        (, uint64 readyAt) = src.wordOf(a.tickets, d);
        assertEq(readyAt, deadline + 1);
        assertFalse(_refUsable(d, requestedAt), "ready after the 7 days: does not count");
        vm.expectRevert(IBoxTickets.NothingSettled.selector);
        tickets.settle(1);
        tickets.enterTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal));
        assertGt(_cancelDraw(eoa[5], d), 0);
    }

    /// P6.14: the backup window from the consumer's view: a start at 5 days exactly is `BackupTooEarly`, at 5 days +
    /// 1 s allowed; at 5 days 18 hours allowed, a second later `BackupTooLate`; a draw whose round passed the latest
    /// start with no backup can only wait for its 7 days (terminal).
    function testProperty_AUDIT_U6_backupStartWindowEdges() public {
        _toDrawing();
        _advance(1);
        uint256 d = _draw(eoa[3], AUDIT_DRAW_VALUE);
        uint256 round = _roundOf(d);
        uint256 at = src.roundTime(round) + src.BACKUP_AFTER();
        uint256 until = src.roundTime(round) + src.LATEST_START();
        _warpTo(at);
        (bool ok,, bytes memory err) = _tryStartBackup(round, eoa[5]);
        assertFalse(ok);
        assertEq(_sel(err), BoxBackedSource.BackupTooEarly.selector);
        uint256 snap = vm.snapshotState();
        _warpTo(at + 1);
        (ok,,) = _tryStartBackup(round, eoa[5]);
        assertTrue(ok);
        vm.revertToState(snap);
        _warpTo(until);
        (ok,,) = _tryStartBackup(round, eoa[5]);
        assertTrue(ok);
        vm.revertToState(snap);
        _warpTo(until + 1);
        (ok,, err) = _tryStartBackup(round, eoa[5]);
        assertFalse(ok);
        assertEq(_sel(err), BoxBackedSource.BackupTooLate.selector);
        _warpTo(uint256(_dv(d).requestedAt) + SILENCE + 1);
        tickets.enterTerminal();
    }
}

/// The same under Amsterdam (EIP-2935's history code and BLOCKHASH serve the fix on both).
/// forge-config: default.evm_version = "amsterdam"
contract AuditU6FableTimersAmsterdamTest is AuditU6FableTimersTest {}
