// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice TEST ONLY. Reads a contract's runtime code instruction by instruction (PUSH data skipped, so a byte inside
/// pushed data is never read as an opcode) for the instance checks of the box conformance harness: which function
/// selectors the code pushes (a Solidity dispatcher compares the call's selector with a push of each of its functions,
/// solc using the shortest push, PUSH1 to PUSH4, for the selector's value; so a selector the code never pushes cannot
/// be dispatched), and whether it contains an opcode.
/// A negative answer is sound for Solidity-built code and every selector but 0x00000000 (which solc may test with
/// ISZERO, pushing nothing; no denied signature hashes to it); a positive one is a warning to read the source, since
/// pushed constants can collide with a selector by chance (the harness asserts the positive controls it relies on).
library CodeScan {
    /// @dev EIP-1167 minimal proxy prefix: 363d3d373d3d3d363d73 (then the 20-byte target).
    bytes10 internal constant MINIMAL_PROXY_PREFIX = 0x363d3d373d3d3d363d73;
    /// @dev EIP-7702 delegation designator prefix.
    bytes3 internal constant DELEGATION_PREFIX = 0xef0100;
    uint8 internal constant OP_DELEGATECALL = 0xf4;
    uint8 internal constant OP_SELFDESTRUCT = 0xff;
    uint8 internal constant OP_CALLCODE = 0xf2;
    uint8 private constant OP_PUSH1 = 0x60;
    uint8 private constant OP_PUSH4 = 0x63;
    uint8 private constant OP_PUSH32 = 0x7f;

    /// @notice Every value the code pushes with PUSH1 to PUSH4, left-padded to 4 bytes (so a selector with leading zero
    /// bytes, which solc pushes with fewer bytes, is found too), in code order, as uint32.
    function pushedWords(bytes memory code) internal pure returns (uint32[] memory found) {
        uint256 len = code.length;
        uint256 count;
        uint256 i;
        while (i < len) {
            uint8 op = uint8(code[i]);
            if (op >= OP_PUSH1 && op <= OP_PUSH32) {
                if (op <= OP_PUSH4 && i + op - 0x5f < len) ++count;
                i += op - 0x5e;
            } else {
                ++i;
            }
        }
        found = new uint32[](count);
        count = 0;
        i = 0;
        while (i < len) {
            uint8 op = uint8(code[i]);
            if (op >= OP_PUSH1 && op <= OP_PUSH32) {
                uint256 n = op - 0x5f;
                if (op <= OP_PUSH4 && i + n < len) {
                    uint32 v;
                    for (uint256 j = 1; j <= n; ++j) {
                        v = (v << 8) | uint8(code[i + j]);
                    }
                    found[count++] = v;
                }
                i += n + 1;
            } else {
                ++i;
            }
        }
    }

    function pushes(uint32[] memory words, bytes4 selector) internal pure returns (bool) {
        uint32 s = uint32(selector);
        for (uint256 i; i < words.length; ++i) {
            if (words[i] == s) return true;
        }
        return false;
    }

    /// @notice True if `op` occurs as an instruction (not as PUSH data).
    function hasOpcode(bytes memory code, uint8 op) internal pure returns (bool) {
        uint256 i;
        uint256 len = code.length;
        while (i < len) {
            uint8 x = uint8(code[i]);
            if (x == op) return true;
            i += (x >= 0x60 && x <= 0x7f) ? x - 0x5e : 1;
        }
        return false;
    }

    function isMinimalProxy(bytes memory code) internal pure returns (bool) {
        return code.length >= 10 && bytes10(_word(code)) == MINIMAL_PROXY_PREFIX;
    }

    /// @notice The fixed target of an EIP-1167 minimal clone (the 20 bytes after its prefix).
    function minimalProxyTarget(bytes memory code) internal pure returns (address target) {
        require(isMinimalProxy(code) && code.length >= 30, "not a minimal clone");
        assembly ("memory-safe") {
            target := shr(96, mload(add(code, 0x2a)))
        }
    }

    function isDelegation(bytes memory code) internal pure returns (bool) {
        return code.length == 23 && bytes3(_word(code)) == DELEGATION_PREFIX;
    }

    /// @dev The first 32 bytes of `code` (zero-padded).
    function _word(bytes memory code) private pure returns (bytes32 w) {
        assembly ("memory-safe") {
            w := mload(add(code, 0x20))
        }
        if (code.length < 32) w &= bytes32(type(uint256).max << (8 * (32 - code.length)));
    }
}
