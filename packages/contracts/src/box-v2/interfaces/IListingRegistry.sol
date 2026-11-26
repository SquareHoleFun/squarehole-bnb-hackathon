// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Manual listing wire ids; internal readers only, no funds move.
enum ListingClass {
    NONE,
    NATIVE,
    STANDARD,
    STABLE,
    STOCK,
    OTHER
}
enum ListingKind {
    NONE,
    LISTED,
    BOX_TOKEN
}
enum ListingRefusal {
    NONE,
    TOKEN_NOT_CONTRACT,
    DECIMALS_OUT_OF_RANGE,
    TRANSFER_NOT_EXACT,
    ERC777_HOOKS,
    ALLOWLIST_ONLY,
    ADDRESS_TOO_HIGH,
    BOX_TOKEN_BY_RULE,
    RESERVED_RELIST_TOO_EARLY,
    CLASS_NOT_ALLOWED,
    RESERVED_ROUTE_SHAPE,
    RESERVED_INTERMEDIATE_NOT_ALLOWED,
    RESERVED_POOL_NOT_FOUND,
    RESERVED_FIXED_RATE_UNKNOWN,
    RESERVED_FIXED_RATE_CHECK,
    RESERVED_FIXED_RATE_IMPLEMENTATION,
    RESERVED_ORACLE_BUFFER_BELOW_FLOOR,
    RESERVED_ORACLE_NOT_COVERING,
    RESERVED_V2_SNAPSHOTS_MISSING,
    RESERVED_AVERAGE_NOT_READY,
    RESERVED_RAISE_OUT_OF_BAND,
    RAISE_NOT_BUILDABLE,
    BOUND_ZERO,
    REGISTRY_UNKNOWN,
    BOX_UNKNOWN,
    NOT_GRADUATED,
    PRICING_NOT_LISTED,
    RESERVED_ROUTE_TOO_DEEP
}

/// @notice Thresholds copied at box creation; fixed by that box's raise, no money moves through this type.
struct QParameters {
    /// @notice Factory/launch router read untaxed bootstrap P amount; no funds move through the field.
    uint256 bootstrapQ;
    /// @notice Receiver reads minimum batch eligible for a tip; no funds move through the field.
    uint256 batchMinQ;
    /// @notice Protocol parts read maximum real-P tip; no funds move through the field.
    uint256 tipMaxQ;
    /// @notice Hook/receiver read minimum P for a protocol step; no funds move through the field.
    uint256 swapStepMinQ;
}
/// @notice One permanent row per coin; lister may update only raise and its derived thresholds for future boxes.
struct ListingRecord {
    /// @notice Lister writes once; anyone reads identity, no money moves.
    uint32 id;
    /// @notice Lister writes once; anyone reads identity, no money moves.
    address token;
    /// @notice Lister writes once; anyone reads identity, no money moves.
    uint8 decimals;
    /// @notice Lister writes once; anyone reads identity, no money moves.
    ListingClass class;
    /// @notice Lister writes once; anyone reads identity, no money moves.
    ListingKind kind;
    /// @notice Lister writes once; anyone reads identity, no money moves.
    uint64 listedAt;
    /// @notice Lister sets/updates; a box snapshots at creation and never rereads its raise; no money moves.
    uint256 raise;
    /// @notice Lister derives from raise for newly created boxes; no money moves.
    QParameters q;
}

/// @notice CQ11-D manual registry; one row per coin for life (F123), with immutable identity and mutable raise.
interface IListingRegistry {
    /// @notice Anyone reads the newest sellable-list version; each eligible addition or lot change increments it.
    function sellableVersion() external view returns (uint256);
    /// @notice Anyone reads a coin's raw lot as of `version` (zero: not sellable then, or a box coin); no money moves.
    function sellableLotAt(address coin, uint256 version) external view returns (uint256);
    /// @notice Anyone reads how many coins the sellable list held at `version`, in insertion order; no money moves.
    function sellableCount(uint256 version) external view returns (uint256);
    /// @notice Anyone reads the sellable coin at `index` in insertion order; no money moves.
    function sellableToken(uint256 index) external view returns (address);
    /// @notice Existing lister sets a positive raw-unit lot for this coin in future boxes.
    function setRoyaltyLot(uint32 id, uint256 lot) external;
    /// @notice Current raw-unit lot; inboxes instead read their captured version.
    function royaltyLot(address token) external view returns (uint256);
    /// @notice A coin's lot was recorded for future boxes (its first listing or the lister's review); no money moves.
    event RoyaltyLotUpdated(address indexed token, uint256 lot);

