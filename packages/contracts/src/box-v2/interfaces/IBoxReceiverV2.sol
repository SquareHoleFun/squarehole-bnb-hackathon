// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {RoyaltyDestination} from "../../box/interfaces/BoxTypes.sol";
import {FeeChoice} from "./RecipeTypes.sol";
import {ProtocolSkip} from "./IBoxHookV2.sol";
import {HeldKind, FailRoute} from "./FailureTableV2.sol";

/// @notice Receiver collect result; raw P on both sides, recorded by collect, moves no money itself.
struct FeeBatchV2 {
    /// @notice Buyers P booked by the receiver; includes unlabelled donations, no transfer by this field.
    uint256 buyersP;
    /// @notice Sellers P booked from the sale-fee counter, no transfer by this field.
    uint256 sellersP;
    /// @notice P minted to the coordinator reserve by harvest, no transfer by this field.
    uint256 qToReserve;
    /// @notice Real P tip successfully paid last by collect, no transfer by this field.
    uint256 tip;
}

/// @notice CQ11-B one-part receiver. Pending fee budgets are P claims; v2.1 purchases fund T claims. Non-P royalties remain at the royalty router
/// in every phase and are claimable there by the current creator payee (RC5 C).
interface IBoxReceiverV2 {
    /// @notice Coordinator only, once; validate clone arguments and refuse zero ledgers for holders/items; no money moves.
    function initialize() external;
    /// @notice Anyone; harvest, floor unbooked claims, book both P fee sides and pay the real-P tip last. Failed-box receipts join the holder pot, without a tip.
    function collect(address tipTo) external returns (FeeBatchV2 memory batch);
    /// @notice Anyone after graduation; buy T with Burn or reward P in this pool at 1%, fund its ledger or burn T; real-P tip last.
    function buyBack(address tipTo) external returns (ProtocolSkip skip, uint256 pSpent, uint256 tBought, uint256 tip);
    /// @notice Anyone; retry burning receiver-held T and inside-item T claims; no wallet payout.
    function burnPending() external returns (uint256 burned);
    /// @notice Anyone may trigger owed P payment only to immutable FIT_SAFE; a blocked Safe retains its owed ledger.
    /// @dev F130: a third party chooses timing only, never the recipient or a tip. F127 owner-only claims govern user payouts.
    function payFit() external returns (uint256 amount);
    /// @notice Anyone may trigger owed P payment only to immutable PLATFORM_SAFE; a blocked Safe retains its owed ledger.
    /// @dev F130: a third party chooses timing only, never the recipient or a tip. F127 owner-only claims govern user payouts.
    function payPlatform() external returns (uint256 amount);
    /// @notice Payee only after graduation; withdraw its owed price coin to a nonzero recipient.
    function claimCreator(address token, address to) external returns (uint256 amount);
    /// @notice Current payee only; propose its successor, moves no funds.
    function proposeCreatorPayee(address proposed) external;
    /// @notice Proposed payee only; accept the claim right, moves no funds.
    function acceptCreatorPayee() external;
    /// @notice Coordinator only or lazily within receiver entries; release held pool/grow P, royalties and item P after graduation.
    function onGraduation() external;
    /// @notice Coordinator only after hook.close; harvest counter, split reserve as fees, send keep/burn/pool/items/royalty and pending T-reward P to pot; grow and carries also join the pot.
    function enterFailure() external;
    /// @notice Anyone: accepts only exact P. Before graduation holds it; afterwards books the destination; after failure funds the holder pot.
    function fundRoyalty(address token, uint256 amount) external payable;
    /// @notice Anyone reads the PoolManager; no money moves.
    function poolManager() external view returns (IPoolManager);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function FIT_SAFE() external view returns (address);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function PLATFORM_SAFE() external view returns (address);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function coordinator() external view returns (address);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function hook() external view returns (address);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function token() external view returns (address);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function q() external view returns (address);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function launchRouter() external view returns (address);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function registry() external view returns (address);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function boxId() external view returns (uint256);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function holderLedger() external view returns (address);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function itemLedger() external view returns (address);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function creatorPayee() external view returns (address);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function pendingCreatorPayee() external view returns (address);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function buyersChoice() external view returns (FeeChoice);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function sellersChoice() external view returns (FeeChoice);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function royaltyDestination() external view returns (RoyaltyDestination);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function graduationSettled() external view returns (bool);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function fitOwed() external view returns (uint256);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function platformOwed() external view returns (uint256);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function poolHeldP() external view returns (uint256);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function growHeldP() external view returns (uint256);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function creatorP() external view returns (uint256);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function buyBackP() external view returns (uint256);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function itemsHeldP() external view returns (uint256);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function royaltyHeldP() external view returns (uint256);
    /// @notice Anyone reads fixed wiring or ledger state; no money moves.
    function tBurnPending() external view returns (uint256);
    /// @notice Anyone reads owed/held creator price coin; no funds move.
    function creatorOwed(address token) external view returns (uint256 owed, uint256 held);
    /// @notice Anyone reads total booked claims for this asset; no funds move.
    function booked(address token) external view returns (uint256);
    /// @notice Anyone reads net P assigned, or cumulative bought T for a T-mode batch; no funds move.
    /// @dev T funding grows with purchases; its unconverted P remainder does not prevent settlement.
    function holderBatchPaid(uint256 batchId) external view returns (uint256);
    /// @notice Anyone reads whether the receiver allocated this batch, including zero net P; no funds move.
    /// @dev P funding is final at allocation. T allocation fixes its P interval, while bought T can grow later.
    /// Buyer and seller allocation advance independently; this is not a consecutive funded-id frontier.
    function holderBatchClosed(uint256 batchId) external view returns (bool);
    /// @notice Anyone reads cumulative authenticated harvest returns for a wired ledger; excludes gifts and royalties.
    /// @dev Historical source attribution is on hook.tradeBatch; migration resets the old harvest buyers counter.
    /// Plain M1 returns zero. No funds move, and these totals are never an entitlement denominator.
    function harvestedFees() external view returns (uint256 buyers, uint256 sellers, uint256 reserve);
    /// @notice Receiver allocation finalizes net batch P, including zero; claims move only to its fixed ledger.
    event HolderBatchFunded(uint256 indexed batchId, uint256 netP);
    /// @notice Internal funding rejects an open, repeated or unbacked batch; no money moves.
    error InvalidHolderBatch(uint256 batchId);
    /// @notice Permissionless collect reports fees booked on each side, reserve and actual tip, all in P.
    event Collected(address indexed caller, address tipTo, uint256 buyersP, uint256 sellersP, uint256 qToReserve, uint256 tip);
    /// @notice Permissionless payout reports real P paid to the immutable FIT Safe.
    event FitPaid(address indexed safe, uint256 amount);
    /// @notice Permissionless payout reports real P paid to the immutable platform Safe.
    event PlatformPaid(address indexed safe, uint256 amount);
    /// @notice Permissionless royalty intake reports funds received; forwarding non-P is fail-safe.
    event RoyaltyFunded(address indexed token, RoyaltyDestination indexed destination, uint256 amount);
    /// @notice Permissionless royalty forward reports non-P sent to the fixed conversion Safe.
    /// @notice Permissionless collection reports the floor applied when booked exceeds balance; no extra money moves.
    event BookingClipped(address indexed token, uint256 booked, uint256 balance);
    /// @notice Permissionless buy-back reports P spent, T bought, T burned and actual P tip.
    event BoughtBack(uint256 pSpent, uint256 tBought, uint256 tBurned, uint256 tip);
    /// @notice Coordinator failure reports the destination of each ledger of P claims.
    event FailureRouted(HeldKind indexed kind, FailRoute indexed route, address indexed token, uint256 amount);
    /// @notice Payee claim reports price coin paid to its recipient.
    event CreatorClaimed(address indexed payee, address indexed token, address to, uint256 amount);
    /// @notice Payee proposal reports new claimant; moves no funds.
    event CreatorPayeeProposed(address indexed payee, address indexed proposed);
    /// @notice Accepted payee handover; moves no funds.
    event CreatorPayeeChanged(address indexed previous, address indexed payee);
    /// @notice Rejects an invalid caller, phase or transfer atomically; no money moves.
    error NotCoordinator(address caller);
    /// @notice Rejects an invalid caller, phase or transfer atomically; no money moves.
    error NotPayee(address caller);
    /// @notice Rejects an invalid caller, phase or transfer atomically; no money moves.
    error NotPendingPayee(address caller);
    /// @notice Rejects an invalid caller, phase or transfer atomically; no money moves.
    error AlreadyInitialised();
    /// @notice Rejects an invalid caller, phase or transfer atomically; no money moves.
    error NotGraduated();
    /// @notice Rejects an invalid caller, phase or transfer atomically; no money moves.
    error BoxFailed();
    /// @notice Rejects an invalid caller, phase or transfer atomically; no money moves.
    error TransferNotExact(uint256 expected, uint256 received);
    /// @notice Rejects an invalid caller, phase or transfer atomically; no money moves.
    error WrongValue(uint256 sent, uint256 required);
    /// @notice Rejects an invalid caller, phase or transfer atomically; no money moves.
    error ZeroAddress();
    /// @notice Rejects an invalid caller, phase or transfer atomically; no money moves.
    error NOT_OFFERED();
    /// @notice Rejects an invalid caller, phase or transfer atomically; no money moves.
    error InvalidChoice();
    /// @notice Rejects an invalid caller, phase or transfer atomically; no money moves.
    error ForeignUnlock();
}

