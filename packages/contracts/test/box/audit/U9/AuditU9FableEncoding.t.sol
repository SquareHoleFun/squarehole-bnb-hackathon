// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxEncoding} from "../../../../src/box/libraries/BoxEncoding.sol";

/// @title AuditU9FableEncoding
/// @notice SH-AUDIT-B0-U9 (Fable 5.1), lens L7 (P9.9): `BoxEncoding`'s base64, base32, decimal and hex against
/// independent references (a bit-accumulator base64 and base32 written here, RFC 4648's own test vectors, forge-std's
/// `vm.toString` for decimal and hex) for every input length 0..96 (every remainder class of 3 and of 5), for random
/// bytes, and for `type(uint256).max`; the raw-block CIDv1's shape.
/// @dev Source: `BoxEncoding.sol:4-8` (RFC 4648 base64 with padding, base32 lower case unpadded, decimal, 0x hex).
contract AuditU9FableEncodingTest is Test {
    bytes internal constant B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    bytes internal constant B32 = "abcdefghijklmnopqrstuvwxyz234567";

    // ------------------------------------------------------------------------------------------------ references

    /// @dev RFC 4648 § 4 by a bit accumulator (the library packs 24-bit groups instead).
    function _refBase64(bytes memory d) internal pure returns (string memory) {
        bytes memory alpha = B64;
        uint256 outLen = 4 * ((d.length + 2) / 3);
        bytes memory out = new bytes(outLen);
        uint256 bits;
        uint256 nbits;
        uint256 j;
        for (uint256 i; i < d.length; ++i) {
            bits = (bits << 8) | uint8(d[i]);
            nbits += 8;
            while (nbits >= 6) {
                nbits -= 6;
                out[j++] = alpha[(bits >> nbits) & 63];
            }
            bits &= (1 << nbits) - 1;
        }
        if (nbits > 0) out[j++] = alpha[(bits << (6 - nbits)) & 63];
        while (j < outLen) {
            out[j++] = "=";
        }
        return string(out);
    }

    /// @dev RFC 4648 § 6 in lower case without padding, by a bit accumulator.
    function _refBase32(bytes memory d) internal pure returns (string memory) {
        bytes memory alpha = B32;
        uint256 outLen = (d.length * 8 + 4) / 5;
        bytes memory out = new bytes(outLen);
        uint256 bits;
        uint256 nbits;
        uint256 j;
        for (uint256 i; i < d.length; ++i) {
            bits = (bits << 8) | uint8(d[i]);
            nbits += 8;
            while (nbits >= 5) {
                nbits -= 5;
                out[j++] = alpha[(bits >> nbits) & 31];
            }
            bits &= (1 << nbits) - 1;
        }
        if (nbits > 0) out[j++] = alpha[(bits << (5 - nbits)) & 31];
        assertEq(j, outLen, "reference length");
        return string(out);
    }

    function _data(uint256 n, uint256 seed) internal pure returns (bytes memory d) {
        d = new bytes(n);
        for (uint256 i; i < n; ++i) {
            d[i] = bytes1(uint8(uint256(keccak256(abi.encode(seed, i / 32))) >> (8 * (i % 32))));
        }
    }

    // ------------------------------------------------------------------------------------------------ base64

    /// RFC 4648 § 10's base64 vectors, then every length 0..96 (three seeds each) against the reference: the output
    /// length is 4 x ceil(n / 3) and the padding count is (3 - n % 3) % 3.
    function testProperty_AUDIT_U9_base64EveryLength0To96() public pure {
        string[7] memory inputs = ["", "f", "fo", "foo", "foob", "fooba", "foobar"];
        string[7] memory expected = ["", "Zg==", "Zm8=", "Zm9v", "Zm9vYg==", "Zm9vYmE=", "Zm9vYmFy"];
        for (uint256 i; i < 7; ++i) {
            assertEq(BoxEncoding.base64(bytes(inputs[i])), expected[i], inputs[i]);
            assertEq(_refBase64(bytes(inputs[i])), expected[i], "reference");
        }
        for (uint256 n; n <= 96; ++n) {
            for (uint256 seed; seed < 3; ++seed) {
                bytes memory d = _data(n, seed);
                string memory got = BoxEncoding.base64(d);
                assertEq(got, _refBase64(d), "base64 vs reference");
                assertEq(bytes(got).length, 4 * ((n + 2) / 3), "length");
                uint256 pad;
                for (uint256 k = bytes(got).length; k > 0 && bytes(got)[k - 1] == "="; --k) {
                    ++pad;
                }
                assertEq(pad, (3 - n % 3) % 3, "padding");
            }
        }
        // Every byte value at every position of a 3-byte group.
        for (uint256 c; c < 256; ++c) {
            for (uint256 pos; pos < 3; ++pos) {
                bytes memory d = new bytes(3);
                d[pos] = bytes1(uint8(c));
                assertEq(BoxEncoding.base64(d), _refBase64(d));
            }
        }
    }

    function testFuzz_AUDIT_U9_base64MatchesTheReference(bytes memory d) public pure {
        assertEq(BoxEncoding.base64(d), _refBase64(d));
    }

    // ------------------------------------------------------------------------------------------------ base32

    /// RFC 4648 § 10's base32 vectors in lower case without padding, then every length 0..96 against the reference:
    /// the output length is ceil(8n / 5); every remainder class n % 5 is covered.
    function testProperty_AUDIT_U9_base32EveryLength0To96() public pure {
        string[7] memory inputs = ["", "f", "fo", "foo", "foob", "fooba", "foobar"];
        string[7] memory expected = ["", "my", "mzxq", "mzxw6", "mzxw6yq", "mzxw6ytb", "mzxw6ytboi"];
        for (uint256 i; i < 7; ++i) {
            assertEq(BoxEncoding.base32Lower(bytes(inputs[i])), expected[i], inputs[i]);
            assertEq(_refBase32(bytes(inputs[i])), expected[i], "reference");
        }
        for (uint256 n; n <= 96; ++n) {
            for (uint256 seed; seed < 3; ++seed) {
                bytes memory d = _data(n, seed);
                string memory got = BoxEncoding.base32Lower(d);
                assertEq(got, _refBase32(d), "base32 vs reference");
                assertEq(bytes(got).length, (8 * n + 4) / 5, "length");
                for (uint256 k; k < bytes(got).length; ++k) {
                    bytes1 ch = bytes(got)[k];
                    assertTrue((ch >= "a" && ch <= "z") || (ch >= "2" && ch <= "7"), "alphabet");
                }
            }
        }
        for (uint256 c; c < 256; ++c) {
            for (uint256 pos; pos < 5; ++pos) {
                bytes memory d = new bytes(5);
                d[pos] = bytes1(uint8(c));
                assertEq(BoxEncoding.base32Lower(d), _refBase32(d));
            }
        }
    }

    function testFuzz_AUDIT_U9_base32MatchesTheReference(bytes memory d) public pure {
        assertEq(BoxEncoding.base32Lower(d), _refBase32(d));
    }

    /// `type(uint256).max` as 32 bytes: 51 sevens and a `q` (256 = 51 x 5 + 1: the last character carries one set bit
    /// then four zero bits, 0b10000 = 16 = 'q'); as base64 44 characters of which the last is `=`.
    function testProperty_AUDIT_U9_maxWordEncodings() public pure {
        bytes memory d = abi.encodePacked(type(uint256).max);
        string memory b32 = BoxEncoding.base32Lower(d);
        assertEq(bytes(b32).length, 52);
        for (uint256 i; i < 51; ++i) {
            assertEq(bytes(b32)[i], "7");
        }
        assertEq(bytes(b32)[51], "q");
        assertEq(b32, _refBase32(d));
        string memory b64 = BoxEncoding.base64(d);
        assertEq(bytes(b64).length, 44);
        assertEq(b64, "//////////////////////////////////////////8=");
        assertEq(
            BoxEncoding.toHexString(bytes32(type(uint256).max)),
            "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
        );
        assertEq(
            BoxEncoding.toString(type(uint256).max),
            "115792089237316195423570985008687907853269984665640564039457584007913129639935"
        );
    }

    // ------------------------------------------------------------------------------------------------ decimal, hex

    /// Decimal and hex against forge-std's `vm.toString`: the edges and a fuzz.
    function testProperty_AUDIT_U9_decimalAndHexMatchForgeStd() public pure {
        uint256[12] memory xs =
            [uint256(0), 1, 9, 10, 11, 99, 100, 101, 1e18, (1 << 64) - 1, 1 << 128, type(uint256).max - 1];
        for (uint256 i; i < 12; ++i) {
            assertEq(BoxEncoding.toString(xs[i]), vm.toString(xs[i]));
        }
        bytes32[4] memory hs = [bytes32(0), bytes32(uint256(1)), bytes32(uint256(0xdeadbeef) << 224), keccak256("x")];
        for (uint256 i; i < 4; ++i) {
            assertEq(BoxEncoding.toHexString(hs[i]), vm.toString(hs[i]));
            assertEq(bytes(BoxEncoding.toHexString(hs[i])).length, 66);
        }
    }

    function testFuzz_AUDIT_U9_decimalAndHexMatchForgeStd(uint256 x, bytes32 h) public pure {
        assertEq(BoxEncoding.toString(x), vm.toString(x));
        assertEq(BoxEncoding.toHexString(h), vm.toString(h));
    }

    // ------------------------------------------------------------------------------------------------ CID

    /// The raw-block CIDv1: 59 characters, `bafkrei` first (the multibase `b` and the base32 of 0x01 0x55 0x12 0x20),
    /// equal to `b` followed by the reference base32 of the prefix and the digest.
    function testFuzz_AUDIT_U9_rawCidV1Shape(bytes32 digest) public pure {
        string memory cid = BoxEncoding.rawCidV1(digest);
        assertEq(bytes(cid).length, 59);
        assertEq(bytes(cid)[0], "b");
        assertEq(string(_slice(bytes(cid), 0, 7)), "bafkrei");
        assertEq(cid, string.concat("b", _refBase32(abi.encodePacked(bytes4(0x01551220), digest))));
    }

    function _slice(bytes memory b, uint256 start, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = b[start + i];
        }
    }
}
