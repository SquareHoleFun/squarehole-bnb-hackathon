// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FactoryLife} from "../kit/FactoryLife.sol";
import {FeeBatchV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";

/// CQ11-F / M1-61: independent running split model, using actual trades and production factory clones.
abstract contract WholeMenuHarness is FactoryLife {
    uint256[3] internal recipe;
    uint256 internal fit;
    uint256 internal platform;
    uint256 internal pool;
    uint256 internal buyersCarry;
    uint256 internal sellersCarry;

    function _resetModel() internal {
        recipe = [uint256(0), 0, 0];
        fit = 0;
        platform = 0;
        pool = 0;
        buyersCarry = 0;
        sellersCarry = 0;
    }

    function _collectModel(uint8 buys, uint8 sells) internal {
        uint256 pending = hook.saleFeesPending();
        FeeBatchV2 memory batch = receiver.collect(address(0));
        assertEq(batch.sellersP, pending, "sale mint consumed once");
        assertEq(hook.saleFeesPending(), 0);
        uint256 units = (batch.buyersP + buyersCarry) / 15;
        buyersCarry = (batch.buyersP + buyersCarry) % 15;
        recipe[buys - 1] += units * 10;
        uint256 sellUnits = (batch.sellersP + sellersCarry) / 15;
        sellersCarry = (batch.sellersP + sellersCarry) % 15;
        recipe[sells - 1] += sellUnits * 10;
        fit += (units + sellUnits) * 2;
        platform += units + sellUnits;
        pool += (units + sellUnits) * 2;
        assertEq(receiver.fitOwed(), fit);
        assertEq(receiver.platformOwed(), platform);
        assertEq(receiver.creatorP(), recipe[0]);
        assertEq(receiver.buyBackP(), recipe[1]);
        assertEq(receiver.growHeldP(), recipe[2]);
        assertEq(receiver.poolHeldP(), pool);
        uint256 expected = fit + platform + pool + recipe[0] + recipe[1] + recipe[2] + buyersCarry + sellersCarry;
        assertEq(receiver.booked(box.q()), expected);
        _booked();
    }

    function _life(uint8 buys, uint8 sells, uint256 input, uint256 sellDivisor, bool graduate) internal {
        _start(_menu(buys, sells));
        _resetModel();
        uint256 money = _money();
        _buy(input);
        uint256 sale = token.balanceOf(address(buyer)) / sellDivisor;
        buyer.swap(hook.poolKey(), false, sale, layout.sqrtPriceStartX96);
        _collectModel(buys, sells);
        // A second batch crosses independent per-side carry boundaries and includes an unattributed P gift.
        _gift(address(receiver), 17);
        _buy(input / 2);
        buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 7, layout.sqrtPriceStartX96);
        _collectModel(buys, sells);
        assertEq(_money(), money);
        if (graduate) {
            _fill();
            box.graduate();
            receiver.collect(address(0));
            assertEq(receiver.poolHeldP(), 0);
            assertEq(receiver.growHeldP(), 0);
            assertGt(hook.depthBudget(), 0);
            (ProtocolSkip skip, uint256 moved,,) = hook.deepen(address(0));
            assertEq(uint256(skip), uint256(ProtocolSkip.None));
            assertGt(moved, 0);
            (skip,,,) = receiver.buyBack(address(0));
            assertEq(uint256(skip), uint256(ProtocolSkip.StepTaken));
            vm.roll(block.number + 1);
            if (receiver.buyBackP() >= factory.boxQParameters(0, box.raise()).swapStepMinQ) {
                uint256 before = receiver.buyBackP();
                uint256 supply = token.totalSupply();
                uint256 spent;
                uint256 bought;
                (skip, spent, bought,) = receiver.buyBack(address(0));
                assertEq(uint256(skip), uint256(ProtocolSkip.None));
                assertEq(before - receiver.buyBackP(), spent);
                assertEq(supply - token.totalSupply() + receiver.tBurnPending(), bought);
            }
            receiver.collect(address(0));
            if (receiver.creatorP() != 0) {
                vm.prank(CREATOR);
                receiver.claimCreator(address(0), CREATOR);
            }
            uint256 reward = box.rewardOf(address(this));
            if (reward != 0) assertEq(box.claimReward(address(this)), reward);
        } else {
            // No trading after the model's last collect: only D6 may cross as fees at failure.
            uint256 reserveUnits = (hook.reserveMinted() + buyersCarry) / 15;
            uint256 expectedFit = fit + 2 * reserveUnits;
            _gift(address(box), 111); // principal gift must never be fee-split
            vm.warp(box.deadline());
            box.fail();
            assertEq(receiver.platformOwed(), platform + reserveUnits, "only recorded reserve split as fees");
            assertEq(receiver.fitOwed(), expectedFit, "only earned fee share to FIT; grow and carry stay in pot");
            assertEq(hook.depthBudget(), 0, "failure leaves no P budget outside pot");
            assertEq(receiver.creatorP(), 0);
            assertEq(receiver.buyBackP(), 0);
            assertEq(receiver.poolHeldP(), 0);
            assertEq(receiver.growHeldP(), 0);
            _claimBuyer();
        }
        uint256 owed = receiver.fitOwed();
        assertEq(receiver.payFit(), owed);
        owed = receiver.platformOwed();
        assertEq(receiver.payPlatform(), owed);
        assertEq(_money(), money, "all P conserved across trades, fees, tips and exits");
        _booked();
    }
}
