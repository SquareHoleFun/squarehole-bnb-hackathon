// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title BoxData
/// @notice Box data stored as contract code (the SSTORE2 pattern): code = 0x00 ‖ data, the leading STOP so it can never
/// run. The box's coordinator writes the metadata table this way before it creates the collection clone, which names
/// the data contract and its keccak256 as arguments (BC-062: nothing can rewrite code). Copied from MisfitsCollection
/// (`_writeData`, src/v2/MisfitsCollection.sol:700-711; `metadataTableBytes`, `:486-494` at 46a030f6), made a library
/// so the coordinator (S7) and the tests share one writer.
/// @dev Written for Square Hole (MIT, no third-party code).
library BoxData {
    /// @dev EIP-170 caps the data contract's code at 24,576 bytes, one of which is the STOP prefix.
    uint256 internal constant MAX_DATA_BYTES = 24_575;

    error DataTooLong(uint256 length);
    error DataWriteFailed();

    /// @notice The creation code of a data contract holding `data`: `PUSH2 len, DUP1, PUSH1 12, PUSH1 0, CODECOPY,
    /// PUSH1 0, RETURN`, then the runtime 0x00 ‖ data.
    function creationCode(bytes memory data) internal pure returns (bytes memory) {
        if (data.length > MAX_DATA_BYTES) revert DataTooLong(data.length);
        bytes memory runtime = abi.encodePacked(hex"00", data);
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encodePacked(hex"61", uint16(runtime.length), hex"80600c6000396000f3", runtime);
    }

    /// @notice CREATEs a data contract holding `data` and returns its address.
    function write(bytes memory data) internal returns (address pointer) {
        bytes memory creation = creationCode(data);
        assembly ("memory-safe") {
            pointer := create(0, add(creation, 0x20), mload(creation))
        }
        if (pointer == address(0)) revert DataWriteFailed();
    }

    /// @notice The data behind `pointer` (its code after the STOP prefix); empty for an account without code.
    function read(address pointer) internal view returns (bytes memory data) {
        uint256 size = pointer.code.length;
        if (size == 0) return data;
        unchecked {
            size -= 1;
        }
        data = new bytes(size);
        assembly ("memory-safe") {
            extcodecopy(pointer, add(data, 0x20), 1, size)
        }
    }
}
