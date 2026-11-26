// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice New schema/release identities, not a reassignment of the frozen mainnet release.
library SetConstantsV2 {
    uint16 internal constant FORMAT = 2;
    bytes32 internal constant SCHEMA = keccak256("SquareHole.SetSpecV2.v1");
    bytes32 internal constant RELEASE = keccak256("SquareHole.ExistingNFTs.v1");
    bytes32 internal constant TEMPLATE = keccak256("SquareHole.ExistingNFTs.PicksReturns.Grow.v1");
    uint32 internal constant MIN_COUNT = 10;
    uint32 internal constant MAX_COUNT = 10_000;
    uint256 internal constant MAX_PAGE = 32;
    uint32 internal constant MIN_OPEN_AT = 1_788_220_800;
    uint256 internal constant MAX_OPEN_AHEAD = 14 days;
    uint16 internal constant RETURN_FEE_BPS = 500;
    uint8 internal constant GROW_CHOICE = 3;
}

/// @notice Stable add-on refusal numbers. Common meanings retain BoxSpecV2's numbers; fields use the new schema.
library SetReason {
    uint16 internal constant OK = 0;
    uint16 internal constant UNSUPPORTED_VERSION = 1;
    uint16 internal constant NOT_A_MEMBER = 2;
    uint16 internal constant OUT_OF_RANGE = 4;
    uint16 internal constant LENGTH_OUT_OF_RANGE = 5;
    uint16 internal constant BAD_CHARACTER = 6;
    uint16 internal constant ZERO_VALUE = 7;
    uint16 internal constant RAISE_NOT_A_PRESET = 10;
    uint16 internal constant DEADLINE_RULE = 12;
    uint16 internal constant LISTING_UNKNOWN = 21;
    uint16 internal constant LISTING_MISMATCH = 22;
    uint16 internal constant FORBIDDEN_FIELD = 27; // Strict JSON only: no extra members, even zero-valued.
    uint16 internal constant INVALID_TYPE = 28; // Strict JSON/runtime shape only.
    uint16 internal constant NONCANONICAL_ABI = 29;
    uint16 internal constant COUNT_MISMATCH = 30;
    uint16 internal constant HASH_MISMATCH = 31;
    uint16 internal constant COLLECTION_MISMATCH = 32;
    uint16 internal constant NONZERO_TIER = 33;
    uint16 internal constant DUPLICATE_ID = 34;
    uint16 internal constant PAGE_SIZE = 35;
    uint16 internal constant COLLECTION_NO_CODE = 36;
    uint16 internal constant INTERFACE_REFUSED = 37;
    uint16 internal constant TRANSFER_VALIDATOR = 38;
    uint16 internal constant LOCK_REFUSED = 39;
    uint16 internal constant OWNER_MISMATCH = 40;
    uint16 internal constant PROBE_GAS = 41;
    uint16 internal constant GLOBAL = type(uint16).max;
}
