// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {DrawStatus, ItemReveal, TicketPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {TransientReentrancyGuard} from "../../../../src/libraries/TransientReentrancyGuard.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU6FableNoReceiver, AuditU6FableReenterer} from "./AuditU6FableActors.sol";
import {AuditU6FableBase} from "./AuditU6FableBase.sol";

/// @notice SH-AUDIT-B0 U6 (Fable): L2 access and roles (P6.4 with a real EIP-7702 delegation, P6.5, P6.6) and L3
/// reentrancy and callbacks (P6.7, P6.8) on the factory's box 0. Every ETH send of this unit forwards all gas
/// (`DrandWords.payRound`'s refund: `call(gas(), …)`; `DrandSource.withdrawBounty`: all gas), so the Amsterdam variant
/// below pins that the 7702 drawer's refund and its fast open work there too.
/// forge-config: default.evm_version = "osaka"
contract AuditU6FableAccessTest is AuditU6FableBase {
    bytes32 internal constant MIX = keccak256("audit.u6.fable mix");

    function setUp() public virtual override {
        super.setUp();
        _buildRevealCache();
    }

    // ================================================================================================ P6.4 open

    /// P6.4 (BoxTickets.sol:267-282): `open` only by the holder or an operator approved in the current era; the item
    /// always goes to the holder, never to the operator; a stranger and an era-1 operator are refused.
    function testProperty_AUDIT_U6_openOnlyByHolderOrCurrentEraOperator() public {
        _toBonding();
        vm.prank(eoa[0]);
        tickets.setApprovalForAll(eoa[4], true); // era 1
        vm.prank(eoa[0]);
        tickets.approve(eoa[5], 2); // era 1, token 2
        _toDrawing();
        uint256 n2 = tickets.numberOf(2);
        ItemReveal memory r2 = _rv(n2);
        vm.prank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, eoa[4], 2));
        tickets.open(2, r2);
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, eoa[5], 2));
        tickets.open(2, r2);
        vm.prank(eoa[7]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, eoa[7], 2));
        tickets.open(2, r2);
        assertEq(tickets.getApproved(2), address(0), "the era-1 approval does not count");
        assertFalse(tickets.isApprovedForAll(eoa[0], eoa[4]));
        // Era 3 approvals count; the item goes to the holder.
        vm.prank(eoa[0]);
        tickets.setApprovalForAll(eoa[4], true);
        vm.prank(eoa[4]);
        uint256 item = tickets.open(2, r2);
        assertEq(item, n2);
        assertEq(collection.ownerOf(item), eoa[0], "the holder gets the item, not the operator");
        vm.prank(eoa[0]);
        tickets.approve(eoa[5], 3);
        uint256 n3 = tickets.numberOf(3);
        vm.prank(eoa[5]);
        tickets.open(3, _rv(n3));
        assertEq(collection.ownerOf(n3), eoa[0]);
        // Only the holder itself may open without the reveal after the grace (an operator may not).
        vm.prank(eoa[1]);
        tickets.setApprovalForAll(eoa[4], true);
        uint256 graceAt = uint256(_st().wordAcceptedAt) + REVEAL_GRACE;
        _warpTo(graceAt);
        uint256 n4 = tickets.numberOf(4);
        vm.prank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.RevealRequired.selector, n4, graceAt));
        tickets.open(4, _noReveal());
        vm.prank(eoa[1]);
        tickets.open(4, _noReveal());
        assertEq(collection.ownerOf(n4), eoa[1]);
        assertFalse(collection.isRevealed(n4));
        _assertGhostLedger();
    }

    // ================================================================================================ P6.4 openDraw

    /// P6.4 (BoxTickets.sol:284-323; review of sh-core-v1 #3): the drawer opens to any recipient; anyone else opens
    /// an EOA drawer's draw at once, to the drawer (its `to` ignored); a contract drawer's draw only after
    /// REVEAL_GRACE past its settlement, to the drawer; a stranger can never choose the recipient.
    function testProperty_AUDIT_U6_openDrawRecipientRules() public {
        _toDrawing();
        // Draw B (contract drawer, settled, unopened): a stranger is refused until the grace, then serves the drawer.
        uint256 graceAt = _dv(drawB).revealFallbackAt;
        vm.prank(eoa[7]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.DrawerOpensFirst.selector, drawB, graceAt));
        tickets.openDraw(drawB, eoa[7], _rv(itemB));
        // The drawer names any recipient.
        _advance(1);
        uint256 d1 = _draw(eoa[3], AUDIT_DRAW_VALUE);
        uint256 d2 = _draw(eoa[4], AUDIT_DRAW_VALUE);
        uint256 d3 = _draw(address(contractDrawer), AUDIT_DRAW_VALUE);
        uint256 round = _roundOf(d1);
        _silentBackup(round, MIX, eoa[5]);
        assertEq(_settle(keeper, 3), 3);
        uint256 i1 = _dv(d1).itemId;
        uint256 i2 = _dv(d2).itemId;
        uint256 i3 = _dv(d3).itemId;
        uint256 got = _openDraw(eoa[3], d1, eoa[7], true);
        assertEq(got, i1);
        assertEq(collection.ownerOf(i1), eoa[7], "the drawer chose the recipient");
        // A stranger opens an EOA drawer's draw at once, to the drawer, whatever `to` it names.
        got = _openDraw(eoa[5], d2, eoa[5], true);
        assertEq(got, i2);
        assertEq(collection.ownerOf(i2), eoa[4], "to the drawer, not to the stranger's `to`");
        // A contract drawer: refused before the grace, served to the drawer at the grace.
        uint256 g3 = _dv(d3).revealFallbackAt;
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.DrawerOpensFirst.selector, d3, g3));
        tickets.openDraw(d3, eoa[5], _rv(i3));
        _warpTo(g3 - 1);
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.DrawerOpensFirst.selector, d3, g3));
        tickets.openDraw(d3, eoa[5], _rv(i3));
        _warpTo(g3);
        got = _openDraw(eoa[5], d3, eoa[5], true);
        assertEq(got, i3);
        assertEq(collection.ownerOf(i3), address(contractDrawer), "to the contract drawer, never to the stranger");
        // Once opened, closed for everyone.
        vm.prank(address(contractDrawer));
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.DrawClosed.selector, d3));
        tickets.openDraw(d3, address(0), _rv(i3));
        _assertGhostLedger();
    }

    /// P6.4 (AR-17 gap; BoxTickets.sol:302-308, 706-714): a drawer with a real EIP-7702 delegation (23-byte
    /// designator, `vm.signAndAttachDelegation`) counts as a drawer without code: a stranger opens its draw at once,
    /// to the drawer (the delegate's `onERC721Received` runs); the drawer itself may still name any recipient. Pinned
    /// under Osaka and, in the subclass, Amsterdam.
    function testProperty_AUDIT_U6_openDraw7702DrawerServedAtOnceByAnyone() public {
        _toDrawing();
        _advance(1);
        assertEq(eoa7702.code.length, 23, "a delegation designator");
        assertEq(bytes3(eoa7702.code), bytes3(hex"ef0100"));
        uint256 e0 = eoa7702.balance + AUDIT_DRAW_VALUE;
        uint256 d = _draw(eoa7702, AUDIT_DRAW_VALUE);
        assertEq(eoa7702.balance, e0 - _target(), "the 7702 drawer got its rest back (the refund forwards all gas)");
        _silentBackup(_roundOf(d), MIX, eoa[5]);
        assertEq(_settle(keeper, 1), 1);
        uint256 item = _dv(d).itemId;
        assertLt(vm.getBlockTimestamp(), _dv(d).revealFallbackAt, "before the grace");
        uint256 got = _openDraw(eoa[5], d, eoa[5], true);
        assertEq(got, item);
        assertEq(collection.ownerOf(item), eoa7702, "delivered to the 7702 drawer at once, not to the stranger");
        assertTrue(collection.isRevealed(item));
        emit log_named_string("evm", _evm());
        _assertGhostLedger();
    }

    /// P6.4: the drawer may name a recipient, but never one of box 0's own custody addresses: the vault, the
    /// collection, T, the tickets contract (none can take an ERC-721 safe transfer outside a return).
    function testProperty_AUDIT_U6_openDrawToASystemAddressIsRefused() public {
        _toDrawing();
        _advance(1);
        uint256 d = _draw(eoa[3], AUDIT_DRAW_VALUE);
        _silentBackup(_roundOf(d), MIX, eoa[5]);
        assertEq(_settle(keeper, 1), 1);
        uint256 item = _dv(d).itemId;
        address[4] memory system = [a.vault, a.collection, a.token, a.tickets];
        for (uint256 i; i < system.length; ++i) {
            vm.prank(eoa[3]);
            vm.expectRevert();
            tickets.openDraw(d, system[i], _rv(item));
            assertEq(uint8(_dv(d).status), uint8(DrawStatus.Settled), "still settled");
            assertEq(collection.ownerOf(item), a.vault, "the item stays in the vault");
        }
        _assertGhostLedger();
    }

    /// P6.4, a drawer contract without `onERC721Received`: its own open to itself fails (the collection's safe
    /// transfer is refused), nobody else can open it before the grace, but it opens to any EOA it names, so its draw
    /// is not stuck.
    function testProperty_AUDIT_U6_contractDrawerWithoutReceiverOpensToAnEoa() public {
        _toDrawing();
        _advance(1);
        AuditU6FableNoReceiver dumb = new AuditU6FableNoReceiver(address(this));
        _ghostAddOutside(address(dumb));
        _fundDraws(address(dumb), 1);
        dumb.exec(a.token, 0, abi.encodeWithSignature("approve(address,uint256)", a.tickets, type(uint256).max));
        _fund(address(dumb), AUDIT_DRAW_VALUE);
        uint256 t0 = token.balanceOf(address(dumb));
        bytes memory ret = dumb.exec(
            a.tickets, AUDIT_DRAW_VALUE, abi.encodeCall(IBoxTickets.draw, (type(uint256).max, vm.getBlockTimestamp()))
        );
        uint256 d = abi.decode(ret, (uint256));
        _noteEthIn(EthIn.DrawValue, AUDIT_DRAW_VALUE);
        _noteEthOut(EthOut.Refund, AUDIT_DRAW_VALUE - _target());
        _noteTChange(t0, token.balanceOf(address(dumb)), TIn.Draw, TOut.Other);
        _silentBackup(_roundOf(d), MIX, eoa[5]);
        assertEq(_settle(keeper, 1), 1);
        uint256 item = _dv(d).itemId;
        vm.expectRevert();
        dumb.exec(a.tickets, 0, abi.encodeCall(IBoxTickets.openDraw, (d, address(0), _rv(item))));
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.DrawerOpensFirst.selector, d, _dv(d).revealFallbackAt));
        tickets.openDraw(d, eoa[5], _rv(item));
        dumb.exec(a.tickets, 0, abi.encodeCall(IBoxTickets.openDraw, (d, eoa[7], _rv(item))));
        assertEq(collection.ownerOf(item), eoa[7]);
        _assertGhostLedger();
    }

    // ================================================================================================ P6.5 eras

    /// P6.5 (BoxPlaceholderToken.sol:13-16, 147-150): an approval counts only in the era it was given and never in era
    /// 2: era-1 operator and per-token approvals are dead in era 2 (frozen) and era 3; an approval given in era 2 never
    /// counts, not even in era 2; an era-3 approval moves placeholders in era 3; terminal mode without the word is era 3
    /// as well, so an era-1 approval does not count there either.
    function testProperty_AUDIT_U6_approvalsCountOnlyInTheirEra() public {
        _toBonding();
        vm.prank(eoa[0]);
        tickets.setApprovalForAll(eoa[4], true);
        vm.prank(eoa[0]);
        tickets.approve(eoa[5], 2);
        assertTrue(tickets.isApprovedForAll(eoa[0], eoa[4]));
        assertEq(tickets.getApproved(2), eoa[5]);
        vm.prank(eoa[4]);
        tickets.transferFrom(eoa[0], eoa[4], 3); // the era-1 operator moves token 3 in era 1
        assertEq(tickets.ownerOf(3), eoa[4]);
        _toGraduated();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.AwaitingWord), "era 2");
        assertFalse(tickets.isApprovedForAll(eoa[0], eoa[4]), "an era-1 operator does not count in era 2");
        assertEq(tickets.getApproved(2), address(0));
        vm.prank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, eoa[4], 2));
        tickets.transferFrom(eoa[0], eoa[4], 2);
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, eoa[5], 2));
        tickets.transferFrom(eoa[0], eoa[5], 2);
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxTickets.Frozen.selector);
        tickets.transferFrom(eoa[0], eoa[5], 2);
        // An approval given in era 2 never counts.
        vm.prank(eoa[0]);
        tickets.setApprovalForAll(eoa[3], true);
        vm.prank(eoa[0]);
        tickets.approve(eoa[3], 2);
        assertFalse(tickets.isApprovedForAll(eoa[0], eoa[3]), "never in era 2");
        assertEq(tickets.getApproved(2), address(0));
        _toDrawing();
        assertFalse(tickets.isApprovedForAll(eoa[0], eoa[3]), "an era-2 approval is dead in era 3");
        assertEq(tickets.getApproved(2), address(0));
        assertFalse(tickets.isApprovedForAll(eoa[0], eoa[4]), "an era-1 operator is dead in era 3");
        vm.prank(eoa[3]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, eoa[3], 2));
        tickets.transferFrom(eoa[0], eoa[3], 2);
        vm.prank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, eoa[4], 2));
        tickets.transferFrom(eoa[0], eoa[4], 2);
        // Era 3 approvals count in era 3.
        vm.prank(eoa[0]);
        tickets.setApprovalForAll(eoa[4], true);
        vm.prank(eoa[4]);
        tickets.transferFrom(eoa[0], eoa[5], 2);
        assertEq(tickets.ownerOf(2), eoa[5]);
        vm.prank(eoa[5]);
        tickets.approve(eoa[3], 2);
        vm.prank(eoa[3]);
        tickets.transferFrom(eoa[5], eoa[3], 2);
        assertEq(tickets.ownerOf(2), eoa[3]);
        assertEq(tickets.getApproved(2), address(0), "cleared by the transfer");
        _assertGhostLedger();
    }

    /// P6.5 in terminal mode entered without the word (the graduation word dead): era 3, so an era-1 approval is dead
    /// and a fresh one works; number-less hand-backs are open to holders only, `open` is refused (no numbers).
    function testProperty_AUDIT_U6_terminalWithoutWordIsEraThree() public {
        _toBonding();
        vm.prank(eoa[0]);
        tickets.setApprovalForAll(eoa[4], true);
        _toSilentFromGraduation();
        _toTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal));
        assertEq(_st().wordAcceptedAt, 0);
        assertFalse(tickets.isApprovedForAll(eoa[0], eoa[4]), "era 1 is over");
        vm.prank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, eoa[4], 1));
        tickets.transferFrom(eoa[0], eoa[4], 1);
        vm.prank(eoa[0]);
        tickets.setApprovalForAll(eoa[4], true);
        vm.prank(eoa[4]);
        tickets.transferFrom(eoa[0], eoa[4], 1);
        assertEq(tickets.ownerOf(1), eoa[4]);
        assertEq(tickets.numberOf(1), 0, "no number without the word");
        vm.prank(eoa[4]);
        vm.expectRevert(IBoxTickets.WordNotAccepted.selector);
        tickets.open(1, _noReveal());
        // The operator cannot hand back for the holder; the holder can, fee-free (the gate is open).
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotHolder.selector, 1));
        tickets.handBack(_one(1), 0, vm.getBlockTimestamp());
        (uint256 qp, uint256 qf) = vault.quoteHandBack(1);
        assertEq(qf, 0, "fee-free");
        uint256 t0 = token.balanceOf(eoa[4]);
        (uint256 p, uint256 f) = _handBack(eoa[4], _one(1));
        assertEq(p, qp);
        assertEq(f, 0);
        assertEq(token.balanceOf(eoa[4]), t0 + qp);
        assertEq(_st().slots, 5, "q is not compacted after graduation");
        assertEq(vault.pendingTickets(), 4);
        _assertGhostLedger();
    }

    // ================================================================================================ P6.6 terminal

    /// P6.6 (BoxTickets.sol:42-44, 328-387): `enterTerminal` only when the head is dead (anyone), `cancelDraw` only in
    /// terminal mode (anyone, paid to the drawer), `takeByNumber` only in terminal mode from TAKE_DELAY on (anyone);
    /// before graduation terminal entry is refused.
    function testProperty_AUDIT_U6_terminalModeRules() public {
        _toClosed();
        vm.prank(eoa[5]);
        vm.expectRevert(IBoxTickets.NotGraduated.selector);
        tickets.enterTerminal();
        _toDrawing();
        vm.prank(eoa[5]);
        vm.expectRevert(IBoxTickets.NothingPending.selector);
        tickets.enterTerminal();
        vm.prank(eoa[5]);
        vm.expectRevert(IBoxTickets.NotTerminal.selector);
        tickets.cancelDraw(drawB);
        (uint256 item,) = _poolItem(0);
        vm.prank(eoa[5]);
        vm.expectRevert(IBoxTickets.NotTerminal.selector);
        tickets.takeByNumber(item, 0, type(uint256).max, vm.getBlockTimestamp(), _rv(item));
        _toSilent();
        (bool exists, bool dead, uint256 key, uint256 deadline) = _refHead();
        assertTrue(exists && !dead && key == drawC);
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, drawC, deadline));
        tickets.enterTerminal();
        _toTerminal();
        (exists, dead,,) = _refHead();
        assertTrue(exists && dead, "the reference rule agrees: the head was dead");
        // Settled draws (B) are not cancellable, only openable; the Requested one (C) is cancellable by anyone.
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotCancellable.selector, drawB));
        tickets.cancelDraw(drawB);
        _warpTo(_dv(drawB).revealFallbackAt);
        uint256 got = _openDraw(eoa[5], drawB, eoa[5], true);
        assertEq(got, itemB);
        assertEq(collection.ownerOf(itemB), address(contractDrawer), "a settled draw opens in terminal mode");
        uint256 t0 = token.balanceOf(eoa7702);
        uint256 p = _cancelDraw(eoa[5], drawC);
        assertEq(token.balanceOf(eoa7702), t0 + p, "the principal to the drawer, whoever cancels");
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotCancellable.selector, drawC));
        tickets.cancelDraw(drawC);
        // Draws and settles refused for good; takes by number from TAKE_DELAY.
        uint256 deadline2 = vm.getBlockTimestamp();
        vm.prank(eoa[3]);
        vm.expectRevert(IBoxTickets.TerminalMode.selector);
        tickets.draw(type(uint256).max, deadline2);
        vm.expectRevert(IBoxTickets.TerminalMode.selector);
        tickets.settle(1);
        vm.expectRevert(IBoxTickets.AlreadyTerminal.selector);
        tickets.enterTerminal();
        _assertGhostLedger();
    }

    /// L2 (BC-100; BoxTickets.sol:115-125): `initialize` only by the box's coordinator, once; every state-changing
    /// entry point of an uninitialised clone of the implementation is refused.
    function testProperty_AUDIT_U6_initializeOnlyByTheCoordinatorOnce() public {
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotCoordinator.selector, eoa[5]));
        tickets.initialize();
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxTickets.AlreadyInitialised.selector);
        tickets.initialize();
        assertEq(tickets.coordinatorImplementation(), kit.impls().coordinator);
        // The implementation itself: never initialised, refuses takes and approvals.
        IBoxTickets impl = IBoxTickets(_ticketsImpl());
        assertEq(impl.openAt(), 0);
        vm.expectRevert(IBoxTickets.NotInitialised.selector);
        impl.take(1, type(uint256).max, vm.getBlockTimestamp());
        vm.expectRevert(IBoxTickets.NotInitialised.selector);
        impl.setApprovalForAll(eoa[5], true);
    }

    /// L2: `requestGraduationWord` is reachable only while graduation's own poke of it has not run (it is one-shot),
    /// and never before graduation or without placeholders.
    function testProperty_AUDIT_U6_graduationWordRequestedOnce() public {
        _toClosed();
        vm.expectRevert(IBoxTickets.NotGraduated.selector);
        tickets.requestGraduationWord();
        _toGraduated();
        vm.expectRevert(IBoxTickets.WordAlreadyRequested.selector);
        tickets.requestGraduationWord();
        vm.expectRevert(IBoxTickets.WordNotReady.selector);
        tickets.acceptGraduationWord();
        _toDrawing();
        vm.expectRevert(IBoxTickets.WordAlreadyAccepted.selector);
        tickets.acceptGraduationWord();
        vm.expectRevert(IBoxTickets.WordAlreadyRequested.selector);
        tickets.requestGraduationWord();
    }

    // ================================================================================================ P6.7 callbacks

    /// P6.7 (BoxPlaceholderToken.sol:103-114): a placeholder's safe transfer calls `onERC721Received` after the state
    /// is final. The receiver's callback re-enters `take`, `handBack` of the received token and a transfer back: all
    /// succeed (transfers are not under the lock) on final state, and afterwards every live placeholder holds a
    /// distinct slot below q, minted − burned == live, the vault's pending tickets == live: no slot used twice.
    function testProperty_AUDIT_U6_safeTransferCallbackSeesFinalStateOnTheCurve() public {
        _toBonding();
        AuditU6FableReenterer r = new AuditU6FableReenterer(tickets, token, a.collection, address(this));
        _ghostAddOutside(address(r));
        _fundDraws(address(r), 4);
        uint256 live0 = vault.pendingTickets();
        // (a) hand back the received token inside the callback
        r.setPlan(AuditU6FableReenterer.Plan.HandBackReceived, _noReveal());
        uint256 t0 = token.balanceOf(address(r));
        vm.prank(eoa[0]);
        tickets.safeTransferFrom(eoa[0], address(r), 1);
        assertTrue(r.lastOk(), "the hand-back inside the callback passed");
        assertEq(r.receivedToken(), 1);
        _noteTChange(t0, token.balanceOf(address(r)), TIn.Other, TOut.HandBack);
        assertEq(_ownerOrZero(1), address(0), "token 1 burned once");
        assertEq(tickets.balanceOf(address(r)), 0);
        assertEq(tickets.balanceOf(eoa[0]), 2);
        assertEq(vault.pendingTickets(), live0 - 1);
        _assertSlotsConsistentHere(live0 - 1);
        // (b) take one inside the callback
        r.setPlan(AuditU6FableReenterer.Plan.TakeOne, _noReveal());
        t0 = token.balanceOf(address(r));
        vm.prank(eoa[0]);
        tickets.safeTransferFrom(eoa[0], address(r), 2);
        assertTrue(r.lastOk(), "the take inside the callback passed");
        _noteTChange(t0, token.balanceOf(address(r)), TIn.Take, TOut.Other);
        assertEq(tickets.balanceOf(address(r)), 2, "token 2 and the new one");
        assertEq(vault.pendingTickets(), live0);
        _assertSlotsConsistentHere(live0);
        // (c) transfer the received token back inside the callback
        r.setPlan(AuditU6FableReenterer.Plan.TransferBack, _noReveal());
        vm.prank(eoa[1]);
        tickets.safeTransferFrom(eoa[1], address(r), 4);
        assertTrue(r.lastOk(), "the transfer back inside the callback passed");
        assertEq(tickets.ownerOf(4), eoa[1]);
        assertEq(tickets.balanceOf(address(r)), 2);
        _assertSlotsConsistentHere(live0);
        _assertGhostLedger();
    }

    /// P6.7 after the word: the receiver's callback opens the received placeholder (it is the holder by then): the
    /// item is delivered once, to the receiver; a `draw` from the callback passes on final state (no lock on
    /// transfers) and a `settle` reports nothing to settle; the vault's pending tickets stay == live + open draws.
    function testProperty_AUDIT_U6_safeTransferCallbackAfterTheWord() public {
        _toDrawing();
        AuditU6FableReenterer r = new AuditU6FableReenterer(tickets, token, a.collection, address(this));
        _ghostAddOutside(address(r));
        _fundDraws(address(r), 4);
        uint256 n2 = tickets.numberOf(2);
        r.setPlan(AuditU6FableReenterer.Plan.OpenReceived, _rv(n2));
        vm.prank(eoa[0]);
        tickets.safeTransferFrom(eoa[0], address(r), 2);
        assertTrue(r.lastOk(), "open inside the callback passed");
        assertEq(collection.ownerOf(n2), address(r), "delivered once, to the receiver");
        assertEq(_ownerOrZero(2), address(0));
        assertEq(vault.pendingTickets(), 4, "3, 4, 5 live + draw B open");
        // A draw from the callback (the refund goes to this receiver's `receive`, which runs no plan then).
        _advance(1);
        r.setDrawValue(AUDIT_DRAW_VALUE);
        _fund(address(r), AUDIT_DRAW_VALUE);
        r.setPlan(AuditU6FableReenterer.Plan.Draw, _noReveal());
        uint256 t0 = token.balanceOf(address(r));
        uint256 e0 = address(r).balance;
        vm.prank(eoa[0]);
        tickets.safeTransferFrom(eoa[0], address(r), 3);
        assertTrue(r.lastOk(), "draw inside the callback passed");
        _noteEthIn(EthIn.DrawValue, AUDIT_DRAW_VALUE);
        _noteEthOut(EthOut.Refund, address(r).balance + AUDIT_DRAW_VALUE - e0);
        _noteTChange(t0, token.balanceOf(address(r)), TIn.Draw, TOut.Other);
        assertEq(_st().drawsRequested, 3);
        assertEq(_dv(3).drawer, address(r));
        assertEq(vault.pendingTickets(), 5, "3 (now the receiver's), 4, 5 live + draws B and 3 open");
        r.setPlan(AuditU6FableReenterer.Plan.Settle, _noReveal());
        vm.prank(eoa[1]);
        tickets.safeTransferFrom(eoa[1], address(r), 4);
        assertFalse(r.lastOk());
        assertEq(r.lastError(), IBoxTickets.NothingSettled.selector, "settle from the callback: nothing to settle");
        _assertGhostLedger();
    }

    /// P6.7 under the lock (BoxTickets.sol:53-54; the draw's refund and an item's delivery run inside `nonReentrantCall`):
    /// a drawer whose `receive` re-enters `draw` or `settle` during the refund, and a recipient whose `onERC721Received`
    /// re-enters `openDraw`/`open` during an item's delivery, are refused `Reentrancy()`; the outer call completes.
    function testProperty_AUDIT_U6_lockRefusesReentryFromRefundAndDelivery() public {
        _toDrawing();
        _advance(1);
        AuditU6FableReenterer r = new AuditU6FableReenterer(tickets, token, a.collection, address(this));
        _ghostAddOutside(address(r));
        _fundDraws(address(r), 4);
        _fund(address(r), 2 * AUDIT_DRAW_VALUE);
        r.setDrawValue(0);
        r.setPlan(AuditU6FableReenterer.Plan.Draw, _noReveal());
        uint256 t0 = token.balanceOf(address(r));
        uint256 e0 = address(r).balance;
        bytes memory ret = r.exec(
            a.tickets, AUDIT_DRAW_VALUE, abi.encodeCall(IBoxTickets.draw, (type(uint256).max, vm.getBlockTimestamp()))
        );
        uint256 d = abi.decode(ret, (uint256));
        _noteEthIn(EthIn.DrawValue, AUDIT_DRAW_VALUE);
        _noteEthOut(EthOut.Refund, address(r).balance + AUDIT_DRAW_VALUE - e0);
        _noteTChange(t0, token.balanceOf(address(r)), TIn.Draw, TOut.Other);
        assertEq(r.calls(), 1, "the refund arrived");
        assertFalse(r.lastOk());
        assertEq(r.lastError(), TransientReentrancyGuard.Reentrancy.selector, "draw refused inside the refund");
        assertEq(_st().drawsRequested, 3, "only the outer draw");
        r.setPlan(AuditU6FableReenterer.Plan.Settle, _noReveal());
        e0 = address(r).balance;
        t0 = token.balanceOf(address(r));
        r.exec(
            a.tickets, AUDIT_DRAW_VALUE, abi.encodeCall(IBoxTickets.draw, (type(uint256).max, vm.getBlockTimestamp()))
        );
        _noteEthIn(EthIn.DrawValue, AUDIT_DRAW_VALUE);
        _noteEthOut(EthOut.Refund, address(r).balance + AUDIT_DRAW_VALUE - e0);
        _noteTChange(t0, token.balanceOf(address(r)), TIn.Draw, TOut.Other);
        assertEq(r.lastError(), TransientReentrancyGuard.Reentrancy.selector, "settle refused inside the refund");
        // The delivery: the item's receipt re-enters openDraw (the same ticket) and open.
        _silentBackup(_roundOf(d), MIX, eoa[5]);
        assertEq(_settle(keeper, 2), 2);
        uint256 item = _dv(d).itemId;
        r.setPlan(AuditU6FableReenterer.Plan.Settle, _noReveal());
        uint256 calls0 = r.calls();
        r.exec(a.tickets, 0, abi.encodeCall(IBoxTickets.openDraw, (d, address(0), _rv(item))));
        assertEq(collection.ownerOf(item), address(r), "delivered");
        // The collection's safe transfer called the receiver: its settle ran against the tickets' lock.
        assertEq(r.calls(), calls0 + 1, "the delivery's receipt ran");
        assertFalse(r.lastOk());
        assertEq(r.lastError(), TransientReentrancyGuard.Reentrancy.selector, "settle refused inside the delivery");
        assertEq(uint8(_dv(d).status), uint8(DrawStatus.Opened));
        _assertGhostLedger();
    }

    /// @dev Every live placeholder holds a distinct slot below q, q == live (curve).
    function _assertSlotsConsistentHere(uint256 expectLive) internal view {
        (uint256[] memory ids, uint256 live) = _livePlaceholders();
        assertEq(live, expectLive, "live placeholders");
        uint256 q = _st().slots;
        assertEq(q, live, "q == live");
        bool[] memory seen = new bool[](q);
        for (uint256 i; i < live; ++i) {
            uint256 slot = tickets.slotOf(ids[i]);
            assertLt(slot, q);
            assertFalse(seen[slot], "distinct slots");
            seen[slot] = true;
        }
    }

    // ================================================================================================ P6.8 the source

    /// P6.8 (BoxTickets.sol:776-796; DrandWords.sol:23-25): `settle` reads "no word" from a source whose `wordOf`
    /// reverts, answers short, or burns all its gas, within the 50,000-gas read, and changes nothing else; a caller
    /// that leaves too little gas for the read reverts `GasTooLow` instead of reading "no word". Stand-ins: the
    /// pinned source's code replaced (`vm.etch`) or its `wordOf` mocked, after the requests were made through the real
    /// one.
    function testProperty_AUDIT_U6_settleReadsNoWordFromABrokenSourceWithinItsGas() public {
        _toDrawing();
        _advance(1);
        uint256 d = _draw(eoa[3], AUDIT_DRAW_VALUE);
        _silentBackup(_roundOf(d), MIX, eoa[5]);
        assertTrue(_refUsable(d, _dv(d).requestedAt), "the real source has the word");
        bytes memory realCode = address(src).code;
        bytes memory callData = abi.encodeWithSelector(BoxBackedSource.wordOf.selector, a.tickets, d);
        uint256 snap = vm.snapshotState();

        // (i) reverts
        vm.mockCallRevert(address(src), callData, "source down");
        vm.expectRevert(IBoxTickets.NothingSettled.selector);
        tickets.settle(1);
        vm.clearMockedCalls();
        // (ii) short answer
        vm.mockCall(address(src), callData, hex"01");
        vm.expectRevert(IBoxTickets.NothingSettled.selector);
        tickets.settle(1);
        vm.clearMockedCalls();
        // (iii) burns all the gas it gets: still "no word", and the whole settle costs at most the read's 50,000 more
        // than a settle against a source that reverts at once.
        vm.mockCallRevert(address(src), callData, "");
        uint256 g0 = gasleft();
        (bool ok, bytes memory ret) = a.tickets.call(abi.encodeCall(IBoxTickets.settle, (1)));
        uint256 gasRevertingSource = g0 - gasleft();
        assertFalse(ok);
        assertEq(_sel(ret), IBoxTickets.NothingSettled.selector);
        vm.clearMockedCalls();
        vm.etch(address(src), hex"5b600056"); // JUMPDEST PUSH1 0 JUMP: every call to the source burns all its gas
        g0 = gasleft();
        (ok, ret) = a.tickets.call(abi.encodeCall(IBoxTickets.settle, (1)));
        uint256 gasBurningSource = g0 - gasleft();
        assertFalse(ok);
        assertEq(_sel(ret), IBoxTickets.NothingSettled.selector, "a burning source reads as no word");
        assertLe(gasBurningSource, gasRevertingSource + 50_000, "at most the 50,000-gas read more");
        emit log_named_uint("settle gas, source reverting at once", gasRevertingSource);
        emit log_named_uint("settle gas, source burning its whole read", gasBurningSource);
        vm.etch(address(src), realCode);
        assertEq(uint8(_dv(d).status), uint8(DrawStatus.Requested), "nothing changed");
        // (iv) too little caller gas: GasTooLow, never "no word"; enough gas: the real word settles the draw.
        uint256 lowest = type(uint256).max;
        for (uint256 g = 40_000; g <= 400_000; g += 1_000) {
            (ok, ret) = a.tickets.call{gas: g}(abi.encodeCall(IBoxTickets.settle, (1)));
            if (ok) {
                lowest = g;
                break;
            }
            bytes4 s = _sel(ret);
            assertTrue(
                s == IBoxTickets.GasTooLow.selector || ret.length == 0,
                "below the budget: GasTooLow or a plain out-of-gas, never NothingSettled"
            );
            if (s == IBoxTickets.GasTooLow.selector) vm.revertToState(snap);
        }
        assertLt(lowest, type(uint256).max, "a settle with enough gas passed");
        emit log_named_uint("lowest call gas (1,000-gas steps) at which settle(1) passes", lowest);
        assertEq(uint8(_dv(d).status), uint8(DrawStatus.Settled));
        vm.revertToState(snap);
        // The guard is reachable: at the smallest gas the guard refuses, the error is GasTooLow.
        (ok, ret) = a.tickets.call{gas: 58_000}(abi.encodeCall(IBoxTickets.settle, (1)));
        assertFalse(ok);
        assertEq(_sel(ret), IBoxTickets.GasTooLow.selector, "58,000 gas: the read's budget is checked first");
    }

    /// P6.8, the head rule under a broken source: with `wordOf` reverting, a head past its deadline reads as dead and
    /// terminal mode opens, while the real source would have answered (the source's failure is its own; F61 R4's
    /// 7 days decide). Pinned as the documented behaviour, not a finding.
    function testProperty_AUDIT_U6_brokenSourceMakesTheHeadDeadAfterSevenDays() public {
        _toDrawing();
        _advance(1);
        uint256 d = _draw(eoa[3], AUDIT_DRAW_VALUE);
        _silentBackup(_roundOf(d), MIX, eoa[5]);
        _warpTo(uint256(_dv(d).requestedAt) + SILENCE + 1);
        (, bool dead,,) = _refHead();
        assertFalse(dead, "the real source: a usable word, not dead");
        vm.expectRevert();
        tickets.enterTerminal();
        vm.mockCallRevert(address(src), abi.encodeWithSelector(BoxBackedSource.wordOf.selector, a.tickets, d), "");
        tickets.enterTerminal();
        vm.clearMockedCalls();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal));
    }
}

/// The same under Amsterdam: the 7702 drawer's refund and fast open, the lock, the broken-source reads.
/// forge-config: default.evm_version = "amsterdam"
contract AuditU6FableAccessAmsterdamTest is AuditU6FableAccessTest {}
