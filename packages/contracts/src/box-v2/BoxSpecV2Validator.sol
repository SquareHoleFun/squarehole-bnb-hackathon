// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpec, ReleaseContext} from "./interfaces/SpecTypes.sol";
import {BoxSpecV2} from "./BoxSpecV2.sol";

/// @notice What the planner calls: format 2's `validate()` under a release context (box-spec-v2-draft.md § 4, § 7).
interface IBoxSpecV2Validator {
    /// @notice Anyone may check a spec against a creation-time listing snapshot; no state or funds change.
    /// @return reason 0 for a valid spec, else the first failing check's reason (box-spec-v2-draft.md § 7)
    /// @return field the field id, or the recipe sub-field id (buyers 17001-17022, sellers 18001-18022)
    function validate(BoxSpec calldata spec, ReleaseContext calldata ctx)
        external
        pure
        returns (uint16 reason, uint16 field);
}

/// @title BoxSpecV2Validator
/// @notice The generated format 2 validator behind the planner's STATICCALL boundary. It holds no state and its
/// code hash is part of the factory's versionCodeHash (size-budget.v2.json). The generated twin owns all
/// structural, ItemsDestParams, PileParams and ShopConfigV2 checks, in the same order as TypeScript.
/// Pile asset listing and predicted-T checks belong to live admission, outside this pure one-listing context.
/// No funds or state change.
/// @dev Written for Square Hole (MIT).
contract BoxSpecV2Validator is IBoxSpecV2Validator {
    /// @inheritdoc IBoxSpecV2Validator
    function validate(BoxSpec calldata s, ReleaseContext calldata ctx) external pure returns (uint16, uint16) {
        return BoxSpecV2.validate(s, ctx);
    }
}
