// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {BoxSwapBoundsV2 as B} from "../../../src/box-v2/libraries/BoxSwapBoundsV2.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {Slot0} from "v4-core/src/types/Slot0.sol";
contract M130aSwapBoundsV2Test is Test {
    function test_M130a_BC166_roomLimitUsesOnlySpotAndRemainingTicks() public pure {
        assertEq(B.roomLimit(true, 1 << 96, 0), 0); assertEq(B.roomLimit(false, 1 << 96, 0), 0);
        assertEq(B.roomLimit(true, 1 << 96, 7), TickMath.getSqrtPriceAtTick(-7));
        assertEq(B.roomLimit(false, 1 << 96, 7), TickMath.getSqrtPriceAtTick(7));
        assertEq(B.roomLimit(true, 1 << 96, 999), TickMath.getSqrtPriceAtTick(-49));
    }
    function test_M130a_BC166_roomLimitPreservesFractionalSpot() public pure {
        uint160 spot = TickMath.getSqrtPriceAtTick(200) + 123456789;
        assertEq(B.roomLimit(true, spot, 13), FullMath.mulDivRoundingUp(spot, TickMath.getSqrtPriceAtTick(-13), 1 << 96));
        assertEq(B.roomLimit(false, spot, 13), FullMath.mulDiv(spot, TickMath.getSqrtPriceAtTick(13), 1 << 96));
    }
    function test_M130a_BC166_roomLimitClampsPriceExtremesOrWaits() public pure {
        assertEq(B.roomLimit(true, TickMath.MIN_SQRT_PRICE + 1, 49), 0);
        assertEq(B.roomLimit(false, TickMath.MAX_SQRT_PRICE - 1, 49), 0);
        assertEq(B.roomLimit(true, TickMath.getSqrtPriceAtTick(TickMath.MIN_TICK + 5), 49), TickMath.MIN_SQRT_PRICE + 1);
        assertEq(B.roomLimit(false, TickMath.getSqrtPriceAtTick(TickMath.MAX_TICK - 5), 49), TickMath.MAX_SQRT_PRICE - 1);
    }
    function testFuzz_M130a_BC166_roomLimitIsDirectionalAndMonotone(bool buy, uint160 spot, uint24 room) public pure {
        spot = uint160(bound(spot, TickMath.MIN_SQRT_PRICE + 2, TickMath.MAX_SQRT_PRICE - 2)); room = uint24(bound(room, 1, 49));
        uint160 limit = B.roomLimit(buy, spot, room); uint160 full = B.roomLimit(buy, spot, 49);
        if (buy) { assertLt(limit, spot); assertGe(limit, full); } else { assertGt(limit, spot); assertLe(limit, full); }
    }
    function test_M130a_BC229_tipOfTakesTheBoxTipCap() public pure {
        assertEq(B.tipOf(1000000, 1000), 1000); assertEq(B.tipOf(1000000, 1000000), 50000);
    }
    function test_M130a_FM1_ticksFromReleaseConstants() public pure {
        assertEq(B.STEP_TICKS, C.STEP_TICKS); assertLt(B.STEP_TICKS, 60);
        assertEq(B.sqrtImpactDownX96(), TickMath.getSqrtPriceAtTick(-49));
        assertEq(B.sqrtImpactUpX96(), TickMath.getSqrtPriceAtTick(49));
    }
    function testFuzz_M130a_FM1_minimumOutputIsConservative(uint96 input, bool buy) public pure {
        uint256 out = B.minOut(buy, input, 1 << 96, 10000); assertLe(out, uint256(input) * 99 / 100);
    }
    // C14 removes averages; the remaining input minimum reads the live slot's directional fees.
    function test_M130a_C14_liveDirectionalFeesReplaceAverage() public pure {
        Slot0 slot = Slot0.wrap(0).setLpFee(10000).setProtocolFee(500 | (1000 << 12));
        (uint24 buy, uint24 buyLp) = B.fees(slot, true); (uint24 sell, uint24 sellLp) = B.fees(slot, false);
        assertEq(buy, 10495); assertEq(buyLp, 9995); assertEq(sell, 10990); assertEq(sellLp, 9990);
    }
}
