// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {CoreV2Deployment} from "../../../script/sepolia-v2/CoreV2Deployment.sol";

/// Exercises the exact script admission for linked libraries, which Foundry deploys before script CREATEs.
contract FeeLibraryDeploymentTest is Test, CoreV2Deployment {
    function test_FM12_eachFixedCoreLibraryHasItsOwnBoundedDeployStep() public {
        chargesStateGas = _codeByteGas() >= STATE_GAS_PER_CODE_BYTE_MIN;
        string[6] memory names = [string("ReceiverBooksV21"), "ReceiverPendingV21", "ReceiverRewardsV21",
            "RewardAccountingV21", "FeeModuleProofV21", "ReceiverModuleCallV21"];
        for (uint256 i; i < names.length; ++i) {
            address part = _deploy(string.concat(names[i], ".sol:", names[i]), "");
            assertGt(part.code.length, 0); assertLe(part.code.length, 22_118);
        }
    }
}
