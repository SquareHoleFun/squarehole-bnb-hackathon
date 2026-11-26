// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";
import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxFactoryV1} from "../../../../src/box/BoxFactoryV1.sol";
import {BoxFactoryV1Planner} from "../../../../src/box/BoxFactoryV1Planner.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxHookExtension} from "../../../../src/box/BoxHookExtension.sol";
import {BoxItemStream} from "../../../../src/box/BoxItemStream.sol";
import {BoxLaunchRouter} from "../../../../src/box/BoxLaunchRouter.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxReceiverExtension} from "../../../../src/box/BoxReceiverExtension.sol";
import {BoxRegistry} from "../../../../src/box/BoxRegistry.sol";
import {BoxRoyaltyRouter} from "../../../../src/box/BoxRoyaltyRouter.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {CoreBox0Kit, CoreImpls} from "./CoreBox0Kit.sol";
import {CoreBuildCode} from "./CoreBuildCode.sol";

/// @notice The post-deploy verifier's code check (`test_BC012_theVersionIsThisBuildsCode`, review of the rehearsal
/// build, finding 2), checked itself on a version deployed here by `CoreBox0Kit` (the deploy script's steps): every
/// contract of the version is this build's code with only its immutables masked; a byte changed anywhere else, a
/// longer code or an artifact of another compilation is caught; the masked bytes are exactly the immutables'. Runs under
/// both profiles (each against its own build).
contract CoreBuildCodeTest is Test {
    CoreBox0Kit internal kit;
    CoreImpls internal v;

    function setUp() public {
        kit = new CoreBox0Kit();
        kit.setUpWorld();
        v = kit.impls();
    }

    function _all() internal view returns (address[14] memory at, string[14] memory names, bytes[14] memory codes) {
        at = [
            v.coordinator,
            v.hook,
            v.hookExtension,
            v.launchRouter,
            v.receiver,
            v.receiverExtension,
            v.collection,
            v.vault,
            v.tickets,
            v.royaltyRouter,
            v.itemStream,
            v.planner,
            v.factory,
            v.registry
        ];
        names = [
            "BoxCoordinator",
            "BoxHook",
            "BoxHookExtension",
            "BoxLaunchRouter",
            "BoxReceiver",
            "BoxReceiverExtension",
            "BoxCollection",
            "BoxVault",
            "BoxTickets",
            "BoxRoyaltyRouter",
            "BoxItemStream",
            "BoxFactoryV1Planner",
            "BoxFactoryV1",
            "BoxRegistry"
        ];
        codes = [
            type(BoxCoordinator).creationCode,
            type(BoxHook).creationCode,
            type(BoxHookExtension).creationCode,
            type(BoxLaunchRouter).creationCode,
            type(BoxReceiver).creationCode,
            type(BoxReceiverExtension).creationCode,
            type(BoxCollection).creationCode,
            type(BoxVault).creationCode,
            type(BoxTickets).creationCode,
            type(BoxRoyaltyRouter).creationCode,
            type(BoxItemStream).creationCode,
            type(BoxFactoryV1Planner).creationCode,
            type(BoxFactoryV1).creationCode,
            type(BoxRegistry).creationCode
        ];
    }

    /// Every implementation, the planner, the factory and its registry, deployed by the deploy script's steps, are this
    /// build's code: the same length, every byte outside the immutables equal, the artifact this compilation's.
    function test_coreBuildCode_aVersionDeployedFromThisBuildIsItsCode() public view {
        (address[14] memory at, string[14] memory names, bytes[14] memory codes) = _all();
        assertEq(
            keccak256(bytes(CoreBuildCode.outDir())),
            keccak256(bytes(BoxBuildV1.REHEARSAL ? "out-rehearsal" : "out")),
            "the profile's output folder"
        );
        for (uint256 i; i < at.length; ++i) {
            CoreBuildCode.Result memory r = CoreBuildCode.compare(at[i], names[i], codes[i]);
            assertTrue(r.artifactIsThisBuild, string.concat(names[i], ": the artifact is this compilation's"));
            assertTrue(r.sameLength, string.concat(names[i], ": the same length"));
            assertTrue(r.same, string.concat(names[i], ": every byte outside the immutables"));
            assertEq(r.firstDifference, type(uint256).max, names[i]);
            assertEq(r.maskedBytes, 32 * CoreBuildCode.immutableRanges(names[i]).length, "only the immutables masked");
        }
    }

    /// A byte changed outside the immutables is caught where it is: the first byte of the hook implementation, the
    /// middle of the planner (no immutables at all) and the last byte of the factory.
    function test_coreBuildCode_aByteChangedOutsideTheImmutablesIsCaught() public {
        _flipAndExpect(v.hook, "BoxHook", type(BoxHook).creationCode, 0);
        _flipAndExpect(
            v.planner, "BoxFactoryV1Planner", type(BoxFactoryV1Planner).creationCode, v.planner.code.length / 2
        );
        _flipAndExpect(v.factory, "BoxFactoryV1", type(BoxFactoryV1).creationCode, v.factory.code.length - 1);
    }

    function _flipAndExpect(address at, string memory name, bytes memory creation, uint256 offset) internal {
        uint256 snap = vm.snapshotState();
        bytes memory code = at.code;
        code[offset] = bytes1(uint8(code[offset]) ^ 0x01);
        vm.etch(at, code);
        CoreBuildCode.Result memory r = CoreBuildCode.compare(at, name, creation);
        assertTrue(r.artifactIsThisBuild && r.sameLength, name);
        assertFalse(r.same, string.concat(name, ": a changed byte is caught"));
        assertEq(r.firstDifference, offset, string.concat(name, ": at its offset"));
        vm.revertToState(snap);
    }

    /// The masked bytes are exactly the immutables: the artifact holds zeros there and the deployed hook implementation
    /// its constructor's values (so without the mask the codes would differ); a byte changed inside an immutable range is
    /// masked, the byte right after it is caught.
    function test_coreBuildCode_onlyTheImmutablesAreMasked() public {
        CoreBuildCode.ImmutableRef[] memory refs = CoreBuildCode.immutableRanges("BoxHook");
        assertGt(refs.length, 0, "the hook has immutables (the PoolManager, the coordinator, its extension)");
        bytes memory artifact = vm.getDeployedCode("BoxHook.sol:BoxHook");
        bytes memory code = v.hook.code;
        assertEq(artifact.length, code.length);
        assertTrue(keccak256(artifact) != keccak256(code), "unmasked, the deployed code differs (its immutables)");
        for (uint256 i; i < refs.length; ++i) {
            assertEq(refs[i].length, 32, "one word each");
            for (uint256 k = refs[i].start; k < refs[i].start + 32; ++k) {
                assertEq(uint8(artifact[k]), 0, "the artifact holds zeros in an immutable");
            }
        }
        CoreBuildCode.ImmutableRef memory first = refs[0];
        uint256 snap = vm.snapshotState();
        code[first.start + 31] = bytes1(uint8(code[first.start + 31]) ^ 0xff);
        vm.etch(v.hook, code);
        assertTrue(CoreBuildCode.compare(v.hook, "BoxHook", type(BoxHook).creationCode).same, "inside: masked");
        vm.revertToState(snap);
        code = v.hook.code;
        uint256 after_ = first.start + 32;
        bool inAnother;
        for (uint256 i; i < refs.length; ++i) {
            if (after_ >= refs[i].start && after_ < refs[i].start + 32) inAnother = true;
        }
        assertFalse(inAnother, "the byte after the first immutable is code");
        _flipAndExpect(v.hook, "BoxHook", type(BoxHook).creationCode, after_);
    }

    /// A code of another length (one byte appended) and an artifact of another contract are refused.
    function test_coreBuildCode_anotherLengthOrAnotherArtifactIsCaught() public {
        uint256 snap = vm.snapshotState();
        vm.etch(v.vault, bytes.concat(v.vault.code, hex"00"));
        CoreBuildCode.Result memory r = CoreBuildCode.compare(v.vault, "BoxVault", type(BoxVault).creationCode);
        assertFalse(r.sameLength, "a longer code");
        assertFalse(r.same);
        vm.revertToState(snap);
        r = CoreBuildCode.compare(v.vault, "BoxVault", type(BoxTickets).creationCode);
        assertFalse(r.artifactIsThisBuild, "the artifact must be the compilation's own contract");
        r = CoreBuildCode.compare(v.vault, "BoxTickets", type(BoxTickets).creationCode);
        assertFalse(r.same, "another contract's code");
    }
}
