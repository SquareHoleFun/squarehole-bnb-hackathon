// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M132aCreationTest} from "../m1-32a/M132aCreation.t.sol";
import {M132aSaltTest} from "../m1-32a/M132aSalt.t.sol";
import {M132aSpecTest} from "../m1-32a/M132aSpec.t.sol";
import {M132aReleaseWiringTest} from "../m1-32a/M132aReleaseWiring.t.sol";
import {M132aRereadsTest} from "../m1-32a/M132aRereads.t.sol";
import {CQ11WCreationTest} from "../m1-32a/CQ11WCreation.t.sol";
import {RegistryCQ11Test} from "../m1-32b/Registry.t.sol";
import {RegistryProofTest} from "../m1-32b/proof/RegistryProof.t.sol";
import {PlanningDTest} from "../cq11-d/Planning.t.sol";
import {FactoryDTest} from "../cq11-d/Factory.t.sol";
import {M210CreationBoundaryTest} from "../m2-10/CreationBoundary.t.sol";

// Run the inherited factory/planner/parts/checker/registry contracts through this ticket's test path.
contract M234LegacyCreationTest is M132aCreationTest {}
contract M234LegacySaltTest is M132aSaltTest {}
contract M234LegacySpecTest is M132aSpecTest {}
contract M234LegacyReleaseTest is M132aReleaseWiringTest {}
contract M234LegacyRereadsTest is M132aRereadsTest {}
contract M234CQ11CreationTest is CQ11WCreationTest {}
contract M234RegistryTest is RegistryCQ11Test {}
contract M234RegistryProofTest is RegistryProofTest {}
contract M234PlanningTest is PlanningDTest {}
contract M234FactoryTest is FactoryDTest {}
contract M234LegacyM2AdmissionTest is M210CreationBoundaryTest {}
