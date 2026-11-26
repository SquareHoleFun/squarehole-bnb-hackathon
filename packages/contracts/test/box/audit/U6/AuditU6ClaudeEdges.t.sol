// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {DrawStatus, ItemReveal, TicketPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {AuditU6ClaudeBase} from "./AuditU6ClaudeBase.sol";

/// @notice U6 lens L7 (arithmetic, rounding and edges) on the factory's box 0: P6.15 (slots: every live placeholder
/// holds a distinct slot below q, minted - burned == live, the vault's pending tickets == live placeholders + open
/// draws, `IBoxTickets.sol:27-29`) and P6.16 (every timer at its edge: SILENCE 7 days, SILENCE_UNREQUESTED 30 days,
/// TAKE_DELAY 3 days, REVEAL_GRACE and RETURN_GRACE 30 days, the backup's 5 days and 5 days 18 hours;
/// `BoxTickets.sol:69-78, 738-774`, `BoxVault.sol:572-584`, `BoxBackedSource.sol:160-169`). The code's edges: the 7-day
/// and 30-day silences are dead strictly after the deadline (at it, alive), as the source's `isSilent`; every other
/// timer opens at its edge exactly.
/// forge-config: default.evm_version = "osaka"
contract AuditU6ClaudeEdgesTest is AuditU6ClaudeBase {
    /// SILENCE at a draw's word: a post exactly 7 days after the request counts; one second later it does not (the head
    /// is dead and terminal mode opens).
    function testProperty_AUDIT_U6_sevenDayEdgeOfADrawWord() public {
        _toWordAccepted();
        uint256 d = _draw(eoa[3], AUDIT_DRAW_VALUE);
        uint256 deadline = tickets.drawTicket(d).requestedAt + tickets.SILENCE();
        uint256 snap = vm.snapshotState();
        _warpTo(deadline);
        _post(r0 + 4);
        assertEq(_settle(keeper, 1), 1, "ready exactly at 7 days: counts");
        vm.revertToState(snap);
        _warpTo(deadline + 1);
        _post(r0 + 4);
        vm.expectRevert(IBoxTickets.NothingSettled.selector);
        tickets.settle(1);
        tickets.enterTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal), "one second late: dead");
        _assertGhostLedger();
    }

    /// SILENCE at the graduation word (key 0): posted exactly 7 days after its request it is accepted; one second later
    /// it is not, and the head (key 0) is dead.
    function testProperty_AUDIT_U6_sevenDayEdgeOfTheGraduationWord() public {
        _toGraduated();
        uint256 deadline = uint256(tickets.status().wordRequestedAt) + tickets.SILENCE();
        uint256 snap = vm.snapshotState();
        _warpTo(deadline);
        _post(r0);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, 0, deadline));
        tickets.enterTerminal();
        tickets.acceptGraduationWord();
        vm.revertToState(snap);
        _warpTo(deadline + 1);
        _post(r0);
        vm.expectRevert(IBoxTickets.WordNotReady.selector);
        tickets.acceptGraduationWord();
        tickets.enterTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal));
    }

    /// SILENCE_UNREQUESTED (graduation's poke of the word failed once): at gate + 30 days the head is alive, one
    /// second later dead; a draw at that second instead requests the word and the queue lives on its own 7 days.
    function testProperty_AUDIT_U6_thirtyDayUnrequestedEdge() public {
        _toClosed();
        _warpTo(_requestTimeFor(r0));
        vm.mockCallRevert(address(src), abi.encodeWithSelector(IDrandSource.request.selector, uint256(0)), "refused");
        _graduate(keeper);
        vm.clearMockedCalls();
        uint256 gateAt = vault.gateOpenedAt();
        assertEq(tickets.status().wordRequestedAt, 0);
        uint256 edge = gateAt + tickets.SILENCE_UNREQUESTED();
        _warpTo(edge);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, 0, edge));
        tickets.enterTerminal();
        _warpTo(edge + 1);
        uint256 snap = vm.snapshotState();
        tickets.enterTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal), "unrequested for 30 days: dead");
        vm.revertToState(snap);
        uint256 d = _draw(eoa[3], AUDIT_DRAW_VALUE);
        assertEq(tickets.status().wordRequestedAt, vm.getBlockTimestamp(), "the draw requested the word");
        vm.expectRevert(
            abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, 0, vm.getBlockTimestamp() + tickets.SILENCE())
        );
        tickets.enterTerminal();
        (, uint64 rw) = src.requestOf(a.tickets, 0);
        (, uint64 rd) = src.requestOf(a.tickets, d);
        assertEq(rw, rd, "the word and the draw share one round (one bounty)");
        _assertGhostLedger();
    }

    /// TAKE_DELAY: a take by number is refused one second before terminal mode's 3 days and accepted at them.
    function testProperty_AUDIT_U6_takeDelayEdge() public {
        _toTerminal();
        uint256 takeFrom = uint256(tickets.status().terminalAt) + tickets.TAKE_DELAY();
        _warpTo(takeFrom - 1);
        (uint256 item, bool hidden) = _poolItem(0);
        assertTrue(hidden);
        _approveT(eoa[4], a.tickets);
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.TooEarly.selector, takeFrom));
        tickets.takeByNumber(item, 0, type(uint256).max, deadline, _noReveal());
        _warpTo(takeFrom);
        _takeByNumber(eoa[4], item, 0, false);
        assertEq(collection.ownerOf(item), eoa[4], "at 3 days exactly");
        assertEq(tickets.returnableFrom(item), takeFrom + tickets.RETURN_GRACE(), "taken unrevealed: the safety net");
        _assertGhostLedger();
    }

    /// REVEAL_GRACE and RETURN_GRACE for a placeholder: the holder's unrevealed open is refused one second before 30
    /// days after the word's acceptance and accepted at them; the item is returnable unrevealed exactly 30 days later,
    /// not one second before.
    function testProperty_AUDIT_U6_placeholderGraceEdges() public {
        _toDrawing();
        uint256 fallbackAt = uint256(tickets.status().wordAcceptedAt) + tickets.REVEAL_GRACE();
        uint256 item = tickets.numberOf(4);
        _warpTo(fallbackAt - 1);
        vm.prank(eoa[1]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.RevealRequired.selector, item, fallbackAt));
        tickets.open(4, _noReveal());
        _warpTo(fallbackAt);
        vm.prank(eoa[1]);
        tickets.open(4, _noReveal());
        uint256 returnable = tickets.returnableFrom(item);
        assertEq(returnable, fallbackAt + tickets.RETURN_GRACE());
        _warpTo(returnable - 1);
        vm.prank(eoa[1]);
        collection.setApprovalForAll(a.vault, true);
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(eoa[1]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotRevealed.selector, item));
        vault.returnItem(item, 0, deadline);
        _warpTo(returnable);
        _returnItem(eoa[1], item);
        assertEq(collection.ownerOf(item), a.vault, "returned unrevealed at 30 days exactly");
        assertTrue(vault.isOnShelf(item));
        _assertGhostLedger();
    }

    /// REVEAL_GRACE for a draw: the drawer's own unrevealed open is refused one second before its grace (settlement
    /// rounded up to the hour, plus 30 days) and accepted at it.
    function testProperty_AUDIT_U6_drawGraceEdge() public {
        _toDrawing();
        // draw A is opened; draw B is the contract drawer's: use a new EOA draw on r0 + 12
        uint256 d = _draw(eoa[4], AUDIT_DRAW_VALUE);
        _advance(1);
        _post(r0 + 12);
        _settle(keeper, 1);
        IBoxTickets.DrawView memory v = tickets.drawTicket(d);
        uint256 graceAt = v.revealFallbackAt;
        assertGe(graceAt, vm.getBlockTimestamp() + tickets.REVEAL_GRACE(), "at least 30 days after the settlement");
        assertLt(graceAt, vm.getBlockTimestamp() + tickets.REVEAL_GRACE() + 1 hours, "within an hour of it");
        _warpTo(graceAt - 1);
        vm.prank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.RevealRequired.selector, v.itemId, graceAt));
        tickets.openDraw(d, eoa[4], _noReveal());
        _warpTo(graceAt);
        vm.prank(eoa[4]);
        tickets.openDraw(d, eoa[4], _noReveal());
        assertEq(collection.ownerOf(v.itemId), eoa[4]);
        assertEq(tickets.returnableFrom(v.itemId), graceAt + tickets.RETURN_GRACE());
        _assertGhostLedger();
    }

    /// The backup's own edges around box 0's draws (BACKUP_AFTER): a start exactly 5 days after the round is refused,
    /// one second later accepted.
    function testProperty_AUDIT_U6_backupStartEdge() public {
        _toDrawing();
        _advance(1);
        uint256 d = _draw(eoa[4], AUDIT_DRAW_VALUE);
        (, uint64 round) = src.requestOf(a.tickets, d);
        assertFalse(_committed(round));
        uint256 at = src.roundTime(round) + src.BACKUP_AFTER();
        _warpTo(at);
        bytes memory h = _parentHeader();
        uint256 parent = vm.getBlockNumber() - 1;
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupTooEarly.selector, round, at));
        src.startBackup(round, parent, h);
        _warpTo(at + 1);
        _startBackup(round, eoa[5]);
        (uint64 startedAt,,,) = src.backupOf(round);
        assertEq(startedAt, at + 1);
    }

    /// Input edges on the curve (quantities, limits, deadlines, token lists).
    function testProperty_AUDIT_U6_inputEdgesOnTheCurve() public {
        _toBonding();
        uint256 deadline = vm.getBlockTimestamp();
        _approveT(eoa[3], a.tickets);
        vm.startPrank(eoa[3]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.InvalidQuantity.selector, 0, vault.inside()));
        tickets.take(0, type(uint256).max, deadline);
        (uint256 qp, uint256 qf) = vault.quoteTake(2);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.MaxTokenExceeded.selector, qp + qf, qp + qf - 1));
        tickets.take(2, qp + qf - 1, deadline);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.DeadlineExpired.selector, deadline - 1, deadline));
        tickets.take(2, type(uint256).max, deadline - 1);
        vm.stopPrank();
        uint256 first = _take(eoa[3], 2);
        uint256[] memory none = new uint256[](0);
        uint256[] memory dup = new uint256[](2);
        (dup[0], dup[1]) = (first, first);
        uint256[] memory foreign = new uint256[](1);
        foreign[0] = 1;
        (uint256 hp, uint256 hf) = vault.quoteHandBack(1);
        uint256[] memory one = new uint256[](1);
        one[0] = first;
        vm.startPrank(eoa[3]);
        vm.expectRevert(IBoxTickets.InvalidTokenList.selector);
        tickets.handBack(none, 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotHolder.selector, first));
        tickets.handBack(dup, 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotHolder.selector, 1));
        tickets.handBack(foreign, 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.MinTokenNotMet.selector, hp - hf, hp - hf + 1));
        tickets.handBack(one, hp - hf + 1, deadline);
        vm.stopPrank();
        _assertSlotsAndTickets();
    }

    /// Input edges in terminal mode (ids, pool indexes, draw ids).
    function testProperty_AUDIT_U6_inputEdgesInTerminalMode() public {
        _toTerminal();
        _warpTo(uint256(tickets.status().terminalAt) + tickets.TAKE_DELAY());
        uint256 deadline = vm.getBlockTimestamp();
        uint256 n = editionSize;
        vm.startPrank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.IneligibleId.selector, 0));
        tickets.takeByNumber(0, 0, type(uint256).max, deadline, _noReveal());
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.IneligibleId.selector, n + 1));
        tickets.takeByNumber(n + 1, 0, type(uint256).max, deadline, _noReveal());
        uint256 placeholderItem = tickets.numberOf(2);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NumberTaken.selector, placeholderItem));
        tickets.takeByNumber(placeholderItem, 0, type(uint256).max, deadline, _noReveal());
        (uint256 pool0,) = _poolItem(0);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotInPool.selector, pool0, 1));
        tickets.takeByNumber(pool0, 1, type(uint256).max, deadline, _noReveal());
        uint256 left = n - tickets.status().slots - tickets.status().drawsSettled;
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotInPool.selector, pool0, left));
        tickets.takeByNumber(pool0, left, type(uint256).max, deadline, _noReveal());
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotInPool.selector, itemB, 0));
        tickets.takeByNumber(itemB, 0, type(uint256).max, deadline, _noReveal());
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.UnknownDraw.selector, 0));
        tickets.openDraw(0, eoa[4], _noReveal());
        uint256 next = tickets.status().drawsRequested + 1;
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.UnknownDraw.selector, next));
        tickets.openDraw(next, eoa[4], _noReveal());
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotCancellable.selector, 0));
        tickets.cancelDraw(0);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotCancellable.selector, drawB));
        tickets.cancelDraw(drawB);
        vm.stopPrank();
    }
}

