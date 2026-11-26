// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DrawStatus, ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCollection} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU6ClaudeAgent, AuditU6ClaudeBase} from "./AuditU6ClaudeBase.sol";

/// @notice TEST ONLY. An account that takes ETH and has no ERC-721 receiver (no `onERC721Received`, no fallback): the
/// code an EIP-7702 EOA delegates to in the "rejecting delegate" case, and a contract recipient that refuses tokens.
contract AuditU6ClaudeNoReceiver {
    receive() external payable {}
}

/// @notice TEST ONLY. An ERC-721 receiver that records its call and answers a chosen selector.
contract AuditU6ClaudeRecordingReceiver {
    bytes4 public immutable answer;
    address public operator;
    address public from;
    uint256 public tokenId;
    bytes public data;

    constructor(bytes4 answer_) {
        answer = answer_;
    }

    function onERC721Received(address operator_, address from_, uint256 tokenId_, bytes calldata data_)
        external
        returns (bytes4)
    {
        (operator, from, tokenId, data) = (operator_, from_, tokenId_, data_);
        return answer;
    }
}

/// @notice U6 lenses L2 and L3 on the placeholder's ERC-721 surface and the draw's recipients, on the factory's box 0:
/// the transfer guards (`BoxPlaceholderToken.sol:81-97`, F25 (3)), the receiver check of `safeTransferFrom`
/// (`:99-114`), approvals given while frozen (`:13-16, 147-150`), P6.7's "draw" from a receiver's hook, the EIP-7702
/// recipients of P6.4 and P6.3 with real delegations (`vm.signAndAttachDelegation`; a delegate without an ERC-721
/// receiver, a delegate whose `receive` costs more than a 2,300-gas stipend), and the events' documented fields
/// (`IBoxTickets.sol:52-80`).
/// forge-config: default.evm_version = "osaka"
contract AuditU6ClaudeSurfaceTest is AuditU6ClaudeBase {
    function _isAmsterdam() internal pure returns (bool) {
        return keccak256(bytes(vm.getEvmVersion())) == keccak256("amsterdam");
    }

    /// @dev A fresh EOA with a real EIP-7702 delegation to `delegate` (chain id 1, nonce 0), holding `t` T from eoa[2].
    function _delegated(string memory label, address delegate, uint256 t) internal returns (address e) {
        uint256 key;
        (e, key) = makeAddrAndKey(label);
        vm.signAndAttachDelegation(delegate, key);
        (bool ok,) = e.call("");
        require(ok, "the authorization's call");
        assertEq(e.code.length, 23, "a delegation designator");
        assertEq(bytes3(e.code), bytes3(hex"ef0100"));
        _ghostAddOutside(e);
        if (t != 0) _giveT(eoa[2], e, t);
    }

    /// The transfer guards in era 1: refused to zero, this contract, the vault, the collection and T; a wrong `from`; a
    /// caller without rights; nonexistent ids on every read and write; balanceOf(0); an approval is cleared by a
    /// transfer, and the transfer moves exactly one balance unit.
    function testProperty_AUDIT_U6_placeholderTransferGuards() public {
        _toBonding();
        address[5] memory refused = [address(0), a.tickets, a.vault, a.collection, a.token];
        for (uint256 i; i < 5; ++i) {
            vm.prank(eoa[0]);
            vm.expectRevert(abi.encodeWithSelector(IBoxTickets.DirectSendRefused.selector, refused[i]));
            tickets.transferFrom(eoa[0], refused[i], 1);
        }
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.WrongFrom.selector, eoa[1], eoa[0]));
        tickets.transferFrom(eoa[1], eoa[2], 1);
        vm.prank(eoa[2]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, eoa[2], 1));
        tickets.transferFrom(eoa[0], eoa[2], 1);
        vm.prank(eoa[2]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, eoa[2], 1));
        tickets.approve(eoa[2], 1);
        bytes memory gone = abi.encodeWithSelector(IBoxTickets.NonexistentToken.selector, 999);
        vm.expectRevert(gone);
        tickets.ownerOf(999);
        vm.expectRevert(gone);
        tickets.getApproved(999);
        vm.expectRevert(gone);
        tickets.slotOf(999);
        vm.expectRevert(gone);
        tickets.numberOf(999);
        vm.prank(eoa[0]);
        vm.expectRevert(gone);
        tickets.approve(eoa[2], 999);
        vm.prank(eoa[0]);
        vm.expectRevert(gone);
        tickets.transferFrom(eoa[0], eoa[2], 999);
        vm.expectRevert(IBoxTickets.ZeroAddress.selector);
        tickets.balanceOf(address(0));

        vm.prank(eoa[0]);
        tickets.approve(eoa[3], 1);
        assertEq(tickets.getApproved(1), eoa[3]);
        uint256 b0 = tickets.balanceOf(eoa[0]);
        uint256 b4 = tickets.balanceOf(eoa[4]);
        vm.prank(eoa[3]);
        tickets.transferFrom(eoa[0], eoa[4], 1);
        assertEq(tickets.getApproved(1), address(0), "the approval is cleared by the transfer");
        assertEq(tickets.balanceOf(eoa[0]), b0 - 1);
        assertEq(tickets.balanceOf(eoa[4]), b4 + 1);
        vm.prank(eoa[3]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, eoa[3], 1));
        tickets.transferFrom(eoa[4], eoa[3], 1);
        _assertSlotsAndTickets();
    }

    /// `safeTransferFrom`'s receiver check: an EOA gets no call; a contract without a receiver and one answering a
    /// wrong selector are refused (`UnsafeRecipient`); a receiver's own revert reason bubbles; the call carries
    /// (operator, from, id, data); an EIP-7702 EOA is called through its delegate (refused when the delegate has no
    /// receiver, accepted when it has one).
    function testProperty_AUDIT_U6_placeholderSafeTransferReceivers() public {
        _toBonding();
        AuditU6ClaudeNoReceiver none = new AuditU6ClaudeNoReceiver();
        AuditU6ClaudeRecordingReceiver wrong = new AuditU6ClaudeRecordingReceiver(bytes4(0xdeadbeef));
        AuditU6ClaudeRecordingReceiver good = new AuditU6ClaudeRecordingReceiver(bytes4(0x150b7a02));
        AuditU6ClaudeAgent refusing = _agent(eoa[0], 0);
        refusing.setRefuse(false, true);
        address rejecting7702 = _delegated("u6.7702.noReceiver", address(none), 0);

        vm.startPrank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.UnsafeRecipient.selector, address(none)));
        tickets.safeTransferFrom(eoa[0], address(none), 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.UnsafeRecipient.selector, address(wrong)));
        tickets.safeTransferFrom(eoa[0], address(wrong), 1);
        vm.expectRevert(bytes("agent refuses NFTs"));
        tickets.safeTransferFrom(eoa[0], address(refusing), 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.UnsafeRecipient.selector, rejecting7702));
        tickets.safeTransferFrom(eoa[0], rejecting7702, 1);
        tickets.safeTransferFrom(eoa[0], address(good), 1, hex"c0ffee");
        tickets.safeTransferFrom(eoa[0], eoa7702, 2);
        tickets.safeTransferFrom(eoa[0], eoa[5], 3);
        vm.stopPrank();
        assertEq(good.operator(), eoa[0]);
        assertEq(good.from(), eoa[0]);
        assertEq(good.tokenId(), 1);
        assertEq(good.data(), hex"c0ffee");
        assertEq(tickets.ownerOf(1), address(good));
        assertEq(tickets.ownerOf(2), eoa7702, "a 7702 EOA whose delegate takes ERC-721");
        assertEq(tickets.ownerOf(3), eoa[5]);
        _assertSlotsAndTickets();
    }

    /// P6.5 while frozen: approve and setApprovalForAll still succeed and emit their standard events, but the approval
    /// never counts, neither in era 2 nor in era 3 (`_counts`: same era and never era 2); the owner itself is frozen.
    function testProperty_AUDIT_U6_frozenApprovalsEmitButNeverCount() public {
        _toGraduated();
        vm.expectEmit(a.tickets);
        emit IBoxTickets.ApprovalForAll(eoa[0], eoa[6], true);
        vm.prank(eoa[0]);
        tickets.setApprovalForAll(eoa[6], true);
        vm.expectEmit(a.tickets);
        emit IBoxTickets.Approval(eoa[0], eoa[6], 1);
        vm.prank(eoa[0]);
        tickets.approve(eoa[6], 1);
        assertFalse(tickets.isApprovedForAll(eoa[0], eoa[6]), "era 2: does not count");
        assertEq(tickets.getApproved(1), address(0));
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxTickets.Frozen.selector);
        tickets.transferFrom(eoa[0], eoa[2], 1);
        _advance(1);
        _post(r0);
        tickets.acceptGraduationWord();
        assertFalse(tickets.isApprovedForAll(eoa[0], eoa[6]), "era 3: an era-2 approval still does not count");
        assertEq(tickets.getApproved(1), address(0));
        ItemReveal memory r = _reveal(tickets.numberOf(1));
        vm.prank(eoa[6]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, eoa[6], 1));
        tickets.open(1, r);
        vm.prank(eoa[6]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, eoa[6], 1));
        tickets.transferFrom(eoa[0], eoa[6], 1);
    }

    /// P6.7 "draw": a receiver that, from its `onERC721Received` hook in era 3, draws (paying T and the round's
    /// bounty, its rest refunded into the same hook), opens the placeholder it was just given, tries to open it again
    /// and to settle: the draw and the open pass on final state, the second open finds the token burned, the settle
    /// finds nothing; nothing stays in the tickets contract.
    function testProperty_AUDIT_U6_receiverDrawsFromItsHook() public {
        _toDrawing();
        AuditU6ClaudeAgent ag = _agent(eoa[2], 10 * vault.quoteWithdraw(1));
        ag.exec(address(token), 0, abi.encodeCall(token.approve, (a.tickets, type(uint256).max)));
        uint256 value = 3 * _target();
        vm.deal(address(ag), value);
        uint256 deadline = vm.getBlockTimestamp();
        uint256 item2 = tickets.numberOf(2);
        ItemReveal memory rv = _reveal(item2);
        uint256 nextId = uint256(tickets.status().drawsRequested) + 1;
        ag.addOnNft(a.tickets, value, abi.encodeCall(tickets.draw, (type(uint256).max, deadline)));
        ag.addOnNft(a.tickets, 0, abi.encodeCall(tickets.open, (2, rv)));
        ag.addOnNft(a.tickets, 0, abi.encodeCall(tickets.open, (2, rv)));
        ag.addOnNft(a.tickets, 0, abi.encodeCall(tickets.settle, (1)));
        uint256 e0 = address(ag).balance;
        uint256 t0 = token.balanceOf(address(ag));
        vm.prank(eoa[0]);
        tickets.safeTransferFrom(eoa[0], address(ag), 2);
        _noteEthChange(e0, address(ag).balance, EthIn.DrawValue, EthOut.Refund);
        _noteTChange(t0, token.balanceOf(address(ag)), TIn.Draw, TOut.Other);
        bytes[] memory res = ag.nftResults();
        assertEq(res.length, 4);
        (bool ok, bytes memory ret) = abi.decode(res[0], (bool, bytes));
        assertTrue(ok, "a draw from the hook");
        assertEq(abi.decode(ret, (uint256)), nextId);
        (ok, ret) = abi.decode(res[1], (bool, bytes));
        assertTrue(ok, "the open from the hook");
        assertEq(abi.decode(ret, (uint256)), item2);
        (ok, ret) = abi.decode(res[2], (bool, bytes));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(IBoxTickets.NonexistentToken.selector, 2), "a slot is used once");
        (ok, ret) = abi.decode(res[3], (bool, bytes));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(IBoxTickets.NothingSettled.selector), "its round is not posted yet");
        assertEq(collection.ownerOf(item2), address(ag));
        assertEq(tickets.drawTicket(nextId).drawer, address(ag));
        assertEq(address(ag).balance, value - _target(), "the first draw of its round paid the pot, the rest came back");
        _assertTicketsHoldNothing();
        _assertSlotsAndTickets();
        _assertGhostLedger();
    }

    /// P6.4 with a real EIP-7702 delegation to code that has no ERC-721 receiver: the draw's refund arrives (all gas);
    /// a stranger may try at once (a delegated EOA counts as one without code) but the delivery reverts in the
    /// collection's receiver check (`ERC721InvalidReceiver`), also after the grace, so the draw stays settled; only the
    /// drawer opens it, to an address it names. Nothing is locked: the key holder always can.
    function testProperty_AUDIT_U6_sevenSevenOhTwoDrawerWithoutReceiver() public {
        _toWordAccepted();
        AuditU6ClaudeNoReceiver none = new AuditU6ClaudeNoReceiver();
        address e = _delegated("u6.7702.rejecting", address(none), 20 * vault.quoteWithdraw(1));
        uint256 target = _target();
        uint256 eth0 = e.balance;
        uint256 id = _draw(e, 4 * target);
        assertEq(eth0 + 4 * target - e.balance, target, "the rest came back in full through the delegate");
        _advance(1);
        _post(r0 + 4);
        _settle(keeper, 1);
        IBoxTickets.DrawView memory v = tickets.drawTicket(id);
        ItemReveal memory r = _reveal(v.itemId);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidReceiver.selector, e));
        tickets.openDraw(id, keeper, r);
        _warpTo(v.revealFallbackAt);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidReceiver.selector, e));
        tickets.openDraw(id, keeper, r);
        assertEq(uint8(tickets.drawTicket(id).status), uint8(DrawStatus.Settled), "still settled, not lost");
        vm.prank(e);
        tickets.openDraw(id, eoa[2], r);
        assertEq(collection.ownerOf(v.itemId), eoa[2], "the drawer names the recipient");
        _assertTicketsHoldNothing();
        _assertGhostLedger();
    }

    /// P6.3 and the wave-1 fact on a real EIP-7702 delegation whose `receive` writes storage (more than a 2,300-gas
    /// stipend allows): the draw's refund (DrandWords.payRound's call with all the gas) arrives in full on Osaka and
    /// Amsterdam; a stranger's open delivers into it at once; the control `send` (2,300 stipend) to the same account
    /// fails on both EVMs while a plain call passes.
    function testProperty_AUDIT_U6_sevenSevenOhTwoDrawerWithCostlyReceive() public {
        _toWordAccepted();
        AuditU6ClaudeAgent impl = new AuditU6ClaudeAgent(address(this));
        address e = _delegated("u6.7702.costly", address(impl), 20 * vault.quoteWithdraw(1));
        uint256 target = _target();
        uint256 eth0 = e.balance;
        uint256 id = _draw(e, 4 * target);
        assertEq(eth0 + 4 * target - e.balance, target, "refund of 3 x target arrived");
        assertEq(AuditU6ClaudeAgent(payable(e)).ethReceived(), 3 * target, "through the delegate's costly receive");
        _advance(1);
        _post(r0 + 4);
        _settle(keeper, 1);
        uint256 item = tickets.drawTicket(id).itemId;
        vm.prank(keeper);
        tickets.openDraw(id, keeper, _reveal(item));
        assertEq(collection.ownerOf(item), e, "a stranger delivered to the delegated drawer at once");
        assertEq(AuditU6ClaudeAgent(payable(e)).nftCalls(), 1);
        vm.deal(address(this), 2);
        bool sent = payable(e).send(1);
        assertFalse(sent, "a stipend cannot pay a receive that writes storage, on either EVM");
        (bool ok,) = e.call{value: 1}("");
        assertTrue(ok, "a call with gas can");
        emit log_named_string("evm", vm.getEvmVersion());
        _assertTicketsHoldNothing();
        _assertGhostLedger();
    }

    /// The events carry the documented fields (`IBoxTickets.sol:52-80`; Low lens: wrong events): a take, a hand-back,
    /// graduation's word request, the word's storage, a draw (its bounty), a settlement (item and word), a
    /// placeholder's and a draw's open (`outsideSince`: graduation for a placeholder, the request for a draw), terminal
    /// entry (the dead key), a cancel and a take by number.
    function testProperty_AUDIT_U6_eventsCarryTheDocumentedFields() public {
        _eventsOnTheCurve();
        _eventsAtGraduation();
        uint256 id = _eventsOfADraw();
        _eventsOfTheOpens(id);
        _eventsInTerminalMode();
        _assertGhostLedger();
    }

    function _eventsOnTheCurve() internal {
        _toBonding();
        _approveT(eoa[3], a.tickets);
        (uint256 p, uint256 f) = vault.quoteTake(2);
        uint256 firstId_ = uint256(tickets.status().minted) + 1;
        uint256 firstSlot = tickets.status().slots;
        uint256 dl = vm.getBlockTimestamp();
        vm.expectEmit(a.tickets);
        emit IBoxTickets.PlaceholdersTaken(eoa[3], firstId_, 2, p, f, firstSlot);
        vm.prank(eoa[3]);
        tickets.take(2, type(uint256).max, dl);
        _noteTIn(TIn.Take, p + f);
        uint256[] memory one = new uint256[](1);
        one[0] = firstId_;
        (uint256 hp, uint256 hf) = vault.quoteHandBack(1);
        vm.expectEmit(a.tickets);
        emit IBoxTickets.PlaceholdersHandedBack(eoa[3], 1, hp, hf);
        vm.prank(eoa[3]);
        tickets.handBack(one, 0, dl);
        _noteTOut(TOut.HandBack, hp - hf);
    }

    function _eventsAtGraduation() internal {
        _toClosed();
        _warpTo(_requestTimeFor(r0));
        vm.expectEmit(a.tickets);
        emit IBoxTickets.GraduationWordRequested(a.coordinator, r0, 0);
        vm.prank(keeper);
        coordinator.graduate();
        reached = AuditPhase.Graduated;
        _advance(1);
        _post(r0);
        (bytes32 w, uint64 readyAt) = src.wordOf(a.tickets, 0);
        uint256 q = tickets.status().slots;
        vm.expectEmit(a.tickets);
        emit IBoxTickets.GraduationWordStored(w, q, readyAt);
        tickets.acceptGraduationWord();
    }

    function _eventsOfADraw() internal returns (uint256 id) {
        (uint256 p, uint256 f) = vault.quoteTake(1);
        uint256 round = _roundNow();
        uint256 target = _target();
        _approveT(eoa[4], a.tickets);
        _fund(eoa[4], 2 * target);
        uint256 dl = vm.getBlockTimestamp();
        id = uint256(tickets.status().drawsRequested) + 1;
        vm.expectEmit(a.tickets);
        emit IBoxTickets.DrawRequested(id, eoa[4], p, f, round, target);
        vm.prank(eoa[4]);
        tickets.draw{value: 2 * target}(type(uint256).max, dl);
        _noteEthIn(EthIn.DrawValue, target); // the rest came back
        _noteTIn(TIn.Draw, p + f);
        _advance(1);
        _post(round);
        uint256 item = _replayItems(id)[id];
        (bytes32 dw,) = src.wordOf(a.tickets, id);
        vm.expectEmit(a.tickets);
        emit IBoxTickets.DrawSettled(id, item, dw);
        tickets.settle(1);
    }

    function _eventsOfTheOpens(uint256 id) internal {
        uint256 item = tickets.drawTicket(id).itemId;
        ItemReveal memory r = _reveal(item);
        uint256 requestedAt = tickets.drawTicket(id).requestedAt;
        vm.expectEmit(a.tickets);
        emit IBoxTickets.Opened(id, 2, item, eoa[5], true, requestedAt);
        vm.prank(eoa[4]);
        tickets.openDraw(id, eoa[5], r);
        uint256 itemP = tickets.numberOf(1);
        ItemReveal memory rp = _reveal(itemP);
        uint256 gateAt = vault.gateOpenedAt();
        vm.expectEmit(a.tickets);
        emit IBoxTickets.Opened(1, 1, itemP, eoa[0], true, gateAt);
        vm.prank(eoa[0]);
        tickets.open(1, rp);
    }

    function _eventsInTerminalMode() internal {
        _warpTo(vm.getBlockTimestamp() + 1 hours);
        uint256 silent = _draw(eoa[5], AUDIT_DRAW_VALUE);
        uint256 enterAt = tickets.drawTicket(silent).requestedAt + tickets.SILENCE() + 1;
        _warpTo(enterAt);
        vm.expectEmit(a.tickets);
        emit IBoxTickets.TerminalModeEntered(enterAt, silent);
        tickets.enterTerminal();
        uint256 quote = vault.quoteReturn(1);
        vm.expectEmit(a.tickets);
        emit IBoxTickets.TicketCancelled(silent, eoa[5], quote);
        vm.prank(eoa[7]);
        tickets.cancelDraw(silent);
        _noteTOut(TOut.Cancel, quote);
        _warpTo(uint256(tickets.status().terminalAt) + tickets.TAKE_DELAY());
        (uint256 poolItem,) = _poolItem(3);
        (uint256 p, uint256 f) = vault.quoteTake(1);
        _approveT(eoa[2], a.tickets);
        uint256 dl = vm.getBlockTimestamp();
        vm.expectEmit(a.tickets);
        emit IBoxTickets.TakenByNumber(eoa[2], poolItem, p, f, false);
        vm.prank(eoa[2]);
        tickets.takeByNumber(poolItem, 3, type(uint256).max, dl, _noReveal());
        _noteTIn(TIn.TakeByNumber, p + f);
    }
}

/// The same under Amsterdam: the EIP-7702 cases are fork-sensitive (wave 1's measured fact).
/// forge-config: default.evm_version = "amsterdam"
contract AuditU6ClaudeSurfaceAmsterdamTest is AuditU6ClaudeSurfaceTest {}
