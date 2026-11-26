// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FeeActionV21, IPoolManager, ReceiverViews, A, PricingToken, CheckedBurn, IBoxReceiverV2} from "./FeeActionV21.sol";

/// @notice Release-wide EatPriceCoinFeeModuleV21 action. Stateless, no administration, no upgrades or per-box deployments.
contract EatPriceCoinFeeModuleV21 is FeeActionV21 {
    /// @notice Release deployer fixes the PoolManager and arithmetic views; accepts no funds.
    constructor(IPoolManager pm, ReceiverViews views) FeeActionV21(pm, views) {}
    /// @notice PoolManager only through an authenticated receiver callback under its lock and armed action.
    /// Exact checks and any refusal occur within the original PM unlock and its named allowance.
    function unlockCallback(bytes calldata data) external onlyCallback returns (bytes memory) {
        (, address asset,, uint256 amount) = abi.decode(data, (uint256, address, address, uint256));
        bytes4 selector = bytes4(uint32(A.uintAt(A.LENGTH, 4)));
        address recipient = selector == bytes4(0) ? address(0xdEaD) : address(this);
        uint256 managerBefore = PricingToken.balanceOf(asset, address(_pm));
        uint256 supplyBefore = selector == bytes4(0) ? 0 : CheckedBurn.totalSupply(asset);
        _payClaims(asset, recipient, amount);
        if (PricingToken.balanceOf(asset, address(_pm)) != managerBefore - amount) revert CheckedBurn.BurnRefused();
        if (selector != bytes4(0) && CheckedBurn.burn(asset, amount) != supplyBefore) revert CheckedBurn.BurnRefused();
        return "";
    }
}
