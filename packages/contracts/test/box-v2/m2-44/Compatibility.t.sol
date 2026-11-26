// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FailureTest} from "../m2-32/Failure.t.sol";
import {BoundariesTest} from "../m2-32/Boundaries.t.sol";
import {StarterRecoveryTest} from "../m2-33/Recovery.t.sol";
import {ClaimsTest} from "../cq11-c/Claims.t.sol";
import {HatchTest} from "../cq11-c/Hatch.t.sol";
import {HolderReceiverTest} from "../m2-30/HolderReceiver.t.sol";

// Reuse the original assertions unchanged through owned test paths; no known R40A suite is imported.
contract M244ShopFailureCompatibilityTest is FailureTest {}
contract M244ShopBoundsCompatibilityTest is BoundariesTest {}
contract M244StarterRecoveryCompatibilityTest is StarterRecoveryTest {}
contract M244ClaimsCompatibilityTest is ClaimsTest {}
contract M244HatchCompatibilityTest is HatchTest {}
contract M244FundingCompatibilityTest is HolderReceiverTest {}
