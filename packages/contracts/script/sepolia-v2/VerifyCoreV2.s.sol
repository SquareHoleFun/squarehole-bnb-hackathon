// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Script} from "forge-std/Script.sol";
import {CoreV2ReleaseInventory} from "./CoreV2ReleaseInventory.sol";
import {BoxFactoryV2} from "../../src/box-v2/BoxFactoryV2.sol";
import {BoxReceiverV2} from "../../src/box-v2/BoxReceiverV2.sol";
import {FeeModuleDirectoryV21} from "../../src/box-v2/FeeModuleDirectoryV21.sol";
import {ShopVaultV2, ShopTBurnerV2} from "../../src/box-v2/ShopVaultV2.sol";
import {CoreV2ReleaseBuild} from "../lib/CoreV2ReleaseBuild.sol";

/// @notice No-broadcast receipt check. Only the directory's time-dependent runtime is reproduced locally.
/// The deployed listing registry's RAISE_ETH must also be the release's: a manifest saved from another build's deploy
/// (FOUNDRY_PROFILE=rehearsal) is refused even though its own hashes match (`NotReleaseListing`).
contract VerifyCoreV2 is Script, CoreV2ReleaseInventory, CoreV2ReleaseBuild {
    error ManifestMismatch();
    error DirectoryCodeHashMismatch(address directory, bytes32 expected, bytes32 actual);
    event ReleaseCodeVerified(address factory, bytes32 versionCodeHash, uint256 parts);
    event DirectoryCodeVerified(address directory, uint256 creationTime, bytes32 codeHash);
    event ShopBurnSinkVerified(address burnSink, bytes32 codeHash);

    /// @notice Anyone can verify a founder's saved deployment manifest; no broadcast or private input.
    function run() external {
        string memory json = vm.readFile(vm.envString("CORE_V2_MANIFEST"));
        address factory = verify(json);
        emit ReleaseCodeVerified(factory, BoxFactoryV2(factory).versionCodeHash(), 42);
    }

    /// @notice Anyone checks the exact chain, roles, supporting runtimes and immutable Safe destinations.
    /// This does not certify Safe signatures, explorer source verification, receipts or live waits.
    function verify(string memory json) public returns (address) {
        if (
            keccak256(bytes(vm.parseJsonString(json, ".format"))) != keccak256("squarehole.core-v2-release/2")
                || vm.parseUint(vm.parseJsonString(json, ".chainId")) != block.chainid
        ) revert ManifestMismatch();
        BoxFactoryV2 f = BoxFactoryV2(vm.parseJsonAddress(json, ".factory"));
        address[] memory expected = vm.parseJsonAddressArray(json, ".parts");
        bytes32[] memory hashes = vm.parseJsonBytes32Array(json, ".partCodeHashes");
        if (expected.length != 42 || hashes.length != 42) revert ManifestMismatch();
        // Authenticate all deterministic parts before calling them. Part 29 is reproduced below, never skipped.
        for (uint256 i; i < expected.length; ++i) {
            if (i == 29) continue;
            if (expected[i].codehash != hashes[i]) {
                revert CodeHashMismatch(expected[i], hashes[i], expected[i].codehash);
            }
        }
        // All saved library hashes passed above; this executable may have entirely different links.
        (address[] memory actual,,) = _inventory(f, [
            expected[27], expected[34], expected[35], expected[36], expected[37], expected[38], expected[39], expected[40]
        ]);
        for (uint256 i; i < actual.length; ++i) {
            if (actual[i] != expected[i]) revert ManifestMismatch();
        }
        if (f.versionCodeHash() != vm.parseJsonBytes32(json, ".versionCodeHash")) revert ManifestMismatch();
        address[] memory implementations = vm.parseJsonAddressArray(json, ".implementations");
        bytes32[] memory implementationHashes = vm.parseJsonBytes32Array(json, ".implementationCodeHashes");
        if (implementations.length != 24 || implementationHashes.length != 24) revert ManifestMismatch();
        for (uint256 i; i < 24; ++i) {
            address part = f.implementation(i);
            if (
                part != implementations[i]
                    || (part == address(0) ? bytes32(0) : part.codehash) != implementationHashes[i]
            ) {
                revert ManifestMismatch();
            }
        }
        BoxReceiverV2 r = BoxReceiverV2(f.implementation(5));
        if (
            r.FIT_SAFE() != vm.parseJsonAddress(json, ".safes.fit.address")
                || r.PLATFORM_SAFE() != vm.parseJsonAddress(json, ".safes.platform.address")
        ) revert ManifestMismatch();
        _requireReleaseRaiseConstant(f.listingRegistry());
        _checkDirectory(expected, vm.parseJsonAddress(json, ".safes.platform.address"));
        address sink = address(ShopVaultV2(f.implementation(21)).burnSink());
        // The current burner has no arguments or immutables. A reference CREATE also covers future immutables.
        bytes32 sinkHash = address(new ShopTBurnerV2()).codehash;
        if (sink.codehash != sinkHash) revert CodeHashMismatch(sink, sinkHash, sink.codehash);
        emit ShopBurnSinkVerified(sink, sinkHash);
        return address(f);
    }

    /// @dev The authenticated receiver/inventory supplies the four modules; directory storage supplies only time.
    /// Role rotation, withdrawals and later registrations remain valid; the four original rows cannot be replaced.
    function _checkDirectory(address[] memory parts, address platformSafe) private {
        FeeModuleDirectoryV21 directory = FeeModuleDirectoryV21(parts[29]);
        (,, uint64 readyAt,) = directory.record(0);
        uint256 delay = directory.DELAY();
        if (readyAt < delay) revert ManifestMismatch();
        uint256 createdAt = uint256(readyAt) - delay;
        uint256 now_ = vm.getBlockTimestamp();
        if (createdAt > now_) revert ManifestMismatch();
        address[] memory modules = new address[](4);
        for (uint256 i; i < 4; ++i) modules[i] = parts[30 + i];
        vm.warp(createdAt);
        FeeModuleDirectoryV21 reproduced = new FeeModuleDirectoryV21(platformSafe, modules);
        vm.warp(now_);
        bytes32 expectedHash = address(reproduced).codehash;
        if (parts[29].codehash != expectedHash) {
            revert DirectoryCodeHashMismatch(parts[29], expectedHash, parts[29].codehash);
        }
        for (uint32 i; i < 4; ++i) {
            (address module, bytes32 hash, uint64 rowReadyAt,) = directory.record(i);
            if (module != modules[i] || hash != modules[i].codehash || rowReadyAt != readyAt) revert ManifestMismatch();
        }
        emit DirectoryCodeVerified(parts[29], createdAt, expectedHash);
    }
}
