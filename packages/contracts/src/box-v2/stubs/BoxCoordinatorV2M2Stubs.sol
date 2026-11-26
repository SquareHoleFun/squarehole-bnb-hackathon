// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxCoordinatorV2} from "../interfaces/IBoxCoordinatorV2.sol";

/// @notice Authenticated starter completion entry, implemented by the coordinator's combined gate.
/// @dev StarterSetLoaderV2 validates the set and received seed. Completion state belongs to the coordinator;
/// this inherited entry retains its original path/name without introducing another gate state owner.
abstract contract BoxCoordinatorV2M2Stubs is IBoxCoordinatorV2 {

    /// @inheritdoc IBoxCoordinatorV2
    function starterSetLoaded() external virtual {
        address loader = starterSetLoader();
        if (loader == address(0)) revert NOT_OFFERED();
        if (msg.sender != loader) revert NotStarterSetLoader(msg.sender);
        _completeStarterGate();
        emit StarterSetLoaded(loader);
    }

    /// @inheritdoc IBoxCoordinatorV2
    function starterSetPending() public view virtual returns (bool);

    /// @inheritdoc IBoxCoordinatorV2
    function starterSetLoader() public view virtual returns (address);
    /// @dev Coordinator implements the combined chunks AND starter gate; no loader feature here.
    function _completeStarterGate() internal virtual;
}
