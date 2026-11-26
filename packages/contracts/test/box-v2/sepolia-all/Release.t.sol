// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FeeModuleDirectoryV21} from "../../../src/box-v2/FeeModuleDirectoryV21.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";

import {CQ11WDeploymentFixture} from "../m1-64/CQ11WDeployment.t.sol";
import {BoxFactoryV2} from "../../../src/box-v2/BoxFactoryV2.sol";

import {VerifyCoreV2} from "../../../script/sepolia-v2/VerifyCoreV2.s.sol";
import {CoreV2ReleaseInventory} from "../../../script/sepolia-v2/CoreV2ReleaseInventory.sol";
import {ReceiverShopV21} from "../../../src/box-v2/libraries/ReceiverShopV21.sol";
import {ReceiverPendingV21} from "../../../src/box-v2/libraries/ReceiverPendingV21.sol";
import {ReceiverRewardsV21} from "../../../src/box-v2/libraries/ReceiverRewardsV21.sol";
import {RewardAccountingV21} from "../../../src/box-v2/libraries/RewardAccountingV21.sol";
import {ReceiverBooksV21} from "../../../src/box-v2/libraries/ReceiverBooksV21.sol";
import {FeeModuleProofV21} from "../../../src/box-v2/libraries/FeeModuleProofV21.sol";
import {ReceiverModuleCallV21} from "../../../src/box-v2/libraries/ReceiverModuleCallV21.sol";

/// Exposes the verifier executable's links so the regression proves it uses a separate build's addresses,
/// even when production verification no longer references those libraries.
contract IndependentlyLinkedFeeVerifier is VerifyCoreV2 {
    function executableLibraries() external pure returns (address[7] memory) {
        return [
            address(ReceiverPendingV21), address(ReceiverRewardsV21), address(RewardAccountingV21),
            address(ReceiverBooksV21), address(FeeModuleProofV21), address(ReceiverModuleCallV21), address(ReceiverShopV21)
        ];
    }
}

