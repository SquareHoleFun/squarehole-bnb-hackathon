// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Maintained dependency properties, re-executed through owned final-review entry points.
/// Unit-test doubles retain their original scope; production creation is checked separately.
import {M132aCreationTest} from "../../m1-32a/M132aCreation.t.sol";
import {M132aReleaseWiringTest} from "../../m1-32a/M132aReleaseWiring.t.sol";
import {M132aRereadsTest} from "../../m1-32a/M132aRereads.t.sol";
import {M132aSaltTest} from "../../m1-32a/M132aSalt.t.sol";
import {RegistryCQ11Test} from "../../m1-32b/Registry.t.sol";
import {FactoryDTest} from "../../cq11-d/Factory.t.sol";
import {ListingsDTest} from "../../cq11-d/Listings.t.sol";
import {M234CreationTest} from "../../m2-34/Creation.t.sol";
import {M234BoundariesTest} from "../../m2-34/Boundaries.t.sol";
import {M363CreationAdmissionTest} from "../../m3-63-fix-create/Admission.t.sol";
import {M363ReadbacksTest} from "../../m3-63-fix-create/Readbacks.t.sol";
import {M363JournalTest} from "../../m3-63-fix-create/Journal.t.sol";
import {M363ProductionLifecycleTest} from "../../m3-63-fix-create/Lifecycle.t.sol";

contract FinalM132aCreationTest is M132aCreationTest {}

contract FinalM132aReleaseWiringTest is M132aReleaseWiringTest {}

contract FinalM132aRereadsTest is M132aRereadsTest {}

contract FinalM132aSaltTest is M132aSaltTest {}

contract FinalRegistryCQ11Test is RegistryCQ11Test {}

contract FinalFactoryDTest is FactoryDTest {}

contract FinalListingsDTest is ListingsDTest {}

contract FinalM234CreationTest is M234CreationTest {}

contract FinalM234BoundariesTest is M234BoundariesTest {}

contract FinalM363CreationAdmissionTest is M363CreationAdmissionTest {}

contract FinalM363ReadbacksTest is M363ReadbacksTest {}

contract FinalM363JournalTest is M363JournalTest {}

contract FinalM363ProductionLifecycleTest is M363ProductionLifecycleTest {}
