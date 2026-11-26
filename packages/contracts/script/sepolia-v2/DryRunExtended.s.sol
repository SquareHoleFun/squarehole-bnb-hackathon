// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Script} from "forge-std/Script.sol";
import {SepoliaExtendedRehearsal} from "./SepoliaExtendedRehearsal.sol";

/// @notice Offline only: no RPC, signing or broadcast. Each invocation starts a fresh production release.
contract DryRunExtended is Script {
    function runItems(uint8 decimals) external {
        _fixture().itemLife(decimals);
    }

    function runPile(uint8 decimals) external {
        _fixture().pileLife(decimals);
    }

    function runRoyalties() external {
        _fixture().royaltyLife();
    }

    function _fixture() private returns (SepoliaExtendedRehearsal f) {
        require(keccak256(type(SepoliaExtendedRehearsal).creationCode) != bytes32(0));
        f = SepoliaExtendedRehearsal(payable(vm.deployCode("SepoliaExtendedRehearsal.sol:SepoliaExtendedRehearsal")));
        f.setUp();
    }
}
