// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// SH-300 (BNB Chain testnet only): src/box-v2/BoxSpecV2Validator.sol for the second chain-97 release, calling the
// ten-minute copy of the spec library (BoxSpecV2ShortWait). The interface is the release's own (imported, unchanged).

import {BoxSpec, ReleaseContext} from "../../src/box-v2/interfaces/SpecTypes.sol";
import {IBoxSpecV2Validator} from "../../src/box-v2/BoxSpecV2Validator.sol";
import {BoxSpecV2ShortWait} from "./BoxSpecV2ShortWait.sol";

/// @title BoxSpecV2ValidatorShortWait
/// @notice The release's validator with one difference: a shop's list delay may also be ten minutes. No state or funds.
contract BoxSpecV2ValidatorShortWait is IBoxSpecV2Validator {
    /// @inheritdoc IBoxSpecV2Validator
    function validate(BoxSpec calldata s, ReleaseContext calldata ctx) external pure returns (uint16, uint16) {
        return BoxSpecV2ShortWait.validate(s, ctx);
    }
}
