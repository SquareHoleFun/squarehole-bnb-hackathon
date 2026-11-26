// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FactoryLife} from "../kit/FactoryLife.sol";
import {ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";

contract FactoryLifeTest is FactoryLife {
    function test_createTradeGraduateDeepenBuyBackCollectAndPay() public {
        _start(_menu(2, 1));
        _buy(box.raise() / 10);
        buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 4, layout.sqrtPriceStartX96);
        receiver.collect(address(0));
        assertEq(receiver.creatorP(), 0, "curve seller fees burn");
        assertGt(receiver.buyBackP(), 0);
        _booked();
        _fill();
        box.graduate();
        assertTrue(box.graduated());
        assertTrue(receiver.graduationSettled());
        receiver.collect(address(0));
        (ProtocolSkip skip, uint256 placed,,) = hook.deepen(address(0));
        assertEq(uint256(skip), uint256(ProtocolSkip.None));
        assertGt(placed, 0);
        (skip,,,) = receiver.buyBack(address(0));
        assertEq(uint256(skip), uint256(ProtocolSkip.StepTaken));
        vm.roll(block.number + 1);
        uint256 supply = token.totalSupply();
        uint256 bought;
        (skip,, bought,) = receiver.buyBack(address(0));
        assertEq(uint256(skip), uint256(ProtocolSkip.None));
        assertGt(bought, 0);
        assertEq(supply - token.totalSupply() + receiver.tBurnPending(), bought);
        receiver.collect(address(0));
        uint256 fit = receiver.fitOwed();
        uint256 platform = receiver.platformOwed();
        assertGt(fit, 0);
        assertEq(receiver.payFit(), fit);
        assertEq(fitSafe.balance, fit);
        uint256 before = address(this).balance;
        assertEq(receiver.payPlatform(), platform);
        assertEq(address(this).balance - before, platform);
        buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 3, layout.sqrtPriceStartX96);
        _sellFeeP(); receiver.collect(address(0));
        uint256 creator = receiver.creatorP(); assertGt(creator, 0);
        before = CREATOR.balance;
        vm.prank(CREATOR);
        assertEq(receiver.claimCreator(address(0), CREATOR), creator);
        assertEq(CREATOR.balance - before, creator);
        _booked();
    }
}
