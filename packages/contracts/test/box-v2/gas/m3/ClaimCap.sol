// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Test-only opcode patch; matches PUSH3 instructions, never bytes inside PUSH data.
/// Every production instruction and immutable other than the asserted cap literals is retained.
library ClaimCap {
    uint256 internal constant PROPOSED = 2_600_000;

    function replace(bytes memory code, uint256 oldCap, uint256 newCap, uint256 expected)
        internal
        pure
        returns (bytes memory)
    {
        uint256 count;
        for (uint256 i; i < code.length; ++i) {
            uint8 op = uint8(code[i]);
            if (op == 0x62 && i + 3 < code.length) {
                uint256 value =
                    (uint256(uint8(code[i + 1])) << 16) | (uint256(uint8(code[i + 2])) << 8) | uint8(code[i + 3]);
                if (value == oldCap) {
                    code[i + 1] = bytes1(uint8(newCap >> 16));
                    code[i + 2] = bytes1(uint8(newCap >> 8));
                    code[i + 3] = bytes1(uint8(newCap));
                    ++count;
                }
            }
            if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
        }
        require(count == expected, "stipend double instruction count changed");
        return code;
    }
}
