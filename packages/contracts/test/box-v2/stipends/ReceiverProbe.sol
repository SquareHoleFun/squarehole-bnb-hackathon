// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";

import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

/// Measurement-only entry. All production unlock, history and exactness code is inherited.
contract ReceiverStipendProbe is BoxReceiverV2 {
    constructor(IPoolManager pm, address c, address fit, address platform, address conversion)
        BoxReceiverV2(pm, c, fit, platform, ReceiverDeploy.code(pm)) {}

    function caps() external pure returns (uint256 forward, uint256 burn) {
        return (0, RECEIVER_BURN_GAS);
    }

    /// Test driver only: measure the complete armed PM unlock with a selected allowance.
    function measure(bool burn, address asset, address to, uint256 amount, uint256 cap)
        external locked returns (uint256 used)
    {
        require(burn, "forward removed");
        uint256 start = gasleft();
        require(_tryUnlock(BURN, asset, to, amount, cap), "measured exit refused");
        used = start - gasleft();
    }
}
