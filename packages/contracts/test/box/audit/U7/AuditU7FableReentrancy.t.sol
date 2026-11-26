// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TransientReentrancyGuard} from "../../../../src/libraries/TransientReentrancyGuard.sol";
import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxItemStream} from "../../../../src/box/BoxItemStream.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {ItemReveal, VaultAction} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCollection, IERC721TokenReceiver} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxToken} from "../../../../src/box/interfaces/IBoxToken.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU7FableBase} from "./AuditU7FableBase.sol";

/// @notice TEST ONLY. A receiver that acts inside `onERC721Received` (the callback a pick or a delivery gives the
/// recipient after the vault's state is final): it tries one chosen call and records whether it passed.
contract AuditU7FableReenterer is IERC721TokenReceiver {
    enum Act {
        None,
        Withdraw,
        WithdrawBatch,
        Return,
        Transfer,
        SafeTransferToVault,
        Reveal,
        OpenPlaceholder,
        Claim,
        SendT
    }

    BoxVault internal vault;
    BoxCollection internal collection;
    BoxTickets internal tickets;
    BoxItemStream internal stream;
    BoxToken internal token;
    Act public act;
    uint256 public target;
    address public to;
    ItemReveal internal _r;
    bool public innerOk;
    bytes public innerData;
    uint256 public calls;
    uint256 public lastId;

    constructor(BoxVault v, BoxCollection c, BoxTickets t, BoxItemStream s, BoxToken tk) {
        (vault, collection, tickets, stream, token) = (v, c, t, s, tk);
    }

    function set(Act a, uint256 target_, address to_) external {
        act = a;
        target = target_;
        to = to_;
        innerOk = false;
        delete innerData;
    }

    function setReveal(ItemReveal memory r) external {
        _r = r;
    }

    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        ++calls;
        lastId = id;
        bytes memory data;
        address callee = address(vault);
        if (act == Act.Withdraw) {
            data = abi.encodeCall(vault.withdraw, (target, type(uint256).max, block.timestamp));
        } else if (act == Act.WithdrawBatch) {
            uint256[] memory ids = new uint256[](1);
            ids[0] = target;
            data = abi.encodeCall(vault.withdrawBatch, (ids, type(uint256).max, block.timestamp));
        } else if (act == Act.Return) {
            data = abi.encodeCall(vault.returnItem, (id, 0, block.timestamp));
        } else if (act == Act.Transfer) {
            callee = address(collection);
            data = abi.encodeCall(collection.transferFrom, (address(this), to, id));
        } else if (act == Act.SafeTransferToVault) {
            callee = address(collection);
            data = abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", address(this), vault, id);
        } else if (act == Act.Reveal) {
            callee = address(collection);
            data = abi.encodeCall(
                collection.reveal, (id, _r.traitsPacked, _r.imageHash, _r.avatarHash, _r.modelHash, _r.salt, _r.proof)
            );
        } else if (act == Act.OpenPlaceholder) {
            callee = address(tickets);
            ItemReveal memory none;
            data = abi.encodeCall(tickets.open, (target, none));
        } else if (act == Act.Claim) {
            callee = address(stream);
            uint256[] memory ids = new uint256[](1);
            ids[0] = id;
            data = abi.encodeCall(stream.claim, (ids, address(this)));
        } else if (act == Act.SendT) {
            callee = address(token);
            data = abi.encodeCall(token.transfer, (address(vault), 1));
        } else {
            return IERC721TokenReceiver.onERC721Received.selector;
        }
        (innerOk, innerData) = callee.call(data);
        return IERC721TokenReceiver.onERC721Received.selector;
    }
}

