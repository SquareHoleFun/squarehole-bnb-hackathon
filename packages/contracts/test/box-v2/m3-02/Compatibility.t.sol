// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M234CreationTest} from "../m2-34/Creation.t.sol";
import {M234BoundariesTest} from "../m2-34/Boundaries.t.sol";
import {M234LifecycleTest} from "../m2-34/Lifecycle.t.sol";
import {M234DeploymentTest} from "../m2-34/Deployment.t.sol";
import {M244MoneyTest} from "../m2-44/Money.t.sol";
import {M244RecoveryTest} from "../m2-44/Recovery.t.sol";
import {M244BurnGasTest} from "../m2-44/Gas.t.sol";
import {StarterGateTest} from "../m2-seam/StarterGate.t.sol";
import {M2Box0SeamsTest} from "../m2-02/Box0Seams.t.sol";

// One owned entry point for the integrated dependency proofs, with every inherited assertion intact.
// No pushed claims or unresolved R40A denominator regressions are imported. The sole environment-owning
// deployment preflight remains in M2DeploymentSeamsTest to avoid process-wide environment races.
contract M302CreationTest is M234CreationTest {}

contract M302ReleaseRefusalsTest is M234BoundariesTest {}

contract M302MoneyLifecycleTest is M234LifecycleTest {}

contract M302DeploymentTest is M234DeploymentTest {}

contract M302FailureMoneyTest is M244MoneyTest {}

contract M302FailureRecoveryTest is M244RecoveryTest {}

contract M302BurnBoundsTest is M244BurnGasTest {}

contract M302ChunkAndLoaderGateTest is StarterGateTest {}

contract M302GenesisSeamsTest is M2Box0SeamsTest {}
