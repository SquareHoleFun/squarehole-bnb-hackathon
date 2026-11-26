// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FitTokenBase} from "../../../src/v2/FitTokenBase.sol";

/// @notice TEST ONLY. The production FIT code (`FitTokenBase`) with a chosen one-time issuance, so the T06 traces can
/// replay their own supplies (1 raw unit per Misfit up to 2^256 − 1). The deployed token is `FitToken` (1e27 raw).
contract TraceFitToken is FitTokenBase {
    constructor(uint256 issuance, address recipient, address vault_) FitTokenBase(issuance, recipient, vault_) {}
}
