// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Text encodings for every box's on-chain metadata: RFC 4648 base64 for the `data:` URIs, RFC 4648 base32
/// (lower case, unpadded, multibase "b") for raw-codec CIDv1, decimal numbers and "0x" hex for 32-byte values (the
/// generator hash, F29). Pure functions, used only by view functions. A verbatim copy of v2's MisfitsEncoding
/// (src/v2/libraries/MisfitsEncoding.sol:4-97 at 46a030f6) under the box core's name, so the core does not import v2;
/// `test/box/items/BoxLibraries.t.sol` checks it against the original. Written for this repository (no third-party code).
library BoxEncoding {
    bytes internal constant BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    bytes internal constant BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
    bytes internal constant HEX_ALPHABET = "0123456789abcdef";

    /// @dev CIDv1 header for raw bytes: version 0x01, multicodec raw 0x55, multihash sha2-256 0x12, length 0x20.
    bytes4 internal constant RAW_CID_V1_SHA256_PREFIX = 0x01551220;

    /// @notice Standard base64 with "=" padding (RFC 4648 § 4).
    function base64(bytes memory data) internal pure returns (string memory) {
        uint256 len = data.length;
        if (len == 0) return "";
        bytes memory table = BASE64_ALPHABET;
        bytes memory out = new bytes(4 * ((len + 2) / 3));
        uint256 j;
        unchecked {
            for (uint256 i; i < len; i += 3) {
                uint256 rest = len - i;
                uint256 n = uint256(uint8(data[i])) << 16;
                if (rest > 1) n |= uint256(uint8(data[i + 1])) << 8;
                if (rest > 2) n |= uint256(uint8(data[i + 2]));
                out[j] = table[(n >> 18) & 63];
                out[j + 1] = table[(n >> 12) & 63];
                out[j + 2] = rest > 1 ? table[(n >> 6) & 63] : bytes1("=");
                out[j + 3] = rest > 2 ? table[n & 63] : bytes1("=");
                j += 4;
            }
        }
        return string(out);
    }

    /// @notice Base32 with the RFC 4648 alphabet in lower case and no padding (the multibase "b" body).
    function base32Lower(bytes memory data) internal pure returns (string memory) {
        uint256 bitLength = data.length * 8;
        bytes memory table = BASE32_ALPHABET;
        bytes memory out = new bytes((bitLength + 4) / 5);
        unchecked {
            for (uint256 k; k < out.length; ++k) {
                // The 5 bits starting at bit 5k (most significant first); bits past the end read as zero.
                uint256 bit = k * 5;
                uint256 byteIndex = bit / 8;
                uint256 window = uint256(uint8(data[byteIndex])) << 8;
                if (byteIndex + 1 < data.length) window |= uint256(uint8(data[byteIndex + 1]));
                uint256 value = (window >> (11 - (bit % 8))) & 31;
                out[k] = table[value];
            }
        }
        return string(out);
    }

    /// @notice The CIDv1 of a single raw block whose sha2-256 digest is `digest`: "b" + base32(0x01 0x55 0x12 0x20 ‖
    /// digest), 59 characters beginning "bafkrei". The file (a picture, or a Misfit's GLB model, F29) must be stored
    /// as one raw block (at most 1 MiB, uploaded with CIDv1 raw leaves and a chunk size that holds the whole file, or
    /// as a CAR), so its CID is this hash and nothing else.
    function rawCidV1(bytes32 digest) internal pure returns (string memory) {
        return string.concat("b", base32Lower(abi.encodePacked(RAW_CID_V1_SHA256_PREFIX, digest)));
    }

    /// @notice "0x" followed by the 64 lower-case hex digits of `value`, most significant byte first.
    function toHexString(bytes32 value) internal pure returns (string memory) {
        bytes memory table = HEX_ALPHABET;
        bytes memory out = new bytes(66);
        out[0] = "0";
        out[1] = "x";
        unchecked {
            for (uint256 i; i < 32; ++i) {
                uint8 b = uint8(value[i]);
                out[2 + 2 * i] = table[b >> 4];
                out[3 + 2 * i] = table[b & 15];
            }
        }
        return string(out);
    }

    function toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 v = value; v != 0; v /= 10) {
            ++digits;
        }
        bytes memory out = new bytes(digits);
        unchecked {
            for (uint256 i = digits; i > 0; --i) {
                out[i - 1] = bytes1(uint8(48 + (value % 10)));
                value /= 10;
            }
        }
        return string(out);
    }
}
