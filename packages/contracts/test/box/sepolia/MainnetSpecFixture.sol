// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";

/// @notice TEST ONLY: synthetic mainnet-shaped commitment for local gas-rule tests, never a launch commitment.
/// These deterministic values differ from the known test roots, generators and tables refused by DeployCoreV1.
library MainnetSpecFixture {
    function withCommitment(BoxSpecV1.BoxSpec memory spec) internal pure returns (BoxSpecV1.BoxSpec memory) {
        spec.revealRoot = keccak256("GlamsterdamAfter: TEST ONLY mainnet root");
        spec.generatorHash = keccak256("GlamsterdamAfter: TEST ONLY mainnet generator");
        // Table v1: description "TEST ONLY", one type "GasMode", values "Osaka" and "Amsterdam".
        // The trait/value bytes are distinct too: changing only the description would still be refused.
        spec.metadataTable = bytes.concat(
            hex"010009", bytes("TEST ONLY"), hex"0107", bytes("GasMode"), hex"0205", bytes("Osaka"), hex"09", bytes("Amsterdam")
        );
        return spec;
    }
}
