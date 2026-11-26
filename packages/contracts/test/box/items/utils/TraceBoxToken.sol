// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxTokenBase} from "../../../../src/box/BoxToken.sol";

/// @notice TEST ONLY. The production T code (`BoxTokenBase`) with a chosen one-time issuance, so the vault traces replay
/// their own supplies (test/v2/utils/TraceFitToken.sol's twin). The deployed token is `BoxToken` (1e27 raw).
contract TraceBoxToken is BoxTokenBase {
    constructor(uint256 issuance, address recipient, address vault_)
        BoxTokenBase(issuance, "Trace T", "TRACE", recipient, vault_)
    {}
}
