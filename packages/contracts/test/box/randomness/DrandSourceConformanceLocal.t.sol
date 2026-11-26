// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDrandSource} from "../../../src/box/interfaces/IDrandSource.sol";
import {DrandSourceConformance} from "./DrandSourceConformance.sol";
import {PinnedDrandSource} from "./utils/PinnedDrandSource.sol";

/// @notice BC-053's instance checks, local provider: the pinned deployment made through the canonical deployer on a
/// local chain (the deployer's code etched where the test EVM lacks it). EVM Osaka (EIP-2537).
/// forge-config: default.evm_version = "osaka"
contract DrandSourceConformanceLocalTest is DrandSourceConformance {
    IDrandSource internal src;

    function setUp() public {
        _loadBoxDrand();
        src = IDrandSource(address(PinnedDrandSource.deploy(vm)));
    }

    function _source() internal view override returns (IDrandSource) {
        return src;
    }
}
