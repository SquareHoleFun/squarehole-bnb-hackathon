// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    AuditU7LaneBase,
    BoxCollection,
    BoxVault,
    ItemReveal,
    VaultAction,
    IBoxCollection,
    IBoxVault,
    IBoxTickets,
    IBoxToken,
    IERC721TokenReceiver,
    Vm
} from "./AuditU7LaneBase.sol";

/// @notice Callee fault injection only: etched over the observer in individual tests, never in invariants.
contract AuditU7LaneObserver {
    BoxVault internal immutable vault;
    BoxCollection internal immutable collection;
    uint256 internal immutable mode;
    event BeforeVault(uint256 gasAvailable, uint256 inside, uint256 escrow, uint256 argument);
    event BeforeTransfer(uint256 gasAvailable, address owner, uint256 balance, uint256 id);

    constructor(BoxVault v, BoxCollection c, uint256 m) {
        vault = v;
        collection = c;
        mode = m;
    }

    function onVaultAction(VaultAction, address, uint256, uint256 insideBefore) external {
        uint256 g = gasleft();
        _fault();
        emit BeforeVault(g, vault.inside(), vault.escrowPrincipal(), insideBefore);
    }

    function onItemTransfer(address from, address, uint256 id) external {
        uint256 g = gasleft();
        _fault();
        emit BeforeTransfer(g, collection.ownerOf(id), collection.balanceOf(from), id);
    }

    function _fault() private view {
        if (mode == 1) revert("observer fault");
        if (mode == 2) {
            assembly ("memory-safe") { for {} 1 {} {} }
        }
    }
}

/// @notice A receiver is allowed to forward its item after final state; vault reentry must fail during withdrawal.
contract AuditU7LaneReceiver is IERC721TokenReceiver {
    BoxVault internal immutable vault;
    BoxCollection internal immutable collection;
    IBoxToken internal immutable token;
    address internal immutable destination;
    uint256 public callbacks;
    uint256 public escrowAtCallback;
    bool public finalState;
    bool public withdrew;
    bool public returned;
    bool public revealed;
    bool public forwarded;
    bytes internal revealData;

    constructor(BoxVault v, BoxCollection c, IBoxToken t, address to) {
        vault = v;
        collection = c;
        token = t;
        destination = to;
    }

    function configure(bytes memory r) external {
        revealData = r;
    }

    function buy(uint256 id) external {
        token.approve(address(vault), type(uint256).max);
        vault.withdraw(id, type(uint256).max, block.timestamp);
    }

    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        require(msg.sender == address(collection));
        ++callbacks;
        escrowAtCallback = vault.escrowPrincipal();
        finalState = collection.ownerOf(id) == address(this) && collection.balanceOf(address(this)) == 1
            && collection.getApproved(id) == address(0) && vault.isOutside(id);
        (withdrew,) = address(vault).call(abi.encodeCall(vault.withdraw, (id, type(uint256).max, block.timestamp)));
        collection.approve(address(vault), id);
        (returned,) = address(vault).call(abi.encodeCall(vault.returnItem, (id, 0, block.timestamp)));
        (revealed,) = address(collection).call(revealData);
        (forwarded,) =
            address(collection).call(abi.encodeCall(collection.transferFrom, (address(this), destination, id)));
        require(vault.escrowPrincipal() == escrowAtCallback, "callback changed E during vault action");
        return IERC721TokenReceiver.onERC721Received.selector;
    }
}

/// @notice Multiple complete operations in one external transaction; accepts the returned safe transfers.
contract AuditU7LaneBatchActor is IERC721TokenReceiver {
    BoxVault internal immutable vault;
    BoxCollection internal immutable collection;
    IBoxToken internal immutable token;

    constructor(BoxVault v, BoxCollection c, IBoxToken t) {
        vault = v;
        collection = c;
        token = t;
    }

    function cycles(uint256[] memory ids, uint256 times) external {
        collection.setApprovalForAll(address(vault), true);
        token.approve(address(vault), type(uint256).max);
        for (uint256 i; i < times; ++i) {
            vault.returnItems(ids, 0, block.timestamp);
            vault.withdrawBatch(ids, type(uint256).max, block.timestamp);
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721TokenReceiver.onERC721Received.selector;
    }
}

/// @notice A malformed ERC-721 receiver response, used only to test safe-transfer atomicity.
contract AuditU7LaneRefusingReceiver is IERC721TokenReceiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xffffffff;
    }
}

