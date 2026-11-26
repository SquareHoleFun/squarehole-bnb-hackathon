// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ChunkPart} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {ChunkLoader} from "../../../src/box-v2/libraries/ChunkLoader.sol";

/// @title M1_32bChunkHarness
/// @notice TEST ONLY. The coordinator's side of `ChunkLoader` (M1-30-a's shell calls the same entries): each external
/// function calls one library entry and nothing else, so the loader's state lives in this contract, as it will in the
/// coordinator. `shellWord` stands for the shell's own storage base at slot 0 (file map § 1 rule 3).
contract M1_32bChunkHarness {
    uint256 public shellWord = 0x5ea1;

    function rootOf(bytes calldata part, uint256 chunkMax) external pure returns (bytes32) {
        return ChunkLoader.rootOf(part, chunkMax);
    }

    function init(ChunkPart part, bytes32 root, uint256 length, uint256 chunkMax) external {
        ChunkLoader.init(part, root, length, chunkMax);
    }

    function load(ChunkPart part, bytes calldata data, bytes32 nextHash)
        external
        returns (uint256 index, bool partDone, address chunk)
    {
        return ChunkLoader.load(part, data, nextHash);
    }

    function state(ChunkPart part) external view returns (bytes32 nextHash, uint256 loaded, uint256 total) {
        return ChunkLoader.state(part);
    }

    function rootFor(ChunkPart part) external view returns (bytes32 root, uint256 length) {
        return ChunkLoader.rootFor(part);
    }

    function pointer(ChunkPart part, uint256 index) external view returns (address) {
        return ChunkLoader.pointer(part, index);
    }

    function complete() external view returns (bool) {
        return ChunkLoader.complete();
    }
}
