// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice TEST ONLY. The part of Chainlink's `VRFCoordinatorV2_5` (mainnet 0xD7f8…893a, verified source) that the
/// source and the stand-in wrapper touch: `s_config()` with its nine fields (mainnet's values, read on chain
/// 2026-09-30) and its `reentrancyLock`, which the real coordinator sets only around a consumer's callback
/// (`_deliverRandomness`) and around `migrate`'s calls to consumers, and which makes every non-view coordinator
/// function, `requestRandomWords` included, revert `Reentrant()` (`SubscriptionAPI.nonReentrant`). `deliver` does what
/// `_deliverRandomness` does: the lock on, one call with exactly the gas given, the lock off, a failure only reported.
/// Only the lock is storage, so a copy etched at a real coordinator's address behaves the same.
contract MockVrfCoordinator {
    error Reentrant();

    bool public reentrancyLock;
    /// @dev 0 means the real value (3); set to model the owner raising the minimum above ours.
    uint16 public minimumRequestConfirmationsOverride;

    function s_config()
        external
        view
        returns (
            uint16 minimumRequestConfirmations,
            uint32 maxGasLimit,
            bool lock,
            uint32 stalenessSeconds,
            uint32 gasAfterPaymentCalculation,
            uint32 fulfillmentFlatFeeNativePPM,
            uint32 fulfillmentFlatFeeLinkDiscountPPM,
            uint8 nativePremiumPercentage,
            uint8 linkPremiumPercentage
        )
    {
        uint16 minimum = minimumRequestConfirmationsOverride == 0 ? 3 : minimumRequestConfirmationsOverride;
        return (minimum, 2_500_000, reentrancyLock, 172_800, 38_900, 0, 0, 24, 20);
    }

    function setLock(bool on) external {
        reentrancyLock = on;
    }

    function setMinimumRequestConfirmations(uint16 minimum) external {
        minimumRequestConfirmationsOverride = minimum;
    }

    /// @notice `requestRandomWords`' own checks that the stand-in wrapper forwards to: `nonReentrant` and the minimum
    /// confirmations.
    function checkRequest(uint16 requestConfirmations) external view {
        if (reentrancyLock) revert Reentrant();
        uint16 minimum = minimumRequestConfirmationsOverride == 0 ? 3 : minimumRequestConfirmationsOverride;
        require(requestConfirmations >= minimum, "InvalidRequestConfirmations");
    }

    /// @notice As `_deliverRandomness`: the lock on, `target` called with exactly `gasAmount`, the lock off.
    function deliver(address target, bytes calldata data, uint256 gasAmount) external returns (bool success) {
        reentrancyLock = true;
        (success,) = target.call{gas: gasAmount}(data);
        reentrancyLock = false;
    }
}
