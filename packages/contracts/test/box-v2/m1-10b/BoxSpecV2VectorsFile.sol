// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

/// @notice M1-10-a's vectors, written only by its encode-vectors.mjs.
abstract contract BoxSpecV2VectorsFile is Test {
    string internal constant REAL_VECTORS = "test/vectors/box-spec/box-spec-v2.json";

    function _vectorsFile() internal pure returns (string memory) {
        return REAL_VECTORS;
    }
}
