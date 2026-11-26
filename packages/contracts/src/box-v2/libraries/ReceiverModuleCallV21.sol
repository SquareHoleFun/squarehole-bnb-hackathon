// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IFeeActionV21} from "../interfaces/IFeeModulesV21.sol";
import {BoxReceiverV2Args as A} from "./BoxReceiverV2Args.sol";

/// @notice Fixed core action boundary for future modules. CALL grants only this attempt's chosen P budget.
library ReceiverModuleCallV21 {
    /// @notice Internal receiver callback only after consuming its armed action; never callable as a module.
    function execute(IPoolManager pm, uint256 action, uint256 amount) external {
        uint256 offset = action == 12 ? 287 : 339;
        address module = A.addressAt(offset);
        require(module.codehash == bytes32(A.uintAt(offset + 20, 32)), "ReceiverModuleChanged");
        uint256 id = uint160(A.addressAt(A.P));
        uint256 beforeReceiver = pm.balanceOf(address(this), id);
        uint256 beforeModule = pm.balanceOf(module, id);
        require(pm.transfer(module, id, amount), "ClaimsTransferFailed");
        IFeeActionV21(module).execute(address(pm), address(uint160(id)), amount);
        require(pm.balanceOf(address(this), id) == beforeReceiver - amount
            && pm.balanceOf(module, id) == beforeModule, "ReceiverModuleUnspent");
    }
}
