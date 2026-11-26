// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {DeployCoreV1} from "../../../script/DeployCoreV1.s.sol";
import {DeployCoreV1Harness} from "../s7/BoxFactoryV1Deploy.t.sol";
import {CommittedSpecFiles} from "../conformance/core/CommittedSpecFiles.sol";

/// @notice SH-SEP-BOX0-SAFE: box 0's fourth Sepolia spec file, script/config/box0-spec.11155111.rehearsal.sepolia-safe.json
/// (written by packages/box-spec/src/sepolia-box0-spec.test.ts): the rehearsal build's file (F78) with the founder's
/// Sepolia platform Safe as marketplaceOwner, because core v2's deploy refuses a box 0 whose receiver's platformSafe()
/// is not its 1-of-1 platform Safe (DeployCoreV2: WrongPlatformSafe). Runs under both build profiles:
/// - the file decodes to a spec whose hash is its `.specHash`, for Sepolia and the rehearsal build, its `.platform` the
///   spec's marketplaceOwner, which is neither the testnet deployer nor the mainnet Safe's address (their own files);
/// - it is box0-spec.11155111.rehearsal.json with the platform changed and nothing else (byte for byte), and the
///   encoding's pin (the generator's PINNED_EXAMPLE_HASH, computed there by viem) is Solidity's ABI encoding too;
/// - the deploy script reads it on Sepolia under the rehearsal build only, with the platform the file names only
///   (PlatformSafeMismatch otherwise), never on mainnet; the planner takes it as template 0 for that platform only;
/// - the post-deploy verifier finds it among the committed spec files (CommittedSpecFiles), as it finds the other three.
/// forge-config: default.evm_version = "osaka"
contract SepoliaBox0SafeSpecTest is Test {
    string internal constant SAFE_FILE = "script/config/box0-spec.11155111.rehearsal.sepolia-safe.json";
    string internal constant REHEARSAL_FILE = "script/config/box0-spec.11155111.rehearsal.json";
    uint256 internal constant SEPOLIA = 11_155_111;
    address internal constant TESTNET_DEPLOYER = 0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE;
    /// @notice The committed file's platform: the founder's Sepolia platform Safe, written 2026-10-20 (SH-V21-RC7-INT open
    /// item 54; a 1-of-1 Safe 1.5.0 on Sepolia). Change this pin with the file (the generator's example,
    /// 0x00000000000000000000000000000000005aFE01, until then: Step 0 refuses it, it has no code on Sepolia).
    address internal constant COMMITTED_PLATFORM = 0x9432380a67745b453886698F9539aC035DF80B34;
    /// @notice The generator's encoding pin: the Safe file's spec at 2026-10-06 11:00 UTC with this test Safe.
    address internal constant PIN_SAFE = 0x5afe5afE5afE5afE5afE5aFe5aFe5Afe5Afe5AfE;
    bytes32 internal constant PINNED_EXAMPLE_HASH = 0x243ba12e15e92dbce83d7e60188667fd78e6a0efaf0c2d9d5b8b9b30a6e54bd5;

    function _file(string memory path) internal view returns (BoxSpecV1.BoxSpec memory s, bytes32 hash, address p) {
        string memory json = vm.readFile(path);
        bytes memory encoded = vm.parseJsonBytes(json, ".encoded");
        s = abi.decode(encoded, (BoxSpecV1.BoxSpec));
        hash = vm.parseJsonBytes32(json, ".specHash");
        p = vm.parseJsonAddress(json, ".platform");
        assertEq(keccak256(encoded), hash, "the file's spec hash is keccak256(.encoded)");
        assertEq(keccak256(abi.encode(s)), hash, "canonical ABI encoding");
        assertEq(vm.parseJsonUint(json, ".chainId"), SEPOLIA);
    }

    function test_theSafeFileIsTheRehearsalFileWithTheSafeAsPlatformOnly() public view {
        (BoxSpecV1.BoxSpec memory s, bytes32 h, address p) = _file(SAFE_FILE);
        (BoxSpecV1.BoxSpec memory r, bytes32 hr, address pr) = _file(REHEARSAL_FILE);
        string memory json = vm.readFile(SAFE_FILE);
        assertEq(keccak256(bytes(vm.parseJsonString(json, ".build"))), keccak256("rehearsal"), "the rehearsal build's");
        assertEq(keccak256(bytes(vm.parseJsonString(json, ".z3"))), keccak256("sepolia-safe"));
        assertEq(s.marketplaceOwner, p, "the file's platform is the spec's");
        assertEq(p, COMMITTED_PLATFORM, "the committed platform (the pin changes with the file)");
        assertTrue(p != address(0) && p != TESTNET_DEPLOYER && p != BoxSpecV1.PLATFORM_SAFE_MAINNET, "its own platform");
        assertEq(pr, TESTNET_DEPLOYER);
        assertTrue(h != hr, "the platform is part of the spec");
        assertEq(s.openAt, r.openAt, "the same opening time");
        assertEq(s.raise, r.raise, "the rehearsal raise");
        r.marketplaceOwner = p;
        assertEq(keccak256(abi.encode(r)), h, "the rehearsal file with the platform changed, nothing else");
        // The generator's pin, recomputed here: Solidity's ABI encoding of the same spec.
        r.marketplaceOwner = PIN_SAFE;
        r.openAt = 1_791_284_400;
        assertEq(keccak256(abi.encode(r)), PINNED_EXAMPLE_HASH, "the generator's PINNED_EXAMPLE_HASH");
        console.log("SAFE-SPEC|spec hash (committed platform)", vm.toString(h));
    }

    /// The deploy script: the Safe file on Sepolia under the rehearsal build, with its own platform only; never under the
    /// full-size build, never on mainnet. The planner: template 0 for its platform, NotTemplate0 for any other.
    function test_theDeployScriptReadsTheSafeFileForItsBuildAndPlatformOnly() public {
        DeployCoreV1Harness h = new DeployCoreV1Harness();
        (BoxSpecV1.BoxSpec memory s, bytes32 hash, address p) = _file(SAFE_FILE);
        vm.warp(h.GLAMSTERDAM_SEPOLIA() - 1 days);
        vm.chainId(SEPOLIA);
        if (BoxBuildV1.REHEARSAL) {
            DeployCoreV1.Plan memory plan = h.planFor(TESTNET_DEPLOYER, p, TESTNET_DEPLOYER, SAFE_FILE, false);
            assertEq(keccak256(abi.encode(plan.spec)), hash, "the script's spec is the file's");
            assertEq(plan.platformSafe, p, "the factory's platform: the Safe");
            assertEq(plan.box0Creator, TESTNET_DEPLOYER);
            vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.PlatformSafeMismatch.selector, p, TESTNET_DEPLOYER));
            h.planFor(TESTNET_DEPLOYER, TESTNET_DEPLOYER, TESTNET_DEPLOYER, SAFE_FILE, false);
            (BoxSpecV1.BoxSpec memory r,, address pr) = _file(REHEARSAL_FILE);
            vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.PlatformSafeMismatch.selector, pr, p));
            h.planFor(TESTNET_DEPLOYER, p, TESTNET_DEPLOYER, REHEARSAL_FILE, false);
            (uint16 reason, uint16 field) = BoxSpecV1.validate(s, BoxSpecV1.contextV1());
            assertEq(reason, BoxSpecV1.REASON_OK, string.concat("field ", vm.toString(field)));
            assertEq(r.raise, s.raise);
        } else {
            vm.expectRevert(
                abi.encodeWithSelector(DeployCoreV1.SpecFileForAnotherBuild.selector, "rehearsal", "mainnet")
            );
            h.planFor(TESTNET_DEPLOYER, p, TESTNET_DEPLOYER, SAFE_FILE, false);
        }
        vm.chainId(1);
        if (BoxBuildV1.REHEARSAL) {
            vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.RehearsalBuildOnMainnet.selector, "rehearsal"));
        } else {
            vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.SpecFileForAnotherChain.selector, SEPOLIA, 1));
        }
        h.planFor(TESTNET_DEPLOYER, p, TESTNET_DEPLOYER, SAFE_FILE, false);
    }

    /// The post-deploy verifier (Step 5) finds every committed Sepolia file by its spec hash, the Safe file too.
    function test_theVerifierFindsTheSafeFileAmongTheCommittedFiles() public view {
        string[4] memory names = [
            "script/config/box0-spec.11155111.json",
            "script/config/box0-spec.11155111.safe.json",
            REHEARSAL_FILE,
            SAFE_FILE
        ];
        for (uint256 i; i < names.length; ++i) {
            (, bytes32 hash,) = _file(names[i]);
            assertEq(CommittedSpecFiles.matching("", SEPOLIA, hash), names[i], names[i]);
        }
        assertEq(CommittedSpecFiles.matching("", SEPOLIA, keccak256("no such spec")), "", "none matches");
        assertEq(CommittedSpecFiles.matching(SAFE_FILE, SEPOLIA, _hashOf(REHEARSAL_FILE)), REHEARSAL_FILE, "then the rest");
    }

    function _hashOf(string memory path) internal view returns (bytes32 hash) {
        (, hash,) = _file(path);
    }
}
