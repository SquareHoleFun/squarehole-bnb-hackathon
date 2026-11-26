// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {M123GridKit} from "./GridKit.sol";

/// CQ11-F replaces the three skipped converter pins with the box's actual protocol steps.
contract M123GridPinsTest is M123GridKit {
    function test_CQ11F_buyBackMeasuresRealSpend() public {
        _prepareStep(true);
        uint256 budget = receiver.buyBackP();
        (uint256 moved, uint256 tip) = _step(true, address(0));
        assertGt(moved, 0);
        assertEq(budget - receiver.buyBackP(), moved + tip);
    }

    function test_CQ11F_deepenMeasuresBuyAndAdd() public {
        _prepareStep(false);
        uint256 budget = hook.depthBudget();
        (uint256 moved, uint256 tip) = _step(false, address(0));
        assertGt(moved, 0);
        assertEq(budget - hook.depthBudget(), moved + tip);
    }

    function test_CQ11F_budgetLimitedStepsLeaveOnlyDust() public {
        uint256 root = vm.snapshotState();
        for (uint256 kind; kind < 2; ++kind) {
            assertTrue(vm.revertToState(root));
            bool buyBack = kind == 1;
            _prepareStep(buyBack, 0);
            bool budgetLimited;
            uint256 count;
            while ((buyBack ? receiver.buyBackP() : hook.depthBudget()) >= RAISE / 100000) {
                vm.roll(block.number + 1);
                StepRead memory s = _measureStep(buyBack, TIP_TO);
                if (s.ticks < 49) budgetLimited = true;
                assertLt(++count, 128, "bounded budget drain");
            }
            assertTrue(budgetLimited, "includes a budget-limited step");
            vm.roll(block.number + 1);
            ProtocolSkip skip;
            if (buyBack) (skip,,,) = receiver.buyBack(TIP_TO);
            else (skip,,,) = hook.deepen(TIP_TO);
            assertEq(uint8(skip), uint8(ProtocolSkip.BelowMinimum));
            emit log_string(string.concat(
                    "DRAIN|",
                    buyBack ? "buyBack" : "deepen",
                    "|",
                    vm.toString(count),
                    "|",
                    vm.toString(buyBack ? receiver.buyBackP() : hook.depthBudget())
                ));
        }
    }

    function test_CQ11F_deepenTipsOverManyBlocks() public {
        _prepareStep(false);
        uint256 moved;
        uint256 tips;
        for (uint256 i; i < 64; ++i) {
            vm.roll(block.number + 1);
            (uint256 work, uint256 tip) = _step(false, address(0xBEEF));
            assertGt(work, 0);
            assertGt(tip, 0);
            assertLe(tip, work / 20);
            moved += work;
            tips += tip;
        }
        assertLe(tips, moved / 20);
        assertEq(p.balanceOf(address(0xBEEF)), tips);
        emit log_string(string.concat(
                "TIPS|64|", vm.toString(moved), "|", vm.toString(tips), "|", vm.toString(hook.depthBudget())
            ));
    }
}
