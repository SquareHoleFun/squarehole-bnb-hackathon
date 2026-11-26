// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// GENERATED FILE, do not edit: packages/box-spec/scripts/generate-v2.mjs writes it from packages/box-spec/box-spec.v2.json
// and packages/box-spec/add-ons.v2.json; `node packages/box-spec/scripts/generate-v2.mjs --check` fails when stale.

import {BoxSpec, ReleaseContext, BoxType, GradLayout} from "./interfaces/SpecTypes.sol";
import {Branch, Side, FeeChoice, Leg, Dest, Split, FeeSide, HoldersCurrency, ItemsInsidePolicy} from "./interfaces/RecipeTypes.sol";

/// @title BoxSpecV2
/// @notice BoxSpec format 2 (box-spec-v2-draft.md § 2-7): its fixed values, `validate()` and `specHash()` over the types
/// ticket M1-00 froze (SpecTypes.sol, RecipeTypes.sol), which this library imports and never redefines. The TypeScript
/// twin is packages/box-spec/src/generated/box-spec.v2.ts; both come from the same checks (scripts/lib/checks-v2.mjs).
/// @dev Every enum is a uint8 on the wire (0 is never a member). `validate()` returns the first failing (reason, field):
/// fields in id order (a recipe field checks its members, the release context`s offers and its canonical params),
/// including add-ons at field 29, then the rules and opaque shop contents. Recipe sub-fields are the field id x 1000 + the offset (buyers 17001-17022).
library BoxSpecV2 {
    // ------------------------------------------------------------------------------- fixed values
    /// @dev False for the real M1-10 source. Kept as the release boundary marker; the
    /// validator (M1-32-a) and the release runs (M1-61, M1-64) must assert it is false before any deploy.
    bool internal constant SOURCE_IS_STUB = false;
    /// @dev box-spec-v2-draft.md § 2, field 0
    uint16 internal constant SPEC_FORMAT_VERSION = 2;
    /// @dev box-spec-v2-draft.md § 1-2, field 1: core v2 is the box protocol's version 2
    uint16 internal constant CORE_VERSION = 2;
    /// @dev format 1's (plan § 1); V IBoxTokenV2.sol BoxTokenV2Args.MAX_NAME_BYTES (T's clone argument is a bytes32)
    uint256 internal constant MAX_TOKEN_NAME_BYTES = 32;
    /// @dev format 1's; V IBoxTokenV2.sol BoxTokenV2Args.MAX_SYMBOL_BYTES (a bytes11)
    uint256 internal constant MAX_SYMBOL_BYTES = 11;
    /// @dev format 1's (plan § 1); ADR-0017 § 6 caps table: unchanged
    uint256 internal constant MAX_TEXT_BYTES = 1024;
    /// @dev format 1's (BC-008)
    uint32 internal constant MIN_N = 10;
    /// @dev format 1's (BC-008)
    uint32 internal constant MAX_N = 10_000;
    /// @dev format 1's (V MisfitsGenesis.sol:172); box-spec-v2-draft.md § 2 fields 8, 9: as format 1
    uint256 internal constant FIRST_ID = 1;
    /// @dev format 1's (F80): 2026-09-01 00:00:00 UTC; a non-zero openAt below it is a unit mistake
    uint32 internal constant MIN_OPEN_AT = 1_788_220_800;
    /// @dev ADR-0017 § 6 caps table: 24,575 as v1 (BoxSpecV1.MAX_METADATA_TABLE_BYTES), loaded after creation in chunks against its hash (F96 R20C); M1-60 measures the heaviest spec and sets it
    uint256 internal constant TABLE_MAX = 24_575;
    /// @dev this file's first value (M1-10-a): no document gives one; each chunk is kept as data code (0x00 + bytes, IBoxCoordinatorV2), so it is at most 24,575; 8,192 loads a TABLE_MAX table in 3 transactions (ADR-0017 § 8 defaults: 'a few transactions'). M1-60 sets it so each loading transaction fits the block budget; the coordinator's CHUNK_MAX() returns it
    uint256 internal constant CHUNK_MAX = 8192;
    /// @dev format 1's (V BoxMetadataTable.sol:22)
    uint256 internal constant MAX_TRAIT_TYPES = 16;
    /// @dev format 1's; ADR-0017 § 6 caps table: 8
    uint256 internal constant MAX_ADD_ONS = 8;
    /// @dev V ReleaseConstantsV2.NATIVE_LISTING_ID: listing 0 is native ETH, token address(0)
    uint32 internal constant NATIVE_LISTING_ID = 0;
    /// @dev V BoxSpecV1.PICK_FEE_BPS (F23 C3): field 31's default (ADR-0017 § 5)
    uint16 internal constant PICK_FEE_BPS_DEFAULT = 2500;

    // ------------------------------------------------------------------------------ enums (uint8)
    uint8 internal constant BOX_TYPE_NEW_COLLECTION = uint8(BoxType.NEW_COLLECTION);
    uint8 internal constant BOX_TYPE_EXISTING = uint8(BoxType.EXISTING);
    uint8 internal constant BOX_TYPE_TOKEN_ONLY = uint8(BoxType.TOKEN_ONLY);
    uint8 internal constant BOX_TYPE_SHOP = uint8(BoxType.SHOP);
    uint8 internal constant BOX_TYPE_PILE = uint8(BoxType.PILE);
    uint8 internal constant GRAD_LAYOUT_RESERVED_1 = uint8(GradLayout.RESERVED_1);
    uint8 internal constant GRAD_LAYOUT_RESERVED_2 = uint8(GradLayout.RESERVED_2);
    uint8 internal constant GRAD_LAYOUT_FULL_RANGE = uint8(GradLayout.FULL_RANGE);
    uint8 internal constant FEE_CHOICE_KEEP = uint8(FeeChoice.Keep);
    uint8 internal constant FEE_CHOICE_BURN = uint8(FeeChoice.Burn);
    uint8 internal constant FEE_CHOICE_GROW = uint8(FeeChoice.Grow);
    uint8 internal constant FEE_CHOICE_HOLDERS = uint8(FeeChoice.Holders);
    uint8 internal constant FEE_CHOICE_ITEMS = uint8(FeeChoice.Items);
    uint8 internal constant FEE_CHOICE_EAT_PRICE_COIN = uint8(FeeChoice.EatPriceCoin);
    uint8 internal constant FEE_CHOICE_HOLDERS_T = uint8(FeeChoice.HoldersT);
    uint8 internal constant FEE_CHOICE_ITEMS_T = uint8(FeeChoice.ItemsT);
    uint8 internal constant FEE_CHOICE_PILE = uint8(FeeChoice.Pile);
    uint8 internal constant FEE_CHOICE_MODULE = uint8(FeeChoice.Module);
    uint8 internal constant FEE_CHOICE_SHOP_T = uint8(FeeChoice.ShopT);
    uint8 internal constant LEG_AS_PAID = uint8(Leg.AsPaid);
    uint8 internal constant LEG_BUY_T = uint8(Leg.BuyT);
    uint8 internal constant LEG_RESERVED_3 = uint8(Leg.RESERVED_3);
    uint8 internal constant LEG_RESERVED_4 = uint8(Leg.RESERVED_4);
    uint8 internal constant LEG_RESERVED_5 = uint8(Leg.RESERVED_5);
    uint8 internal constant DEST_EAT = uint8(Dest.Eat);
    uint8 internal constant DEST_CREATOR = uint8(Dest.Creator);
    uint8 internal constant DEST_RESERVED_3 = uint8(Dest.RESERVED_3);
    uint8 internal constant DEST_DEPTH = uint8(Dest.Depth);
    uint8 internal constant DEST_RESERVED_5 = uint8(Dest.RESERVED_5);
    uint8 internal constant DEST_HOLDERS = uint8(Dest.Holders);
    uint8 internal constant DEST_BUDGET_OR_PILE = uint8(Dest.BudgetOrPile);
    uint8 internal constant DEST_ITEMS = uint8(Dest.Items);
    uint8 internal constant DEST_MODULE = uint8(Dest.Module);
    uint8 internal constant SPLIT_NO_SPLIT = uint8(Split.NoSplit);
    uint8 internal constant SPLIT_RESERVED_2 = uint8(Split.RESERVED_2);
    uint8 internal constant SPLIT_RESERVED_3 = uint8(Split.RESERVED_3);
    uint8 internal constant SPLIT_RESERVED_4 = uint8(Split.RESERVED_4);
    uint8 internal constant FEE_SIDE_BUYERS = uint8(FeeSide.Buyers);
    uint8 internal constant FEE_SIDE_SELLERS = uint8(FeeSide.Sellers);
    uint8 internal constant HOLDERS_CURRENCY_P = uint8(HoldersCurrency.P);
    uint8 internal constant HOLDERS_CURRENCY_T = uint8(HoldersCurrency.T);
    uint8 internal constant ITEMS_INSIDE_POLICY_KEEP = uint8(ItemsInsidePolicy.Keep);
    uint8 internal constant ITEMS_INSIDE_POLICY_BUY_BACK_BURN = uint8(ItemsInsidePolicy.BuyBackBurn);
    uint8 internal constant ITEMS_INSIDE_POLICY_DEPTH = uint8(ItemsInsidePolicy.Depth);
    uint8 internal constant LAYOUT_CURVE_V1 = 1;
    uint8 internal constant LAUNCH_FORMAT_CURVE = 1;
    uint8 internal constant ART_MODE_OPEN = 1;
    uint8 internal constant ART_MODE_HIDDEN = 2;
    uint8 internal constant ROYALTY_DESTINATION_FEE_HANDLING = 1;
    uint8 internal constant ROYALTY_DESTINATION_CREATOR = 2;
    uint8 internal constant ROYALTY_DESTINATION_POOL_DEPTH = 3;

    // ------------------------------------------------------------------------------- string rules
    uint8 internal constant RULE_JSON_TEXT = 1;
    uint8 internal constant RULE_SVG = 2;
    uint8 internal constant RULE_URL = 3;

    // ------------------------------------------------------------------------------------ reasons
    uint16 internal constant REASON_OK = 0;
    uint16 internal constant REASON_UNSUPPORTED_VERSION = 1;
    uint16 internal constant REASON_NOT_A_MEMBER = 2;
    uint16 internal constant REASON_NOT_OFFERED = 3;
    uint16 internal constant REASON_OUT_OF_RANGE = 4;
    uint16 internal constant REASON_LENGTH_OUT_OF_RANGE = 5;
    uint16 internal constant REASON_BAD_CHARACTER = 6;
    uint16 internal constant REASON_ZERO_VALUE = 7;
    uint16 internal constant REASON_MUST_BE_ZERO = 8;
    uint16 internal constant REASON_Q_NOT_LISTED = 9;
    uint16 internal constant REASON_RAISE_NOT_A_PRESET = 10;
    uint16 internal constant REASON_MENU_RULE = 11;
    uint16 internal constant REASON_DEADLINE_RULE = 12;
    uint16 internal constant REASON_TOO_MANY_ADD_ONS = 13;
    uint16 internal constant REASON_ADD_ON_ORDER = 14;
    uint16 internal constant REASON_ADD_ON_UNKNOWN = 15;
    uint16 internal constant REASON_ADD_ON_NOT_AVAILABLE = 16;
    uint16 internal constant REASON_ADD_ON_PARAMS_MALFORMED = 17;
    uint16 internal constant REASON_ADD_ON_REQUIRED = 18;
    uint16 internal constant REASON_ADD_ON_CONFLICT = 19;
    uint16 internal constant REASON_METADATA_TABLE_MALFORMED = 20;
    uint16 internal constant REASON_LISTING_UNKNOWN = 21;
    uint16 internal constant REASON_LISTING_MISMATCH = 22;
    uint16 internal constant REASON_RECIPE_RULE = 23;
    uint16 internal constant REASON_SPLIT_RULE = 24;
    uint16 internal constant REASON_PLUG_IN_MALFORMED = 25;
    uint16 internal constant REASON_GAS_BUDGET = 26;

    // ---------------------------------------------------------------------------------- field ids
    uint16 internal constant FIELD_FORMAT = 0;
    uint16 internal constant FIELD_VERSION = 1;
    uint16 internal constant FIELD_BOX_TYPE = 2;
    uint16 internal constant FIELD_TOKEN_NAME = 3;
    uint16 internal constant FIELD_TOKEN_SYMBOL = 4;
    uint16 internal constant FIELD_COLLECTION_NAME = 5;
    uint16 internal constant FIELD_COLLECTION_SYMBOL = 6;
    uint16 internal constant FIELD_DESCRIPTION = 7;
    uint16 internal constant FIELD_N = 8;
    uint16 internal constant FIELD_FIRST_ID = 9;
    uint16 internal constant FIELD_PRICING = 10;
    uint16 internal constant FIELD_RAISE = 11;
    uint16 internal constant FIELD_LAYOUT = 12;
    uint16 internal constant FIELD_GRAD_LAYOUT = 13;
    uint16 internal constant FIELD_LAUNCH_FORMAT = 14;
    uint16 internal constant FIELD_OPEN_AT = 15;
    uint16 internal constant FIELD_DEADLINE_DAYS = 16;
    uint16 internal constant FIELD_BUYERS = 17;
    uint16 internal constant FIELD_SELLERS = 18;
    uint16 internal constant FIELD_ART_MODE = 19;
    uint16 internal constant FIELD_REVEAL_ROOT = 20;
    uint16 internal constant FIELD_METADATA_TABLE = 21;
    uint16 internal constant FIELD_GENERATOR_HASH = 22;
    uint16 internal constant FIELD_COVER_SHA256 = 23;
    uint16 internal constant FIELD_REVEAL_LIST_ID = 24;
    uint16 internal constant FIELD_MARKETPLACE_OWNER = 25;
    uint16 internal constant FIELD_CREATOR_FEE_RECIPIENT = 26;
    uint16 internal constant FIELD_CREATOR_BUY = 27;
    uint16 internal constant FIELD_COLLECTION_COVER_SHA256 = 28;
    uint16 internal constant FIELD_ADD_ONS = 29;
    uint16 internal constant FIELD_CONTENTS_PARAMS = 30;
    uint16 internal constant FIELD_PICK_FEE_BPS = 31;
    uint16 internal constant FIELD_BUYERS_A_LEG = 17_001;
    uint16 internal constant FIELD_BUYERS_A_DEST = 17_002;
    uint16 internal constant FIELD_BUYERS_A_LEG_PARAMS = 17_003;
    uint16 internal constant FIELD_BUYERS_A_DEST_PARAMS = 17_004;
    uint16 internal constant FIELD_BUYERS_B_LEG = 17_011;
    uint16 internal constant FIELD_BUYERS_B_DEST = 17_012;
    uint16 internal constant FIELD_BUYERS_B_LEG_PARAMS = 17_013;
    uint16 internal constant FIELD_BUYERS_B_DEST_PARAMS = 17_014;
    uint16 internal constant FIELD_BUYERS_SPLIT = 17_021;
    uint16 internal constant FIELD_BUYERS_SPLIT_PARAMS = 17_022;
    uint16 internal constant FIELD_SELLERS_A_LEG = 18_001;
    uint16 internal constant FIELD_SELLERS_A_DEST = 18_002;
    uint16 internal constant FIELD_SELLERS_A_LEG_PARAMS = 18_003;
    uint16 internal constant FIELD_SELLERS_A_DEST_PARAMS = 18_004;
    uint16 internal constant FIELD_SELLERS_B_LEG = 18_011;
    uint16 internal constant FIELD_SELLERS_B_DEST = 18_012;
    uint16 internal constant FIELD_SELLERS_B_LEG_PARAMS = 18_013;
    uint16 internal constant FIELD_SELLERS_B_DEST_PARAMS = 18_014;
    uint16 internal constant FIELD_SELLERS_SPLIT = 18_021;
    uint16 internal constant FIELD_SELLERS_SPLIT_PARAMS = 18_022;
    uint16 internal constant FIELD_ADD_ON_PLACEHOLDERS = 100;
    uint16 internal constant FIELD_ADD_ON_PLACEHOLDERS_PLACEHOLDER_NAME = 101;
    uint16 internal constant FIELD_ADD_ON_PLACEHOLDERS_PLACEHOLDER_SYMBOL = 102;
    uint16 internal constant FIELD_ADD_ON_PLACEHOLDERS_PLACEHOLDER_DESCRIPTION = 103;
    uint16 internal constant FIELD_ADD_ON_PLACEHOLDERS_HIDDEN_DESCRIPTION = 104;
    uint16 internal constant FIELD_ADD_ON_PLACEHOLDERS_HIDDEN_SVG = 105;
    uint16 internal constant FIELD_ADD_ON_EDITION_SPECIALS = 300;
    uint16 internal constant FIELD_ADD_ON_EDITION_SPECIALS_LABEL = 301;
    uint16 internal constant FIELD_ADD_ON_EDITION_SPECIALS_COUNT = 302;
    uint16 internal constant FIELD_ADD_ON_ROYALTIES = 400;
    uint16 internal constant FIELD_ADD_ON_ROYALTIES_BPS = 401;
    uint16 internal constant FIELD_ADD_ON_ROYALTIES_DESTINATION = 402;
    uint16 internal constant FIELD_ADD_ON_COLLECTION_METADATA = 600;
    uint16 internal constant FIELD_ADD_ON_COLLECTION_METADATA_BANNER_SHA256 = 601;
    uint16 internal constant FIELD_ADD_ON_COLLECTION_METADATA_TEASER_SHA256S = 602;
    uint16 internal constant FIELD_ADD_ON_COLLECTION_METADATA_EXTERNAL_LINK = 603;
    uint16 internal constant FIELD_ADD_ON_COLLECTION_LIST = 700;
    uint16 internal constant FIELD_ADD_ON_STARTER_SET = 800;
    uint16 internal constant FIELD_ADD_ON_STARTER_SET_SET_HASH = 801;
    uint16 internal constant FIELD_ADD_ON_STARTER_SET_COUNT = 802;
    uint16 internal constant FIELD_ADD_ON_HELD_ITEM_EARNINGS = 900;
    uint16 internal constant FIELD_ADD_ON_HUMBLE_CREATOR = 1000;
    uint16 internal constant FIELD_ADD_ON_HUMBLE_CREATOR_PRESET = 1001;

    // ------------------------------------------------------------------------------------ add-ons
    uint16 internal constant ADD_ON_PLACEHOLDERS = 1;
    uint16 internal constant ADD_ON_EDITION_SPECIALS = 3;
    uint16 internal constant ADD_ON_ROYALTIES = 4;
    uint16 internal constant ADD_ON_COLLECTION_METADATA = 6;
    uint16 internal constant ADD_ON_COLLECTION_LIST = 7;
    uint16 internal constant ADD_ON_STARTER_SET = 8;
    uint16 internal constant ADD_ON_HELD_ITEM_EARNINGS = 9;
    uint16 internal constant ADD_ON_HUMBLE_CREATOR = 10;

    // ---------------------------------------------------------------------------------------- API
    /// @notice keccak256 of the ABI encoding of the whole spec (the registry`s spec hash).
    function specHash(BoxSpec memory s) internal pure returns (bytes32) {
        return keccak256(abi.encode(s));
    }

    /// @notice (REASON_OK, 0) for a valid spec, else the first failing check`s reason and field id, under the release`s
    /// context (the factory supplies the current pricing listing; offers are fixed by this release).
    function validate(BoxSpec memory s, ReleaseContext memory ctx) internal pure returns (uint16 reason, uint16 field) {
        (reason, field) = _checkFields(s, ctx);
        if (reason != REASON_OK) return (reason, field);
        (reason, field) = _checkRules(s, ctx);
        if (reason != REASON_OK) return (reason, field);
        return _checkShop(s);
    }

    // ------------------------------------------------------------------------------------- fields
    function _checkFields(BoxSpec memory s, ReleaseContext memory ctx) private pure returns (uint16, uint16) {
        uint16 r;
        uint16 f;
        // 0 format
        if (!(s.format == 2)) return (REASON_UNSUPPORTED_VERSION, FIELD_FORMAT);
        // 1 version
        if (!(s.version == 2)) return (REASON_UNSUPPORTED_VERSION, FIELD_VERSION);
        // 2 boxType
        if (!(s.boxType >= BOX_TYPE_NEW_COLLECTION && s.boxType <= BOX_TYPE_PILE)) return (REASON_NOT_A_MEMBER, FIELD_BOX_TYPE);
        if (!(s.boxType == BOX_TYPE_NEW_COLLECTION || s.boxType == BOX_TYPE_TOKEN_ONLY || s.boxType == BOX_TYPE_SHOP || s.boxType == BOX_TYPE_PILE)) return (REASON_NOT_OFFERED, FIELD_BOX_TYPE);
        // 3 tokenName
        r = _checkString(bytes(s.tokenName), 1, MAX_TOKEN_NAME_BYTES, RULE_JSON_TEXT);
        if (r != REASON_OK) return (r, FIELD_TOKEN_NAME);
        // 4 tokenSymbol
        r = _checkString(bytes(s.tokenSymbol), 1, MAX_SYMBOL_BYTES, RULE_JSON_TEXT);
        if (r != REASON_OK) return (r, FIELD_TOKEN_SYMBOL);
        // 5 collectionName
        if ((s.boxType == BOX_TYPE_TOKEN_ONLY || s.boxType == BOX_TYPE_SHOP || s.boxType == BOX_TYPE_PILE)) {
            if (!(bytes(s.collectionName).length == 0)) return (REASON_MUST_BE_ZERO, FIELD_COLLECTION_NAME);
        } else {
            r = _checkString(bytes(s.collectionName), 1, MAX_TOKEN_NAME_BYTES, RULE_JSON_TEXT);
            if (r != REASON_OK) return (r, FIELD_COLLECTION_NAME);
        }
        // 6 collectionSymbol
        if ((s.boxType == BOX_TYPE_TOKEN_ONLY || s.boxType == BOX_TYPE_SHOP || s.boxType == BOX_TYPE_PILE)) {
            if (!(bytes(s.collectionSymbol).length == 0)) return (REASON_MUST_BE_ZERO, FIELD_COLLECTION_SYMBOL);
        } else {
            r = _checkString(bytes(s.collectionSymbol), 1, MAX_SYMBOL_BYTES, RULE_JSON_TEXT);
            if (r != REASON_OK) return (r, FIELD_COLLECTION_SYMBOL);
        }
        // 7 description
        r = _checkString(bytes(s.description), 0, MAX_TEXT_BYTES, RULE_JSON_TEXT);
        if (r != REASON_OK) return (r, FIELD_DESCRIPTION);
        // 8 n
        if ((s.boxType == BOX_TYPE_TOKEN_ONLY || s.boxType == BOX_TYPE_SHOP || s.boxType == BOX_TYPE_PILE)) {
            if (!(s.n == 0)) return (REASON_MUST_BE_ZERO, FIELD_N);
        } else {
            if ((s.n < MIN_N || s.n > MAX_N)) return (REASON_OUT_OF_RANGE, FIELD_N);
        }
        // 9 firstId
        if ((s.boxType == BOX_TYPE_TOKEN_ONLY || s.boxType == BOX_TYPE_SHOP || s.boxType == BOX_TYPE_PILE)) {
            if (!(s.firstId == 0)) return (REASON_MUST_BE_ZERO, FIELD_FIRST_ID);
        } else {
            if ((s.firstId < FIRST_ID || s.firstId > FIRST_ID)) return (REASON_OUT_OF_RANGE, FIELD_FIRST_ID);
        }
        // 10 pricing
        if (!_listingKnown(ctx, s.pricing.listingId)) return (REASON_LISTING_UNKNOWN, FIELD_PRICING);
        if (!_listingTokenIs(ctx, s.pricing.listingId, s.pricing.token)) return (REASON_LISTING_MISMATCH, FIELD_PRICING);
        // 11 raise
        if (!_raiseMatches(ctx, s.pricing.listingId, s.raise)) return (REASON_RAISE_NOT_A_PRESET, FIELD_RAISE);
        // 12 layout
        if (!(s.layout == LAYOUT_CURVE_V1)) return (REASON_NOT_A_MEMBER, FIELD_LAYOUT);
        // 13 gradLayout
        if (!(s.gradLayout >= GRAD_LAYOUT_RESERVED_1 && s.gradLayout <= GRAD_LAYOUT_FULL_RANGE)) return (REASON_NOT_A_MEMBER, FIELD_GRAD_LAYOUT);
        if (!(s.gradLayout == GRAD_LAYOUT_FULL_RANGE)) return (REASON_NOT_OFFERED, FIELD_GRAD_LAYOUT);
        // 14 launchFormat
        if (!(s.launchFormat == LAUNCH_FORMAT_CURVE)) return (REASON_NOT_A_MEMBER, FIELD_LAUNCH_FORMAT);
        // 15 openAt
        if ((!(s.openAt == 0) && s.openAt < MIN_OPEN_AT)) return (REASON_OUT_OF_RANGE, FIELD_OPEN_AT);
        // 16 deadlineDays
        if (!(s.deadlineDays == 30 || s.deadlineDays == 60 || s.deadlineDays == 90 || s.deadlineDays == 180)) return (REASON_DEADLINE_RULE, FIELD_DEADLINE_DAYS);
        // 17 buyers
        (r, f) = _checkSide(s.buyers, ctx, 17_000);
        if (r != REASON_OK) return (r, f);
        // 18 sellers
        (r, f) = _checkSide(s.sellers, ctx, 18_000);
        if (r != REASON_OK) return (r, f);
        // 19 artMode
        if ((s.boxType == BOX_TYPE_TOKEN_ONLY || s.boxType == BOX_TYPE_SHOP || s.boxType == BOX_TYPE_PILE)) {
            if (!(s.artMode == 0)) return (REASON_MUST_BE_ZERO, FIELD_ART_MODE);
        } else {
            if (!(s.artMode == ART_MODE_OPEN || s.artMode == ART_MODE_HIDDEN)) return (REASON_NOT_A_MEMBER, FIELD_ART_MODE);
        }
        // 20 revealRoot
        if ((s.boxType == BOX_TYPE_TOKEN_ONLY || s.boxType == BOX_TYPE_SHOP || s.boxType == BOX_TYPE_PILE)) {
            if (!(s.revealRoot == bytes32(0))) return (REASON_MUST_BE_ZERO, FIELD_REVEAL_ROOT);
        } else {
            if (s.revealRoot == bytes32(0)) return (REASON_ZERO_VALUE, FIELD_REVEAL_ROOT);
        }
        // 21 metadataTable
        if ((s.boxType == BOX_TYPE_TOKEN_ONLY || s.boxType == BOX_TYPE_SHOP || s.boxType == BOX_TYPE_PILE)) {
            if (!(s.metadataTable.length == 0)) return (REASON_MUST_BE_ZERO, FIELD_METADATA_TABLE);
        } else {
            if (s.metadataTable.length < 1 || s.metadataTable.length > TABLE_MAX) return (REASON_LENGTH_OUT_OF_RANGE, FIELD_METADATA_TABLE);
            if (!_tableV1(s.metadataTable)) return (REASON_METADATA_TABLE_MALFORMED, FIELD_METADATA_TABLE);
        }
        // 22 generatorHash
        if ((s.boxType == BOX_TYPE_TOKEN_ONLY || s.boxType == BOX_TYPE_SHOP || s.boxType == BOX_TYPE_PILE)) {
            if (!(s.generatorHash == bytes32(0))) return (REASON_MUST_BE_ZERO, FIELD_GENERATOR_HASH);
        }
        // 23 coverSha256
        if (s.coverSha256 == bytes32(0)) return (REASON_ZERO_VALUE, FIELD_COVER_SHA256);
        // 24 revealListId
        if ((s.boxType == BOX_TYPE_TOKEN_ONLY || s.boxType == BOX_TYPE_SHOP || s.boxType == BOX_TYPE_PILE)) {
            if (!(s.revealListId == bytes32(0))) return (REASON_MUST_BE_ZERO, FIELD_REVEAL_LIST_ID);
        }
        // 25 marketplaceOwner
        if ((s.boxType == BOX_TYPE_TOKEN_ONLY || s.boxType == BOX_TYPE_SHOP || s.boxType == BOX_TYPE_PILE)) {
            if (!(s.marketplaceOwner == address(0))) return (REASON_MUST_BE_ZERO, FIELD_MARKETPLACE_OWNER);
        } else {
            if (s.marketplaceOwner == address(0)) return (REASON_ZERO_VALUE, FIELD_MARKETPLACE_OWNER);
        }
        // 28 collectionCoverSha256
        if ((s.boxType == BOX_TYPE_TOKEN_ONLY || s.boxType == BOX_TYPE_SHOP || s.boxType == BOX_TYPE_PILE)) {
            if (!(s.collectionCoverSha256 == bytes32(0))) return (REASON_MUST_BE_ZERO, FIELD_COLLECTION_COVER_SHA256);
        } else {
            if (s.collectionCoverSha256 == bytes32(0)) return (REASON_ZERO_VALUE, FIELD_COLLECTION_COVER_SHA256);
        }
        // 29 addOns
        (r, f) = _checkAddOns(s, ctx);
        if (r != REASON_OK) return (r, f);
        // 30 contentsParams
        if (s.boxType == BOX_TYPE_SHOP) {
            if (s.contentsParams.length < 480 || s.contentsParams.length > 4576) return (REASON_LENGTH_OUT_OF_RANGE, FIELD_CONTENTS_PARAMS);
        } else if (s.boxType == BOX_TYPE_PILE) {
            if (!(_isCanonical(s.contentsParams, _kinds(hex"0806")) || (_isCanonical(s.contentsParams, _kinds(hex"080602")) && (_pw(s.contentsParams, 2) == 0 || _pw(s.contentsParams, 2) == 500)))) return (REASON_RECIPE_RULE, FIELD_CONTENTS_PARAMS);
            if (((s.buyers.a.dest == DEST_BUDGET_OR_PILE || s.sellers.a.dest == DEST_BUDGET_OR_PILE) && !(_addr(_pw(s.contentsParams, 0)) == s.pricing.token))) return (REASON_RECIPE_RULE, FIELD_CONTENTS_PARAMS);
        } else {
            if (!(s.contentsParams.length == 0)) return (REASON_MUST_BE_ZERO, FIELD_CONTENTS_PARAMS);
        }
        // 31 pickFeeBps
        if ((s.boxType == BOX_TYPE_TOKEN_ONLY || s.boxType == BOX_TYPE_SHOP || s.boxType == BOX_TYPE_PILE)) {
            if (!(s.pickFeeBps == 0)) return (REASON_MUST_BE_ZERO, FIELD_PICK_FEE_BPS);
        } else {
            if (!(s.pickFeeBps == 100 || s.pickFeeBps == 500 || s.pickFeeBps == 2500)) return (REASON_NOT_A_MEMBER, FIELD_PICK_FEE_BPS);
        }
        return (REASON_OK, 0);
    }

    // ------------------------------------------------------------------------------------ recipes
    function _checkSide(Side memory d, ReleaseContext memory ctx, uint16 base) private pure returns (uint16 r, uint16 f) {
        (r, f) = _checkBranch(d.a, ctx, base);
        if (r != REASON_OK) return (r, f);
        if (!(d.split >= SPLIT_NO_SPLIT && d.split <= SPLIT_RESERVED_4)) return (REASON_NOT_A_MEMBER, base + 21);
        if (!(d.splitParams.length == 0)) {
            return (REASON_MUST_BE_ZERO, base + 22);
        }
        if (d.split == SPLIT_NO_SPLIT) {
            if (!(d.b.leg == 0)) return (REASON_MUST_BE_ZERO, base + 11);
            if (!(d.b.dest == 0)) return (REASON_MUST_BE_ZERO, base + 12);
            if (!(d.b.legParams.length == 0)) return (REASON_MUST_BE_ZERO, base + 13);
            if (!(d.b.destParams.length == 0)) return (REASON_MUST_BE_ZERO, base + 14);
        } else {
            (r, f) = _checkBranch(d.b, ctx, base + 10);
            if (r != REASON_OK) return (r, f);
        }
        return (REASON_OK, 0);
    }

    function _checkBranch(Branch memory br, ReleaseContext memory ctx, uint16 base) private pure returns (uint16, uint16) {
        if (!(br.leg >= LEG_AS_PAID && br.leg <= LEG_RESERVED_5)) return (REASON_NOT_A_MEMBER, base + 1);
        if (!(br.leg == LEG_AS_PAID || br.leg == LEG_BUY_T)) return (REASON_NOT_OFFERED, base + 1);
        if (!(br.dest >= DEST_EAT && br.dest <= DEST_MODULE)) return (REASON_NOT_A_MEMBER, base + 2);
        if (!(br.dest == DEST_EAT || br.dest == DEST_CREATOR || br.dest == DEST_DEPTH || br.dest == DEST_HOLDERS || br.dest == DEST_BUDGET_OR_PILE || br.dest == DEST_ITEMS || br.dest == DEST_MODULE)) return (REASON_NOT_OFFERED, base + 2);
        if (!(br.legParams.length == 0)) {
            return (REASON_MUST_BE_ZERO, base + 3);
        }
        if (br.dest == DEST_HOLDERS) {
            if (!_isCanonical(br.destParams, _kinds(hex"01"))) return (REASON_RECIPE_RULE, base + 4);
            if (!((br.leg == LEG_AS_PAID && _pw(br.destParams, 0) == HOLDERS_CURRENCY_P) || (br.leg == LEG_BUY_T && _pw(br.destParams, 0) == HOLDERS_CURRENCY_T))) return (REASON_NOT_OFFERED, base + 4);
        } else if (br.dest == DEST_BUDGET_OR_PILE && br.leg == LEG_BUY_T) {
            if (!_isCanonical(br.destParams, _kinds(hex"01"))) return (REASON_RECIPE_RULE, base + 4);
            if (!(_pw(br.destParams, 0) == 2 || _pw(br.destParams, 0) == 4 || _pw(br.destParams, 0) == 8)) return (REASON_NOT_OFFERED, base + 4);
        } else if (br.dest == DEST_ITEMS) {
            if (!_isCanonical(br.destParams, _kinds(hex"01"))) return (REASON_RECIPE_RULE, base + 4);
            if (!(_pw(br.destParams, 0) == ITEMS_INSIDE_POLICY_KEEP || _pw(br.destParams, 0) == ITEMS_INSIDE_POLICY_BUY_BACK_BURN || _pw(br.destParams, 0) == ITEMS_INSIDE_POLICY_DEPTH)) return (REASON_NOT_OFFERED, base + 4);
        } else if (br.dest == DEST_MODULE) {
            if (!_isCanonical(br.destParams, _kinds(hex"03"))) return (REASON_MUST_BE_ZERO, base + 4);
        } else if (!(br.destParams.length == 0)) {
            return (REASON_MUST_BE_ZERO, base + 4);
        }
        return (REASON_OK, 0);
    }

    // ------------------------------------------------------------------------------------ add-ons
    function _checkAddOns(BoxSpec memory s, ReleaseContext memory ctx) private pure returns (uint16, uint16) {
        uint256 count = s.addOns.length;
        if (count > MAX_ADD_ONS) return (REASON_TOO_MANY_ADD_ONS, FIELD_ADD_ONS);
        for (uint256 i; i < count; ++i) {
            uint16 id = s.addOns[i].id;
            if (i != 0) {
                uint16 previous = s.addOns[i - 1].id;
                if (id < previous || (id == previous && !_repeatable(id))) return (REASON_ADD_ON_ORDER, FIELD_ADD_ONS);
            }
            (uint16 r, uint16 f) = _checkAddOn(s, ctx, id, s.addOns[i].params);
            if (r != REASON_OK) return (r, f);
        }
        return (REASON_OK, 0);
    }

    function _repeatable(uint16 id) private pure returns (bool) {
        return id == ADD_ON_EDITION_SPECIALS;
    }

    function _checkAddOn(BoxSpec memory s, ReleaseContext memory ctx, uint16 id, bytes memory p)
        private
        pure
        returns (uint16, uint16)
    {
        if (id == ADD_ON_PLACEHOLDERS) return _checkPlaceholders(s, ctx, p);
        if (id == ADD_ON_EDITION_SPECIALS) return _checkEditionSpecials(s, ctx, p);
        if (id == ADD_ON_ROYALTIES) return _checkRoyalties(s, ctx, p);
        if (id == ADD_ON_COLLECTION_METADATA) return _checkCollectionMetadata(s, ctx, p);
        if (id == ADD_ON_COLLECTION_LIST) return _checkCollectionList(s, ctx, p);
        if (id == ADD_ON_STARTER_SET) return _checkStarterSet(s, ctx, p);
        if (id == ADD_ON_HELD_ITEM_EARNINGS) return _checkHeldItemEarnings(s, ctx, p);
        if (id == ADD_ON_HUMBLE_CREATOR) return _checkHumbleCreator(s, ctx, p);
        return (REASON_ADD_ON_UNKNOWN, FIELD_ADD_ONS);
    }

    /// @dev Add-on 1 `placeholders`: Placeholders: tickets during the curve, hidden art revealed by draws.
    function _checkPlaceholders(BoxSpec memory s, ReleaseContext memory, bytes memory p)
        private
        pure
        returns (uint16, uint16)
    {
        if (!(s.boxType == BOX_TYPE_NEW_COLLECTION)) return (REASON_ADD_ON_CONFLICT, FIELD_ADD_ON_PLACEHOLDERS);
        (bool ok, uint256[] memory w) = _canonical(p, _kinds(hex"0a0a0a0a0a"));
        if (!ok) return (REASON_ADD_ON_PARAMS_MALFORMED, FIELD_ADD_ON_PLACEHOLDERS);
        uint16 r;
        r = _checkStringAt(p, w[0], 1, 32, RULE_JSON_TEXT);
        if (r != REASON_OK) return (r, FIELD_ADD_ON_PLACEHOLDERS_PLACEHOLDER_NAME);
        r = _checkStringAt(p, w[1], 1, 11, RULE_JSON_TEXT);
        if (r != REASON_OK) return (r, FIELD_ADD_ON_PLACEHOLDERS_PLACEHOLDER_SYMBOL);
        r = _checkStringAt(p, w[2], 0, 1024, RULE_JSON_TEXT);
        if (r != REASON_OK) return (r, FIELD_ADD_ON_PLACEHOLDERS_PLACEHOLDER_DESCRIPTION);
        r = _checkStringAt(p, w[3], 0, 1024, RULE_JSON_TEXT);
        if (r != REASON_OK) return (r, FIELD_ADD_ON_PLACEHOLDERS_HIDDEN_DESCRIPTION);
        r = _checkStringAt(p, w[4], 1, 4096, RULE_SVG);
        if (r != REASON_OK) return (r, FIELD_ADD_ON_PLACEHOLDERS_HIDDEN_SVG);
        if (!(s.artMode == ART_MODE_HIDDEN)) return (REASON_ADD_ON_CONFLICT, FIELD_ADD_ON_PLACEHOLDERS);
        return (REASON_OK, 0);
    }

    /// @dev Add-on 3 `edition-specials`: Edition specials: named series of special items, shown as counts.
    function _checkEditionSpecials(BoxSpec memory s, ReleaseContext memory, bytes memory p)
        private
        pure
        returns (uint16, uint16)
    {
        if (!(s.boxType == BOX_TYPE_NEW_COLLECTION)) return (REASON_ADD_ON_CONFLICT, FIELD_ADD_ON_EDITION_SPECIALS);
        (bool ok, uint256[] memory w) = _canonical(p, _kinds(hex"0a03"));
        if (!ok) return (REASON_ADD_ON_PARAMS_MALFORMED, FIELD_ADD_ON_EDITION_SPECIALS);
        uint16 r;
        r = _checkStringAt(p, w[0], 1, 32, RULE_JSON_TEXT);
        if (r != REASON_OK) return (r, FIELD_ADD_ON_EDITION_SPECIALS_LABEL);
        if ((w[1] < 1 || w[1] > uint256(s.n))) return (REASON_OUT_OF_RANGE, FIELD_ADD_ON_EDITION_SPECIALS_COUNT);
        return (REASON_OK, 0);
    }

    /// @dev Add-on 4 `royalties`: Royalties: voluntary ERC-2981 income for the box.
    function _checkRoyalties(BoxSpec memory s, ReleaseContext memory, bytes memory p)
        private
        pure
        returns (uint16, uint16)
    {
        if (!(s.boxType == BOX_TYPE_NEW_COLLECTION)) return (REASON_ADD_ON_CONFLICT, FIELD_ADD_ON_ROYALTIES);
        (bool ok, uint256[] memory w) = _canonical(p, _kinds(hex"0201"));
        if (!ok) return (REASON_ADD_ON_PARAMS_MALFORMED, FIELD_ADD_ON_ROYALTIES);
        if (!(w[0] == 0 || w[0] == 100 || w[0] == 250 || w[0] == 500)) return (REASON_NOT_A_MEMBER, FIELD_ADD_ON_ROYALTIES_BPS);
        if (!(w[1] == 1)) return (REASON_NOT_A_MEMBER, FIELD_ADD_ON_ROYALTIES_DESTINATION);
        return (REASON_OK, 0);
    }

    /// @dev Add-on 6 `collection-metadata`: Collection page: banner, teasers and link (contractURI, ERC-7572).
    function _checkCollectionMetadata(BoxSpec memory s, ReleaseContext memory, bytes memory p)
        private
        pure
        returns (uint16, uint16)
    {
        if (!(s.boxType == BOX_TYPE_NEW_COLLECTION)) return (REASON_ADD_ON_CONFLICT, FIELD_ADD_ON_COLLECTION_METADATA);
        (bool ok, uint256[] memory w) = _canonical(p, _kinds(hex"090b0a"));
        if (!ok) return (REASON_ADD_ON_PARAMS_MALFORMED, FIELD_ADD_ON_COLLECTION_METADATA);
        uint16 r;
        if (_word(p, w[1]) > 4) return (REASON_LENGTH_OUT_OF_RANGE, FIELD_ADD_ON_COLLECTION_METADATA_TEASER_SHA256S);
        if (!_nonZeroItems(p, w[1])) return (REASON_ZERO_VALUE, FIELD_ADD_ON_COLLECTION_METADATA_TEASER_SHA256S);
        r = _checkStringAt(p, w[2], 0, 128, RULE_URL);
        if (r != REASON_OK) return (r, FIELD_ADD_ON_COLLECTION_METADATA_EXTERNAL_LINK);
        return (REASON_OK, 0);
    }

    /// @dev Add-on 7 `collection-list`: Collection list: fixed tiers and an optional add-only curator.
    function _checkCollectionList(BoxSpec memory s, ReleaseContext memory, bytes memory p)
        private
        pure
        returns (uint16, uint16)
    {
        if (!(s.boxType == BOX_TYPE_SHOP)) return (REASON_ADD_ON_CONFLICT, FIELD_ADD_ON_COLLECTION_LIST);
        if (p.length != 0) return (REASON_ADD_ON_PARAMS_MALFORMED, FIELD_ADD_ON_COLLECTION_LIST);
        return (REASON_OK, 0);
    }

    /// @dev Add-on 8 `starter-set`: Starter set: committed NFTs and seed readiness before opening.
    function _checkStarterSet(BoxSpec memory s, ReleaseContext memory, bytes memory p)
        private
        pure
        returns (uint16, uint16)
    {
        if (!(s.boxType == BOX_TYPE_SHOP)) return (REASON_ADD_ON_CONFLICT, FIELD_ADD_ON_STARTER_SET);
        (bool ok, uint256[] memory w) = _canonical(p, _kinds(hex"0903"));
        if (!ok) return (REASON_ADD_ON_PARAMS_MALFORMED, FIELD_ADD_ON_STARTER_SET);
        if ((w[1] < 0 || w[1] > 10_000)) return (REASON_OUT_OF_RANGE, FIELD_ADD_ON_STARTER_SET_COUNT);
        if (!((w[1] == 0 && w[0] == 0) || (w[0] != 0 && w[1] != 0 && w[1] != 1 && w[1] != 2 && w[1] != 3 && w[1] != 4 && w[1] != 5 && w[1] != 6 && w[1] != 7 && w[1] != 8 && w[1] != 9))) return (REASON_ADD_ON_CONFLICT, FIELD_ADD_ON_STARTER_SET);
        return (REASON_OK, 0);
    }

    /// @dev Add-on 9 `held-item-earnings`: Earnings of held items: price-coin earnings feed this box.
    function _checkHeldItemEarnings(BoxSpec memory, ReleaseContext memory, bytes memory)
        private
        pure
        returns (uint16, uint16)
    {
        return (REASON_ADD_ON_NOT_AVAILABLE, FIELD_ADD_ON_HELD_ITEM_EARNINGS);
    }

    /// @dev Add-on 10 `humble-creator`: Humble creator: a cap on everything the creator takes, per 30 days.
    function _checkHumbleCreator(BoxSpec memory, ReleaseContext memory, bytes memory)
        private
        pure
        returns (uint16, uint16)
    {
        return (REASON_ADD_ON_NOT_AVAILABLE, FIELD_ADD_ON_HUMBLE_CREATOR);
    }

    // -------------------------------------------------------------------------------------- rules
    function _checkRules(BoxSpec memory s, ReleaseContext memory ctx) private pure returns (uint16, uint16) {
        uint16 r;
        uint16 f;
        // shop fees are sellers only on a shop; pile fees require a pile
        for (uint256 k; k < 2; ++k) {
            (r, f) = _branchRules1(k, s, ctx, s.buyers, s.buyers.a, true, 17_000);
            if (r != REASON_OK) return (r, f);
            if (!(s.buyers.split == SPLIT_NO_SPLIT)) {
                (r, f) = _branchRules1(k, s, ctx, s.buyers, s.buyers.b, true, 17_010);
                if (r != REASON_OK) return (r, f);
            }
            (r, f) = _branchRules1(k, s, ctx, s.sellers, s.sellers.a, false, 18_000);
            if (r != REASON_OK) return (r, f);
            if (!(s.sellers.split == SPLIT_NO_SPLIT)) {
                (r, f) = _branchRules1(k, s, ctx, s.sellers, s.sellers.b, false, 18_010);
                if (r != REASON_OK) return (r, f);
            }
        }
        // one whole choice per side
        (r, f) = _sideRules2(s, ctx, s.buyers, true, 17_000);
        if (r != REASON_OK) return (r, f);
        (r, f) = _sideRules2(s, ctx, s.sellers, false, 18_000);
        if (r != REASON_OK) return (r, f);
        // only menu combinations; items require the own new collection
        for (uint256 k; k < 2; ++k) {
            (r, f) = _branchRules3(k, s, ctx, s.buyers, s.buyers.a, true, 17_000);
            if (r != REASON_OK) return (r, f);
            if (!(s.buyers.split == SPLIT_NO_SPLIT)) {
                (r, f) = _branchRules3(k, s, ctx, s.buyers, s.buyers.b, true, 17_010);
                if (r != REASON_OK) return (r, f);
            }
            (r, f) = _branchRules3(k, s, ctx, s.sellers, s.sellers.a, false, 18_000);
            if (r != REASON_OK) return (r, f);
            if (!(s.sellers.split == SPLIT_NO_SPLIT)) {
                (r, f) = _branchRules3(k, s, ctx, s.sellers, s.sellers.b, false, 18_010);
                if (r != REASON_OK) return (r, f);
            }
        }
        // open art publishes its reveal list
        if ((s.artMode == ART_MODE_OPEN && (s.revealListId == bytes32(0)))) return (REASON_ZERO_VALUE, FIELD_REVEAL_LIST_ID);
        // hidden art keeps its reveal list private
        if ((s.artMode == ART_MODE_HIDDEN && !(s.revealListId == bytes32(0)))) return (REASON_MUST_BE_ZERO, FIELD_REVEAL_LIST_ID);
        // hidden art needs the placeholders add-on
        if ((s.artMode == ART_MODE_HIDDEN && !_hasAddOn(s, ADD_ON_PLACEHOLDERS))) return (REASON_ADD_ON_REQUIRED, FIELD_ART_MODE);
        // a creator payout names its recipient
        if (((s.buyers.a.dest == DEST_CREATOR || s.sellers.a.dest == DEST_CREATOR || _hasAddOn(s, ADD_ON_ROYALTIES)) && (s.creatorFeeRecipient == address(0)))) return (REASON_ZERO_VALUE, FIELD_CREATOR_FEE_RECIPIENT);
        // no fee recipient without a creator payout
        if ((!(s.buyers.a.dest == DEST_CREATOR || s.sellers.a.dest == DEST_CREATOR || _hasAddOn(s, ADD_ON_ROYALTIES)) && !(s.creatorFeeRecipient == address(0)))) return (REASON_MUST_BE_ZERO, FIELD_CREATOR_FEE_RECIPIENT);
        // a shop commits its collection list
        if ((s.boxType == BOX_TYPE_SHOP && !_hasAddOn(s, ADD_ON_COLLECTION_LIST))) return (REASON_ADD_ON_REQUIRED, FIELD_ADD_ONS);
        // the creator buy cannot fill the curve
        if ((!(s.creatorBuy == 0) && !(s.creatorBuy < s.raise))) return (REASON_OUT_OF_RANGE, FIELD_CREATOR_BUY);
        return (REASON_OK, 0);
    }

    /// @dev Rule `k` of a run of branch rules (rule-major: `_checkRules` loops k) on one branch (`buyers`: the buyers' side; `base`: its sub-field base).
    function _branchRules1(uint256 k, BoxSpec memory s, ReleaseContext memory, Side memory, Branch memory br, bool buyers, uint16 base)
        private
        pure
        returns (uint16, uint16)
    {
        // shop fees are sellers only on a shop
        if ((k == 0 && ((br.leg == LEG_BUY_T && br.dest == DEST_BUDGET_OR_PILE) && !(s.boxType == BOX_TYPE_SHOP && !buyers)))) return (REASON_NOT_OFFERED, base + 2);
        // pile fees require a pile
        if ((k == 1 && ((br.dest == DEST_BUDGET_OR_PILE && br.leg == LEG_AS_PAID) && !(s.boxType == BOX_TYPE_PILE)))) return (REASON_NOT_OFFERED, base + 2);
        return (REASON_OK, 0);
    }

    /// @dev A run of side rules, in source order, on one side (`buyers`: the buyers' side; `base`: its sub-field base).
    function _sideRules2(BoxSpec memory, ReleaseContext memory, Side memory d, bool, uint16 base)
        private
        pure
        returns (uint16, uint16)
    {
        // one whole choice per side
        if (!(d.split == SPLIT_NO_SPLIT)) return (REASON_SPLIT_RULE, base + 21);
        return (REASON_OK, 0);
    }

    /// @dev Rule `k` of a run of branch rules (rule-major: `_checkRules` loops k) on one branch (`buyers`: the buyers' side; `base`: its sub-field base).
    function _branchRules3(uint256 k, BoxSpec memory s, ReleaseContext memory, Side memory, Branch memory br, bool, uint16 base)
        private
        pure
        returns (uint16, uint16)
    {
        // only menu combinations
        if ((k == 0 && !((br.leg == LEG_AS_PAID && !(br.dest == DEST_RESERVED_3 || br.dest == DEST_RESERVED_5)) || (br.leg == LEG_BUY_T && (br.dest == DEST_EAT || br.dest == DEST_HOLDERS || br.dest == DEST_BUDGET_OR_PILE || br.dest == DEST_ITEMS))))) return (REASON_MENU_RULE, base + 1);
        // items require the own new collection
        if ((k == 1 && (br.dest == DEST_ITEMS && !(s.boxType == BOX_TYPE_NEW_COLLECTION)))) return (REASON_NOT_OFFERED, base + 2);
        return (REASON_OK, 0);
    }

    // -------------------------------------------------------- shop contents (frozen IShopVaultV2)
    function _checkShop(BoxSpec memory s) private pure returns (uint16, uint16) {
        if (s.boxType != BOX_TYPE_SHOP) return (REASON_OK, 0);
        bytes memory p = s.contentsParams;
        uint256 n = _pw(p, 13);
        if (_pw(p, 0) != 32 || _pw(p, 11) != 384 || n > 64) return (REASON_RECIPE_RULE, FIELD_CONTENTS_PARAMS);
        if (p.length != 480 + n * 64 || _pw(p, 12) != 416 + n * 32 || _pw(p, 14 + n) != n) return (REASON_RECIPE_RULE, FIELD_CONTENTS_PARAMS);
        if (_pw(p, 6) > 65_535) return (REASON_RECIPE_RULE, FIELD_CONTENTS_PARAMS);
        if (_pw(p, 7) > 65_535) return (REASON_RECIPE_RULE, FIELD_CONTENTS_PARAMS);
        if (_pw(p, 8) > 65_535) return (REASON_RECIPE_RULE, FIELD_CONTENTS_PARAMS);
        if (_pw(p, 9) > 4_294_967_295) return (REASON_RECIPE_RULE, FIELD_CONTENTS_PARAMS);
        if (_pw(p, 10) > 1_461_501_637_330_902_918_203_684_832_716_283_019_655_932_542_975) return (REASON_RECIPE_RULE, FIELD_CONTENTS_PARAMS);
        for (uint256 i = 0; i < n; ++i) {
            if (_pw(p, 14 + i) > 1_461_501_637_330_902_918_203_684_832_716_283_019_655_932_542_975 || _pw(p, 15 + n + i) > 255) return (REASON_RECIPE_RULE, FIELD_CONTENTS_PARAMS);
        }
        uint256 previous = 0;
        for (uint256 i = 2; i < 6; ++i) {
            uint256 price = _pw(p, i);
            if (price <= previous) return (REASON_OUT_OF_RANGE, FIELD_CONTENTS_PARAMS);
            previous = price;
        }
        if (_pw(p, 6) != 12_500 && _pw(p, 6) != 15_000 && _pw(p, 6) != 20_000 && _pw(p, 6) != 30_000) return (REASON_NOT_A_MEMBER, FIELD_CONTENTS_PARAMS);
        if (_pw(p, 7) != 500 && _pw(p, 7) != 1000) return (REASON_NOT_A_MEMBER, FIELD_CONTENTS_PARAMS);
        if (_pw(p, 8) != 100 && _pw(p, 8) != 250 && _pw(p, 8) != 500) return (REASON_NOT_A_MEMBER, FIELD_CONTENTS_PARAMS);
        if (_pw(p, 9) != 604_800 && _pw(p, 9) != 1_209_600 && _pw(p, 9) != 2_592_000) return (REASON_NOT_A_MEMBER, FIELD_CONTENTS_PARAMS);
        uint256 minInitialGiveT = previous;
        for (uint256 i = 0; i < n; ++i) {
            uint256 addressWord = _pw(p, 14 + i);
            if (addressWord == 0) return (REASON_ZERO_VALUE, FIELD_CONTENTS_PARAMS);
            if (_pw(p, 15 + n + i) > 3) return (REASON_OUT_OF_RANGE, FIELD_CONTENTS_PARAMS);
            uint256 giveT = _pw(p, 2 + _pw(p, 15 + n + i));
            if (giveT < minInitialGiveT) minInitialGiveT = giveT;
            for (uint256 j = 0; j < i; ++j) {
                if (_pw(p, 14 + j) == addressWord) return (REASON_RECIPE_RULE, FIELD_CONTENTS_PARAMS);
            }
        }
        if (_pw(p, 1) != 0 && !_hasAddOn(s, 8)) return (REASON_ADD_ON_REQUIRED, FIELD_CONTENTS_PARAMS);
        // F132: the allowance floor needs only two cheapest initially listed gives, even for an empty shop.
        // Division refuses an unrepresentable required seed without overflowing uint256.
        uint256 seed = _pw(p, 1);
        if (n == 0 || seed / 2 < minInitialGiveT) return (REASON_OUT_OF_RANGE, FIELD_CONTENTS_PARAMS);
        return (REASON_OK, 0);
    }

    // ------------------------------------------------------------------------------------------- helpers
    uint8 private constant _K_UINT8 = 1;
    uint8 private constant _K_UINT16 = 2;
    uint8 private constant _K_UINT32 = 3;
    uint8 private constant _K_UINT64 = 4;
    uint8 private constant _K_UINT128 = 5;
    uint8 private constant _K_UINT256 = 6;
    uint8 private constant _K_BOOL = 7;
    uint8 private constant _K_ADDRESS = 8;
    uint8 private constant _K_BYTES32 = 9;
    uint8 private constant _K_STRING = 10;
    uint8 private constant _K_BYTES32_ARRAY = 11;

    /// @dev Bytes rule JSON_TEXT allows: 0x20-0x21, 0x23-0x5b, 0x5d-0x7e.
    uint256 private constant _MASK_JSON_TEXT = 0x000000000000000000000000000000007fffffffeffffffffffffffb00000000;
    /// @dev Bytes rule SVG allows: 0x20-0x7e.
    uint256 private constant _MASK_SVG = 0x000000000000000000000000000000007fffffffffffffffffffffff00000000;
    /// @dev Bytes rule URL allows: 0x21, 0x23-0x3b, 0x3d, 0x3f-0x5b, 0x5d, 0x5f, 0x61-0x7a, 0x7e.
    uint256 private constant _MASK_URL = 0x0000000000000000000000000000000047fffffeafffffffaffffffa00000000;

    function _mask(uint8 rule) private pure returns (uint256) {
        if (rule == RULE_JSON_TEXT) return _MASK_JSON_TEXT;
        if (rule == RULE_SVG) return _MASK_SVG;
        if (rule == RULE_URL) return _MASK_URL;
        return 0;
    }

    function _needsPrefix(uint8 rule) private pure returns (bool) {
        return rule == RULE_URL;
    }

    /// @dev The prefix a non-empty string of the rule must start with (none: empty).
    function _prefix(uint8 rule) private pure returns (bytes memory) {
        if (rule == RULE_URL) return "https://";
        return "";
    }

    function _checkString(bytes memory b, uint256 minBytes, uint256 maxBytes, uint8 rule) private pure returns (uint16) {
        uint256 len = b.length;
        if (len < minBytes || len > maxBytes) return REASON_LENGTH_OUT_OF_RANGE;
        if (!_allBytesAllowed(b, 0, len, _mask(rule))) return REASON_BAD_CHARACTER;
        return _hasPrefix(b, 0, len, rule) ? REASON_OK : REASON_BAD_CHARACTER;
    }

    /// @dev A string inside canonical params: its length word at `offset`, its bytes right after.
    function _checkStringAt(bytes memory p, uint256 offset, uint256 minBytes, uint256 maxBytes, uint8 rule)
        private
        pure
        returns (uint16)
    {
        uint256 len = _word(p, offset);
        if (len < minBytes || len > maxBytes) return REASON_LENGTH_OUT_OF_RANGE;
        if (!_allBytesAllowed(p, offset + 32, len, _mask(rule))) return REASON_BAD_CHARACTER;
        return _hasPrefix(p, offset + 32, len, rule) ? REASON_OK : REASON_BAD_CHARACTER;
    }

    /// @dev True when the rule needs no prefix, the string is empty, or b[start, start + len) starts with the rule's
    /// prefix (the caller checked that the range lies inside `b`).
    function _hasPrefix(bytes memory b, uint256 start, uint256 len, uint8 rule) private pure returns (bool) {
        if (len == 0 || !_needsPrefix(rule)) return true;
        bytes memory prefix = _prefix(rule);
        if (len < prefix.length) return false;
        for (uint256 j; j < prefix.length; ++j) {
            if (b[start + j] != prefix[j]) return false;
        }
        return true;
    }

    /// @dev A canonical bytes32[] in params: its length word at `offset` (checked by `_canonical`), its items after.
    function _nonZeroItems(bytes memory p, uint256 offset) private pure returns (bool) {
        uint256 count = _word(p, offset);
        for (uint256 j; j < count; ++j) {
            if (_word(p, offset + 32 + 32 * j) == 0) return false;
        }
        return true;
    }

    /// @dev True when every byte of b[start, start + len) has its bit set in `mask`. The callers checked that the
    /// range lies inside `b` (a string's own length, or canonical params). Each byte is read as the low byte of the
    /// word ending at it, so every read stays inside `b`'s allocation (its length word and data).
    function _allBytesAllowed(bytes memory b, uint256 start, uint256 len, uint256 mask) private pure returns (bool ok) {
        ok = true;
        assembly ("memory-safe") {
            let p := add(add(b, 0x20), start)
            let end := add(p, len)
            for {} lt(p, end) { p := add(p, 1) } {
                if iszero(and(shr(and(mload(sub(p, 31)), 0xff), mask), 1)) {
                    ok := 0
                    break
                }
            }
        }
    }

    /// @dev Format v1 of the metadata table, BoxMetadataTable.validate's rules (core item 9): version byte 1, a uint16
    /// big-endian description length and the description, at most MAX_TRAIT_TYPES types, then per type a name of at
    /// least one byte, a value count of at least one and each value of at least one byte, every text JSON_TEXT, and
    /// nothing after the last value. Never reverts: every offset is compared with the table's length before a read.
    function _tableV1(bytes memory t) private pure returns (bool) {
        uint256 len = t.length;
        if (len < 3 || uint8(t[0]) != 1) return false;
        uint256 mask = _mask(RULE_JSON_TEXT);
        uint256 c = 3 + ((uint256(uint8(t[1])) << 8) | uint256(uint8(t[2])));
        if (c >= len || !_allBytesAllowed(t, 3, c - 3, mask)) return false;
        uint256 types = uint8(t[c++]);
        if (types > MAX_TRAIT_TYPES) return false;
        bool ok;
        for (uint256 i; i < types; ++i) {
            (ok, c) = _tableText(t, c, mask);
            if (!ok || c >= len) return false;
            uint256 values = uint8(t[c++]);
            if (values == 0) return false;
            for (uint256 v; v < values; ++v) {
                (ok, c) = _tableText(t, c, mask);
                if (!ok) return false;
            }
        }
        return c == len;
    }

    /// @dev One text of the table at `c`: a length byte of at least 1, then that many JSON_TEXT bytes inside `t`.
    /// Returns whether it holds and the offset after it.
    function _tableText(bytes memory t, uint256 c, uint256 mask) private pure returns (bool, uint256) {
        if (c >= t.length) return (false, c);
        uint256 n = uint8(t[c]);
        uint256 end = c + 1 + n;
        if (n == 0 || end > t.length || !_allBytesAllowed(t, c + 1, n, mask)) return (false, c);
        return (true, end);
    }

    /// @dev `ok` when `p` is exactly the canonical abi.encode of a tuple of `kinds` (strings and bytes32[] the only
    /// dynamic types): head words in order, each dynamic part's offset the next free position, zero padding, no
    /// trailing bytes, every static value inside its type. `w` holds the static values and, for a dynamic part, the
    /// offset of its length word. Never reverts: every length is compared with `p.length` before any arithmetic on it.
    /// Each early return leaves `ok` false.
    function _canonical(bytes memory p, uint8[] memory kinds) private pure returns (bool ok, uint256[] memory w) {
        uint256 k = kinds.length;
        w = new uint256[](k);
        uint256 size = p.length;
        uint256 cursor = k * 32;
        if (size < cursor) return (ok, w);
        for (uint256 i; i < k; ++i) {
            uint256 v = _word(p, i * 32);
            if (kinds[i] == _K_STRING) {
                if (v != cursor || size - cursor < 32) return (ok, w);
                uint256 len = _word(p, cursor);
                if (len > size) return (ok, w);
                uint256 padded = (len + 31) & ~uint256(31);
                if (size - cursor - 32 < padded) return (ok, w);
                uint256 end = cursor + 32 + padded;
                for (uint256 j = cursor + 32 + len; j < end; ++j) {
                    if (p[j] != 0) return (ok, w);
                }
                w[i] = cursor;
                cursor = end;
            } else if (kinds[i] == _K_BYTES32_ARRAY) {
                if (v != cursor || size - cursor < 32) return (ok, w);
                uint256 count = _word(p, cursor);
                if (count > (size - cursor - 32) / 32) return (ok, w);
                w[i] = cursor;
                cursor = cursor + 32 + 32 * count;
            } else {
                if (!_fits(kinds[i], v)) return (ok, w);
                w[i] = v;
            }
        }
        ok = cursor == size;
    }

    function _fits(uint8 kind, uint256 v) private pure returns (bool) {
        if (kind == _K_UINT256 || kind == _K_BYTES32) return true;
        if (kind == _K_BOOL) return v <= 1;
        if (kind == _K_ADDRESS) return v >> 160 == 0;
        // _K_UINT8 ... _K_UINT128: 8, 16, 32, 64 or 128 bits.
        return v >> (uint256(8) << (kind - 1)) == 0;
    }

    function _word(bytes memory p, uint256 offset) private pure returns (uint256 v) {
        assembly ("memory-safe") {
            v := mload(add(add(p, 0x20), offset))
        }
    }

    function _hasAddOn(BoxSpec memory s, uint16 id) private pure returns (bool) {
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id == id) return true;
        }
        return false;
    }

    /// @dev True when an entry of add-on `id` holds `value` in head word `index` of its params. Only rules call it, and
    /// rules run after every add-on passed its own checks, so each entry's params hold at least its head words.
    function _addOnWordIs(BoxSpec memory s, uint16 id, uint256 index, uint256 value) private pure returns (bool) {
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id == id && _word(s.addOns[i].params, 32 * index) == value) return true;
        }
        return false;
    }

    function _inList(uint8 v, uint8[] memory list) private pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == v) return true;
        }
        return false;
    }

    function _pw(bytes memory p, uint256 i) private pure returns (uint256) {
        return _word(p, 32 * i);
    }

    /// @dev The length of a dynamic member of canonical params: its offset is head word `i`, its length word is there.
    function _dynLen(bytes memory p, uint256 i) private pure returns (uint256) {
        return _word(p, _word(p, 32 * i));
    }

    /// @dev An address member of canonical params: `_canonical` checked that its word fits 160 bits.
    function _addr(uint256 w) private pure returns (address) {
        // casting to 'uint160' is safe because canonical params hold an address member in its low 160 bits
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(w));
    }

    /// @dev A params list's kinds from one byte each (`_K_*`), so a check carries them as one literal.
    function _kinds(bytes memory k) private pure returns (uint8[] memory kinds) {
        kinds = new uint8[](k.length);
        for (uint256 i; i < k.length; ++i) {
            kinds[i] = uint8(k[i]);
        }
    }

    function _isCanonical(bytes memory p, uint8[] memory kinds) private pure returns (bool ok) {
        (ok,) = _canonical(p, kinds);
    }

    function _in16(uint16 v, uint16[] memory list) private pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == v) return true;
        }
        return false;
    }

    /// @dev An empty context is not native listing zero: admitted rows have a nonzero kind.
    function _listingKnown(ReleaseContext memory ctx, uint256 id) private pure returns (bool) {
        return ctx.listing.kind != 0 && ctx.listing.id == id;
    }

    function _listingTokenIs(ReleaseContext memory ctx, uint256 id, address token) private pure returns (bool) {
        return _listingKnown(ctx, id) && ctx.listing.token == token;
    }

    function _raiseMatches(ReleaseContext memory ctx, uint256 id, uint256 raise) private pure returns (bool) {
        return _listingKnown(ctx, id) && raise == ctx.listing.raise;
    }

    function _sameBranch(Branch memory x, Branch memory y) private pure returns (bool) {
        return x.leg == y.leg && x.dest == y.dest && keccak256(x.legParams) == keccak256(y.legParams)
            && keccak256(x.destParams) == keccak256(y.destParams);
    }

    function _one(bool b) private pure returns (uint256 n) {
        if (b) n = 1;
    }
}