    /// @notice Lister only; admit a checked token once, prove graduation for a box coin, run exact-transfer probe; no retained funds.
    function add(address token, ListingClass class, uint256 raise) external returns (uint32 id);
    /// @notice Lister only; change the existing row raise and QParameters for future boxes; existing boxes keep their snapshot; no funds move.
    function updateRaise(uint32 id, uint256 raise) external;
    /// @notice Anyone; validate buildable curve/full range and raise bounds without writing or moving funds.
    /// @dev Anyone may read checkLayout; no funds move.
    function checkLayout(uint256 raise) external view;
    /// @notice Anyone reads a permanent row; moves no money.
    function listing(uint32 id) external view returns (ListingRecord memory);
    /// @notice Anyone reads number of rows including native row 0; moves no money.
    function listingCount() external view returns (uint32);
    /// @notice Anyone resolves the one permanent row for a coin; moves no money.
    function newestListingOf(address token) external view returns (bool listed, uint32 id);
    /// @notice Lister only; propose successor or cancel with zero, moves no money.
    function proposeLister(address proposed) external;
    /// @notice Pending lister only; accept listing authority, moves no money.
    function acceptLister() external;
    /// @notice Lister only; propose permanent renunciation, moves no money.
    function proposeRenounce() external;
    /// @notice Lister only after proposal; permanently disable additions and raise updates, moves no money.
    function renounce() external;
    /// @notice Anyone reads registry wiring or authority; no money moves.
    function lister() external view returns (address);
    /// @notice Anyone reads registry wiring or authority; no money moves.
    function pendingLister() external view returns (address);
    /// @notice Anyone reads registry wiring or authority; no money moves.
    function renouncePending() external view returns (bool);
    /// @notice Anyone reads registry wiring or authority; no money moves.
    function renounced() external view returns (bool);
    /// @notice Anyone reads registry wiring or authority; no money moves.
    function boxRegistry() external view returns (address);
    /// @notice Anyone reads registry wiring or authority; no money moves.
    function poolManager() external view returns (address);
    /// @notice Anyone reads registry wiring or authority; no money moves.
    function weth() external view returns (address);
    /// @notice Anyone reads registry wiring or authority; no money moves.
    function RAISE_ETH() external view returns (uint256);
    /// @notice Lister admission records permanent identity and initial raise; only probe transfers occur.
    event ListingAdded(uint32 indexed id, address indexed token, ListingClass class, ListingKind kind, uint256 raise);
    /// @notice Lister update records raise for future boxes; no money moves.
    event RaiseUpdated(uint32 indexed id, uint256 previousRaise, uint256 raise);
    /// @notice Lister authority changes only; no money moves.
    event ListerProposed(address indexed lister, address indexed proposed);
    /// @notice Lister authority changes only; no money moves.
    event ListerChanged(address indexed previous, address indexed lister);
    /// @notice Lister authority changes only; no money moves.
    event RenounceProposed(address indexed lister);
    /// @notice Lister authority changes only; no money moves.
    event Renounced(address indexed lister);
    /// @notice Refuses invalid listing/authority atomically; no money moves.
    error NotLister(address caller);
    /// @notice Refuses invalid listing/authority atomically; no money moves.
    error NotPendingLister(address caller);
    /// @notice Refuses invalid listing/authority atomically; no money moves.
    error NoRenouncePending();
    /// @notice Refuses invalid listing/authority atomically; no money moves.
    error ListingRefused(ListingRefusal reason);
    /// @notice Refuses invalid listing/authority atomically; no money moves.
    error UnknownListing(uint32 id);
    /// @notice Refuses invalid listing/authority atomically; no money moves.
    error AlreadyListed(address token, uint32 id);
}
