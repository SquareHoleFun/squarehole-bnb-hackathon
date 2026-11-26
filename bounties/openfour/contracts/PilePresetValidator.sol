// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IOpenFourPresetValidator} from "openfour-kit/developer/startup/contracts/interfaces/IOpenFourPresetValidator.sol";
import {OpenFourTypes} from "openfour-kit/developer/startup/contracts/libraries/OpenFourTypes.sol";

/// @title PilePresetValidator
/// @notice The creation check of the "Pile Bonding" preset. The preset is OpenFour's standard bonding preset with
/// one slot replaced (Trade = `module.trade.pile`), so this validator first asks the standard bonding validator
/// (`inner`, fixed at deployment) about everything but the trade parameters, exactly as it would for a standard
/// bonding token, then checks the pile's own parameters: the fee rates decode, stay within `maxFeeBps`, and at least
/// one of them is above zero. No owner, no setter.
contract PilePresetValidator is IOpenFourPresetValidator {
    /// @notice The standard bonding preset's validator, or zero for none.
    address public immutable inner;
    /// @notice The highest fee rate per side this preset accepts.
    uint16 public immutable maxFeeBps;

    constructor(address inner_, uint16 maxFeeBps_) {
        require(maxFeeBps_ > 0 && maxFeeBps_ <= 1_000, "PileValidator: bad maxFeeBps");
        inner = inner_;
        maxFeeBps = maxFeeBps_;
    }

    function validate(uint256 presetId, OpenFourTypes.TokenInitParams calldata params) external view override {
        require(params.quoteAsset != address(0), "PileValidator: zero quoteAsset");
        (uint16 buyFeeBps, uint16 sellFeeBps) = abi.decode(params.tradeParams, (uint16, uint16));
        require(buyFeeBps <= maxFeeBps && sellFeeBps <= maxFeeBps, "PileValidator: fee too high");
        require(buyFeeBps != 0 || sellFeeBps != 0, "PileValidator: no fee");

        if (inner != address(0)) {
            // The standard bonding validator knows the standard trade slot, which takes no parameters.
            OpenFourTypes.TokenInitParams memory standard = params;
            standard.tradeParams = "";
            IOpenFourPresetValidator(inner).validate(presetId, standard);
        }
    }
}
