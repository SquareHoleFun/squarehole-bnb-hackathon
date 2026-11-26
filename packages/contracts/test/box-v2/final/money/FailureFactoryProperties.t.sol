// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ClaimsTest} from "../../cq11-c/Claims.t.sol";
import {HatchTest} from "../../cq11-c/Hatch.t.sol";
import {RoyaltyRouterTest} from "../../cq11-c/RoyaltyRouter.t.sol";
import {YearSweepTest} from "../../r40a/YearSweep.t.sol";
import {M363ReadbacksTest} from "../../m3-63-fix-create/Readbacks.t.sol";
import {M363CreationAdmissionTest} from "../../m3-63-fix-create/Admission.t.sol";

// Final-review entry points preserve the existing assertions and their fixture boundaries.
// These are regression checks, not newly designed tests or proof beyond their tested cases.
// R44A's pending Safe-trigger negative tests are intentionally not selected.
contract FinalMoneyFailureClaimsProperties is ClaimsTest {}

contract FinalMoneyHatchProperties is HatchTest {}

contract FinalMoneyRouterProperties is RoyaltyRouterTest {}

contract FinalMoneyYearSweepProperties is YearSweepTest {}

contract FinalMoneyFactoryBindingsProperties is M363ReadbacksTest {}

contract FinalMoneyFactoryAdmissionProperties is M363CreationAdmissionTest {}

