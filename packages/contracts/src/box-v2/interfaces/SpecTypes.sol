// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Side} from "./RecipeTypes.sol";

// BoxSpec format 2 and its release context: the shapes ticket M1-00 freezes (docs/design/core-v2-m1-tickets.md § 2,
// Lane 0; ADR-0017 § 12; docs/design/box-spec-v2-draft.md § 2-4). Owner 1 of M1-00 writes this file.
//
// M1-10's generated library (src/box-v2/BoxSpecV2.sol) and its TypeScript twin use these types and never redefine them;
// `validate(spec, ctx)` and the field rules, reasons, presets and caps are M1-10's. Format 1 (src/box/BoxSpecV1.sol) is
// frozen for box 0 and is not imported here (ADR-0017 § 10).
//
// Wire rules: every enum field is a uint8 and 0 is never a member, so a bad value decodes and is refused with a reason;
// the spec hash is `keccak256(abi.encode(spec))`, as format 1's (BoxSpecV1.sol:358-360). Field ids keep format 1's
// numbers where the meaning is the same (box-spec-v2-draft.md § 2); the struct lists fields 0-31 in id order.

/// @notice BoxSpec field 2: what is in the box (box-spec-v2-draft.md § 1-2; format 1's values kept, 4 and 5 added).
/// @dev `BoxSpec.boxType` carries it as a uint8. The member names are the ticket's and the draft's exact names
/// (`SHOP`, `PILE`: core-v2-m1-tickets.md § 2 M1-00; `NEW_COLLECTION`, `EXISTING`, `TOKEN_ONLY`: box-spec-v2-draft.md
/// § 2 field 2), as BoxSpecV1's `BOX_TYPE_*` constants spell them (integrator, M1-00).
enum BoxType {
    NONE,
    /// @dev A new collection in the supply-share vault. Offered in M1.
    NEW_COLLECTION,
    /// @dev Existing NFTs (M3); NOT_OFFERED in M1.
    EXISTING,
    /// @dev Just the token. Offered in M1.
    TOKEN_ONLY,
    /// @dev A shop vault (M2); NOT_OFFERED in M1.
    SHOP,
    /// @dev A coin pile (M3); NOT_OFFERED in M1.
    PILE
}

/// @notice BoxSpec field 10: the pricing token, named by its listing in this release.
struct Pricing {
    /// @dev The listing id in this release's listing registry; 0 = native ETH.
    /// @dev Encoders/readers use listingId as data; no funds move.
    uint32 listingId;
    /// @dev The listing's token, which must match it (`LISTING_MISMATCH`); address(0) with listing 0.
    /// @dev Encoders/readers use token as data; no funds move.
    address token;
}

/// @notice One add-on (field 29): its catalog id and the canonical `abi.encode` of its params tuple (add-ons.v2.json),
/// as format 1's (BoxSpecV1.sol `AddOn`).
struct AddOn {
    /// @dev Encoders/readers use id as data; no funds move.
    uint16 id;
    /// @dev Encoders/readers use params as data; no funds move.
    bytes params;
}

