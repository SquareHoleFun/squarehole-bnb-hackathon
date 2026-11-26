// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CQ11ARealFixture} from "../cq11-a/RealFixture.sol";
import {CQATrader} from "../cq11-a/Fixture.sol";
import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";

/// Local real-part fixture: no fork, storage edits, fee exemptions or replaced protocol methods.
abstract contract M123Kit is CQ11ARealFixture {
    using StateLibrary for IPoolManager;
    address internal constant TIP_TO = address(0x123BEEF);
    bytes32 internal constant SWAP = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");

    struct SwapRead {
        int128 p;
        int128 t;
        uint24 fee;
    }

    struct StepRead {
        uint256 moved;
        uint256 tip;
        uint256 input;
        uint256 bought;
        uint256 addedP;
        uint256 addedT;
        uint256 fee;
        uint160 beforePrice;
        uint160 afterPrice;
        int24 ticks;
    }

    function _price() internal view returns (uint160 price) {
        (price,,,) = pm.getSlot0(hook.poolId());
    }

    function _swapRead(Vm.Log[] memory logs) internal view returns (SwapRead memory s) {
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(pm) && logs[i].topics[0] == SWAP) {
                (s.p, s.t,,,, s.fee) = abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
                ++found;
            }
        }
        assertEq(found, 1, "one real PoolManager swap");
    }

    function _trade(bool buy, int256 amount, uint160 limit) internal returns (BalanceDelta delta, uint256 fee) {
        uint256 beforeP = p.balanceOf(address(trader));
        uint256 beforeT = t.balanceOf(address(trader));
        uint256 pending = hook.saleFeesPending();
        uint256 mark = hook.lastProtocolBlock();
        vm.recordLogs();
        delta = trader.trade(key, buy, amount, limit);
        SwapRead memory s = _swapRead(vm.getRecordedLogs());
        assertEq(int256(p.balanceOf(address(trader))) - int256(beforeP), delta.amount0());
        assertEq(int256(t.balanceOf(address(trader))) - int256(beforeT), delta.amount1());
        assertEq(hook.lastProtocolBlock(), mark, "user never consumes step");
        assertEq(s.fee, 10000);
        assertEq(s.p, delta.amount0()); assertEq(s.t, delta.amount1());
        assertEq(hook.saleFeesPending(), pending, "user sale has no P surcharge");
        // Nominal input fee; v4 may round each uninitialised-tick crossing separately.
        fee = (uint256(-int256(buy ? delta.amount0() : delta.amount1())) + 99) / 100;
        (,,, uint24 stored) = pm.getSlot0(hook.poolId());
        assertEq(stored, 10000, "fixed 1% LP fee");
    }

    function _measureStep(bool buyBack, address tipTo) internal returns (StepRead memory r) {
        r.beforePrice = _price();
        uint256 budget = buyBack ? receiver.buyBackP() : hook.depthBudget();
        uint256 supply = t.totalSupply();
        uint128 liquidity = hook.pairedLiquidity();
        uint256 tipBefore = p.balanceOf(tipTo);
        uint256 pmP = p.balanceOf(address(pm));
        uint256 gifts = pm.balanceOf(address(hook), uint256(uint160(address(t)))) - hook.tFeesPending();
        ProtocolSkip skip;
        vm.recordLogs();
        if (buyBack) (skip, r.input, r.bought, r.tip) = receiver.buyBack(tipTo);
        else (skip, r.addedP, r.addedT, r.tip) = hook.deepen(tipTo);
        SwapRead memory s = _swapRead(vm.getRecordedLogs());
        assertEq(uint8(skip), uint8(ProtocolSkip.None));
        assertEq(s.fee, 10000);
        uint256 swapP = uint256(-int256(s.p));
        uint256 swapT = uint256(int256(s.t));
        if (buyBack) {
            assertEq(r.input, swapP);
            assertEq(r.bought, swapT);
            assertEq(supply - t.totalSupply(), r.bought);
            assertEq(receiver.tBurnPending(), 0);
            r.fee = (r.input + 99) / 100;
        } else {
            r.input = swapP;
            r.bought = swapT;
            assertLe(r.addedT, r.bought, "only freshly bought T added");
            assertEq(supply - t.totalSupply(), r.bought - r.addedT);
            assertLe(
                uint256(hook.pairedLiquidity() - liquidity) * 10000,
                uint256(liquidity) * 25,
                "full-range add at most 0.25 percent"
            );
        }
        assertEq(pm.balanceOf(address(hook), uint256(uint160(address(t)))), gifts + hook.tFeesPending(), "T gifts and fees never paired");
        r.moved = r.input + r.addedP;
        assertGt(r.moved, 0);
        assertEq(budget - (buyBack ? receiver.buyBackP() : hook.depthBudget()), r.moved + r.tip);
        assertEq(p.balanceOf(tipTo) - tipBefore, r.tip);
        assertEq(pmP - p.balanceOf(address(pm)), r.tip, "principal moves only as claims");
        assertLe(r.tip, r.moved / 20);
        assertLe(r.tip, hook.deepenTipCap());
        assertEq(hook.lastProtocolBlock(), block.number);
        r.afterPrice = _price();
        // Independent fractional-tick bound: do not reuse production roomLimit().
        uint256 limit = FullMath.mulDivRoundingUp(r.beforePrice, TickMath.getSqrtPriceAtTick(-49), 1 << 96);
        assertGe(r.afterPrice, limit, "49-tick fractional step limit");
        assertLt(r.afterPrice, r.beforePrice);
        r.ticks = TickMath.getTickAtSqrtPrice(r.beforePrice) - TickMath.getTickAtSqrtPrice(r.afterPrice);
        assertLe(r.ticks, 49);
        assertLe(receiver.booked(address(p)), _claims(address(receiver)));
    }
}
