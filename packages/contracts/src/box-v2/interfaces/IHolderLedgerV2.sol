// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxHolderBatchNoticeV2} from "./IBoxHookV2.sol";

/// @notice P or T holder accounting; the legacy P slots and entry selectors are preserved; no initializer, admin, rescue or expiry.
/// @dev Role 17 keeps the 100-byte P args; T modes append side bits at offset 100. PoolManager is a release immutable.
/// Legacy event/return names ending P denote the batch currency: payoutAsset(batchId) identifies it.
/// T batches settle purchased tranches against original trade history, independently of pending P.
/// Each successful hook notice stores (batch, units, token checkpoint, eligible supply, holder count).
/// Swapper is ignored for eligibility. At that checkpoint holder h earns floor(units * balance(h) / supply)
/// integer units. Entitlement = floor(funding * sum(holder units) / (user + protocol units)), per T tranche
/// or once per P batch. T tranche funding is snapshotted at the start of its bounded settlement.
/// FullMath is required. Missing notices, zero eligible supply and both floors leave residue, never extra credit.
/// Token checkpoints precede optional settlement callbacks. Reads at the notice are the actual T state then:
/// a buy's later token receipt does not earn that buy's fee. No balance inferred from swapper or current holdings.
/// No holder loop on trades/transfers. Closed batches settle in bounded pages over notice/holder pairs;
/// token history recovers missed callbacks exactly, including out-and-back. No approximate balance fallback.
/// Freeze the holder-count bound at the last successful notice; later holders cannot earn earlier units.
/// Only after every pair is accounted does that tranche's credit/residue become available. Earlier tranches
/// stay claimable while new ones settle. No claim deadline; later funding never repays earlier tranches.
interface IHolderLedgerV2 is IBoxHolderBatchNoticeV2 {
    /// @notice Any non-system holder registers itself once, enabling future units only (BC-056).
    /// @dev Calls immutable T.registerHolder(msg.sender) to create an eligibility checkpoint; no money moves.
    /// Wallets earn automatically from first receipt; ordinary contracts must register, never by a third party.
    function register() external;
    /// @notice Any unauthorized hook/token caller is refused before accounting changes.
    error Unauthorized(address caller);
    /// @notice Any caller using an open, unknown or incompletely settled batch is refused.
    error BatchNotReady(uint256 batchId);
    /// @notice Any caller requesting zero/oversized work, invalid recipient or insufficient payout is refused.
    error InvalidRequest();
    /// @notice Permissionless settlement completed for one P batch or one T tranche; amounts are incremental.
    event BatchSettled(uint256 indexed batchId, uint256 fundingP, uint256 holderP, uint256 residueP);
    /// @notice Holder claimed real P; tipP is always zero (event shape retained for owner claims, F127).
    event HolderPaid(uint256 indexed batchId, address indexed holder, address indexed to, uint256 grossP, uint256 tipP);
    /// @notice Permissionless flush transferred only proved residue as P claims to the fixed depth/FIT path.
    event ResidueFlushed(uint256 indexed batchId, address indexed destination, uint256 amountP);

