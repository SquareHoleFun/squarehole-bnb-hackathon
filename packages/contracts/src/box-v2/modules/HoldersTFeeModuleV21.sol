// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FeeActionV21, IPoolManager, ReceiverViews, A, PricingToken, CheckedBurn, IBoxReceiverV2} from "./FeeActionV21.sol";

/// @notice Release-wide HoldersTFeeModuleV21 action. Stateless, no administration, no upgrades or per-box deployments.
contract HoldersTFeeModuleV21 is FeeActionV21 {
    /// @notice Release deployer fixes the PoolManager and arithmetic views; accepts no funds.
    constructor(IPoolManager pm, ReceiverViews views) FeeActionV21(pm, views) {}
    /// @notice PoolManager only through an authenticated receiver callback under its lock and armed action.
    /// Exact checks and any refusal occur within the original PM unlock and its named allowance.
    function unlockCallback(bytes calldata data) external onlyCallback returns (bytes memory) {
        (,,, uint256 amount) = abi.decode(data, (uint256, address, address, uint256));
        (uint256 spent, uint256 bought) = _buy(amount, true);
        return abi.encode(spent, bought);
    }
}
