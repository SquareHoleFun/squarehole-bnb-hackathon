// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {IBoxCoordinator} from "../../../src/box/interfaces/IBoxCoordinator.sol";
import {BoxS6Base} from "./BoxS6Base.sol";

/// @notice Fuzzed BC-026 and BC-027 on the real hook and receiver: any trade and collect schedule, gifts of claims
/// and T to the coordinator, any close path, any delay and any caller.
contract BoxS6FuzzTest is BoxS6Base {
    bytes32 internal constant MIGRATED_TOPIC =
        keccak256("Migrated(bytes32,uint256,uint256,uint128,uint128,uint128,uint256,uint256)");

    address internal stranger = makeAddr("s6.fuzz.stranger");

    function setUp() public {
        _setUpWorld();
    }

    /// @dev BC-027: whatever ran before (trades, collects in any pattern, a collect just before, gifts of Q claims and
    /// T), the caller of graduate() is credited exactly min(the curve's Q fees, 0.1% of R), once, from the reserve;
    /// gifts become the receiver's fees; the positions hold exactly R; the claim pays exactly the reward.
    function testFuzz_BC027_rewardUnderAnySchedule(uint256 seed) public {
        Params memory p = seed & 1 == 0 ? _box0Params() : _creatorParams(carol);
        Box memory b = _buildAndLaunch(p);
        _skipWindow(b);
        uint256 rounds = 1 + (seed >> 1) % 10;
        for (uint256 i; i < rounds; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 action = r % 5;
            if (action == 0 || action == 1) {
                uint256 room = b.raise - _curveQ(b);
                uint256 amount = 0.01 ether + (r >> 8) % 0.8 ether;
                if (amount * 100 < room * 90) _buy(b, alice, amount, 0);
            } else if (action == 2) {
                uint256 bal = b.t.balanceOf(alice);
                if (bal != 0) _sell(b, alice, bal * (1 + (r >> 8) % 99) / 100);
            } else if (action == 3) {
                try _recv(b).collect(keeper) {} catch {}
            } else {
                uint256 g = 1 + (r >> 8) % 0.01 ether;
                vm.deal(stranger, g);
                vm.prank(stranger);
                minter.mintTo{value: g}(address(b.coord));
                uint256 tBal = b.t.balanceOf(alice);
                if (tBal != 0) {
                    vm.prank(alice);
                    b.t.transfer(address(b.coord), tBal / 10);
                }
            }
            _roll(1 + (r >> 16) % 5);
        }
        _buy(b, bob, 3 * b.raise, (seed >> 8) & 1 == 0 ? b.curve.sqrtPriceLowerX96 : 0);
        assertTrue(b.hook.closed());
        if ((seed >> 9) & 1 == 1) {
            try _recv(b).collect(searcher) {} catch {}
        }
        uint256 fees = _curveQFeesAccrued(b);
        uint256 cap = b.hook.reserveCap();
        address caller = address(uint160(uint256(keccak256(abi.encode("caller", seed)))));
        vm.recordLogs();
        vm.prank(caller);
        uint256 reward = b.coord.graduate();
        assertEq(reward, fees < cap ? fees : cap, "min(curve fees, cap)");
        assertEq(b.coord.rewardOf(caller), reward);
        // Gifts of claims left with the forwarding to the receiver (its only exit before the claim).
        assertEq(_claims(address(b.coord), address(0)), reward, "the coordinator keeps only the reward");
        assertEq(b.t.balanceOf(address(b.coord)), 0, "no T left with the coordinator");
        (uint256 q, uint128 bid, uint128 sentinel, uint256 dust) = _migrated(b);
        assertEq(q, b.raise, "the curve held exactly R");
        uint160 maxS = TickMath.getSqrtPriceAtTick(BoxSpecV1.MAX_USABLE_TICK);
        uint256 poolQ = SqrtPriceMath.getAmount0Delta(b.curve.sqrtPriceLowerX96, maxS, bid, true)
            + SqrtPriceMath.getAmount0Delta(b.curve.sqrtPriceUpperX96, maxS, sentinel, true);
        assertEq(poolQ + dust, b.raise, "nothing from the raise");
        uint256 before = keeper.balance;
        vm.prank(caller);
        b.coord.claimReward(keeper);
        assertEq(keeper.balance - before, reward);
    }

    function _migrated(Box memory b) internal view returns (uint256 q, uint128 bid, uint128 sentinel, uint256 dust) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(b.hook) && logs[i].topics[0] == MIGRATED_TOPIC) {
                (q,,, bid, sentinel,, dust) =
                    abi.decode(logs[i].data, (uint256, uint256, uint128, uint128, uint128, uint256, uint256));
                return (q, bid, sentinel, dust);
            }
        }
        revert("no Migrated");
    }

    /// @dev BC-026: at any fill below P1 graduate() reverts; from the closing swap on (same block or any delay, any
    /// close path) it succeeds once for any caller; then it reverts for everyone.
    function testFuzz_BC026_onceFromTheClose(uint256 fillPpm, uint8 closeKind, uint16 delay, address caller) public {
        vm.assume(caller != address(0) && caller.code.length == 0);
        fillPpm = bound(fillPpm, 1, 999_000);
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        _fillTo(b, fillPpm);
        vm.prank(caller);
        vm.expectRevert(IBoxCoordinator.NotClosed.selector);
        b.coord.graduate();
        uint256 k = closeKind % 3;
        vm.deal(bob, 20 ether);
        vm.prank(bob);
        if (k == 0) {
            swapper.swap{value: 2 * b.raise}(b.key, true, -int256(2 * b.raise), b.curve.sqrtPriceLowerX96);
        } else if (k == 1) {
            swapper.swap{value: 2 * b.raise}(b.key, true, -int256(2 * b.raise), 0);
        } else {
            uint256 tLeft =
                SqrtPriceMath.getAmount1Delta(b.curve.sqrtPriceLowerX96, _sqrtP(b), b.curve.liquidity, false);
            swapper.swap{value: 2 * b.raise}(b.key, true, int256(tLeft + 1e18), b.curve.sqrtPriceLowerX96);
        }
        assertTrue(b.hook.closed());
        if (delay != 0) _roll(delay);
        vm.prank(caller);
        assertEq(b.coord.graduate(), b.hook.reserveCap());
        assertEq(b.coord.rewardOf(caller), b.hook.reserveCap());
        assertEq(_sqrtP(b), b.curve.sqrtPriceLowerX96, "exactly P1");
        vm.prank(caller);
        vm.expectRevert(IBoxCoordinator.AlreadyGraduated.selector);
        b.coord.graduate();
    }
}
