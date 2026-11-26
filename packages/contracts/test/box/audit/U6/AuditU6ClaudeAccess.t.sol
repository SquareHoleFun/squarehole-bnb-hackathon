// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {DrawStatus, ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {AuditU6ClaudeBase} from "./AuditU6ClaudeBase.sol";

/// @notice U6 lens L2 (access and roles) on the factory's box 0: P6.4 (`open` by the holder or a current-era operator,
/// `BoxTickets.sol:268-282`; `openDraw` by the drawer to any address, by others to the drawer, at once for an EOA or an
/// EIP-7702 account, after REVEAL_GRACE for a contract, `:285-323`, `IBoxTickets.sol:169-173`; review of sh-core-v1
/// #3 and AR-17 hold), P6.5 (an approval counts only in its own era and never in era 2, `BoxPlaceholderToken.sol:13-16,
/// 147-150`; AR-16 holds), P6.6 (terminal-mode gates, `BoxTickets.sol:329-387`), BC-010 for the tickets' entry points
/// (a random caller changes nothing) and BC-100 (initialise once, only by the box's coordinator). The EIP-7702 drawer
/// is the world's `eoa7702` with a real delegation (`vm.signAndAttachDelegation`), on Osaka and on Amsterdam.
/// forge-config: default.evm_version = "osaka"
contract AuditU6ClaudeAccessTest is AuditU6ClaudeBase {
    address internal op1 = makeAddr("u6.op1");
    address internal op2 = makeAddr("u6.op2");
    address internal op3 = makeAddr("u6.op3");
    address internal op4 = makeAddr("u6.op4");
    address internal op5 = makeAddr("u6.op5");
    address internal op6 = makeAddr("u6.op6");
    address internal op7 = makeAddr("u6.op7");

    /// P6.4 + P6.5 through all three eras: approvals given in era 1 or era 2 never count in era 3 (open, transfer,
    /// views); fresh era-3 approvals open, and the item always goes to the holder; an operator can never skip the
    /// reveal, the holder can after REVEAL_GRACE (30 days from the word's acceptance).
    function testProperty_AUDIT_U6_openOnlyHolderOrEraThreeOperator() public {
        _toBonding();
        vm.startPrank(eoa[0]);
        tickets.setApprovalForAll(op1, true);
        tickets.approve(op2, 2);
        vm.stopPrank();
        assertTrue(tickets.isApprovedForAll(eoa[0], op1), "era 1: the operator counts");
        assertEq(tickets.getApproved(2), op2, "era 1: the approval counts");
        // era 1: an operator moves a placeholder
        vm.prank(op1);
        tickets.transferFrom(eoa[0], eoa[2], 3);
        assertEq(tickets.ownerOf(3), eoa[2]);

        _toGraduated();
        assertFalse(tickets.isApprovedForAll(eoa[0], op1), "era 2: no approval counts");
        assertEq(tickets.getApproved(2), address(0));
        vm.prank(op1);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, op1, 2));
        tickets.transferFrom(eoa[0], op1, 2);
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxTickets.Frozen.selector);
        tickets.transferFrom(eoa[0], eoa[2], 2);
        // approvals given while frozen are stored but never count
        vm.startPrank(eoa[0]);
        tickets.approve(op3, 2);
        tickets.setApprovalForAll(op4, true);
        vm.stopPrank();
        assertEq(tickets.getApproved(2), address(0), "an era-2 approval never counts");
        assertFalse(tickets.isApprovedForAll(eoa[0], op4));

        _toDrawing();
        ItemReveal memory r2 = _reveal(tickets.numberOf(2));
        address[4] memory stale = [op1, op2, op3, op4];
        for (uint256 i; i < 4; ++i) {
            vm.prank(stale[i]);
            vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, stale[i], 2));
            tickets.open(2, r2);
            vm.prank(stale[i]);
            vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, stale[i], 2));
            tickets.transferFrom(eoa[0], stale[i], 2);
        }
        assertFalse(tickets.isApprovedForAll(eoa[0], op1), "era 3: the era-1 operator does not count");
        assertEq(tickets.getApproved(2), address(0), "era 3: the era-2 approval does not count");

        vm.prank(eoa[0]);
        tickets.setApprovalForAll(op5, true);
        uint256 item2 = tickets.numberOf(2);
        vm.prank(op5);
        assertEq(tickets.open(2, r2), item2);
        assertEq(collection.ownerOf(item2), eoa[0], "the holder gets the item, not the operator");
        vm.prank(eoa[2]);
        tickets.approve(op6, 3);
        uint256 item3 = tickets.numberOf(3);
        ItemReveal memory r3 = _reveal(item3);
        vm.prank(op6);
        tickets.open(3, r3);
        assertEq(collection.ownerOf(item3), eoa[2], "the holder gets the item, not the approved address");

        // the reveal grace: only the holder may open without the reveal
        vm.prank(eoa[1]);
        tickets.setApprovalForAll(op7, true);
        uint256 graceAt = uint256(tickets.status().wordAcceptedAt) + tickets.REVEAL_GRACE();
        _warpTo(graceAt);
        uint256 item4 = tickets.numberOf(4);
        vm.prank(op7);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.RevealRequired.selector, item4, graceAt));
        tickets.open(4, _noReveal());
        vm.prank(eoa[1]);
        tickets.open(4, _noReveal());
        assertFalse(collection.isRevealed(item4), "left unrevealed");
        assertEq(tickets.returnableFrom(item4), graceAt + tickets.RETURN_GRACE(), "returnable 30 days after it left");
        _assertTicketsHoldNothing();
        _assertSlotsAndTickets();
        _assertGhostLedger();
    }

    /// P6.4: a stranger opens an EOA drawer's settled draw at once, always to the drawer, never without the reveal.
    function testProperty_AUDIT_U6_strangerOpensEoaDrawToTheDrawer() public {
        _toWordAccepted();
        uint256 id = _draw(eoa[3], AUDIT_DRAW_VALUE);
        _advance(1);
        _post(r0 + 4);
        _settle(keeper, 1);
        uint256 item = tickets.drawTicket(id).itemId;
        uint256 fallbackAt = tickets.drawTicket(id).revealFallbackAt;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.RevealRequired.selector, item, fallbackAt));
        tickets.openDraw(id, keeper, _noReveal());
        vm.prank(keeper);
        tickets.openDraw(id, keeper, _reveal(item));
        assertEq(collection.ownerOf(item), eoa[3], "to the drawer, not the caller's `to`");
        assertTrue(collection.isRevealed(item));
        assertEq(tickets.ticketInFlight(), 0, "nothing in flight after the call");
        _assertTicketsHoldNothing();
        _assertGhostLedger();
    }

    /// P6.4, the AR-17 gap: an EIP-7702 drawer (real delegation, 23-byte designator) counts as an account without
    /// code: a stranger opens its draw at once, to the drawer; its draw refund (all gas) arrives in full on this EVM.
    function testProperty_AUDIT_U6_strangerOpens7702DrawAtOnce() public {
        assertEq(eoa7702.code.length, 23, "a delegation designator");
        assertEq(bytes3(eoa7702.code), bytes3(hex"ef0100"));
        _toWordAccepted();
        uint256 target = _target();
        uint256 e0 = eoa7702.balance;
        uint256 id = _draw(eoa7702, AUDIT_DRAW_VALUE);
        assertEq(e0 + AUDIT_DRAW_VALUE - eoa7702.balance, target, "the 7702 drawer got its rest back in full");
        _advance(1);
        _post(r0 + 4);
        _settle(keeper, 1);
        uint256 item = tickets.drawTicket(id).itemId;
        vm.prank(keeper);
        tickets.openDraw(id, keeper, _reveal(item));
        assertEq(collection.ownerOf(item), eoa7702, "at once, to the 7702 drawer");
        _assertTicketsHoldNothing();
        _assertGhostLedger();
    }

    /// P6.4: a contract drawer opens first: a stranger is refused until exactly the drawer's grace (DrawerOpensFirst at
    /// graceAt - 1, accepted at graceAt, to the drawer); the drawer itself opens at once to any address it names.
    function testProperty_AUDIT_U6_contractDrawerOpensFirst() public {
        _toDrawing();
        uint256 item = itemB;
        uint256 graceAt = tickets.drawTicket(drawB).revealFallbackAt;
        ItemReveal memory r = _reveal(item);
        uint256 snap = vm.snapshotState();
        // the drawer's own open, to an address it chooses, at once
        vm.prank(address(contractDrawer));
        tickets.openDraw(drawB, eoa[2], r);
        assertEq(collection.ownerOf(item), eoa[2], "the drawer names the recipient");
        vm.revertToState(snap);

        _warpTo(graceAt - 1);
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.DrawerOpensFirst.selector, drawB, graceAt));
        tickets.openDraw(drawB, eoa[5], r);
        _warpTo(graceAt);
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.RevealRequired.selector, item, graceAt));
        tickets.openDraw(drawB, eoa[5], _noReveal());
        vm.prank(eoa[5]);
        tickets.openDraw(drawB, eoa[5], r);
        assertEq(collection.ownerOf(item), address(contractDrawer), "after the grace, to the drawer only");
        _assertTicketsHoldNothing();
        _assertGhostLedger();
    }

    /// P6.4: the drawer may name any recipient; zero means itself; an EOA drawer too.
    function testProperty_AUDIT_U6_drawerNamesTheRecipient() public {
        _toWordAccepted();
        uint256 d1 = _draw(eoa[3], AUDIT_DRAW_VALUE);
        uint256 d2 = _draw(eoa[4], AUDIT_DRAW_VALUE);
        _advance(1);
        _post(r0 + 4);
        _settle(keeper, 2);
        uint256 i1 = _openDraw(eoa[3], d1, eoa[2], true);
        assertEq(collection.ownerOf(i1), eoa[2], "to the named address");
        uint256 i2 = _openDraw(eoa[4], d2, address(0), true);
        assertEq(collection.ownerOf(i2), eoa[4], "zero: to the drawer");
        vm.prank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.DrawClosed.selector, d2));
        tickets.openDraw(d2, eoa[4], _noReveal());
        _assertGhostLedger();
    }

    /// P6.6: terminal mode's gates: cancel and take-by-number refused before it; draws, settles and the graduation word
    /// refused in it; enterTerminal once.
    function testProperty_AUDIT_U6_terminalGates() public {
        _toSilent();
        vm.expectRevert(IBoxTickets.NotTerminal.selector);
        tickets.cancelDraw(drawC);
        uint256 deadline = vm.getBlockTimestamp();
        vm.expectRevert(IBoxTickets.NotTerminal.selector);
        tickets.takeByNumber(itemA, 0, type(uint256).max, deadline, _noReveal());
        _toTerminal();
        deadline = vm.getBlockTimestamp();
        vm.prank(eoa[3]);
        vm.expectRevert(IBoxTickets.TerminalMode.selector);
        tickets.draw(type(uint256).max, deadline);
        vm.expectRevert(IBoxTickets.TerminalMode.selector);
        tickets.settle(1);
        vm.expectRevert(IBoxTickets.WordAlreadyAccepted.selector);
        tickets.acceptGraduationWord();
        vm.expectRevert(IBoxTickets.TerminalMode.selector);
        tickets.requestGraduationWord();
        vm.expectRevert(IBoxTickets.AlreadyTerminal.selector);
        tickets.enterTerminal();
        // a requested draw cannot be opened in terminal mode, only cancelled
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotSettled.selector, drawC));
        tickets.openDraw(drawC, eoa7702, _noReveal());
        // the settled, unopened draw B still opens (its drawer)
        vm.prank(address(contractDrawer));
        tickets.openDraw(drawB, address(0), _reveal(itemB));
        assertEq(collection.ownerOf(itemB), address(contractDrawer));
        // hand-backs stay closed once the word was stored (placeholders open instead)
        uint256[] memory ids = new uint256[](1);
        ids[0] = 2;
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxTickets.HandBackClosed.selector);
        tickets.handBack(ids, 0, deadline);
        _assertGhostLedger();
    }

    /// BC-100: only the box's coordinator initialises, once; the implementation itself is inert (NotInitialised for
    /// take and setApprovalForAll, NotCoordinator for initialize).
    function testProperty_AUDIT_U6_initializeOnceAndInertImplementation() public {
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxTickets.AlreadyInitialised.selector);
        tickets.initialize();
        vm.prank(eoa[2]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotCoordinator.selector, eoa[2]));
        tickets.initialize();
        BoxTickets impl = BoxTickets(kit.impls().tickets);
        vm.prank(a.coordinator);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotCoordinator.selector, a.coordinator));
        impl.initialize();
        uint256 deadline = vm.getBlockTimestamp();
        vm.expectRevert(IBoxTickets.NotInitialised.selector);
        impl.take(1, type(uint256).max, deadline);
        vm.expectRevert(IBoxTickets.NotInitialised.selector);
        impl.setApprovalForAll(eoa[2], true);
        assertEq(impl.openAt(), 0, "never initialised");
    }
}

