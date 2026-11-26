// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title BackedSourcePins (F143; read by factory v1, S7, for BC-101)
/// @notice The pinned `BoxBackedSource` deployment (box 0's randomness source: drand first through the pinned
/// `DrandSource`, the RANDAO backup by an on-chain rule) for chains 1 (mainnet) and 11155111 (Sepolia), as this
/// repository compiles it (`foundry.toml`: solc 0.8.26, optimizer 1,000 runs, EVM Cancun, `bytecode_hash = "none"`),
/// pinned exactly as `DrandSourcePins` pins the DrandSource:
/// - `ADDRESS_*`: CREATE2(`DEPLOYER`, `SALT`, `INIT_CODE_HASH`) through the canonical deterministic deployer, so the
///   init code and an empty storage are fixed (a storage-poisoned twin has the code hash but another address);
/// - `CODE_HASH_*`: its EXTCODEHASH (an EIP-7702 delegation at the address would hash differently).
/// The source has no constructor input and names the DrandSource by a constant, so both chains share one address and
/// one code hash. `test/box/backup/BackedSourcePin.t.sol` compares every value with the compiled source, so a change to
/// the source, its imports or the compiler settings fails there until these lines are updated (the failing assertion
/// prints the new value). Anyone may send the deployment; its result is always the same contract.
library BackedSourcePins {
    /// @notice The canonical deterministic deployer: calldata = salt ‖ init code, CREATE2 with that salt.
    address internal constant DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// @notice The deployment salt.
    bytes32 internal constant SALT = keccak256("squarehole.box.v1.BoxBackedSource");
    /// @notice keccak256 of `BoxBackedSource`'s creation code (no constructor arguments).
    bytes32 internal constant INIT_CODE_HASH = 0x415eb6674eb7b0419c721fda0113ef5a0ad3cdbd9706901239a4421f7d6ed1bb;

    address internal constant ADDRESS_MAINNET = 0x4FE27aE2810DAdA5F2f0f425F6623FdbE6A321fb;
    address internal constant ADDRESS_SEPOLIA = 0x4FE27aE2810DAdA5F2f0f425F6623FdbE6A321fb;
    bytes32 internal constant CODE_HASH_MAINNET = 0x7b3be4b9531713d98f065160d3c2dd2f517a0d5203672d8cd3df590d82f2ffa3;
    bytes32 internal constant CODE_HASH_SEPOLIA = 0x7b3be4b9531713d98f065160d3c2dd2f517a0d5203672d8cd3df590d82f2ffa3;

    /// @notice The pinned source and its code hash on `chainId`; zeros on every chain but 1 and 11155111.
    function pinned(uint256 chainId) internal pure returns (address source, bytes32 codeHash) {
        if (chainId == 1) return (ADDRESS_MAINNET, CODE_HASH_MAINNET);
        if (chainId == 11_155_111) return (ADDRESS_SEPOLIA, CODE_HASH_SEPOLIA);
        return (address(0), bytes32(0));
    }

    /// @notice Whether `source` is this chain's pinned deployment: its address and its code hash. False elsewhere.
    function isPinned(address source) internal view returns (bool) {
        (address at, bytes32 codeHash) = pinned(block.chainid);
        return at != address(0) && source == at && source.codehash == codeHash;
    }
}