    /// @notice Immutable T only, after its mandatory history write; optional cache hint, no money moves.
    /// @dev TOKEN_SETTLEMENT_GAS capped; skip/revert never blocks transfer, transferFrom, mint or burn.
    /// The token retains TOKEN_SETTLEMENT_RESERVE_GAS after the call; discard all return/revert data.
    /// Correctness cannot depend on this hint. A replay or missed hint cannot invent or erase historical credit.
    function onTokenCheckpoint(uint256 checkpoint, address from, address to) external;
    /// @notice Anyone advances a closed, receiver-allocated batch by 1..MAX_SETTLE_STEPS notice/holder pairs.
    /// @dev Returns true when the current tranche completes; later T purchases require another tranche.
    /// Idempotent without new funding. Reads hook tradeBatch and receiver holderBatchClosed/Paid, never calls
    /// receiver funding. Any failed read reverts only this page. No token code or payout occurs here.
    function settleBatch(uint256 batchId, uint256 maxSteps) external returns (bool complete);
    /// @notice Holder msg.sender only; redeem its settled credit to nonzero to; T uses bounded int128 tranches.
    /// @dev No minimum/tip/expiry; works for contracts and after failure. Locked unlock/burn/take payout;
    /// rejection rolls back only this claim. Never pay wallet ERC-6909 claims. No claim on others' credit.
    function claim(uint256 batchId, address to) external returns (uint256 paidP);
    /// @notice Anyone transfers settled unflushed residue as claims to immutable hook while live,
    /// or immutable receiver after failure, then the holder pot on collect. T batches burn residue in bounded retries.
    /// @dev No ledger call on receipt, no gift API, no payout tip. Transfer failure rolls back for retry.
    function flushResidue(uint256 batchId) external returns (uint256 amountP);
    /// @notice Anyone reads remaining credit from completed settlement; T keeps earlier credits during new pages.
    function claimable(uint256 batchId, address holder) external view returns (uint256 amountP);
    /// @notice Anyone reads progress and proved residue; complete means all currently bought funding is settled.
    /// @dev T becomes incomplete again when new funding arrives; previous credits/residue remain available.
    function batchState(uint256 batchId) external view returns (bool complete, uint256 holderCursor, uint256 noticeCursor, uint256 residueP);
}

/// @notice Additional M2 token history contract, owned here; IBoxTokenV2 and its 137-byte args stay unchanged.
/// @dev Implement only in BoxTokenV2Ledger. Local writes are mandatory on every nonzero balance change,
/// including mint/burn and transferFrom; one monotonically increasing checkpoint per operation, both balances
/// and eligible supply recorded before the optional ledger hint. Self/zero transfers make no checkpoint.
/// Exclude zero, T itself, PoolManager and every nonzero fixed box role (0..23), resolved before initial mint.
/// Wallet/no-code or exact 7702 status at first receipt enables automatic eligibility; ordinary contracts
/// must self-register through the ledger. Registration creates a new checkpoint, never backdates eligibility.
/// Later code changes never rewrite past units or restrict self claims. System exclusions cannot be registered away.
/// Append each eligible recipient once to a stable enumeration; histories never pruned. Historical lookup uses
/// upper-bound binary search, zero before first receipt. Count bound at a notice prevents later enumeration grief.
interface IHolderTokenHistoryV2 {
    /// @notice Immutable ledger only registers this holder, recording balance and supply at a new checkpoint.
    /// @dev Reject fixed system addresses; once enabled never disabled. No callback needed and no money moves.
    function registerHolder(address holder) external;
    /// @notice Anyone reads the latest committed token mutation checkpoint, no money moves.
    function holderCheckpoint() external view returns (uint256);
    /// @notice Anyone reads eligible supply at a committed checkpoint; future checkpoints revert.
    function eligibleSupplyAt(uint256 checkpoint) external view returns (uint256);
    /// @notice Anyone reads eligible holder balance at a committed checkpoint; future checkpoints revert.
    function eligibleBalanceAt(address holder, uint256 checkpoint) external view returns (uint256);
    /// @notice Anyone reads current stable enumeration length; no money moves.
    function holderCount() external view returns (uint256);
    /// @notice Anyone reads a holder at a stable zero-based index; out-of-range reverts, no money moves.
    function holderAt(uint256 index) external view returns (address);
}

/// @notice M2-only ceilings; existing CQ11 notice/settlement caps remain in ReleaseConstantsV2 unchanged.
library HolderLedgerLimitsV2 {
    /// @dev Callers may process at most this many notice/holder pairs per settlement transaction.
    uint256 internal constant MAX_SETTLE_STEPS = 64;
    /// @dev Token reserves this after its optional callback plus cap/63 and 20,000 overhead. Provisional M2-60.
    uint256 internal constant TOKEN_SETTLEMENT_RESERVE_GAS = 1_200_000;
}
