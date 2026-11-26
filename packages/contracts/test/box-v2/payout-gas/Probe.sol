// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";

import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

/// Test-only entry around the inherited complete PAY callback; installed only after real creation.
/// No transfer, history, accounting or exactness code is replaced by this measurement control.
contract PayoutProbe is BoxReceiverV2 {
    constructor(IPoolManager pm, address c, address fit, address platform, address conversion)
        BoxReceiverV2(pm, c, fit, platform, ReceiverDeploy.code(pm)) {}

    function allowance() external pure returns (uint256) { return PAYOUT_GAS; }

    /// FIT owner only. Measurement-only recipient/cap selection, never a production entry.
    function measured(address to, uint256 cap) external locked returns (uint256 amount, uint256 used) {
        return _measured(to, cap, PAY);
    }

    /// FIT owner only. Fund the production TIP callback from this probe's existing claims for gas measurement.
    function measuredTip(address to, uint256 cap) external locked returns (uint256 amount, uint256 used) {
        return _measured(to, cap, TIP);
    }

    function _measured(address to, uint256 cap, uint256 action) private returns (uint256 amount, uint256 used) {
        require(msg.sender == _fitSafe, "owner only");
        _prepare();
        amount = _payoutBatch(_p[FIT]);
        _p[FIT] -= amount;
        uint256 beforeGas = gasleft();
        bool ok = _tryUnlock(action, _priceCoin(), to, amount, cap);
        used = beforeGas - gasleft();
        require(ok, "measured payout refused");
    }
}
