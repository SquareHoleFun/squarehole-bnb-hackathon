// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Deployment manifest for the separate add-on. Expected hashes come from the reviewed build,
/// including linked addresses and constructor immutables; getters alone never authenticate an implementation.
struct SetReleaseV2 {
    address factory;
    address registry;
    address listingRegistry;
    address poolManager;
    address weth;
    address fitSafe;
    address platformSafe;
    address[24] implementations;
    bytes32[24] implementationHashes;
    // Registry, listing registry, PoolManager, WETH, hook extension, coordinator views,
    // receiver views, receiver callback, fee directory, then the four built-in fee modules.
    bytes32[13] dependencyHashes;
    bytes32 plannerHash;
    // keccak256(abi.encode(olderRegistries, olderRegistryCodeHashes)), in directory index order.
    bytes32 directoryHash;
}