/// @notice U7.6-8, real box 0, explicit observer/adapter/receiver fault injections only where documented.
/// forge-config: default.evm_version = "osaka"
contract AuditU7LaneCallbacks is AuditU7LaneBase {
    function testProperty_AUDIT_U7_safeReceiverRefusalRollsBackApprovalsAndOwners() public {
        _toDrawing();
        address bad = address(new AuditU7LaneRefusingReceiver());
        vm.prank(eoa[3]);
        collection.approve(eoa[4], itemA);
        uint256 e = vault.escrowPrincipal();
        vm.prank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidReceiver.selector, bad));
        collection.safeTransferFrom(eoa[3], bad, itemA, hex"1234");
        assertEq(collection.getApproved(itemA), eoa[4]);
        assertEq(collection.ownerOf(itemA), eoa[3]);
        assertEq(collection.balanceOf(bad), 0);
        assertEq(vault.escrowPrincipal(), e);
        vm.prank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidReceiver.selector, address(0)));
        collection.transferFrom(eoa[3], address(0), itemA);
        _assertVault();
    }

    function testProperty_AUDIT_U7_deliveryReceiverMayRevealOnceAndForward() public {
        _toDrawing();
        _cacheTree();
        AuditU7LaneReceiver r = new AuditU7LaneReceiver(vault, collection, IBoxToken(a.token), eoa[5]);
        r.configure(_revealCall(itemB, _data(itemB)));
        uint256 e = vault.escrowPrincipal();
        uint256 revealed = collection.revealedCount();
        ItemReveal memory empty;
        vm.prank(address(contractDrawer));
        tickets.openDraw(drawB, address(r), empty);
        assertTrue(r.finalState());
        assertEq(r.callbacks(), 1);
        assertFalse(r.withdrew());
        assertFalse(r.returned());
        assertTrue(r.revealed());
        assertTrue(r.forwarded());
        assertEq(collection.revealedCount(), revealed + 1);
        assertEq(collection.ownerOf(itemB), eoa[5]);
        assertEq(collection.balanceOf(address(r)), 0);
        assertEq(vault.escrowPrincipal(), e);
        _assertVault();
    }

    function testProperty_AUDIT_U7_observerBeforeStateAndFullCap() public {
        _toDrawing();
        uint256 n = vault.inside();
        uint256 e = vault.escrowPrincipal();
        AuditU7LaneObserver spy = new AuditU7LaneObserver(vault, collection, 0);
        vm.etch(a.itemStream, address(spy).code);
        vm.recordLogs();
        _returnItem(eoa[3], itemA);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawVault;
        bool sawCollection;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != a.itemStream) continue;
            if (logs[i].topics[0] == AuditU7LaneObserver.BeforeVault.selector) {
                (uint256 g, uint256 observedN, uint256 observedE, uint256 arg) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                assertLe(g, 460_000);
                assertGt(g, 455_000);
                assertEq(observedN, n);
                assertEq(arg, n);
                assertEq(observedE, e);
                sawVault = true;
            } else if (logs[i].topics[0] == AuditU7LaneObserver.BeforeTransfer.selector) {
                (uint256 g, address owner, uint256 balance, uint256 id) =
                    abi.decode(logs[i].data, (uint256, address, uint256, uint256));
                assertTrue(sawVault, "vault observer before collection observer");
                assertLe(g, 460_000);
                assertGt(g, 455_000);
                assertEq(owner, eoa[3]);
                assertEq(balance, 1);
                assertEq(id, itemA);
                sawCollection = true;
            }
        }
        assertTrue(sawVault && sawCollection);
        assertEq(vault.observerGas(), 460_000);
        assertEq(collection.observerGas(), 460_000);
        _assertVault();
    }

    function testProperty_AUDIT_U7_observerFailureDoesNotRedirectOwnership() public {
        _toDrawing();
        uint256 snapshot = vm.snapshotState();
        for (uint256 mode = 1; mode <= 2; ++mode) {
            AuditU7LaneObserver bad = new AuditU7LaneObserver(vault, collection, mode);
            vm.etch(a.itemStream, address(bad).code);
            vm.recordLogs();
            vm.prank(eoa[3]);
            collection.transferFrom(eoa[3], eoa[4], itemA);
            assertEq(collection.ownerOf(itemA), eoa[4]);
            uint256 p = vault.quoteReturn(1);
            uint256 e = vault.escrowPrincipal();
            _returnItem(eoa[4], itemA);
            assertEq(collection.ownerOf(itemA), a.vault);
            assertEq(vault.escrowPrincipal(), e - p);
            _pick(eoa[5], itemA);
            assertEq(collection.ownerOf(itemA), eoa[5]);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            uint256 failures;
            for (uint256 i; i < logs.length; ++i) {
                if (
                    logs[i].topics[0] == IBoxCollection.TransferObserverFailed.selector
                        || logs[i].topics[0] == IBoxVault.VaultObserverFailed.selector
                ) ++failures;
            }
            assertEq(failures, 5, "three transfers and two vault callbacks");
            _assertVault();
            assertTrue(vm.revertToState(snapshot));
        }
    }

    function testProperty_AUDIT_U7_lowGasRefusesAtomically() public {
        _toDrawing();
        uint256 e = vault.escrowPrincipal();
        vm.prank(eoa[3]);
        (bool ok, bytes memory reason) =
            a.collection.call{gas: 200_000}(abi.encodeCall(collection.transferFrom, (eoa[3], eoa[4], itemA)));
        assertFalse(ok);
        assertEq(bytes4(reason), IBoxCollection.ObserverGasTooLow.selector);
        assertEq(collection.ownerOf(itemA), eoa[3]);
        vm.prank(eoa[3]);
        collection.setApprovalForAll(a.vault, true);
        vm.prank(eoa[3]);
        (ok, reason) = a.vault.call{gas: 200_000}(abi.encodeCall(vault.returnItem, (itemA, 0, block.timestamp)));
        assertFalse(ok);
        assertEq(bytes4(reason), IBoxVault.ObserverGasTooLow.selector);
        assertEq(collection.ownerOf(itemA), eoa[3]);
        assertEq(vault.escrowPrincipal(), e);
        _assertVault();
    }

    /// @notice Failed/short returnableFrom callee data is treated as not returnable (settled S3 regression).
    function testProperty_AUDIT_U7_failedReturnableFromIsClosed() public {
        _toDrawing();
        vm.warp(uint256(tickets.status().wordAcceptedAt) + tickets.REVEAL_GRACE());
        uint256 id = _open(eoa[0], 2, false);
        vm.warp(tickets.returnableFrom(id));
        vm.prank(eoa[0]);
        collection.setApprovalForAll(a.vault, true);
        bytes memory query = abi.encodeCall(IBoxTickets.returnableFrom, (id));
        vm.mockCallRevert(a.tickets, query, hex"bad0");
        _refusedReturn(id);
        vm.clearMockedCalls();
        vm.mockCall(a.tickets, query, hex"01");
        _refusedReturn(id);
        vm.clearMockedCalls();
        _returnItem(eoa[0], id);
        _assertVault();
    }

    function _refusedReturn(uint256 id) private {
        uint256 e = vault.escrowPrincipal();
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotRevealed.selector, id));
        vault.returnItem(id, 0, block.timestamp);
        assertEq(vault.escrowPrincipal(), e);
        assertEq(collection.ownerOf(id), eoa[0]);
    }

    function testProperty_AUDIT_U7_withdrawReceiverFinalStateReentryAndForward() public {
        _toDrawing();
        _returnItem(eoa[3], itemA);
        _cacheTree();
        AuditU7LaneReceiver r = new AuditU7LaneReceiver(vault, collection, IBoxToken(a.token), eoa[5]);
        r.configure(_revealCall(itemA, _data(itemA)));
        uint256 p = vault.quoteWithdraw(1);
        uint256 e = vault.escrowPrincipal();
        vm.prank(eoa[4]);
        token.transfer(address(r), p + _fee(p, 2500));
        r.buy(itemA);
        assertTrue(r.finalState());
        assertEq(r.callbacks(), 1);
        assertFalse(r.withdrew());
        assertFalse(r.returned());
        assertFalse(r.revealed());
        assertTrue(r.forwarded());
        assertEq(collection.ownerOf(itemA), eoa[5]);
        assertEq(collection.balanceOf(address(r)), 0);
        assertEq(vault.escrowPrincipal(), e + p);
        assertEq(r.escrowAtCallback(), e + p);
        _assertVault();
    }

    function testProperty_AUDIT_U7_overlappingBatchesMatchSeparateTransactions() public {
        _toDrawing();
        uint256[] memory ids = new uint256[](2);
        ids[0] = itemA;
        ids[1] = itemP1;
        AuditU7LaneBatchActor actor = new AuditU7LaneBatchActor(vault, collection, IBoxToken(a.token));
        vm.prank(eoa[3]);
        collection.safeTransferFrom(eoa[3], address(actor), itemA);
        vm.prank(eoa[0]);
        collection.safeTransferFrom(eoa[0], address(actor), itemP1);
        uint256 funding = token.balanceOf(eoa[4]);
        vm.prank(eoa[4]);
        token.transfer(address(actor), funding);
        uint256 snapshot = vm.snapshotState();
        actor.cycles(ids, 2); // four vault calls in ONE transaction, the same ids overlap every time
        bytes32 combined = _batchState(address(actor), ids);
        assertTrue(vm.revertToState(snapshot));
        actor.cycles(ids, 1); // isolate=true: each top-level call is a separate transaction
        actor.cycles(ids, 1);
        assertEq(_batchState(address(actor), ids), combined);
        _assertVault();
    }

    function _batchState(address owner, uint256[] memory ids) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                vault.escrowPrincipal(),
                vault.inside(),
                token.totalSupply(),
                token.balanceOf(owner),
                collection.balanceOf(owner),
                collection.ownerOf(ids[0]),
                collection.ownerOf(ids[1])
            )
        );
    }

    function testProperty_AUDIT_U7_duplicateBatchesRollbackAndClearMarks() public {
        _toDrawing();
        uint256[] memory ids = new uint256[](2);
        ids[0] = itemA;
        ids[1] = itemA;
        uint256 e = vault.escrowPrincipal();
        vm.prank(eoa[3]);
        vm.expectRevert(IBoxVault.InvalidIdList.selector);
        vault.returnItems(ids, 0, block.timestamp);
        assertEq(vault.escrowPrincipal(), e);
        _returnItem(eoa[3], itemA);
        e = vault.escrowPrincipal();
        _approveT(eoa[4], a.vault);
        vm.prank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.IneligibleId.selector, itemA));
        vault.withdrawBatch(ids, type(uint256).max, block.timestamp);
        assertEq(vault.escrowPrincipal(), e);
        _pick(eoa[4], itemA);
        assertEq(collection.ownerOf(itemA), eoa[4]);
        _assertVault();
    }
}

/// @notice Same gas-sensitive callbacks under the future state-gas schedule; accepted M16 remains fail-safe.
/// forge-config: default.evm_version = "amsterdam"
contract AuditU7LaneCallbacksAmsterdam is AuditU7LaneCallbacks {}
