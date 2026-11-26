// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../../rc5-a/NoFailureSweep.sol";

import {CustodyFixture} from "./CustodyFixture.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {FeeBatchV2} from "../../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {ProtocolSkip} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";

/// @notice Custody assertions across real hook, receiver, coordinator, launch router, T and PoolManager.
contract CustodyFlowsTest is CustodyFixture {
    function _booked() private view {
        uint256 ledgers = receiver.fitOwed() + receiver.platformOwed() + receiver.poolHeldP() + receiver.growHeldP()
            + receiver.creatorP() + receiver.buyBackP() + receiver.itemsHeldP() + receiver.royaltyHeldP();
        uint256 booked = receiver.booked(address(p));
        assertGe(booked, ledgers);
        assertLt(booked - ledgers, 30);
        assertLe(booked, _claims(address(receiver)));
    }

    function test_curveSaleTFeesDoNotCreateReceiverP() public {
        _open();
        _buy(RAISE / 10);
        receiver.collect(address(0));
        uint256 beforeClaims = _claims(address(receiver));
        uint256 sold = t.balanceOf(address(trader)) / 3;
        BalanceDelta delta = trader.trade(key, false, -int256(sold), layout.sqrtPriceStartX96);
        uint256 fee = hook.saleFeesPending();
        assertGt(delta.amount0(), 0);
        assertEq(fee, 0);
        assertEq(_claims(address(receiver)) - beforeClaims, fee);
        FeeBatchV2 memory batch = receiver.collect(address(0));
        assertEq(batch.sellersP, fee);
        assertEq(batch.buyersP, 0);
        assertEq(hook.saleFeesPending(), 0);
        uint256 booked = receiver.booked(address(p));
        batch = receiver.collect(address(0));
        assertEq(batch.buyersP + batch.sellersP, 0);
        assertEq(receiver.booked(address(p)), booked);
        _booked();
    }

    function test_graduationSeparatesDepthCreatorAndD6Reward() public {
        _open();
        _buy(RAISE / 3);
        receiver.collect(address(0));
        assertGt(receiver.poolHeldP(), 0);
        assertGt(receiver.creatorP(), 0);
        assertGt(_claims(address(box)), 0);
        _fill();
        uint256 reward = box.graduate();
        assertLe(reward, RAISE / 1000);
        assertEq(_claims(address(box)), reward);
        assertTrue(receiver.graduationSettled());
        assertEq(receiver.poolHeldP() + receiver.growHeldP(), 0);
        uint256 depth = hook.depthBudget();
        assertGt(depth, 0);
        vm.prank(address(0xBAD));
        (bool ok,) = address(box).call(abi.encodeCall(box.claimReward, (address(0xBAD))));
        assertFalse(ok, "only the recorded graduator owns D6");
        uint256 beforeP = p.balanceOf(address(this));
        assertEq(box.claimReward(address(this)), reward);
        assertEq(p.balanceOf(address(this)) - beforeP, reward);
        assertEq(_claims(address(box)), 0);
        uint256 creator = receiver.creatorP();
        assertEq(receiver.claimCreator(address(p), address(this)), creator);
        assertEq(hook.depthBudget(), depth, "creator and reward payouts cannot spend depth");
        _booked();
    }

    function test_buyBackAndDeepenKeepBudgetsSeparateAndShareBlock() public {
        choice = 2;
        _make(RAISE);
        _graduate();
        trader.gift(address(p), address(receiver), RAISE / 5);
        receiver.collect(address(0));
        uint256 budget = receiver.buyBackP();
        uint256 depth = hook.depthBudget();
        uint256 supply = t.totalSupply();
        address keeper = address(0xC011EC7);
        p.mint(keeper, 1);
        vm.roll(block.number + 1);
        (ProtocolSkip skip, uint256 spent, uint256 bought, uint256 tip) = receiver.buyBack(keeper);
        assertEq(uint256(skip), uint256(ProtocolSkip.None));
        assertGt(spent, 0);
        assertLe(tip, spent / 20);
        assertEq(receiver.buyBackP(), budget - spent - tip);
        assertEq(hook.depthBudget(), depth);
        assertEq(supply - t.totalSupply() + receiver.tBurnPending(), bought);
        (skip,,,) = hook.deepen(keeper);
        assertEq(uint256(skip), uint256(ProtocolSkip.StepTaken));
        assertEq(hook.depthBudget(), depth);
        _booked();

        vm.roll(block.number + 1);
        uint256 beforeBuyBack = receiver.buyBackP();
        uint256 receiverClaims = _claims(address(receiver));
        (skip,,,) = hook.deepen(keeper);
        assertEq(uint256(skip), uint256(ProtocolSkip.None));
        assertLt(hook.depthBudget(), depth);
        assertEq(receiver.buyBackP(), beforeBuyBack);
        assertGt(_claims(address(receiver)), receiverClaims, "buy-back LP fees leave depth and reach receiver");
        (skip,,,) = receiver.buyBack(keeper);
        assertEq(uint256(skip), uint256(ProtocolSkip.StepTaken));
        receiver.collect(address(0));
        _booked();
    }

    function test_failureKeepsSafeDebtAndClaimsConsumeThePotThenLateMoneyStaysPut() public {
        _open();
        _buy(RAISE / 10);
        receiver.collect(address(0));
        uint256 fitBefore = receiver.fitOwed();
        uint256 platformBefore = receiver.platformOwed();
        vm.warp(box.deadline());
        box.fail();
        assertTrue(box.failed());
        assertGe(receiver.fitOwed(), fitBefore);
        assertGe(receiver.platformOwed(), platformBefore);
        assertEq(receiver.creatorP() + receiver.buyBackP() + receiver.poolHeldP(), 0);
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(left, t.balanceOf(address(trader)));
        uint256 half = left / 2;
        vm.prank(address(trader));
        t.approve(address(box), left);
        vm.prank(address(trader));
        uint256 first = box.claim(half, address(0xCA11));
        vm.prank(address(trader));
        uint256 last = box.claim(left - half, address(0xCA11));
        assertEq(first + last, pot);
        (pot, left) = box.claimState();
        assertEq(pot + left, 0);
        trader.gift(address(p), address(hook), 150);
        uint256 fit = receiver.fitOwed();
        NoFailureSweep.check(address(box));
        assertEq(receiver.fitOwed(), fit);
        NoFailureSweep.check(address(box));
        _booked();
    }
}