/// @notice TEST ONLY. Runs vault batches one after another in ONE call (one transaction for the transient marks).
contract AuditU7FableBatcher is IERC721TokenReceiver {
    BoxVault internal vault;
    BoxCollection internal collection;
    BoxToken internal token;
    bytes4[] public results;

    constructor(BoxVault v, BoxCollection c, BoxToken t) {
        (vault, collection, token) = (v, c, t);
        token.approve(address(v), type(uint256).max);
    }

    function prepare() external {
        collection.setApprovalForAll(address(vault), true);
    }

    /// @notice Owning x and y outside: a return with a repeated id, the same pair returned, the pair again, a pick
    /// with a repeated id, the pair picked, one of them again, the pair returned in the other order.
    function run(uint256 x, uint256 y) external {
        delete results;
        uint256[] memory xyx = new uint256[](3);
        (xyx[0], xyx[1], xyx[2]) = (x, y, x);
        uint256[] memory xy = new uint256[](2);
        (xy[0], xy[1]) = (x, y);
        uint256[] memory xx = new uint256[](2);
        (xx[0], xx[1]) = (x, x);
        uint256[] memory yx = new uint256[](2);
        (yx[0], yx[1]) = (y, x);
        uint256[] memory onlyX = new uint256[](1);
        onlyX[0] = x;
        _try(abi.encodeCall(vault.returnItems, (xyx, 0, block.timestamp)));
        _try(abi.encodeCall(vault.returnItems, (xy, 0, block.timestamp)));
        _try(abi.encodeCall(vault.returnItems, (xy, 0, block.timestamp)));
        _try(abi.encodeCall(vault.withdrawBatch, (xx, type(uint256).max, block.timestamp)));
        _try(abi.encodeCall(vault.withdrawBatch, (xy, type(uint256).max, block.timestamp)));
        _try(abi.encodeCall(vault.withdrawBatch, (onlyX, type(uint256).max, block.timestamp)));
        _try(abi.encodeCall(vault.returnItems, (yx, 0, block.timestamp)));
    }

    function count() external view returns (uint256) {
        return results.length;
    }

    function _try(bytes memory data) private {
        (bool ok, bytes memory ret) = address(vault).call(data);
        results.push(ok ? bytes4(0) : bytes4(ret));
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721TokenReceiver.onERC721Received.selector;
    }
}

