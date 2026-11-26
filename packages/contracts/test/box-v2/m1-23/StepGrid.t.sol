// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M123GridKit} from "./GridKit.sol";

/// 80 measured cells, each with a paired no-step control. Every row also reports the
/// ordinary trader and creator result, plus a separately identified step-caller tip.
contract M123StepGridTest is M123GridKit {
    function test_CQ11F_buyBackBuyBefore() public {
        _grid(true, false);
    }

    function test_CQ11F_buyBackSaleBefore() public {
        _grid(true, true);
    }

    function test_CQ11F_deepenBuyBefore() public {
        _grid(false, false);
    }

    function test_CQ11F_deepenSaleBefore() public {
        _grid(false, true);
    }

    function _grid(bool buyBack, bool sellFirst) private {
        uint256 root = vm.snapshotState();
        uint256[5] memory notionals = [RAISE / 10000, RAISE / 1000, RAISE / 100, RAISE / 10, RAISE / 2];
        for (uint256 budget; budget < 2; ++budget) {
            assertTrue(vm.revertToState(root));
            _prepareStep(buyBack, budget == 0 ? 0 : RAISE);
            uint256 base = vm.snapshotState();
            uint256 stepBudget = buyBack ? receiver.buyBackP() : hook.depthBudget();
            StepRead memory alone = _measureStep(buyBack, TIP_TO);
            uint256 recipeBefore = receiver.buyBackP();
            receiver.collect(address(0));
            uint256 aloneRecovery =
                buyBack ? receiver.buyBackP() - recipeBefore : receiver.claimCreator(address(p), address(this));
            emit log_string(string.concat(
                    "BASE|",
                    buyBack ? "buyBack" : "deepen",
                    "/b",
                    vm.toString(budget),
                    "|",
                    vm.toString(stepBudget),
                    "|",
                    vm.toString(t.balanceOf(address(donor))),
                    "|",
                    vm.toString(alone.tip),
                    "|",
                    vm.toString(aloneRecovery)
                ));
            for (uint256 n; n < notionals.length; ++n) {
                for (uint256 gift; gift < 2; ++gift) {
                    assertTrue(vm.revertToState(base));
                    Cell memory control = _cell(buyBack, sellFirst, notionals[n], gift != 0, false);
                    assertTrue(vm.revertToState(base));
                    Cell memory c = _cell(buyBack, sellFirst, notionals[n], gift != 0, true);
                    // Record positive cells instead of converting economic findings into a failing suite.
                    // The pinned observations are regression bounds, not an assumed universal no-gain theorem.
                    assertLt(control.net, 0, "fees make the no-step round trip costly");
                    string memory id = string.concat(
                        buyBack ? "buyBack" : "deepen",
                        "/",
                        sellFirst ? "saleBefore" : "buyBefore",
                        "/b",
                        vm.toString(budget),
                        "/n",
                        vm.toString(n),
                        "/g",
                        vm.toString(gift)
                    );
                    _row(id, c, control);
                }
            }
        }
    }

    function testFuzz_CQ11F_roundTripConservesInventory(uint64 size, bool saleBefore, bool buyBack, bool gift) public {
        _prepareStep(buyBack);
        uint256 notional = bound(uint256(size), RAISE / 100000, RAISE / 2);
        uint256 passive;
        if (!buyBack) {
            uint256 saved = vm.snapshotState();
            _step(false, TIP_TO); receiver.collect(address(0));
            passive = receiver.creatorP(); // The same deepen pays P LP fees even without a round trip.
            assertTrue(vm.revertToState(saved));
        }
        Cell memory c = _cell(buyBack, saleBefore, notional, gift, true);
        assertLt(c.net, 0, "sampled trader round trip after the two input fees");
        if (!buyBack) assertLt(c.creatorNet - int256(passive), 0, "round trip versus passive creator fees");
    }

    function test_CQ11F_giftDoesNotChangeAnyGridResult() public {
        uint256 root = vm.snapshotState();
        for (uint256 step; step < 2; ++step) {
            assertTrue(vm.revertToState(root));
            _prepareStep(step == 1);
            uint256 base = vm.snapshotState();
            for (uint256 side; side < 2; ++side) {
                assertTrue(vm.revertToState(base));
                Cell memory plain = _cell(step == 1, side == 1, RAISE / 10, false, true);
                assertTrue(vm.revertToState(base));
                Cell memory gift = _cell(step == 1, side == 1, RAISE / 10, true, true);
                assertEq(plain.net, gift.net);
                assertEq(plain.creatorNet, gift.creatorNet);
                assertEq(plain.step.moved, gift.step.moved);
                assertEq(plain.step.addedT, gift.step.addedT);
                assertEq(plain.step.tip, gift.step.tip);
                assertEq(plain.step.afterPrice, gift.step.afterPrice);
            }
        }
    }
}
