// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FailureTestBase} from "./FailureTestBase.sol";
import {ChunkPart} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";

contract FailureReviewTest is FailureTestBase {
    function test_dustTAgainstHugePotUsesFullPrecision() public {
        uint256 pot = uint256(uint128(type(int128).max));
        _fail(pot, 1);
        assertEq(_claim(ALICE, 1, BOB), pot);
    }

    function test_lateDonationsIncreaseOnlyRemainingClaimValue() public {
        _fail(100, 100);
        assertEq(_claim(ALICE, 50, ALICE), 50);
        _fund(p, address(box), 13);
        assertEq(_claim(ALICE, 50, BOB), 63);
    }

    function test_noChunkCanReopenFailedGate() public {
        _box(p, true, false);
        vm.warp(box.openAt() + 14 days);
        box.failClosed();
        vm.expectRevert();
        box.loadChunk(ChunkPart.Table, hex"01", bytes32(0));
        assertFalse(box.gateOpen());
        assertTrue(box.failed());
    }
}
