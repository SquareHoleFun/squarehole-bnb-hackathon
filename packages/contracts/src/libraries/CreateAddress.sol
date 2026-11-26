// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Address of a contract created with CREATE: keccak256(rlp([deployer, nonce]))[12:].
/// @dev Written for Square Hole. Supports nonces 1 … 2^32 − 1 (a contract's CREATE nonce starts at 1, EIP-161).
library CreateAddress {
    error NonceOutOfRange(uint256 nonce);

    function compute(address deployer, uint256 nonce) internal pure returns (address) {
        bytes memory rlp;
        if (nonce == 0 || nonce > type(uint32).max) revert NonceOutOfRange(nonce);
        // casting to 'uint8'/'uint16'/'uint24'/'uint32' is safe because each branch bounds `nonce` first
        // forge-lint: disable-start(unsafe-typecast)
        if (nonce <= 0x7f) {
            rlp = abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, uint8(nonce));
        } else if (nonce <= 0xff) {
            rlp = abi.encodePacked(bytes1(0xd7), bytes1(0x94), deployer, bytes1(0x81), uint8(nonce));
        } else if (nonce <= 0xffff) {
            rlp = abi.encodePacked(bytes1(0xd8), bytes1(0x94), deployer, bytes1(0x82), uint16(nonce));
        } else if (nonce <= 0xffffff) {
            rlp = abi.encodePacked(bytes1(0xd9), bytes1(0x94), deployer, bytes1(0x83), uint24(nonce));
        } else {
            rlp = abi.encodePacked(bytes1(0xda), bytes1(0x94), deployer, bytes1(0x84), uint32(nonce));
        }
        // forge-lint: disable-end(unsafe-typecast)
        return address(uint160(uint256(keccak256(rlp))));
    }
}
