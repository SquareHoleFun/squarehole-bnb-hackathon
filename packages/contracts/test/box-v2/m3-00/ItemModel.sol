// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ItemHistoryModel} from "./ItemHistoryModel.sol";
import {ItemFundingV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {ItemLifecycleV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IItemLedgerV2} from "../../../src/box-v2/interfaces/IItemLedgerV2.sol";

/// @dev Small-collection executable oracle, NOT a production algorithm. Enumerates known items/tickets on sync,
/// never guesses unrevealed IDs; production uses lazy indexes and materializes only the journal's named record.
contract ItemModel {
    struct Item { uint256 credit; uint256 stash; bool known; bool outside; }
    struct Ticket { uint256 start; uint256 credit; uint256 stash; bool open; }
    ItemHistoryModel public immutable history;
    mapping(uint256 => Item) private items;
    mapping(bytes32 => Ticket) private tickets;
    bytes32[] private keys;
    uint256 public fundingCursor;
    uint256 public lifecycleCursor;
    uint256 public hidden;
    uint256 public hiddenStash;
    uint256 public baseUnassigned;
    uint256 public basePerItem;
    uint256 public index;
    uint256 public residue;
    uint256 public depth;
    uint256 public paid;
    uint256 private processedP;
    constructor(ItemHistoryModel h) { history = h; hidden = h.n(); }
    /// @notice Anyone reads both immutable policies; no funds move.
    function insidePolicies() external view returns (uint8, uint8) { return (history.buyers(), history.sellers()); }
    /// @notice Anyone replays at most k records of each authenticated journal; failed reads revert only this page.
    function sync(uint256 k) external {
        require(k != 0 && k <= 32, "page"); uint256 f; uint256 l;
        while (true) {
            if (l < k && lifecycleCursor < history.itemLifecycleCount()) {
                ItemLifecycleV2 memory op = history.itemLifecycle(lifecycleCursor+1);
                if (op.fundingCursor <= fundingCursor) { _operation(op); ++lifecycleCursor; ++l; continue; }
            }
            if (f < k && fundingCursor < history.itemFundingCount()) {
                ItemFundingV2 memory r = history.itemFunding(fundingCursor+1);
                if (r.lifecycleCursor <= lifecycleCursor) { _receipt(r); ++fundingCursor; ++f; continue; }
            }
            break;
        }
    }
    function _receipt(ItemFundingV2 memory r) private {
        uint256 n = history.n(); uint256 u = r.choiceP / n;
        bool keep = (r.side == 1 ? history.buyers() : history.sellers()) == 1;
        require(r.hiddenCount == hidden && r.insideCount <= n, "counts");
        uint256 expected = keep ? r.choiceP : r.source == 3 ? 0 : r.choiceP - r.insideCount*u;
        require(r.ledgerP == expected, "backing"); processedP += r.ledgerP;
        if (r.source == 3) {
            if (keep) { basePerItem += u; baseUnassigned += n*u; residue += r.choiceP % n; }
            return;
        }
        index += u; residue += r.choiceP % n;
        if (keep) hiddenStash += hidden*u;
        for (uint256 id = 1; id <= n; ++id) {
            Item storage a = items[id];
            if (a.outside) a.credit += u; else if (a.known && keep) a.stash += u;
        }
        for (uint256 j; j < keys.length; ++j) if (tickets[keys[j]].open) tickets[keys[j]].credit += u;
    }
    function _slot() private returns (uint256 stash) {
        require(hidden != 0, "hidden"); stash = hiddenStash / hidden; hiddenStash -= stash; --hidden;
    }
    function _assign(uint256 id) private {
        Item storage a = items[id]; require(!a.known, "known"); a.known = true;
        a.stash += basePerItem; baseUnassigned -= basePerItem;
    }
    function _operation(ItemLifecycleV2 memory op) private {
        Ticket storage t = tickets[op.ticketKey]; Item storage a = items[op.itemId];
        if (op.kind == 1) {
            keys.push(op.ticketKey); t.start = index; t.stash = _slot(); t.open = true;
        } else if (op.kind == 2) {
            require(t.open, "ticket"); _assign(op.itemId); a.outside = true;
            a.credit += t.credit; a.stash += t.stash; t.credit = 0; t.stash = 0; t.open = false;
        } else if (op.kind == 3) {
            require(t.open, "ticket"); residue += t.credit; hiddenStash += t.stash; ++hidden;
            t.credit = 0; t.stash = 0; t.open = false;
        } else if (op.kind == 4) {
            if (!a.known) { a.stash += _slot(); _assign(op.itemId); } a.outside = true;
        } else if (op.kind == 5) a.outside = false;
        else require(op.kind == 6, "kind"); // failed pre-graduation release has no item funding
    }
    /// @notice Anyone reads a valid NFT; hidden credits materialize at assignment, foreign ids revert.
    function itemCredit(uint256 id) external view returns (uint256, uint256) {
        require(id != 0 && id <= history.n(), "item"); return (items[id].credit, items[id].stash);
    }
    /// @notice Anyone reads exact-key outside credit/start/open status; no funds move.
    function ticketCredit(bytes32 key) external view returns (uint256, uint256, bool) {
        Ticket storage t = tickets[key]; return (t.start, t.credit, t.open);
    }
    /// @notice Test observation only: anyone reads retained stash separately from outside credit.
    function ticketStash(bytes32 key) external view returns (uint256) { return tickets[key].stash; }
    function _ready() internal view {
        if (fundingCursor != history.itemFundingCount() || lifecycleCursor != history.itemLifecycleCount())
            revert IItemLedgerV2.ItemSyncPending(fundingCursor, lifecycleCursor);
    }
    /// @notice Current owner only; the single-id initial batch bound makes duplicate/unsorted batches invalid.
    function claim(uint256[] calldata ids, address to) external virtual returns (uint256 amount) {
        _ready(); require(ids.length == 1 && to != address(0) && to != address(history), "recipient/batch");
        require(history.ownerOf(ids[0]) == msg.sender, "owner");
        amount = _take(ids[0]); paid += amount;
    }
    function _take(uint256 id) internal returns (uint256 amount) {
        Item storage a = items[id]; require(a.outside, "inside"); amount = a.credit+a.stash;
        require(amount != 0, "empty"); a.credit = 0; a.stash = 0;
    }
    /// @notice Anyone transfers proved residue only to fixed depth; no item, ticket or hidden liability is swept.
    function flushResidue() external returns (uint256 amount) { amount = residue; residue = 0; depth += amount; }
    /// @notice Anyone reads pending and processed liabilities plus payouts/depth, for conservation.
    function accounted() external view returns (uint256 total) {
        total = history.ledgerTransferred() - processedP + hiddenStash + baseUnassigned + residue + depth + paid;
        for (uint256 id = 1; id <= history.n(); ++id) total += items[id].credit + items[id].stash;
        for (uint256 j; j < keys.length; ++j) total += tickets[keys[j]].credit + tickets[keys[j]].stash;
    }
}
