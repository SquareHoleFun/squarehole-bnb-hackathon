// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IBoxShopLifecycleV2} from "./IBoxShopLifecycleV2.sol";
import {IBoxVaultCountV2} from "./IBoxVaultV2.sol";
import {IBoxSupplyFloor} from "../../box/interfaces/IBoxToken.sol";

/// @notice Creator's immutable SHOP contentsParams = abi.encode(ShopConfigV2); monetary fields are raw T.
struct ShopConfigV2 {
    /// @notice Creator/Safe funds this seed by vault pull before opening; at least two cheapest initial gives.
    uint256 seedT;
    /// @notice Four immutable, strictly increasing nonzero give prices, selected by each collection's tier 0..3.
    uint256[4] givePricesT;
    /// @notice Creator selects 12500, 15000, 20000 or 30000; pick price rounds UP from give price * bps / 10000.
    uint16 pickBps;
    /// @notice Creator selects 500 or 1000 weekly bps, and 100, 250 or 500 per-collection bps <= weekly bps.
    uint16 weeklyBps;
    uint16 collectionBps;
    /// @notice Creator selects 7, 14 or 30 days; initial and later collection entries wait this long.
    uint32 listDelay;
    /// @notice Initial curator, or zero for a fixed list; no curator may remove or alter entries/prices.
    address curator;
    /// @notice Creator commits 1..64 unique nonzero ERC-721 collections with corresponding tiers.
    address[] collections;
    uint8[] tiers;
}

/// @notice M2 role 3; M2SeamArgs.shop prefix (60 bytes), then the opaque contents above. No escrow or price oracle.
/// @dev initialize pulls neither seed nor NFTs. fundSeed is an explicit creator-approved pull after creation.
/// Shop with seed requires add-on 8/role 19 even if starter count is zero: loader completes only after seedReady.
/// Admission requires 1..64 usable initial collections and seedT / 2 >= minInitialGiveT (F132).
/// The minimum uses listed tiers only; an empty starter set still requires this positive two-give seed.
/// No starter NFT is moved during creation. Seed may never be withdrawn.
/// Gives/picks only after coordinator graduation/openGate. Seed, pick receipts and optional capped receiver fee T fund gives; nobody withdraws budget.
/// Weeks are anchored to openGate; first operation in each week fixes that week's budget snapshot. Receipts
/// thereafter fund the next week's allowance. Total and each collection's weekly spend are bounded by
/// max(floor(snapshot * preset / 10000), min(snapshot, cheapest active listed give)). Unlisted/pending tiers
/// do not set the floor. Activating a cheaper tier can lower the floor; earlier spend still counts.
/// The floor is a total allowance, never a per-call top-up. Unused allowance does not roll over.
/// Actual accounted liquid budget bounds every give. Only its own receiver may add bought fee T, up to the immutable ceiling.
/// Failed seed, pick receipts, donations and PM T claims join H once, never K; all remain quarantined for burns.
/// NFTs loaded before failure return to creator; they confer no right to excluded T or separate holder P.
interface IShopVaultV2 is IBoxShopLifecycleV2, IBoxVaultCountV2, IBoxSupplyFloor {
    /// @notice Any unauthorized lifecycle, loader or curator caller is refused atomically.
    error Unauthorized(address caller);
    /// @notice Any caller using an invalid phase, commitment, allowance, tier or recipient is refused atomically.
    error InvalidRequest();
    /// @notice Creator-approved seed pull completed; only the fixed creator was debited.
    event SeedFunded(uint256 amountT);
    /// @notice Curator added one immutable entry; it cannot accept gives until activeAt.
    event CollectionAdded(address indexed collection, uint8 tier, uint256 activeAt);
    /// @notice Item owner gave an NFT and received the fixed tier's T from the budget.
    event Given(address indexed collection, uint256 indexed id, address indexed giver, uint256 amountT);
    /// @notice Picker paid T into the budget and received an NFT; at least one item remains.
    event Picked(address indexed collection, uint256 indexed id, address indexed to, uint256 amountT);
    /// @notice Anyone may fund the exact committed seed once by pulling T from the fixed creator's approval.
    /// @dev Before gate completion, never after failure/graduation; transfer failure rolls back for retry.
    function fundSeed() external;
    /// @notice Anyone reads whether the admitted positive seed has arrived; no money moves.
    function seedReady() external view returns (bool);
    /// @notice Anyone reads currently spendable liquid T; claims-backed frozen T is never spendable after failure.
    function budgetT() external view returns (uint256);
    /// @notice Anyone reads seed times the immutable 2/4/8 preset, saturated at uint256.max; zero on legacy shops.
    function ceilingT() external view returns (uint256);
    /// @notice Anyone reads the weekly fee decision; idle weeks use the live budget. Failure/legacy return false.
    function feesWanted() external view returns (bool);
    /// @notice Anyone reads cumulative fee T accepted, never including seed, picks or gifts.
    function feesT() external view returns (uint256);
    /// @notice Only the own receiver, after opening and never after failure, may fund bought T.
    /// Exact pull and live ceiling check are atomic; the receipt cannot enlarge this week's give allowance.
    function fundFromFees(uint256 amountT) external;
    /// @notice Exact fee receipt increased accounted budget and the cumulative counter.
    event FeesFunded(uint256 amountT, uint256 totalT);
    /// @notice NFT owner msg.sender gives one active listed NFT to the vault for its fixed T price, >= minT.
    /// @dev Vault pulls from caller under a lock; NFT custody and exact T payout succeed together or revert.
    function give(address collection, uint256 id, uint256 minT) external returns (uint256 paidT);
    /// @notice Anyone picks a held NFT to nonzero to, pulling at most maxT from msg.sender, under a lock.
    /// @dev Ceil price enters budget; refuse the last item. Atomic rollback on either transfer failure.
    function pick(address collection, uint256 id, uint256 maxT, address to) external returns (uint256 paidT);
    /// @notice Curator only adds one previously unseen collection/tier, at most once per 7 days, never after failure.
    function addCollection(address collection, uint8 tier) external;
    /// @notice Current curator only proposes a nonzero successor; no custody power passes yet.
    function proposeCurator(address next) external;
    /// @notice Pending successor only accepts; does not reset listing cooldowns or delays.
    function acceptCurator() external;
    /// @notice Current curator only permanently freezes additions and clears any pending successor.
    function renounceCurator() external;
    /// @notice Immutable loader only, before open/failure, pulls one committed NFT from the fixed creator.
    /// @dev Reject duplicate custody and tier mismatch. Creator approval required; never trust caller-supplied owner.
    function loadStarter(address collection, uint256 id, uint8 tier) external;
    /// @notice Anyone retries <= MAX_STARTER_BATCH failed-shop NFT returns, only to the fixed creator.
    /// @dev Isolate each safeTransfer under NFT_RETURN_GAS and reserve; failed items remain retryable.
    /// No approval, arbitrary recipient, excluded T transfer or ledger-P withdrawal is permitted.
    function returnStarter(uint256[] calldata indexes) external returns (uint256 returned);
    /// @notice Anyone reads fixed give/pick prices and activation time; no money moves.
    function collectionTerms(address collection) external view returns (uint256 giveT, uint256 pickT, uint256 activeAt);
    /// @notice Anyone reads quarantined liquid plus claims-backed T awaiting burn; never a redeemable balance.
    function failedT() external view returns (uint256);
    // Inherited supplyFloor returns 0 (no escrow); collectionSize is cumulative accepted NFTs, inside is custody
    // count, insideIntegral is its time integral. Lifecycle caller rules are inherited without alteration.
}

