// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DrawStatus, TicketPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {BoxShuffle} from "../../../../src/box/libraries/BoxShuffle.sol";
import {AuditU6ClaudeBase} from "./AuditU6ClaudeBase.sol";

/// @notice U6's two modes the shared drivers never reach, on the factory's box 0: terminal mode before any number
/// exists (the graduation word silent for 7 days: "fee-free cancels and number-less hand-backs; takeByNumber from
/// TAKE_DELAY", `IBoxTickets.sol:18-21`, `BoxTickets.sol:42-44, 175, 370-380, 668-684`) and a graduation with no
/// placeholder at all ("q = 0: no word, π the identity", `BoxTickets.sol:33`, `:620-637`, `:668-684`). Lenses L1, L2,
/// L4, L7 (P6.2, P6.6, P6.9, P6.15).
/// forge-config: default.evm_version = "osaka"
contract AuditU6ClaudeModesTest is AuditU6ClaudeBase {
    /// Terminal mode on the graduation word (key 0) with five placeholders and one draw waiting behind it. The head is
    /// alive at its deadline and dead one second later; once terminal, a late drand post can never be stored, no
    /// placeholder carries a number, placeholders move again (era 3) and are handed back for the vault's current
    /// return quote with no fee and no compaction (q stays), the draw is cancelled for its current principal, and from
    /// 3 days on any hidden item is taken by number with the pool index ignored (no number was ever given); a taken
    /// item cannot be taken twice. Every ticket ends released or delivered; nothing stays in the tickets contract.
    function testProperty_AUDIT_U6_numberlessTerminalMode() public {
        _toSilentFromGraduation();
        uint256 d = _draw(eoa[3], AUDIT_DRAW_VALUE); // waits behind key 0 (requested at graduation, alive for 7 days)
        uint256 deadline = uint256(tickets.status().wordRequestedAt) + tickets.SILENCE();
        _warpTo(deadline);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, 0, deadline));
        tickets.enterTerminal();
        _warpTo(deadline + 1);
        vm.prank(eoa[5]);
        tickets.enterTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal));
        // A late post of the graduation round (accepted by the DrandSource) can never be stored now.
        _post(r0);
        vm.expectRevert(IBoxTickets.TerminalMode.selector);
        tickets.acceptGraduationWord();
        assertEq(tickets.numberOf(1), 0, "no placeholder carries a number");
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxTickets.WordNotAccepted.selector);
        tickets.open(1, _noReveal());
        // Era 3: placeholders move again.
        vm.prank(eoa[0]);
        tickets.transferFrom(eoa[0], eoa[2], 1);
        assertEq(tickets.ownerOf(1), eoa[2]);

        // A number-less hand-back of two: the current return quote, no fee, nothing burned, q unchanged.
        uint256[] memory two = new uint256[](2);
        (two[0], two[1]) = (2, 3);
        (uint256 qp, uint256 qf) = vault.quoteHandBack(2);
        assertEq(qf, 0, "no fee once the gate is open");
        assertEq(qp, vault.quoteReturn(2), "the vault's return quote");
        uint256 supply0 = token.totalSupply();
        uint256 hidden0 = vault.hiddenCount();
        uint256 pending0 = vault.pendingTickets();
        uint256 bal0 = token.balanceOf(eoa[0]);
        (uint256 principal, uint256 fee) = _handBack(eoa[0], two);
        assertEq(principal, qp);
        assertEq(fee, 0);
        assertEq(token.balanceOf(eoa[0]) - bal0, qp, "the holder got the whole principal");
        assertEq(token.totalSupply(), supply0, "nothing burned");
        assertEq(tickets.status().slots, 5, "no compaction after graduation: q stays");
        assertEq(vault.hiddenCount(), hidden0 + 2, "the two items are hidden again");
        assertEq(vault.pendingTickets(), pending0 - 2);

        // The draw behind the dead head: cancelled for its current principal, to its drawer.
        uint256 quote = vault.quoteReturn(1);
        assertEq(_cancelDraw(eoa[7], d), quote);
        assertEq(uint8(tickets.drawTicket(d).status), uint8(DrawStatus.Cancelled));

        // Takes by number: refused one second before 3 days, then any hidden item, the pool index ignored.
        uint256 takeFrom = uint256(tickets.status().terminalAt) + tickets.TAKE_DELAY();
        _warpTo(takeFrom - 1);
        _approveT(eoa[4], a.tickets);
        uint256 dl = vm.getBlockTimestamp();
        vm.prank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.TooEarly.selector, takeFrom));
        tickets.takeByNumber(1, 0, type(uint256).max, dl, _noReveal());
        _warpTo(takeFrom);
        uint256 last = tickets.firstId() + editionSize - 1;
        _takeByNumber(eoa[4], 1, 999_999, false); // any index: no number was ever given
        _takeByNumber(eoa[4], last, 0, true);
        assertEq(collection.ownerOf(1), eoa[4]);
        assertEq(collection.ownerOf(last), eoa[4]);
        assertFalse(collection.isRevealed(1), "taken without its reveal");
        assertEq(tickets.returnableFrom(1), takeFrom + tickets.RETURN_GRACE(), "the safety net counts from the take");
        assertTrue(collection.isRevealed(last));
        dl = vm.getBlockTimestamp();
        vm.prank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotHidden.selector, 1));
        tickets.takeByNumber(1, 0, type(uint256).max, dl, _noReveal());

        // The remaining placeholders still hand back; every ticket is then released or delivered.
        uint256[] memory rest = new uint256[](2);
        (rest[0], rest[1]) = (4, 5);
        _handBack(eoa[1], rest);
        uint256[] memory one = new uint256[](1);
        one[0] = 1;
        _handBack(eoa[2], one);
        assertEq(vault.pendingTickets(), 0, "every ticket released or delivered");
        assertEq(tickets.status().minted, 5);
        _assertSlotsAndTickets();
        _assertTicketsHoldNothing();
        _assertGhostLedger();
    }

    /// No placeholder at graduation (all five handed back on the curve): graduation's poke of the word fails
    /// (`NoPlaceholders`, no word needed), the phase is Drawing at once, the word can be neither requested nor
    /// accepted, a draw requests no word, and every draw's item is firstId + its pool position (π the identity),
    /// the oracle's; in terminal mode the numbers are the identity's and a settled draw's item is out of the pool.
    function testProperty_AUDIT_U6_noPlaceholdersIdentityPool() public {
        _graduateWithoutPlaceholders();
        uint256[3] memory d = _threeIdentityDraws();
        uint256[3] memory items = [_openDraw(eoa[3], d[0], eoa[3], true), _itemOf(d[1]), _itemOf(d[2])];

        // A draw on a silent round, then terminal mode on it.
        _warpTo(vm.getBlockTimestamp() + 1 hours);
        uint256 d4 = _draw(eoa[3], AUDIT_DRAW_VALUE);
        (, uint64 rd4) = src.requestOf(a.tickets, d4);
        assertFalse(_committed(rd4));
        _warpTo(tickets.drawTicket(d4).requestedAt + tickets.SILENCE() + 1);
        tickets.enterTerminal();
        _warpTo(uint256(tickets.status().terminalAt) + tickets.TAKE_DELAY());
        // The pool's numbers are the identity's: index i holds item firstId + poolPositionAt(i).
        uint256 left = editionSize - tickets.status().drawsSettled;
        for (uint256 i; i < 8; ++i) {
            uint256 idx = (i * 251) % left;
            assertTrue(vault.isHidden(tickets.firstId() + tickets.poolPositionAt(idx)), "a pool item is hidden");
        }
        uint256 pick = tickets.firstId() + tickets.poolPositionAt(7);
        _takeByNumber(eoa[2], pick, 7, true);
        assertEq(collection.ownerOf(pick), eoa[2]);
        // The settled draws' items are out of the pool, at the index each was picked at (one outside, two reserved).
        uint256 dl = vm.getBlockTimestamp();
        for (uint256 k; k < 3; ++k) {
            uint256 at = BoxShuffle.pickIndex(_wordOfKey(k + 1), k + 1, editionSize - k);
            vm.prank(eoa[2]);
            vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotInPool.selector, items[k], at));
            tickets.takeByNumber(items[k], at, type(uint256).max, dl, _noReveal());
        }
        assertGt(_cancelDraw(eoa[7], d4), 0);
        _openDraw(eoa[4], d[1], eoa[4], true);
        _openDraw(eoa[5], d[2], eoa[5], true);
        assertEq(vault.pendingTickets(), 0);
        _assertTicketsHoldNothing();
        _assertGhostLedger();
    }

    /// @dev Bonding, all five placeholders handed back (q = 0), the close, graduation at r0's request time.
    function _graduateWithoutPlaceholders() internal {
        _toBonding();
        uint256[] memory ids0 = new uint256[](3);
        (ids0[0], ids0[1], ids0[2]) = (1, 2, 3);
        uint256[] memory ids1 = new uint256[](2);
        (ids1[0], ids1[1]) = (4, 5);
        _handBack(eoa[0], ids0);
        _handBack(eoa[1], ids1);
        assertEq(tickets.status().slots, 0, "q = 0");
        assertEq(vault.pendingTickets(), 0);
        _toClosed();
        _warpTo(_requestTimeFor(r0));
        (, uint256 failures) = _graduate(keeper);
        reached = AuditPhase.Graduated;
        assertEq(failures, 1, "the tickets' poke reverted (NoPlaceholders), the others passed");
        assertEq(tickets.status().wordRequestedAt, 0);
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Drawing), "no word to wait for");
        vm.expectRevert(IBoxTickets.NoPlaceholders.selector);
        tickets.requestGraduationWord();
        vm.expectRevert(IBoxTickets.WordNotRequested.selector);
        tickets.acceptGraduationWord();
        vm.expectRevert(IBoxTickets.NothingSettled.selector);
        tickets.settle(1);
        vm.expectRevert(IBoxTickets.NothingPending.selector);
        tickets.enterTerminal();
    }

    /// @dev Two draws in graduation's block (round r0), one in the next (r0 + 4), all settled; identity items.
    function _threeIdentityDraws() internal returns (uint256[3] memory d) {
        d[0] = _draw(eoa[3], AUDIT_DRAW_VALUE);
        d[1] = _draw(eoa[4], AUDIT_DRAW_VALUE);
        (, uint64 rd1) = src.requestOf(a.tickets, d[0]);
        assertEq(rd1, r0);
        (uint64 wordAt,) = src.requestOf(a.tickets, 0);
        assertEq(wordAt, 0, "a draw requests no word when q = 0");
        _advance(1);
        d[2] = _draw(eoa[5], AUDIT_DRAW_VALUE);
        _post(r0);
        _advance(1);
        _post(r0 + 4);
        assertEq(_settle(keeper, 5), 3);
        uint256 first = BoxShuffle.pickIndex(_wordOfKey(d[0]), d[0], editionSize);
        assertEq(_itemOf(d[0]), tickets.firstId() + first, "identity: the first pick's position");
        _assertItemsMatchOracle();
    }

    function _itemOf(uint256 ticketId) internal view returns (uint256) {
        return tickets.drawTicket(ticketId).itemId;
    }

    function _wordOfKey(uint256 key) internal view returns (bytes32 w) {
        (w,) = src.wordOf(a.tickets, key);
    }
}

/// The same under Amsterdam.
/// forge-config: default.evm_version = "amsterdam"
contract AuditU6ClaudeModesAmsterdamTest is AuditU6ClaudeModesTest {}
