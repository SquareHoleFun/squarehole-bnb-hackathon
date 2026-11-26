// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/console.sol";
import {DrawStatus, FeeBatch, ItemReveal, TicketPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU7FableBase} from "./AuditU7FableBase.sol";

/// @notice SH-AUDIT-B0 U7 (Fable). The invariant campaign the brief asks for (P7.1, P7.13; plan § 3.1 X03, X04, X14,
/// X15): the vault, the collection and the real per-item stream on the factory's box 0 (mainnet build, N 1,969),
/// starting in the drawing phase (two items outside, four placeholders live, draw B settled). The handler IS this
/// contract (`targetContract(address(this))` with the `h_` selectors), so every action goes through the world's
/// booked helpers and the ghost ledger is checked after every call. Every action is fail-safe: a precondition that
/// does not hold skips (counted), and what must never happen is asserted inside the action (the quotes against the
/// formula from the pre-action state, the stream's record after a move, the refused sends).
abstract contract AuditU7FableInvariantBase is AuditU7FableBase {
    address[] internal actors;
    uint256[] internal outsideIds;
    uint256[] internal shelfIds;
    uint256[] internal livePlaceholders;
    uint256[] internal openDraws;
    mapping(uint256 => address) internal ghostOwner;
    mapping(uint256 => bool) internal ghostRevealed;
    uint256 internal ghostRevealedCount;

    // ------------------------------------------------------------------ counters (logged at the end)
    uint256 public picks;
    uint256 public returns_;
    uint256 public transfers;
    uint256 public opens;
    uint256 public draws;
    uint256 public drawOpens;
    uint256 public claims;
    uint256 public trades;
    uint256 public collects;
    uint256 public burns;
    uint256 public refusalChecks;
    uint256 public skips;

    function _setUpCampaign() internal {
        _toDrawing();
        _buildTree();
        actors.push(eoa[0]);
        actors.push(eoa[1]);
        actors.push(eoa[2]);
        actors.push(eoa[3]);
        actors.push(eoa[4]);
        actors.push(eoa[5]);
        actors.push(address(contractDrawer));
        actors.push(eoa7702);
        _noteOutside(itemA, eoa[3]);
        _noteOutside(itemP1, eoa[0]);
        for (uint256 t = 2; t <= 5; ++t) {
            livePlaceholders.push(t);
        }
        openDraws.push(drawB);
        ghostRevealedCount = collection.revealedCount();
        targetContract(address(this));
    }

    function _selectors(bool vaultWeighted) internal pure returns (bytes4[] memory s) {
        if (vaultWeighted) {
            s = new bytes4[](14);
            s[0] = this.h_pick.selector;
            s[1] = this.h_pick.selector;
            s[2] = this.h_return.selector;
            s[3] = this.h_return.selector;
            s[4] = this.h_transfer.selector;
            s[5] = this.h_openPlaceholder.selector;
            s[6] = this.h_openDraw.selector;
            s[7] = this.h_draw.selector;
            s[8] = this.h_claim.selector;
            s[9] = this.h_trade.selector;
            s[10] = this.h_collect.selector;
            s[11] = this.h_burn.selector;
            s[12] = this.h_refusedSends.selector;
            s[13] = this.h_warp.selector;
        } else {
            s = new bytes4[](14);
            s[0] = this.h_transfer.selector;
            s[1] = this.h_transfer.selector;
            s[2] = this.h_transfer.selector;
            s[3] = this.h_refusedSends.selector;
            s[4] = this.h_revealGuards.selector;
            s[5] = this.h_pick.selector;
            s[6] = this.h_return.selector;
            s[7] = this.h_openPlaceholder.selector;
            s[8] = this.h_openDraw.selector;
            s[9] = this.h_draw.selector;
            s[10] = this.h_claim.selector;
            s[11] = this.h_trade.selector;
            s[12] = this.h_streamBurn.selector;
            s[13] = this.h_warp.selector;
        }
    }

    // ================================================================================================ actions

    /// A named pick of k shelf items by an actor (funded from eoa[2] when short): the quote from the pre-action
    /// state must be what the vault charges.
    function h_pick(uint256 actorSeed, uint256 kSeed) public {
        if (shelfIds.length == 0) return _skip();
        address who = _actor(actorSeed);
        uint256 k = bound(kSeed, 1, shelfIds.length < 4 ? shelfIds.length : 4);
        (uint256 p, uint256 f) = _pickQuote(k);
        if (!_ensureT(who, p + f)) return _skip();
        if (token.totalSupply() - f < vault.escrowPrincipal() + p + vault.inside() - k) return _skip();
        uint256[] memory ids = new uint256[](k);
        for (uint256 i; i < k; ++i) {
            ids[i] = _takeShelf(uint256(keccak256(abi.encode(kSeed, i))));
        }
        (uint256 principal, uint256 fee) = k == 1 ? _pick(who, ids[0]) : _pickBatch(who, ids);
        assertEq(principal, p, "pick principal from the pre-action state");
        assertEq(fee, f, "pick fee 25%");
        for (uint256 i; i < k; ++i) {
            _noteOutside(ids[i], who);
        }
        ++picks;
    }

    /// A return of k of an actor's items: the quote from the pre-action state must be what the vault pays.
    function h_return(uint256 actorSeed, uint256 kSeed) public {
        address who = _actor(actorSeed);
        uint256[] memory mine = _ownedBy(who);
        if (mine.length == 0) return _skip();
        uint256 k = bound(kSeed, 1, mine.length < 4 ? mine.length : 4);
        uint256[] memory ids = new uint256[](k);
        for (uint256 i; i < k; ++i) {
            ids[i] = mine[i];
        }
        (uint256 r, uint256 rf) = _returnQuote(k);
        (uint256 principal, uint256 fee) = k == 1 ? _returnItem(who, ids[0]) : _returnItems(who, ids);
        assertEq(principal, r, "return principal from the pre-action state");
        assertEq(fee, rf, "return fee 5%");
        for (uint256 i; i < k; ++i) {
            _noteInside(ids[i]);
        }
        ++returns_;
    }

    /// A move between holders by the owner, by an approved address or by an operator, safe or not: the collection
    /// and the real stream must agree on the new owner; the approval must be cleared.
    function h_transfer(uint256 fromSeed, uint256 toSeed, uint256 mode) public {
        if (outsideIds.length == 0) return _skip();
        uint256 id = outsideIds[fromSeed % outsideIds.length];
        address from = ghostOwner[id];
        address to = _actor(toSeed);
        if (to == from) to = _actorAt(toSeed, 1);
        mode %= 4;
        if (mode == 0) {
            vm.prank(from);
            collection.transferFrom(from, to, id);
        } else if (mode == 1) {
            vm.prank(from);
            collection.safeTransferFrom(from, to, id);
        } else if (mode == 2) {
            vm.prank(from);
            collection.approve(to, id);
            vm.prank(to);
            collection.transferFrom(from, to, id);
        } else {
            address op = _actorAt(toSeed, 2);
            if (op == from) op = to;
            vm.prank(from);
            collection.setApprovalForAll(op, true);
            vm.prank(op);
            collection.safeTransferFrom(from, to, id, "u7");
            vm.prank(from);
            collection.setApprovalForAll(op, false);
        }
        assertEq(collection.ownerOf(id), to, "the new owner");
        assertEq(collection.getApproved(id), address(0), "approval cleared");
        (address recorded,) = stream.pendingOf(id);
        assertEq(recorded, to, "the real stream recorded the move");
        ghostOwner[id] = to;
        ++transfers;
    }

    /// A live placeholder opened by its holder with its reveal: one item out, revealed.
    function h_openPlaceholder(uint256 seed) public {
        if (livePlaceholders.length == 0) return _skip();
        uint256 i = seed % livePlaceholders.length;
        uint256 tokenId = livePlaceholders[i];
        address holder = tickets.ownerOf(tokenId);
        uint256 item = _openWith(holder, tokenId);
        livePlaceholders[i] = livePlaceholders[livePlaceholders.length - 1];
        livePlaceholders.pop();
        _noteOutside(item, holder);
        _noteRevealed(item);
        ++opens;
    }

    /// A settled draw opened by its drawer with its reveal.
    function h_openDraw(uint256 seed) public {
        if (openDraws.length == 0) return _skip();
        uint256 i = seed % openDraws.length;
        uint256 t = openDraws[i];
        IBoxTickets.DrawView memory d = tickets.drawTicket(t);
        if (d.status != DrawStatus.Settled) return _skip();
        uint256 item = _openDrawWith(d.drawer, t, d.drawer);
        openDraws[i] = openDraws[openDraws.length - 1];
        openDraws.pop();
        _noteOutside(item, d.drawer);
        _noteRevealed(item);
        ++drawOpens;
    }

    /// One draw by an actor, its word produced (a committed round posted, or the backup after 5 days) and settled,
    /// left open for `h_openDraw`.
    function h_draw(uint256 actorSeed) public {
        if (tickets.phase() != TicketPhase.Drawing) return _skip();
        IBoxTickets.TicketState memory s = _status();
        if (s.drawsSettled != s.drawsRequested) return _skip();
        address who = _actor(actorSeed);
        (uint256 p, uint256 f) = vault.quoteTake(1);
        if (!_ensureT(who, p + f)) return _skip();
        uint256 t = _draw(who, AUDIT_DRAW_VALUE);
        (, uint64 round) = src.requestOf(a.tickets, t);
        _produceWord(round, who);
        vm.prank(keeper);
        uint256 settled = tickets.settle(1);
        assertEq(settled, 1, "the draw settled on its word");
        openDraws.push(t);
        ++draws;
    }

    /// An actor claims its items' stream share.
    function h_claim(uint256 actorSeed) public {
        address who = _actor(actorSeed);
        uint256[] memory mine = _ownedBy(who);
        if (mine.length == 0) return _skip();
        _claimStream(who, mine);
        ++claims;
    }

    /// A buy or a sell through the router stand-in (fees into the stream's value).
    function h_trade(uint256 seed, bool sell) public {
        address who = _actor(seed);
        if (sell) {
            uint256 bal = token.balanceOf(who);
            if (bal < 1e18) return _skip();
            _sell(who, bound(seed, 1e18, bal / 5 < 1e18 ? 1e18 : bal / 5));
        } else {
            _buy(who, bound(seed, 0.001 ether, 0.3 ether));
        }
        ++trades;
    }

    /// A fee batch collected by the keeper when there is one.
    function h_collect() public {
        uint256 e0 = keeper.balance;
        vm.prank(keeper);
        try receiver.collect(keeper) returns (FeeBatch memory) {
            _noteEthChange(e0, keeper.balance, EthIn.Other, EthOut.Tip);
            ++collects;
        } catch {
            _skip();
        }
    }

    /// A holder burns some of its own T (S falls; A falls).
    function h_burn(uint256 actorSeed, uint256 amountSeed) public {
        address who = _actor(actorSeed);
        uint256 bal = token.balanceOf(who);
        if (bal < 10) return _skip();
        uint256 amount = bound(amountSeed, 1, bal / 10);
        if (token.totalSupply() - amount < vault.supplyFloor()) return _skip();
        _burnT(who, amount);
        ++burns;
    }

    /// The stream burns the inside share it holds.
    function h_streamBurn() public {
        stream.burn();
    }

    /// What must never pass: sends to the vault, the collection and T; a stranger moving or returning an outside
    /// item; anyone moving, approving or picking an item the vault still hides; T sent to the vault; the gate and
    /// the adapter paths from an actor.
    function h_refusedSends(uint256 seed) public {
        address stranger = _actorAt(seed, 3);
        if (outsideIds.length != 0) {
            uint256 id = outsideIds[seed % outsideIds.length];
            address from = ghostOwner[id];
            if (stranger == from) stranger = _actorAt(seed, 4);
            _mustRevert(from, a.collection, abi.encodeCall(collection.transferFrom, (from, a.vault, id)));
            _mustRevert(
                from,
                a.collection,
                abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", from, a.vault, id)
            );
            _mustRevert(from, a.collection, abi.encodeCall(collection.transferFrom, (from, a.collection, id)));
            _mustRevert(from, a.collection, abi.encodeCall(collection.transferFrom, (from, a.token, id)));
            _mustRevert(stranger, a.collection, abi.encodeCall(collection.transferFrom, (from, stranger, id)));
            _mustRevert(stranger, a.vault, abi.encodeCall(vault.returnItem, (id, 0, block.timestamp)));
        }
        uint256 hidden = _hiddenFrom(seed);
        _mustRevert(stranger, a.collection, abi.encodeCall(collection.transferFrom, (a.vault, stranger, hidden)));
        _mustRevert(stranger, a.collection, abi.encodeCall(collection.approve, (stranger, hidden)));
        _mustRevert(stranger, a.vault, abi.encodeCall(vault.withdraw, (hidden, type(uint256).max, block.timestamp)));
        _mustRevert(stranger, a.token, abi.encodeCall(token.transfer, (a.vault, 1)));
        _mustRevert(stranger, a.vault, abi.encodeCall(vault.openGate, ()));
        _mustRevert(stranger, a.vault, abi.encodeCall(vault.waiveHandBackFee, ()));
        _mustRevert(stranger, a.vault, abi.encodeCall(vault.openTickets, (1, type(uint256).max)));
        _mustRevert(stranger, a.vault, abi.encodeCall(vault.releaseTickets, (1, stranger, 0)));
        _mustRevert(stranger, a.vault, abi.encodeCall(vault.deliverTicket, (hidden, stranger)));
        ++refusalChecks;
    }

    /// What must never pass: a second reveal of a revealed item, a reveal of an item inside, a reveal with another
    /// item's proof.
    function h_revealGuards(uint256 seed) public {
        if (outsideIds.length != 0) {
            uint256 id = outsideIds[seed % outsideIds.length];
            _mustRevert(_actor(seed), a.collection, _revealCall(id, _revealOf(id)));
        }
        uint256 hidden = 1 + seed % editionSize;
        if (vault.isHidden(hidden) && collection.ownerOf(hidden) == a.vault && !collection.isRevealed(hidden)) {
            _mustRevert(_actor(seed), a.collection, _revealCall(hidden, _revealOf(hidden)));
        }
        ++refusalChecks;
    }

    function h_warp(uint256 seed) public {
        _advance(bound(seed, 1, 30));
    }

    // ================================================================================================ invariants

    /// One campaign per contract (every `invariant_` function would rerun the whole random campaign): VLT-08 read
    /// from the chain, X03 custody, X04 tickets with the real stream in step, reveal once, the vault's approvals,
    /// the gate, and the ghost ledger (X01/X02 at the boundary), all after every call.
    function invariant_AUDIT_U7_vaultCollectionAndStream() public view {
        _assertVlt08("invariant");
        _checkCustody();
        _checkTicketsAndStreamInStep();
        _checkRevealOnce();
        _checkApprovalsAndGate();
        _assertGhostLedger();
    }

    /// X03: the vault holds n + t; outside items are exactly the ghost's, each with its ghost owner; shelf items are
    /// the vault's, on the shelf and revealed; Σ balances over the vault and the actors == N; one owner per id.
    function _checkCustody() internal view {
        uint256 n = vault.inside();
        assertEq(collection.balanceOf(a.vault), n + vault.pendingTickets(), "the vault holds n + t");
        assertEq(outsideIds.length, editionSize - collection.balanceOf(a.vault), "outside items = the ghost's");
        uint256 sum = collection.balanceOf(a.vault);
        for (uint256 i; i < actors.length; ++i) {
            sum += collection.balanceOf(actors[i]);
        }
        assertEq(sum, editionSize, "sum of balances == N");
        for (uint256 i; i < outsideIds.length; ++i) {
            uint256 id = outsideIds[i];
            assertEq(collection.ownerOf(id), ghostOwner[id], "one owner, the ghost's");
            assertTrue(vault.isOutside(id) && vault.hasLeftVault(id), "outside per the vault");
        }
        for (uint256 i; i < shelfIds.length; ++i) {
            uint256 id = shelfIds[i];
            assertEq(collection.ownerOf(id), a.vault);
            assertTrue(vault.isOnShelf(id) && collection.isRevealed(id), "shelf: inside, has left, revealed");
        }
        assertEq(vault.shelfCount(), shelfIds.length, "shelf count = the ghost's");
    }

    /// X04 and the real stream in step (BC-065): pending tickets == live placeholders + open draws, as the vault and
    /// as the stream count them; the stream's m == the vault's outside.
    function _checkTicketsAndStreamInStep() internal view {
        assertEq(vault.pendingTickets(), livePlaceholders.length + openDraws.length, "t = live + open draws");
        (uint256 p, uint256 d,) = stream.openTickets();
        assertEq(p + d, vault.pendingTickets(), "the stream's open tickets");
        assertEq(stream.outsideCount(), vault.outside(), "the stream's m = N - n");
    }

    /// Reveal once: the count is the ghost's; every item that left is revealed (every opening here carried its
    /// reveal).
    function _checkRevealOnce() internal view {
        assertEq(collection.revealedCount(), ghostRevealedCount, "revealed count");
        for (uint256 i; i < outsideIds.length; ++i) {
            assertTrue(collection.isRevealed(outsideIds[i]));
        }
    }

    /// The vault approves nobody; the gate stays open; v1 never waives.
    function _checkApprovalsAndGate() internal view {
        for (uint256 i; i < actors.length; ++i) {
            assertEq(token.allowance(a.vault, actors[i]), 0);
            assertFalse(collection.isApprovedForAll(a.vault, actors[i]));
        }
        assertEq(token.allowance(a.vault, a.tickets), 0);
        for (uint256 i; i < shelfIds.length; ++i) {
            assertEq(collection.getApproved(shelfIds[i]), address(0));
        }
        assertTrue(vault.gateOpen());
        assertFalse(vault.handBackFeeWaived());
    }

    function afterInvariant() external view {
        console.log("picks", picks, "returns", returns_);
        console.log("transfers", transfers, "placeholder opens", opens);
        console.log("draws", draws, "draw opens", drawOpens);
        console.log("claims", claims, "trades", trades);
        console.log("collects", collects, "burns", burns);
        console.log("refusal checks", refusalChecks, "skips", skips);
        console.log("outside now", outsideIds.length, "shelf now", shelfIds.length);
    }

    // ================================================================================================ internals

    function _skip() internal {
        ++skips;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _actorAt(uint256 seed, uint256 shift) internal view returns (address) {
        return actors[(seed % actors.length + shift) % actors.length];
    }

    /// @dev `who` holds at least `amount` T, topped up from eoa[2] when it can be.
    function _ensureT(address who, uint256 amount) internal returns (bool) {
        uint256 bal = token.balanceOf(who);
        if (bal >= amount) return true;
        if (who == eoa[2] || token.balanceOf(eoa[2]) < amount - bal) return false;
        _transferT(eoa[2], who, amount - bal);
        return true;
    }

    function _takeShelf(uint256 seed) internal returns (uint256 id) {
        uint256 i = seed % shelfIds.length;
        id = shelfIds[i];
        shelfIds[i] = shelfIds[shelfIds.length - 1];
        shelfIds.pop();
    }

    function _noteOutside(uint256 id, address owner) internal {
        ghostOwner[id] = owner;
        outsideIds.push(id);
    }

    function _noteInside(uint256 id) internal {
        ghostOwner[id] = address(0);
        for (uint256 i; i < outsideIds.length; ++i) {
            if (outsideIds[i] == id) {
                outsideIds[i] = outsideIds[outsideIds.length - 1];
                outsideIds.pop();
                break;
            }
        }
        shelfIds.push(id);
    }

    function _noteRevealed(uint256 id) internal {
        if (!ghostRevealed[id]) {
            ghostRevealed[id] = true;
            ++ghostRevealedCount;
        }
    }

    function _ownedBy(address who) internal view returns (uint256[] memory mine) {
        uint256 count;
        for (uint256 i; i < outsideIds.length; ++i) {
            if (ghostOwner[outsideIds[i]] == who) ++count;
        }
        mine = new uint256[](count);
        uint256 j;
        for (uint256 i; i < outsideIds.length; ++i) {
            if (ghostOwner[outsideIds[i]] == who) mine[j++] = outsideIds[i];
        }
    }

    /// @dev The word for `round`: a committed round is posted once its time comes; a silent one gets the backup
    /// (started 5 days and a second after its time by `starter`, fixed 257 blocks on by the poster).
    function _produceWord(uint256 round, address starter) internal {
        if (_committed(round)) {
            if (block.timestamp < src.roundTime(round)) _warpTo(src.roundTime(round));
            (, uint64 postedAt) = drand.beaconOf(round);
            if (postedAt == 0) _post(round);
            return;
        }
        (uint64 startedAt,,, bytes32 mix) = src.backupOf(round);
        if (mix != bytes32(0)) return;
        if (startedAt == 0) {
            _warpTo(src.roundTime(round) + src.BACKUP_AFTER() + 1);
            _backup(round, keccak256(abi.encode("u7", round)), starter);
        } else {
            _advance(src.TARGET_BLOCKS() + 1);
            _fixBackup(round, keccak256(abi.encode("u7", round)), poster);
        }
    }

    /// @dev An id the vault still hides (never left), from a seeded start: nearly every id, found at once.
    function _hiddenFrom(uint256 seed) internal view returns (uint256 id) {
        uint256 start = seed % editionSize;
        for (uint256 i; i < editionSize; ++i) {
            id = 1 + (start + i) % editionSize;
            if (vault.isHidden(id)) return id;
        }
        revert("no hidden id left");
    }

    function _mustRevert(address who, address target, bytes memory data) internal {
        vm.prank(who);
        (bool ok,) = target.call(data);
        assertFalse(ok, "must revert");
    }

    function _revealCall(uint256 id, ItemReveal memory r) internal pure returns (bytes memory) {
        return abi.encodeWithSignature(
            "reveal(uint256,uint128,bytes32,bytes32,bytes32,bytes32,bytes32[])",
            id,
            r.traitsPacked,
            r.imageHash,
            r.avatarHash,
            r.modelHash,
            r.salt,
            r.proof
        );
    }
}

/// @notice The vault campaign: weighted to picks, returns, draws and openings (every path that moves n, t and E),
/// with the collection's moves and the stream's claims and trades in the mix.
/// forge-config: default.evm_version = "osaka"
contract AuditU7FableVaultInvariants is AuditU7FableInvariantBase {
    function setUp() public override {
        super.setUp();
        _setUpCampaign();
        targetSelector(FuzzSelector({addr: address(this), selectors: _selectors(true)}));
    }
}

/// @notice The collection campaign: weighted to transfers (plain, safe, approved, operator), refused sends and
/// reveal guards, with enough vault traffic to keep items flowing in and out.
/// forge-config: default.evm_version = "osaka"
contract AuditU7FableCollectionInvariants is AuditU7FableInvariantBase {
    function setUp() public override {
        super.setUp();
        _setUpCampaign();
        targetSelector(FuzzSelector({addr: address(this), selectors: _selectors(false)}));
    }
}
