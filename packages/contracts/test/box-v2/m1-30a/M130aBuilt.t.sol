// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M130aBase} from "./M130aBase.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxRolesV2} from "../../../src/box-v2/interfaces/IBoxRegistryV2.sol";
import {ChunkPart} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {StdCheatsSafe} from "forge-std/StdCheats.sol";
import {DefaultArtifacts} from "../m3-40/DefaultArtifacts.sol";

contract M130aBuiltTest is M130aBase, DefaultArtifacts {
    // The upstream PM compilation can emit this suite too. Deploy the pinned release parts
    // in either test profile so lifecycle checks and the unchanged byte gates inspect the same code.
    function deployCode(string memory what, bytes memory args)
        internal virtual override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what, args); }

    function deployCode(string memory what)
        internal virtual override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what); }

    // C14 retires sampler pokes. Both lifecycle paths work with no sampler role or code.
    function test_M130a_C14_graduationWithoutSampler() public {
        assertEq(box.roleAddress(10), address(0)); _graduate(); assertGt(hook.pairedLiquidity(), 0);
    }
    function test_M130a_C14_graduationCollectsWithoutSampler() public {
        _graduate(); receiver.collect(address(0)); assertGt(receiver.creatorP(), 0);
    }
    function test_M130a_CQ91_tokenIsCreatedBeforeOtherParts() public view {
        assertEq(address(t), vm.computeCreateAddress(address(box), 1));
        assertEq(address(receiver), vm.computeCreateAddress(address(box), 2));
        assertTrue(BoxClones.isCloneOf(address(t), ti));
    }
    function testFuzz_M130a_CQ91_refusesTokenAtLaterNonceBeforeCreating(uint8 nonce) public {
        nonce = uint8(bound(nonce, 2, 127)); bytes memory ns = new bytes(24); ns[BoxRolesV2.ROLE_TOKEN] = bytes1(nonce);
        BoxCoordinatorV2 fresh = _undeployed(bytes24(ns));
        bytes[] memory codes = new bytes[](nonce);
        vm.expectRevert(BoxCoordinatorV2.InvalidNonces.selector);
        fresh.deploy(codes, "", 0, 1, [bytes32(0),bytes32(0)], [uint256(0),uint256(0)]);
        assertEq(vm.getNonce(address(fresh)), 1);
    }
    function test_M130a_BC157_graduateAndClaimRewardInP() public {
        _graduate(); uint256 reward = box.rewardOf(address(this)); assertGt(reward, 0);
        assertEq(box.claimReward(address(0xA11CE)), reward); assertEq(p.balanceOf(address(0xA11CE)), reward);
    }
    function test_M130a_creationIsTheFactorysOnce() public {
        bytes[] memory codes = new bytes[](0);
        vm.expectRevert(BoxCoordinatorV2.AlreadyDeployed.selector);
        box.deploy(codes, "", 0, 1, [bytes32(0),bytes32(0)], [uint256(0),uint256(0)]);
        vm.prank(address(0xBAD)); vm.expectRevert(); box.launch();
    }
    function test_M130a_F80_nowOpensInTheNextBlock() public view {
        assertEq(box.effectiveOpenAt(), block.timestamp + 1); assertEq(hook.openAt(), box.effectiveOpenAt());
    }
    function test_M130a_chunklessBoxRefusesChunks() public {
        vm.expectRevert(); box.loadChunk(ChunkPart.Texts, hex"00", bytes32(0));
    }
    function test_M130a_argumentsReadBack() public view {
        assertEq(box.creator(), address(this)); assertEq(box.q(), address(p)); assertEq(box.raise(), RAISE);
        assertEq(box.hook(), address(hook)); assertEq(box.receiver(), address(receiver)); assertEq(box.launchRouter(), address(router));
    }
    function test_M130a_sizeGates() public view {
        assertLe(ci.code.length, 22118, "coordinator release runtime");
        assertLe(hi.code.length, 22118, "hook release runtime");
        assertLe(ri.code.length, 22118, "receiver release runtime");
        assertLe(li.code.length, 22118, "router release runtime");
    }
    function test_M130a_BC157_pricingTokenReturnSafeAndForced() public {
        _graduate(); uint256 reward = box.rewardOf(address(this));
        vm.prank(address(0xBAD)); vm.expectRevert(); box.claimReward(address(0xBAD));
        assertEq(box.rewardOf(address(this)), reward); assertEq(box.claimReward(address(0xCAFE)), reward);
    }
    function test_M130a_BC157_settleToClaimsExactly() public {
        uint256 before = p.balanceOf(address(trader)); trader.gift(address(p), address(box), 123456);
        assertEq(before - p.balanceOf(address(trader)), 123456); assertEq(_claims(address(box)), 123456);
    }
}
