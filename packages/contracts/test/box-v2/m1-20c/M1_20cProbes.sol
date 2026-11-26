// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// TEST ONLY (M1-20-c red tests, `docs/evidence/SH-V2-M1-20C.md`). `ListingChecks` and `BoxTokenProof` are internal
// libraries the listing registry (M1-20-b's shell) calls, with no frozen stub (file map § 1 rule 8: a ticket's own
// slots share them), so the red tests reach them through two probes: small harnesses the implementer writes in this
// folder, each entry calling the library and nothing else. `M1_20cDeployHook.sol` deploys them; until it is filled it
// reverts `NotBuilt()`, as the frozen stubs do. These interfaces are the tests' face of the libraries, not their
// signatures: the libraries may take other arguments, and the probe maps them. Marks: [V] ADR-0017 or the ticket says
// it; [P] chosen here.

/// @notice What `proveBox` proved, as the tests read it.
struct BoxProofView {
    uint8 registryIndex;
    uint256 boxId;
    /// The registry at `registryIndex`: this release's box registry (0) or `directory()[i - 1]` [V ADR-0017 § 3, § 10].
    address registry;
    /// `registry.coordinatorOf(boxId)` [V].
    address coordinator;
    /// `coordinator.token()`, never an address a caller supplies [V].
    address token;
    /// `coordinator.hook()`, whose `priceAverage()` gives the 1-hour average [V].
    address hook;
    /// `coordinator.q()`: the box's pricing token (address(0): ETH) [V v1 view; P carried here].
    address pricingToken;
}

/// @title IListingChecksProbe
/// @notice The token-behaviour checks `add()` runs on a token it is given (ADR-0017 § 3, "On-chain checks at listing";
/// § 4, the address ceiling) [V], each its `ListingRefusal`:
/// - code exists (`TOKEN_NOT_CONTRACT`);
/// - below `ReleaseConstantsV2.LISTED_TOKEN_CEILING` (`ADDRESS_TOO_HIGH`);
/// - `decimals()` 6-18; a missing or failing `decimals()` reads as out of range (`DECIMALS_OUT_OF_RANGE`) [P the
///   missing case];
/// - no ERC-777 registration: the ERC-1820 registry (`ERC1820_REGISTRY`) names no implementer of `ERC777Token` for the
///   token; a registry without code reads as no registration (`ERC777_HOOKS`) [P the lookup's form];
/// - exact transfers both ways: every probe transfer moves exactly the amount named on both sides
///   (`TRANSFER_NOT_EXACT`); the probe's amount is at least 10,000 raw units, so a 1 bps fee shows [P];
/// - a wallet nobody allowed can hold it, so an allowlist that names the registry and the PoolManager still fails
///   (`ALLOWLIST_ONLY`) [P]; a blocklist that leaves those wallets alone passes (Ondo, F88) [V].
/// Name and symbol are never read (listing by address, BC-155) [V]. The order of the checks is the implementer's [P].
interface IListingChecksProbe {
    /// @notice Runs the checks on `token`. Probe transfers are paid from `funder`, which approved this probe for any
    /// amount (in `add()`, the lister) [P]; at the end every balance and the supply are as they started.
    /// @return decimals the token's decimals, when it passes
    /// @dev Reverts `IListingRegistry.ListingRefused(reason)` on the first check that fails.
    function checkToken(address token, address funder) external returns (uint8 decimals);
}

/// @title IBoxTokenProofProbe
/// @notice The two proofs about Square Hole box tokens (ADR-0017 § 3) [V]:
/// - **the reverse proof** `add()` refuses box tokens with (`BOX_TOKEN_BY_RULE`): the token's `initialHolder()`, read
///   by a gas-capped staticcall, is a coordinator that this release's registry or one in its fixed directory records
///   (`boxIdOf`), and that coordinator's `token()` is the token. A revert, a bad return or a coordinator no listed
///   registry records reads as no box [V]; a bad return is anything but one 32-byte word holding an address [P];
/// - **the forward proof and the state** `addBoxToken(registryIndex, boxId)` builds on: the registry from the index
///   (`REGISTRY_UNKNOWN`), the coordinator from the registry (`BOX_UNKNOWN`), the token from the coordinator, the box
///   graduated (`NOT_GRADUATED`) and its hook's 1-hour average ready (`AVERAGE_NOT_READY`) [V]. No token address is
///   checked against `LISTED_TOKEN_CEILING` (ADR-0017 § 4: `addBoxToken` checks no address) [V].
/// The pricing listing's presence (`PRICING_NOT_LISTED`), the route's depth (`ROUTE_TOO_DEEP`) and every hop's checks
/// are the registry's and `RouteChecks`' (M1-20-a, M1-20-b) [P the split].
interface IBoxTokenProofProbe {
    function isBoxToken(address token) external view returns (bool);
    /// @dev Reverts `IListingRegistry.ListingRefused(reason)` on the first check that fails.
    function proveBox(uint8 registryIndex, uint256 boxId) external view returns (BoxProofView memory);
}

/// @dev The ERC-1820 registry, at the same address on every chain (EIP-1820) [V].
address constant ERC1820_REGISTRY = 0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24;
/// @dev The interface hash an ERC-777 token registers for itself (EIP-777) [V].
bytes32 constant ERC777_TOKEN_HASH = keccak256("ERC777Token");
