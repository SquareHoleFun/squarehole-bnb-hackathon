// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Legacy refusal declaration; holder and every-item booking are implemented by BoxReceiverV2.
abstract contract BoxReceiverV2M2Stubs {
    /// @notice Any attempted later-milestone operation refuses; no money moves.
    error NOT_OFFERED();
}
