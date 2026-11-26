// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice What M1-32-a's planner fills for one box's coordinator clone (`BoxCoordinatorV2Args.encode`).
struct CoordinatorV2Config {
    /// The pricing token P (address(0): native ETH).
    /// @dev Encoders/readers use p as data; no funds move.
    address p;
    /// R in P's raw units (spec field 11).
    /// @dev Encoders/readers use raise as data; no funds move.
    uint256 raise;
    /// The creator buy in P's raw units (field 27; 0 for none).
    /// @dev Encoders/readers use creatorBuy as data; no funds move.
    uint256 creatorBuy;
    /// The box's `QParameters.bootstrapQ`: the untaxed bootstrap buy in P's raw units.
    /// @dev Encoders/readers use bootstrapQ as data; no funds move.
    uint256 bootstrapQ;
    /// Receives the creator buy's T.
    /// @dev Encoders/readers use creator as data; no funds move.
    address creator;
    /// keccak256(abi.encode(spec)) of format 2's `BoxSpec`.
    /// @dev Encoders/readers use specHash as data; no funds move.
    bytes32 specHash;
    /// FIT's buy-and-burn executor (registry role 9), named by every box.
    /// @dev Encoders/readers use executor as data; no funds move.
    address executor;
    /// The chain's pinned drand source.
    /// @dev Encoders/readers use randomness as data; no funds move.
    address randomness;
    /// Registry v2 of this release.
    /// @dev Encoders/readers use registry as data; no funds move.
    address registry;
    /// The release's listing registry.
    /// @dev Encoders/readers use listingRegistry as data; no funds move.
    address listingRegistry;
    /// The listing the box is created on (field 10; 0: ETH).
    /// @dev Encoders/readers use pricingListingId as data; no funds move.
    uint32 pricingListingId;
    /// The spec's open (field 15; Unix seconds, 0 = Now).
    /// @dev Encoders/readers use openAt as data; no funds move.
    uint32 openAt;
    /// 30, 60, 90 or 180 (field 16).
    /// @dev Encoders/readers use deadlineDays as data; no funds move.
    uint16 deadlineDays;
    /// Byte i is the CREATE nonce (1-127) the coordinator's `deploy` creates `BoxRolesV2` role i at, 0 for none.
    /// T must be the first creation, at `ReleaseConstantsV2.TOKEN_CREATE_NONCE` (1); deploy checks this before CREATE.
    /// @dev Encoders/readers use nonces as data; no funds move.
    bytes24 nonces;
}

/// @title BoxCoordinatorV2Args (core v2 M1, ticket M1-30-a; file map § 1 rule 9: the owner's layout)
/// @notice The coordinator clone's immutable arguments, packed (`abi.encodePacked`) after the 45-byte EIP-1167 proxy and
/// read with EXTCODECOPY at the offsets below. None depends on the clone's own address, so its CREATE2 address is known
/// before the transaction (v1's rule, `BoxCoordinator.sol:41-55`). v1's 154 bytes with P any token, the bootstrap in P,
/// registry v2, the listing registry, the listing, the open, the deadline and one nonce byte per `BoxRolesV2` role.
library BoxCoordinatorV2Args {
    /// @notice A raw amount above 2^128 − 1 (the 16-byte fields).
    error AmountTooLarge(uint256 amount);

    /// @dev Encoders/readers use P as data; no funds move.
    uint256 internal constant P = 0; // address
    /// @dev Encoders/readers use RAISE as data; no funds move.
    uint256 internal constant RAISE = 20; // uint128
    /// @dev Encoders/readers use CREATOR_BUY as data; no funds move.
    uint256 internal constant CREATOR_BUY = 36; // uint128
    /// @dev Encoders/readers use BOOTSTRAP_Q as data; no funds move.
    uint256 internal constant BOOTSTRAP_Q = 52; // uint128
    /// @dev Encoders/readers use CREATOR as data; no funds move.
    uint256 internal constant CREATOR = 68; // address
    /// @dev Encoders/readers use SPEC_HASH as data; no funds move.
    uint256 internal constant SPEC_HASH = 88; // bytes32
    /// @dev Encoders/readers use EXECUTOR as data; no funds move.
    uint256 internal constant EXECUTOR = 120; // address
    /// @dev Encoders/readers use RANDOMNESS as data; no funds move.
    uint256 internal constant RANDOMNESS = 140; // address
    /// @dev Encoders/readers use REGISTRY as data; no funds move.
    uint256 internal constant REGISTRY = 160; // address
    /// @dev Encoders/readers use LISTING_REGISTRY as data; no funds move.
    uint256 internal constant LISTING_REGISTRY = 180; // address
    /// @dev Encoders/readers use PRICING_LISTING_ID as data; no funds move.
    uint256 internal constant PRICING_LISTING_ID = 200; // uint32
    /// @dev Encoders/readers use OPEN_AT as data; no funds move.
    uint256 internal constant OPEN_AT = 204; // uint32
    /// @dev Encoders/readers use DEADLINE_DAYS as data; no funds move.
    uint256 internal constant DEADLINE_DAYS = 208; // uint16
    /// @dev Encoders/readers use NONCES as data; no funds move.
    uint256 internal constant NONCES = 210; // bytes24, byte i = role i
    /// @dev Encoders/readers use LENGTH as data; no funds move.
    uint256 internal constant LENGTH = 234;

    /// @notice Optional additive vault-kind tail; absent/zero retains the M1 share vault, 4 selects shop custody.
    uint256 internal constant VAULT_KIND = LENGTH;
    /// @dev Internal failure discriminator; SHOP is encoded in the optional tail.
    uint8 internal constant SHOP_KIND = 4;
    /// @dev Never trusted from clone arguments: selected only by the cached factory-authenticated PILE bit.
    uint8 internal constant PILE_KIND = 5;

    /// @notice Factory encodes shop custody explicitly; ordinary M1 clone bytes remain identical.
    function withShop(bytes memory args, bool shop) internal pure returns (bytes memory) {
        return shop ? bytes.concat(args, hex"04") : args;
    }

    /// @dev Internal callers may read encode; no funds move.
    function encode(CoordinatorV2Config memory c) internal pure returns (bytes memory) {
        return bytes.concat(
            abi.encodePacked(c.p, _u128(c.raise), _u128(c.creatorBuy), _u128(c.bootstrapQ), c.creator, c.specHash),
            abi.encodePacked(c.executor, c.randomness, c.registry, c.listingRegistry),
            abi.encodePacked(c.pricingListingId, c.openAt, c.deadlineDays, c.nonces)
        );
    }

    /// @dev Anyone may read _u128; no funds move.
    function _u128(uint256 a) private pure returns (uint128) {
        if (a > type(uint128).max) revert AmountTooLarge(a);
        // casting to 'uint128' is safe because the value was checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(a);
    }
}
