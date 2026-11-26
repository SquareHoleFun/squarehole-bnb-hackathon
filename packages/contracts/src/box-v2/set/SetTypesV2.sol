// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Pricing, Listing} from "../interfaces/SpecTypes.sol";

/// @notice Separate add-on wire schema. Field ids are the zero-based order below; no funds move.
struct SetSpecV2 {
    uint16 format;
    bytes32 schema;
    bytes32 release;
    string tokenName;
    string tokenSymbol;
    Pricing pricing;
    uint256 raise;
    uint32 openAt;
    uint16 deadlineDays;
    uint256 creatorBuy;
    address collection;
    uint32 count;
    bytes32 setHash;
    uint16 pickFeeBps;
    string description;
    bytes32 logoSha256;
}

/// @notice Factory supplies the admitted pricing snapshot and block time, never creator-supplied authority.
struct SetValidationContext {
    Listing listing;
    uint256 timestamp;
}

/// @notice Immutable membership commitment, compatible with the unchanged starter loader.
struct SetCommitment {
    address collection;
    uint32 count;
    bytes32 setHash;
}

/// @notice Exact arguments of StarterSetLoaderV2.load; nextHash is the suffix after this page.
struct SetPage {
    address[] collections;
    uint256[] ids;
    uint8[] tiers;
    bytes32 nextHash;
}

error SetRefused(uint16 reason, uint16 field);
