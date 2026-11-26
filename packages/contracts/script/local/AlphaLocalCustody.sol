// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {LocalV2Custody} from "./DeployCoreV2Local.s.sol";
import {IListingRegistry} from "../../src/box-v2/interfaces/IListingRegistry.sol";

/// @notice 31337-only custody fixture; the existing twin's custody bytecode stays unchanged.
contract AlphaLocalCustody is LocalV2Custody {
    constructor(address[] memory owners) LocalV2Custody(owners, 1) {
        require(block.chainid == 31337, "alpha local only");
    }
    function updateLocalRaise(IListingRegistry registry, uint32 id, uint256 raise) external {
        require(msg.sender == this.getOwners()[0], "local owner only");
        registry.updateRaise(id, raise);
    }
}
