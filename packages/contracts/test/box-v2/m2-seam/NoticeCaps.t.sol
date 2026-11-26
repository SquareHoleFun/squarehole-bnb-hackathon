// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {CQ11AFixture, CQATrader} from "../cq11-a/Fixture.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TradeBatchV2, IBoxHolderBatchNoticeV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";

contract NoticeGasSink {
    fallback() external { assembly { for {} 1 {} {} } }
}
contract NoticeCapsTest is CQ11AFixture {
    function test_N1_firstBuyNoticeBoundaryPreservesSettlement() public {
        _open();
        _assertNoticeBoundary(RAISE / 5, false);
    }

    function test_N1_checkpointNoticeBoundaryPreservesSettlement() public {
        // Accumulate real, backed fees until the next buy must checkpoint them.
        uint256 large = 340282366920938463376658674914100925496;
        _make(large);
        _open();
        bool ready;
        for (uint256 i; i < 128; ++i) {
            uint256 saved = vm.snapshotState();
            BalanceDelta bought = _buy(large / 4);
            if (_claims(address(coordinator)) != 0) {
                assertTrue(vm.revertToState(saved));
                ready = true;
                break;
            }
            trader.trade(key, false, -int256(bought.amount1()), layout.sqrtPriceStartX96);
        }
        assertTrue(ready, "next buy must run the fee checkpoint");
        // Its first T receipt is a clean zero-to-nonzero write, even after volume setup.
        trader = new CQATrader(pm);
        p.mint(address(trader), large);
        _assertNoticeBoundary(large / 4, true);
    }

    function _assertNoticeBoundary(uint256 amount, bool checkpoint) private {
        address sink = address(new NoticeGasSink());
        vm.etch(address(hook), bytes.concat(address(hook).code, abi.encodePacked(sink)));
        assertEq(t.balanceOf(address(trader)), 0, "fresh T balance");
        assertEq(_claims(address(coordinator)), 0, "fresh reserve checkpoint");
        bytes memory data = abi.encodeCall(CQATrader.trade, (key, true, -int256(amount), layout.sqrtPriceEndX96));
        uint256 saved = vm.snapshotState();
        (bool ok, bool attempted) = this.attemptBuy(data, 6_000_000, sink);
        assertTrue(ok && attempted, "full-stipend sink must be reached and trade must settle");
        TradeBatchV2 memory batch = hook.tradeBatch(1);
        assertEq(batch.tradeUnits, (amount + 99) / 100, "authoritative units survive sink OOG");
        assertEq(batch.protocolUnits, 0);
        assertFalse(batch.closed);
        assertGt(t.balanceOf(address(trader)), 0);
        assertEq(batch.netP != 0, checkpoint, "checkpoint must execute in the measured trade");
        assertEq(_claims(address(coordinator)) != 0, checkpoint);
        bytes32 expected = _settledState();
        assertTrue(vm.revertToState(saved));

        bool succeeded;
        uint256 firstNotice;
        uint256 lastSkip;
        // Include low gas, the old thresholds on both EVMs and the new activation threshold.
        for (uint256 gasLimit = 200_000; gasLimit <= 6_000_000; gasLimit += 10_000) {
            saved = vm.snapshotState();
            (ok, attempted) = this.attemptBuy(data, gasLimit, sink);
            if ((!ok && succeeded) || (!ok && attempted)) emit log_named_uint("unsafe notice gas", gasLimit);
            assertFalse(succeeded && !ok, "more gas must not turn a settled trade into a revert");
            assertFalse(attempted && !ok, "notice consumed settlement/checkpoint gas");
            if (ok) {
                succeeded = true;
                assertEq(_settledState(), expected, "same settlement and batch with or without notice");
                if (!attempted) lastSkip = gasLimit;
            }
            if (attempted && firstNotice == 0) firstNotice = gasLimit;
            assertTrue(vm.revertToState(saved));
            // Ten successful post-activation points suffice; the one-gas boundary is pinned below.
            // Avoid spending the aggregate test budget on hundreds of identical full-stipend sinks.
            if (firstNotice != 0 && gasLimit >= firstNotice + 100_000) break;
        }
        assertGt(lastSkip, 0, "must exercise successful skipped notices");
        assertGt(firstNotice, lastSkip, "must exercise notice activation");
        // Pin the one-gas boundary too, so moving the threshold cannot hide a narrow failure band.
        while (firstNotice - lastSkip > 1) {
            uint256 gasLimit = (firstNotice + lastSkip) / 2;
            saved = vm.snapshotState();
            (ok, attempted) = this.attemptBuy(data, gasLimit, sink);
            assertTrue(ok, "trade must settle at notice boundary");
            assertEq(_settledState(), expected);
            if (attempted) firstNotice = gasLimit;
            else lastSkip = gasLimit;
            assertTrue(vm.revertToState(saved));
        }
        emit log_named_uint("last skipped notice gas", lastSkip);
        emit log_named_uint("first attempted notice gas", firstNotice);
        vm.expectCall(sink, 0, uint64(C.HOLDER_NOTICE_GAS),
            abi.encodeWithSelector(IBoxHolderBatchNoticeV2.onTradeFeeBatch.selector), uint64(1));
        (ok, attempted) = this.attemptBuy(data, firstNotice, sink);
        assertTrue(ok && attempted, "activation must provide the full fixed stipend and settle");
        assertEq(_settledState(), expected);
    }

    // Keep each state-diff recording in its own frame so the sweep does not accumulate its memory.
    function attemptBuy(bytes calldata data, uint256 gasLimit, address sink) external returns (bool ok, bool attempted) {
        // Avoid warming token slots through the assertions or earlier trials.
        vm.cool(address(pm));
        vm.cool(address(hook));
        vm.cool(address(trader));
        vm.cool(address(p));
        vm.cool(address(t));
        vm.cool(sink);
        vm.startStateDiffRecording();
        (ok,) = address(trader).call{gas: gasLimit}(data);
        VmSafe.AccountAccess[] memory calls = vm.stopAndReturnStateDiff();
        for (uint256 i; i < calls.length; ++i) {
            if (calls[i].account == sink && calls[i].kind == VmSafe.AccountAccessKind.Call) {
                attempted = true;
            }
        }
    }

    function _settledState() private view returns (bytes32) {
        return keccak256(abi.encode(hook.tradeBatch(1), _claims(address(receiver)), _claims(address(coordinator)),
            p.balanceOf(address(trader)), t.balanceOf(address(trader)), p.balanceOf(address(pm)), t.balanceOf(address(pm))));
    }

    function test_N1_gasConsumingNoticeCannotEraseTradeOrBlockSettlement() public {
        vm.etch(address(hook), bytes.concat(address(hook).code, abi.encodePacked(address(new NoticeGasSink()))));
        _open();
        uint256 before = t.balanceOf(address(trader));
        _buy(RAISE / 5);
        assertGt(t.balanceOf(address(trader)), before);
        TradeBatchV2 memory batch = hook.tradeBatch(1);
        assertGt(batch.tradeUnits, 0);
        assertFalse(batch.closed);
        receiver.harvest(hook);
        assertTrue(hook.tradeBatch(1).closed);
        assertEq(hook.tradeBatch(1).tradeUnits, batch.tradeUnits);
        assertGt(hook.tradeBatch(1).netP, 0);
    }
    function test_N1_namedCapsRemainReservedForBothFailSafeCallers() public pure {
        assertEq(C.HOLDER_NOTICE_GAS, 1_400_000);
        assertEq(C.TOKEN_SETTLEMENT_GAS, 600_000);
    }
}
