// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M2DeploymentSeamsTest} from "../../../m2-02/Box0Seams.t.sol";

/// Re-run the unchanged genesis/Safe deployment assertions with a distinct environment namespace.
contract Round2DeploymentEnvironmentTest is M2DeploymentSeamsTest {
    function _environmentNamespace() internal pure override returns (string memory) {
        return "Round2DeploymentEnvironment";
    }
}
