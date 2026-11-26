// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditU2ClaudeBase, AuditU2ClaudeForcing} from "./AuditU2ClaudeBase.sol";

/// @notice BC-029 ("Forcing graduation is expensive") and BC-067 (the graduated layout) on the factory's box 0 with the
/// real coordinator: the existing BC-029 tests (`test/box/s45/BoxHookCurve.t.sol:379-415`) run on a mock coordinator
/// (`BoxS45Mocks.sol`), so the coordinator's own graduation path (its whole T handed to `migrate`, the dust burned,
/// the reward) is pinned here. A forcer with no capital of its own buys to exactly P1 after the window, calls
/// `graduate()` and sells everything back in one block (`_force`); the same round trip with a T gift to the
/// coordinator before `graduate()` measures what BC-043's "T sent to the coordinator joins the ask" does to it
/// (AUDIT-U2-02 pins the defect at 20.7% fill; this contract pins what holds).
/// - BC-029: without a gift the round trip costs at least 0.670, 0.121 and 0.0019 ETH at 20.7%, 70.1% and 98.1% fill
///   by ETH, and the pool keeps at least what the curve held, by the model's margins.
/// - BC-067: without a gift the graduated positions are three (ask, full-range bid, sentinel), the pool holding R.
/// - The bound that holds with a gift: whatever the fill, a gift of the least T that empties the sentinel (6,306,641 T,
///   3.12% of the pool share) changes the forcer's cost by less than the sentinel's Q (0.1275 ETH), the pool still
///   keeps what the curve held, and from 45% fill on it makes forcing dearer.
/// forge-config: default.evm_version = "osaka"
contract AuditU2ClaudeForcingTest is AuditU2ClaudeBase {
    /// @notice A gift of at least the least T that empties the sentinel (6,306,640.853 T, measured at the end of
    /// `testAccepted_AUDIT_U2_02_tGiftToTheCoordinatorDropsTheSentinelAndCheapensForcing`), rounded up to the whole T.
    uint256 internal constant GIFT = 6_306_641 ether;

    function setUp() public override {
        super.setUp();
        _warpTo(hook.windowEndsAt());
    }

    /// @notice BC-029 and BC-067 hold on the factory's box 0 when nobody sends T to the coordinator.
    function testProperty_AUDIT_U2_forcingCostsWhatBc029StatesWithoutAGift() public {
        uint256[3] memory fills = [uint256(207_000), 701_000, 981_000];
        uint256[3] memory minCost = [uint256(0.67 ether), 0.121 ether, 0.0019 ether];
        uint256[3] memory minMargin = [uint256(0.636 ether), 0.108 ether, 0.0011 ether];
        for (uint256 i; i < fills.length; ++i) {
            uint256 snap = vm.snapshotState();
            _fillTo(fills[i]);
            AuditU2ClaudeForcing memory f = _force(eoa[5], 0);
            emit log_named_uint("U2C|forcing|fill ppm", f.qBefore * 1e6 / raise);
            emit log_named_decimal_uint("U2C|forcing|cost without a gift, ETH", f.cost, 18);
            emit log_named_decimal_uint("U2C|forcing|pool Q after - curve Q before, ETH", f.poolQAfter - f.qBefore, 18);
            assertApproxEqAbs(f.qBefore, raise * fills[i] / 1e6, 1e9, "the curve at the BC-029 fill");
            assertGe(f.cost + 1e12, minCost[i], "BC-029: the round trip costs at least the model's figure");
            assertGe(f.poolQAfter, f.qBefore, "BC-029: the pool keeps at least what the curve held");
            assertGe(f.poolQAfter - f.qBefore, minMargin[i], "by the model's margin");
            assertGt(f.ask, 0, "BC-067: an ask");
            assertEq(f.bid, f.ask, "BC-067: the full-range bid at the ask's liquidity");
            assertGt(f.sentinel, 0, "BC-067: and a sentinel");
            assertEq(f.reward, coordinator.rewardCap(), "the forcer is credited the D6 reward");
            assertEq(token.balanceOf(eoa[5]), 0, "it sold everything");
            _assertGhostLedger();
            vm.revertToState(snap);
        }
    }

    /// @notice What a gift of `GIFT` T to the coordinator (from the forcer's own buy, before `graduate()`) does to the
    /// round trip, at fills from an empty curve (the bootstrap only) to 98.1%: the change in cost is below the
    /// sentinel's Q, the pool keeps what the curve held, and from 45% on the gift only makes forcing dearer. The
    /// measured costs are logged (`U2C|forcing|` lines); the cheaper round trips below 45% are AUDIT-U2-02's subject.
    function testProperty_AUDIT_U2_aTGiftMovesAForcersCostByLessThanTheSentinel() public {
        uint256[7] memory fills = [uint256(0), 100_000, 207_000, 300_000, 450_000, 701_000, 981_000];
        for (uint256 i; i < fills.length; ++i) {
            uint256 snap = vm.snapshotState();
            _fillTo(fills[i]);
            uint256 snapFill = vm.snapshotState();
            AuditU2ClaudeForcing memory plain = _force(eoa[5], 0);
            uint256 sentinelQ = _sentinelQ(plain.sentinel);
            vm.revertToState(snapFill);
            uint256 bought = _boughtToP1();
            AuditU2ClaudeForcing memory gifted = _force(eoa[5], bought < GIFT ? bought / 2 : GIFT);
            emit log_named_uint("U2C|forcing|fill ppm", plain.qBefore * 1e6 / raise);
            emit log_named_decimal_uint("U2C|forcing|cost without a gift, ETH", plain.cost, 18);
            emit log_named_decimal_uint("U2C|forcing|gift, T", gifted.gift, 18);
            emit log_named_decimal_uint("U2C|forcing|cost with the gift, ETH", gifted.cost, 18);
            emit log_named_decimal_uint("U2C|forcing|sentinel Q without the gift, ETH", sentinelQ, 18);
            uint256 change = plain.cost > gifted.cost ? plain.cost - gifted.cost : gifted.cost - plain.cost;
            if (plain.cost > gifted.cost) {
                assertLt(change, sentinelQ, "a gift saves the forcer less than the sentinel's Q");
            }
            if (fills[i] >= 450_000) assertGt(gifted.cost, plain.cost, "from 45% fill a gift makes forcing dearer");
            assertGe(gifted.poolQAfter, gifted.qBefore, "the pool still keeps what the curve held");
            assertEq(gifted.reward, plain.reward, "the same reward");
            assertEq(token.balanceOf(a.coordinator), 0, "the coordinator ends with no T");
            _assertGhostLedger();
            vm.revertToState(snap);
        }
    }

    /// @notice The T a buy to P1 would take from the curve now (its T side from P1 up to the price), rolled back.
    function _boughtToP1() internal returns (uint256 t) {
        uint256 snap = vm.snapshotState();
        t = _buyTo(eoa[4], 3 * raise, _p1());
        vm.revertToState(snap);
    }
}
