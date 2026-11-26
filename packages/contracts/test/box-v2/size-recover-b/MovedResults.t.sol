// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {ReferenceReceiverViews} from "./ReferenceViews.sol";

/// @notice SIZE-B2: exact return/revert bytes for moved computations, full-width inputs and boundaries.
contract ReceiverMovedResultsTest is Test {
    ReferenceReceiverViews private old;
    address private views;

    function setUp() public {
        old = new ReferenceReceiverViews();
        views = deployCode("ReceiverViews.sol:ReceiverViews");
    }

    function testFuzz_buyLimit(uint160 spot) public view {
        _same(abi.encodeCall(old.buyLimit, (spot)));
    }

    function test_buyLimitBoundaries() public view {
        uint160[7] memory spots = [
            uint160(0),
            1,
            TickMath.MIN_SQRT_PRICE,
            TickMath.MIN_SQRT_PRICE + 1,
            TickMath.MIN_SQRT_PRICE + 2,
            uint160(1 << 96),
            type(uint160).max
        ];
        for (uint256 i; i < spots.length; ++i) {
            _same(abi.encodeCall(old.buyLimit, (spots[i])));
        }
    }

    function testFuzz_buyResult(int128 p, int128 t, uint256 amount, uint160 limit, uint24 protocolFee) public view {
        _same(abi.encodeCall(old.buyResult, (toBalanceDelta(p, t), amount, limit, protocolFee)));
    }

    function test_buyResultRoundingAndRefusalBoundaries() public view {
        for (uint256 n; n <= 30; ++n) {
            for (uint256 t; t <= n + 1; ++t) {
                _same(
                    abi.encodeCall(
                        old.buyResult,
                        (toBalanceDelta(-int128(int256(n)), int128(int256(t))), n, uint160(1 << 96), uint24(0))
                    )
                );
            }
        }
        _same(abi.encodeCall(old.buyResult, (toBalanceDelta(-100, 98), 99, uint160(1 << 96), uint24(1000))));
        _same(
            abi.encodeCall(
                old.buyResult,
                (
                    toBalanceDelta(type(int128).min, type(int128).max),
                    uint256(1) << 127,
                    type(uint160).max,
                    type(uint24).max
                )
            )
        );
    }

    function _same(bytes memory data) private view {
        (bool expectedOk, bytes memory expected) = address(old).staticcall(data);
        (bool actualOk, bytes memory actual) = views.staticcall(data);
        assertEq(actualOk, expectedOk, "success/revert changed");
        assertEq(actual, expected, "return/revert bytes changed");
    }
}
