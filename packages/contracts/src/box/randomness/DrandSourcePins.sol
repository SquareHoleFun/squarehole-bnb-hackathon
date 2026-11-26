// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title DrandSourcePins (slice S9; read by the factory, S7, for BC-101)
/// @notice The pinned `DrandSource` deployment for chains 1 (mainnet) and 11155111 (Sepolia), as this repository
/// compiles it (`foundry.toml`: solc 0.8.26, optimizer 1,000 runs, EVM Cancun, `bytecode_hash = "none"`):
/// - `ADDRESS_*`: CREATE2(`DEPLOYER`, `SALT`, `INIT_CODE_HASH`) through the canonical deterministic deployer
///   (Arachnid's proxy, the same code on both chains; v2 pins its source the same way, src/v2/genesis/SourceCode.sol:
///   15-16). The address fixes the init code, so the source's storage starts empty: a twin whose own init code writes
///   storage and then installs the same runtime code has the same code hash but another address (security review
///   2026-09-30, the pinning bypass).
/// - `CODE_HASH_*`: its EXTCODEHASH, the second check (an EIP-7702 delegation at the address would hash differently).
/// The source has no constructor input, so both chains share one address and one code hash; they are named per chain
/// because the factory pins per chain and refuses every other chain (`pinned` returns zeros there).
/// `test/box/randomness/DrandSourcePin.t.sol` compares every value with the compiled source, so a change to the
/// source, its imports or the compiler settings fails there until these lines are updated (the failing assertion prints
/// the new value); the opt-in fork suites deploy through the real deployer and check the same on the real chains.
/// Nothing is deployed by this repository's tests or scripts; anyone may send the deployment, and its result is always
/// the same contract.
library DrandSourcePins {
    /// @notice The canonical deterministic deployer: calldata = salt ‖ init code, CREATE2 with that salt.
    address internal constant DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// @notice The deployment salt.
    bytes32 internal constant SALT = keccak256("squarehole.box.v1.DrandSource");
    /// @notice keccak256 of `DrandSource`'s creation code (no constructor arguments).
    bytes32 internal constant INIT_CODE_HASH = 0x62dddec17789f5c5d01823829943fd55e7a5241badaf36c824f11d8b9ef8895b;

    address internal constant ADDRESS_MAINNET = 0xbeEcE13fBdd67D0A696cB7cfD28103Ed37ba79A6;
    address internal constant ADDRESS_SEPOLIA = 0xbeEcE13fBdd67D0A696cB7cfD28103Ed37ba79A6;
    bytes32 internal constant CODE_HASH_MAINNET = 0xb835f0713da5f533832670cd4fa7ba4cc94b93203025f9412d87c9b575a54218;
    bytes32 internal constant CODE_HASH_SEPOLIA = 0xb835f0713da5f533832670cd4fa7ba4cc94b93203025f9412d87c9b575a54218;

    /// @notice The pinned source and its code hash on `chainId`; zeros on every chain but 1 and 11155111.
    function pinned(uint256 chainId) internal pure returns (address source, bytes32 codeHash) {
        if (chainId == 1) return (ADDRESS_MAINNET, CODE_HASH_MAINNET);
        if (chainId == 11_155_111) return (ADDRESS_SEPOLIA, CODE_HASH_SEPOLIA);
        return (address(0), bytes32(0));
    }

    /// @notice Whether `source` is this chain's pinned deployment: its address and its code hash (so code is there, it
    /// is the reviewed code, and it is not a delegation). False on every other chain.
    function isPinned(address source) internal view returns (bool) {
        (address at, bytes32 codeHash) = pinned(block.chainid);
        return at != address(0) && source == at && source.codehash == codeHash;
    }
}
