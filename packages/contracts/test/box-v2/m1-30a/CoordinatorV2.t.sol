// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M130aBase} from "./M130aBase.sol";
import {CQAAsset} from "../cq11-a/Fixture.sol";
import {ChunkPart} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";

contract M130aCoordinatorTest is M130aBase {
    function test_M130a_BC157_launchPullsExactlyBootstrapAndCreatorBuy() public {
        creatorBuy = RAISE / 100; _make(RAISE);
        assertTrue(router.bootstrapped()); assertTrue(router.creatorBought());
        assertEq(p.balanceOf(address(box)), 0); assertEq(p.allowance(address(box), address(router)), 0);
        assertEq(p.balanceOf(address(router)), 0); assertGt(t.balanceOf(address(this)), 0);
    }
    function test_M130a_BC159_launchRefusals() public {
        vm.expectRevert(); box.launch();
        assertTrue(router.bootstrapped()); assertFalse(box.failed());
    }
    function test_M130a_BC157_ethBoxLaunchTakesExactlyTheValue() public {
        p = CQAAsset(address(0)); _make(RAISE);
        assertEq(address(this).balance, RAISE - RAISE / 10000);
        assertEq(address(box).balance, 0); assertEq(address(router).balance, 0);
    }
    function test_M130a_BC220_tokenOnlyBoxIsOpenAtItsOpenAt() public view {
        assertTrue(box.gateOpen()); assertEq(box.openAt(), box.effectiveOpenAt());
        assertEq(router.openAt(), box.effectiveOpenAt());
    }
    function test_M130a_BC220_gateHoldsUntilTheLastChunk() public {
        holdGate = true; _make(RAISE); assertFalse(box.gateOpen());
        vm.warp(block.timestamp + 100); vm.roll(block.number + 1);
        vm.expectRevert(); _buy(1000);
        box.loadChunk(ChunkPart.Texts, hex"00", bytes32(0));
        assertTrue(box.gateOpen()); assertEq(box.effectiveOpenAt(), block.timestamp + 1);
        assertEq(hook.openAt(), box.effectiveOpenAt()); assertEq(router.openAt(), box.effectiveOpenAt());
    }
    function test_M130a_BC156_viewsAndTheM2Entry() public {
        assertEq(box.bootstrapQ(), RAISE / 10000); assertEq(box.rewardCap(), RAISE / 1000);
        assertFalse(box.starterSetPending()); vm.expectRevert(); box.starterSetLoaded();
        assertEq(box.itemStream(), address(0)); assertEq(box.vault(), address(0)); assertEq(box.boxId(), 1);
    }
}
