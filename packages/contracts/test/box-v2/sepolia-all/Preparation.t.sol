// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {CQ11WDeploymentFixture} from "../m1-64/CQ11WDeployment.t.sol";
import {CoreV2LocalActions} from "../../../script/local/CoreV2LocalActions.sol";
import {PrepareCoreV2Box} from "../../../script/sepolia-v2/PrepareCoreV2Box.s.sol";
import {BoxSpec, AddOn} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {HostileCollection} from "../kit/m2/ShopDoubles.sol";
import {BoxRegistryV2} from "../../../src/box-v2/BoxRegistryV2.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BoxCollectionV2} from "../../../src/box-v2/BoxCollectionV2.sol";

contract SepoliaPreparationTest is CQ11WDeploymentFixture, CoreV2LocalActions {
    /// The every-item tree the Sepolia preparation commits, as before SH-TA-33: ten leaves with `bytes32(id)` pictures.
    bytes32 private constant SEPOLIA_ITEM_ROOT = 0x7a45fe00dd9393da6f5e34aee75ced42d5a9079c62c64f2b7ed19e3dd605dbf2;

    function test_unsignedDataCreatesAllSixRecipesAndLoadsItemChunks() public {
        (localFactory,) = _run();
        localActor = address(0xA11CE);
        vm.deal(localActor, 100 ether);
        localNft = new HostileCollection();
        PrepareCoreV2Box preparation = new PrepareCoreV2Box();
        for (uint8 mode; mode <= 6; ++mode) {
            BoxSpec memory s = _localSpec(mode == 6 ? 4 : mode);
            if (mode == 6) {
                s.artMode = 2;
                s.revealListId = 0;
                s.addOns = new AddOn[](1);
                s.addOns[0] = AddOn(
                    1, abi.encode("Tickets", "TKT", "Draw", "Hidden", '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
                );
            }
            uint256 count = BoxRegistryV2(localFactory.registry()).boxCount();
            string memory json = preparation.prepare(address(localFactory), localActor, s, 0);
            if (mode == 5) assertFalse(vm.keyExistsJson(json, ".tableCall"), "pile must not inherit item calldata");
            assertEq(BoxRegistryV2(localFactory.registry()).boxCount(), count, "prepare never creates");
            bytes memory data = vm.parseJsonBytes(json, ".createData");
            uint256 envelope = vm.parseUint(vm.parseJsonString(json, ".gasLimit"));
            assertEq(envelope, 16_500_000 + 21_000 + data.length * 40, "creation keeps the full measured entry budget");
            assertLe(envelope, 16_660_680, "creation envelope cannot rise");
            assertLe(envelope, 16_777_216);
            uint256 value = vm.parseUint(vm.parseJsonString(json, ".nativeValue"));
            assertEq(keccak256(data), vm.parseJsonBytes32(json, ".calldataHash"));
            vm.prank(localActor);
            // A transaction pays intrinsic before entering the factory. The test's outer CALL
            // has ample EIP-150 reserve; production's own nested pre-checks remain unchanged.
            (bool ok, bytes memory result) =
                address(localFactory).call{value: value, gas: envelope - 21_000 - data.length * 40}(data);
            if (!ok) {
                assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
            }
            (, address b,) = abi.decode(result, (uint256, address, address));
            assertEq(b, vm.parseJsonAddress(json, ".coordinator"));
            (int24 low, int24 high,) = IBoxHookV2(BoxCoordinatorV2(b).hook()).curve();
            assertEq(vm.parseUint(vm.parseJsonString(json, ".curveBuyLimit")), TickMath.getSqrtPriceAtTick(low));
            assertEq(vm.parseUint(vm.parseJsonString(json, ".curveSellLimit")), TickMath.getSqrtPriceAtTick(high));
            assertEq(BoxRegistryV2(localFactory.registry()).boxCount(), count + 1);
            if (mode == 4 || mode == 6) {
                bytes memory chunk = vm.parseJsonBytes(json, ".tableCall");
                vm.prank(localActor);
                (ok,) = b.call(chunk);
                assertTrue(ok);
                if (!BoxCoordinatorV2(b).gateOpen()) {
                    chunk = vm.parseJsonBytes(json, ".textsCall");
                    vm.prank(localActor);
                    (ok,) = b.call(chunk);
                    assertTrue(ok);
                }
                assertTrue(BoxCoordinatorV2(b).gateOpen());
                if (mode == 4) {
                    bytes[] memory reveals = abi.decode(vm.parseJson(json, ".revealCalls"), (bytes[]));
                    BoxCollectionV2 collection = BoxCollectionV2(BoxCoordinatorV2(b).collection());
                    assertEq(collection.revealRoot(), SEPOLIA_ITEM_ROOT, "XR-SH-TA-33 F1: the synthetic item tree");
                    for (uint256 i; i < reveals.length; ++i) {
                        vm.prank(localActor);
                        (ok,) = address(collection).call(reveals[i]);
                        assertTrue(ok);
                        (bool revealed,, bytes32 image,) = collection.traitsOf(i + 1);
                        assertTrue(revealed);
                        assertEq(image, bytes32(i + 1), "synthetic test art, not a local catalogue picture");
                    }
                }
            }
        }
    }

    /// XR-SH-TA-33 F1: the Sepolia preparation itself (PrepareCoreV2Box.run, kind 4) keeps the synthetic item tree, never
    /// the local stack's catalogue pictures (CoreV2LocalPictures). Its root is the one before SH-TA-33, and every prepared
    /// proof, in the reveal calls and in openDraw's tuples, authenticates to the prepared spec's revealRoot.
    function test_everyItemPreparationKeepsItsRootAndEveryProofVerifies() public {
        (localFactory,) = _run();
        // run() takes its inputs from the environment: set each one it reads for kind 4, so no shell value leaks in.
        vm.setEnv("CORE_V2_FACTORY", vm.toString(address(localFactory)));
        vm.setEnv("CORE_V2_CREATOR", vm.toString(address(0xA11CE)));
        vm.setEnv("CORE_V2_KIND", "4");
        vm.setEnv("CORE_V2_SHOP_COLLECTION", vm.toString(address(0)));
        vm.setEnv("CORE_V2_LISTING", "0");
        vm.setEnv("CORE_V2_INSIDE_POLICY", "1");
        vm.setEnv("CORE_V2_HIDDEN", "false");
        vm.setEnv("CORE_V2_SALT_START", "0");
        vm.setEnv("CORE_V2_WRITE_MANIFEST", "false");
        string memory json = new PrepareCoreV2Box().run();
        BoxSpec memory s = abi.decode(vm.parseJsonBytes(json, ".specEncoded"), (BoxSpec));
        assertEq(s.revealRoot, SEPOLIA_ITEM_ROOT, "the Sepolia preparation keeps its item tree");
        // The whole-release rehearsals (SepoliaAllRehearsal) take their every-item spec from the same recipe.
        assertEq(_localSpec(4).revealRoot, SEPOLIA_ITEM_ROOT, "and so do the rehearsals");
        assertEq(s.n, 10);
        assertEq(s.firstId, 1);
        bytes[] memory reveals = vm.parseJsonBytesArray(json, ".revealCalls");
        string[] memory tuples = vm.parseJsonStringArray(json, ".revealTuples");
        assertEq(reveals.length, 10);
        assertEq(tuples.length, 10);
        for (uint256 i; i < 10; ++i) {
            assertEq(bytes4(reveals[i]), BoxCollectionV2.reveal.selector);
            (uint256 id, uint128 traits, bytes32 image, bytes32 avatar, bytes32 model, bytes32 salt, bytes32[] memory proof)
            = abi.decode(_arguments(reveals[i]), (uint256, uint128, bytes32, bytes32, bytes32, bytes32, bytes32[]));
            assertEq(id, s.firstId + i);
            assertEq(image, bytes32(id), "synthetic test art, not a local catalogue picture");
            assertEq(proof.length, 4, "the collection's tree depth for ten items");
            // BoxCollectionV2._verify: from the leaf at id - firstId, hash with each sibling, left or right by the index bit.
            bytes32 node = keccak256(abi.encode(id, traits, image, avatar, model, salt));
            uint256 index = id - s.firstId;
            for (uint256 level; level < proof.length; ++level) {
                node = index & 1 == 0 ? keccak256(abi.encodePacked(node, proof[level]))
                    : keccak256(abi.encodePacked(proof[level], node));
                index >>= 1;
            }
            assertEq(node, s.revealRoot, "each prepared proof authenticates to the prepared root");
            assertEq(tuples[i], _tuple(image, proof), "openDraw's tuple carries the same leaf fields and proof");
        }
    }

    /// The call's ABI arguments, after its four-byte selector.
    function _arguments(bytes memory call) private pure returns (bytes memory args) {
        args = new bytes(call.length - 4);
        for (uint256 i; i < args.length; ++i) {
            args[i] = call[i + 4];
        }
    }

    /// ItemReveal's non-proof fields (no traits, `image`, no avatar, model or salt) and the proof, as the preparation
    /// writes them for openDraw.
    function _tuple(bytes32 image, bytes32[] memory proof) private pure returns (string memory items) {
        string memory zero = vm.toString(bytes32(0));
        items = string.concat("(0,", vm.toString(image), ",", zero, ",", zero, ",", zero, ",[");
        for (uint256 i; i < proof.length; ++i) {
            items = string.concat(items, i == 0 ? "" : ",", vm.toString(proof[i]));
        }
        items = string.concat(items, "])");
    }
}
