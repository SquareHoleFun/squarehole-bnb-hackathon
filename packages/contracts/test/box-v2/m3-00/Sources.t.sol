// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {ItemSourceModel} from "./ItemSourceModel.sol";
import {ItemHistoryModel} from "./ItemHistoryModel.sol";
import {ItemModel} from "./ItemModel.sol";
import {FailureModel} from "./FreezeRules.sol";

contract M300SourcesTest is Test {
    ItemSourceModel s;
    function setUp() public { s = new ItemSourceModel(); }
    function test_S2_exactSourceCarryAndFailedTipNeverRewriteReceipt() public {
        s.receiveSource(1,1,1,1,29,0,29); s.allocate(1,0,false);
        assertEq(s.choice(1),10); assertEq(s.carry(1),14);
        s.receiveSource(2,2,1,2,15,0,15);
        vm.expectRevert(); s.allocate(2,0,true);
        s.receiveSource(1,1,1,1,1,0,1); s.allocate(1,0,true);
        assertEq(s.choice(1),20); assertEq(s.carry(1),0);
        s.allocate(2,0,true); assertEq(s.choice(2),10);
        assertEq(s.receipt(1).choiceP,10); assertEq(s.receipt(2).choiceP,10);
        assertEq(s.receipt(2).batchId,1); assertEq(s.receipt(3).batchId,2);
        vm.expectRevert(); s.receiveSource(1,1,1,1,15,0,15);
        assertEq(s.accounted(),s.received());
    }
    function test_S2_underfundingD6TipAndDebtIsolation() public {
        s.bookDebt(700); s.receiveSource(1,1,1,1,100,10,30);
        s.receiveSource(2,2,1,2,900,0,900); s.allocate(1,1,true);
        assertEq(s.choice(1),10); assertEq(s.depth(),16); // pool 2 + terminal carry 14
        assertEq(s.tips(),1); assertEq(s.debt(),700);
        s.allocate(2,0,true); assertEq(s.choice(2),600); assertEq(s.accounted(),s.received()+700);
        vm.expectRevert(); s.allocate(1,0,true);
        vm.prank(address(42)); vm.expectRevert(); s.receiveSource(3,1,2,0,1,0,1);
    }
    function test_S2_royaltyAndRepeatedTradeReceiptsFundActualItems() public {
        ItemHistoryModel h = new ItemHistoryModel(4,1,2); ItemModel m = new ItemModel(h);
        h.graduate(); h.pick(1,address(this));
        s.receiveSource(1,1,1,1,30,0,30); s.allocate(1,0,false);
        h.fund(1,1,1,s.receipt(1).choiceP);
        s.receiveSource(1,1,1,1,30,0,30); s.allocate(1,0,true);
        h.fund(1,1,1,s.receipt(2).choiceP);
        s.receiveSource(2,1,2,0,30,0,30); s.allocate(2,0,true);
        h.fund(1,2,0,s.receipt(3).choiceP); m.sync(32);
        (uint256 c,) = m.itemCredit(1); assertEq(c,15); assertEq(m.hiddenStash(),45);
        assertEq(m.accounted(),h.ledgerTransferred()); assertEq(s.receipt(3).batchId,0);
        assertEq(s.receipt(3).source,2); assertEq(s.accounted(),s.received());
    }
    function testFuzz_S2_splitConservation(uint128 a, uint128 b, uint8 tip) public {
        s.receiveSource(1,1,1,1,a,0,a); s.allocate(1,0,false);
        s.receiveSource(1,1,1,1,b,0,b);
        uint256 actual = bound(tip,0,uint256(b)/20); s.allocate(1,actual,true);
        assertEq(s.accounted(),uint256(a)+b); assertEq(s.carry(1),0);
    }

    function test_S2_failureConsumesFourteenPendingRawUnitsIntoPotOnce() public {
        s.receiveSource(1,1,1,1,14,0,14); s.allocate(1,0,false);
        assertEq(s.pending(),14); assertEq(s.carry(1),14);
        s.enterFailure(); s.allocate(1,0,true);
        assertEq(s.fit(),0); assertEq(s.depth(),0); assertEq(s.pot(),14);
        assertEq(s.pending(),0); assertEq(s.carry(1),0); assertEq(s.next(),2);
        assertEq(s.receipt(1).choiceP,0); assertEq(s.receipt(2).choiceP,0);
        vm.expectRevert(); s.allocate(1,0,true);
        assertEq(s.accounted(),14);
    }

    function test_S2_failureBoundaryIsDriverOnlyAndTerminal() public {
        s.receiveSource(1,1,1,1,44,0,44);
        vm.prank(address(42)); vm.expectRevert(); s.enterFailure();
        s.enterFailure();
        vm.expectRevert(); s.enterFailure();
        // Final failure settlement cannot pay a collect tip or leave a source open.
        vm.expectRevert(); s.allocate(1,1,true);
        vm.expectRevert(); s.allocate(1,0,false);
        // Final close fees / D6 must be supplied before the boundary; late P joins the pot without splitting.
        vm.expectRevert(); s.receiveSource(1,1,1,1,15,0,15);
        vm.expectRevert(); s.receiveSource(2,2,1,2,15,0,15);
        assertEq(s.pending(),44); assertEq(s.next(),1); assertEq(s.accounted(),44);
        s.allocate(1,0,true);
        assertEq(s.fit(),4); assertEq(s.platform(),2); assertEq(s.pot(),18);
        assertEq(s.choice(1),20); assertEq(s.depth(),0); assertEq(s.accounted(),44);
    }

    function test_S2_S5_deadlineSettlesPendingSourcesAndFinalD6() public { _failure(1); }
    function test_S2_S5_unopenedSettlesPendingSourcesAndFinalD6() public { _failure(2); }
    function test_S2_S5_hatchSettlesPendingSourcesAndFinalD6() public { _failure(3); }

    function _failure(uint8 cause) private {
        for (uint8 buyers = 1; buyers <= 2; ++buyers) {
            ItemSourceModel source = new ItemSourceModel();
            ItemHistoryModel history = new ItemHistoryModel(4,buyers,3-buyers);
            ItemModel items = new ItemModel(history);
            source.bookDebt(700);
            source.receiveSource(1,1,1,1,29,0,29); source.allocate(1,0,false);
            _fund(source,history,1); // 10 held Items, 14 pending carry, 2 base pool P.
            source.receiveSource(2,2,1,2,44,0,44);
            source.receiveSource(3,1,2,0,151,0,151); // Only returned D6, never curve principal.
            bytes32 oldReceipt = keccak256(abi.encode(source.receipt(1)));
            source.enterFailure();
            vm.expectRevert(); source.allocate(2,0,true); // Source order survives the phase boundary.
            source.allocate(1,0,true); _fund(source,history,2);
            source.allocate(2,0,true); _fund(source,history,3);
            source.allocate(3,0,true); _fund(source,history,4);
            assertEq(keccak256(abi.encode(source.receipt(1))),oldReceipt);
            assertEq(source.receipt(3).side,2); assertEq(source.receipt(3).batchId,2);
            assertEq(source.receipt(4).source,2); assertEq(source.receipt(4).batchId,0);
            assertEq(source.receipt(4).choiceP,100); assertEq(history.itemsHeldP(),130);
            assertEq(source.pending(),0); assertEq(source.next(),4);
            for (uint256 id = 1; id <= 3; ++id) {
                assertEq(source.carry(id),0);
                vm.expectRevert(); source.allocate(id,0,true);
            }
            history.fail();
            assertEq(history.pot(),130); assertEq(history.itemsHeldP(),0);
            assertEq(history.itemFundingCount(),0); assertEq(history.ledgerTransferred(),0);
            assertEq(history.buyBackP(),0); items.sync(32); assertEq(items.accounted(),0);
            vm.expectRevert(); history.fail();
            vm.expectRevert(); history.graduate();
            // Already allocated depth is swept by hook.close with principal. The failure base
            // share and history's held Items enter once. D6 is already split: do NOT split it again.
            FailureModel failure = new FailureModel(1000+source.depth()+source.pot(),history.pot(),0,80,cause);
            assertEq(failure.cause(),cause); assertEq(failure.pot(),1185);
            assertEq(source.fit(),26); assertEq(source.platform(),13); assertEq(source.depth(),2);
            assertEq(source.pot(),53); assertEq(source.accounted(),source.received()+700);
            assertEq(history.accounted(),source.choiceTotal());
            assertEq(failure.pot()+source.fit()+source.platform(),1000+source.received());
            // Converted royalties after failure join the pot; final receipts remain locked.
            failure.receiverLate(7); assertEq(failure.pot(),1192);
            assertEq(failure.claim(30),447); assertEq(failure.claim(50),745);
            failure.receiverLate(9); assertEq(failure.pot(),9); assertEq(failure.fit(),0);
            assertEq(failure.paid()+failure.pot()+failure.fit()+source.fit()+source.platform(),1240);
        }
    }

    function testFuzz_S2_S5_pendingCarryFailureConservesActualBacking(
        uint128 first, uint128 last, uint128 d6, uint8 why, bool noBuyers
    ) public {
        ItemHistoryModel history = new ItemHistoryModel(4,1,2);
        s.bookDebt(700);
        // Source has a permanent shortfall; the reserve and unrelated debt are not backing.
        s.receiveSource(1,1,1,1,uint256(first)+100,40,first); s.allocate(1,0,false);
        _fund(s,history,1);
        s.receiveSource(1,1,1,1,last,0,last);
        s.receiveSource(2,1,2,0,d6,0,d6);
        s.enterFailure(); s.allocate(1,0,true); _fund(s,history,2);
        s.allocate(2,0,true); _fund(s,history,3); history.fail();
        uint256 net = uint256(first)%15+last;
        uint256 expectedFit = 2*(uint256(first)/15+net/15+uint256(d6)/15);
        assertEq(s.fit(),expectedFit);
        assertEq(s.pot(),2*(net/15+uint256(d6)/15)+net%15+d6%15);
        assertEq(s.pending(),0); assertEq(s.carry(1)+s.carry(2),0);
        assertEq(s.accounted(),s.received()+700); assertEq(history.pot(),s.choiceTotal());
        assertEq(history.itemFundingCount(),0); assertEq(history.buyBackP(),0);
        FailureModel failure = new FailureModel(1000+s.depth()+s.pot(),history.pot(),0,noBuyers ? 0 : 3,why%3+1);
        uint256 pot = failure.pot();
        failure.receiverLate(17);
        if (noBuyers) {
            assertEq(failure.fixedCreator(),pot); assertEq(failure.claim(0),pot);
        } else {
            uint256 paid = failure.claim(1); paid += failure.claim(2); assertEq(paid,pot+17);
        }
        assertEq(failure.pot(),noBuyers ? 17 : 0);
        assertEq(failure.paid()+failure.pot()+failure.fit()+s.fit()+s.platform(),1017+uint256(first)+last+d6);
    }

    function _fund(ItemSourceModel source, ItemHistoryModel history, uint256 id) private {
        ItemSourceModel.SourceAllocation memory allocation = source.receipt(id);
        history.fund(allocation.side,allocation.source,allocation.batchId,allocation.choiceP);
    }
}
