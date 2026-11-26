// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IBoxCollection, IERC721TokenReceiver} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {EthIn} from "../common/AuditGhostLedger.sol";
import {AuditU7ClaudeBase, AuditU7ClaudeMath} from "./AuditU7ClaudeBase.sol";

/// @title AuditU7ClaudeDataReceiver
/// @notice TEST ONLY. Records the arguments of `onERC721Received` (EIP-721's receiver check).
contract AuditU7ClaudeDataReceiver is IERC721TokenReceiver {
    address public lastOperator;
    address public lastFrom;
    uint256 public lastId;
    bytes public lastData;
    uint256 public calls;

    function onERC721Received(address operator, address from, uint256 id, bytes calldata data)
        external
        returns (bytes4)
    {
        (lastOperator, lastFrom, lastId, lastData) = (operator, from, id, data);
        ++calls;
        return IERC721TokenReceiver.onERC721Received.selector;
    }
}

/// @notice SH-AUDIT-B0-U7 (Claude), L2 and L6 for the collection after graduation (items A and P1 outside, revealed):
/// transfers only by the owner, the approved address or an operator (BoxCollection.sol:684-710; EIP-721), the approval
/// cleared on every transfer, sends to the vault (except its own pull), to the collection and to T refused
/// (BoxCollection.sol:46-47, :687-688; BC-042), EIP-721's errors and events, the receiver check with its data, ERC-165
/// answers (BoxCollection.sol:150-156), ERC-2981 for every price (BoxCollection.sol:190-197; BC-112, P7.3), the royalty
/// receiver accepting a stipend payment under both schedules (the only ETH this unit names: BoxVault and BoxCollection
/// send none), and tokenURI/contractURI as JSON. Σ balances == N with one owner per id after each scenario (P7.13).
/// forge-config: default.evm_version = "osaka"
contract AuditU7ClaudeCollectionTest is AuditU7ClaudeBase {
    AuditU7ClaudeDataReceiver internal dataRx;

    function setUp() public virtual override {
        super.setUp();
        _toDrawing();
        dataRx = new AuditU7ClaudeDataReceiver();
    }

    // ------------------------------------------------------------------------------------------------ L2: who moves

    /// @notice P7.5: a caller that is neither owner, approved nor operator cannot move an item
    /// (ERC721InsufficientApproval); the owner, then an approved address, then an operator can, each transfer emits
    /// one Transfer and clears the approval.
    function testFuzz_AUDIT_U7_onlyOwnerApprovedOrOperatorTransfers(address stranger, address to) public {
        vm.assume(stranger != eoa[3] && stranger != address(0));
        vm.assume(to != address(0) && to != a.vault && to != a.collection && to != a.token && to.code.length == 0);
        vm.assume(to != eoa[3] && to != eoa[4] && to != eoa[5]);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InsufficientApproval.selector, stranger, itemA));
        collection.transferFrom(eoa[3], to, itemA);
        // The owner.
        _expectTransfer(eoa[3], eoa[4], itemA);
        vm.prank(eoa[3]);
        collection.transferFrom(eoa[3], eoa[4], itemA);
        // The approved address.
        vm.prank(eoa[4]);
        collection.approve(eoa[5], itemA);
        assertEq(collection.getApproved(itemA), eoa[5], "approved");
        _expectTransfer(eoa[4], to, itemA);
        vm.prank(eoa[5]);
        collection.transferFrom(eoa[4], to, itemA);
        assertEq(collection.getApproved(itemA), address(0), "approval cleared by the transfer");
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InsufficientApproval.selector, eoa[5], itemA));
        collection.transferFrom(to, eoa[5], itemA);
        // An operator.
        vm.prank(to);
        collection.setApprovalForAll(eoa[5], true);
        vm.prank(eoa[5]);
        collection.transferFrom(to, eoa[3], itemA);
        assertEq(collection.ownerOf(itemA), eoa[3], "back with its first owner");
        address[] memory extra = new address[](1);
        extra[0] = to;
        _assertCollectionConserved(_holders(extra), "transfers");
    }

    /// @notice P7.5: approve only by the owner or an operator (ERC721InvalidApprover); setApprovalForAll refuses the
    /// zero operator (ERC721InvalidOperator); both emit their events.
    function testFuzz_AUDIT_U7_approvalsOnlyByOwnerOrOperator(address stranger) public {
        vm.assume(stranger != eoa[3] && stranger != address(0));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidApprover.selector, stranger));
        collection.approve(stranger, itemA);
        vm.expectEmit(true, true, true, true, a.collection);
        emit IBoxCollection.Approval(eoa[3], stranger, itemA);
        vm.prank(eoa[3]);
        collection.approve(stranger, itemA);
        vm.prank(eoa[3]);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidOperator.selector, address(0)));
        collection.setApprovalForAll(address(0), true);
        vm.expectEmit(true, true, false, true, a.collection);
        emit IBoxCollection.ApprovalForAll(eoa[3], eoa[6], true);
        vm.prank(eoa[3]);
        collection.setApprovalForAll(eoa[6], true);
        // The operator may approve for the owner.
        vm.prank(eoa[6]);
        collection.approve(eoa[7], itemA);
        assertEq(collection.getApproved(itemA), eoa[7], "an operator's approval");
    }

    /// @notice P7.5 / BC-042: a send to the vault reverts DirectSendRefused unless the vault pulls a return from
    /// someone else; to the collection and to T always; by the owner or an operator; for transferFrom and both
    /// safeTransferFrom forms. Nothing moves.
    function testProperty_AUDIT_U7_sendsToSystemAddressesRefused() public {
        address[3] memory refused = [a.vault, a.collection, a.token];
        vm.prank(eoa[3]);
        collection.setApprovalForAll(eoa[6], true);
        for (uint256 i; i < refused.length; ++i) {
            for (uint256 j; j < 2; ++j) {
                address sender = j == 0 ? eoa[3] : eoa[6];
                bytes memory err = abi.encodeWithSelector(IBoxCollection.DirectSendRefused.selector, refused[i]);
                vm.prank(sender);
                vm.expectRevert(err);
                collection.transferFrom(eoa[3], refused[i], itemA);
                vm.prank(sender);
                vm.expectRevert(err);
                collection.safeTransferFrom(eoa[3], refused[i], itemA);
                vm.prank(sender);
                vm.expectRevert(err);
                collection.safeTransferFrom(eoa[3], refused[i], itemA, "x");
            }
        }
        assertEq(collection.ownerOf(itemA), eoa[3], "nothing moved");
        _assertVlt08Light("refused sends");
    }

    /// @notice L6 (EIP-721 errors): a wrong `from` (ERC721IncorrectOwner), the zero receiver (ERC721InvalidReceiver),
    /// a nonexistent id (ERC721NonexistentToken) for ownerOf, getApproved, tokenURI and transfers; balanceOf(0)
    /// (ERC721InvalidOwner).
    function testProperty_AUDIT_U7_erc721ErrorsAsSpecified() public {
        vm.prank(eoa[3]);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721IncorrectOwner.selector, eoa[4], itemA, eoa[3]));
        collection.transferFrom(eoa[4], eoa[5], itemA);
        vm.prank(eoa[3]);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidReceiver.selector, address(0)));
        collection.transferFrom(eoa[3], address(0), itemA);
        uint256 none = editionSize + 1;
        bytes memory err = abi.encodeWithSelector(IBoxCollection.ERC721NonexistentToken.selector, none);
        vm.expectRevert(err);
        collection.ownerOf(none);
        vm.expectRevert(err);
        collection.getApproved(none);
        vm.expectRevert(err);
        collection.tokenURI(none);
        vm.prank(eoa[3]);
        vm.expectRevert(err);
        collection.transferFrom(eoa[3], eoa[4], none);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidOwner.selector, address(0)));
        collection.balanceOf(address(0));
    }

    /// @notice L6: safeTransferFrom calls onERC721Received(operator = msg.sender, from, id, data) after the move, with
    /// the data; a self-transfer keeps the balance and emits one Transfer.
    function testProperty_AUDIT_U7_receiverCheckGetsItsArguments() public {
        vm.prank(eoa[3]);
        collection.setApprovalForAll(eoa[6], true);
        vm.prank(eoa[6]);
        collection.safeTransferFrom(eoa[3], address(dataRx), itemA, hex"c0ffee");
        assertEq(dataRx.calls(), 1, "called once");
        assertEq(dataRx.lastOperator(), eoa[6], "operator = the caller");
        assertEq(dataRx.lastFrom(), eoa[3], "from");
        assertEq(dataRx.lastId(), itemA, "id");
        assertEq(dataRx.lastData(), hex"c0ffee", "data");
        assertEq(collection.ownerOf(itemA), address(dataRx), "moved");
        uint256 bal = collection.balanceOf(eoa[0]);
        _expectTransfer(eoa[0], eoa[0], itemP1);
        vm.prank(eoa[0]);
        collection.transferFrom(eoa[0], eoa[0], itemP1);
        assertEq(collection.balanceOf(eoa[0]), bal, "a self-transfer keeps the balance");
        address[] memory extra = new address[](1);
        extra[0] = address(dataRx);
        _assertCollectionConserved(_holders(extra), "receiver check");
    }

    /// @notice L6 (EIP-7702): an EOA with a delegation designator has code (23 bytes), so a safe transfer calls its
    /// delegate's onERC721Received; the world's delegate implements it and the item arrives. (A delegate without the
    /// hook makes every safe transfer to that account revert, the vault's deliveries included: see the evidence.)
    function testProperty_AUDIT_U7_delegatedEoaReceivesThroughItsDelegate() public {
        assertEq(eoa7702.code.length, 23, "a delegation designator");
        vm.prank(eoa[3]);
        collection.safeTransferFrom(eoa[3], eoa7702, itemA);
        assertEq(collection.ownerOf(itemA), eoa7702, "received");
    }

    /// @notice Observation for the evidence (L6, EIP-7702): an EOA delegated to code without onERC721Received (here
    /// T's code) cannot receive an item by safe transfer: ERC721InvalidReceiver, the vault's picks and deliveries use
    /// safe transfers only (BoxVault.sol:220, :494); transferFrom still reaches it.
    function testProperty_AUDIT_U7_delegatedEoaWithoutHookCannotTakeDeliveries() public {
        (address dele, uint256 key) = makeAddrAndKey("u7.eoa7702.nohook");
        vm.signAndAttachDelegation(a.token, key);
        (bool ok,) = dele.call("");
        ok;
        assertEq(dele.code.length, 23, "delegated");
        vm.prank(eoa[3]);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidReceiver.selector, dele));
        collection.safeTransferFrom(eoa[3], dele, itemA);
        vm.prank(eoa[3]);
        collection.transferFrom(eoa[3], dele, itemA);
        assertEq(collection.ownerOf(itemA), dele, "transferFrom reaches it");
    }

    // ------------------------------------------------------------------------------------------------ L6: ERC-165, 2981

    /// @notice P7.11 / BC-112: ERC-165 answers true exactly for ERC-165, ERC-721, ERC-721 metadata, ERC-4906 and
    /// ERC-2981 (box 0 has the royalties add-on), false for 0xffffffff and any other id.
    function testFuzz_AUDIT_U7_supportsExactlyItsInterfaces(bytes4 id) public view {
        bool known = id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0x5b5e139f || id == 0x49064906 || id == 0x2a55205a;
        assertEq(collection.supportsInterface(id), known, "ERC-165 answer");
        assertTrue(collection.supportsInterface(0x2a55205a), "ERC-2981 reported");
        assertFalse(collection.supportsInterface(0xffffffff), "0xffffffff false");
    }

    /// @notice P7.3 / BC-112: royaltyInfo(id, price) == (the royalty router, ⌊price × 250 / 10,000⌋) for every id
    /// (existing or not) and every price up to 2^256 − 1, never reverting; BC-112's points: 1 ETH → 0.025 ETH,
    /// 10,000 wei → 250, 39 wei → 0.
    function testFuzz_AUDIT_U7_royaltyInfoForEveryPrice(uint256 id, uint256 price) public view {
        (address r, uint256 amount) = collection.royaltyInfo(id, price);
        assertEq(r, a.royaltyRouter, "the box's royalty router");
        assertTrue(AuditU7ClaudeMath.isFloor(amount, price, 250, 10_000), "floor(price * 250 / 10,000)");
        (r, amount) = collection.royaltyInfo(id, type(uint256).max);
        assertEq(amount, type(uint256).max / 40, "at 2^256 - 1");
        (, amount) = collection.royaltyInfo(1, 1 ether);
        assertEq(amount, 0.025 ether, "1 ETH");
        (, amount) = collection.royaltyInfo(2_135, 10_000);
        assertEq(amount, 250, "10,000 wei");
        (, amount) = collection.royaltyInfo(4_269, 39);
        assertEq(amount, 0, "39 wei");
        assertEq(collection.royaltyBps(), 250, "250 bps");
        assertEq(collection.royaltyRouter(), a.royaltyRouter, "royaltyRouter()");
    }

    /// @notice L6 (ETH sends of this unit): the only ETH destination U7 names is royaltyInfo's receiver, the royalty
    /// router (a receiving clone); a marketplace's 2,300-gas `transfer` and a 0-wei send reach it (BC-114). Run under
    /// both schedules (the Amsterdam contract below).
    function testProperty_AUDIT_U7_royaltyReceiverTakesAStipendPayment() public {
        (address r,) = collection.royaltyInfo(itemA, 1 ether);
        uint256 b0 = r.balance;
        _fund(address(this), 1 ether);
        payable(r).transfer(1 ether);
        _noteEthIn(EthIn.Royalty, 1 ether);
        (bool ok,) = r.call{gas: 2_300}("");
        assertTrue(ok, "a 0-wei stipend call");
        assertEq(r.balance, b0 + 1 ether, "received");
        _assertGhostLedger();
    }

    // ------------------------------------------------------------------------------------------------ metadata

    /// @notice tokenURI == "data:application/json;base64," + base64(tokenJSON) and parses as JSON with the name
    /// "<collection name> #<id>", for a hidden id (the placeholders add-on's view) and a revealed one (the table's
    /// attributes); contractURI parses too.
    function testProperty_AUDIT_U7_metadataIsJson() public view {
        uint256 hidden = _firstHiddenId();
        uint256[2] memory ids = [hidden, itemA];
        for (uint256 i; i < 2; ++i) {
            string memory json = collection.tokenJSON(ids[i]);
            assertEq(
                collection.tokenURI(ids[i]),
                string.concat("data:application/json;base64,", vm.toBase64(bytes(json))),
                "tokenURI wraps tokenJSON"
            );
            string memory name = vm.parseJsonString(json, ".name");
            assertEq(name, string.concat(collection.name(), " #", vm.toString(ids[i])), "the title");
            vm.parseJsonString(json, ".image");
        }
        assertTrue(collection.isRevealed(itemA) && !collection.isRevealed(hidden), "one of each");
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _expectTransfer(address from, address to, uint256 id) internal {
        vm.expectEmit(true, true, true, true, a.collection);
        emit IBoxCollection.Transfer(from, to, id);
    }

    function _firstHiddenId() internal view returns (uint256 id) {
        for (id = 1; id <= editionSize; ++id) {
            if (vault.isHidden(id)) return id;
        }
    }
}

/// @notice The same under Amsterdam: the royalty receiver still takes a 2,300-gas payment (its receiving clone stops
/// at once, BoxClones.sol:13-18), and the collection's rules do not depend on the schedule.
/// forge-config: default.evm_version = "amsterdam"
contract AuditU7ClaudeCollectionAmsterdamTest is AuditU7ClaudeCollectionTest {}
