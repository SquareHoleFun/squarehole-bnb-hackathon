// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxMetadataTable} from "../../../../src/box/libraries/BoxMetadataTable.sol";
import {IBoxCollection, IERC721TokenReceiver} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxItemStream} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxToken} from "../../../../src/box/interfaces/IBoxToken.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {AuditU7FableBase} from "./AuditU7FableBase.sol";

/// @notice TEST ONLY. A receiver contract with a chosen answer to `onERC721Received`: the right selector, a wrong one,
/// a revert with a reason, or a revert without data; records what it was told.
contract AuditU7FableReceiverMock is IERC721TokenReceiver {
    enum Mode {
        Accept,
        WrongSelector,
        RevertReason,
        RevertEmpty
    }

    Mode public mode;
    address public lastOperator;
    address public lastFrom;
    uint256 public lastId;
    bytes public lastData;
    uint256 public calls;

    error Refused(uint256 id);

    function set(Mode m) external {
        mode = m;
    }

    function onERC721Received(address operator, address from, uint256 id, bytes calldata data)
        external
        returns (bytes4)
    {
        ++calls;
        (lastOperator, lastFrom, lastId, lastData) = (operator, from, id, data);
        if (mode == Mode.WrongSelector) return 0xdeadbeef;
        if (mode == Mode.RevertReason) revert Refused(id);
        if (mode == Mode.RevertEmpty) revert();
        return IERC721TokenReceiver.onERC721Received.selector;
    }
}

