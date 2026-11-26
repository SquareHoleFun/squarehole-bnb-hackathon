// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCollection} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxToken} from "../../../../src/box/interfaces/IBoxToken.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {TransientReentrancyGuard} from "../../../../src/libraries/TransientReentrancyGuard.sol";
import {TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU7ClaudeBase, AuditU7ClaudeTree} from "./AuditU7ClaudeBase.sol";

/// @title AuditU7ClaudeReceiver
/// @notice TEST ONLY. An item holder with code whose `onERC721Received` re-enters box 0 (a stand-in: the property is how
/// the vault and the collection treat a receiver that calls back, plan § 1 World). On every receipt it records what it
/// saw (the vault's E, n, h, t, T's supply, the item's owner and outside bit) and tries, each caught: a named pick of
/// `pickId`, a return of the item just received, a take by number (`takeItem`), a transfer of the item to the vault, a
/// reveal of the item with the committed data, and (mode MoveOn) a transfer of the item to `onward`.
contract AuditU7ClaudeReceiver {
    enum Mode {
        Accept,
        MoveOn,
        WrongSelector,
        RevertWithReason,
        RevertEmpty
    }

    struct Seen {
        uint256 id;
        address operator;
        address from;
        uint256 e;
        uint256 n;
        uint256 h;
        uint256 t;
        uint256 s;
        address owner;
        bool outside;
        bool revealed;
        bytes4 pickErr;
        bytes4 returnErr;
        bytes4 takeErr;
        bytes4 toVaultErr;
        bool revealOk;
        bool movedOn;
    }

    IBoxVault public immutable vault;
    IBoxCollection public immutable collection;
    IBoxToken public immutable token;
    IBoxTickets public immutable tickets;
    AuditU7ClaudeTree public immutable tree;
    address public immutable onward;

    Mode public mode;
    uint256 public pickId;
    uint256 public takeItem;
    uint256 public takeIndex;
    bool public reenter;
    Seen[] internal _seen;

    constructor(IBoxVault v, IBoxCollection c, IBoxToken t, IBoxTickets tk, AuditU7ClaudeTree tr, address onward_) {
        (vault, collection, token, tickets, tree, onward) = (v, c, t, tk, tr, onward_);
        t.approve(address(v), type(uint256).max);
        t.approve(address(tk), type(uint256).max);
        c.setApprovalForAll(address(v), true);
    }

    function configure(Mode m, bool reenter_, uint256 pickId_, uint256 takeItem_, uint256 takeIndex_) external {
        (mode, reenter, pickId, takeItem, takeIndex) = (m, reenter_, pickId_, takeItem_, takeIndex_);
    }

    function seenCount() external view returns (uint256) {
        return _seen.length;
    }

    function seen(uint256 i) external view returns (Seen memory) {
        return _seen[i];
    }

    /// @notice Acts as a holder: any call (picks, returns, takes, transfers) from this contract.
    function act(address target, bytes calldata data) external returns (bytes memory ret) {
        bool ok;
        (ok, ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function onERC721Received(address operator, address from, uint256 id, bytes calldata) external returns (bytes4) {
        if (mode == Mode.RevertWithReason) revert("receiver refuses");
        if (mode == Mode.RevertEmpty) revert();
        Seen memory s;
        s.id = id;
        s.operator = operator;
        s.from = from;
        s.e = vault.escrowPrincipal();
        s.n = vault.inside();
        s.h = vault.hiddenCount();
        s.t = vault.pendingTickets();
        s.s = token.totalSupply();
        s.owner = collection.ownerOf(id);
        s.outside = vault.isOutside(id);
        s.revealed = collection.isRevealed(id);
        if (reenter) _reenter(s, id);
        _seen.push(s);
        if (mode == Mode.WrongSelector) return bytes4(0xdeadbeef);
        return this.onERC721Received.selector;
    }

    function _reenter(Seen memory s, uint256 id) internal {
        uint256 deadline = block.timestamp;
        if (pickId != 0) {
            try vault.withdraw(pickId, type(uint256).max, deadline) {}
            catch (bytes memory r) {
                s.pickErr = bytes4(r);
            }
        }
        try vault.returnItem(id, 0, deadline) {}
        catch (bytes memory r) {
            s.returnErr = bytes4(r);
        }
        if (takeItem != 0) {
            ItemReveal memory rv = tree.itemReveal(takeItem);
            try tickets.takeByNumber(takeItem, takeIndex, type(uint256).max, deadline, rv) {}
            catch (bytes memory r) {
                s.takeErr = bytes4(r);
            }
        }
        try collection.transferFrom(address(this), address(vault), id) {}
        catch (bytes memory r) {
            s.toVaultErr = bytes4(r);
        }
        if (!collection.isRevealed(id) && collection.isRevealable(id)) {
            ItemReveal memory rv = tree.itemReveal(id);
            try collection.reveal(id, rv.traitsPacked, rv.imageHash, rv.avatarHash, rv.modelHash, rv.salt, rv.proof) {
                s.revealOk = true;
            } catch {}
        }
        if (mode == Mode.MoveOn && collection.ownerOf(id) == address(this)) {
            collection.transferFrom(address(this), onward, id);
            s.movedOn = true;
        }
    }
}

/// @title AuditU7ClaudeBatcher
/// @notice TEST ONLY. Runs several vault calls in one transaction (P7.8: BoxIdSet's transient marks are cleared after
/// each call, so a second batch with overlapping ids in the same transaction behaves as in its own transaction).
contract AuditU7ClaudeBatcher {
    IBoxVault public immutable vault;

    constructor(IBoxVault v, IBoxCollection c, IBoxToken t) {
        vault = v;
        t.approve(address(v), type(uint256).max);
        c.setApprovalForAll(address(v), true);
    }

    /// @notice returnItems(ids), withdrawBatch(ids), returnItems(ids): one transaction.
    function cycle(uint256[] calldata ids) external returns (uint256 p1, uint256 p2, uint256 p3) {
        (p1,) = vault.returnItems(ids, 0, block.timestamp);
        (p2,) = vault.withdrawBatch(ids, type(uint256).max, block.timestamp);
        (p3,) = vault.returnItems(ids, 0, block.timestamp);
    }

    /// @notice A refused batch with a repeated id (caught), then the batch without the repeat, in one transaction.
    function refusedThenGood(uint256[] calldata bad, uint256[] calldata good) external returns (bytes4 err, uint256 p) {
        try vault.returnItems(bad, 0, block.timestamp) {}
        catch (bytes memory r) {
            err = bytes4(r);
        }
        (p,) = vault.returnItems(good, 0, block.timestamp);
    }

    /// @notice One call.
    function returnBatch(uint256[] calldata ids) external returns (uint256 p) {
        (p,) = vault.returnItems(ids, 0, block.timestamp);
    }

    function pickBatch(uint256[] calldata ids) external returns (uint256 p) {
        (p,) = vault.withdrawBatch(ids, type(uint256).max, block.timestamp);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

/// @notice SH-AUDIT-B0-U7 (Claude), L3: the vault's deliveries and the collection's safe transfers call
/// `onERC721Received` after the state is final, and a receiver that calls back cannot obtain an item twice or move E
/// (BoxVault.sol:42-43 "checks, effects, interactions under a transient lock", :469-496, :202-221; BoxCollection.sol
/// :682-684, :722-732; P7.7); two batches with overlapping ids in one transaction behave as in two, duplicate ids in one
/// batch are refused (BoxIdSet.sol:5-35, BoxVault.sol:514, :661; P7.8). Box 0 in terminal mode, TAKE_DELAY passed.
/// forge-config: default.evm_version = "osaka"
contract AuditU7ClaudeReentrancyTest is AuditU7ClaudeBase {
    AuditU7ClaudeReceiver internal rx;
    AuditU7ClaudeBatcher internal batcher;
    address internal onward;
    uint256[] internal shelf;

    function setUp() public virtual override {
        super.setUp();
        _toTerminal();
        _warpTo(uint256(tickets.status().terminalAt) + tickets.TAKE_DELAY());
        _buildTree();
        onward = makeAddr("u7.onward");
        rx = new AuditU7ClaudeReceiver(vault, collection, token, tickets, tree, onward);
        batcher = new AuditU7ClaudeBatcher(vault, collection, token);
        _ghostAddOutside(address(rx));
        _ghostAddOutside(address(batcher));
        _ghostAddOutside(onward);
        // T for the receiver and the batcher (between outside holders: nothing crosses the boundary).
        _transferT(eoa[0], address(rx), 20 * vault.quoteWithdraw(1));
        _transferT(eoa[0], address(batcher), 20 * vault.quoteWithdraw(1));
        for (uint256 i; i < 4; ++i) {
            uint256 item = _takeItem(eoa[2], 3_000 + i * 131, true);
            _returnItem(eoa[2], item);
            shelf.push(item);
        }
    }

    /// @notice P7.7: a named pick of two items into the receiver: in each hook E, n, h, t and S are already the
    /// post-pick values, the item is the receiver's and outside; a re-entrant pick, return or take reverts
    /// Reentrancy() (the vault's lock), a send to the vault reverts DirectSendRefused; E moved once by exactly the
    /// quoted principal and each item arrived once.
    function testProperty_AUDIT_U7_pickReceiverSeesFinalStateAndCannotReenter() public {
        (uint256 hiddenItem, uint256 hiddenIndex) = _hiddenPoolItem(9_999);
        rx.configure(AuditU7ClaudeReceiver.Mode.Accept, true, shelf[2], hiddenItem, hiddenIndex);
        VaultState memory b = _vaultState();
        uint256 p = (b.a * 2 + b.n - 1) / b.n;
        uint256 t0 = token.balanceOf(address(rx));
        rx.act(
            a.vault,
            abi.encodeCall(IBoxVault.withdrawBatch, (_ids2(shelf[0], shelf[1]), type(uint256).max, block.timestamp))
        );
        _noteTChange(t0, token.balanceOf(address(rx)), TIn.Pick, TOut.Other);
        VaultState memory c = _vaultState();
        assertEq(c.e, b.e + p, "E moved once, by the quoted principal");
        assertEq(rx.seenCount(), 2, "two receipts, one per item");
        for (uint256 i; i < 2; ++i) {
            AuditU7ClaudeReceiver.Seen memory s = rx.seen(i);
            assertEq(s.id, shelf[i], "in list order");
            assertEq(s.operator, a.vault, "operator: the vault");
            assertEq(s.from, a.vault, "from: the vault");
            assertEq(s.e, c.e, "E final in the hook");
            assertEq(s.n, c.n, "n final in the hook");
            assertEq(s.h, c.h, "h final in the hook");
            assertEq(s.t, c.t, "t final in the hook");
            assertEq(s.s, c.s, "S final in the hook (the fee burned before the deliveries)");
            assertEq(s.owner, address(rx), "the item is the receiver's in its hook");
            assertTrue(s.outside, "outside in the hook");
            assertEq(s.pickErr, TransientReentrancyGuard.Reentrancy.selector, "re-entrant pick refused");
            assertEq(s.returnErr, TransientReentrancyGuard.Reentrancy.selector, "re-entrant return refused");
            assertEq(s.takeErr, TransientReentrancyGuard.Reentrancy.selector, "re-entrant take refused");
            assertEq(s.toVaultErr, IBoxCollection.DirectSendRefused.selector, "a send to the vault refused");
        }
        assertEq(collection.ownerOf(shelf[0]), address(rx), "item 1 once");
        assertEq(collection.ownerOf(shelf[1]), address(rx), "item 2 once");
        assertTrue(vault.isOnShelf(shelf[2]), "the re-entrant pick took nothing");
        assertTrue(vault.isHidden(hiddenItem), "the re-entrant take took nothing");
        _assertVlt08("pick into a re-entrant receiver");
        _assertGhostLedger();
    }

    /// @notice P7.7: a take by number into the receiver (the tickets deliver, then reveal): in the hook the vault's
    /// accounting is final, the item the receiver's and not yet revealed; it reveals the item itself (permissionless,
    /// the committed data) and passes it on; the tickets' own reveal then sees it revealed and the call succeeds; the
    /// re-entrant pick, return and take revert Reentrancy().
    function testProperty_AUDIT_U7_takeReceiverRevealsAndMovesOn() public {
        (uint256 item, uint256 index) = _hiddenPoolItem(5_555);
        rx.configure(AuditU7ClaudeReceiver.Mode.MoveOn, true, shelf[0], 0, 0);
        ItemReveal memory r = tree.itemReveal(item);
        VaultState memory b = _vaultState();
        uint256 p = (b.a + b.n - 1) / b.n;
        uint256 t0 = token.balanceOf(address(rx));
        rx.act(
            a.tickets, abi.encodeCall(IBoxTickets.takeByNumber, (item, index, type(uint256).max, block.timestamp, r))
        );
        _noteTChange(t0, token.balanceOf(address(rx)), TIn.TakeByNumber, TOut.Other);
        VaultState memory c = _vaultState();
        assertEq(c.e, b.e + p, "E moved once");
        AuditU7ClaudeReceiver.Seen memory s = rx.seen(0);
        assertEq(s.e, c.e, "E final in the hook");
        assertEq(s.n, c.n, "n final in the hook");
        assertEq(s.t, c.t + 0, "t final in the hook");
        assertFalse(s.revealed, "not revealed yet in the hook (the tickets reveal after the delivery)");
        assertTrue(s.revealOk, "the receiver revealed it itself");
        assertTrue(s.movedOn, "and passed it on");
        assertEq(s.pickErr, TransientReentrancyGuard.Reentrancy.selector, "re-entrant pick refused");
        assertEq(s.returnErr, TransientReentrancyGuard.Reentrancy.selector, "re-entrant return refused");
        assertEq(collection.ownerOf(item), onward, "one owner: where the receiver sent it");
        assertTrue(collection.isRevealed(item), "revealed once");
        assertEq(rx.seenCount(), 1, "one receipt");
        _assertVlt08("take into a re-entrant receiver");
        _assertGhostLedger();
    }

    /// @notice P7.7 (and L6, EIP-721): a receiver that returns another selector or reverts empty makes the vault's
    /// delivery revert ERC721InvalidReceiver; one that reverts with a reason bubbles it; nothing moves (E, owners).
    function testProperty_AUDIT_U7_refusingReceiverRevertsTheDelivery() public {
        VaultState memory b = _vaultState();
        bytes memory call = abi.encodeCall(IBoxVault.withdraw, (shelf[0], type(uint256).max, block.timestamp));
        rx.configure(AuditU7ClaudeReceiver.Mode.WrongSelector, false, 0, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidReceiver.selector, address(rx)));
        rx.act(a.vault, call);
        rx.configure(AuditU7ClaudeReceiver.Mode.RevertEmpty, false, 0, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidReceiver.selector, address(rx)));
        rx.act(a.vault, call);
        rx.configure(AuditU7ClaudeReceiver.Mode.RevertWithReason, false, 0, 0, 0);
        vm.expectRevert(bytes("receiver refuses"));
        rx.act(a.vault, call);
        VaultState memory c = _vaultState();
        assertEq(keccak256(abi.encode(c)), keccak256(abi.encode(b)), "nothing moved");
        assertEq(collection.ownerOf(shelf[0]), a.vault, "still on the shelf");
    }

    /// @notice P7.7: outside any vault call a receiver may return the item it is being sent (the vault is not
    /// locked then): it is its owner; the transfer completes and the item ends in the vault, E falls by one return's
    /// principal. Nothing is obtained twice.
    function testProperty_AUDIT_U7_plainTransferReceiverMayReturnItsItem() public {
        uint256 item = shelf[3];
        _pick(eoa[1], item);
        rx.configure(AuditU7ClaudeReceiver.Mode.Accept, true, 0, 0, 0);
        VaultState memory b = _vaultState();
        uint256 pr = b.a / b.n;
        uint256 t0 = token.balanceOf(address(rx));
        vm.prank(eoa[1]);
        collection.safeTransferFrom(eoa[1], address(rx), item);
        _noteTChange(t0, token.balanceOf(address(rx)), TIn.Other, TOut.Return);
        AuditU7ClaudeReceiver.Seen memory s = rx.seen(0);
        assertEq(s.returnErr, bytes4(0), "the return inside the hook succeeded");
        assertEq(collection.ownerOf(item), a.vault, "returned");
        VaultState memory c = _vaultState();
        assertEq(c.e, b.e - pr, "E fell by one return");
        assertEq(rx.seenCount(), 1, "one receipt");
        _assertVlt08("a receiver that returns");
        _assertGhostLedger();
    }

    /// @notice P7.8: returnItems, withdrawBatch, returnItems of the same three ids in one transaction behave as the
    /// same three calls in three transactions (same principals, same end state): BoxIdSet's marks are cleared.
    function testProperty_AUDIT_U7_overlappingBatchesInOneTransaction() public {
        uint256[] memory ids = _ids3(shelf[0], shelf[1], shelf[2]);
        _pickBatch(eoa[2], ids);
        for (uint256 i; i < 3; ++i) {
            vm.prank(eoa[2]);
            collection.transferFrom(eoa[2], address(batcher), ids[i]);
        }
        uint256 snap = vm.snapshotState();
        (uint256 a1, uint256 a2, uint256 a3) = batcher.cycle(ids);
        bytes32 oneTx = keccak256(abi.encode(_vaultState(), token.balanceOf(address(batcher))));
        vm.revertToState(snap);
        uint256 b1 = batcher.returnBatch(ids);
        _advance(1);
        uint256 b2 = batcher.pickBatch(ids);
        _advance(1);
        uint256 b3 = batcher.returnBatch(ids);
        bytes32 threeTx = keccak256(abi.encode(_vaultState(), token.balanceOf(address(batcher))));
        assertEq(a1, b1, "first return");
        assertEq(a2, b2, "pick");
        assertEq(a3, b3, "second return");
        // Time differs (two blocks), but nothing in the vault reads it here: the states agree.
        assertEq(oneTx, threeTx, "one transaction == three");
        vm.revertToState(snap);
        batcher.cycle(ids);
        _assertVlt08("one transaction");
    }

    /// @notice P7.8: a repeated id is refused (returns: InvalidIdList; picks: IneligibleId) and a refused batch leaves
    /// no mark: the good batch right after it, in the same transaction, succeeds.
    function testProperty_AUDIT_U7_duplicatesRefusedWithoutStaleMarks() public {
        uint256[] memory ids = _ids2(shelf[0], shelf[1]);
        _pickBatch(eoa[2], ids);
        for (uint256 i; i < 2; ++i) {
            vm.prank(eoa[2]);
            collection.transferFrom(eoa[2], address(batcher), ids[i]);
        }
        uint256[] memory bad = _ids3(shelf[0], shelf[1], shelf[0]);
        (bytes4 err, uint256 p) = batcher.refusedThenGood(bad, ids);
        assertEq(err, IBoxVault.InvalidIdList.selector, "a repeated id refused");
        assertGt(p, 0, "the good batch after it succeeds in the same transaction");
        vm.prank(address(batcher));
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.IneligibleId.selector, shelf[0]));
        vault.withdrawBatch(_ids3(shelf[0], shelf[1], shelf[0]), type(uint256).max, block.timestamp);
        _assertVlt08Light("duplicates");
    }

    /// @notice P7.8 / L3: the BoxIdSet marks (transient slots keccak256(seed, id)) are zero after a successful batch.
    function testProperty_AUDIT_U7_idSetMarksClearedAfterABatch() public {
        uint256[] memory ids = _ids3(shelf[0], shelf[1], shelf[2]);
        _pickBatch(eoa[2], ids);
        vm.prank(eoa[2]);
        collection.setApprovalForAll(a.vault, true);
        vm.prank(eoa[2]);
        vault.returnItems(ids, 0, block.timestamp);
        bytes32 seed = 0xe7c3f898e47e26ee554b5d45e9f96be8fc03e8beeb6e6e8b911e95fc625016a6;
        for (uint256 i; i < 3; ++i) {
            bytes32 slot = keccak256(abi.encode(seed, ids[i]));
            assertEq(vm.load(a.vault, slot), bytes32(0), "no persistent mark");
        }
        // The seed is the vault's own constant (`uint256(keccak256("squarehole.box.vault.seen")) - 1`).
        assertEq(uint256(seed), uint256(keccak256("squarehole.box.vault.seen")) - 1, "the seed");
    }
}
