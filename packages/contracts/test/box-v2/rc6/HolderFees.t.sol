// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M261Harness} from "../property/m2/MenuHarness.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {ProtocolSkip, TradeBatchV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";

contract PlainHolderFeesTest is M261Harness {
    using StateLibrary for IPoolManager;
    mapping(uint256 => uint256) private waiting;
    mapping(uint256 => uint256) private proceeds;
    mapping(uint256 => uint256) private frozenUnits;
    uint256 private first;
    bool private rewardCaller;
    uint256 private tips;

    function _startJournal() private {
        _open(3, 18, 4, 4); _fillTracked(); box.graduate(); _collect(0);
        _registerBuyer();
        _move(CREATOR, ALICE, token.balanceOf(CREATOR) / 2);
        first = hook.currentTradeBatch(false);
    }
    function _growth() private view returns (uint256 growth, uint128 liquidity, uint256 last) {
        (liquidity,, last) = pm.getPositionInfo(hook.poolId(), address(hook),
            BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, bytes32(uint256(3)));
        (, growth) = pm.getFeeGrowthInside(hook.poolId(), BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK);
    }
    // Independent fee inputs: real-manager position growth, not the hook's per-batch journal.
    function _observeFees() private {
        (uint256 growth, uint128 liquidity, uint256 last) = _growth();
        waiting[hook.currentTradeBatch(false)] += FullMath.mulDiv(growth - last, liquidity, 1 << 128);
    }
    function _checkJournal() private view {
        uint256 sum;
        uint256 end = hook.currentTradeBatch(false);
        for (uint256 id = first; id <= end; id += 2) {
            assertEq(hook.tradeBatchPendingT(id), waiting[id], "exact source T remaining");
            assertEq(hook.tradeBatch(id).netP, proceeds[id], "exact FIFO source P");
            if (id < end) assertEq(hook.tradeBatch(id).tradeUnits + hook.tradeBatch(id).protocolUnits,
                frozenUnits[id], "frozen denominator");
            if (waiting[id] != 0) assertFalse(hook.tradeBatch(id).closed, "deferred source is not ready");
            sum += waiting[id];
        }
        assertEq(sum, hook.tFeesPending(), "source journal conserves T");
    }
    function _freeze(uint256 id) private {
        TradeBatchV2 memory b = hook.tradeBatch(id);
        frozenUnits[id] = b.tradeUnits + b.protocolUnits;
    }
    function _collectDeferred() private {
        _observeFees();
        uint256 id = hook.currentTradeBatch(false);
        _freeze(id);
        receiver.collect(address(0));
        _checkJournal();
        _fundAndSettle(); // Independent model follows ready ids on either side, including buyers past a tail.
        _assertState();
    }
    function _convert() private returns (ProtocolSkip skip) {
        uint256 current = hook.currentTradeBatch(false);
        _freeze(current);
        (uint256 growth, uint128 liquidity, uint256 last) = _growth();
        vm.roll(block.number + 1);
        uint256 used; uint256 out; uint256 tip;
        if (!rewardCaller) vm.prank(address(hook)); // Exercise both refused and successful tips.
        (skip, used, out, tip) = hook.sellFees();
        if (!rewardCaller) assertEq(tip, 0);
        tips += tip;
        out -= tip;
        if (skip != ProtocolSkip.None) return skip;
        waiting[current] += FullMath.mulDiv(growth - last, liquidity, 1 << 128);
        assertGt(used, 0);
        uint256 consumed; uint256 credited; uint256 sources;
        for (uint256 id = first; id <= current && consumed < used; id += 2) {
            uint256 take = waiting[id];
            if (take == 0) continue;
            ++sources;
            if (take > used - consumed) take = used - consumed;
            waiting[id] -= take; consumed += take;
            uint256 cumulative = FullMath.mulDiv(out, consumed, used);
            proceeds[id] += cumulative - credited; credited = cumulative;
        }
        assertEq(consumed, used); assertEq(credited, out); assertLe(sources, 32);
        assertEq(hook.currentTradeBatch(false), current + 2);
        (uint256 afterGrowth,,) = _growth();
        waiting[current + 2] += FullMath.mulDiv(afterGrowth - growth, liquidity, 1 << 128);
        // Raw-wei dust conversions can have a zero realized LP fee.
        model.trade(current + 2, (used + 99) / 100, true, false);
        _checkJournal(); _assertState();
    }
    function _drain() private {
        uint256 target = hook.currentTradeBatch(false);
        uint256 calls;
        for (; calls < 256; ++calls) {
            if (_convert() == ProtocolSkip.BelowMinimum) {
                bool earnedTail;
                for (uint256 id = first; id <= target; id += 2) {
                    if (waiting[id] != 0 && hook.tradeBatch(id).tradeUnits != 0) earnedTail = true;
                }
                if (!earnedTail) break;
                // Below-minimum fees remain owed. Later real trading lets that oldest tail settle.
                _trade(true, box.raise() / 4, true);
                _trade(false, token.balanceOf(address(buyer)) / 2, true);
                _collectDeferred();
                continue;
            }
            _collectDeferred();
        }
        assertLt(calls, 256);
        // Drain ready receiver pages even when conversions have reached the dust minimum.
        for (uint256 i; i < 32 && hook.tradeBatch(nextBatch).closed; ++i) _collectDeferred();
        _checkJournal();
    }
    function _assertUnfinished(uint256 id) private {
        assertGt(waiting[id], 0);
        assertFalse(receiver.holderBatchClosed(id));
        vm.expectRevert(); ledger.settleBatch(id, 3);
        vm.expectRevert(); ledger.flushResidue(id);
        assertEq(ledger.claimable(id, CREATOR), 0);
    }

    function test_deepenSelfFeeUsesProtocolDenominatorAndExactHolderCredits() public {
        _open(3, 18, 4, 4); _fillTracked(); box.graduate(); _collect(0);
        uint256 id = hook.currentTradeBatch(true);
        _trade(true, box.raise() / 10, true);
        uint256 budget = hook.depthBudget();
        vm.roll(block.number + 1);
        (, uint256 added,, uint256 tip) = hook.deepen(address(0));
        uint256 input = budget - hook.depthBudget() - added - tip;
        uint256 units = (input + 99) / 100;
        assertGt(units, 0); assertEq(hook.tradeBatch(id).protocolUnits, units);
        model.trade(id, units, true, false);
        _collect(0); // Independent historical-holder model checks every wallet's exact credit.
        assertGt(receiver.holderBatchPaid(id), 0);
        (,,, uint256 residue) = ledger.batchState(id);
        assertGt(residue, 0, "self-buy share cannot be paid to user units");
    }
    function test_convertedSaleProceedsPayExactSellerHolderCredits() public {
        _startJournal();
        _trade(false, token.balanceOf(address(buyer)) / 3, true);
        _drain();
        assertGt(proceeds[first], 0);
        assertEq(waiting[first], 0);
        assertGt(ledger.claimable(first, CREATOR), 0);
        _allocations(first);
    }
    function test_collectBeforeConversionPreservesOriginalSellerBatch() public {
        _startJournal();
        _trade(false, token.balanceOf(address(buyer)) / 3, true);
        _collectDeferred(); _assertUnfinished(first);
        _drain();
        assertEq(waiting[first], 0); assertGt(proceeds[first], 0);
        _allocations(first);
    }
    function test_collectBetweenPartialConversionsPreservesExactCredits() public {
        _startJournal();
        _trade(false, token.balanceOf(address(buyer)) * 9 / 10, true);
        _collectDeferred();
        uint256 beforeT = waiting[first];
        _convert();
        assertLt(waiting[first], beforeT); assertGt(waiting[first], 0, "fixture needs partial conversion");
        uint256 partialP = proceeds[first]; assertGt(partialP, 0);
        _collectDeferred(); _assertUnfinished(first);
        _drain();
        assertGt(proceeds[first], partialP); assertEq(waiting[first], 0);
        _allocations(first);
    }
    function test_interveningTradesAndTransfersKeepHistoricalShares() public {
        _startJournal();
        _trade(false, token.balanceOf(address(buyer)) / 2, true);
        _collectDeferred();
        _convert(); _collectDeferred();
        _move(ALICE, BOB, token.balanceOf(ALICE));
        _move(CREATOR, BOB, token.balanceOf(CREATOR) / 2);
        _trade(true, box.raise() / 10, true);
        uint256 later = hook.currentTradeBatch(false);
        _trade(false, token.balanceOf(address(buyer)) / 2, true);
        _collectDeferred();
        _drain();
        assertEq(waiting[first] + waiting[later], 0);
        assertGt(ledger.claimable(first, ALICE), 0);
        assertEq(ledger.claimable(first, BOB), 0);
        assertEq(ledger.claimable(later, ALICE), 0);
        assertGt(ledger.claimable(later, BOB), 0);
        _allocations(first); _allocations(later);
    }
    function test_paidTipIsSharedAcrossOriginalSources() public {
        _startJournal(); rewardCaller = true;
        uint256[4] memory ids;
        for (uint256 i; i < ids.length; ++i) {
            ids[i] = hook.currentTradeBatch(false);
            _trade(false, token.balanceOf(address(buyer)) / 20, true);
            _collectDeferred();
        }
        _drain(); assertGt(tips, 0);
        for (uint256 i; i < ids.length; ++i) {
            assertEq(waiting[ids[i]], 0); _allocations(ids[i]);
        }
    }
    function test_dustSourcesCannotBlockNewerConvertibleFees() public {
        _startJournal();
        for (uint256 i; i < 8; ++i) {
            _trade(false, 1000, true);
            _collectDeferred();
        }
        _trade(false, token.balanceOf(address(buyer)) / 3, true);
        _collectDeferred();
        _drain();
        for (uint256 id = first; id < first + 16; id += 2) {
            assertEq(waiting[id], 0); assertTrue(receiver.holderBatchClosed(id));
            _allocations(id);
        }
    }
    function test_manyPendingBatchesKeepEveryWeiAndBoundEachConversion() public {
        _startJournal();
        uint256[24] memory ids;
        for (uint256 i; i < ids.length; ++i) {
            ids[i] = hook.currentTradeBatch(false);
            _move(i % 2 == 0 ? ALICE : BOB, i % 2 == 0 ? BOB : ALICE,
                token.balanceOf(i % 2 == 0 ? ALICE : BOB));
            _trade(false, token.balanceOf(address(buyer)) / 100, true);
            _collectDeferred(); _assertUnfinished(ids[i]);
        }
        _drain();
        for (uint256 i; i < ids.length; ++i) {
            assertEq(waiting[ids[i]], 0); assertGt(proceeds[ids[i]], 0);
            assertTrue(receiver.holderBatchClosed(ids[i])); _allocations(ids[i]);
        }
    }
}