/// @notice RC7 source allocation cursors, separate from the original receiver ABI.
interface IBoxReceiverCursorsV21 {
    /// @notice Anyone reads allocated and open source ids; no funds move. Allocated ids start at zero and freeze
    /// after failure settlement. Open ids are zero for a box without trade-batch sources.
    function allocationCursors() external view returns (uint256 lastBuyer, uint256 lastSeller, uint256 openBuyer, uint256 openSeller);
}

/// @notice RC6 failed-claim preview; separate from the original receiver interface for older parts.
interface IBoxReceiverFailedV21 {
    /// @notice Anyone reads the P that failed collect can move to the pot, excluding booked debts; no funds move.
    /// Returns zero until receiver failure settlement completes. Does not harvest or settle holder ledgers.
    function failedCollectableP() external view returns (uint256);
}

/// @notice S2: immutable, transfer-backed Items receipt; anyone reads it without moving funds.
struct ItemFundingV2 {
    /// @notice M2 source batch for source 1; zero for sources 2/3. Carry retries may share a batch, never a receipt id.
    uint256 batchId;
    /// @notice Last committed vault lifecycle sequence before this receipt; determines order, not its timestamp.
    uint256 lifecycleCursor;
    /// @notice Side allocation in its payout asset after deductions. Depth T uses the equal-item basis:
    /// floor(boughtT/outside)*N + boughtT%outside; only ledgerP is actual T backing. Source 3 T is zero.
    uint256 choiceP;
    /// @notice Claims actually transferred to the fixed item ledger (P or T). P inside shares go to
    /// buyBackP under BuyBackBurn, to the existing pool budget under Depth, or to this ledger under Keep.
    uint256 ledgerP;
    /// @notice Fixed-vault inside count, at most N, excluding pending tickets; never a time average.
    uint32 insideCount;
    /// @notice Fixed-vault hidden count, at most insideCount, excluding pending reservations and shelf items.
    uint32 hiddenCount;
    /// @notice Existing FeeSide id: 1 buyers, 2 sellers. Zero is invalid.
    uint8 side;
    /// @notice 1 ordinary trade, 2 non-trade allocation, 3 pre-graduation held-item release; zero is invalid.
    uint8 source;
}

