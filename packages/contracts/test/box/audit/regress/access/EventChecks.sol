// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

/// Exact wire-level checks: emitter, topic count/order/values and all ABI-encoded data bytes.
/// Selection ignores unrelated logs (including Amsterdam native-transfer logs), never log position zero.
abstract contract AuditRegressEventChecks is Test {
    function _event(
        Vm.Log[] memory logs,
        address emitter,
        string memory signature,
        bytes memory indexedFields,
        bytes memory data
    ) internal pure {
        bytes memory topics = bytes.concat(keccak256(bytes(signature)), indexedFields);
        uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && keccak256(abi.encodePacked(logs[i].topics)) == keccak256(topics)) {
                ++count;
                assertEq(logs[i].data, data, signature);
            }
        }
        assertEq(count, 1, signature);
    }

    function _oneEvent(Vm.Log[] memory logs, address emitter, string memory signature)
        internal
        pure
        returns (Vm.Log memory found)
    {
        uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == emitter && logs[i].topics.length != 0
                    && logs[i].topics[0] == keccak256(bytes(signature))
            ) {
                found = logs[i];
                ++count;
            }
        }
        assertEq(count, 1, signature);
    }

    function _noEvent(Vm.Log[] memory logs, address emitter, string memory signature) internal pure {
        for (uint256 i; i < logs.length; ++i) {
            assertFalse(
                logs[i].emitter == emitter && logs[i].topics.length != 0
                    && logs[i].topics[0] == keccak256(bytes(signature)),
                signature
            );
        }
    }
}
