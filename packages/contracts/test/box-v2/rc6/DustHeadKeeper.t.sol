// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M261Harness} from "../property/m2/MenuHarness.sol";
import {ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {BoxSwapBoundsV2 as Bounds} from "../../../src/box-v2/libraries/BoxSwapBoundsV2.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {GasBudget} from "../gas/GasBudget.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {HostileToken} from "../kit/HostileToken.sol";

/// RC6-MONEY-1: real trades and public collects create the FIFO, without storage injection.
contract DustHeadKeeperTest is M261Harness {
    using StateLibrary for IPoolManager;
    uint256 private firstDust;
    uint256 private realSource;
    uint256 private dustT;

    function _simulate() private returns (ProtocolSkip skip, uint256 tIn, uint256 pOut, uint256 tip) {
        uint256 snap = vm.snapshotState();
        (skip, tIn, pOut, tip) = hook.sellFees();
        vm.revertToState(snap);
    }

    function _dustHead(uint256 count, uint256 sale) private {
        _open(3, 18, 4, 4); _fillTracked(); box.graduate(); _collect(0);
        _registerBuyer();
        firstDust = hook.currentTradeBatch(false);
        bool nearOne = sale == 0;
        if (nearOne) {
            (uint160 spot,,,) = pm.getSlot0(hook.poolId());
            sale = 100 * FullMath.mulDiv(spot, spot, 1 << 192);
        }
        for (uint256 i; i < count; ++i) {
            _trade(false, sale, true); receiver.collect(address(0));
            uint256 pending = hook.tradeBatchPendingT(firstDust + 2 * i);
            (uint160 spot,,,) = pm.getSlot0(hook.poolId());
            assertGt(pending, 0);
            assertEq(Bounds.tInQAtSqrt(pending, spot), 0, "each dust source is worth less than one raw P");
            dustT += pending;
        }
        uint256 bought = _trade(true, box.raise() / (nearOne ? 2 : 20), true);
        realSource = hook.currentTradeBatch(false);
        _trade(false, nearOne ? bought * 102 / 100 : token.balanceOf(address(buyer)) / 3, true);
        receiver.collect(address(0));
        vm.roll(block.number + 1);
        (uint160 finalSpot,,,) = pm.getSlot0(hook.poolId());
        for (uint256 id = firstDust; id < realSource; id += 2) {
            assertEq(Bounds.tInQAtSqrt(hook.tradeBatchPendingT(id), finalSpot), 0, "still dust at sale spot");
        }
    }

    function test_nineDustSourcesReachRealFeesInOneOrdinaryPress() public {
        _dustHead(9, 1e9); // Release review's DustHead, including collect after every tiny sale.
        uint256 beforeReal = hook.tradeBatchPendingT(realSource);
        uint256 g = gasleft();
        (ProtocolSkip skip, uint256 used, uint256 out, uint256 tip) = hook.sellFees();
        emit log_named_uint("nine-dust press gas", g - gasleft());
        assertEq(uint8(skip), uint8(ProtocolSkip.None));
        assertGt(used, dustT, "one press reaches real fee value behind all nine dust sources");
        assertGt(out, 0); assertLe(tip, out / 20);
        assertLt(hook.tradeBatchPendingT(realSource), beforeReal);
        for (uint256 id = firstDust; id < realSource; id += 2) assertEq(hook.tradeBatchPendingT(id), 0);
        (skip,,,) = hook.sellFees(); assertEq(uint8(skip), uint8(ProtocolSkip.StepTaken));
    }

    function test_hardBoundClears32DustSourcesAndKeeperRuleReachesRealFees() public {
        _dustHead(48, 1000);
        (ProtocolSkip skip, uint256 used, uint256 out, uint256 tip) = _simulate();
        assertEq(uint8(skip), uint8(ProtocolSkip.None)); assertGt(used, 0); assertEq(out, 0); assertEq(tip, 0);
        uint256 g = gasleft(); hook.sellFees();
        emit log_named_uint("32-dust zero-P press gas", g - gasleft());
        for (uint256 i; i < 32; ++i) assertEq(hook.tradeBatchPendingT(firstDust + 2 * i), 0, "32 sources per dust page");
        assertGt(hook.tradeBatchPendingT(firstDust + 64), 0, "hard bound stops at 32");
        // Keeper rule: a sent zero-P press is due again next turn, instead of waiting an hour.
        vm.roll(block.number + 1);
        (skip, used, out,) = _simulate();
        assertEq(uint8(skip), uint8(ProtocolSkip.None)); assertGt(used, 0); assertGt(out, 0);
        uint256 realBefore = hook.tradeBatchPendingT(realSource);
        hook.sellFees();
        assertLt(hook.tradeBatchPendingT(realSource), realBefore);
        for (uint256 id = firstDust; id < realSource; id += 2) assertEq(hook.tradeBatchPendingT(id), 0);
    }

    function test_valuedSourcesBelowStepMinimumDoNotEndThePage() public {
        _open(3, 18, 4, 4); _fillTracked(); box.graduate(); _collect(0); _registerBuyer();
        uint256 first = hook.currentTradeBatch(false);
        for (uint256 i; i < 6; ++i) { _trade(false, 1e12, true); receiver.collect(address(0)); }
        (uint160 spot,,,) = pm.getSlot0(hook.poolId());
        for (uint256 i; i < 6; ++i) {
            assertEq(Bounds.tInQAtSqrt(hook.tradeBatchPendingT(first + 2 * i), spot), 47);
        }
        assertLt(Bounds.tInQAtSqrt(hook.tFeesPending(), spot), box.raise() / 100000);
        _trade(false, token.balanceOf(address(buyer)) / 3, true); receiver.collect(address(0));
        uint256 larger = first + 12;
        uint256 beforeReal = hook.tradeBatchPendingT(larger);
        vm.roll(block.number + 1);
        uint256 g = gasleft(); hook.sellFees();
        emit log_named_uint("six-valued press gas", g - gasleft());
        emit log_named_uint("larger source before", beforeReal);
        emit log_named_uint("larger source after", hook.tradeBatchPendingT(larger));
        for (uint256 i; i < 6; ++i) assertEq(hook.tradeBatchPendingT(first + 2 * i), 0, "all six small sources clear");
        assertLt(hook.tradeBatchPendingT(larger), beforeReal, "one press reaches the larger source");
    }

    function test_stepMinimumValueEndsPageBeforeFourSources() public {
        _open(3, 18, 4, 4); _fillTracked(); box.graduate(); _collect(0); _registerBuyer();
        uint256 first = hook.currentTradeBatch(false);
        (uint160 beforeSpot,,,) = pm.getSlot0(hook.poolId());
        uint256 minimum = factory.boxQParameters(1, box.raise()).swapStepMinQ;
        uint256 sale = 100 * FullMath.mulDiv(FullMath.mulDiv(2 * minimum, beforeSpot, 1 << 96), beforeSpot, 1 << 96);
        for (uint256 i; i < 3; ++i) {
            _trade(false, sale, true); receiver.collect(address(0));
        }
        (uint160 spot,,,) = pm.getSlot0(hook.poolId());
        uint256 selected = hook.tradeBatchPendingT(first) + hook.tradeBatchPendingT(first + 2);
        assertLt(Bounds.tInQAtSqrt(hook.tradeBatchPendingT(first), spot), minimum);
        assertGe(Bounds.tInQAtSqrt(selected, spot), minimum);
        uint256 next = hook.tradeBatchPendingT(first + 4);
        // The 49-tick cap can consume only part of this page. Pin the offered input,
        // so the test distinguishes value-sized selection from a price-limited fill.
        vm.expectCall(address(pm), abi.encodeCall(IPoolManager.swap,
            (hook.poolKey(), SwapParams(false, -int256(selected), Bounds.roomLimit(false, spot, 49)), bytes(""))));
        vm.roll(block.number + 1);
        (ProtocolSkip skip, uint256 used,,) = hook.sellFees(); assertEq(uint8(skip), uint8(ProtocolSkip.None));
        assertGt(used, 0); assertLe(used, selected);
        assertEq(hook.tradeBatchPendingT(first + 4), next, "minimum-value page leaves the third source untouched");
    }

    function test_cold32SourceConversionFitsKeeperLimitWithTwoTimesMargin() public { _coldSale(false); }
    function test_cold32SourceConversionWithExhaustedTipStipend() public { _coldSale(true); }

    function _coldSale(bool exhaustTip) private {
        _dustHead(31, 0);
        if (exhaustTip) {
            vm.etch(address(0xBADD), hex"5b600056");
            HostileToken(box.q()).armReentry(address(0xBADD), "");
        }
        uint256 realBefore = hook.tradeBatchPendingT(realSource);
        address target = address(hook);
        bytes memory data = abi.encodeWithSignature("sellFees()");
        for (uint256 i; i < 24; ++i) {
            address part = box.roleAddress(i); if (part != address(0)) vm.cool(part);
            address implementation = release.implementations[i]; if (implementation != address(0)) vm.cool(implementation);
        }
        vm.cool(box.q()); vm.cool(address(pm));
        uint256 g = gasleft();
        (bool ok, bytes memory returned) = target.call{gas: 16_000_000}(data);
        uint256 used = GasBudget.transaction(g - gasleft(), data);
        assertTrue(ok);
        (ProtocolSkip skip,, uint256 out, uint256 tip) = abi.decode(returned, (ProtocolSkip, uint256, uint256, uint256));
        assertEq(uint8(skip), uint8(ProtocolSkip.None)); assertGt(out, 0);
        if (exhaustTip) assertEq(tip, 0); else assertGt(tip, 0);
        assertLt(hook.tradeBatchPendingT(realSource), realBefore);
        emit log_named_uint(exhaustTip ? "cold 32-source exhausted-tip transaction gas" : "cold 32-source sellFees transaction gas", used);
        assertLe(used * 2, 16_000_000, "requested keeper limit retains at least 2x measured margin");
    }
}
