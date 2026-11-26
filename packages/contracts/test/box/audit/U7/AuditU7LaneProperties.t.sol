// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    AuditU7LaneBase,
    AuditU7LaneReturningReceiver,
    ItemReveal,
    IBoxCollection,
    IBoxVault,
    IBoxToken,
    Vm
} from "./AuditU7LaneBase.sol";

/// @notice SH-AUDIT-B0-U7: properties on the factory's box 0 with its actual stream.
/// forge-config: default.evm_version = "osaka"
contract AuditU7LaneProperties is AuditU7LaneBase {
    function testProperty_AUDIT_U7_creationAndInterfaces() public view {
        assertEq(creationEvents, 1);
        assertEq(creationIds, editionSize);
        assertEq(collection.totalSupply(), editionSize);
        assertEq(collection.balanceOf(a.vault), editionSize);
        assertEq(vault.hiddenCount(), editionSize);
        assertEq(vault.ticketAdapter(), a.tickets);
        for (uint256 id = 1; id <= editionSize; ++id) {
            assertEq(collection.ownerOf(id), a.vault);
            assertEq(collection.getApproved(id), address(0));
        }
        bytes memory code = collection.metadataTable().code;
        assertEq(uint8(code[0]), 0);
        assertEq(code.length, collection.metadataTableBytes().length + 1);
        assertEq(keccak256(collection.metadataTableBytes()), collection.metadataTableHash());
        assertTrue(collection.supportsInterface(0x01ffc9a7));
        assertTrue(collection.supportsInterface(0x80ac58cd));
        assertTrue(collection.supportsInterface(0x5b5e139f));
        assertTrue(collection.supportsInterface(0x2a55205a));
        assertFalse(collection.supportsInterface(0xffffffff));
        _assertVault();
    }

    function testFuzz_AUDIT_U7_royaltyEveryUint256(uint256 id, uint256 price) public view {
        (address payee, uint256 royalty) = collection.royaltyInfo(id, price);
        assertEq(payee, a.royaltyRouter);
        assertEq(royalty, price / 40, "250/10000 exactly 1/40, no overflow");
        (payee, royalty) = collection.royaltyInfo(id, type(uint256).max);
        assertEq(payee, a.royaltyRouter);
        assertEq(royalty, type(uint256).max / 40);
    }

    function testProperty_AUDIT_U7_gateAndAdapterAuthority() public {
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotCoordinator.selector, address(this)));
        vault.openGate();
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotCoordinator.selector, address(this)));
        vault.waiveHandBackFee();
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotAdapter.selector, address(this)));
        vault.openTickets(1, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotAdapter.selector, address(this)));
        vault.releaseTickets(1, eoa[0], 0);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotAdapter.selector, address(this)));
        vault.deliverTicket(1, eoa[0]);
        vm.expectRevert(IBoxVault.GateClosed.selector);
        vault.withdraw(1, type(uint256).max, block.timestamp);
        vm.expectRevert(IBoxVault.GateClosed.selector);
        vault.withdrawBatch(_ids(1), type(uint256).max, block.timestamp);
        vm.expectRevert(IBoxVault.GateClosed.selector);
        vault.returnItem(1, 0, block.timestamp);
        vm.expectRevert(IBoxVault.GateClosed.selector);
        vault.returnItems(_ids(1), 0, block.timestamp);
        vm.prank(a.tickets);
        vm.expectRevert(IBoxVault.GateClosed.selector);
        vault.deliverTicket(1, eoa[0]);
        _toClosed();
        assertFalse(vault.gateOpen());
        _toGraduated();
        assertTrue(vault.gateOpen());
        assertEq(vault.gateOpenedAt(), block.timestamp);
        assertEq(graduationPokeFailures, 0);
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxVault.GateAlreadyOpen.selector);
        vault.openGate();
        assertFalse(vault.handBackFeeWaived());
        assertEq(collection.revealUnlocker(), address(0));
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.NotRevealUnlocker.selector, address(this)));
        collection.unlockReveal(1);
        _assertVault();
    }

    function testProperty_AUDIT_U7_everyBatchIdRequiresOwnershipAndShelfReveal() public {
        _toDrawing();
        uint256[] memory ids = new uint256[](2);
        ids[0] = itemA;
        ids[1] = itemP1;
        uint256 e = vault.escrowPrincipal();
        vm.prank(eoa[3]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotOwner.selector, itemP1));
        vault.returnItems(ids, 0, block.timestamp);
        assertEq(vault.escrowPrincipal(), e);
        assertEq(collection.ownerOf(itemA), eoa[3]);
        _approveT(eoa[4], a.vault);
        uint256 hidden = 1;
        while (!vault.isHidden(hidden)) ++hidden;
        vm.prank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.HiddenItem.selector, hidden));
        vault.withdrawBatch(_ids(hidden), type(uint256).max, block.timestamp);
        assertEq(vault.escrowPrincipal(), e);
        _assertVault();
    }

    function testFuzz_AUDIT_U7_ticketFeesAndPreActionQuotes(uint256 seed) public {
        _toBonding();
        uint256 k = 1 + seed % 8;
        uint256 s = token.totalSupply();
        uint256 e = vault.escrowPrincipal();
        uint256 p = _ceil(s - e, k, vault.inside());
        uint256 f = _fee(p, 100);
        uint256 b = token.balanceOf(eoa[0]);
        uint256 first = _take(eoa[0], k);
        assertEq(vault.escrowPrincipal(), e + p);
        assertEq(token.balanceOf(eoa[0]), b - p - f);
        assertEq(token.totalSupply(), s - f);
        _assertVault();
        uint256[] memory ids = new uint256[](k);
        for (uint256 i; i < k; ++i) {
            ids[i] = first + i;
        }
        uint256 r = _floor(token.totalSupply() - vault.escrowPrincipal(), k, vault.inside());
        (uint256 received, uint256 returnFee) = _handBack(eoa[0], ids);
        assertEq(received, r);
        assertEq(returnFee, _fee(r, 500));
        assertEq(token.totalSupply(), s - f - returnFee);
        assertEq(vault.escrowPrincipal(), e + p - r);
        assertLe(r, p);
        _assertVault();
    }

    function testProperty_AUDIT_U7_drawPickReturnFlatBurns() public {
        _toDrawing();
        _returnItem(eoa[3], itemA);
        uint256 s = token.totalSupply();
        uint256 e = vault.escrowPrincipal();
        uint256 p = _ceil(s - e, 1, vault.inside());
        (uint256 paid, uint256 f) = _pick(eoa[4], itemA);
        assertEq(paid, p);
        assertEq(f, _fee(p, 2500));
        assertEq(token.totalSupply(), s - f);
        assertEq(vault.escrowPrincipal(), e + p);
        uint256 r = _floor(token.totalSupply() - vault.escrowPrincipal(), 1, vault.inside());
        (uint256 got, uint256 rf) = _returnItem(eoa[4], itemA);
        assertEq(got, r);
        assertEq(rf, _fee(r, 500));
        assertLe(got, paid);
        assertEq(token.totalSupply(), s - f - rf);
        uint256 ds = token.totalSupply();
        uint256 de = vault.escrowPrincipal();
        uint256 dp = _ceil(ds - de, 1, vault.inside());
        _draw(eoa[4], AUDIT_DRAW_VALUE);
        assertEq(vault.escrowPrincipal(), de + dp);
        assertEq(token.totalSupply(), ds - _fee(dp, 100));
        _assertVault();
    }

    function testProperty_AUDIT_U7_unsolicitedRefusedAndQuotesIgnoreBalance() public {
        _toBonding();
        uint256 e = vault.escrowPrincipal();
        uint256 q = vault.quoteWithdraw(1);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.DirectSendRefused.selector, a.vault));
        token.transfer(a.vault, 17);
        assertEq(vault.escrowPrincipal(), e);
        assertEq(vault.quoteWithdraw(1), q);
        uint256 r = vault.quoteReturn(1);
        // Fault injection confined to the token's balance view: quotes must not consult that callee result.
        vm.mockCall(a.token, abi.encodeCall(token.balanceOf, (a.vault)), abi.encode(type(uint256).max));
        assertEq(vault.quoteWithdraw(1), q);
        assertEq(vault.quoteReturn(1), r);
        vm.clearMockedCalls();
        _assertVault();
    }

    function testProperty_AUDIT_U7_returnOwnerAndGrace() public {
        _toDrawing();
        vm.warp(uint256(tickets.status().wordAcceptedAt) + tickets.REVEAL_GRACE());
        uint256 id = _open(eoa[0], 2, false);
        vm.prank(eoa[0]);
        collection.setApprovalForAll(eoa[4], true);
        vm.prank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotOwner.selector, id));
        vault.returnItems(_ids(id), 0, block.timestamp);
        uint256 at = tickets.returnableFrom(id);
        vm.prank(eoa[0]);
        collection.setApprovalForAll(a.vault, true);
        vm.warp(at - 1);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotRevealed.selector, id));
        vault.returnItem(id, 0, block.timestamp);
        vm.warp(at);
        _returnItem(eoa[0], id);
        assertEq(collection.ownerOf(id), a.vault);
        _approveT(eoa[4], a.vault);
        vm.prank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotRevealed.selector, id));
        vault.withdraw(id, type(uint256).max, block.timestamp);
        _publish(id);
        _pick(eoa[4], id);
        _assertVault();
    }

    function testProperty_AUDIT_U7_erc721AuthorityEventsAndRefusedSends() public {
        _toDrawing();
        uint256 id = itemA;
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InsufficientApproval.selector, address(this), id));
        collection.transferFrom(eoa[3], eoa[4], id);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidApprover.selector, address(this)));
        collection.approve(eoa[4], id);
        vm.prank(eoa[3]);
        vm.expectEmit(true, true, true, true, a.collection);
        emit IBoxCollection.Approval(eoa[3], eoa[4], id);
        collection.approve(eoa[4], id);
        assertEq(collection.getApproved(id), eoa[4]);
        vm.prank(eoa[4]);
        vm.expectEmit(true, true, true, true, a.collection);
        emit IBoxCollection.Transfer(eoa[3], eoa[5], id);
        collection.transferFrom(eoa[3], eoa[5], id);
        assertEq(collection.getApproved(id), address(0));
        assertEq(collection.balanceOf(eoa[3]), 0);
        assertEq(collection.balanceOf(eoa[5]), 1);
        vm.prank(eoa[5]);
        vm.expectEmit(true, true, false, true, a.collection);
        emit IBoxCollection.ApprovalForAll(eoa[5], eoa[4], true);
        collection.setApprovalForAll(eoa[4], true);
        address[3] memory refused = [a.vault, a.collection, a.token];
        for (uint256 i; i < refused.length; ++i) {
            vm.prank(eoa[4]);
            vm.expectRevert(abi.encodeWithSelector(IBoxCollection.DirectSendRefused.selector, refused[i]));
            collection.safeTransferFrom(eoa[5], refused[i], id);
        }
        vm.prank(eoa[4]);
        collection.safeTransferFrom(eoa[5], eoa[0], id, hex"1234");
        assertEq(collection.ownerOf(id), eoa[0]);
        vm.prank(eoa[5]);
        collection.setApprovalForAll(eoa[4], false);
        assertFalse(collection.isApprovedForAll(eoa[5], eoa[4]));
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidOwner.selector, address(0)));
        collection.balanceOf(address(0));
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721NonexistentToken.selector, editionSize + 1));
        collection.ownerOf(editionSize + 1);
        _assertVault();
    }

    /// @notice Property: ticket U7.7 says a receiver cannot change E; BoxCollection.sol:682-683 releases its
    /// transfer lock before the receiver, while BoxVault.sol:510-540 gives the current owner the return right.
    /// Expected: E unchanged throughout a safe-transfer receiver callback.
    /// Observed: a receiver can exercise its newly acquired owner's return right (not a double withdrawal).
    /// Steps: real draw/reveal; safe transfer to receiver; receiver approves vault and returns that same item.
    /// Amounts: E 3550320655513595951339578 -> 3043466387602632234478881;
    /// principal 506854267910963716860697; fee ceil(principal*5/100). No value is created.
    function test_AUDIT_U7_51_standaloneReceiverCanReturnItsNewItem() public {
        _toDrawing();
        AuditU7LaneReturningReceiver r = new AuditU7LaneReturningReceiver(vault, collection);
        uint256 e = vault.escrowPrincipal();
        uint256 p = vault.quoteReturn(1);
        uint256 s = token.totalSupply();
        vm.prank(eoa[3]);
        collection.safeTransferFrom(eoa[3], address(r), itemA);
        assertEq(vault.escrowPrincipal(), e - p);
        assertEq(token.balanceOf(address(r)), p - _fee(p, 500));
        assertEq(token.totalSupply(), s - _fee(p, 500));
        assertTrue(r.finalOwnerSeen());
        assertEq(r.callbacks(), 1);
        assertEq(collection.ownerOf(itemA), a.vault);
        assertEq(collection.balanceOf(address(r)), 0);
        _assertVault();
    }
}
