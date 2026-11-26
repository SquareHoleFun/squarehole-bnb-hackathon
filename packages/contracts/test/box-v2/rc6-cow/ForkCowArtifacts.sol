// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Standalone ForkCow.t.sol's artifact-only fixture. An abstract marker keeps this source in Forge's
// compilation set even when selecting one test file. Importing PoolManager in the factory test itself
// would also compile its linked production libraries under the upstream profile, creating duplicates.
import {PoolManager} from "v4-core/src/PoolManager.sol";

abstract contract ForkCowPoolManagerArtifact {}