/// @notice S2 declared companion for the receiver's M3 implementation; existing IBoxReceiverV2 stays buildable.
/// @dev Implement in BoxReceiverV2/Base in M3-23. Receipt ids start at 1, are consecutive and never rewritten.
/// Bucket debit, fixed-ledger claims transfer and publication are atomic. No ledger call, including a view,
/// occurs during collect/graduation/failure; policies are authenticated/cached once during initialization.
/// Gifts cannot manufacture credits. A failed transfer publishes nothing; later funds never repair old receipts.
/// On graduation publish source 3 once per Items side (even zero), before live receipts: Keep transfers held P,
/// BuyBackBurn retains all held P; Depth routes it to the existing pool budget. Failure instead sends held Items P to the pot and creates no item credit.
/// Late receiver P joins the holder pot on collect, without a tip. Existing holder batches and their funding namespace are unchanged.
interface IBoxReceiverItemsV2 {
    /// @notice Anyone reads the last published receipt id (zero before any receipt); no funds move.
    function itemFundingCount() external view returns (uint256);
    /// @notice Anyone reads a committed receipt; zero or an id above itemFundingCount reverts. No funds move.
    function itemFunding(uint256 receiptId) external view returns (ItemFundingV2 memory);
    /// @notice Receiver allocation publishes actual backing atomically in the side's payout asset.
    /// For Depth in T, choiceP is the equal-item basis (not bought T); ledgerP is actual T backing.
    /// Source 3 in T is a zero-T marker; ItemsDepthFunded separately accounts for its held P.
    event ItemFunded(uint256 indexed receiptId, uint256 indexed batchId,
        uint8 side, uint8 source, uint256 choiceP, uint256 ledgerP);
}
