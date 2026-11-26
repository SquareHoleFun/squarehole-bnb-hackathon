// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxItemStream} from "../../../../src/box/BoxItemStream.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {DrawStatus, ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCollection} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxItemStream} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxToken} from "../../../../src/box/interfaces/IBoxToken.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {BoxShuffle} from "../../../../src/box/libraries/BoxShuffle.sol";
import {TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU7ClaudeMath, AuditU7ClaudeTree} from "./AuditU7ClaudeBase.sol";
import {AuditU7ClaudeReceiver} from "./AuditU7ClaudeReentrancy.t.sol";

/// @notice The invariant contract's ghost-ledger hook (the world's ledger lives in the test contract).
interface AuditU7ClaudeBooks {
    function u7NoteT(uint256 before, uint256 after_, TIn inClass, TOut outClass) external;
}

/// @notice The box 0 contracts and parties the handler drives.
struct AuditU7ClaudeWiring {
    BoxVault vault;
    BoxCollection collection;
    BoxToken token;
    BoxTickets tickets;
    BoxItemStream stream;
    AuditU7ClaudeTree tree;
    address coordinator;
    address onward;
    uint256 drawB;
    uint256 drawC;
    address drawerB;
    address[] receivers;
}

/// @title AuditU7ClaudeHandler
/// @notice TEST ONLY (SH-AUDIT-B0-U7, Claude). Random life of box 0's vault and collection in terminal mode (TAKE_DELAY
/// passed), every contract real, the per-item stream as both observers: takes by number (with or without the reveal),
/// placeholder openings, draw B's opening and draw C's cancel, named picks and returns (single and batched, with
/// repeated ids on purpose), item transfers (owner, approved, operator; plain and safe, to EOAs, a delegated EOA, a
/// contract and re-entrant receivers), approvals and operator changes, sends to the vault, the collection and T (must
/// revert), T sent to the vault (must revert), reveals (committed, forged, repeated), holder burns, T transfers, stream
/// claims, strangers calling the coordinator-only and adapter-only entry points, and time jumps (so the 30-day safety
/// nets come due). Every call is fail-safe (`fail_on_revert`); the ghosts count what must never happen.
contract AuditU7ClaudeHandler is CommonBase, StdCheats, StdUtils {
    uint256 internal constant PICK_BPS = 2_500;
    uint256 internal constant RETURN_BPS = 500;
    uint256 internal constant DRAW_BPS = 100;

    AuditU7ClaudeBooks internal immutable books;
    BoxVault internal vault;
    BoxCollection internal collection;
    BoxToken internal token;
    BoxTickets internal tickets;
    BoxItemStream internal stream;
    AuditU7ClaudeTree internal tree;
    address internal coordinator;
    address internal onward;
    uint256 internal drawB;
    uint256 internal drawC;
    address internal drawerB;
    uint256 internal n_;

    address[] public holders;
    mapping(address => bool) public isHolder;
    mapping(address => bool) public isReceiver;
    /// Ids that ever left the vault (every other id never moved: implicitly the vault's).
    uint256[] public tracked;
    mapping(uint256 => bool) public isTracked;
    mapping(uint256 => bool) public sawRevealed;

    // ------------------------------------------------------------------ ghosts (must stay zero)
    uint256 public quoteMismatch;
    uint256 public feeMismatch;
    uint256 public burnMismatch;
    uint256 public escrowMismatch;
    uint256 public priceRose;
    uint256 public refusalBroken;
    uint256 public accessBroken;
    uint256 public duplicateAccepted;
    uint256 public doubleReveal;
    uint256 public forgedReveal;
    uint256 public revealDataWrong;
    uint256 public observerFailures;
    uint256 public checkpointRepairs;
    uint256 public approvalSurvived;
    uint256 public ownershipWrong;
    uint256 public hookStateNotFinal;
    uint256 public reentryNotBlocked;
    uint256 public unexpected;
    bytes public lastUnexpected;
    string public lastUnexpectedWhere;

    // ------------------------------------------------------------------ coverage
    uint256 public calls;
    uint256 public takes;
    uint256 public takesUnrevealed;
    uint256 public picks;
    uint256 public pickBatches;
    uint256 public returnsDone;
    uint256 public returnBatches;
    uint256 public unrevealedReturns;
    uint256 public transfersDone;
    uint256 public safeTransfers;
    uint256 public reentrantReceipts;
    uint256 public reentrantReturns;
    uint256 public vaultDeliveriesToReceivers;
    uint256 public revealsDone;
    uint256 public refusalsChecked;
    uint256 public duplicatesRefused;
    uint256 public opens;
    uint256 public cancels;
    uint256 public claims;
    uint256 public burns;
    uint256 public warps;

    constructor(AuditU7ClaudeBooks books_, AuditU7ClaudeWiring memory w, address[] memory holders_) {
        books = books_;
        (vault, collection, token, tickets, stream, tree) =
        (w.vault, w.collection, w.token, w.tickets, w.stream, w.tree);
        (coordinator, onward, drawB, drawC, drawerB) = (w.coordinator, w.onward, w.drawB, w.drawC, w.drawerB);
        n_ = vault.collectionSize();
        for (uint256 i; i < holders_.length; ++i) {
            _addHolder(holders_[i]);
        }
        _addHolder(onward);
        for (uint256 i; i < w.receivers.length; ++i) {
            _addHolder(w.receivers[i]);
            isReceiver[w.receivers[i]] = true;
        }
        uint256 first = collection.firstId();
        for (uint256 id = first; id < first + n_; ++id) {
            if (vault.isOutside(id) || vault.hasLeftVault(id)) _track(id);
        }
    }

    // ================================================================== views for the invariants

    function trackedCount() external view returns (uint256) {
        return tracked.length;
    }

    function trackedIds() external view returns (uint256[] memory) {
        return tracked;
    }

    function allHolders() external view returns (address[] memory) {
        return holders;
    }

    function holderCount() external view returns (uint256) {
        return holders.length;
    }

    // ================================================================== vault actions

    /// @notice A take by number of a hidden pool item, with its reveal or (`bare`) without one.
    function takeByNumber(uint256 actorSeed, uint256 itemSeed, bool bare) external {
        _begin();
        address who = _tHolder(actorSeed);
        (bool found, uint256 item, uint256 index) = _hiddenPoolItem(itemSeed);
        if (found && tracked.length < 48) _take(who, item, index, bare);
        _end();
    }

    struct Pre {
        uint256 s;
        uint256 e;
        uint256 n;
        uint256 a;
        uint256 p;
        uint256 fee;
        uint256 t0;
        uint256 seen0;
        uint256 k;
    }

    function _take(address who, uint256 item, uint256 index, bool bare) internal {
        Pre memory b = _pre();
        b.p = (b.a + b.n - 1) / b.n;
        b.fee = AuditU7ClaudeMath.feeOf(b.p, DRAW_BPS);
        if (token.balanceOf(who) < b.p + b.fee) return;
        vm.prank(who);
        token.approve(address(tickets), type(uint256).max);
        ItemReveal memory r;
        if (!bare) r = tree.itemReveal(item);
        b.t0 = token.balanceOf(who);
        b.seen0 = _seenOf(who);
        vm.prank(who);
        try tickets.takeByNumber(item, index, type(uint256).max, block.timestamp, r) returns (uint256 pp, uint256 ff) {
            if (pp != b.p) ++quoteMismatch;
            if (ff != b.fee) ++feeMismatch;
            _checkMove(b, int256(b.p), b.fee, -1);
            _checkVaultHooks(who, b.seen0);
            if (collection.ownerOf(item) != who && !_movedOnByReceiver(who, item)) ++ownershipWrong;
            _track(item);
            ++takes;
            if (bare) ++takesUnrevealed;
        } catch (bytes memory err) {
            _unexpected(err, "takeByNumber");
        }
        books.u7NoteT(b.t0, token.balanceOf(who), TIn.TakeByNumber, TOut.Other);
    }

    /// @notice A named pick of 1-3 revealed shelf items, or (`dup`) a list repeating one (must revert IneligibleId).
    function pick(uint256 actorSeed, uint256 k, uint256 seed, bool dup) external {
        _begin();
        address who = _tHolder(actorSeed);
        uint256[] memory pool = _filter(_isPickable);
        if (pool.length != 0) {
            k = bound(k, 1, pool.length < 3 ? pool.length : 3);
            uint256[] memory ids = _choose(pool, k, seed);
            if (dup) _pickDup(who, _withRepeat(ids));
            else _pick(who, ids);
        }
        _end();
    }

    /// @dev The payment is checked before the ids (BoxVault.sol:478-482 before :482), so the payer can pay for the list.
    function _pickDup(address who, uint256[] memory ids) internal {
        Pre memory b = _pre();
        if (ids.length >= b.n) return;
        uint256 p = (b.a * ids.length + b.n - 1) / b.n;
        if (token.balanceOf(who) < p + AuditU7ClaudeMath.feeOf(p, PICK_BPS)) return;
        vm.prank(who);
        try vault.withdrawBatch(ids, type(uint256).max, block.timestamp) {
            ++duplicateAccepted;
        } catch (bytes memory err) {
            if (bytes4(err) == IBoxVault.IneligibleId.selector) ++duplicatesRefused;
            else _unexpected(err, "pick dup");
        }
    }

    function _pick(address who, uint256[] memory ids) internal {
        Pre memory b = _pre();
        b.k = ids.length;
        if (b.k >= b.n) return;
        b.p = (b.a * b.k + b.n - 1) / b.n;
        b.fee = AuditU7ClaudeMath.feeOf(b.p, PICK_BPS);
        if (token.balanceOf(who) < b.p + b.fee) return;
        vm.prank(who);
        token.approve(address(vault), type(uint256).max);
        b.t0 = token.balanceOf(who);
        b.seen0 = _seenOf(who);
        vm.prank(who);
        try vault.withdrawBatch(ids, type(uint256).max, block.timestamp) returns (uint256 pp, uint256 ff) {
            if (pp != b.p) ++quoteMismatch;
            if (ff != b.fee) ++feeMismatch;
            _checkMove(b, int256(b.p), b.fee, -int256(b.k));
            _checkVaultHooks(who, b.seen0);
            for (uint256 i; i < b.k; ++i) {
                if (collection.ownerOf(ids[i]) != who && !_movedOnByReceiver(who, ids[i])) ++ownershipWrong;
            }
            ++picks;
            if (b.k > 1) ++pickBatches;
        } catch (bytes memory err) {
            _unexpected(err, "pick");
        }
        books.u7NoteT(b.t0, token.balanceOf(who), TIn.Pick, TOut.Other);
    }

    /// @notice A return of 1-3 items its owner holds (revealed, or past `returnableFrom`), or (`dup`) a list repeating
    /// one (must revert InvalidIdList).
    function returnSome(uint256 ownerSeed, uint256 k, uint256 seed, bool dup) external {
        _begin();
        address who = holders[ownerSeed % holders.length];
        uint256[] memory pool = _ownedReturnable(who);
        if (pool.length != 0) {
            k = bound(k, 1, pool.length < 3 ? pool.length : 3);
            uint256[] memory ids = _choose(pool, k, seed);
            vm.prank(who);
            collection.setApprovalForAll(address(vault), true);
            if (dup) _returnDup(who, _withRepeat(ids));
            else _return(who, ids);
        }
        _end();
    }

    function _returnDup(address who, uint256[] memory ids) internal {
        vm.prank(who);
        try vault.returnItems(ids, 0, block.timestamp) {
            ++duplicateAccepted;
        } catch (bytes memory err) {
            if (bytes4(err) == IBoxVault.InvalidIdList.selector) ++duplicatesRefused;
            else _unexpected(err, "return dup");
        }
    }

    function _return(address who, uint256[] memory ids) internal {
        Pre memory b = _pre();
        b.k = ids.length;
        b.p = b.a * b.k / b.n;
        b.fee = AuditU7ClaudeMath.feeOf(b.p, RETURN_BPS);
        uint256 unrevealed;
        for (uint256 i; i < b.k; ++i) {
            if (!collection.isRevealed(ids[i])) ++unrevealed;
        }
        b.t0 = token.balanceOf(who);
        vm.prank(who);
        try vault.returnItems(ids, 0, block.timestamp) returns (uint256 pp, uint256 ff) {
            if (pp != b.p) ++quoteMismatch;
            if (ff != b.fee) ++feeMismatch;
            if (token.balanceOf(who) != b.t0 + pp - ff) ++escrowMismatch;
            _checkMove(b, -int256(b.p), b.fee, int256(b.k));
            for (uint256 i; i < b.k; ++i) {
                if (collection.ownerOf(ids[i]) != address(vault)) ++ownershipWrong;
            }
            ++returnsDone;
            if (b.k > 1) ++returnBatches;
            unrevealedReturns += unrevealed;
        } catch (bytes memory err) {
            _unexpected(err, "return");
        }
        books.u7NoteT(b.t0, token.balanceOf(who), TIn.Other, TOut.Return);
    }

    /// @notice Opens one of the placeholders still live (its holder, with its reveal, or bare once the grace passed).
    function openPlaceholder(uint256 tokenSeed, bool bare) external {
        _begin();
        IBoxTickets.TicketState memory s = tickets.status();
        uint256 tokenId = 1 + (tokenSeed % uint256(s.minted));
        address holder;
        try tickets.ownerOf(tokenId) returns (address o) {
            holder = o;
        } catch {
            return _end();
        }
        uint256 item = tickets.numberOf(tokenId);
        ItemReveal memory r;
        bool graceOver = block.timestamp >= uint256(s.wordAcceptedAt) + tickets.REVEAL_GRACE();
        if (!bare || !graceOver) r = tree.itemReveal(item);
        Pre memory b = _pre();
        b.t0 = vault.pendingTickets();
        b.seen0 = _seenOf(holder);
        vm.prank(holder);
        try tickets.open(tokenId, r) returns (uint256 got) {
            if (got != item) ++ownershipWrong;
            _checkMove(b, 0, 0, 0);
            _checkVaultHooks(holder, b.seen0);
            if (vault.pendingTickets() + 1 != b.t0) ++escrowMismatch;
            if (collection.ownerOf(item) != holder && !_movedOnByReceiver(holder, item)) ++ownershipWrong;
            _track(item);
            ++opens;
        } catch (bytes memory err) {
            _unexpected(err, "open");
        }
        _end();
    }

    /// @notice Draw B's opening by its drawer (to itself or another holder), with its reveal.
    function openDrawB(uint256 toSeed) external {
        _begin();
        if (tickets.drawTicket(drawB).status != DrawStatus.Settled) return _end();
        uint256 item = tickets.drawTicket(drawB).itemId;
        address to = holders[toSeed % holders.length];
        ItemReveal memory r = tree.itemReveal(item);
        uint256 seen0 = _seenOf(to);
        vm.prank(drawerB);
        try tickets.openDraw(drawB, to, r) {
            _checkVaultHooks(to, seen0);
            if (collection.ownerOf(item) != to && !_movedOnByReceiver(to, item)) ++ownershipWrong;
            _track(item);
            ++opens;
        } catch (bytes memory err) {
            _unexpected(err, "openDraw");
        }
        _end();
    }

    /// @notice Draw C's terminal cancel by anyone: ⌊A/n⌋ to its drawer, no fee (the gate is open).
    function cancelDrawC(address caller) external {
        _begin();
        if (tickets.drawTicket(drawC).status != DrawStatus.Requested) return _end();
        address drawer = tickets.drawTicket(drawC).drawer;
        Pre memory b = _pre();
        b.p = b.a / b.n;
        b.t0 = token.balanceOf(drawer);
        if (caller == address(0)) caller = address(1);
        vm.prank(caller);
        try tickets.cancelDraw(drawC) returns (uint256 pp) {
            if (pp != b.p) ++quoteMismatch;
            if (token.balanceOf(drawer) != b.t0 + b.p) ++escrowMismatch;
            _checkMove(b, -int256(b.p), 0, 1);
            ++cancels;
        } catch (bytes memory err) {
            _unexpected(err, "cancelDraw");
        }
        books.u7NoteT(b.t0, token.balanceOf(drawer), TIn.Other, TOut.Cancel);
        _end();
    }

    // ================================================================== collection actions

    /// @notice Moves an item between holders: by its owner (plain or safe), by an approved address, or by an operator.
    function transferItem(uint256 idSeed, uint256 toSeed, uint8 how) external {
        _begin();
        (bool found, uint256 id, address from) = _ownedTracked(idSeed);
        if (!found) return _end();
        address to = holders[toSeed % holders.length];
        if (to == from) to = holders[((toSeed % holders.length) + 1) % holders.length];
        how = how % 4;
        address sender = from;
        if (how == 2) {
            sender = holders[((toSeed % holders.length) + 3) % holders.length];
            vm.prank(from);
            collection.approve(sender, id);
        } else if (how == 3) {
            sender = holders[((toSeed % holders.length) + 5) % holders.length];
            vm.prank(from);
            collection.setApprovalForAll(sender, true);
        }
        uint256 fromBal = collection.balanceOf(from);
        uint256 toT = token.balanceOf(to);
        Pre memory b = _pre();
        vm.prank(sender);
        if (how == 1) {
            try collection.safeTransferFrom(from, to, id) {
                ++safeTransfers;
                _afterMove(id, from, to, fromBal);
            } catch (bytes memory err) {
                _unexpected(err, "safeTransferFrom");
            }
        } else {
            try collection.transferFrom(from, to, id) {
                _afterMove(id, from, to, fromBal);
            } catch (bytes memory err) {
                _unexpected(err, "transferFrom");
            }
        }
        if (how == 3) {
            vm.prank(from);
            collection.setApprovalForAll(sender, false);
        }
        // A re-entrant receiver may have returned the item in its hook (the vault is not locked then): T to it.
        books.u7NoteT(toT, token.balanceOf(to), TIn.Other, TOut.Return);
        Pre memory c = _pre();
        if (!AuditU7ClaudeMath.productGe(b.a, c.n, c.a, b.n)) ++priceRose;
        _end();
    }

    /// @notice A stranger (no approval) tries to move someone's item: must revert ERC721InsufficientApproval.
    function strangerTransfer(uint256 idSeed, address stranger) external {
        _begin();
        (bool found, uint256 id, address from) = _ownedTracked(idSeed);
        if (!found || stranger == from || stranger == address(0)) return _end();
        if (collection.getApproved(id) == stranger || collection.isApprovedForAll(from, stranger)) return _end();
        ++refusalsChecked;
        vm.prank(stranger);
        try collection.transferFrom(from, stranger, id) {
            ++refusalBroken;
        } catch (bytes memory err) {
            // A system address as the stranger meets the send refusal first (BoxCollection.sol:687-688).
            bytes4 e = bytes4(err);
            if (
                e != IBoxCollection.ERC721InsufficientApproval.selector
                    && e != IBoxCollection.DirectSendRefused.selector
            ) {
                _unexpected(err, "stranger");
            }
        }
        _end();
    }

    /// @notice An owner approves someone for an item, or sets or clears an operator.
    function approveSome(uint256 idSeed, uint256 whoSeed, bool operator, bool on) external {
        _begin();
        (bool found, uint256 id, address from) = _ownedTracked(idSeed);
        if (!found) return _end();
        address who = holders[whoSeed % holders.length];
        vm.prank(from);
        if (operator) collection.setApprovalForAll(who, on);
        else collection.approve(who, id);
        _end();
    }

    /// @notice Sends an item (or T) to the vault, the collection or T, by every route: each must revert.
    function sendToSystem(uint256 idSeed, uint8 which, uint8 how, uint256 amount) external {
        _begin();
        address target = which % 3 == 0 ? address(vault) : which % 3 == 1 ? address(collection) : address(token);
        if (how % 4 == 3) {
            address who = holders[idSeed % holders.length];
            uint256 bal = token.balanceOf(who);
            amount = bound(amount, 0, bal);
            ++refusalsChecked;
            vm.prank(who);
            try token.transfer(address(vault), amount) {
                ++refusalBroken;
            } catch (bytes memory err) {
                if (bytes4(err) != IBoxToken.DirectSendRefused.selector) _unexpected(err, "T to the vault");
            }
            return _end();
        }
        (bool found, uint256 id, address from) = _ownedTracked(idSeed);
        if (!found) return _end();
        ++refusalsChecked;
        vm.prank(from);
        bool ok;
        bytes memory err;
        if (how % 4 == 0) {
            try collection.transferFrom(from, target, id) {
                ok = true;
            } catch (bytes memory e) {
                err = e;
            }
        } else if (how % 4 == 1) {
            try collection.safeTransferFrom(from, target, id) {
                ok = true;
            } catch (bytes memory e) {
                err = e;
            }
        } else {
            try collection.safeTransferFrom(from, target, id, hex"01") {
                ok = true;
            } catch (bytes memory e) {
                err = e;
            }
        }
        if (ok) ++refusalBroken;
        else if (bytes4(err) != IBoxCollection.DirectSendRefused.selector) _unexpected(err, "item to a system address");
        _end();
    }

    /// @notice Reveals an outside or shelf item that is still unrevealed: with the committed data (once), a forgery
    /// (must revert InvalidProof), or again (must revert AlreadyRevealed).
    function reveal(uint256 idSeed, uint8 kind, bytes32 noise) external {
        _begin();
        if (tracked.length == 0) return _end();
        uint256 id = tracked[idSeed % tracked.length];
        ItemReveal memory r = tree.itemReveal(id);
        kind = kind % 4;
        if (collection.isRevealed(id)) {
            try collection.reveal(id, r.traitsPacked, r.imageHash, r.avatarHash, r.modelHash, r.salt, r.proof) {
                ++doubleReveal;
            } catch (bytes memory err) {
                if (bytes4(err) != IBoxCollection.AlreadyRevealed.selector) _unexpected(err, "reveal again");
            }
            return _end();
        }
        if (kind != 0) {
            if (noise == bytes32(0)) noise = bytes32(uint256(7));
            if (kind == 1) r.imageHash ^= noise;
            else if (kind == 2) r.proof[uint256(noise) % r.proof.length] ^= noise;
            else r.salt ^= noise;
            try collection.reveal(id, r.traitsPacked, r.imageHash, r.avatarHash, r.modelHash, r.salt, r.proof) {
                ++forgedReveal;
            } catch (bytes memory err) {
                if (bytes4(err) != IBoxCollection.InvalidProof.selector) _unexpected(err, "forged reveal");
            }
            return _end();
        }
        try collection.reveal(id, r.traitsPacked, r.imageHash, r.avatarHash, r.modelHash, r.salt, r.proof) {
            ++revealsDone;
            (bool rv, uint128 traits, bytes32 image, bytes32 model) = collection.traitsOf(id);
            if (!rv || traits != r.traitsPacked || image != r.imageHash || model != r.modelHash) ++revealDataWrong;
        } catch (bytes memory err) {
            _unexpected(err, "reveal");
        }
        _end();
    }

    // ================================================================== T, the stream, time, strangers

    function burnT(uint256 whoSeed, uint256 amount) external {
        _begin();
        address who = _tHolder(whoSeed);
        uint256 bal = token.balanceOf(who);
        amount = bound(amount, 0, bal / 20);
        uint256 s0 = token.totalSupply();
        vm.prank(who);
        try token.burn(amount) {
            if (token.totalSupply() + amount != s0) ++burnMismatch;
            ++burns;
        } catch (bytes memory err) {
            _unexpected(err, "burn");
        }
        books.u7NoteT(bal, token.balanceOf(who), TIn.OwnBurn, TOut.Other);
        _end();
    }

    function transferT(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        _begin();
        address from = _tHolder(fromSeed);
        address to = holders[toSeed % holders.length];
        amount = bound(amount, 0, token.balanceOf(from) / 4);
        vm.prank(from);
        try token.transfer(to, amount) {}
        catch (bytes memory err) {
            _unexpected(err, "T transfer");
        }
        _end();
    }

    function claimStream(uint256 whoSeed) external {
        _begin();
        address who = holders[whoSeed % holders.length];
        uint256[] memory owned = _owned(who);
        uint256 t0 = token.balanceOf(who);
        vm.prank(who);
        try stream.claim(owned, who) {
            ++claims;
        } catch (bytes memory err) {
            _unexpected(err, "claim");
        }
        books.u7NoteT(t0, token.balanceOf(who), TIn.Other, TOut.StreamClaim);
        _end();
    }

    function warp(uint256 secs) external {
        _begin();
        secs = bound(secs, 12, 4 days);
        vm.roll(block.number + 1 + secs / 12);
        vm.warp(block.timestamp + secs);
        ++warps;
        _end();
    }

    /// @notice A caller that is neither the coordinator nor the tickets adapter calls their entry points: each must
    /// revert (NotCoordinator / NotAdapter).
    function strangerCalls(address caller, uint256 count, uint256 id) external {
        _begin();
        if (caller == coordinator || caller == address(tickets) || caller == address(0)) return _end();
        ++refusalsChecked;
        vm.prank(caller);
        try vault.openGate() {
            ++accessBroken;
        } catch {}
        vm.prank(caller);
        try vault.waiveHandBackFee() {
            ++accessBroken;
        } catch {}
        vm.prank(caller);
        try vault.openTickets(count, type(uint256).max) {
            ++accessBroken;
        } catch {}
        vm.prank(caller);
        try vault.releaseTickets(count, caller, 0) {
            ++accessBroken;
        } catch {}
        vm.prank(caller);
        try vault.deliverTicket(id, caller) {
            ++accessBroken;
        } catch {}
        vm.prank(caller);
        try collection.unlockReveal(id) {
            ++accessBroken;
        } catch {}
        _end();
    }

    // ================================================================== internals

    function _begin() internal {
        ++calls;
        vm.recordLogs();
    }

    /// @dev Counts observer failures and checkpoint repairs among the call's logs (the real stream: none expected).
    function _end() internal {
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 0) continue;
            bytes32 t0 = logs[i].topics[0];
            if (logs[i].emitter == address(vault) && t0 == IBoxVault.VaultObserverFailed.selector) ++observerFailures;
            if (logs[i].emitter == address(collection) && t0 == IBoxCollection.TransferObserverFailed.selector) {
                ++observerFailures;
            }
            if (logs[i].emitter == address(stream) && t0 == IBoxItemStream.CheckpointRepaired.selector) {
                ++checkpointRepairs;
            }
        }
    }

    function _unexpected(bytes memory err, string memory where) internal {
        ++unexpected;
        lastUnexpected = err;
        lastUnexpectedWhere = where;
    }

    function _pre() internal view returns (Pre memory b) {
        b.s = token.totalSupply();
        b.e = vault.escrowPrincipal();
        b.n = vault.inside();
        b.a = b.s - b.e;
    }

    /// @dev E moved by exactly `de`, S fell by exactly `burned`, n moved by `dn`, A/n did not rise.
    function _checkMove(Pre memory b, int256 de, uint256 burned, int256 dn) internal {
        Pre memory c = _pre();
        if (int256(c.e) - int256(b.e) != de) ++escrowMismatch;
        if (b.s - c.s != burned) ++burnMismatch;
        if (int256(c.n) - int256(b.n) != dn) ++escrowMismatch;
        if (!AuditU7ClaudeMath.productGe(b.a, c.n, c.a, b.n)) ++priceRose;
    }

    function _afterMove(uint256 id, address from, address to, uint256 fromBal) internal {
        ++transfersDone;
        address owner = collection.ownerOf(id);
        bool returnedInHook = isReceiver[to] && owner == address(vault) && !vault.isOutside(id);
        if (owner != to && !_movedOnByReceiver(to, id) && !returnedInHook) ++ownershipWrong;
        // A re-entrant receiver that moves the item on to `onward` may hand it back to its sender (onward == from).
        if (owner == from ? collection.balanceOf(from) != fromBal : collection.balanceOf(from) + 1 != fromBal) {
            ++ownershipWrong;
        }
        if (collection.getApproved(id) != address(0)) ++approvalSurvived;
        if (isReceiver[to]) ++reentrantReceipts;
        if (returnedInHook) ++reentrantReturns;
    }

    function _movedOnByReceiver(address to, uint256 id) internal view returns (bool) {
        return isReceiver[to] && collection.ownerOf(id) == onward;
    }

    /// @dev After a vault delivery (pick, take, opening) to a re-entrant receiver: in each hook the vault's E, n, t and
    /// T's supply were already the final values, and its pick, return and take attempts reverted Reentrancy().
    function _checkVaultHooks(address to, uint256 seenBefore) internal {
        if (!isReceiver[to]) return;
        AuditU7ClaudeReceiver rx = AuditU7ClaudeReceiver(to);
        uint256 seenAfter = rx.seenCount();
        for (uint256 i = seenBefore; i < seenAfter; ++i) {
            AuditU7ClaudeReceiver.Seen memory sn = rx.seen(i);
            if (
                sn.e != vault.escrowPrincipal() || sn.n != vault.inside() || sn.t != vault.pendingTickets()
                    || sn.s != token.totalSupply()
            ) ++hookStateNotFinal;
            if (sn.returnErr != _REENTRANCY) ++reentryNotBlocked;
            if (sn.toVaultErr != IBoxCollection.DirectSendRefused.selector) ++reentryNotBlocked;
            ++vaultDeliveriesToReceivers;
        }
    }

    bytes4 internal constant _REENTRANCY = 0xab143c06;

    function _seenOf(address to) internal view returns (uint256) {
        return isReceiver[to] ? AuditU7ClaudeReceiver(to).seenCount() : 0;
    }

    function _addHolder(address h) internal {
        if (h == address(0) || isHolder[h]) return;
        isHolder[h] = true;
        holders.push(h);
    }

    function _track(uint256 id) internal {
        if (isTracked[id]) return;
        isTracked[id] = true;
        tracked.push(id);
    }

    function _tHolder(uint256 seed) internal view returns (address) {
        return holders[seed % holders.length];
    }

    function _isPickable(uint256 id) internal view returns (bool) {
        return vault.isOnShelf(id) && collection.isRevealed(id);
    }

    function _filter(function(uint256) view returns (bool) keep) internal view returns (uint256[] memory out) {
        uint256 count;
        uint256[] memory tmp = new uint256[](tracked.length);
        for (uint256 i; i < tracked.length; ++i) {
            if (keep(tracked[i])) tmp[count++] = tracked[i];
        }
        out = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            out[i] = tmp[i];
        }
    }

    function _owned(address who) internal view returns (uint256[] memory out) {
        uint256 count;
        uint256[] memory tmp = new uint256[](tracked.length);
        for (uint256 i; i < tracked.length; ++i) {
            if (collection.ownerOf(tracked[i]) == who) tmp[count++] = tracked[i];
        }
        out = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            out[i] = tmp[i];
        }
    }

    function _ownedReturnable(address who) internal view returns (uint256[] memory out) {
        uint256[] memory owned = _owned(who);
        uint256 count;
        uint256[] memory tmp = new uint256[](owned.length);
        for (uint256 i; i < owned.length; ++i) {
            uint256 id = owned[i];
            if (!vault.isOutside(id)) continue;
            if (!collection.isRevealed(id)) {
                uint256 from = tickets.returnableFrom(id);
                if (from == 0 || block.timestamp < from) continue;
            }
            tmp[count++] = id;
        }
        out = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            out[i] = tmp[i];
        }
    }

    /// @dev A tracked id held outside the vault, and its owner.
    function _ownedTracked(uint256 seed) internal view returns (bool found, uint256 id, address owner) {
        uint256 len = tracked.length;
        if (len == 0) return (false, 0, address(0));
        for (uint256 i; i < len; ++i) {
            id = tracked[((seed % len) + i) % len];
            owner = collection.ownerOf(id);
            if (owner != address(vault) && isHolder[owner]) return (true, id, owner);
        }
        return (false, 0, address(0));
    }

    function _choose(uint256[] memory pool, uint256 k, uint256 seed) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](k);
        uint256 start = seed % pool.length;
        for (uint256 i; i < k; ++i) {
            ids[i] = pool[(start + i) % pool.length];
        }
    }

    function _withRepeat(uint256[] memory ids) internal pure returns (uint256[] memory out) {
        out = new uint256[](ids.length + 1);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = ids[i];
        }
        out[ids.length] = ids[0];
    }

    /// @dev A hidden pool item (BoxTickets' numbering under the stored word), walking at most 32 indices.
    function _hiddenPoolItem(uint256 seed) internal view returns (bool found, uint256 item, uint256 index) {
        IBoxTickets.TicketState memory s = tickets.status();
        uint256 left = n_ - s.slots - s.drawsSettled;
        if (left == 0) return (false, 0, 0);
        bytes32 w = tickets.graduationWord();
        (uint256 u, uint256 v) = BoxShuffle.halves(n_);
        index = seed % left;
        for (uint256 i; i < 32; ++i) {
            item = tickets.firstId() + BoxShuffle.permute(w, tickets.poolPositionAt(index), n_, u, v);
            if (vault.isHidden(item)) return (true, item, index);
            index = (index + 1) % left;
        }
        return (false, 0, 0);
    }
}

