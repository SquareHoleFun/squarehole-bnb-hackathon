// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {FailureTableV2, HeldKind, FailRoute} from "../../../src/box-v2/interfaces/FailureTableV2.sol";
contract CQ110FailureShapeTest is Test {
    function test_failureDestinationIdsStayFixed() public pure {
        assertEq(uint256(FailRoute.CLOSING_POOL), 1);
        assertEq(uint256(FailRoute.FIT), 2);
        assertEq(uint256(FailRoute.PLATFORM), 6);
        assertEq(uint256(FailRoute.RESERVED_CONVERSION_SAFE), 7);
        assertEq(uint256(FailRoute.LOCKED), 8);
        assertEq(uint256(HeldKind.BURN_BRANCH), 14);
        assertEq(uint256(HeldKind.SIDE_CARRY), 22);
    }
    function test_burnAndItemsJoinClaimReserveStaysFees() public pure {
        assertEq(uint256(FailureTableV2.routeOf(HeldKind.DEPTH_BRANCH, true)), uint256(FailRoute.CLOSING_POOL));
        assertEq(uint256(FailureTableV2.routeOf(HeldKind.SIDE_CARRY, true)), uint256(FailRoute.CLOSING_POOL));
        assertEq(uint256(FailureTableV2.routeOf(HeldKind.BURN_BRANCH, true)), uint256(FailRoute.CLOSING_POOL));
        assertEq(uint256(FailureTableV2.routeOf(HeldKind.ITEMS_CREDITS, true)), uint256(FailRoute.CLOSING_POOL));
        assertEq(uint256(FailureTableV2.routeOf(HeldKind.GRADUATION_RESERVE, true)), uint256(FailRoute.AS_BOOKED));
        // RC5-C: non-price royalties remain in the router until the creator payee claims, in every phase.
        assertEq(uint256(FailureTableV2.routeOf(HeldKind.ROYALTIES, false)), uint256(FailRoute.CREATOR_PAYEE));
        assertEq(uint256(FailureTableV2.routeOf(HeldKind.ROYALTIES, true)), uint256(FailRoute.CLOSING_POOL));
    }
}
