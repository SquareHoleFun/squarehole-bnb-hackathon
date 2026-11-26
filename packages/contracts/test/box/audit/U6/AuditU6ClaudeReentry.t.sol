// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DrawStatus, ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {
    AuditU6ClaudeAgent,
    AuditU6ClaudeBase,
    AuditU6ClaudeHostileSource,
    AuditU6ClaudeInFlightRecorder
} from "./AuditU6ClaudeBase.sol";

/// @notice U6 lens L3 (reentrancy, callbacks and ordering) on the factory's box 0: P6.7 (a placeholder's
/// `safeTransferFrom` calls the receiver after the state is final, `BoxPlaceholderToken.sol:103-114`; a receiver that
/// calls back sees that state and cannot use a slot twice), the tickets' lock over the item's delivery and the draw's
/// refund (`BoxTickets.sol:53-56`, `TransientReentrancyGuard.sol:26-33`; `ticketInFlight`, `IBoxTicketsInFlight.sol`),
/// and P6.8 (`_wordOf`, `BoxTickets.sol:776-796`: a source that reverts, answers short, burns its gas or names a bad
/// time reads as "no word" and changes nothing; too little caller gas reverts GasTooLow, never "no word"). The hostile
/// sources are a stand-in by necessity: their code is etched over box 0's pinned source for one test each, because the
/// property is how the tickets treat another contract's behaviour (the common rules' exception).
/// forge-config: default.evm_version = "osaka"
contract AuditU6ClaudeReentryTest is AuditU6ClaudeBase {
    function _decode(bytes memory r) internal pure returns (bool ok, bytes memory ret) {
        (ok, ret) = abi.decode(r, (bool, bytes));
    }

    /// P6.7 on the curve: the receiver's hook sees itself as the owner (balance 1, the same slot), hands the
    /// placeholder back (paid), cannot hand it back twice or move it afterwards, and can take a new one; the slots stay
    /// dense and the tickets match the vault.
    function testProperty_AUDIT_U6_placeholderReceiverSeesFinalStateOnCurve() public {
        _toBonding();
        AuditU6ClaudeAgent r = _agent(eoa[3], token.balanceOf(eoa[3]) / 2);
        r.exec(address(token), 0, abi.encodeCall(token.approve, (a.tickets, type(uint256).max)));
        uint256 deadline = vm.getBlockTimestamp();
        uint256 slot1 = tickets.slotOf(1);
        uint256[] memory one = new uint256[](1);
        one[0] = 1;
        r.addOnNft(a.tickets, 0, abi.encodeCall(tickets.ownerOf, (1)));
        r.addOnNft(a.tickets, 0, abi.encodeCall(tickets.balanceOf, (address(r))));
        r.addOnNft(a.tickets, 0, abi.encodeCall(tickets.slotOf, (1)));
        r.addOnNft(a.tickets, 0, abi.encodeCall(tickets.handBack, (one, 0, deadline)));
        r.addOnNft(a.tickets, 0, abi.encodeCall(tickets.handBack, (one, 0, deadline)));
        r.addOnNft(a.tickets, 0, abi.encodeCall(tickets.take, (1, type(uint256).max, deadline)));
        r.addOnNft(
            a.tickets, 0, abi.encodeWithSignature("transferFrom(address,address,uint256)", address(r), eoa[2], 1)
        );
        uint256 t0 = token.balanceOf(address(r));
        uint256 minted0 = tickets.status().minted;
        vm.prank(eoa[0]);
        tickets.safeTransferFrom(eoa[0], address(r), 1);
        _noteTChange(t0, token.balanceOf(address(r)), TIn.Take, TOut.HandBack);

        bytes[] memory res = r.nftResults();
        assertEq(res.length, 7);
        (bool ok, bytes memory ret) = _decode(res[0]);
        assertTrue(ok);
        assertEq(abi.decode(ret, (address)), address(r), "the hook sees itself as the owner");
        (ok, ret) = _decode(res[1]);
        assertEq(abi.decode(ret, (uint256)), 1, "and its balance");
        (ok, ret) = _decode(res[2]);
        assertEq(abi.decode(ret, (uint256)), slot1, "the slot is unchanged by a transfer");
        (ok,) = _decode(res[3]);
        assertTrue(ok, "a hand-back from the hook works");
        (ok, ret) = _decode(res[4]);
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(IBoxTickets.NotHolder.selector, 1), "not twice");
        (ok, ret) = _decode(res[5]);
        assertTrue(ok, "a take from the hook works");
        assertEq(abi.decode(ret, (uint256)), minted0 + 1, "a new token id, never a reused one");
        (ok, ret) = _decode(res[6]);
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(IBoxTickets.NonexistentToken.selector, 1), "the burned token is gone");
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NonexistentToken.selector, 1));
        tickets.ownerOf(1);
        assertEq(tickets.ownerOf(minted0 + 1), address(r));
        _assertTicketsHoldNothing();
        _assertSlotsAndTickets();
        _assertGhostLedger();
    }

    /// P6.7 in era 3: the receiver opens the placeholder from its hook (the item reaches it), cannot open it again,
    /// and sees a consistent queue (nothing to settle).
    function testProperty_AUDIT_U6_placeholderReceiverOpensFromItsHook() public {
        _toDrawing();
        AuditU6ClaudeAgent r = _agent(eoa[0], 0);
        uint256 item2 = tickets.numberOf(2);
        ItemReveal memory rv = _reveal(item2);
        r.addOnNft(a.tickets, 0, abi.encodeCall(tickets.open, (2, rv)));
        r.addOnNft(a.tickets, 0, abi.encodeCall(tickets.open, (2, rv)));
        r.addOnNft(a.tickets, 0, abi.encodeCall(tickets.settle, (1)));
        vm.prank(eoa[0]);
        tickets.safeTransferFrom(eoa[0], address(r), 2);
        bytes[] memory res = r.nftResults();
        (bool ok, bytes memory ret) = _decode(res[0]);
        assertTrue(ok, "open from the hook");
        assertEq(abi.decode(ret, (uint256)), item2);
        (ok, ret) = _decode(res[1]);
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(IBoxTickets.NonexistentToken.selector, 2), "a slot is used once");
        (ok, ret) = _decode(res[2]);
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(IBoxTickets.NothingSettled.selector), "the queue is empty");
        assertEq(collection.ownerOf(item2), address(r));
        assertTrue(collection.isRevealed(item2));
        assertEq(tickets.balanceOf(address(r)), 0);
        _assertTicketsHoldNothing();
        _assertSlotsAndTickets();
        _assertGhostLedger();
    }

    /// The tickets' lock over `openDraw`'s delivery: inside the recipient's ERC-721 hook every tickets entry point and
    /// the vault revert Reentrancy, `ticketInFlight` names the ticket, the item is not yet revealed and may be moved on;
    /// the reveal then completes and nothing stays in flight.
    function testProperty_AUDIT_U6_deliveryHookIsLocked() public {
        _toWordAccepted();
        AuditU6ClaudeAgent ag = _agent(eoa[3], token.balanceOf(eoa[3]) / 2);
        ag.exec(address(token), 0, abi.encodeCall(token.approve, (a.tickets, type(uint256).max)));
        uint256 id = _agentDraw(ag, AUDIT_DRAW_VALUE);
        _advance(1);
        _post(r0 + 4);
        _settle(keeper, 1);
        uint256 item = tickets.drawTicket(id).itemId;
        ItemReveal memory rv = _reveal(item);
        uint256 deadline = vm.getBlockTimestamp();
        ag.addOnNft(a.tickets, 0, abi.encodeCall(tickets.ticketInFlight, ()));
        ag.addOnNft(a.tickets, 0, abi.encodeCall(tickets.settle, (1)));
        ag.addOnNft(a.tickets, 0, abi.encodeCall(tickets.draw, (type(uint256).max, deadline)));
        ag.addOnNft(a.tickets, 0, abi.encodeCall(tickets.openDraw, (id, address(ag), rv)));
        ag.addOnNft(a.tickets, 0, abi.encodeCall(tickets.enterTerminal, ()));
        ag.addOnNft(a.vault, 0, abi.encodeCall(vault.returnItem, (item, 0, deadline)));
        ag.addOnNft(a.collection, 0, abi.encodeCall(collection.isRevealed, (item)));
        ag.addOnNft(
            a.collection, 0, abi.encodeWithSignature("transferFrom(address,address,uint256)", address(ag), eoa[2], item)
        );
        ag.exec(a.tickets, 0, abi.encodeCall(tickets.openDraw, (id, address(ag), rv)));
        bytes[] memory res = ag.nftResults();
        assertEq(res.length, 8);
        (bool ok, bytes memory ret) = _decode(res[0]);
        assertEq(abi.decode(ret, (uint256)), id, "the ticket in flight during the delivery");
        for (uint256 i = 1; i <= 5; ++i) {
            (ok, ret) = _decode(res[i]);
            assertFalse(ok);
            assertEq(ret, _reentrancy(), "locked");
        }
        (ok, ret) = _decode(res[6]);
        assertFalse(abi.decode(ret, (bool)), "not revealed yet inside the hook");
        (ok,) = _decode(res[7]);
        assertTrue(ok, "the recipient may move the item on");
        assertEq(collection.ownerOf(item), eoa[2]);
        assertTrue(collection.isRevealed(item), "the reveal completed after the hook");
        assertEq(uint8(tickets.drawTicket(id).status), uint8(DrawStatus.Opened));
        assertEq(tickets.ticketInFlight(), 0);
        _assertTicketsHoldNothing();
        _assertGhostLedger();
    }

    /// The tickets' lock over the draw's refund (DrandWords.payRound's call to the drawer): re-entry reverts, the state
    /// the drawer reads is final (its ticket counted), and ETH it adds to the round from the hook only grows the pot.
    function testProperty_AUDIT_U6_refundHookIsLockedAndSeesFinalState() public {
        _toWordAccepted();
        AuditU6ClaudeAgent ag = _agent(eoa[3], token.balanceOf(eoa[3]) / 2);
        ag.exec(address(token), 0, abi.encodeCall(token.approve, (a.tickets, type(uint256).max)));
        uint256 round = _roundNow();
        uint256 target = _target();
        uint256 deadline = vm.getBlockTimestamp();
        uint256 extra = 7 gwei;
        ag.addOnEth(a.tickets, 0, abi.encodeCall(tickets.settle, (1)));
        ag.addOnEth(a.tickets, 0, abi.encodeCall(tickets.draw, (type(uint256).max, deadline)));
        ag.addOnEth(a.tickets, 0, abi.encodeCall(tickets.status, ()));
        ag.addOnEth(address(src), 0, abi.encodeCall(src.bountyOf, (round)));
        ag.addOnEth(address(src), extra, abi.encodeCall(src.addBounty, (round)));
        uint256 id = _agentDraw(ag, 3 * target);
        bytes[] memory res = ag.ethResults();
        assertEq(res.length, 5);
        (bool ok, bytes memory ret) = _decode(res[0]);
        assertFalse(ok);
        assertEq(ret, _reentrancy());
        (ok, ret) = _decode(res[1]);
        assertFalse(ok);
        assertEq(ret, _reentrancy());
        (ok, ret) = _decode(res[2]);
        IBoxTickets.TicketState memory s = abi.decode(ret, (IBoxTickets.TicketState));
        assertEq(s.drawsRequested, id, "the drawer's own ticket is already counted");
        (ok, ret) = _decode(res[3]);
        assertEq(abi.decode(ret, (uint256)), 0, "the pot is topped up after the refund");
        (ok,) = _decode(res[4]);
        assertTrue(ok, "anyone may add to a pot");
        assertEq(drand.bountyOf(round), target + extra, "the draw paid the target, the hook its extra");
        assertEq(address(ag).balance, 2 * target - extra);
        _assertTicketsHoldNothing();
        _assertGhostLedger();
    }

    /// P6.8: a source whose `wordOf` reverts (1), answers 32 bytes (2), burns all its gas (3), names a time above 2^64
    /// (4), a time before the request (5), a time in the future (6), a zero word (7) reads as "no word": settle and
    /// openDraw change nothing, and after 7 days the head is dead (the failure is the source's own); a 200-byte answer
    /// whose first 64 bytes are a valid word now (8) counts as that word.
    function testProperty_AUDIT_U6_hostileSourceReadsNoWord() public {
        _toDrawing();
        _advance(1);
        uint256 d = _draw(eoa[3], AUDIT_DRAW_VALUE);
        uint256 requestedAt = tickets.drawTicket(d).requestedAt;
        bytes memory original = address(src).code;
        bytes memory hostile = address(new AuditU6ClaudeHostileSource()).code;
        for (uint256 mode = 1; mode <= 8; ++mode) {
            uint256 snap = vm.snapshotState();
            vm.etch(address(src), hostile);
            vm.store(address(src), bytes32(0), bytes32(mode));
            IBoxTickets.TicketState memory s0 = tickets.status();
            if (mode == 8) {
                assertEq(tickets.settle(1), 1, "a long answer: its first 64 bytes count");
                vm.revertToState(snap);
                continue;
            }
            uint256 g0 = gasleft();
            vm.expectRevert(IBoxTickets.NothingSettled.selector);
            tickets.settle(1);
            uint256 used = g0 - gasleft();
            if (mode == 3) assertLt(used, 120_000, "a gas-burning source costs the caller at most its 50,000 cap");
            assertEq(abi.encode(tickets.status()), abi.encode(s0), "nothing changed");
            vm.prank(eoa[3]);
            vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotSettled.selector, d));
            tickets.openDraw(d, eoa[3], _noReveal());
            _warpTo(requestedAt + tickets.SILENCE());
            vm.expectRevert(abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, d, requestedAt + 7 days));
            tickets.enterTerminal();
            _warpTo(requestedAt + tickets.SILENCE() + 1);
            tickets.enterTerminal();
            assertEq(tickets.status().terminalAt, vm.getBlockTimestamp(), "no word for 7 days: terminal mode");
            vm.revertToState(snap);
        }
        vm.etch(address(src), original);
        (bytes32 w,) = src.wordOf(a.tickets, d);
        assertEq(w, bytes32(0), "the real source again (the round is unposted)");
        _assertGhostLedger();
    }

    /// P6.8: with a usable word at the head, no caller gas makes `settle` read "no word": every limit either settles the
    /// head or reverts GasTooLow or out of gas (cold state at every limit).
    function testProperty_AUDIT_U6_lowGasSettleNeverReadsNoWord() public {
        _toWordAccepted();
        _draw(eoa[3], AUDIT_DRAW_VALUE);
        _advance(1);
        _post(r0 + 4);
        bytes memory nothing = abi.encodeWithSelector(IBoxTickets.NothingSettled.selector);
        bytes memory tooLow = abi.encodeWithSelector(IBoxTickets.GasTooLow.selector);
        uint256 firstOk;
        uint256 gasTooLow;
        uint256 outOfGas;
        for (uint256 g = 30_000; g <= 300_000; g += 250) {
            uint256 snap = vm.snapshotState();
            vm.cool(address(src));
            vm.cool(address(drand));
            vm.cool(a.tickets);
            vm.cool(a.vault);
            (bool ok, bytes memory ret) = a.tickets.call{gas: g}(abi.encodeCall(tickets.settle, (1)));
            vm.revertToState(snap);
            if (ok) {
                if (firstOk == 0) firstOk = g;
                continue;
            }
            assertTrue(keccak256(ret) != keccak256(nothing), "low gas never reads as no word");
            if (keccak256(ret) == keccak256(tooLow)) ++gasTooLow;
            else if (ret.length == 0) ++outOfGas;
            else revert("an unexpected revert");
        }
        emit log_named_string("evm", vm.getEvmVersion());
        emit log_named_uint("first cold gas limit that settles", firstOk);
        emit log_named_uint("limits reverting GasTooLow", gasTooLow);
        emit log_named_uint("limits out of gas", outOfGas);
        assertGt(firstOk, 0);
        assertGt(gasTooLow, 0, "the GasTooLow guard is reached");
    }

    /// P6.8 / P6.12 at a draw head (the existing never-stuck tests pin key 0): a timely backup word at the head of the
    /// draw queue cannot be hidden by a low-gas `enterTerminal` after its deadline; every limit fails.
    function testProperty_AUDIT_U6_lowGasCannotKillATimelyDrawHead() public {
        _toSilent();
        _backup(silentRound, MIX, eoa[5]);
        uint256 deadline = tickets.drawTicket(drawC).requestedAt + tickets.SILENCE();
        _warpTo(deadline + 1);
        bytes memory headNotDead = abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, drawC, deadline);
        uint256 firstRead;
        for (uint256 g = 40_000; g <= 250_000; g += 100) {
            vm.cool(address(src));
            vm.cool(address(drand));
            vm.cool(a.tickets);
            vm.cool(a.vault);
            (bool ok, bytes memory ret) = a.tickets.call{gas: g}(abi.encodeCall(tickets.enterTerminal, ()));
            assertFalse(ok, "a timely word at the head is never read as dead");
            if (firstRead == 0 && keccak256(ret) == keccak256(headNotDead)) firstRead = g;
        }
        emit log_named_string("evm", vm.getEvmVersion());
        emit log_named_uint("first cold gas limit that reads the head's word", firstRead);
        assertGt(firstRead, 0);
        assertEq(tickets.status().terminalAt, 0);
        assertEq(_settle(keeper, 1), 1, "and the head still settles");
    }

    /// R1 (architecture review 2026-10-07, recorded; holds): the tickets name the draw in flight to their observer while
    /// `openDraw` delivers its item and while `cancelDraw` releases its ticket, and 0 at every other observer call (a
    /// placeholder's open, a draw's request) and after each call. The stream's code is replaced by a recorder for this
    /// test (the transient value is what is observed; the stream's own booking of it is U5's).
    function testProperty_AUDIT_U6_inFlightTicketOnlyDuringItsOwnDeliveryOrRelease() public {
        _toWordAccepted();
        uint256 d1 = _draw(eoa[3], AUDIT_DRAW_VALUE);
        _advance(1);
        _post(r0 + 4);
        uint256 d2 = _draw(eoa[4], AUDIT_DRAW_VALUE); // r0 + 8, never posted: cancelled in terminal mode
        _settle(keeper, 1);
        uint256 item1 = tickets.drawTicket(d1).itemId;
        uint256 itemP = tickets.numberOf(2);
        ItemReveal memory r1 = _reveal(item1);
        ItemReveal memory rp = _reveal(itemP);
        vm.etch(a.itemStream, type(AuditU6ClaudeInFlightRecorder).runtimeCode);
        vm.store(a.itemStream, bytes32(0), bytes32(uint256(uint160(a.tickets))));
        vm.store(a.itemStream, bytes32(uint256(1)), bytes32(0)); // the recorder's array starts empty
        vm.prank(eoa[0]);
        tickets.open(2, rp); // a placeholder: nothing in flight
        vm.prank(eoa[3]);
        tickets.openDraw(d1, eoa[3], r1); // draw 1 in flight during its delivery
        _warpTo(tickets.drawTicket(d2).requestedAt + tickets.SILENCE() + 1);
        tickets.enterTerminal();
        tickets.cancelDraw(d2); // draw 2 in flight during its release
        uint256[] memory seen = AuditU6ClaudeInFlightRecorder(payable(a.itemStream)).recorded();
        assertEq(seen.length, 3, "one observer call per item transfer or vault release");
        assertEq(seen[0], 0, "a placeholder's open: none in flight");
        assertEq(seen[1], d1, "the draw being delivered");
        assertEq(seen[2], d2, "the draw being released");
        assertEq(tickets.ticketInFlight(), 0, "cleared after each call");
    }

    /// @dev A draw by the agent (exec), its ETH and T booked by their change.
    function _agentDraw(AuditU6ClaudeAgent ag, uint256 value) internal returns (uint256 id) {
        vm.deal(address(ag), address(ag).balance + value);
        uint256 e0 = address(ag).balance;
        uint256 t0 = token.balanceOf(address(ag));
        uint256 deadline = vm.getBlockTimestamp();
        bytes memory ret = ag.exec(a.tickets, value, abi.encodeCall(tickets.draw, (type(uint256).max, deadline)));
        id = abi.decode(ret, (uint256));
        _noteEthChange(e0, address(ag).balance, EthIn.DrawValue, EthOut.Refund);
        _noteTChange(t0, token.balanceOf(address(ag)), TIn.Draw, TOut.Other);
    }
}

/// The same under Amsterdam (the read's gas margin and the cold costs are fork-sensitive).
/// forge-config: default.evm_version = "amsterdam"
contract AuditU6ClaudeReentryAmsterdamTest is AuditU6ClaudeReentryTest {}
