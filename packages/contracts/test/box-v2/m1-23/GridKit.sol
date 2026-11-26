// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M123Kit} from "./M123Kit.sol";
import {CQATrader} from "../cq11-a/Fixture.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

abstract contract M123GridKit is M123Kit {
    CQATrader internal donor;

    struct Cell {
        uint256 input;
        uint256 output;
        uint256 fees; // P units only; sale T fees must not be added to P.
        uint256 recovered;
        int256 net;
        int256 creatorNet;
        StepRead step;
    }

    function _prepareStep(bool buyBack) internal {
        _prepareStep(buyBack, RAISE);
    }

    function _prepareStep(bool buyBack, uint256 extra) internal {
        if (buyBack) {
            choice = 2;
            _make(RAISE);
        }
        _graduate();
        receiver.collect(address(0));
        if (extra != 0) trader.gift(address(p), buyBack ? address(receiver) : address(hook), extra);
        receiver.collect(address(0));
        if (!buyBack) receiver.claimCreator(address(p), address(this));
        donor = new CQATrader(pm);
        uint256 gift = t.balanceOf(address(trader)) / 4;
        vm.prank(address(trader));
        t.transfer(address(donor), gift);
        vm.roll(block.number + 1);
    }

    function _step(bool buyBack, address tipTo) internal returns (uint256 moved, uint256 tip) {
        StepRead memory s = _measureStep(buyBack, tipTo);
        return (s.moved, s.tip);
    }

    function _cell(bool buyBack, bool sellFirst, uint256 amount, bool gift, bool withStep)
        internal
        returns (Cell memory c)
    {
        uint256 beforeP = p.balanceOf(address(trader));
        uint256 beforeT = t.balanceOf(address(trader));
        BalanceDelta first;
        uint256 fee;
        // Sales specify net P out; buys specify gross P in. Both use the same P notional.
        (first, fee) = _trade(
            !sellFirst,
            sellFirst ? int256(amount) : -int256(amount),
            sellFirst ? TickMath.MAX_SQRT_PRICE - 1 : TickMath.MIN_SQRT_PRICE + 1
        );
        c.fees = sellFirst ? 0 : fee;
        if (gift) donor.gift(address(t), address(hook), t.balanceOf(address(donor)));
        if (withStep) c.step = _measureStep(buyBack, TIP_TO);
        BalanceDelta last;
        // Exact restoration of T inventory: no mark-to-market profit or unsold T.
        (last, fee) = _trade(
            sellFirst, -int256(first.amount1()), sellFirst ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        );
        if (sellFirst) c.fees += fee;
        assertEq(t.balanceOf(address(trader)), beforeT, "round trip closes T inventory exactly");
        c.input = uint256(-int256(sellFirst ? last.amount0() : first.amount0()));
        c.output = uint256(int256(sellFirst ? first.amount0() : last.amount0()));
        c.net = int256(p.balanceOf(address(trader))) - int256(beforeP);
        assertEq(c.net, int256(c.output) - int256(c.input));
        uint256 recipeBefore = receiver.buyBackP();
        receiver.collect(address(0));
        if (!buyBack) {
            uint256 cash = p.balanceOf(address(this));
            c.recovered = receiver.claimCreator(address(p), address(this));
            assertEq(p.balanceOf(address(this)) - cash, c.recovered, "real creator payout");
        } else {
            // Keep/keep cannot fund buyBackP. Credit the exact 10/15 allocation from
            // the real burn ledger as a counterfactual; never a claimed production payout.
            assertEq(receiver.creatorP(), 0);
            c.recovered = receiver.buyBackP() - recipeBefore;
        }
        c.creatorNet = c.net + int256(c.recovered);
        assertLe(receiver.booked(address(p)), _claims(address(receiver)));
    }

    function _row(string memory id, Cell memory c, Cell memory control) internal {
        string memory balances = string.concat(
            "CELL|",
            id,
            "|",
            vm.toString(c.input),
            "|",
            vm.toString(c.output),
            "|",
            vm.toString(c.fees),
            "|",
            vm.toString(c.recovered),
            "|",
            vm.toString(c.net),
            "|",
            vm.toString(c.creatorNet)
        );
        string memory stepData = string.concat(
            "|",
            vm.toString(c.step.moved),
            "|",
            vm.toString(c.step.tip),
            "|",
            vm.toString(int256(c.step.ticks)),
            "|",
            vm.toString(c.step.beforePrice),
            "|",
            vm.toString(c.step.afterPrice)
        );
        emit log_string(string.concat(
                balances, "|", vm.toString(control.net), "|", vm.toString(control.creatorNet), stepData
            ));
        // Global real-P conservation: fee/principal claims are backed once at the manager.
        assertEq(
            p.totalSupply(),
            p.balanceOf(address(this)) + p.balanceOf(address(trader)) + p.balanceOf(address(pm)) + p.balanceOf(TIP_TO)
                + p.balanceOf(address(router))
        );
    }
}