/// The same under Amsterdam: the EIP-7702 drawer's case is fork-sensitive (a value call to a delegated account costs
/// more there; R0-A's observation and wave 1's measured fact).
/// forge-config: default.evm_version = "amsterdam"
contract AuditU6ClaudeAccessAmsterdamTest is AuditU6ClaudeAccessTest {}

/// @notice BC-010 for the tickets' entry points, from the drawing phase (set up once, so each fuzz run starts there):
/// placeholders 2-5 live (eoa[0], eoa[1]), draw B settled for the contract drawer, the queue empty.
/// forge-config: default.evm_version = "osaka"
contract AuditU6ClaudeAccessFuzzTest is AuditU6ClaudeBase {
    function setUp() public override {
        super.setUp();
        _toDrawing();
    }

    /// BC-010 on the tickets' entry points: a random caller (no placeholder, no draw, no role) is refused by every
    /// gated entry point with the documented error and changes nothing; its permitted calls (`settle`,
    /// `setApprovalForAll` for its own operators) leave every other account's rights as they were.
    function testFuzz_AUDIT_U6_randomCallerChangesNothing(address caller, uint8 which) public {
        vm.assume(caller != address(0) && caller.code.length == 0 && uint160(caller) > 0x1_0000);
        for (uint256 i; i < 8; ++i) {
            vm.assume(caller != eoa[i]);
        }
        vm.assume(caller != eoa7702 && caller != address(contractDrawer) && caller != a.coordinator);
        vm.assume(caller != address(this) && caller != safe && caller != address(kit));
        IBoxTickets.TicketState memory s0 = tickets.status();
        address[4] memory owners0 = [tickets.ownerOf(2), tickets.ownerOf(3), tickets.ownerOf(4), tickets.ownerOf(5)];
        uint256 graceB = tickets.drawTicket(drawB).revealFallbackAt;
        uint256 deadline = vm.getBlockTimestamp();
        uint256[] memory ids = new uint256[](1);
        ids[0] = 2;
        uint256 w = uint256(which) % 14;
        vm.startPrank(caller);
        if (w == 0) {
            vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotCoordinator.selector, caller));
            tickets.initialize();
        } else if (w == 1) {
            vm.expectRevert(IBoxTickets.TakesClosed.selector);
            tickets.take(1, type(uint256).max, deadline);
        } else if (w == 2) {
            vm.expectRevert(IBoxTickets.HandBackClosed.selector);
            tickets.handBack(ids, 0, deadline);
        } else if (w == 3) {
            vm.expectRevert(IBoxTickets.WordAlreadyRequested.selector);
            tickets.requestGraduationWord();
        } else if (w == 4) {
            vm.expectRevert(IBoxTickets.WordAlreadyAccepted.selector);
            tickets.acceptGraduationWord();
        } else if (w == 5) {
            ItemReveal memory r = _reveal(tickets.numberOf(2));
            vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, caller, 2));
            tickets.open(2, r);
        } else if (w == 6) {
            ItemReveal memory rb = _reveal(itemB);
            vm.expectRevert(abi.encodeWithSelector(IBoxTickets.DrawerOpensFirst.selector, drawB, graceB));
            tickets.openDraw(drawB, caller, rb);
        } else if (w == 7) {
            vm.expectRevert(IBoxTickets.NothingPending.selector);
            tickets.enterTerminal();
        } else if (w == 8) {
            vm.expectRevert(IBoxTickets.NotTerminal.selector);
            tickets.cancelDraw(drawB);
        } else if (w == 9) {
            vm.expectRevert(IBoxTickets.NotTerminal.selector);
            tickets.takeByNumber(itemB, 0, type(uint256).max, deadline, _noReveal());
        } else if (w == 10) {
            vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, caller, 2));
            tickets.transferFrom(eoa[0], caller, 2);
        } else if (w == 11) {
            vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, caller, 2));
            tickets.approve(caller, 2);
        } else if (w == 12) {
            vm.expectRevert(IBoxTickets.NothingSettled.selector);
            tickets.settle(1);
        } else {
            tickets.setApprovalForAll(eoa[1], true);
            assertTrue(tickets.isApprovedForAll(caller, eoa[1]), "its own operator only");
            assertFalse(tickets.isApprovedForAll(eoa[0], caller));
        }
        vm.stopPrank();
        IBoxTickets.TicketState memory s1 = tickets.status();
        assertEq(abi.encode(s1), abi.encode(s0), "the ticket state is unchanged");
        assertEq(tickets.ownerOf(2), owners0[0]);
        assertEq(tickets.ownerOf(3), owners0[1]);
        assertEq(tickets.ownerOf(4), owners0[2]);
        assertEq(tickets.ownerOf(5), owners0[3]);
        assertEq(uint8(tickets.drawTicket(drawB).status), uint8(DrawStatus.Settled));
        assertEq(tickets.balanceOf(caller), 0);
    }
}
