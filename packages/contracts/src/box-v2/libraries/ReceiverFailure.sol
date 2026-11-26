// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice CQ11-B replaces the old closing/recipe path; no legacy money logic remains enabled.
library ReceiverFailure {
    /// @notice Internal callers must wait for CQ11-B; no money moves.
    error NotBuilt();
}
