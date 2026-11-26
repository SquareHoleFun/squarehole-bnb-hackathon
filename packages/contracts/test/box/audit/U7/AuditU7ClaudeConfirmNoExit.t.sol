// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxCollection} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxItemStream} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {AuditU7FableBase} from "./AuditU7FableBase.sol";

/// @title AuditU7ClaudeConfirmNoExitTest (SH-AUDIT-B0-FINAL; register row W3-U7-1, FQ-41, R66-LOST, F147)
/// @notice The wave 3b confirmer's (Opus 5.5) four scratch probes around Fable's U7 proof 25
/// (`testAccepted_AUDIT_U7_25_itemSentToTheStreamIsLostAndItsShareStaysReserved`), pinned as properties now that the
/// founder accepted the class (F147, R66-LOST: an item or a placeholder a holder sends with the unsafe `transferFrom`
/// to a box 0 contract has no exit; it is on the accepted no-exit list in F126's row). They ran green at `90422e8d6`
/// as `test/box/audit/U7/ZTriage3bProbe.t.sol` (kept only in the session scratchpad, `triage-wave3-b.md` § 2.1, § 2.2,
/// § 4); here they are the same steps and assertions under property names, with the probe's console logs left out.
/// What they pin: only the owner, its approved address or its operator can make the send (and every safe path of the
/// vault refuses a box contract); nobody else's money or items change (15 values equal against an owner who keeps the
/// item and never claims); at the eight other box contracts the item has no exit and anyone's `claimFor` moves its
/// share into that contract (burned at FIT's executor by its next `execute`); and a live placeholder sent to the stream
/// can never be opened.
/// forge-config: default.evm_version = "osaka"
contract AuditU7ClaudeConfirmNoExitTest is AuditU7FableBase {
    address internal picker;
    address internal other;
    uint256 internal item;
    uint256 internal otherItem;

    /// @dev What everyone else sees after one fee flow (the probe's `Obs`).
    struct Obs {
        uint256 j;
        uint256 streamBal;
        uint256 liab;
        uint256 claimed;
        uint256 burned;
        uint256 supply;
        uint256 e;
        uint256 n;
        uint256 m;
        uint256 av;
        uint256 qw;
        uint256 qr;
        uint256 otherPending;
        uint256 itemPending;
        address itemRecorded;
        uint256 pickerOwed;
        uint256 streamOutside;
        uint256 otherPaid;
    }

    function setUp() public override {
        super.setUp();
        _toDrawing();
        _buildTree();
        _stockShelf();
        picker = eoa[4];
        other = eoa[3];
        (uint256 p, uint256 f) = _pickQuote(shelf.length);
        _fundT(picker, 2 * (p + f));
        _fundT(other, 2 * (p + f));
    }

    function _fees() internal {
        _buy(eoa[5], 1 ether);
        _sell(eoa[2], token.balanceOf(eoa[2]) / 10);
        _advance(12);
        _collect(keeper, keeper);
    }

    function _observe() internal view returns (Obs memory o) {
        o.j = stream.index();
        o.streamBal = token.balanceOf(a.itemStream);
        o.liab = stream.liabilities();
        (o.claimed, o.burned) = stream.totals();
        o.supply = token.totalSupply();
        o.e = vault.escrowPrincipal();
        o.n = vault.inside();
        o.m = vault.outside();
        o.av = vault.activeSupply();
        o.qw = vault.quoteWithdraw(1);
        o.qr = vault.quoteReturn(1);
        (, o.otherPending) = stream.pendingOf(otherItem);
        (o.itemRecorded, o.itemPending) = stream.pendingOf(item);
        o.pickerOwed = stream.owedOf(picker);
        o.streamOutside = stream.outsideCount();
    }

    function _flow() internal returns (Obs memory o) {
        _fees();
        stream.burn();
        o = _observe();
        o.otherPaid = _claimStream(other, _ids1(otherItem));
    }

    /// Who can make the unsafe send (probe `test_T3B_whoCanSend`): a stranger is refused; the owner's approved address,
    /// its operator and the owner itself can send an item into a box contract; a contract drawer naming the stream as
    /// its draw's recipient is refused (the vault delivers with the safe path).
    function testProperty_AUDIT_U7_whoCanSendWithTransferFrom() public {
        uint256 id1 = shelf[0];
        uint256 id2 = shelf[1];
        uint256 id3 = shelf[2];
        _pick(picker, id1);
        _pick(picker, id2);
        _pick(picker, id3);
        // A stranger: refused.
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InsufficientApproval.selector, eoa[7], id1));
        vm.prank(eoa[7]);
        collection.transferFrom(picker, a.itemStream, id1);
        // The owner's single-token approval: accepted.
        vm.prank(picker);
        collection.approve(eoa[6], id1);
        vm.prank(eoa[6]);
        collection.transferFrom(picker, a.itemStream, id1);
        assertEq(collection.ownerOf(id1), a.itemStream, "approved address sent it");
        // The owner's operator: accepted, to another box contract.
        vm.prank(picker);
        collection.setApprovalForAll(eoa[7], true);
        vm.prank(eoa[7]);
        collection.transferFrom(picker, a.coordinator, id2);
        assertEq(collection.ownerOf(id2), a.coordinator, "operator sent it");
        // The owner itself.
        vm.prank(picker);
        collection.transferFrom(picker, a.hook, id3);
        assertEq(collection.ownerOf(id3), a.hook, "owner sent it");
        // Draw B (the contract drawer's) is settled: a delivery to the stream goes through the vault's safe path.
        uint256 itemB_ = tickets.drawTicket(drawB).itemId;
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidReceiver.selector, a.itemStream));
        vm.prank(address(contractDrawer));
        tickets.openDraw(drawB, a.itemStream, _revealOf(itemB_));
    }

    /// Others unchanged (probe `test_T3B_othersUnchangedAgainstAnIdleOwner`): from one snapshot, world X (the owner
    /// keeps the item and never claims) and world Y (the owner sends it to the stream) see the same fees, burn and
    /// another owner's claim; all 15 values anyone else sees are equal. The sender keeps its accrual before the send;
    /// the stream's own slot can never be claimed (`SelfClaim`) and the former owner is no longer its owner.
    function testProperty_AUDIT_U7_othersUnchangedAgainstAnIdleOwner() public {
        item = shelf[0];
        otherItem = shelf[1];
        _pick(picker, item);
        _pick(other, otherItem);
        _fees(); // the picker's item accrues before any send
        (, uint256 preSend) = stream.pendingOf(item);
        assertGt(preSend, 0, "the item accrued before the send");
        uint256 snap = vm.snapshotState();

        Obs memory x = _flow();

        require(vm.revertToState(snap), "revert X");
        vm.prank(picker);
        collection.transferFrom(picker, a.itemStream, item);
        // The transfer checkpoint books the accrual up to the send to the sender.
        uint256 owedAtSend = stream.owedOf(picker);
        assertEq(owedAtSend, preSend, "the accrual before the send is booked to the sender");
        Obs memory y = _flow();
        // The sender can still claim what accrued before the send. Measured: the claim pays one raw unit less than
        // owed (a claim pays what the stream holds and keeps the rest owed, IBoxItemStream.sol; W2-U5-1's bound).
        uint256 t0 = token.balanceOf(picker);
        vm.prank(picker);
        uint256 paidPre = stream.claim(new uint256[](0), picker);
        assertEq(token.balanceOf(picker) - t0, paidPre, "the pre-send accrual is paid");
        assertGt(paidPre, 0);
        assertLe(owedAtSend - paidPre, 1, "within a raw unit of what was owed");
        vm.expectRevert(IBoxItemStream.SelfClaim.selector);
        stream.claimFor(a.itemStream, _ids1(item));
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotOwner.selector, item, picker));
        vm.prank(picker);
        stream.claim(_ids1(item), picker);

        // Everyone else sees the same world in X and Y.
        assertEq(y.j, x.j, "J");
        assertEq(y.streamBal, x.streamBal, "stream balance");
        assertEq(y.liab, x.liab, "liabilities");
        assertEq(y.claimed, x.claimed, "claimed");
        assertEq(y.burned, x.burned, "burned");
        assertEq(y.supply, x.supply, "supply");
        assertEq(y.e, x.e, "E");
        assertEq(y.n, x.n, "n");
        assertEq(y.m, x.m, "outside");
        assertEq(y.av, x.av, "A");
        assertEq(y.qw, x.qw, "pick quote");
        assertEq(y.qr, x.qr, "return quote");
        assertEq(y.otherPending, x.otherPending, "other's pending");
        assertEq(y.otherPaid, x.otherPaid, "other's claim");
        assertEq(y.streamOutside, x.streamOutside, "stream outside count");
        // Only the item's record and where its own accrual sits differ.
        assertEq(y.itemPending, x.itemPending - preSend, "the slot's accrual since the send, the stream's now");
        assertEq(y.itemRecorded, a.itemStream);
        assertEq(x.itemRecorded, picker);
        _assertVlt08("idle owner against a send to the stream");
    }

    /// The eight other box contracts as holders (probe `test_T3B_otherBoxContractsAsHolder`): the item has no exit
    /// (nobody can return or move it), and a stranger's `claimFor` pays the slot's share to the contract itself, where
    /// it stays (M01 at the receiver, M02 at the royalty router, M25 at the others), except at FIT's executor, whose
    /// next `execute(1)` burns every T it holds.
    function testProperty_AUDIT_U7_otherBoxContractsAsHolder() public {
        uint256 id = shelf[0];
        _pick(picker, id);
        address[8] memory targets =
            [a.receiver, a.coordinator, a.hook, a.executor, a.launchRouter, a.tickets, a.royaltyRouter, a.table];
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < targets.length; ++i) {
            require(vm.revertToState(snap), "revert");
            address t = targets[i];
            vm.prank(picker);
            collection.transferFrom(picker, t, id);
            assertEq(collection.ownerOf(id), t);
            assertTrue(vault.isOutside(id));
            _fees();
            (address rec,) = stream.pendingOf(id);
            assertEq(rec, t, "the stream records the box contract");
            uint256 b0 = token.balanceOf(t);
            vm.prank(eoa[7]);
            uint256 paid = stream.claimFor(t, _ids1(id));
            assertGt(paid, 0, "the slot earned a share");
            assertEq(token.balanceOf(t) - b0, paid, "a stranger's claimFor pays the box contract");
            vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotOwner.selector, id));
            vm.prank(picker);
            vault.returnItem(id, 0, block.timestamp);
            vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InsufficientApproval.selector, picker, id));
            vm.prank(picker);
            collection.transferFrom(t, picker, id);
            if (t == a.executor) {
                executor.execute(1);
                assertEq(token.balanceOf(t), 0, "the executor burns every T it holds");
            }
            _assertVlt08("box contract holder");
        }
    }

    /// The placeholder twin (probe `test_T3B_placeholderSentToTheStream`): a live placeholder sent with the plain
    /// `transferFrom` to the stream can never be opened; its item stays hidden in the vault, its ticket pending, and
    /// the stream still counts it as an open placeholder. The safe path refuses the same send.
    function testProperty_AUDIT_U7_placeholderSentToTheStream() public {
        uint256 tokenId = 5;
        assertEq(tickets.ownerOf(tokenId), eoa[1], "placeholder 5 is eoa[1]'s");
        uint256 itemNo = tickets.numberOf(tokenId);
        uint256 t0 = vault.pendingTickets();
        (uint256 ph0,,) = stream.openTickets();
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.UnsafeRecipient.selector, a.itemStream));
        vm.prank(eoa[1]);
        tickets.safeTransferFrom(eoa[1], a.itemStream, tokenId);
        vm.prank(eoa[1]);
        tickets.transferFrom(eoa[1], a.itemStream, tokenId);
        assertEq(tickets.ownerOf(tokenId), a.itemStream, "plain transferFrom accepted");
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, eoa[1], tokenId));
        vm.prank(eoa[1]);
        tickets.open(tokenId, _revealOf(itemNo));
        assertTrue(vault.isHidden(itemNo), "its item stays hidden in the vault");
        assertEq(vault.pendingTickets(), t0, "the ticket stays pending");
        (uint256 ph1,,) = stream.openTickets();
        assertEq(ph1, ph0, "the stream still counts it open");
    }
}
