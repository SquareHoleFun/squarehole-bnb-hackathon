// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M234CreationTest} from "../m2-34/Creation.t.sol";
import {M234BoundariesTest} from "../m2-34/Boundaries.t.sol";
import {M234LifecycleTest} from "../m2-34/Lifecycle.t.sol";
import {M234DeploymentTest} from "../m2-34/Deployment.t.sol";
import {
    M234LegacyCreationTest, M234LegacySaltTest, M234LegacySpecTest, M234LegacyReleaseTest,
    M234LegacyRereadsTest, M234CQ11CreationTest, M234RegistryTest, M234RegistryProofTest,
    M234PlanningTest, M234FactoryTest, M234LegacyM2AdmissionTest
} from "../m2-34/Compatibility.t.sol";

// Run the existing owner suites on this ticket's changed-file path; no historical assertions weakened.
contract M332M2CreationRegression is M234CreationTest {}
contract M332M2BoundariesRegression is M234BoundariesTest {}
contract M332M2LifecycleRegression is M234LifecycleTest {}
contract M332M2DeploymentRegression is M234DeploymentTest {}
contract M332CreationRegression is M234LegacyCreationTest {}
contract M332SaltRegression is M234LegacySaltTest {}
contract M332SpecRegression is M234LegacySpecTest {}
contract M332ReleaseRegression is M234LegacyReleaseTest {}
contract M332RereadsRegression is M234LegacyRereadsTest {}
contract M332CQ11Regression is M234CQ11CreationTest {}
contract M332RegistryRegression is M234RegistryTest {}
contract M332RegistryProofRegression is M234RegistryProofTest {}
contract M332PlanningRegression is M234PlanningTest {}
contract M332FactoryRegression is M234FactoryTest {}
contract M332M2AdmissionRegression is M234LegacyM2AdmissionTest {}
