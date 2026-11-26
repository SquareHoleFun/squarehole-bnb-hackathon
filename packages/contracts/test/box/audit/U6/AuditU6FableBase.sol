// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {DrawStatus, ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {BoxShuffle} from "../../../../src/box/libraries/BoxShuffle.sol";
import {DrandWords} from "../../../../src/box/randomness/DrandWords.sol";
import {SepoliaBox0TestSet} from "../../../../script/lib/SepoliaBox0TestSet.sol";
import {AuditPhases} from "../common/AuditPhases.sol";
import {AuditRevealSet} from "../common/AuditRevealSet.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";

/// @title AuditU6FableBase
/// @notice TEST ONLY (SH-AUDIT-B0 U6, Fable 5.1 auditor). The shared base of the U6 audit suite on the factory's box 0
/// (`AuditPhases`, the mainnet build, the pinned BoxBackedSource and DrandSource, committed quicknet rounds):
/// - a storage cache of the edition's reveal tree (`AuditRevealSet.proof` rebuilds 2,048 leaves per call, about 20M
///   gas at N 1,969; the cache answers a proof with 11 SLOADs and is checked against the library in a test);
/// - fail-safe wrappers (`_tryX`) around every entry point of the tickets add-on, booking the ghost ledger exactly as
///   the world's helpers do but only when the call succeeded (an invariant handler needs them, `fail_on_revert`);
/// - the reference implementation of the queue-head rule (`_refHead`) and of the shuffle's inverse, written here from
///   the documents (BoxTickets.sol:42-44, IBoxTickets.sol:18-21) so the contract's `_head` is checked against an
///   independent reading, not against itself;
/// - helpers that request several draws in one block (they share one quicknet round), post committed rounds and run
///   the backup.
abstract contract AuditU6FableBase is AuditPhases {
    uint256 internal constant SILENCE = 7 days;
    uint256 internal constant SILENCE_UNREQUESTED = 30 days;
    uint256 internal constant REVEAL_GRACE = 30 days;
    uint256 internal constant TAKE_DELAY = 3 days;
    uint256 internal constant RETURN_GRACE = 30 days;
    uint256 internal constant EIP170 = 24_576;

    // ------------------------------------------------------------------------------------------------ reveal cache
    /// @dev The whole tree, heap-like: level 0 (leaves, 2^depth of them) first, then each level up; built once.
    bytes32[] internal _treeNodes;
    uint256 internal _treeDepth;
    bool internal _treeBuilt;

    /// @notice Builds the reveal-tree cache for this world's edition (call once in setUp; metering paused).
    function _buildRevealCache() internal {
        if (_treeBuilt) return;
        vm.pauseGasMetering();
        uint256 n = editionSize;
        uint256 depth = AuditRevealSet.depth(n);
        uint256 width = uint256(1) << depth;
        bytes32[] memory nodes = new bytes32[](2 * width - 1);
        for (uint256 id = 1; id <= n; ++id) {
            nodes[id - 1] = AuditRevealSet.leafOf(id);
        }
        uint256 base;
        for (uint256 w = width; w > 1; w >>= 1) {
            uint256 next = base + w;
            for (uint256 i; i < w >> 1; ++i) {
                nodes[next + i] = keccak256(abi.encodePacked(nodes[base + 2 * i], nodes[base + 2 * i + 1]));
            }
            base = next;
        }
        for (uint256 i; i < nodes.length; ++i) {
            _treeNodes.push(nodes[i]);
        }
        _treeDepth = depth;
        _treeBuilt = true;
        vm.resumeGasMetering();
    }

    /// @notice The index-directed proof of item `id` from the cache (equal to `AuditRevealSet.proof`).
    function _cachedProof(uint256 id) internal view returns (bytes32[] memory p) {
        require(_treeBuilt, "AuditU6FableBase: reveal cache not built");
        p = new bytes32[](_treeDepth);
        uint256 index = id - 1;
        uint256 base;
        uint256 level;
        for (uint256 w = uint256(1) << _treeDepth; w > 1; w >>= 1) {
            p[level++] = _treeNodes[base + (index ^ 1)];
            base += w;
            index >>= 1;
        }
    }

    /// @notice Item `id`'s reveal with the cached proof (the world's `_reveal` rebuilds the tree each call).
    function _rv(uint256 id) internal view returns (ItemReveal memory r) {
        SepoliaBox0TestSet.Entry memory e = AuditRevealSet.entry(id);
        r.traitsPacked = e.traitsPacked;
        r.imageHash = e.imageHash;
        r.avatarHash = e.avatarHash;
        r.modelHash = e.modelHash;
        r.salt = e.salt;
        r.proof = _cachedProof(id);
    }

    function _noReveal() internal pure returns (ItemReveal memory r) {}

    // ------------------------------------------------------------------------------------------------ reads

    function _st() internal view returns (IBoxTickets.TicketState memory) {
        return tickets.status();
    }

    function _dv(uint256 id) internal view returns (IBoxTickets.DrawView memory) {
        return tickets.drawTicket(id);
    }

    function _ticketsImpl() internal view returns (address) {
        return kit.impls().tickets;
    }

    /// @notice The round fixed for (box 0's tickets, `key`) on the backed source.
    function _roundOf(uint256 key) internal view returns (uint256 round) {
        (, uint64 r) = src.requestOf(a.tickets, key);
        round = r;
    }

    function _requestedAtOf(uint256 key) internal view returns (uint256 at) {
        (uint64 t,) = src.requestOf(a.tickets, key);
        at = t;
    }

    /// @notice π_w⁻¹(item − firstId): the shuffle position of `item` under the stored word (q ≠ 0).
    function _positionOfItem(uint256 item) internal view returns (uint256) {
        (uint256 u, uint256 v) = BoxShuffle.halves(editionSize);
        return BoxShuffle.invert(tickets.graduationWord(), item - tickets.firstId(), editionSize, u, v);
    }

    /// @notice The item at shuffle position `position` under the stored word (identity when q = 0).
    function _itemAtPosition(uint256 position) internal view returns (uint256) {
        if (_st().slots == 0) return tickets.firstId() + position;
        (uint256 u, uint256 v) = BoxShuffle.halves(editionSize);
        return tickets.firstId() + BoxShuffle.permute(tickets.graduationWord(), position, editionSize, u, v);
    }

    /// @notice R, the undrawn pool positions.
    function _left() internal view returns (uint256) {
        IBoxTickets.TicketState memory s = _st();
        return editionSize - s.slots - s.drawsSettled;
    }

    /// @notice The draw-pool index holding `position`, or type(uint256).max when it is not in the pool.
    function _poolIndexOfPosition(uint256 position) internal view returns (uint256) {
        uint256 left = _left();
        for (uint256 i; i < left; ++i) {
            if (tickets.poolPositionAt(i) == position) return i;
        }
        return type(uint256).max;
    }

    /// @notice The pot a draw must top its round up to in this block (F75 W3). Read afresh on every call (the lint
    /// sees callers change the fee between two calls: each call reads the fee of its own moment).
    function _target() internal view returns (uint256) {
        // forge-lint: disable-next-line(environment-read-across-mutation)
        return DrandWords.BOUNTY_GAS * block.basefee;
    }

    // ------------------------------------------------------------------------------------------------ reference rules

    /// @notice The queue-head rule as the documents state it (BoxTickets.sol:42-44; IBoxTickets.sol:18-21), computed
    /// without `_head`: the head is the graduation word while placeholders wait for it (deadline: its request + 7 days,
    /// or graduation + 30 days when nobody requested it), else the oldest unsettled draw (its request + 7 days); it is
    /// dead when the deadline has passed (strictly) and the source has no word that counts (non-zero, ready no earlier
    /// than the request, no later than now and no later than the deadline).
    function _refHead() internal view returns (bool exists, bool dead, uint256 key, uint256 deadline) {
        IBoxTickets.TicketState memory s = _st();
        uint256 gateAt = vault.gateOpenedAt();
        if (gateAt == 0) return (false, false, 0, 0);
        uint256 requestedAt;
        bool requested = true;
        if (s.slots != 0 && s.wordAcceptedAt == 0) {
            key = 0;
            requested = s.wordRequestedAt != 0;
            requestedAt = s.wordRequestedAt;
            deadline = requested ? requestedAt + SILENCE : gateAt + SILENCE_UNREQUESTED;
        } else {
            if (s.drawsSettled == s.drawsRequested) return (false, false, 0, 0);
            key = uint256(s.drawsSettled) + 1;
            requestedAt = _dv(key).requestedAt;
            deadline = requestedAt + SILENCE;
        }
        exists = true;
        uint256 now_ = vm.getBlockTimestamp();
        if (now_ <= deadline) return (true, false, key, deadline);
        if (!requested) return (true, true, key, deadline);
        (bytes32 word, uint64 readyAt) = src.wordOf(a.tickets, key);
        bool usable = word != bytes32(0) && readyAt >= requestedAt && readyAt <= now_ && readyAt <= deadline;
        dead = !usable;
    }

    /// @notice Whether the word of (tickets, `key`) counts for a request made at `requestedAt`, read from the source.
    function _refUsable(uint256 key, uint256 requestedAt) internal view returns (bool) {
        (bytes32 word, uint64 readyAt) = src.wordOf(a.tickets, key);
        return word != bytes32(0) && readyAt >= requestedAt && readyAt <= vm.getBlockTimestamp()
            && readyAt <= requestedAt + SILENCE;
    }

    // ------------------------------------------------------------------------------------------------ fail-safe calls

    function _tryTake(address who, uint256 count) internal returns (bool ok, uint256 firstToken, bytes memory err) {
        _approveT(who, a.tickets);
        uint256 t0 = token.balanceOf(who);
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(who);
        try tickets.take(count, type(uint256).max, deadline) returns (uint256 first) {
            ok = true;
            firstToken = first;
            _noteTChange(t0, token.balanceOf(who), TIn.Take, TOut.Other);
        } catch (bytes memory reason) {
            err = reason;
        }
    }

    function _tryHandBack(address who, uint256[] memory ids)
        internal
        returns (bool ok, uint256 principal, uint256 fee, bytes memory err)
    {
        uint256 t0 = token.balanceOf(who);
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(who);
        try tickets.handBack(ids, 0, deadline) returns (uint256 p, uint256 f) {
            ok = true;
            (principal, fee) = (p, f);
            _noteTChange(t0, token.balanceOf(who), TIn.Other, TOut.HandBack);
        } catch (bytes memory reason) {
            err = reason;
        }
    }

    /// @dev `value` from `who` (funded here); the refund booked from the drawer's balance, as the world does. The call
    /// gets at most DRAW_GAS: a drawer whose `receive` burns everything (the gas burner) must not spin for the test's
    /// whole budget; a real draw needs about 350,000.
    uint256 internal constant DRAW_GAS = 3_000_000;

    function _tryDraw(address who, uint256 value) internal returns (bool ok, uint256 ticketId, bytes memory err) {
        _approveT(who, a.tickets);
        _fund(who, value);
        uint256 e0 = who.balance;
        uint256 t0 = token.balanceOf(who);
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(who);
        try tickets.draw{value: value, gas: DRAW_GAS}(type(uint256).max, deadline) returns (uint256 id) {
            ok = true;
            ticketId = id;
            _noteEthIn(EthIn.DrawValue, value);
            uint256 e1 = who.balance;
            if (e1 + value > e0) _noteEthOut(EthOut.Refund, e1 + value - e0);
            _noteTChange(t0, token.balanceOf(who), TIn.Draw, TOut.Other);
        } catch (bytes memory reason) {
            err = reason;
        }
    }

    function _trySettle(address who, uint256 maxCount) internal returns (bool ok, uint256 settled, bytes memory err) {
        vm.prank(who);
        try tickets.settle(maxCount) returns (uint256 n) {
            ok = true;
            settled = n;
        } catch (bytes memory reason) {
            err = reason;
        }
    }

    function _tryOpen(address who, uint256 tokenId, bool withReveal)
        internal
        returns (bool ok, uint256 item, bytes memory err)
    {
        ItemReveal memory r;
        if (withReveal && _st().wordAcceptedAt != 0) {
            (bool known, bytes memory ret) = a.tickets.staticcall(abi.encodeCall(IBoxTickets.numberOf, (tokenId)));
            if (known && ret.length == 32) r = _rv(abi.decode(ret, (uint256)));
        }
        vm.prank(who);
        try tickets.open(tokenId, r) returns (uint256 id) {
            ok = true;
            item = id;
        } catch (bytes memory reason) {
            err = reason;
        }
    }

    function _tryOpenDraw(address who, uint256 ticketId, address to, bool withReveal)
        internal
        returns (bool ok, uint256 item, bytes memory err)
    {
        ItemReveal memory r;
        if (withReveal) {
            IBoxTickets.DrawView memory d = _dv(ticketId);
            if (d.status == DrawStatus.Settled) r = _rv(d.itemId);
        }
        vm.prank(who);
        try tickets.openDraw(ticketId, to, r) returns (uint256 id) {
            ok = true;
            item = id;
        } catch (bytes memory reason) {
            err = reason;
        }
    }

    function _tryCancel(address who, uint256 ticketId) internal returns (bool ok, uint256 principal, bytes memory err) {
        address drawer = _dv(ticketId).drawer;
        uint256 t0 = drawer == address(0) ? 0 : token.balanceOf(drawer);
        vm.prank(who);
        try tickets.cancelDraw(ticketId) returns (uint256 p) {
            ok = true;
            principal = p;
            _noteTChange(t0, token.balanceOf(drawer), TIn.Other, TOut.Cancel);
        } catch (bytes memory reason) {
            err = reason;
        }
    }

    function _tryTakeByNumber(address who, uint256 itemId, uint256 poolIndex, bool withReveal)
        internal
        returns (bool ok, uint256 principal, uint256 fee, bytes memory err)
    {
        _approveT(who, a.tickets);
        bytes memory data = abi.encodeCall(
            IBoxTickets.takeByNumber,
            (itemId, poolIndex, type(uint256).max, vm.getBlockTimestamp(), withReveal ? _rv(itemId) : _noReveal())
        );
        uint256 t0 = token.balanceOf(who);
        vm.prank(who);
        (ok, err) = a.tickets.call(data);
        if (ok) {
            (principal, fee) = abi.decode(err, (uint256, uint256));
            err = "";
            _noteTChange(t0, token.balanceOf(who), TIn.TakeByNumber, TOut.Other);
        }
    }

    function _tryEnterTerminal(address who) internal returns (bool ok, bytes memory err) {
        vm.prank(who);
        try tickets.enterTerminal() {
            ok = true;
        } catch (bytes memory reason) {
            err = reason;
        }
    }

    function _tryRequestWord(address who, uint256 value) internal returns (bool ok, bytes memory err) {
        _fund(who, value);
        uint256 e0 = who.balance;
        vm.prank(who);
        try tickets.requestGraduationWord{value: value}() {
            ok = true;
            _noteEthChange(e0, who.balance, EthIn.WordValue, EthOut.Other);
        } catch (bytes memory reason) {
            err = reason;
        }
    }

    function _tryAcceptWord(address who) internal returns (bool ok, bytes memory err) {
        vm.prank(who);
        try tickets.acceptGraduationWord() {
            ok = true;
        } catch (bytes memory reason) {
            err = reason;
        }
    }

    function _tryPost(uint256 round) internal returns (bool ok) {
        if (!_committed(round)) return false;
        (, uint64 postedAt) = drand.beaconOf(round);
        if (postedAt != 0 || vm.getBlockTimestamp() < src.roundTime(round)) return false;
        bytes memory sig = _boxDrand(round).xy;
        vm.prank(poster);
        try drand.postRound(round, sig) {
            ok = true;
        } catch {}
    }

    function _tryStartBackup(uint256 round, address who) internal returns (bool ok, uint256 target, bytes memory err) {
        if (vm.getBlockNumber() == 0) return (false, 0, "");
        bytes memory p = _parentHeader();
        uint256 parent = vm.getBlockNumber() - 1;
        vm.prank(who);
        try src.startBackup(round, parent, p) returns (uint256 t) {
            ok = true;
            target = t;
        } catch (bytes memory reason) {
            err = reason;
        }
    }

    function _tryFixBackup(uint256 round, bytes32 mix, address who) internal returns (bool ok, bytes memory err) {
        (uint64 startedAt, uint64 target, uint64 fixedAt,) = src.backupOf(round);
        if (startedAt == 0 || fixedAt != 0 || vm.getBlockNumber() <= target) return (false, "");
        bytes memory h = _mineHeader(target, mix);
        vm.prank(who);
        try src.fixBackup(round, h) {
            ok = true;
        } catch (bytes memory reason) {
            err = reason;
        }
    }

    /// @dev Bounded gas (a recipient that burns everything must not spin for the test's whole budget).
    function _tryWithdrawBounty(address who, address payable to) internal returns (bool ok, uint256 amount) {
        uint256 e0 = to.balance;
        vm.prank(who);
        try drand.withdrawBounty{gas: 1_000_000}(to) returns (uint256 x) {
            ok = true;
            amount = x;
            if (!_ghostIsSystem[to]) _noteEthChange(e0, to.balance, EthIn.Other, EthOut.BountyWithdraw);
        } catch {}
    }

    // ------------------------------------------------------------------------------------------------ scenario helpers

    /// @notice The backup for `round` from wherever the clock is: forward to the first second it may start (5 days + 1 s
    /// past the round's time) if not there yet, start as `starter`, 257 blocks on, fix with `mix` as `poster`.
    function _silentBackup(uint256 round, bytes32 mix, address starter) internal returns (uint256 target) {
        uint256 from = src.roundTime(round) + src.BACKUP_AFTER() + 1;
        if (vm.getBlockTimestamp() < from) _warpTo(from);
        target = _backup(round, mix, starter);
    }

    /// @notice Graduated, one block on, r0 posted and the word accepted: the clock at r0's time, so a draw now fixes
    /// round r0 + 4, the next block's r0 + 8, then r0 + 12 (all committed), then r0 + 16 and later (silent). Unlike
    /// `_toDrawing` it makes no draw of its own; never call `_toDrawing` after it (r0 is posted already).
    function _toWordAccepted() internal {
        _toGraduated();
        _advance(1);
        _post(r0);
        vm.prank(keeper);
        tickets.acceptGraduationWord();
    }

    /// @notice T for `who` from the richest EOA (eoa[2], the closing buyer, after the close): an outside-to-outside
    /// move, nothing crosses the boundary; `who` is registered as an outside holder if it was not.
    function _giveT(address who, uint256 amount) internal {
        _ghostAddOutside(who);
        address richest = eoa[2];
        for (uint256 i; i < 8; ++i) {
            if (eoa[i] != who && token.balanceOf(eoa[i]) > token.balanceOf(richest)) richest = eoa[i];
        }
        require(richest != who, "AuditU6FableBase: no other holder");
        _transferT(richest, who, amount);
    }

    /// @notice Enough T for `draws` draws at the current quote (with a margin for rising quotes).
    function _fundDraws(address who, uint256 draws) internal {
        (uint256 p, uint256 f) = vault.quoteTake(1);
        uint256 need = (p + f) * draws * 11 / 10;
        if (token.balanceOf(who) < need) _giveT(who, need - token.balanceOf(who));
    }

    /// @notice One draw by `who` with `value`, approval and funding done before the call so an `expectEmit` set by the
    /// caller right before this helper sees the draw's own events first; booked like the world's `_draw`.
    function _drawAfterExpect(address who, uint256 value) internal returns (uint256 ticketId) {
        uint256 e0 = who.balance;
        uint256 t0 = token.balanceOf(who);
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(who);
        ticketId = tickets.draw{value: value}(type(uint256).max, deadline);
        _noteEthIn(EthIn.DrawValue, value);
        uint256 e1 = who.balance;
        if (e1 + value > e0) _noteEthOut(EthOut.Refund, e1 + value - e0);
        _noteTChange(t0, token.balanceOf(who), TIn.Draw, TOut.Other);
    }

    /// @notice Approval and ETH funding for a draw (the part of `_draw` that emits before the draw).
    function _prepareDraw(address who, uint256 value) internal {
        _approveT(who, a.tickets);
        _fund(who, value);
    }

    /// @notice `count` draws by `who` in this block (one quicknet round for all of them); returns the first ticket id.
    function _drawMany(address who, uint256 count, uint256 value) internal returns (uint256 firstId_) {
        for (uint256 i; i < count; ++i) {
            uint256 id = _draw(who, value);
            if (i == 0) firstId_ = id;
        }
    }

    /// @notice The first 4-byte selector of revert data (0 when shorter).
    function _sel(bytes memory err) internal pure returns (bytes4 s) {
        if (err.length >= 4) {
            assembly ("memory-safe") {
                s := mload(add(err, 32))
            }
        }
    }

    /// @notice Draw `id`'s item under the live state, or 0 when it is not settled.
    function _itemOfDraw(uint256 id) internal view returns (uint256) {
        IBoxTickets.DrawView memory d = _dv(id);
        return d.status == DrawStatus.Settled || d.status == DrawStatus.Opened ? d.itemId : 0;
    }

    /// @notice Live placeholder ids (owner set) among 1 … minted.
    function _livePlaceholders() internal view returns (uint256[] memory ids, uint256 live) {
        uint256 total = _st().minted;
        ids = new uint256[](total);
        for (uint256 id = 1; id <= total; ++id) {
            (bool ok, bytes memory ret) = a.tickets.staticcall(abi.encodeCall(IBoxTickets.ownerOf, (id)));
            if (ok && ret.length == 32 && abi.decode(ret, (address)) != address(0)) ids[live++] = id;
        }
    }

    function _ownerOrZero(uint256 tokenId) internal view returns (address) {
        (bool ok, bytes memory ret) = a.tickets.staticcall(abi.encodeCall(IBoxTickets.ownerOf, (tokenId)));
        return ok && ret.length == 32 ? abi.decode(ret, (address)) : address(0);
    }

    function _one(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function _evm() internal view returns (string memory) {
        return vm.getEvmVersion();
    }

    function _isAmsterdam() internal view returns (bool) {
        return keccak256(bytes(_evm())) == keccak256("amsterdam");
    }
}