/// The public release entry, with explicit local genesis/Safe read doubles. No broadcast.
contract SepoliaAllReleaseTest is CQ11WDeploymentFixture {
    function test_DIR_DELAY_releaseActionsMatureExactlyOneDayAfterDeployment() public {
        uint256 deployedAt = vm.getBlockTimestamp();
        (BoxFactoryV2 f,) = _run();
        assertEq(vm.getBlockTimestamp(), deployedAt, "deploy never bypasses notice");
        (,, address directory_) = BoxReceiverV2(f.implementation(5)).receiverCode();
        FeeModuleDirectoryV21 directory = FeeModuleDirectoryV21(directory_);
        assertEq(directory.DELAY(), 1 days);
        assertEq(directory.count(), 4);
        for (uint32 id; id < 4; ++id) {
            (address module, bytes32 hash, uint64 readyAt, bool withdrawn) = directory.record(id);
            assertEq(readyAt, deployedAt + 1 days);
            assertEq(module.codehash, hash);
            assertFalse(withdrawn);
            assertFalse(directory.initialSelectable(id));
        }
        vm.warp(deployedAt + 1 days - 1);
        for (uint32 id; id < 4; ++id) {
            assertFalse(directory.initialSelectable(id));
            vm.expectRevert(); directory.resolve(id);
        }
        vm.warp(deployedAt + 1 days);
        for (uint32 id; id < 4; ++id) {
            assertTrue(directory.initialSelectable(id));
            (address module, bytes32 hash) = directory.resolve(id);
            assertEq(module.codehash, hash);
        }
    }

    function test_FM24_savedManifestAcceptsIndependentlyLinkedVerifier() public {
        (BoxFactoryV2 f, string memory manifest) = _run();
        IndependentlyLinkedFeeVerifier checker = new IndependentlyLinkedFeeVerifier();
        assertEq(checker.verify(manifest), address(f), "original verifier accepts saved release");
        address[] memory parts = vm.parseJsonAddressArray(manifest, ".parts");
        string[] memory names = vm.parseJsonStringArray(manifest, ".partNames");
        bytes32[] memory hashes = vm.parseJsonBytes32Array(manifest, ".partCodeHashes");
        bytes memory original = address(checker).code;
        for (uint256 i; i < 7; ++i) {
            // Change one library link at a time, as a separately linked script would.
            address copy = deployCode(string.concat(names[34 + i], ".sol:", names[34 + i]));
            assertNotEq(copy, parts[34 + i]);
            _relink(checker, parts[34 + i], copy);
            assertEq(checker.executableLibraries()[i], copy, "verifier link must actually change");
            assertEq(checker.verify(manifest), address(f), "saved release is independent of verifier links");
            for (uint256 j; j < parts.length; ++j) {
                assertEq(parts[j].codehash, hashes[j], "relinking must not change release code");
            }
            vm.etch(address(checker), original);
        }
    }

    function test_FM25_independentlyLinkedVerifierStillAuthenticatesReleaseLibraries() public {
        (BoxFactoryV2 f, string memory manifest) = _run();
        IndependentlyLinkedFeeVerifier checker = new IndependentlyLinkedFeeVerifier();
        address[] memory parts = vm.parseJsonAddressArray(manifest, ".parts");
        string[] memory names = vm.parseJsonStringArray(manifest, ".partNames");
        for (uint256 i; i < 7; ++i) {
            address copy = deployCode(string.concat(names[34 + i], ".sol:", names[34 + i]));
            _relink(checker, parts[34 + i], copy);
            assertEq(checker.executableLibraries()[i], copy);
        }
        assertEq(checker.verify(manifest), address(f));
        for (uint256 i = 34; i < 41; ++i) {
            bytes memory original = parts[i].code;
            bytes32 expectedHash = parts[i].codehash;
            vm.etch(parts[i], hex"00");
            vm.expectRevert(abi.encodeWithSelector(
                CoreV2ReleaseInventory.CodeHashMismatch.selector, parts[i], expectedHash, parts[i].codehash
            ));
            checker.verify(manifest);
            vm.etch(parts[i], original);
        }
        assertEq(checker.verify(manifest), address(f));
    }

    /// Reproduce link substitution without changing the release, manifest, or verifier logic.
    function _relink(IndependentlyLinkedFeeVerifier checker, address from, address to) private {
        bytes memory runtime = address(checker).code;
        uint256 replaced;
        for (uint256 i; i + 20 <= runtime.length; ++i) {
            bytes20 candidate;
            assembly ("memory-safe") { candidate := mload(add(add(runtime, 32), i)) }
            if (candidate != bytes20(from)) continue;
            for (uint256 j; j < 20; ++j) runtime[i + j] = bytes20(to)[j];
            ++replaced;
            i += 19;
        }
        assertGt(replaced, 0, "no verifier link was replaced");
        vm.etch(address(checker), runtime);
    }

    function test_savedManifestRefusesEveryChangedRuntimeAndWrongChain() public {
        (BoxFactoryV2 f, string memory manifest) = _run();
        VerifyCoreV2 checker = new VerifyCoreV2();
        assertEq(checker.verify(manifest), address(f));
        address[] memory parts = vm.parseJsonAddressArray(manifest, ".parts");
        for (uint256 i; i < parts.length; ++i) {
            bytes memory original = parts[i].code;
            vm.etch(parts[i], hex"00");
            vm.expectRevert();
            checker.verify(manifest);
            vm.etch(parts[i], original);
        }
        assertEq(checker.verify(manifest), address(f));
        vm.chainId(1);
        vm.expectRevert(VerifyCoreV2.ManifestMismatch.selector);
        checker.verify(manifest);
    }

    function test_combinedReleaseIncludesAllMilestonesAndCodeCommitments() public {
        (BoxFactoryV2 f, string memory manifest) = _run();
        uint256[6] memory slots = [uint256(16), 17, 19, 20, 21, 22];
        bytes32[] memory hashes = vm.parseJsonBytes32Array(manifest, ".implementationCodeHashes");
        for (uint256 i; i < slots.length; ++i) {
            address part = f.implementation(slots[i]);
            assertGt(part.code.length, 0, "missing M2/M3 implementation");
            assertLe(part.code.length, 22_118);
            assertEq(hashes[slots[i]], part.codehash);
        }
        address[] memory parts = vm.parseJsonAddressArray(manifest, ".parts");
        bytes32[] memory codeHashes = vm.parseJsonBytes32Array(manifest, ".partCodeHashes");
        assertEq(parts.length, 42, "release includes fixed fee parts and shared CoW handler");
        assertEq(vm.parseJsonStringArray(manifest, ".partNames")[41], "RoyaltyCowHandler");
        (,address callback,) = BoxReceiverV2(f.implementation(5)).receiverCode();
        assertEq(parts[28], callback);
        assertEq(codeHashes.length, parts.length);
        for (uint256 i; i < parts.length; ++i) {
            assertGt(parts[i].code.length, 0);
            assertEq(codeHashes[i], parts[i].codehash);
            assertLe(parts[i].code.length, 22_118);
        }
        assertFalse(vm.parseJsonBool(manifest, ".publicReleaseReady"));
        assertEq(vm.parseJsonString(manifest, ".milestones"), "M1-64,M2-64,M3-64");
    }
}
