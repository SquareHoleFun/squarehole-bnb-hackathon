// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverFixture, ReceiverArgs, ReceiverHook} from "../cq11-b/ReceiverFixture.sol";
import {BatchHookFixture} from "./HolderFixture.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SourceModel} from "../m2-00/SourceModel.sol";

contract LedgerSink { fallback() external { revert("receiver must not call ledger"); } }
contract ReceiverFundingTest is ReceiverFixture {
    BatchHookFixture private batches;
    address private ledger;
    function _holders(uint8 buyers, uint8 sellers) private {
        batches = new BatchHookFixture(); hook = ReceiverHook(address(batches));
        ReceiverArgs memory a = _args(buyers, sellers, 1, address(p));
        ledger = address(new LedgerSink()); a.holderLedger = ledger; r = _clone(a); coord.initialize(r);
    }
    function _receipt(uint256 id, uint256 n, uint256 backing) private {
        batches.receipt(id, n, false); driver.mintClaims(Currency.wrap(address(p)), address(r), backing);
    }
    function test_collectFundsBothClosedSourcesWithoutCallingLedgerAndMatchesSourceModel() public {
        _holders(4, 4); _receipt(1, 1500, 1500); _receipt(2, 750, 750);
        SourceModel m = new SourceModel(); m.receipt(1, 1520, 20, 1500); m.receipt(2, 750, 0, 750);
        m.allocate(1, 75, false); m.allocate(2, 0, false);
        assertEq(r.collect(TIP).tip, 75);
        assertTrue(r.holderBatchClosed(1)); assertTrue(r.holderBatchClosed(2));
        assertEq(r.holderBatchPaid(1), m.funding(1)); assertEq(r.holderBatchPaid(2), m.funding(2));
        assertEq(_balance(ledger), 1450); assertEq(r.fitOwed(), m.fit()); assertEq(r.platformOwed(), m.platform());
        assertEq(r.poolHeldP(), m.depth()); _booked();
        r.collect(address(0)); assertEq(r.holderBatchPaid(1), 950); assertTrue(r.holderBatchClosed(3));
    }
    function test_refusedTipStaysInItsSourceAndTerminalCarryCannotSubsidizeNextBatch() public {
        _holders(4, 4); _receipt(1, 1501, 1501); p.setBlocked(TIP, true);
        assertEq(r.collect(TIP).tip, 0); assertEq(r.holderBatchPaid(1), 1000);
        assertEq(_balance(address(hook)), 1, "terminal source dust exits to depth even before graduation");
        _receipt(3, 14, 14); r.collect(address(0)); assertEq(r.holderBatchPaid(3), 0);
        assertEq(_balance(address(hook)), 15); _booked();
    }
    function test_royaltyDonationAndReturnedReserveNeverCreditHolderLedger() public {
        _holders(4, 4); _royalty(address(p), 1500);
        _receipt(1, 1500, 1500); driver.mintClaims(Currency.wrap(address(p)), address(r), 150);
        r.collect(address(0)); assertEq(r.holderBatchPaid(1), 1000); assertEq(r.royaltyHeldP(), 1500);
        coord.graduation(r); assertEq(_balance(ledger), 1000); assertEq(_balance(address(hook)), 1520);
        // An independent failure before collect: source receipt is post-D6; returned D6 has no trade units.
        coord = _newCoordinator(); _holders(4, 4); _receipt(1, 1500, 1500);
        driver.mintClaims(Currency.wrap(address(p)), address(r), 150); coord.failure(r);
        assertEq(r.holderBatchPaid(1), 1000); assertEq(_balance(address(coord)), 320);
        assertEq(r.fitOwed(), 220); assertEq(r.platformOwed(), 110);
        driver.mintClaims(Currency.wrap(address(p)), address(r), 90); r.collect(address(0));
        assertEq(r.fitOwed(), 220); assertEq(_balance(address(coord)), 410); assertEq(r.holderBatchPaid(1), 1000);
    }
    function test_oldShortfallCannotConsumeLaterReceiptOrBookedDebtAndNeverRefills() public {
        _holders(4, 4); _royalty(address(p), 150);
        _receipt(1, 150, 0); batches.harvest(); _receipt(3, 300, 300);
        r.collect(address(0)); assertEq(r.holderBatchPaid(1), 0); assertTrue(r.holderBatchClosed(1));
        assertEq(r.holderBatchPaid(3), 200); assertEq(r.royaltyHeldP(), 150);
        driver.mintClaims(Currency.wrap(address(p)), address(r), 150); r.collect(address(0));
        assertEq(r.holderBatchPaid(1), 0); assertEq(_balance(ledger), 200); _booked();
    }
    function test_mixedChoicesUseIndependentSidesAndGraduationClosesBeforeCollect() public {
        _holders(1, 4); _receipt(1, 1500, 1500); _receipt(2, 3000, 3000);
        batches.harvest(); coord.graduation(r); r.collect(address(0));
        assertTrue(r.holderBatchClosed(1)); assertEq(r.holderBatchPaid(1), 0);
        assertEq(r.holderBatchPaid(2), 2000); assertEq(r.creatorP(), 1000);
        assertEq(_balance(address(hook)), 600); _booked();
    }
    function testFuzz_sourceAllocationParityAndConservation(uint64 x, uint64 y, uint8 decimals, bool refuseTip) public {
        _holders(4, 4);
        uint256 scale = 10 ** (decimals % 3 == 0 ? 6 : decimals % 3 == 1 ? 8 : 18);
        uint256 buyers = (uint256(x) % 1e9) * scale;
        uint256 sellers = (uint256(y) % 1e9) * scale;
        _receipt(1, buyers, buyers); _receipt(2, sellers, sellers);
        p.setBlocked(TIP, refuseTip);
        uint256 tip = buyers < 1000 || refuseTip ? 0 : buyers / 20;
        if (tip > 100) tip = 100;
        assertEq(r.collect(TIP).tip, tip);
        SourceModel m = new SourceModel();
        m.receipt(1, buyers, 0, buyers); m.receipt(2, sellers, 0, sellers);
        m.allocate(1, tip, false); m.allocate(2, 0, false);
        assertEq(r.holderBatchPaid(1), m.funding(1)); assertEq(r.holderBatchPaid(2), m.funding(2));
        assertEq(r.fitOwed(), m.fit()); assertEq(r.platformOwed(), m.platform());
        assertEq(r.poolHeldP() + _balance(address(hook)), m.depth());
        assertEq(_balance(address(r)) + _balance(ledger) + _balance(address(hook)) + tip, buyers + sellers);
        _booked();
    }
    function test_productionRuntimeFitsReservedGate() public view {
        assertLe(address(implementation).code.length, 22118);
    }
}
