// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CQ11WDeploymentFixture} from "../m1-64/CQ11WDeployment.t.sol";
import {BoxFactoryV2} from "../../../src/box-v2/BoxFactoryV2.sol";
import {FeeModuleDirectoryV21} from "../../../src/box-v2/FeeModuleDirectoryV21.sol";
import {ShopVaultV2, ShopTBurnerV2} from "../../../src/box-v2/ShopVaultV2.sol";
import {VerifyCoreV2} from "../../../script/sepolia-v2/VerifyCoreV2.s.sol";
import {CoreV2ReleaseInventory} from "../../../script/sepolia-v2/CoreV2ReleaseInventory.sol";

contract SepoliaReleaseTimeTest is CQ11WDeploymentFixture {
    event DirectoryCodeVerified(address directory, uint256 creationTime, bytes32 codeHash);
    event ShopBurnSinkVerified(address burnSink, bytes32 codeHash);

    function test_RT1_savedSimulationVerifiesLaterDeployment() public {
        uint256 snapshot = vm.snapshotState();
        (, string memory savedPlan) = _run();
        bytes32[] memory simulated = vm.parseJsonBytes32Array(savedPlan, ".partCodeHashes");
        assertTrue(vm.revertToState(snapshot));
        vm.warp(vm.getBlockTimestamp() + 744);
        uint256 createdAt = vm.getBlockTimestamp();
        (BoxFactoryV2 f, string memory deployed) = _run();
        address[] memory parts = vm.parseJsonAddressArray(deployed, ".parts");
        assertEq(parts, vm.parseJsonAddressArray(savedPlan, ".parts"));
        for (uint256 i; i < parts.length; ++i) {
            if (i == 29) assertNotEq(parts[i].codehash, simulated[i]);
            else assertEq(parts[i].codehash, simulated[i]);
        }
        vm.warp(createdAt + 7 days);
        VerifyCoreV2 verifier = new VerifyCoreV2();
        vm.expectEmit(false, false, false, true, address(verifier));
        emit DirectoryCodeVerified(parts[29], createdAt, parts[29].codehash);
        address sink = address(ShopVaultV2(f.implementation(21)).burnSink());
        vm.expectEmit(false, false, false, true, address(verifier));
        emit ShopBurnSinkVerified(sink, address(new ShopTBurnerV2()).codehash);
        assertEq(verifier.verify(savedPlan), address(f));
        assertEq(vm.getBlockTimestamp(), createdAt + 7 days, "restore local clock");
    }

    function test_RT2_planLabelsSimulatedDirectoryTime() public {
        (, string memory plan) = _run();
        assertEq(vm.parseJsonString(plan, ".timeDependentCodeHash.part"), "29");
        assertEq(vm.parseJsonString(plan, ".timeDependentCodeHash.name"), "FeeModuleDirectoryV21");
        assertEq(vm.parseJsonString(plan, ".timeDependentCodeHash.simulatedCreationTime"), vm.toString(vm.getBlockTimestamp()));
        assertEq(vm.parseJsonString(plan, ".format"), "squarehole.core-v2-release/2");
    }

    function test_RT3_directoryReadyAtMustReproduceRuntime() public {
        (, string memory plan) = _run();
        address[] memory parts = vm.parseJsonAddressArray(plan, ".parts");
        address[] memory modules = _modules(parts, 4);
        vm.warp(vm.getBlockTimestamp() + 1);
        FeeModuleDirectoryV21 other = new FeeModuleDirectoryV21(address(platform), modules);
        bytes32 referenceHash = parts[29].codehash;
        vm.etch(parts[29], address(other).code);
        _expectDirectoryMismatch(plan, parts[29], referenceHash);
    }

    function test_RT4_directoryInitialCountMustBeFour() public {
        (, string memory plan) = _run();
        address[] memory parts = vm.parseJsonAddressArray(plan, ".parts");
        FeeModuleDirectoryV21 other = new FeeModuleDirectoryV21(address(platform), _modules(parts, 3));
        bytes32 referenceHash = parts[29].codehash;
        vm.etch(parts[29], address(other).code);
        _expectDirectoryMismatch(plan, parts[29], referenceHash);
    }

    function test_RT5_directoryModuleListMustMatchRelease() public {
        (, string memory plan) = _run();
        address[] memory parts = vm.parseJsonAddressArray(plan, ".parts");
        // Record[] starts at slot 0; each record has address, hash, packed readyAt/withdrawn.
        uint256 first = uint256(keccak256(abi.encode(uint256(0))));
        vm.store(parts[29], bytes32(first), bytes32(uint256(uint160(parts[31]))));
        vm.store(parts[29], bytes32(first + 1), parts[31].codehash);
        VerifyCoreV2 verifier = new VerifyCoreV2();
        vm.expectRevert(VerifyCoreV2.ManifestMismatch.selector);
        verifier.verify(plan);
    }

    function test_RT6_burnSinkMustMatchCompiledRuntime() public {
        (BoxFactoryV2 f, string memory plan) = _run();
        address sink = address(ShopVaultV2(f.implementation(21)).burnSink());
        bytes32 expected = sink.codehash;
        vm.etch(sink, hex"00");
        VerifyCoreV2 verifier = new VerifyCoreV2();
        vm.expectRevert(abi.encodeWithSelector(CoreV2ReleaseInventory.CodeHashMismatch.selector, sink, expected, sink.codehash));
        verifier.verify(plan);
    }

    function _modules(address[] memory parts, uint256 n) private pure returns (address[] memory modules) {
        modules = new address[](n);
        for (uint256 i; i < n; ++i) modules[i] = parts[30 + i];
    }

    function _expectDirectoryMismatch(string memory plan, address directory, bytes32 referenceHash) private {
        VerifyCoreV2 verifier = new VerifyCoreV2();
        vm.expectRevert(abi.encodeWithSelector(
            bytes4(keccak256("DirectoryCodeHashMismatch(address,bytes32,bytes32)")), directory, referenceHash, directory.codehash
        ));
        verifier.verify(plan);
    }
}