/// @notice SH-AUDIT-B0 U7 (Fable). Reentrancy, callbacks and the observer (L3 P7.6, P7.7, P7.8) on the factory's
/// box 0: what a recipient can and cannot do inside `onERC721Received` during a pick or a delivery; an observer that
/// reverts or burns all its gas (its code stood in at the stream's address, stated); `ObserverGasTooLow`; batches
/// with overlapping ids in one transaction.
/// forge-config: default.evm_version = "osaka"
contract AuditU7FableReentrancyTest is AuditU7FableBase {
    AuditU7FableReenterer internal re;
    AuditU7FableBatcher internal batcher;

    function setUp() public override {
        super.setUp();
        _toDrawing();
        _buildTree();
        _stockShelfKeepingFour(); // placeholders 4 and 5 stay live for the delivery paths
        re = new AuditU7FableReenterer(vault, collection, tickets, stream, token);
        batcher = new AuditU7FableBatcher(vault, collection, token);
        _ghostAddOutside(address(re));
        _ghostAddOutside(address(batcher));
        (uint256 p, uint256 f) = _pickQuote(shelf.length);
        _fundT(address(re), 3 * (p + f));
        _fundT(address(batcher), 3 * (p + f));
    }

    // ============================================================================================ P7.7 callbacks

    /// P7.7 (`TransientReentrancyGuard.sol`, `BoxVault.sol:43, 227-260`): inside the callback of a pick the recipient
    /// cannot re-enter `withdraw`, `withdrawBatch` or `returnItem` (the vault's lock is held, `Reentrancy()`), cannot
    /// send the item or T into the vault, and the pick's outcome is unchanged: one item, E as quoted.
    function testProperty_AUDIT_U7_receiverCannotReenterTheVault() public {
        uint256 id = shelf[0];
        uint256 other = shelf[1];
        AuditU7FableReenterer.Act[5] memory acts = [
            AuditU7FableReenterer.Act.Withdraw,
            AuditU7FableReenterer.Act.WithdrawBatch,
            AuditU7FableReenterer.Act.Return,
            AuditU7FableReenterer.Act.SafeTransferToVault,
            AuditU7FableReenterer.Act.SendT
        ];
        bytes4[5] memory expected = [
            TransientReentrancyGuard.Reentrancy.selector,
            TransientReentrancyGuard.Reentrancy.selector,
            TransientReentrancyGuard.Reentrancy.selector,
            IBoxCollection.DirectSendRefused.selector,
            IBoxToken.DirectSendRefused.selector
        ];
        for (uint256 i; i < acts.length; ++i) {
            uint256 snap = vm.snapshotState();
            re.set(acts[i], other, address(0));
            (uint256 p, uint256 f) = _pickQuote(1);
            uint256 e0 = vault.escrowPrincipal();
            (uint256 principal, uint256 fee) = _pick(address(re), id);
            assertEq(principal, p);
            assertEq(fee, f);
            assertEq(re.calls(), 1, "one callback");
            assertEq(re.lastId(), id);
            assertFalse(re.innerOk(), "the inner call failed");
            assertEq(bytes4(re.innerData()), expected[i], "with the lock's or the refusal's error");
            assertEq(collection.ownerOf(id), address(re));
            assertEq(collection.ownerOf(other), a.vault, "the other item stayed");
            assertEq(vault.escrowPrincipal(), e0 + p, "E moved by one quote only");
            assertEq(collection.balanceOf(address(re)), 1);
            _assertVlt08("after a re-entering pick");
            _assertGhostLedger();
            vm.revertToState(snap);
        }
    }

    /// P7.7 (`BoxCollection.sol:682-683`: the receiver hook runs after the lock is released): inside the callback the
    /// recipient may move the item on (the real stream checkpoints the second move too) and may read its claim; the
    /// vault's counts and E stay those of one pick.
    function testProperty_AUDIT_U7_receiverMayMoveTheItemOnDuringAPick() public {
        uint256 id = shelf[0];
        re.set(AuditU7FableReenterer.Act.Transfer, 0, eoa[5]);
        (uint256 p,) = _pickQuote(1);
        uint256 e0 = vault.escrowPrincipal();
        uint256 n0 = vault.inside();
        _pick(address(re), id);
        assertTrue(re.innerOk(), "the onward transfer passed");
        assertEq(collection.ownerOf(id), eoa[5]);
        assertEq(collection.balanceOf(address(re)), 0);
        assertEq(collection.balanceOf(eoa[5]), 1);
        (address rec,) = stream.pendingOf(id);
        assertEq(rec, eoa[5], "the stream saw the second move");
        assertEq(vault.escrowPrincipal(), e0 + p);
        assertEq(vault.inside(), n0 - 1);
        assertTrue(vault.isOutside(id));
        _assertVlt08("after a pick moved on");
        // A claim from inside the callback: allowed, pays nothing (the item started at this J).
        re.set(AuditU7FableReenterer.Act.Claim, 0, address(0));
        uint256 t0 = token.balanceOf(address(re));
        (uint256 p2, uint256 f2) = _pickQuote(1);
        _pick(address(re), shelf[1]);
        assertTrue(re.innerOk(), "claim inside the callback passed");
        assertEq(token.balanceOf(address(re)), t0 - p2 - f2, "and paid nothing");
        _assertVlt08("after a claim inside a pick");
        _assertGhostLedger();
    }

    /// P7.7 (`BoxTickets.sol:690-704`, `BoxCollection.sol:309-337`): during a delivery the recipient cannot open
    /// another placeholder (the tickets' lock) nor pick (the vault's lock); it may reveal the item it is receiving
    /// (anyone may, once it left), which lets its own empty-proof open complete as a revealed one.
    function testProperty_AUDIT_U7_receiverDuringADelivery() public {
        // The reenterer holds placeholder 5 (eoa[1] gives it).
        vm.prank(eoa[1]);
        tickets.transferFrom(eoa[1], address(re), 5);
        uint256 item5 = tickets.numberOf(5);
        uint256 snap = vm.snapshotState();
        // A pick from inside the delivery: the vault is locked.
        re.set(AuditU7FableReenterer.Act.Withdraw, shelf[0], address(0));
        vm.prank(address(re));
        uint256 got = tickets.open(5, _revealOf(item5));
        assertEq(got, item5);
        assertFalse(re.innerOk());
        assertEq(bytes4(re.innerData()), TransientReentrancyGuard.Reentrancy.selector, "the vault's lock");
        assertEq(collection.ownerOf(item5), address(re));
        assertEq(collection.ownerOf(shelf[0]), a.vault);
        _assertVlt08("after a delivery with a re-entering pick");
        vm.revertToState(snap);
        // Opening placeholder 4 from inside the delivery of 5: the tickets' lock.
        vm.prank(eoa[1]);
        tickets.transferFrom(eoa[1], address(re), 4);
        re.set(AuditU7FableReenterer.Act.OpenPlaceholder, 4, address(0));
        vm.prank(address(re));
        tickets.open(5, _revealOf(item5));
        assertFalse(re.innerOk());
        assertEq(bytes4(re.innerData()), TransientReentrancyGuard.Reentrancy.selector, "the tickets' lock");
        assertEq(tickets.ownerOf(4), address(re), "placeholder 4 still open");
        _assertVlt08("after a delivery with a re-entering open");
        vm.revertToState(snap);
        // The reveal from inside the delivery of an empty-proof open before the grace: the item has left, so the
        // reveal verifies; the opening then reads it as revealed and does not mark it as left unrevealed.
        uint256 count0 = collection.revealedCount();
        re.setReveal(_revealOf(item5));
        re.set(AuditU7FableReenterer.Act.Reveal, 0, address(0));
        vm.prank(address(re));
        got = tickets.open(5, _emptyReveal());
        assertEq(got, item5);
        assertTrue(re.innerOk(), "the reveal inside the callback passed");
        assertTrue(collection.isRevealed(item5));
        assertEq(tickets.returnableFrom(item5), 0, "not marked as left unrevealed");
        assertEq(collection.revealedCount(), count0 + 1);
        _assertVlt08("after a delivery revealed from inside");
        _assertGhostLedger();
    }

    // ============================================================================================ P7.6 observer

    /// P7.6 (M16 accepted; `BoxVault.sol:621-634`, `BoxCollection.sol:712-720`; `IBoxItemStream.sol:10-14`): an
    /// observer that reverts, or one that burns all the gas it is given, is skipped with `VaultObserverFailed` /
    /// `TransferObserverFailed`; the pick, the transfer and the return happen exactly as with the real stream; the
    /// vault's T balance stays E. The observer is stood in by etching an actor's code at the stream's address
    /// (stated: a stand-in for the observer's behaviour, restored by the snapshot).
    function testProperty_AUDIT_U7_observerFailureDoesNotChangeOutcomes() public {
        uint256 id = shelf[0];
        bytes[2] memory codes = [address(ethRefuser).code, address(gasBurner).code];
        for (uint256 i; i < codes.length; ++i) {
            uint256 snap = vm.snapshotState();
            vm.etch(a.itemStream, codes[i]);
            uint256 e0 = vault.escrowPrincipal();
            uint256 n0 = vault.inside();
            uint256 p = _failedObserverPick(id);
            uint256 r = _failedObserverMoveAndReturn(id);
            assertEq(vault.inside(), n0);
            assertEq(vault.escrowPrincipal(), e0 + p - r);
            _assertVlt08(i == 0 ? "observer reverting" : "observer burning all gas");
            _assertGhostLedger();
            vm.revertToState(snap);
        }
    }

    /// @dev eoa[5] picks `id` with the stream's code failing: both failed-observer events, the quote unchanged.
    function _failedObserverPick(uint256 id) internal returns (uint256 p) {
        uint256 f;
        (p, f) = _pickQuote(1);
        uint256 e0 = vault.escrowPrincipal();
        _fundT(eoa[5], p + f);
        _approveT(eoa[5], a.vault);
        uint256 t0 = token.balanceOf(eoa[5]);
        vm.expectEmit(true, true, true, true, a.vault);
        emit IBoxVault.VaultObserverFailed(VaultAction.Withdrawn, eoa[5], 1);
        vm.expectEmit(true, true, true, true, a.collection);
        emit IBoxCollection.TransferObserverFailed(a.vault, eoa[5], id);
        vm.prank(eoa[5]);
        (uint256 principal, uint256 fee) = vault.withdraw(id, type(uint256).max, block.timestamp);
        _noteTChange(t0, token.balanceOf(eoa[5]), TIn.Pick, TOut.Other);
        assertEq(principal, p);
        assertEq(fee, f);
        assertEq(collection.ownerOf(id), eoa[5]);
        assertEq(vault.escrowPrincipal(), e0 + p);
        assertEq(token.balanceOf(a.vault), vault.escrowPrincipal());
    }

    /// @dev eoa[5] moves `id` to eoa[6], which returns it, the stream's code still failing: the events, the quote.
    function _failedObserverMoveAndReturn(uint256 id) internal returns (uint256 r) {
        vm.expectEmit(true, true, true, true, a.collection);
        emit IBoxCollection.TransferObserverFailed(eoa[5], eoa[6], id);
        vm.prank(eoa[5]);
        collection.transferFrom(eoa[5], eoa[6], id);
        assertEq(collection.ownerOf(id), eoa[6]);
        vm.prank(eoa[6]);
        collection.setApprovalForAll(a.vault, true);
        uint256 rf;
        (r, rf) = _returnQuote(1);
        uint256 t0 = token.balanceOf(eoa[6]);
        vm.expectEmit(true, true, true, true, a.vault);
        emit IBoxVault.VaultObserverFailed(VaultAction.Returned, eoa[6], 1);
        vm.expectEmit(true, true, true, true, a.collection);
        emit IBoxCollection.TransferObserverFailed(eoa[6], a.vault, id);
        vm.prank(eoa[6]);
        (uint256 principal, uint256 fee) = vault.returnItem(id, 0, block.timestamp);
        _noteTChange(t0, token.balanceOf(eoa[6]), TIn.Other, TOut.Return);
        assertEq(principal, r);
        assertEq(fee, rf);
        assertEq(collection.ownerOf(id), a.vault);
    }

    /// P7.6 (`BoxVault.sol:58, 626-627`; `BoxCollection.sol:65, 714-715`; F90 R16H; stream-gas R4): a pick, a return
    /// and a transfer sent with the cap itself as the call's gas revert `ObserverGasTooLow` naming the floor 477,301
    /// (nothing moves); with the floor reached at the observer call they run. The exact least call gas is measured
    /// in the gas suite.
    function testProperty_AUDIT_U7_observerGasTooLowAtTheCap() public {
        uint256 id = shelf[0];
        (uint256 p, uint256 f) = _pickQuote(1);
        _fundT(eoa[5], p + f);
        _approveT(eoa[5], a.vault);
        vm.prank(eoa[5]);
        (bool ok, bytes memory err) =
            a.vault.call{gas: OBSERVER_GAS}(abi.encodeCall(vault.withdraw, (id, type(uint256).max, block.timestamp)));
        assertFalse(ok);
        assertEq(bytes4(err), IBoxVault.ObserverGasTooLow.selector);
        (, uint256 required) = abi.decode(_tail(err), (uint256, uint256));
        assertEq(required, OBSERVER_FLOOR, "477,301");
        assertEq(collection.ownerOf(id), a.vault, "nothing moved");
        _pick(eoa[5], id);
        vm.prank(eoa[5]);
        (ok, err) = a.collection.call{gas: OBSERVER_GAS}(abi.encodeCall(collection.transferFrom, (eoa[5], eoa[6], id)));
        assertFalse(ok);
        assertEq(bytes4(err), IBoxCollection.ObserverGasTooLow.selector);
        (, required) = abi.decode(_tail(err), (uint256, uint256));
        assertEq(required, OBSERVER_FLOOR);
        vm.prank(eoa[5]);
        collection.setApprovalForAll(a.vault, true);
        vm.prank(eoa[5]);
        (ok, err) = a.vault.call{gas: OBSERVER_GAS}(abi.encodeCall(vault.returnItem, (id, 0, block.timestamp)));
        assertFalse(ok);
        assertEq(bytes4(err), IBoxVault.ObserverGasTooLow.selector);
        assertEq(collection.ownerOf(id), eoa[5], "nothing moved");
        _returnItem(eoa[5], id);
        _assertVlt08("after the gas-floor checks");
        _assertGhostLedger();
    }

    // ============================================================================================ P7.8 batches

    /// P7.8 (`BoxIdSet.sol:11-35`, `BoxVault.sol:514, 651-667`): in one transaction, a return with a repeated id is
    /// refused and leaves no mark (the same pair returns right after), the pair returned twice is refused as not
    /// outside (not as a list error), a pick with a repeated id is refused, a pair picked twice is refused as
    /// already outside, and the order of ids does not matter.
    function testProperty_AUDIT_U7_batchesInOneTransaction() public {
        uint256 x = shelf[0];
        uint256 y = shelf[1];
        batcher.prepare();
        _pickBatch(address(batcher), _ids2(x, y));
        uint256 t0 = token.balanceOf(address(batcher));
        uint256 e0 = vault.escrowPrincipal();
        uint256 s0 = token.totalSupply();
        uint256 n0 = vault.inside();
        batcher.run(x, y);
        _noteTChange(t0, token.balanceOf(address(batcher)), TIn.Pick, TOut.Return);
        assertEq(batcher.count(), 7);
        assertEq(batcher.results(0), IBoxVault.InvalidIdList.selector, "[x, y, x] is a list error");
        assertEq(batcher.results(1), bytes4(0), "[x, y] returns right after: no mark lingered");
        assertEq(batcher.results(2), IBoxVault.NotOwner.selector, "[x, y] again: not outside (not a list error)");
        assertEq(batcher.results(3), IBoxVault.IneligibleId.selector, "[x, x] pick: repeated id");
        assertEq(batcher.results(4), bytes4(0), "[x, y] picked");
        assertEq(batcher.results(5), IBoxVault.IneligibleId.selector, "[x] again: already outside");
        assertEq(batcher.results(6), bytes4(0), "[y, x] returned");
        assertEq(collection.ownerOf(x), a.vault);
        assertEq(collection.ownerOf(y), a.vault);
        assertTrue(vault.isOnShelf(x) && vault.isOnShelf(y));
        assertEq(vault.inside(), n0 + 2, "both inside again");
        // What the batcher paid in equals what E kept plus what was burned: T(batcher) + E + burned is constant.
        assertEq(
            token.balanceOf(address(batcher)) + vault.escrowPrincipal() + (s0 - token.totalSupply()),
            t0 + e0,
            "T paid = E kept + fees burned"
        );
        _assertVlt08("after batches in one transaction");
        _assertGhostLedger();
    }

    // ============================================================================================ helpers

    function _tail(bytes memory err) internal pure returns (bytes memory t) {
        t = new bytes(err.length - 4);
        for (uint256 i; i < t.length; ++i) {
            t[i] = err[i + 4];
        }
    }
}
