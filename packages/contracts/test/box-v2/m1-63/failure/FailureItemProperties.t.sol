// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FailureItemsTest} from "../../m1-31/FailureReview2.t.sol";

/// @notice Reuses the existing real vault/ticket/claim fixture and its eight R28B regression checks.
/// The hook and receiver remain scripted boundaries; NFT delivery and all escrow math run production code.
contract FailureItemPropertiesTest is FailureItemsTest {
    function test_I01_terminalReleaseAllItemsBeforeCancellationsStillPaysAllClaims() public {
        _close();
        uint256 quote = frozen;
        vm.warp(realVault.failureWindowEnds() + 30 days + 1);
        tickets.enterTerminal(); // No request or word ever arrived.
        uint256[] memory ids = new uint256[](5);
        for (uint256 i; i < 5; ++i) {
            ids[i] = i + 1;
        }
        realVault.releaseToCreator(ids);
        for (uint256 i; i < 5; ++i) {
            ids[i] = i + 6;
        }
        realVault.releaseToCreator(ids);
        assertEq(items.balanceOf(CREATOR), 10);
        assertEq(realVault.inside(), 0);
        vm.prank(ALICE);
        tickets.handBack(_one(1), quote, block.timestamp);
        vm.prank(ALICE);
        tickets.handBack(_one(2), quote, block.timestamp);
        assertEq(realVault.inside(), 0, "released items must not return to the inside count");
        assertEq(_left(), t.balanceOf(ALICE));
        assertEq(_claim(ALICE, _left(), ALICE), 1000);
        assertEq(_pot(), 0);
        assertEq(_left(), 0);
    }
}
