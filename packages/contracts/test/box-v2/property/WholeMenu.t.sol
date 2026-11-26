// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {WholeMenuHarness} from "./WholeMenuHarness.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";

/// Replaces CQ11-F's skipped pre-CQ11 cap/converter/RULE scenarios with the current nine offered menus.
contract WholeMenuTest is WholeMenuHarness {
    function test_allNineMenusGraduateAndFailWithConservation() public {
        uint256 initial = vm.snapshotState();
        uint256 raise = listings.listing(0).raise;
        for (uint8 buys = 1; buys <= 3; ++buys) {
            for (uint8 sells = 1; sells <= 3; ++sells) {
                for (uint256 outcome; outcome < 2; ++outcome) {
                    assertTrue(vm.revertToState(initial));
                    _life(buys, sells, raise / 5, 3, outcome == 1);
                }
            }
        }
    }

    function testFuzz_menuLifeConservesMoney(uint8 buySeed, uint8 sellSeed, uint64 amount, uint8 divisor, bool graduate)
        public
    {
        uint256 raise = listings.listing(0).raise;
        _life(
            uint8(buySeed % 3 + 1),
            uint8(sellSeed % 3 + 1),
            bound(amount, raise / 10, raise / 4),
            bound(divisor, 2, 8),
            graduate
        );
    }

    function testFuzz_splitClaimsEmptyThePot(uint64 seed, uint8 parts) public {
        _start(_menu(2, 3));
        _buy(box.raise() / 5);
        vm.warp(box.deadline());
        box.fail();
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(left, token.balanceOf(address(buyer)));
        uint256 total;
        uint256 count = bound(parts, 1, 16);
        vm.startPrank(address(buyer));
        token.approve(address(box), left);
        for (uint256 i; i < count; ++i) {
            uint256 take = i + 1 == count ? left : 1 + uint256(keccak256(abi.encode(seed, i))) % (left / 2);
            uint256 quoted = box.quoteClaim(take);
            uint256 paid = box.claim(take, address(buyer));
            assertEq(paid, quoted);
            total += paid;
            left -= take;
        }
        vm.stopPrank();
        assertEq(total, pot);
        (pot, left) = box.claimState();
        assertEq(pot, 0);
        assertEq(left, 0);
    }

    function test_defaultBuyOverrideForBothKindsBeforeAndAfterGraduation() public {
        _start(_menu(2, 2));
        for (uint256 phase; phase < 2; ++phase) {
            if (phase == 1) {
                _fill();
                box.graduate();
            }
            PoolKey memory key = hook.poolKey();
            for (uint256 kind; kind < 2; ++kind) {
                SwapParams memory swap =
                    SwapParams(true, kind == 0 ? -int256(10000) : int256(10000), layout.sqrtPriceEndX96);
                vm.prank(address(pm));
                (,, uint24 fee) = IHooks(address(hook)).beforeSwap(address(buyer), key, swap, "");
                assertEq(fee, uint24(0));
                swap.zeroForOne = false;
                vm.prank(address(pm));
                (,, fee) = IHooks(address(hook)).beforeSwap(address(buyer), key, swap, "");
                assertEq(fee, uint24(0));
            }
        }
    }
}
