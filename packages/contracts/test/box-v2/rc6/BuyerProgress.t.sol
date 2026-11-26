// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M261Harness} from "../property/m2/MenuHarness.sol";
import {ProtocolSkip, TradeBatchV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {FeeBatchV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";

/// RC6-MONEY-2 / RR-HOOKPOOL-2: real PM fees, independent historical-holder oracle and conservation.
contract BuyerProgressTest is M261Harness {
    mapping(uint256 => bool) private accounted;

    function _start(uint8 buys, uint8 sells) private {
        _open(3, 18, buys, sells); _fillTracked(); box.graduate(); _collect(0); _registerBuyer();
        for (uint256 id = 1; id < nextBatch; ++id) accounted[id] = true;
        _move(CREATOR, ALICE, token.balanceOf(CREATOR) / 2);
    }

    function _convert() private returns (ProtocolSkip skip) {
        vm.roll(block.number + 1);
        uint256 used;
        // Refused tip keeps all P inside the fixture's independently conserved accounts.
        vm.prank(address(hook)); (skip, used,,) = hook.sellFees();
        if (skip == ProtocolSkip.None) model.trade(hook.currentTradeBatch(false), (used + 99) / 100, true, false);
        _assertState();
    }

    function _collectReady() private returns (FeeBatchV2 memory result) {
        Buckets memory b = _buckets();
        uint256 depth = hook.depthBudget();
        uint256 buyers; uint256 sellers; uint256 toDepth;
        result = receiver.collect(address(0));
        for (uint256 id = 1; id < hook.currentTradeBatch(true); ++id) {
            if (accounted[id] || !receiver.holderBatchClosed(id)) continue;
            accounted[id] = true;
            TradeBatchV2 memory source = hook.tradeBatch(id);
            assertTrue(source.closed);
            uint256 unit = source.netP / 15;
            uint8 choice = id % 2 == 1 ? buyChoice : sellChoice;
            if (id % 2 == 1) buyers += source.netP; else sellers += source.netP;
            b.fit += 2 * unit; b.platform += unit;
            if (choice == 1) b.keep += 10 * unit;
            toDepth += 2 * unit + source.netP % 15;
            uint256 funding = choice == 4 ? 10 * unit : 0;
            assertEq(receiver.holderBatchPaid(id), funding, "exact source funding, even out of order");
            model.close(id, funding);
            while (!ledger.settleBatch(id, 3)) {}
            while (!model.finalized(id)) model.settle(id, 3);
            _allocations(id);
        }
        assertEq(result.buyersP, buyers); assertEq(result.sellersP, sellers); assertEq(result.tip, 0);
        assertEq(abi.encode(_buckets()), abi.encode(b), "every collected source books its exact split");
        assertEq(hook.depthBudget(), depth + toDepth, "pool share and terminal dust reach depth");
        _assertState();
    }

    function _thirtyHours(uint8 buys, uint8 sells) private {
        _start(buys, sells);
        _trade(false, token.balanceOf(address(buyer)) / 3, true);
        uint256 steps;
        for (; steps < 100; ++steps) {
            ProtocolSkip skip = _convert(); _collectReady();
            if (skip == ProtocolSkip.BelowMinimum) break;
        }
        assertLt(steps, 100); assertGt(hook.tFeesPending(), 0, "conversion's own sub-minimum seller tail");
        uint256 tail;
        for (uint256 id = 2; id < hook.currentTradeBatch(true); id += 2) {
            if (hook.tradeBatchPendingT(id) != 0) { tail = id; break; }
        }
        assertGt(tail, 0); assertFalse(receiver.holderBatchClosed(tail));
        for (uint256 h; h < 30; ++h) {
            vm.warp(block.timestamp + 1 hours); vm.roll(block.number + 1);
            uint256 id = hook.currentTradeBatch(true);
            _trade(true, box.raise() / 10000, true);
            FeeBatchV2 memory result = _collectReady();
            assertGt(result.buyersP, 0, "every hour books buyer fees despite the seller tail");
            assertTrue(receiver.holderBatchClosed(id), "new buyer source allocated by this collect");
            assertFalse(receiver.holderBatchClosed(tail));
            assertEq(uint8(_convert()), uint8(ProtocolSkip.BelowMinimum));
        }
    }

    function test_thirtyHoursBuyersHoldersSharesNeverWaitForSellerTail() public { _thirtyHours(4, 1); }
    function test_thirtyHoursBuyersCreatorSharesNeverWaitForSellerTail() public { _thirtyHours(1, 4); }

    function test_mixedOrdersConserveAndKeepExactHistoricalHolderCredits() public {
        _start(4, 4);
        uint256 seller = hook.currentTradeBatch(false);
        _trade(false, token.balanceOf(address(buyer)) / 3, true); _collectReady();
        _move(ALICE, BOB, token.balanceOf(ALICE));
        uint256 laterBuyer = hook.currentTradeBatch(true);
        _trade(true, box.raise() / 100, true); _collectReady();
        assertTrue(receiver.holderBatchClosed(laterBuyer), "buyer settles ahead of the older seller");
        assertFalse(receiver.holderBatchClosed(seller));
        assertGt(ledger.claimable(laterBuyer, BOB), 0); assertEq(ledger.claimable(laterBuyer, ALICE), 0);
        for (uint256 i; i < 100 && !receiver.holderBatchClosed(seller); ++i) {
            if (_convert() == ProtocolSkip.BelowMinimum) {
                _trade(true, box.raise() / 100, true);
                _trade(false, token.balanceOf(address(buyer)) / 4, true);
            }
            _collectReady();
        }
        assertTrue(receiver.holderBatchClosed(seller));
        assertGt(ledger.claimable(seller, ALICE), 0); assertEq(ledger.claimable(seller, BOB), 0);
        uint256 credit = ledger.claimable(seller, ALICE);
        vm.prank(ALICE); assertEq(ledger.claim(seller, ALICE), credit);
        vm.prank(ALICE); assertEq(model.claim(seller, ALICE), credit);
        _collectReady(); assertEq(ledger.claimable(seller, ALICE), 0); _allocations(laterBuyer); _assertState();
    }
}
