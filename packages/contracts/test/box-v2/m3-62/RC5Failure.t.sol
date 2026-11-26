// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {PermanentClaimsTest} from "../rc5-a/PermanentClaims.t.sol";
import {ReceiverFailureTest} from "../cq11-b/ReceiverFailure.t.sol";

// Keep each historical mutation campaign on its own test entry point.
contract RC5ClaimsMutationTest is PermanentClaimsTest {}
contract RC5RoutingMutationTest is ReceiverFailureTest {}