/// @notice The curve campaign's hooks into its invariant contract (graduation runs the world's booked drivers).
interface AuditU7ClaudeCurveHooks is AuditU7ClaudeBooks {
    function u7Graduate() external;
}

/// @title AuditU7ClaudeCurveHandler
/// @notice TEST ONLY (SH-AUDIT-B0-U7, Claude). Random life of box 0's vault on its bonding curve, the gate closed:
/// placeholder takes (⌈A·k/n⌉ plus the 1% draw fee) and hand-backs (⌊A·k/n⌋ less the 5% return fee), T sent to the vault
/// (must revert), holder burns and transfers, strangers on the restricted entry points, short time steps; and once,
/// graduation (the closing buy and `graduate()`, the world's drivers): the coordinator opens the gate, after which
/// takes revert TakesClosed and hand-backs HandBackClosed. Fail-safe; the ghosts count what must never happen.
contract AuditU7ClaudeCurveHandler is CommonBase, StdCheats, StdUtils {
    AuditU7ClaudeCurveHooks internal immutable hooks;
    BoxVault internal vault;
    BoxTickets internal tickets;
    BoxToken internal token;
    address internal coordinator;
    address[] public actors;
    uint256 internal latest;

    uint256 public quoteMismatch;
    uint256 public feeMismatch;
    uint256 public burnMismatch;
    uint256 public escrowMismatch;
    uint256 public priceRose;
    uint256 public refusalBroken;
    uint256 public accessBroken;
    uint256 public afterGraduationAccepted;
    uint256 public observerFailures;
    uint256 public unexpected;
    bytes public lastUnexpected;
    string public lastUnexpectedWhere;

    uint256 public takes;
    uint256 public handBacks;
    uint256 public graduations;
    uint256 public refusedAfterGraduation;
    /// Calls in this run; graduation waits for the 64th, so each run has a curve half and a graduated half.
    uint256 public curveCalls;

    struct Pre {
        uint256 s;
        uint256 e;
        uint256 n;
        uint256 h;
        uint256 t;
        uint256 a;
    }

    constructor(
        AuditU7ClaudeCurveHooks hooks_,
        BoxVault v,
        BoxTickets tk,
        BoxToken t,
        address coordinator_,
        address[] memory actors_,
        uint256 latest_
    ) {
        hooks = hooks_;
        (vault, tickets, token, coordinator, actors, latest) = (v, tk, t, coordinator_, actors_, latest_);
    }

    function take(uint256 actorSeed, uint256 k) external {
        ++curveCalls;
        vm.recordLogs();
        address who = actors[actorSeed % actors.length];
        k = bound(k, 1, 4);
        Pre memory b = _pre();
        bool open = vault.gateOpen();
        uint256 p = (b.a * k + b.n - 1) / b.n;
        uint256 fee = AuditU7ClaudeMath.feeOf(p, DRAW_BPS);
        if (token.balanceOf(who) < p + fee) return _end();
        vm.prank(who);
        token.approve(address(tickets), type(uint256).max);
        uint256 t0 = token.balanceOf(who);
        vm.prank(who);
        try tickets.take(k, type(uint256).max, block.timestamp) {
            if (open) ++afterGraduationAccepted;
            Pre memory c = _pre();
            if (c.e != b.e + p) ++quoteMismatch;
            if (b.s - c.s != fee) ++feeMismatch;
            if (t0 - token.balanceOf(who) != p + fee) ++burnMismatch;
            if (c.n + k != b.n || c.h + k != b.h || c.t != b.t + k) ++escrowMismatch;
            if (!AuditU7ClaudeMath.productGe(b.a, c.n, c.a, b.n)) ++priceRose;
            ++takes;
        } catch (bytes memory err) {
            if (open && bytes4(err) == IBoxTickets.TakesClosed.selector) ++refusedAfterGraduation;
            else _unexpected(err, "take");
        }
        hooks.u7NoteT(t0, token.balanceOf(who), TIn.Take, TOut.Other);
        _end();
    }

    function handBack(uint256 actorSeed, uint256 k, uint256 seed) external {
        ++curveCalls;
        vm.recordLogs();
        address who = actors[actorSeed % actors.length];
        uint256[] memory mine = _placeholdersOf(who);
        if (mine.length == 0) return _end();
        k = bound(k, 1, mine.length < 3 ? mine.length : 3);
        uint256[] memory ids = new uint256[](k);
        uint256 start = seed % mine.length;
        for (uint256 i; i < k; ++i) {
            ids[i] = mine[(start + i) % mine.length];
        }
        Pre memory b = _pre();
        bool open = vault.gateOpen();
        uint256 p = b.a * k / b.n;
        uint256 fee = AuditU7ClaudeMath.feeOf(p, RETURN_BPS);
        uint256 t0 = token.balanceOf(who);
        vm.prank(who);
        try tickets.handBack(ids, 0, block.timestamp) returns (uint256 pp, uint256 ff) {
            if (open) ++afterGraduationAccepted;
            Pre memory c = _pre();
            if (pp != p || c.e + p != b.e) ++quoteMismatch;
            if (ff != fee || b.s - c.s != fee) ++feeMismatch;
            if (token.balanceOf(who) != t0 + p - fee) ++burnMismatch;
            if (c.n != b.n + k || c.h != b.h + k || c.t + k != b.t) ++escrowMismatch;
            if (!AuditU7ClaudeMath.productGe(b.a, c.n, c.a, b.n)) ++priceRose;
            ++handBacks;
        } catch (bytes memory err) {
            if (open && bytes4(err) == IBoxTickets.HandBackClosed.selector) ++refusedAfterGraduation;
            else _unexpected(err, "handBack");
        }
        hooks.u7NoteT(t0, token.balanceOf(who), TIn.Other, TOut.HandBack);
        _end();
    }

    function sendTToVault(uint256 actorSeed, uint256 amount) external {
        ++curveCalls;
        vm.recordLogs();
        address who = actors[actorSeed % actors.length];
        amount = bound(amount, 0, token.balanceOf(who));
        vm.prank(who);
        try token.transfer(address(vault), amount) {
            ++refusalBroken;
        } catch (bytes memory err) {
            if (bytes4(err) != IBoxToken.DirectSendRefused.selector) _unexpected(err, "T to the vault");
        }
        _end();
    }

    function burnT(uint256 actorSeed, uint256 amount) external {
        ++curveCalls;
        vm.recordLogs();
        address who = actors[actorSeed % actors.length];
        uint256 bal = token.balanceOf(who);
        amount = bound(amount, 0, bal / 20);
        uint256 s0 = token.totalSupply();
        vm.prank(who);
        try token.burn(amount) {
            if (token.totalSupply() + amount != s0) ++burnMismatch;
        } catch (bytes memory err) {
            _unexpected(err, "burn");
        }
        hooks.u7NoteT(bal, token.balanceOf(who), TIn.OwnBurn, TOut.Other);
        _end();
    }

    function transferT(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        ++curveCalls;
        vm.recordLogs();
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        amount = bound(amount, 0, token.balanceOf(from) / 4);
        vm.prank(from);
        try token.transfer(to, amount) {}
        catch (bytes memory err) {
            _unexpected(err, "T transfer");
        }
        _end();
    }

    function strangerCalls(address caller, uint256 count, uint256 id) external {
        ++curveCalls;
        vm.recordLogs();
        if (caller == coordinator || caller == address(tickets) || caller == address(0)) return _end();
        vm.prank(caller);
        try vault.openGate() {
            ++accessBroken;
        } catch {}
        vm.prank(caller);
        try vault.waiveHandBackFee() {
            ++accessBroken;
        } catch {}
        vm.prank(caller);
        try vault.openTickets(count, type(uint256).max) {
            ++accessBroken;
        } catch {}
        vm.prank(caller);
        try vault.releaseTickets(count, caller, 0) {
            ++accessBroken;
        } catch {}
        vm.prank(caller);
        try vault.deliverTicket(id, caller) {
            ++accessBroken;
        } catch {}
        _end();
    }

    function step(uint256 blocks) external {
        ++curveCalls;
        vm.recordLogs();
        blocks = bound(blocks, 1, 5);
        if (block.timestamp + 12 * blocks < latest) {
            vm.roll(block.number + blocks);
            vm.warp(block.timestamp + 12 * blocks);
        }
        _end();
    }

    /// @notice Graduation, once (the closing buy and graduate(), by the world's booked drivers).
    function graduate() external {
        ++curveCalls;
        vm.recordLogs();
        if (graduations != 0 || curveCalls < 64) return _end();
        try hooks.u7Graduate() {
            ++graduations;
        } catch (bytes memory err) {
            _unexpected(err, "graduate");
        }
        _end();
    }

    uint256 internal constant DRAW_BPS = 100;
    uint256 internal constant RETURN_BPS = 500;

    function _pre() internal view returns (Pre memory b) {
        b.s = token.totalSupply();
        b.e = vault.escrowPrincipal();
        b.n = vault.inside();
        b.h = vault.hiddenCount();
        b.t = vault.pendingTickets();
        b.a = b.s - b.e;
    }

    function _placeholdersOf(address who) internal view returns (uint256[] memory out) {
        uint256 minted = tickets.status().minted;
        uint256[] memory tmp = new uint256[](minted);
        uint256 count;
        for (uint256 id = 1; id <= minted; ++id) {
            try tickets.ownerOf(id) returns (address o) {
                if (o == who) tmp[count++] = id;
            } catch {}
        }
        out = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            out[i] = tmp[i];
        }
    }

    function _unexpected(bytes memory err, string memory where) internal {
        ++unexpected;
        lastUnexpected = err;
        lastUnexpectedWhere = where;
    }

    function _end() internal {
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 0) continue;
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == IBoxVault.VaultObserverFailed.selector) {
                ++observerFailures;
            }
        }
    }
}
