// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IItemLedgerCalls} from "./ILedgerCalls.sol";

/// @title Item ledger accounting and claim interface.
/// @notice Equal weights for every item of this box's NEW_COLLECTION; P mode is unchanged; v2.1 T modes append immutable currency bits.
/// @dev Funding and lifecycle journals authenticate every receipt and custody change.
/// No receiver funding callback: sync reads committed net receipts after their selected-asset claims transfer.
/// Keep stashes and unclaimed outside funds follow the NFT through transfers/returns, without expiry.
/// BuyBackBurn and Depth belong to the receiver; this ledger only burns resolved T residue and never swaps.
/// Legacy claim/read entries always use P. T boxes use claimT/itemCreditT
/// for their independent T state. Event names distinguish T payments; legacy receipt fields use the side currency.
/// F127: owner claims only, without a minimum, tip, wallet-code restriction or expiry.
interface IItemLedgerV2 is IItemLedgerCalls {
    /// @notice Fixed coordinator only, once on an authenticated clone; validate collection and wiring, move no funds.
    function initialize() external;
    /// @notice Anyone; consume at most maxReceipts receipts and lifecycle records per active currency once after graduation.
    /// @dev No arbitrary balance delta is funding. Invalid/unfunded records cannot create credit or borrow later P.
    function sync(uint256 maxReceipts) external;
    /// @notice Current NFT owner only, for one id; pay its outside credit and stash to nonzero to, never the vault.
    /// @dev Exactly one item per claim; settle conservatively first. Atomic token-payout failure preserves all credit.
    /// Contract owners claim themselves; no ERC-6909-to-wallet fallback. Payouts use the named CLAIM_GAS stipend.
    function claim(uint256[] calldata ids, address to) external returns (uint256 p);
    /// @notice Anyone; transfer only resolved rounding/cancel/missed-call residue as P claims to fixed hook depth. The additive flushResidueT burns T residue.
    /// @dev Outside receiver booking, never gifts; cannot flush item liabilities or unresolved tickets.
    function flushResidue() external returns (uint256 p);
    /// @notice Anyone reads processed receipt cursor; no funds move.
    function fundingCursor() external view returns (uint256);
    /// @notice Anyone reads this item's unclaimed outside P and retained inside stash; no funds move.
    function itemCredit(uint256 id) external view returns (uint256 outsideP, uint256 stashP);
    /// @notice Anyone reads the exact ticket's start, accrued P and open flag; no funds move.
    /// @dev Key must distinguish draw ids from pre-graduation placeholders. Timestamp is never identity.
    function ticketCredit(bytes32 ticketKey) external view returns (uint256 start, uint256 p, bool open);
    /// @notice Anyone reads the bounded real-P payout stipend, to be measured and aligned with M2-00; no funds move.
    function CLAIM_GAS() external view returns (uint256);

    /// @notice Anyone reads immutable per-side inside policies, including before initialization; no funds move.
    /// @dev S1: 0 for a non-Items side, 1 Keep, 2 BuyBackBurn, 3 Depth. The authenticated role-16 clone encodes these at
    /// packed offsets 140/141, after coordinator/vault/collection/tickets/receiver/hook/P; minimum P and tip cap
    /// occupy legacy slots at 142/174 (206 bytes total), unused by claims under F127.
    /// Receiver validates/caches policies once; funding never calls this ledger.
    function insidePolicies() external view returns (uint8 buyers, uint8 sellers);

    /// @notice Anyone reads the last fully processed vault lifecycle sequence; no funds move.
    /// @dev S4: sync(k) processes at most k receipts AND k lifecycle records, initially 1 <= k <= 32.
    /// Opposite cursors order the journals, even in one second; lifecycle progress needs no new funding receipt.
    /// Exact keys survive missed notices and reverse delivery. Unsynced funding/stashes/tickets remain liabilities.
    /// Claims reconcile through their entry's snapshotted cursors or revert ItemSyncPending; custody never waits.
    function lifecycleCursor() external view returns (uint256);

    /// @notice A caller's claim cannot catch up within bounded work; revert payout, preserving every credit for retry.
    /// @dev Reports the ledger's processed receipt and lifecycle cursors, not the target cursors. Anyone can sync.
    error ItemSyncPending(uint256 receiptCursor, uint256 lifecycleCursor);
}