/// @notice SH-AUDIT-B0 U7 (Fable). The collection after graduation on the factory's box 0 with the real stream as
/// transfer observer (L2 P7.5, L6 P7.11, L5 JSON): transfers by the owner, an approved address or an operator only;
/// the refused sends; the receiver check on safe transfers (contracts, an EIP-7702 account, the box's own contracts);
/// approvals cleared by transfers and by the vault's pull; `tokenURI` / `contractURI` as valid JSON from the table.
/// Proof 25 pins what an unsafe send to the box's stream does.
/// forge-config: default.evm_version = "osaka"
contract AuditU7FableCollectionTest is AuditU7FableBase {
    address internal picker;
    AuditU7FableReceiverMock internal mock;

    function setUp() public override {
        super.setUp();
        _toDrawing();
        _buildTree();
        _stockShelf();
        picker = eoa[4];
        (uint256 p, uint256 f) = _pickQuote(shelf.length);
        _fundT(picker, 2 * (p + f));
        mock = new AuditU7FableReceiverMock();
        _ghostAddOutside(address(mock));
    }

    // ============================================================================================ L2 transfers

    /// P7.5, P7.11 (ERC-721; `BoxCollection.sol:263-294, 684-710`): the owner, an approved address or an operator may
    /// move an item (events as the standard says; the per-token approval cleared by the move); nobody else; the real
    /// stream sees every move; the vault's counts do not change for a move between holders.
    function testProperty_AUDIT_U7_transfersOnlyByOwnerApprovedOrOperator() public {
        uint256 id = shelf[0];
        _pick(picker, id);
        uint256 outside0 = vault.outside();
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InsufficientApproval.selector, eoa[5], id));
        vm.prank(eoa[5]);
        collection.transferFrom(picker, eoa[5], id);
        // The owner.
        vm.expectEmit(true, true, true, true, a.collection);
        emit IBoxCollection.Transfer(picker, eoa[5], id);
        vm.prank(picker);
        collection.transferFrom(picker, eoa[5], id);
        assertEq(collection.ownerOf(id), eoa[5]);
        assertEq(collection.balanceOf(picker), 0);
        assertEq(collection.balanceOf(eoa[5]), 1);
        (address rec,) = stream.pendingOf(id);
        assertEq(rec, eoa[5], "the real stream checkpointed the move");
        // An approved address, once; the approval is cleared by the move.
        vm.expectEmit(true, true, true, true, a.collection);
        emit IBoxCollection.Approval(eoa[5], eoa[6], id);
        vm.prank(eoa[5]);
        collection.approve(eoa[6], id);
        assertEq(collection.getApproved(id), eoa[6]);
        vm.prank(eoa[6]);
        collection.transferFrom(eoa[5], eoa[7], id);
        assertEq(collection.ownerOf(id), eoa[7]);
        assertEq(collection.getApproved(id), address(0), "cleared by the transfer");
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InsufficientApproval.selector, eoa[6], id));
        vm.prank(eoa[6]);
        collection.transferFrom(eoa[7], eoa[6], id);
        // An operator, for any of the holder's items, safe or not; it may also approve on the holder's behalf.
        vm.expectEmit(true, true, true, true, a.collection);
        emit IBoxCollection.ApprovalForAll(eoa[7], eoa[0], true);
        vm.prank(eoa[7]);
        collection.setApprovalForAll(eoa[0], true);
        vm.prank(eoa[0]);
        collection.safeTransferFrom(eoa[7], address(contractDrawer), id);
        assertEq(collection.ownerOf(id), address(contractDrawer));
        assertTrue(collection.isApprovedForAll(eoa[7], eoa[0]), "an operator approval survives the move");
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InsufficientApproval.selector, eoa[0], id));
        vm.prank(eoa[0]);
        collection.transferFrom(address(contractDrawer), eoa[0], id);
        vm.prank(address(contractDrawer));
        collection.setApprovalForAll(eoa[1], true);
        vm.expectEmit(true, true, true, true, a.collection);
        emit IBoxCollection.Approval(address(contractDrawer), eoa[2], id);
        vm.prank(eoa[1]);
        collection.approve(eoa[2], id);
        vm.prank(eoa[2]);
        collection.transferFrom(address(contractDrawer), eoa[2], id);
        assertEq(collection.ownerOf(id), eoa[2]);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721IncorrectOwner.selector, eoa[7], id, eoa[2]));
        vm.prank(eoa[2]);
        collection.transferFrom(eoa[7], eoa[3], id);
        (rec,) = stream.pendingOf(id);
        assertEq(rec, eoa[2]);
        assertEq(vault.outside(), outside0, "moves between holders change no vault count");
        assertTrue(vault.isOutside(id));
        _assertVlt08("after moves between holders");
        _assertGhostLedger();
    }

    /// P7.5 (F24 (d), F25 (3); BC-042, BC-043, BC-044; `BoxCollection.sol:685-688`, `BoxVault.sol:264-274`,
    /// `BoxToken.sol:143`, `BoxTickets.sol:727-730`): sends to the vault (except its own pull), to the collection and
    /// to T revert before any receiver hook; the vault's hook refuses a foreign collection and an unsolicited item of
    /// its own; T and placeholders refuse the same destinations.
    function testProperty_AUDIT_U7_sendsToBoxContractsRefused() public {
        uint256 id = shelf[0];
        _pick(picker, id);
        address[3] memory refused = [a.vault, a.collection, a.token];
        for (uint256 i; i < refused.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IBoxCollection.DirectSendRefused.selector, refused[i]));
            vm.prank(picker);
            collection.transferFrom(picker, refused[i], id);
            vm.expectRevert(abi.encodeWithSelector(IBoxCollection.DirectSendRefused.selector, refused[i]));
            vm.prank(picker);
            collection.safeTransferFrom(picker, refused[i], id);
        }
        // An operator for the picker cannot route it into the vault either (only the vault's own pull passes).
        vm.prank(picker);
        collection.setApprovalForAll(eoa[5], true);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.DirectSendRefused.selector, a.vault));
        vm.prank(eoa[5]);
        collection.safeTransferFrom(picker, a.vault, id);
        // The vault's receiver hook on its own: a foreign collection, an unsolicited item of its own collection.
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.ForeignNft.selector, eoa[5], id));
        vm.prank(eoa[5]);
        vault.onERC721Received(eoa[5], picker, id, "");
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.UnsolicitedItem.selector, picker, id));
        vm.prank(a.collection);
        vault.onERC721Received(picker, picker, id, "");
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.UnsolicitedItem.selector, picker, id));
        vm.prank(a.collection);
        vault.onERC721Received(a.vault, picker, id, ""); // the vault as operator, but no return in flight
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.DirectSendRefused.selector, a.vault));
        vm.prank(picker);
        token.transfer(a.vault, 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.DirectSendRefused.selector, a.token));
        vm.prank(picker);
        token.transfer(a.token, 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.DirectSendRefused.selector, a.vault));
        vm.prank(eoa[1]);
        tickets.transferFrom(eoa[1], a.vault, 5);
        assertEq(collection.ownerOf(id), picker, "nothing moved");
        _assertVlt08("after refused sends");
    }

    /// P7.7, P7.11 (ERC-721 `safeTransferFrom`; `BoxCollection.sol:722-732`): a receiver without code takes the item;
    /// a contract takes it only by answering the selector (an EIP-7702 account is a contract here: its delegate
    /// answers); a wrong selector or an empty revert reads `ERC721InvalidReceiver`, a reason bubbles up; the box's
    /// own contracts (no hook) refuse every safe send; the data passes through.
    function testProperty_AUDIT_U7_safeTransfersAndReceivers() public {
        uint256 id = shelf[0];
        _pick(picker, id);
        vm.prank(picker);
        collection.safeTransferFrom(picker, eoa[5], id, "plain");
        vm.prank(eoa[5]);
        collection.safeTransferFrom(eoa[5], address(contractDrawer), id);
        vm.prank(address(contractDrawer));
        collection.safeTransferFrom(address(contractDrawer), eoa7702, id);
        assertEq(collection.ownerOf(id), eoa7702, "the 7702 account's delegate answered the hook");
        vm.prank(eoa7702);
        collection.safeTransferFrom(eoa7702, address(ethRefuser), id);
        assertEq(collection.ownerOf(id), address(ethRefuser), "an ETH refuser still takes items");
        vm.prank(address(ethRefuser));
        collection.safeTransferFrom(address(ethRefuser), address(mock), id, hex"c0ffee");
        assertEq(mock.calls(), 1);
        assertEq(mock.lastOperator(), address(ethRefuser));
        assertEq(mock.lastFrom(), address(ethRefuser));
        assertEq(mock.lastId(), id);
        assertEq(mock.lastData(), hex"c0ffee");
        vm.prank(address(mock));
        collection.transferFrom(address(mock), picker, id);

        mock.set(AuditU7FableReceiverMock.Mode.WrongSelector);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidReceiver.selector, address(mock)));
        vm.prank(picker);
        collection.safeTransferFrom(picker, address(mock), id);
        mock.set(AuditU7FableReceiverMock.Mode.RevertEmpty);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidReceiver.selector, address(mock)));
        vm.prank(picker);
        collection.safeTransferFrom(picker, address(mock), id);
        mock.set(AuditU7FableReceiverMock.Mode.RevertReason);
        vm.expectRevert(abi.encodeWithSelector(AuditU7FableReceiverMock.Refused.selector, id));
        vm.prank(picker);
        collection.safeTransferFrom(picker, address(mock), id);
        mock.set(AuditU7FableReceiverMock.Mode.Accept);
        // The box's own contracts answer no hook: every safe send to them reverts.
        address[9] memory boxContracts = [
            a.itemStream,
            a.receiver,
            a.coordinator,
            a.hook,
            a.executor,
            a.launchRouter,
            a.tickets,
            a.royaltyRouter,
            a.table
        ];
        for (uint256 i; i < boxContracts.length; ++i) {
            vm.prank(picker);
            (bool ok,) = a.collection
                .call(abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", picker, boxContracts[i], id));
            assertFalse(ok, "a safe send to a box contract reverts");
        }
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidReceiver.selector, a.itemStream));
        vm.prank(picker);
        collection.safeTransferFrom(picker, a.itemStream, id);
        assertEq(collection.ownerOf(id), picker);
        _assertVlt08("after receiver checks");
        _assertGhostLedger();
    }

    /// P7.5, P7.11 (`BoxCollection.sol:701-702`; `BoxVault.sol:600-611`): a per-token approval set before a return is
    /// cleared by the vault's pull and does not survive to the next owner; one set from inside the observer could
    /// not pass either (cleared after the observer runs).
    function testProperty_AUDIT_U7_approvalClearedByTheVaultPull() public {
        uint256 id = shelf[0];
        _pick(picker, id);
        vm.prank(picker);
        collection.approve(eoa[5], id);
        assertEq(collection.getApproved(id), eoa[5]);
        _returnItem(picker, id);
        assertEq(collection.getApproved(id), address(0), "cleared by the pull");
        assertEq(collection.ownerOf(id), a.vault);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InsufficientApproval.selector, eoa[5], id));
        vm.prank(eoa[5]);
        collection.transferFrom(a.vault, eoa[5], id);
        (uint256 p6, uint256 f6) = _pickQuote(1);
        _fundT(eoa[6], p6 + f6);
        _pick(eoa[6], id);
        assertEq(collection.getApproved(id), address(0), "nothing survives to the next owner");
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InsufficientApproval.selector, eoa[5], id));
        vm.prank(eoa[5]);
        collection.transferFrom(eoa[6], eoa[5], id);
        _assertVlt08("after approval checks");
        _assertVaultApprovesNobody();
    }

    // ============================================================================================ L5 metadata

    /// P7.10 (BC-051, BC-054; `BoxCollection.sol:396-438`): `tokenJSON` of a hidden and of a revealed id, and
    /// `contractURI`, parse as JSON with the fields the table and the reveal give; `tokenURI` is their base64 data URI;
    /// the CID views refuse a hidden id.
    function testProperty_AUDIT_U7_tokenJsonValidAndFromTheTable() public {
        uint256 revealed = shelf[0];
        uint256 hidden = 1;
        require(!collection.isRevealed(hidden), "id 1 is hidden here");
        string memory j = collection.tokenJSON(revealed);
        assertEq(vm.parseJsonString(j, ".name"), string.concat(collection.name(), " #", vm.toString(revealed)), "name");
        bytes memory table = collection.metadataTableBytes();
        assertEq(vm.parseJsonString(j, ".description"), string(BoxMetadataTable.description(table)), "description");
        assertEq(vm.parseJsonString(j, ".image"), string.concat("ipfs://", collection.imageCid(revealed)));
        assertEq(vm.parseJsonString(j, ".animation_url"), string.concat("ipfs://", collection.modelCid(revealed)));
        uint256 types = uint8(table[3 + BoxMetadataTable.descriptionLength(table)]);
        (, uint128 traits,,) = collection.traitsOf(revealed);
        uint256 expected;
        for (uint256 t; t < types; ++t) {
            if ((uint256(traits) >> (8 * t)) & 0xff != 0) ++expected;
        }
        assertGt(expected, 0);
        assertEq(_attributeCount(j), expected, "one attribute per set trait the table knows");
        assertEq(vm.parseJsonString(j, ".attributes[0].trait_type"), _traitName(table, 0));
        assertEq(collection.tokenURI(revealed), string.concat("data:application/json;base64,", vm.toBase64(bytes(j))));

        string memory h = collection.tokenJSON(hidden);
        assertEq(vm.parseJsonString(h, ".name"), string.concat(collection.name(), " #1"));
        assertEq(vm.parseJsonString(h, ".attributes[0].trait_type"), "Status");
        assertEq(vm.parseJsonString(h, ".attributes[0].value"), "Not revealed");
        string memory image = vm.parseJsonString(h, ".image");
        if (bytes(collection.hiddenSvg()).length != 0) {
            assertEq(vm.parseJsonString(h, ".description"), collection.hiddenDescription());
            assertEq(image, string.concat("data:image/svg+xml;base64,", vm.toBase64(bytes(collection.hiddenSvg()))));
        } else {
            assertEq(vm.parseJsonString(h, ".description"), collection.description());
        }
        assertEq(collection.tokenURI(hidden), string.concat("data:application/json;base64,", vm.toBase64(bytes(h))));
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.NotRevealed.selector, hidden));
        collection.imageCid(hidden);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.NotRevealed.selector, hidden));
        collection.modelCid(hidden);

        // contractURI: a base64 data URI whose JSON carries the views (decoded by the test's own reader, which
        // forge's encoder round-trips).
        bytes memory cb = bytes(collection.contractURI());
        bytes memory prefix = bytes("data:application/json;base64,");
        bytes memory payload = new bytes(cb.length - prefix.length);
        for (uint256 i; i < prefix.length; ++i) {
            assertEq(cb[i], prefix[i], "data URI prefix");
        }
        for (uint256 i; i < payload.length; ++i) {
            payload[i] = cb[prefix.length + i];
        }
        string memory cj = string(_base64Decode(payload));
        assertEq(vm.toBase64(bytes(cj)), string(payload), "base64 round trip");
        assertEq(vm.parseJsonString(cj, ".name"), collection.name());
        assertEq(vm.parseJsonString(cj, ".symbol"), collection.symbol());
        assertEq(vm.parseJsonString(cj, ".description"), collection.description());
        assertTrue(vm.keyExistsJson(cj, ".image"));
        if (collection.generatorHash() != bytes32(0)) assertTrue(vm.keyExistsJson(cj, ".generator_hash"));
        if (bytes(collection.externalLink()).length != 0) {
            assertEq(vm.parseJsonString(cj, ".external_link"), collection.externalLink());
        }
    }

    // ============================================================================================ proof 25

    // W3-U7-1, accepted as built (FQ-41, R66-LOST, F147): the class is on the accepted no-exit list (F126's row).
    /// @notice Property: every T unit and every item is either out, claimable by a named party now, or in a
    /// documented no-exit class (plan § 3.1 X21; F126's M01/M25 cover FIT at a box address, F26 (1) T at a dead
    /// address); the collection refuses direct sends to the vault, to itself and to T (F24 (d), `BoxCollection.sol:
    /// 46-47, 685-688`), and the stream pays every slot's share to its owner (`IBoxItemStream.sol:49-52`).
    /// Expected (from those sources): an item cannot end in a place from which neither it nor its share has an exit,
    /// other than the documented classes. Observed: `transferFrom` (the unsafe ERC-721 path) moves an item to the
    /// box's own stream (or any other box contract without the hook: the collection refuses only the vault, itself
    /// and T); the item is then nobody's to move or return, the vault counts it outside for good, and the stream
    /// books the slot's share to its own address, which `claimFor` refuses (`SelfClaim`) and which `burn()` keeps as
    /// owners' accrual, so that T is neither paid nor burned. Steps: pick an item; `transferFrom` it to the stream;
    /// a buy and a sell (fees), `collect()`; read the stream's record, try the claim, the return and a move; `burn()`.
    /// Amounts: one item; its share of 13/15 of one sell's 1% T fee ÷ 1,969. Severity estimate: low (self-inflicted
    /// by an unsafe transfer that `safeTransferFrom` refuses; bounded to the sender's item and 1/N of the stream's
    /// later income; no third party loses; the same shape as the accepted M25 / F26 (1)). Question for the founder:
    /// should the collection refuse sends to the box's other contracts (it knows the receiver, the coordinator, the
    /// stream, the tickets and the royalty router), as it does for the vault, itself and T?
    function testAccepted_AUDIT_U7_25_itemSentToTheStreamIsLostAndItsShareStaysReserved() public {
        uint256 id = shelf[0];
        _pick(picker, id);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidReceiver.selector, a.itemStream));
        vm.prank(picker);
        collection.safeTransferFrom(picker, a.itemStream, id);
        vm.prank(picker);
        collection.transferFrom(picker, a.itemStream, id); // observed: accepted
        assertEq(collection.ownerOf(id), a.itemStream);
        assertTrue(vault.isOutside(id));
        (address recorded, uint256 pending0) = stream.pendingOf(id);
        assertEq(recorded, a.itemStream, "the stream records itself as the owner");
        assertEq(pending0, 0);
        // Fees flow: a buy (Q fees, so the batch clears the minimum) and a sell (T fees, the stream's side).
        uint256 j0 = stream.index();
        _buy(eoa[5], 1 ether);
        _sell(eoa[2], token.balanceOf(eoa[2]) / 10);
        _advance(12);
        _collect(keeper, keeper);
        assertGt(stream.index(), j0, "J rose");
        (, uint256 pending) = stream.pendingOf(id);
        assertGt(pending, 0, "the slot's share accrues to the stream's own address");
        // No exit: nobody can claim it, move it or return it.
        vm.expectRevert(IBoxItemStream.SelfClaim.selector);
        stream.claimFor(a.itemStream, _ids1(id));
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotOwner.selector, id));
        vm.prank(picker);
        vault.returnItem(id, 0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InsufficientApproval.selector, picker, id));
        vm.prank(picker);
        collection.transferFrom(a.itemStream, picker, id);
        // The share is kept as owners' accrual: a burn leaves at least the liabilities, which count this slot.
        uint256 liabilities = stream.liabilities();
        assertGe(liabilities, pending, "liabilities count the stuck slot");
        stream.burn();
        assertGe(token.balanceOf(a.itemStream), liabilities, "burn() keeps the owners' accrual, this slot's too");
        assertEq(stream.liabilities(), liabilities, "nothing of it was paid or burned");
        assertEq(vault.outside(), 3, "the vault counts it outside for good (with placeholder 5 and draw B)");
        _assertVlt08("with an item at the stream");
        // The ledger: the item's T share sits inside the system (the stream), booked nowhere as out.
        _assertGhostLedger();
    }

    // ============================================================================================ helpers

    function _traitName(bytes memory table, uint256 index) internal pure returns (string memory) {
        uint256 cursor = 3 + BoxMetadataTable.descriptionLength(table) + 1;
        for (uint256 t; t <= index; ++t) {
            uint256 nameLength = uint8(table[cursor]);
            if (t == index) return string(BoxMetadataTable.slice(table, cursor + 1, nameLength));
            cursor += 1 + nameLength;
            uint256 values = uint8(table[cursor]);
            ++cursor;
            for (uint256 v; v < values; ++v) {
                cursor += 1 + uint8(table[cursor]);
            }
        }
        return "";
    }

    function _base64Decode(bytes memory data) internal pure returns (bytes memory out) {
        bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        uint8[256] memory rev;
        for (uint256 i; i < 64; ++i) {
            rev[uint8(table[i])] = uint8(i);
        }
        uint256 len = data.length;
        uint256 padding;
        if (len != 0 && data[len - 1] == "=") ++padding;
        if (len > 1 && data[len - 2] == "=") ++padding;
        out = new bytes(len / 4 * 3 - padding);
        uint256 o;
        for (uint256 i; i < len; i += 4) {
            uint256 v = (uint256(rev[uint8(data[i])]) << 18) | (uint256(rev[uint8(data[i + 1])]) << 12)
                | (uint256(rev[uint8(data[i + 2])]) << 6) | uint256(rev[uint8(data[i + 3])]);
            if (o < out.length) out[o++] = bytes1(uint8(v >> 16));
            if (o < out.length) out[o++] = bytes1(uint8(v >> 8));
            if (o < out.length) out[o++] = bytes1(uint8(v));
        }
    }
}