/// The same under Amsterdam.
/// forge-config: default.evm_version = "amsterdam"
contract AuditU6ClaudeEdgesAmsterdamTest is AuditU6ClaudeEdgesTest {}

/// @notice P6.15 on the curve, by fuzz: random takes, hand-backs (single and batched, any order) and transfers by four
/// holders from the bonding phase (set up once): after every step the live placeholders hold exactly the slots
/// 0 … q - 1 once each, minted - burned == live, every balance sums to live, and the vault's pending tickets == live.
/// forge-config: default.evm_version = "osaka"
contract AuditU6ClaudeCompactionTest is AuditU6ClaudeBase {
    function setUp() public override {
        super.setUp();
        _toBonding();
        address[4] memory who = [eoa[0], eoa[1], eoa[3], eoa[4]];
        for (uint256 i; i < 4; ++i) {
            _approveT(who[i], a.tickets);
        }
    }

    function testFuzz_AUDIT_U6_compactionKeepsSlotsDense(uint256 seed) public {
        address[4] memory who = [eoa[0], eoa[1], eoa[3], eoa[4]];
        uint256 burned;
        uint256 minted0 = tickets.status().minted;
        for (uint256 step; step < 14; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            address w = who[r % 4];
            uint256 action = (r >> 8) % 3;
            (uint256[] memory ids,) = _livePlaceholders();
            if (action == 0 || ids.length < 2) {
                _take(w, 1 + (r >> 16) % 3);
            } else if (action == 1) {
                // a batch of up to three of one holder's tokens, in a random order
                address h = tickets.ownerOf(ids[(r >> 16) % ids.length]);
                uint256[] memory mine = new uint256[](ids.length);
                uint256 m;
                for (uint256 i; i < ids.length; ++i) {
                    if (tickets.ownerOf(ids[(i + (r >> 24)) % ids.length]) == h) {
                        mine[m++] = ids[(i + (r >> 24)) % ids.length];
                    }
                }
                uint256 k = 1 + (r >> 32) % (m < 3 ? m : 3);
                uint256[] memory batch = new uint256[](k);
                for (uint256 i; i < k; ++i) {
                    batch[i] = mine[i];
                }
                _handBack(h, batch);
                burned += k;
            } else {
                uint256 id = ids[(r >> 16) % ids.length];
                address from = tickets.ownerOf(id);
                address to = who[(r >> 40) % 4];
                vm.prank(from);
                tickets.transferFrom(from, to, id);
            }
            (uint256[] memory live, uint256[] memory slots) = _livePlaceholders();
            IBoxTickets.TicketState memory s = tickets.status();
            assertEq(live.length, s.slots, "q == live placeholders");
            assertEq(uint256(s.minted) + 5 - minted0 - burned, live.length, "minted - burned == live");
            bool[] memory used = new bool[](s.slots);
            for (uint256 i; i < live.length; ++i) {
                assertLt(slots[i], s.slots);
                assertFalse(used[slots[i]], "a slot holds one placeholder");
                used[slots[i]] = true;
            }
            uint256 balances;
            for (uint256 i; i < 4; ++i) {
                balances += tickets.balanceOf(who[i]);
            }
            assertEq(balances, live.length, "balances sum to the live placeholders");
            assertEq(vault.pendingTickets(), live.length, "the vault's tickets");
        }
        _assertTicketsHoldNothing();
        _assertGhostLedger();
    }
}
