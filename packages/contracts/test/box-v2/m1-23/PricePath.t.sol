// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M123GridKit} from "./GridKit.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";

contract M123PricePathTest is M123GridKit {
    function test_CQ11F_fastFallThenFastRise() public {
        _prepareStep(true);
        uint160 initial = _price();
        // T/P is inverse to the trader's P/T price: selling T raises sqrtPrice.
        uint160 lowPrice = initial * 2; // P/T falls 75% within this block.
        _trade(false, -int256(t.balanceOf(address(trader))), lowPrice);
        assertEq(_price(), lowPrice);
        StepRead memory first = _measureStep(true, TIP_TO);
        (ProtocolSkip skip,,,) = hook.deepen(TIP_TO);
        assertEq(uint8(skip), uint8(ProtocolSkip.StepTaken));
        vm.roll(block.number + 1);
        StepRead memory second = _measureStep(false, TIP_TO);
        // Next block: buy to four times the initial P/T price, 16x the fallen price.
        uint160 highPrice = initial / 2;
        _trade(true, -int256(RAISE * 8), highPrice);
        assertEq(_price(), highPrice);
        vm.roll(block.number + 1);
        StepRead memory third = _measureStep(true, TIP_TO);
        vm.roll(block.number + 1);
        StepRead memory fourth = _measureStep(false, TIP_TO);
        assertFalse(box.failed());
        assertTrue(box.graduated());
        _pathRow("fall/buyBack", first);
        _pathRow("fall/deepen", second);
        _pathRow("rise/buyBack", third);
        _pathRow("rise/deepen", fourth);
        receiver.collect(address(0));
        uint256 fit = receiver.fitOwed();
        uint256 platform = receiver.platformOwed();
        assertEq(receiver.payFit(), fit);
        assertEq(receiver.payPlatform(), platform);
        assertEq(p.balanceOf(receiver.FIT_SAFE()), fit);
        assertEq(p.balanceOf(receiver.PLATFORM_SAFE()), platform);
        assertLe(receiver.booked(address(p)), _claims(address(receiver)));
    }

    function _pathRow(string memory id, StepRead memory s) private {
        emit log_string(string.concat(
                "PATH|",
                id,
                "|",
                vm.toString(s.beforePrice),
                "|",
                vm.toString(s.afterPrice),
                "|",
                vm.toString(s.moved),
                "|",
                vm.toString(s.tip),
                "|",
                vm.toString(int256(s.ticks))
            ));
    }

    function test_CQ11F_traderFundedGiftHasAnExplicitCost() public {
        _prepareStep(false);
        uint256 beforeT = t.balanceOf(address(trader));
        uint256 beforeP = p.balanceOf(address(trader));
        uint256 gift = beforeT / 10;
        trader.gift(address(t), address(hook), gift);
        _trade(true, -int256(RAISE / 100), TickMath.MIN_SQRT_PRICE + 1);
        _measureStep(false, TIP_TO);
        // Restore starting inventory including the donated T. No donated T is valued at zero.
        uint256 currentT = t.balanceOf(address(trader));
        if (currentT < beforeT) _trade(true, int256(beforeT - currentT), TickMath.MIN_SQRT_PRICE + 1);
        else _trade(false, -int256(currentT - beforeT), TickMath.MAX_SQRT_PRICE - 1);
        assertEq(t.balanceOf(address(trader)), beforeT);
        assertEq(pm.balanceOf(address(hook), uint256(uint160(address(t)))), gift);
        int256 net = int256(p.balanceOf(address(trader))) - int256(beforeP);
        assertLt(net, 0);
        emit log_string(string.concat("SELF_GIFT|", vm.toString(gift), "|", vm.toString(net)));
    }
}
