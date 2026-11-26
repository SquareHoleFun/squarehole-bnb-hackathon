// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FeeActionV21, IPoolManager, ReceiverViews, A, PricingToken, CheckedBurn, IBoxReceiverV2} from "./FeeActionV21.sol";

/// @notice Release-wide PileFeeModuleV21 action. Stateless, no administration, no upgrades or per-box deployments.
contract PileFeeModuleV21 is FeeActionV21 {
    /// @notice Release deployer fixes the PoolManager and arithmetic views; accepts no funds.
    constructor(IPoolManager pm, ReceiverViews views) FeeActionV21(pm, views) {}
    /// @notice PoolManager only through an authenticated receiver callback under its lock and armed action.
    /// Exact checks and any refusal occur within the original PM unlock and its named allowance.
    function unlockCallback(bytes calldata data) external onlyCallback returns (bytes memory) {
        (, address asset, address to, uint256 amount) = abi.decode(data, (uint256, address, address, uint256));
        uint256 beforeManager = PricingToken.balanceOf(asset, address(_pm));
        _payClaims(asset, to, amount);
        require(PricingToken.balanceOf(asset, address(_pm)) == beforeManager - amount, "ReceiverInexactDebit");
        return "";
    }
}
