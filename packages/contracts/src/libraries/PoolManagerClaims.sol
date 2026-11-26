// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Uniswap v4-core @ 46c68346 (MIT files only: interfaces and types; see DEPENDENCIES.md).
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

/// @notice Custody of fee funds as Uniswap v4 ERC-6909 claims on the canonical PoolManager (ADR-0011 "Fee
/// realization"). A claim with id `uint256(uint160(asset))` is a fully backed PoolManager liability of one raw unit
/// of `asset`, redeemable 1:1 inside an unlock (burn the claim, take the ERC-20).
/// @dev Written for Square Hole; no third-party code beyond the imported MIT interfaces.
library PoolManagerClaims {
    error ClaimsDeltaMismatch(address asset, uint256 expected, uint256 received);

    /// @notice ERC-6909 id of `asset` on the PoolManager (`Currency.toId`).
    function claimId(address asset) internal pure returns (uint256) {
        return uint256(uint160(asset));
    }

    /// @notice This contract's claim balance of `asset`.
    function claimsOf(IPoolManager pm, address asset) internal view returns (uint256) {
        return pm.balanceOf(address(this), claimId(asset));
    }

    /// @notice Pulls exactly `amount` claims of `asset` from `from` (which granted this contract an exact
    /// allowance) and checks the balance delta of that pull, so unsolicited claims sent to this contract can
    /// neither satisfy nor block a receipt.
    function pullExact(IPoolManager pm, address from, address asset, uint256 amount) internal {
        uint256 id = claimId(asset);
        uint256 balanceBefore = pm.balanceOf(address(this), id);
        pm.transferFrom(from, address(this), id, amount);
        uint256 received = pm.balanceOf(address(this), id) - balanceBefore;
        if (received != amount) revert ClaimsDeltaMismatch(asset, amount, received);
    }

    /// @notice Inside this contract's own unlock callback: burns `amount` of its `asset` claims and sends the same
    /// amount of the ERC-20 from the PoolManager to `to`. The two deltas cancel, so the unlock settles.
    function redeem(IPoolManager pm, address asset, address to, uint256 amount) internal {
        pm.burn(address(this), claimId(asset), amount);
        pm.take(Currency.wrap(asset), to, amount);
    }
}
