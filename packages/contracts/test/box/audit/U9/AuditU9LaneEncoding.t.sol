// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxEncoding} from "../../../../src/box/libraries/BoxEncoding.sol";

/// @notice RFC4648 §§4,6; F29 CID and generator hash; independent cheatcode and bit-by-bit references.
contract AuditU9LaneEncoding is Test {
    function _base32(bytes memory data) internal pure returns (string memory) {
        bytes memory alphabet = "abcdefghijklmnopqrstuvwxyz234567";
        bytes memory out = new bytes((data.length * 8 + 4) / 5);
        for (uint256 i; i < out.length; ++i) {
            uint256 value;
            for (uint256 bit; bit < 5; ++bit) {
                uint256 at = i * 5 + bit;
                value *= 2;
                if (at < data.length * 8) value += (uint8(data[at / 8]) >> (7 - at % 8)) & 1;
            }
            out[i] = alphabet[value];
        }
        return string(out);
    }

    function _check(bytes memory data, uint256 n) internal pure {
        assertEq(BoxEncoding.base64(data), vm.toBase64(data));
        assertEq(BoxEncoding.base32Lower(data), _base32(data));
        assertEq(BoxEncoding.toString(n), vm.toString(n));
        assertEq(BoxEncoding.toHexString(bytes32(n)), vm.toString(bytes32(n)));
        bytes32 digest = keccak256(data);
        assertEq(BoxEncoding.rawCidV1(digest), string.concat("b", _base32(abi.encodePacked(hex"01551220", digest))));
    }

    function testProperty_AUDIT_U9_allLengthsZeroThrough96AndMaxUint() public pure {
        for (uint256 length; length <= 96; ++length) {
            bytes memory data = new bytes(length);
            _check(data, length);
            for (uint256 i; i < length; ++i) {
                data[i] = 0xff;
            }
            _check(data, type(uint256).max);
            for (uint256 i; i < length; ++i) {
                data[i] = bytes1(uint8(i * 37 + length));
            }
            _check(data, uint256(keccak256(data)));
        }
        _check(abi.encode(type(uint256).max), type(uint256).max);
    }

    function testFuzz_AUDIT_U9_randomEncoding(bytes32 seed, uint8 length, uint256 n) public pure {
        bytes memory data = new bytes(uint256(length) % 97);
        for (uint256 i; i < data.length; ++i) {
            data[i] = keccak256(abi.encode(seed, i))[0];
        }
        _check(data, n);
    }
}
