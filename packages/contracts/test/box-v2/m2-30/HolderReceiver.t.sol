// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverFixture, ReceiverArgs, ReceiverHook} from "../cq11-b/ReceiverFixture.sol";
import {HistoryFixture, BatchHookFixture} from "./HolderFixture.sol";
import {IHolderLedgerV2} from "../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {M2SeamArgs} from "../../../src/box-v2/libraries/M2SeamArgs.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {HolderModel} from "../m2-00/HolderModel.sol";

contract ResidueReentryTip {
    IHolderLedgerV2 private immutable ledger;
    bool public attempted;
    bool public succeeded;
    constructor(IHolderLedgerV2 l) { ledger = l; }
    receive() external payable {
        attempted = true;
        (succeeded,) = address(ledger).call(abi.encodeCall(IHolderLedgerV2.flushResidue, (1)));
    }
}
contract HolderReceiverTest is ReceiverFixture {
    IHolderLedgerV2 private ledger;
    HistoryFixture private history;
    BatchHookFixture private batches;
    HolderModel private model;
    address private constant ALICE = address(0xA11CE);
    address private constant SYSTEM = address(0x5151);
    function setUp() public override {
        super.setUp(); history = new HistoryFixture(); model = new HolderModel(SYSTEM);
        batches = new BatchHookFixture(); hook = ReceiverHook(address(batches));
        address code = deployCode("out/HolderLedgerV2.sol/HolderLedgerV2.json", abi.encode(pm));
        ReceiverArgs memory a = _args(4, 4, 1, address(0)); a.t = address(history);
        a.holderLedger = address(0x1717);
        r = _clone(a);
        ledger = IHolderLedgerV2(a.holderLedger);
        vm.etch(address(ledger), BoxClones.runtime(code,
            M2SeamArgs.holder(address(coord), address(history), address(hook), address(r), address(0))));
        assertEq(address(ledger), a.holderLedger); history.wire(address(ledger)); batches.wire(address(ledger));
        coord.initialize(r);
    }
    function _tradeSource(uint256 id, uint256 user, uint256 skipped, uint256 net) private {
        batches.trade(id, user, false, true); model.trade(id, user, false, true);
        batches.trade(id, skipped, false, false); model.trade(id, skipped, false, false);
        batches.receipt(id, net, false); driver.mintClaims(Currency.wrap(address(0)), address(r), net);
    }
    function _alice() private {
        history.move(SYSTEM, ALICE, 100, false); model.move(SYSTEM, ALICE, 100, false);
    }
    function _compare(uint256 id) private {
        model.close(id, r.holderBatchPaid(id)); model.settle(id, 64); ledger.settleBatch(id, 64);
        assertEq(ledger.claimable(id, ALICE), model.credit(id, ALICE));
        (,,, uint256 residue) = ledger.batchState(id); assertEq(residue, model.residue(id));
    }
    function test_realReceiverFundsModelCreditsAndRejectsFlushInsideBooking() public {
        _alice(); _tradeSource(1, 100, 100, 1500); r.collect(address(0)); _compare(1);
        ResidueReentryTip tip = new ResidueReentryTip(ledger);
        // Prewarm recipient state: enough gas to observe the rejected nested call on both EVMs.
        vm.store(address(tip), bytes32(0), bytes32(uint256(1)));
        _tradeSource(3, 100, 0, 1500); assertEq(r.collect(address(tip)).tip, 75);
        assertTrue(tip.attempted()); assertFalse(tip.succeeded());
        assertEq(ledger.flushResidue(1), 500); assertEq(_balance(address(hook)), 500);
        _compare(3); vm.prank(ALICE); ledger.claim(1, ALICE);
        vm.prank(ALICE); ledger.claim(3, ALICE); assertEq(ALICE.balance, 1450);
        assertEq(_balance(address(ledger)), 0); _booked();
    }
    function test_failureBeforeCollectKeepsHolderPOutsidePotAndFlushesOnlyResidueToPot() public {
        _alice(); _tradeSource(1, 100, 100, 1500);
        driver.mintClaims(Currency.wrap(address(0)), address(r), 150); // returned D6, no trade receipt
        coord.failure(r); _compare(1);
        assertEq(_balance(address(coord)), 320); assertEq(_balance(address(ledger)), 1000);
        assertEq(ledger.flushResidue(1), 500); r.collect(address(0)); assertEq(r.fitOwed(), 220);
        vm.prank(ALICE); ledger.claim(1, ALICE); assertEq(ALICE.balance, 500);
        assertEq(_balance(address(ledger)), 0); assertEq(_balance(address(coord)), 820); _booked();
    }
    function test_collectTipCapAppliesAcrossLifecycleSources() public {
        _alice(); _tradeSource(1, 100, 0, 3000); batches.harvest();
        _tradeSource(3, 100, 0, 3000); assertEq(r.collect(TIP).tip, 100);
        assertEq(r.holderBatchPaid(1), 1930); assertEq(r.holderBatchPaid(3), 2000);
        _compare(1); _compare(3); _booked();
    }
}
