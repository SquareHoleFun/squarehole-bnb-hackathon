// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {S8World, BoxItemStreamHarness} from "./BoxS8World.sol";

contract ArchitectureReview20261007 is Test {
    function test_lateDrawMustNotReceiveFeesEarnedBeforeItsRequest() public {
        S8World w = new S8World(20, 1);
        w.boot();
        w.graduate(keccak256("review.word"));
        BoxItemStreamHarness s = w.stream();
        for (uint256 i; i < 10; ++i) {
            w.draw();
        }
        w.fee(3000); // 13/15 of 3000 / 20 = index 130.
        assertEq(s.index(), 130);
        w.draw(); // New drawer has earned nothing at index 130.
        for (uint256 i; i < 10; ++i) {
            w.openDraw(address(0xA11CE));
        }
        uint256 lateId = w.openDraw(address(0xB0B));
        (, uint256 lateOwed) = s.pendingOf(lateId);
        emit log_named_uint("late draw received prior earnings", lateOwed);
        emit log_named_uint("documented half-spread bound", 65);
        assertEq(lateOwed, 0, "earnings must start at this draw's request");
    }
}
