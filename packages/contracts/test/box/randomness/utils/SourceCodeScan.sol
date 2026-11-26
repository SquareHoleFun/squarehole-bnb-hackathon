// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxDrandQuicknet} from "../../../../src/box/randomness/BoxDrandQuicknet.sol";

/// @notice TEST ONLY. The instructions of a `DrandSource` runtime: the code before the first of the BLS library's byte
/// constants (the group key, −g2, the tag), which solc stores after the instructions and copies with CODECOPY, so
/// `CodeScan` (test/box/conformance/CodeScan.sol) does not read their bytes as opcodes. Each constant must be found.
library SourceCodeScan {
    function instructions(bytes memory code) internal pure returns (bytes memory head) {
        bytes[3] memory blobs = [BoxDrandQuicknet.PUBLIC_KEY, BoxDrandQuicknet.NEG_G2_GENERATOR, BoxDrandQuicknet.DST];
        uint256 cut = code.length;
        for (uint256 i; i < blobs.length; ++i) {
            uint256 at = find(code, blobs[i]);
            require(at != type(uint256).max, "a constant blob not found in the code");
            if (at < cut) cut = at;
        }
        head = new bytes(cut);
        for (uint256 i; i < cut; ++i) {
            head[i] = code[i];
        }
    }

    function find(bytes memory hay, bytes memory needle) internal pure returns (uint256) {
        if (needle.length > hay.length) return type(uint256).max;
        for (uint256 i; i + needle.length <= hay.length; ++i) {
            bool hit = true;
            for (uint256 j; j < needle.length; ++j) {
                if (hay[i + j] != needle[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return i;
        }
        return type(uint256).max;
    }
}
