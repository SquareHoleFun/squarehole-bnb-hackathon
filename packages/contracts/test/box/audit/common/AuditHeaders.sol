// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title AuditHeaders
/// @notice TEST ONLY (SH-AUDIT-B0 R0-A). The synthetic post-London block header of `test/box/backup/CoreBox0BackupBase.sol`
/// (`_header`), byte for byte, as a library so the audit world can build one without inheriting that base (whose
/// setUp builds its own box 0): 13 fields (parent, ommers, coinbase, state, txs, receipts, a 256-byte bloom,
/// difficulty 0, number, gas limit, gas used, time, extra), then field 13 prevRandao = `mix`, then nonce and base fee.
/// `BoxBackedSource` reads field 13 (`_prevRandao`); real mainnet and Sepolia headers are in `HeaderVectors`.
library AuditHeaders {
    function header(uint256 number, bytes32 mix) internal pure returns (bytes memory) {
        bytes memory head = bytes.concat(
            _b32(keccak256("parent")),
            _b32(keccak256("ommers")),
            hex"94",
            bytes20(address(0xC0FFEE)),
            _b32(keccak256("state")),
            _b32(keccak256("txs")),
            _b32(keccak256("receipts"))
        );
        bytes memory mid = bytes.concat(hex"b90100", new bytes(256), hex"80", rlpUint(number), rlpUint(60_000_000));
        bytes memory tail = bytes.concat(rlpUint(12_345_678), rlpUint(1_790_000_000), hex"83616263", _b32(mix));
        bytes memory body = bytes.concat(head, mid, tail, hex"880000000000000000", rlpUint(7));
        // casting to 'uint16' is safe because the body is far below 65,536 bytes
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes.concat(hex"f9", bytes2(uint16(body.length)), body);
    }

    /// @notice The RLP encoding of an unsigned integer (0 is 0x80, below 0x80 a single byte).
    function rlpUint(uint256 v) internal pure returns (bytes memory out) {
        if (v == 0) return hex"80";
        // casting to 'uint8' is safe because v < 0x80 here
        // forge-lint: disable-next-line(unsafe-typecast)
        if (v < 0x80) return abi.encodePacked(uint8(v));
        uint256 len;
        for (uint256 t = v; t != 0; t >>= 8) {
            ++len;
        }
        out = new bytes(len);
        for (uint256 i; i < len; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            out[len - 1 - i] = bytes1(uint8(v >> (8 * i)));
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        out = bytes.concat(abi.encodePacked(uint8(0x80 + len)), out);
    }

    function _b32(bytes32 x) private pure returns (bytes memory) {
        return bytes.concat(hex"a0", x);
    }
}
