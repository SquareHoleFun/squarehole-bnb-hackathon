// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// The public names of the v2 contracts: what wallets, explorers and marketplaces show (ERC-20 and ERC-721 `name` and
// `symbol`, the collection's `contractURI` and hidden `tokenURI` with their texts and pictures, the placeholder's
// `tokenURI`). Nothing else about the contracts depends on them. The sources import them through the remapping
// `sh-public-names/` (foundry.toml), which picks one of two sets at compile time:
//
// - `src/v2/names/launch/` (the default profile): FIT, The Misfits, the Misfit placeholder. Every test, the local
//   deployments and a mainnet deployment use this set.
// - `src/v2/names/neutral/` (`FOUNDRY_PROFILE=sepolia-neutral`): neutral names for a Sepolia rehearsal of the whole
//   system (F30 Q2: "different names and placeholders, so nothing is spoiled"; docs/v2/sepolia-full.md).
//
// Both files define the same constants. `PLACEHOLDERS_CREATION_CODE_HASH` follows from the names (the placeholder's
// name, symbol and token URI are part of its creation code), so each set carries its own; the genesis accepts only
// the placeholder code compiled with the same set. `test/v2/names/PublicNames.t.sol` checks each set against the
// compiled contracts, in its own profile.

/// @dev This is the launch set.
bool constant PUBLIC_NAMES_NEUTRAL = false;

/// @dev `FitToken` (`FitTokenBase.name`, `symbol`).
string constant FIT_NAME = "FIT";
string constant FIT_SYMBOL = "FIT";

/// @dev `MisfitsCollection.name`, `symbol`; its hidden token's description and picture; its `contractURI` description
/// and image (the image is the FIT icon, byte for byte the committed master `packages/design/art/fit/fit-icon.svg`).
string constant COLLECTION_NAME = "The Misfits";
string constant COLLECTION_SYMBOL = "MISFITS";
string constant COLLECTION_HIDDEN_DESCRIPTION =
    "This Misfit is not revealed yet. Its art was committed on chain before launch and appears here once revealed.";
/// @dev `MisfitsCollection.PLACEHOLDER_SVG`, a hidden item's picture (and the placeholder's): a lavender square in a
/// dark box, the brand's canvas and accent colours. It moved here from `MisfitsCollection.sol` unchanged (2026-10-01),
/// so the neutral set can carry its own (docs/evidence/SH-V2-sepolia-full.md A4).
string constant COLLECTION_HIDDEN_IMAGE_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><rect width=\"64\" height=\"64\" fill=\"#080d16\"/>"
    "<rect x=\"12\" y=\"22\" width=\"40\" height=\"30\" rx=\"4\" fill=\"#2a3350\"/>"
    "<rect x=\"25\" y=\"29\" width=\"14\" height=\"14\" rx=\"2\" fill=\"#a78bfa\"/></svg>";
string constant COLLECTION_DESCRIPTION = "4,200 Misfits from the Square Hole sorter box. Each Misfit starts inside the Misfits vault: locking FIT in the "
    "vault's escrow takes one out, and handing a Misfit back releases FIT from the escrow. Every Misfit's art was "
    "committed on chain before launch and appears once it is revealed.";
string constant COLLECTION_IMAGE_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" width=\"256\" height=\"256\" role=\"img\" aria-label=\"FIT token icon\">\n"
    "  <!-- Rim and hole lip, #6D4AE2: the whole disc with the square hole cut out (evenodd, the hole stays transparent). -->\n"
    "  <path fill=\"#6D4AE2\" fill-rule=\"evenodd\" d=\"M128 0a128 128 0 1 1 0 256a128 128 0 1 1 0-256ZM80 76h96a4 4 0 0 1 4 4v96a4 4 0 0 1-4 4H80a4 4 0 0 1-4-4V80a4 4 0 0 1 4-4Z\"/>\n"
    "  <!-- Face, #A78BFA: the disc inside the 20-unit rim, minus the hole and its 10-unit lip. -->\n"
    "  <path fill=\"#A78BFA\" fill-rule=\"evenodd\" d=\"M128 20a108 108 0 1 1 0 216a108 108 0 1 1 0-216ZM80 66h96a14 14 0 0 1 14 14v96a14 14 0 0 1-14 14H80a14 14 0 0 1-14-14V80a14 14 0 0 1 14-14Z\"/>\n"
    "</svg>\n";

/// @dev `PlaceholderToken.name`, `symbol` and the fixed `tokenURI` (base64 of the JSON with this name, the description
/// below and the collection's unrevealed picture `COLLECTION_HIDDEN_IMAGE_SVG`, byte for byte).
string constant PLACEHOLDER_NAME = "Misfit placeholder";
string constant PLACEHOLDER_SYMBOL = "MISFIT-P";
/// @dev The description inside `PLACEHOLDER_TOKEN_URI` (read by the tests only).
string constant PLACEHOLDER_DESCRIPTION = "Opens into one Misfit once its number is drawn at graduation.";
string constant PLACEHOLDER_TOKEN_URI = "data:application/json;base64,eyJuYW1lIjoiTWlzZml0IHBsYWNlaG9sZGVyIiwiZGVzY3JpcHRpb24iOiJPcGVucyBpbnR"
    "vIG9uZSBNaXNmaXQgb25jZSBpdHMgbnVtYmVyIGlzIGRyYXduIGF0IGdyYWR1YXRpb24uIiwiaW1hZ2UiOiJkYXRhOmltYWdlL3N"
    "2Zyt4bWw7YmFzZTY0LFBITjJaeUI0Yld4dWN6MGlhSFIwY0RvdkwzZDNkeTUzTXk1dmNtY3ZNakF3TUM5emRtY2lJSFpwWlhkQ2I"
    "zZzlJakFnTUNBMk5DQTJOQ0krUEhKbFkzUWdkMmxrZEdnOUlqWTBJaUJvWldsbmFIUTlJalkwSWlCbWFXeHNQU0lqTURnd1pERTJ"
    "JaTgrUEhKbFkzUWdlRDBpTVRJaUlIazlJakl5SWlCM2FXUjBhRDBpTkRBaUlHaGxhV2RvZEQwaU16QWlJSEo0UFNJMElpQm1hV3h"
    "zUFNJak1tRXpNelV3SWk4K1BISmxZM1FnZUQwaU1qVWlJSGs5SWpJNUlpQjNhV1IwYUQwaU1UUWlJR2hsYVdkb2REMGlNVFFpSUh"
    "KNFBTSXlJaUJtYVd4c1BTSWpZVGM0WW1aaElpOCtQQzl6ZG1jKyIsImF0dHJpYnV0ZXMiOlt7InRyYWl0X3R5cGUiOiJTdGF0dXM"
    "iLCJ2YWx1ZSI6IlBsYWNlaG9sZGVyIn1dfQ==";

/// @dev keccak256 of `type(MisfitsPlaceholders).creationCode` compiled with this set (see `PlaceholdersCode.sol`).
bytes32 constant PLACEHOLDERS_CREATION_CODE_HASH = 0x5dc369804558f57130ca601ee1a6b5984dc8f11d91ca80c92c2d7b478aaf615b;