/// @notice A format 2 BoxSpec (box-spec-v2-draft.md § 2). `createBox` takes it whole as calldata and the chain keeps
/// only its hash; the table and the other `tokenURI` texts load after creation in chunks (F96 R20C; ADR-0017 § 6).
struct BoxSpec {
    /// @dev Field 0: 2.
    /// @dev Encoders/readers use format as data; no funds move.
    uint16 format;
    /// @dev Field 1: 2 (core v2).
    /// @dev Encoders/readers use version as data; no funds move.
    uint16 version;
    /// @dev Field 2: a `BoxType` value. NEW_COLLECTION 1 or TOKEN_ONLY 3 in M1; EXISTING 2 (M3), SHOP 4 (M2) and PILE
    /// 5 (M3) are NOT_OFFERED.
    /// @dev Encoders/readers use boxType as data; no funds move.
    uint8 boxType;
    /// @dev Field 3.
    /// @dev Encoders/readers use tokenName as data; no funds move.
    string tokenName;
    /// @dev Field 4.
    /// @dev Encoders/readers use tokenSymbol as data; no funds move.
    string tokenSymbol;
    /// @dev Field 5.
    /// @dev Encoders/readers use collectionName as data; no funds move.
    string collectionName;
    /// @dev Field 6.
    /// @dev Encoders/readers use collectionSymbol as data; no funds move.
    string collectionSymbol;
    /// @dev Field 7.
    /// @dev Encoders/readers use description as data; no funds move.
    string description;
    /// @dev Field 8: 10-10,000; zero for TOKEN_ONLY.
    /// @dev Encoders/readers use n as data; no funds move.
    uint32 n;
    /// @dev Field 9: 1; zero for TOKEN_ONLY.
    /// @dev Encoders/readers use firstId as data; no funds move.
    uint256 firstId;
    /// @dev Field 10.
    /// @dev Encoders/readers use pricing as data; no funds move.
    Pricing pricing;
    /// @dev Field 11: in the token's raw units, equal to the listing raise at creation; then fixed for this box.
    /// @dev Encoders/readers use raise as data; no funds move.
    uint256 raise;
    /// @dev Field 12: CURVE_V1.
    /// @dev Encoders/readers use layout as data; no funds move.
    uint8 layout;
    /// @dev Field 13: FULL_RANGE (3).
    /// @dev Encoders/readers use gradLayout as data; no funds move.
    uint8 gradLayout;
    /// @dev Field 14: CURVE.
    /// @dev Encoders/readers use launchFormat as data; no funds move.
    uint8 launchFormat;
    /// @dev Field 15: as format 1 (at most 14 days ahead, checked by the factory).
    /// @dev Encoders/readers use openAt as data; no funds move.
    uint32 openAt;
    /// @dev Field 16: 30, 60, 90 or 180, required (every v2 box can fail).
    /// @dev Encoders/readers use deadlineDays as data; no funds move.
    uint16 deadlineDays;
    /// @dev Field 17: the buyers' recipe; fees arrive in P.
    /// @dev Encoders/readers use buyers as data; no funds move.
    Side buyers;
    /// @dev Field 18: the sellers' recipe; fees arrive in P.
    /// @dev Encoders/readers use sellers as data; no funds move.
    Side sellers;
    /// @dev Field 19.
    /// @dev Encoders/readers use artMode as data; no funds move.
    uint8 artMode;
    /// @dev Field 20.
    /// @dev Encoders/readers use revealRoot as data; no funds move.
    bytes32 revealRoot;
    /// @dev Field 21: at most `TABLE_MAX` bytes; it stays in the spec, the chain keeps its hash, and it loads in chunks of
    /// at most `CHUNK_MAX` bytes after creation.
    /// @dev Encoders/readers use metadataTable as data; no funds move.
    bytes metadataTable;
    /// @dev Field 22.
    /// @dev Encoders/readers use generatorHash as data; no funds move.
    bytes32 generatorHash;
    /// @dev Field 23.
    /// @dev Encoders/readers use coverSha256 as data; no funds move.
    bytes32 coverSha256;
    /// @dev Field 24.
    /// @dev Encoders/readers use revealListId as data; no funds move.
    bytes32 revealListId;
    /// @dev Field 25.
    /// @dev Encoders/readers use marketplaceOwner as data; no funds move.
    address marketplaceOwner;
    /// @dev Field 26: required exactly when a menu side pays `Creator` or the box has the royalties add-on; zero otherwise.
    /// @dev Encoders/readers use creatorFeeRecipient as data; no funds move.
    address creatorFeeRecipient;
    /// @dev Field 27: pricing-token raw units, below the raise.
    /// @dev Encoders/readers use creatorBuy as data; no funds move.
    uint256 creatorBuy;
    /// @dev Field 28.
    /// @dev Encoders/readers use collectionCoverSha256 as data; no funds move.
    bytes32 collectionCoverSha256;
    /// @dev Field 29: at most 8 entries, ascending ids.
    AddOn[] addOns;
    /// @dev Field 30: reserved for SHOP and PILE (M2, M3); empty in M1.
    /// @dev Encoders/readers use contentsParams as data; no funds move.
    bytes contentsParams;
    /// @dev Field 31: the named-pick fee, 100, 500 or 2,500 bps (2,500 by default); zero for TOKEN_ONLY. The vault reads
    /// it as a clone argument (ADR-0017 § 5).
    /// @dev Encoders/readers use pickFeeBps as data; no funds move.
    uint16 pickFeeBps;
}

/// @notice The only graduated layout offered; earlier wire ids stay reserved. Internal readers move no funds.
enum GradLayout { NONE, RESERVED_1, RESERVED_2, FULL_RANGE }

/// @notice A manual price-coin row for validation; factory snapshots its raise in each new box, no money moves.
struct Listing {
    /// @notice Anyone reads permanent id; no money moves.
    uint32 id;
    /// @notice Anyone reads price coin; zero is native ETH, no money moves.
    address token;
    /// @notice Anyone reads decimals at admission; no money moves.
    uint8 decimals;
    /// @notice Anyone reads manual class; no money moves.
    uint8 class;
    /// @notice Anyone reads listed/box-token kind; no money moves.
    uint8 kind;
    /// @notice Factory snapshots current manual raise; existing boxes never reread this, no money moves.
    uint256 raise;
}

/// @notice Validator's one-row context; the M1 menu is fixed, no routes, targets, caps or plug-ins.
struct ReleaseContext {
    /// @notice Factory/twin provide the pricing row; no money moves.
    Listing listing;
}

/// @notice Optional v2.1 PILE tuple. Creators fix the asset, seed and 0/500 bps preset; no funds move here.
struct PileParamsV21 {
    /// @notice Creator names the listed asset; pile fees require the same asset as P.
    address asset;
    /// @notice Creator commits raw seed units, separately funded after creation; zero is valid.
    uint256 seedAmount;
    /// @notice Creator fixes 0 or 500 basis points; the last T redeemer always empties the balance.
    uint16 leaveBehindBps;
}

/// @notice Legacy 64-byte PILE tuple; zero leave-behind. Creators encode it without moving funds.
/// @dev Creator is the immutable seeder; nonzero seed uses roles 3 and 19, zero seed has no loader.
struct PileParams {
    /// @notice Encoders/readers name the listed seed asset; zero means native ETH. No transfer by this field.
    address asset;
    /// @notice Encoders/readers name the exact creator-funded seed in raw asset units; zero is valid. No transfer here.
    uint256 seedAmount;
}
