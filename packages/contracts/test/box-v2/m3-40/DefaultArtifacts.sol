// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

/// The PoolManager compiler profile may also emit imported protocol contracts.
/// Always exercise the default release artifact, not an ambiguous profile variant.
abstract contract DefaultArtifacts is Test {
    function deployCode(string memory what, bytes memory args) internal virtual override returns (address) {
        return super.deployCode(_artifact(what), args);
    }

    function deployCode(string memory what) internal virtual override returns (address) {
        return super.deployCode(_artifact(what));
    }

    function _artifact(string memory what) private pure returns (string memory) {
        string[] memory parts = vm.split(what, ":");
        // Foundry resolves FactoryChecksCurve links only through named artifacts.
        if (parts.length == 2 && (
            keccak256(bytes(parts[1])) == keccak256("BoxReceiverV2") ||
            keccak256(bytes(parts[1])) == keccak256("BoxFactoryV2") ||
            keccak256(bytes(parts[1])) == keccak256("BoxFactoryV2Checks") ||
            keccak256(bytes(parts[1])) == keccak256("BoxFactoryV2ChecksM332Double")
        )) return what;
        return parts.length == 2 ? string.concat("out/", parts[0], "/", parts[1], ".json") : what;
    }
}
