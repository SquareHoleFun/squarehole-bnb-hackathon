// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {CoordinatorV2Config, BoxCoordinatorV2Args} from "../../../src/box-v2/libraries/BoxCoordinatorV2Args.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IBoxCoordinatorV2, ChunkPart} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";

// Only the loader's authenticated completion is built here; NFT loading belongs to M2-33.
contract GatePart {
    uint256 public open;
    function setOpen(uint256 at) external { open = at; }
    function approve(address, uint256) external pure returns (bool) { return true; }
    fallback() external { assembly ("memory-safe") { mstore(0, 0) return(0, 128) } }
}
contract StarterGateTest is Test {
    BoxCoordinatorV2 box;
    function _make(bool chunks, bool starter) internal {
        vm.warp(1_000_000);
        IPoolManager pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        address impl = deployCode("BoxCoordinatorV2.sol:BoxCoordinatorV2", abi.encode(pm, address(this)));
        bytes memory nonces = new bytes(24);
        nonces[1] = 0x01; nonces[5] = 0x02; nonces[6] = 0x03;
        if (starter) nonces[19] = 0x04;
        CoordinatorV2Config memory c;
        c.creator = address(this); c.raise = 1e18; c.deadlineDays = 30; c.nonces = bytes24(nonces);
        box = BoxCoordinatorV2(BoxClones.create(BoxClones.initCode(impl, BoxCoordinatorV2Args.encode(c))));
        _deploy(chunks, starter);
    }
    function _deploy(bool chunks, bool starter) private {
        bytes[] memory codes = new bytes[](starter ? 4 : 3);
        for (uint256 i; i < codes.length; ++i) codes[i] = type(GatePart).creationCode;
        bytes32 root = chunks ? keccak256(abi.encodePacked(hex"00", bytes32(0))) : bytes32(0);
        box.deploy(codes, type(GatePart).creationCode, bytes32(0), 0, [root, bytes32(0)], [chunks ? uint256(1) : 0, uint256(0)]);
        box.launch();
    }
    function test_G1_noChunksStillWaitsForStarterAndOnlyLoaderCompletes() public {
        _make(false, true);
        assertFalse(box.gateOpen(), "starter-only gate stays closed");
        assertTrue(box.starterSetPending());
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.NotStarterSetLoader.selector, address(this)));
        box.starterSetLoaded();
        vm.prank(box.starterSetLoader()); box.starterSetLoaded();
        assertFalse(box.starterSetPending());
        assertTrue(box.gateOpen());
        assertEq(box.effectiveOpenAt(), block.timestamp + 1);
    }
    function test_G1_failedOpenRollsBackCompletionAndCanRetryOnlyOnce() public {
        _make(false, true);
        address loader = box.starterSetLoader();
        bytes memory reason = new bytes(4096);
        reason[4095] = 0x42;
        vm.mockCallRevert(box.hook(), abi.encodeWithSignature("setOpen(uint256)", block.timestamp + 1), reason);
        vm.prank(loader); vm.expectRevert(reason); box.starterSetLoaded();
        assertTrue(box.starterSetPending()); assertFalse(box.gateOpen());
        vm.clearMockedCalls();
        vm.prank(loader); box.starterSetLoaded();
        vm.prank(loader); vm.expectRevert(IBoxCoordinatorV2.NOT_OFFERED.selector); box.starterSetLoaded();
        assertFalse(box.starterSetPending()); assertTrue(box.gateOpen());
    }
    function test_G1_bothCompletionOrders() public {
        _make(true, true);
        box.loadChunk(ChunkPart(1), hex"00", bytes32(0));
        assertFalse(box.gateOpen(), "chunks alone cannot open");
        vm.prank(box.starterSetLoader()); box.starterSetLoaded();
        assertTrue(box.gateOpen());
        _make(true, true);
        vm.prank(box.starterSetLoader()); box.starterSetLoaded();
        assertFalse(box.gateOpen(), "starter alone cannot open");
        box.loadChunk(ChunkPart(1), hex"00", bytes32(0));
        assertTrue(box.gateOpen());
    }
    function test_G1_failureNeverReopensAndPlainBoxHasNoStarterGate() public {
        _make(false, true);
        vm.warp(box.openAt() + box.GATE_CAP());
        box.failClosed();
        vm.prank(box.starterSetLoader());
        vm.expectRevert(IBoxCoordinatorV2.AlreadyFailed.selector);
        box.starterSetLoaded();
        assertFalse(box.gateOpen());
        _make(false, false);
        assertTrue(box.gateOpen());
        assertFalse(box.starterSetPending());
        vm.expectRevert(IBoxCoordinatorV2.NOT_OFFERED.selector); box.starterSetLoaded();
    }
}
