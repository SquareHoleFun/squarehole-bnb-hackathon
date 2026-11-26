// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetSpecV2, SetRefused} from "./SetTypesV2.sol";
import {SetReason as R} from "./SetConstantsV2.sol";

/// @notice Registry-compatible hash of the entire canonical struct, including schema and release domains.
library SetSpecV2Codec {
    function encode(SetSpecV2 memory spec) internal pure returns (bytes memory) {
        return abi.encode(spec);
    }

    function specHash(SetSpecV2 memory spec) internal pure returns (bytes32) {
        return keccak256(encode(spec));
    }

    /// @notice Refuses trailing bytes, noncanonical offsets/padding and any unrepresented extension.
    /// @dev Malformed ABI may revert in abi.decode; the validator converts all such failures to code 29.
    function decode(bytes memory encoded) internal pure returns (SetSpecV2 memory spec) {
        spec = abi.decode(encoded, (SetSpecV2));
        if (keccak256(encoded) != specHash(spec)) revert SetRefused(R.NONCANONICAL_ABI, R.GLOBAL);
    }
}