/// @notice Role 19, no initializer; M2SeamArgs.starter (76 bytes). Creator read from fixed coordinator.
/// @dev Ordered commitment: h[i] = keccak256(abi.encode(collection, tokenId, uint8 tier, h[i+1])); h[N]=0.
/// Every batch supplies N items and the remaining hash. Validate the whole page before pulling, update after
/// successful pulls only; exact committed count and terminal zero required. Duplicate (collection,id) forbidden.
/// Zero-count seed-only loader requires hash zero. Full sets contain 10..10000 items. No dependence on batch size.
interface IStarterSetLoaderV2 {
    /// @notice Creator only supplies 1..MAX_STARTER_BATCH items and the suffix commitment before opening/failure.
    /// @dev Shop alone pulls NFTs from creator approvals. Wrong order/hash/count/duplicates revert the entire page.
    function load(address[] calldata collections, uint256[] calldata ids, uint8[] calldata tiers, bytes32 nextHash) external;
    /// @notice Anyone retries notification after exact full set AND seedReady; only this role calls coordinator
    /// starterSetLoaded. A reverted coordinator notification leaves completion retryable, never reopens failure.
    function complete() external;
    /// @notice Anyone reads transferred count, remaining hash and successful completion; no money moves.
    function progress() external view returns (uint32 loaded, bytes32 remainingHash, bool notified);
}

/// @notice Named M2 caps; production measurements and twice-strict-case headroom belong to M2-60.
library ShopLimitsV2 {
    /// @dev Loader/return callers supply at most this many NFTs per transaction.
    uint256 internal constant MAX_STARTER_BATCH = 32;
    /// @dev Each optional failed NFT return receives this cap; failure affects only its own item.
    uint256 internal constant NFT_RETURN_GAS = 800_000;
    /// @dev Retain this after an optional return, plus cap/63 and 20,000 overhead; otherwise skip it.
    uint256 internal constant NFT_RETURN_RESERVE_GAS = 200_000;
    // burnFailedT uses independent 1.25M liquid / 2.5M claims caps, the latter in a capped isolated unlock;
    // retain NFT_RETURN_RESERVE_GAS plus EIP-150/overhead for accounting. A refusal leaves all T in custody.
}
