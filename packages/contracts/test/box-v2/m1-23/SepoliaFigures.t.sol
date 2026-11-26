// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {M123GridKit} from "./GridKit.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";

/// CQ11-F: the five skipped seed/route/floor tests are replaced by local real-pool fee
/// measurements. The historical filename does not imply a Sepolia fork or network call.
contract M123FeeKindsTest is M123GridKit {
    using StateLibrary for IPoolManager;

    function test_CQ11F_fourSwapKinds() public {
        _prepareStep(false);
        uint256 base = vm.snapshotState();
        for (uint256 kind; kind < 4; ++kind) {
            assertTrue(vm.revertToState(base));
            bool buy = kind < 2;
            int256 amount = kind == 0
                ? -int256(RAISE / 1000)
                : kind == 1
                    ? int256(t.balanceOf(address(trader)) / 10000)
                    : kind == 2 ? -int256(t.balanceOf(address(trader)) / 10000) : int256(RAISE / 1000);
            (uint256 growthBefore, uint256 tGrowthBefore) = pm.getFeeGrowthGlobals(hook.poolId());
            uint256 claims = _claims(address(receiver));
            (BalanceDelta d, uint256 fee) =
                _trade(buy, amount, buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
            (uint256 growthAfter, uint256 tGrowthAfter) = pm.getFeeGrowthGlobals(hook.poolId());
            if (buy) {
                uint256 accrued = FullMath.mulDiv(growthAfter - growthBefore, hook.pairedLiquidity(), 1 << 128);
                assertApproxEqAbs(accrued, fee, 8, "LP growth proves the charged buy fee");
                assertEq(_claims(address(receiver)), claims, "buy fee remains in position until harvest");
                if (amount > 0) assertEq(d.amount1(), amount);
                else assertEq(d.amount0(), amount);
            } else {
                assertEq(growthBefore, growthAfter, "sale has no P LP fee");
                assertEq(_claims(address(receiver)), claims, "T fee stays in the position");
                assertApproxEqAbs(FullMath.mulDiv(tGrowthAfter - tGrowthBefore, hook.pairedLiquidity(), 1 << 128), fee, 8);
                if (amount < 0) assertEq(d.amount1(), amount);
            }
            emit log_string(string.concat(
                    "FEE|",
                    vm.toString(kind),
                    "|",
                    vm.toString(int256(d.amount0())),
                    "|",
                    vm.toString(int256(d.amount1())),
                    "|",
                    vm.toString(fee)
                ));
        }
    }

    function test_CQ11F_partialExactInSaleChargesOnlyFilledInput() public {
        _prepareStep(false);
        uint160 limit = uint160(FullMath.mulDiv(_price(), TickMath.getSqrtPriceAtTick(1), 1 << 96));
        uint256 offered = t.balanceOf(address(trader)) / 4;
        (BalanceDelta d, uint256 fee) = _trade(false, -int256(offered), limit);
        assertLt(uint256(-int256(d.amount1())), offered);
        assertGt(d.amount0(), 0);
        emit log_string(string.concat(
                "PARTIAL|",
                vm.toString(uint256(-int256(d.amount1()))),
                "|",
                vm.toString(uint256(int256(d.amount0()))),
                "|",
                vm.toString(fee)
            ));
    }

    function test_CQ11F_partialExactOutSaleUsesOrdinaryV4Fill() public {
        _prepareStep(false);
        uint160 beforePrice = _price();
        uint160 limit = uint160(FullMath.mulDiv(beforePrice, TickMath.getSqrtPriceAtTick(1), 1 << 96));
        uint256 beforeP = p.balanceOf(address(trader));
        uint256 beforeT = t.balanceOf(address(trader));
        uint256 claims = _claims(address(receiver));
        uint256 counter = hook.saleFeesPending();
        BalanceDelta d = trader.trade(key, false, int256(RAISE / 2), limit);
        assertEq(_price(), limit);
        assertGt(d.amount0(), 0); assertLt(uint256(int256(d.amount0())), RAISE / 2);
        assertEq(p.balanceOf(address(trader)), beforeP + uint256(int256(d.amount0())));
        assertEq(t.balanceOf(address(trader)), beforeT - uint256(-int256(d.amount1())));
        assertEq(_claims(address(receiver)), claims);
        assertEq(hook.saleFeesPending(), counter);
    }

    function test_CQ11F_keepBothCannotCreateBuyBackBudget() public {
        _prepareStep(false);
        assertEq(receiver.buyBackP(), 0);
        (ProtocolSkip skip, uint256 spent, uint256 bought, uint256 tip) = receiver.buyBack(TIP_TO);
        assertEq(uint8(skip), uint8(ProtocolSkip.BelowMinimum));
        assertEq(spent + bought + tip, 0);
        assertEq(hook.lastProtocolBlock(), 0);
    }
}
