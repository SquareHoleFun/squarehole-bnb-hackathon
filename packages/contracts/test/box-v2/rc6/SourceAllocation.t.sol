// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverFixture, ReceiverArgs, ReceiverHook} from "../cq11-b/ReceiverFixture.sol";
import {TradeBatchV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {FeeBatchV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

/// Authenticated-source boundary double: explicitly controls readiness and cumulative partial proceeds.
interface ReceiverCursors {
    function allocationCursors() external view returns (uint256, uint256, uint256, uint256);
}

contract FeePathSources {
    uint256 public end;
    function currentTradeBatch(bool buyers) external view returns (uint256) {
        return (end + 1) / 2 * 2 + (buyers ? 1 : 2);
    }
    mapping(uint256 => TradeBatchV2) public sources;
    uint256 public tradeBatchTotalP;
    function wire(address) external pure {}
    function receipt(uint256 id, uint256 amount, bool ready) external {
        if (id > end) end = id;
        tradeBatchTotalP += amount - sources[id].netP;
        sources[id].netP = amount; sources[id].closed = ready;
    }
    function tradeBatch(uint256 id) external view returns (TradeBatchV2 memory) { return sources[id]; }
    function harvest() external pure returns (uint256, uint256, uint256) { return (0, 0, 0); }
}

contract SourceAllocationTest is ReceiverFixture {
    FeePathSources private sources;
    address private constant LEDGER = address(0x1717);
    uint256 private minted;
    uint256 private constant PASSES = 5;

    function setUp() public override {
        super.setUp();
        sources = new FeePathSources(); hook = ReceiverHook(address(sources));
        ReceiverArgs memory a = _args(4, 4, 1, address(p)); a.holderLedger = LEDGER;
        r = _clone(a); coord.initialize(r);
    }
    function _source(uint256 id, uint256 amount, uint256 backing, bool ready) private {
        sources.receipt(id, amount, ready);
        driver.mintClaims(Currency.wrap(address(p)), address(r), backing); minted += backing;
    }
    function _conserved(uint256 tips) private view {
        assertEq(_balance(address(r)) + _balance(LEDGER) + _balance(address(hook)) + tips, minted);
        _booked();
        uint256 remaining;
        for (uint256 id = 1; id <= sources.end(); ++id) {
            if (!r.holderBatchClosed(id)) remaining += sources.tradeBatch(id).netP;
        }
        assertEq(sources.tradeBatchTotalP() - uint256(vm.load(address(r), bytes32(uint256(40)))), remaining, "all unallocated entitlements stay reserved");
    }
    function test_pendingSellerReservesPartialPWhileTwoBuyerSourcesAllocate() public {
        _source(1, 150, 150, true); _source(2, 600, 600, false); _source(3, 450, 450, true);
        _source(4, 300, 300, true); _source(5, 750, 750, true);
        FeeBatchV2 memory result = r.collect(address(0));
        assertEq(result.buyersP, 600, "two buyers progress independently"); assertEq(result.sellersP, 0);
        assertEq(r.holderBatchPaid(1), 100); assertEq(r.holderBatchPaid(3), 300);
        assertFalse(r.holderBatchClosed(2)); assertFalse(r.holderBatchClosed(4), "sellers retain FIFO order");
        assertFalse(r.holderBatchClosed(5), "two-source buyer quota"); _conserved(0);
        result = r.collect(address(0)); assertEq(result.buyersP, 750); assertEq(r.holderBatchPaid(5), 500);
        _source(2, 900, 300, true); // The partially converted old source grows after later buyers were allocated.
        result = r.collect(address(0)); assertEq(result.buyersP, 0); assertEq(result.sellersP, 1200);
        assertEq(r.holderBatchPaid(2), 600); assertEq(r.holderBatchPaid(4), 200); _conserved(0);
        result = r.collect(address(0)); assertEq(result.buyersP + result.sellersP, 0); _conserved(0);
    }
    function test_shortfallCannotBorrowFromUnfinishedOrLaterSources() public {
        _source(1, 150, 0, true); _source(2, 600, 600, false); _source(3, 450, 450, true);
        r.collect(address(0));
        assertTrue(r.holderBatchClosed(1)); assertEq(r.holderBatchPaid(1), 0);
        assertEq(r.holderBatchPaid(3), 300, "later buyer keeps all of its backing");
        assertFalse(r.holderBatchClosed(2)); _conserved(0);
        _source(2, 900, 300, true); r.collect(address(0));
        assertEq(r.holderBatchPaid(2), 600, "old partial source backing was reserved in full");
        _source(5, 150, 150, true); r.collect(address(0));
        assertEq(r.holderBatchPaid(1), 0, "clipped sources are never refilled"); _conserved(0);
    }
    function test_eachSidePreservesItsOwnOrderWithoutBlockingTheOther() public {
        _source(1, 150, 150, false); _source(2, 300, 300, true);
        _source(3, 450, 450, true); _source(4, 600, 600, true);
        FeeBatchV2 memory result = r.collect(address(0));
        assertEq(result.buyersP, 0); assertEq(result.sellersP, 900);
        assertFalse(r.holderBatchClosed(1)); assertFalse(r.holderBatchClosed(3));
        assertEq(r.holderBatchPaid(2), 200); assertEq(r.holderBatchPaid(4), 400);
        _source(1, 150, 0, true); r.collect(address(0));
        assertEq(r.holderBatchPaid(1), 100); assertEq(r.holderBatchPaid(3), 300); _conserved(0);
    }
    function test_bothBacklogsHaveReservedQuotasAndOneSharedTipCap() public {
        for (uint256 id = 1; id <= 10; ++id) _source(id, 3000, 3000, true);
        FeeBatchV2 memory result = r.collect(TIP);
        assertEq(result.tip, 100); assertEq(result.buyersP, 5900); assertEq(result.sellersP, 6000);
        for (uint256 id = 1; id <= 4; ++id) assertTrue(r.holderBatchClosed(id));
        assertFalse(r.holderBatchClosed(5)); assertFalse(r.holderBatchClosed(6));
        assertEq(r.holderBatchPaid(1), 1930); assertEq(r.holderBatchPaid(3), 2000); _conserved(100);
        p.setBlocked(TIP, true);
        result = r.collect(TIP); assertEq(result.tip, 0);
        for (uint256 id = 5; id <= 8; ++id) assertEq(r.holderBatchPaid(id), 2000);
        _conserved(100);
    }
    function test_failedFundingRollsBackBothCursorsAndAllocationJournal() public {
        _source(1, 150, 150, true); _source(2, 300, 300, true); _source(3, 450, 450, true);
        vm.mockCallRevert(address(pm), abi.encodeWithSignature("transfer(address,uint256,uint256)", LEDGER, uint160(address(p)), 200), "refused");
        vm.expectRevert(); r.collect(address(0));
        assertFalse(r.holderBatchClosed(1)); assertFalse(r.holderBatchClosed(2)); assertFalse(r.holderBatchClosed(3));
        assertEq(r.fitOwed(), 0); assertEq(_balance(LEDGER), 0);
        vm.clearMockedCalls(); r.collect(address(0));
        assertEq(r.holderBatchPaid(1), 100); assertEq(r.holderBatchPaid(2), 200); assertEq(r.holderBatchPaid(3), 300);
        _conserved(0);
    }
    function test_terminalFailureFundsOnceAndLaterCollectsOnlyMovePToPot() public {
        for (uint256 id = 1; id <= 4; ++id) _source(id, 150, 150, true);
        coord.failure(r);
        for (uint256 id = 1; id <= 4; ++id) {
            assertTrue(r.holderBatchClosed(id)); assertEq(r.holderBatchPaid(id), 100);
        }
        uint256 pot = _balance(address(coord)); uint256 fit = r.fitOwed();
        _source(5, 150, 150, true); r.collect(address(0));
        assertFalse(r.holderBatchClosed(5)); assertEq(_balance(LEDGER), 400);
        assertEq(_balance(address(coord)), pot + 150); assertEq(r.fitOwed(), fit);
        assertEq(_balance(address(r)) + _balance(LEDGER) + _balance(address(coord)), minted);
    }

    function test_subUnitHeadPassesAndBooksEveryValuedShare() public {
        for (uint256 i; i < PASSES; ++i) _source(1 + i * 2, i % 2 == 0 ? 0 : 14, i % 2 == 0 ? 0 : 14, true);
        uint256 valued = PASSES * 2 + 1;
        _source(valued, 150, 150, true);
        r.collect(address(0));
        assertTrue(r.holderBatchClosed(valued), "sub-unit sources leave quota for real fees");
        assertEq(r.holderBatchPaid(valued), 100);
        assertEq(r.fitOwed(), 20); assertEq(r.platformOwed(), 10); assertEq(r.poolHeldP(), 20);
        for (uint256 i; i < PASSES; ++i) { assertTrue(r.holderBatchClosed(1 + i * 2)); assertEq(r.holderBatchPaid(1 + i * 2), 0); }
        _conserved(0);
    }
    function test_subUnitPassesAreBoundedAndCursorViewReportsProgress() public {
        for (uint256 i; i < PASSES + 3; ++i) _source(1 + i * 2, 14, 14, true);
        uint256 valued = 1 + 2 * (PASSES + 3); _source(valued, 150, 150, true);
        r.collect(address(0));
        assertTrue(r.holderBatchClosed(2 * (PASSES + 2) - 1), "N passes plus two quota places");
        assertFalse(r.holderBatchClosed(2 * (PASSES + 3) - 1)); assertFalse(r.holderBatchClosed(valued));
        (uint256 lastBuyer, uint256 lastSeller, uint256 openBuyer, uint256 openSeller) = ReceiverCursors(address(r)).allocationCursors();
        assertEq(lastBuyer, 2 * (PASSES + 2) - 1); assertEq(lastSeller, 0);
        assertEq(openBuyer, sources.currentTradeBatch(true)); assertEq(openSeller, openBuyer + 1); _conserved(0);
        r.collect(address(0)); assertTrue(r.holderBatchClosed(valued)); _conserved(0);
    }
    function test_fifteenUsesQuotaAndEachSideHasIndependentPasses() public {
        for (uint256 side = 1; side <= 2; ++side) {
            _source(side, 15, 15, true); _source(side + 2, 14, 14, true);
            _source(side + 4, 150, 150, true); _source(side + 6, 150, 150, true);
        }
        r.collect(address(0));
        for (uint256 id = 1; id <= 6; ++id) assertTrue(r.holderBatchClosed(id));
        assertFalse(r.holderBatchClosed(7)); assertFalse(r.holderBatchClosed(8)); _conserved(0);
    }
    function test_passesBeforeBothQuotasKeepOneSharedTipCap() public {
        for (uint256 id = 1; id <= PASSES * 2; ++id) _source(id, 14, 14, true);
        for (uint256 id = PASSES * 2 + 1; id <= PASSES * 2 + 6; ++id) _source(id, 1200, 1200, true);
        FeeBatchV2 memory result = r.collect(TIP);
        assertEq(result.tip, 100); assertEq(result.buyersP, 2400 + 14 * PASSES - 100);
        assertEq(result.sellersP, 2400 + 14 * PASSES);
        assertTrue(r.holderBatchClosed(PASSES * 2 + 4)); assertFalse(r.holderBatchClosed(PASSES * 2 + 5));
        _conserved(100);
    }
    function test_deficitPassesReservePartialSellerAndAllLaterSources() public {
        _source(2, 600, 600, false);
        for (uint256 i; i < PASSES; ++i) _source(1 + i * 2, 14, i == 0 ? 0 : 14, true);
        _source(PASSES * 2 + 1, 150, 150, true); _source(4, 14, 14, true); _source(6, 150, 150, true);
        r.collect(address(0)); assertTrue(r.holderBatchClosed(PASSES * 2 + 1));
        assertFalse(r.holderBatchClosed(4)); _conserved(0);
        _source(2, 900, 300, true); r.collect(address(0));
        assertTrue(r.holderBatchClosed(6)); _conserved(0);
    }
    function test_failureDoesNotPassSubUnitsAndFreezesCursors() public {
        _source(1, 150, 150, true); _source(2, 150, 150, true); r.collect(address(0));
        (uint256 beforeBuyer, uint256 beforeSeller,,) = ReceiverCursors(address(r)).allocationCursors();
        assertEq(beforeBuyer, 1); assertEq(beforeSeller, 2);
        for (uint256 id = 3; id <= 10; ++id) _source(id, 14, 14, true);
        coord.failure(r);
        for (uint256 id = 3; id <= 6; ++id) assertTrue(r.holderBatchClosed(id));
        assertFalse(r.holderBatchClosed(7)); assertFalse(r.holderBatchClosed(8));
        (uint256 afterBuyer, uint256 afterSeller,,) = ReceiverCursors(address(r)).allocationCursors();
        assertEq(afterBuyer, beforeBuyer); assertEq(afterSeller, beforeSeller);
        uint256 pot = _balance(address(coord)); _source(11, 150, 150, true); r.collect(address(0));
        assertFalse(r.holderBatchClosed(7)); assertEq(_balance(address(coord)), pot + 4 * 14 + 150);
    }
    function testFuzz_mixedReadinessAndPartialFundingConserve(uint96 a, uint96 b, uint96 c, bool sellerFirst) public {
        uint256 buyerP = bound(a, 0, 1e24); uint256 sellerP = bound(b, 0, 1e24); uint256 laterP = bound(c, 0, 1e24);
        _source(1, buyerP, buyerP, true); _source(2, sellerP / 2, sellerP / 2, false);
        _source(3, laterP, laterP, true);
        for (uint256 i; i < PASSES; ++i) _source(5 + i * 2, uint256(a) % 15, uint256(a) % 15, true);
        if (sellerFirst) _source(2, sellerP, sellerP - sellerP / 2, true);
        r.collect(address(0));
        assertEq(r.holderBatchPaid(1), 10 * (buyerP / 15)); assertEq(r.holderBatchPaid(3), 10 * (laterP / 15));
        _conserved(0);
        if (!sellerFirst) _source(2, sellerP, sellerP - sellerP / 2, true);
        r.collect(address(0)); assertEq(r.holderBatchPaid(2), 10 * (sellerP / 15));
        assertEq(r.fitOwed(), 2 * (buyerP / 15 + sellerP / 15 + laterP / 15));
        _conserved(0);
    }
}
