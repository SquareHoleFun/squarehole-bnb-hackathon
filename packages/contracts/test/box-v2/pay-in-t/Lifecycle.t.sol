// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {M363Base} from "../m3-63-fix-create/Fixture.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {IHolderLedgerV2} from "../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {ItemLedgerV2} from "../../../src/box-v2/ItemLedgerV2.sol";
import {BoxVaultV2} from "../../../src/box-v2/BoxVaultV2.sol";
import {BoxCollectionV2} from "../../../src/box-v2/BoxCollectionV2.sol";

// Local additive shape until the production interface is introduced; old interfaces remain callable.
interface PayInTReceiver {
    function rewardsPendingP() external view returns (uint256);
}
import {SparseBoxTree} from "../../box/items/BoxItemsKit.sol";
contract PayInTLifecycleTest is M363Base {
    function test_AF1_boughtHolderTExitsWithBelowMinimumTailAndNoMoreTrades() public { _tailExit(false); }
    function test_AF1_claimBetweenPurchasesNeverRepaysEarlierTranche() public { _tailExit(true); }
    function test_AF1_priorCreditCanBeClaimedDuringLaterSettlementPages() public {
        _start(_rewardSpec(false, false));
        IHolderLedgerV2 ledger = IHolderLedgerV2(box.roleAddress(17));
        vm.prank(address(buyer)); ledger.register();
        _buy(box.raise() / 10);
        uint256 gift = token.balanceOf(address(buyer)) / 3;
        vm.prank(address(buyer)); token.transfer(address(0xA11CE), gift);
        _fill(); box.graduate(); receiver.collect(address(0));
        vm.roll(block.number + 1); receiver.buyBack(address(0xBEEF)); receiver.collect(address(0));
        while (!ledger.settleBatch(1, 64)) {}
        uint256 oldCredit = ledger.claimable(1, address(buyer)); assertGt(oldCredit, 0);
        vm.roll(block.number + 1); (, uint256 spent,,) = receiver.buyBack(address(0xBEEF)); assertGt(spent, 0);
        assertFalse(ledger.settleBatch(1, 1));
        assertEq(ledger.claimable(1, address(buyer)), oldCredit);
        uint256 before_ = token.balanceOf(address(buyer));
        vm.prank(address(buyer)); assertEq(ledger.claim(1, address(buyer)), oldCredit);
        assertEq(token.balanceOf(address(buyer)) - before_, oldCredit);
        while (!ledger.settleBatch(1, 64)) {}
        assertGt(ledger.claimable(1, address(buyer)), 0, "next tranche uses original history after the claim");
    }
    function _tailExit(bool settleEach) private {
        _start(_rewardSpec(false, false));
        IHolderLedgerV2 ledger = IHolderLedgerV2(box.roleAddress(17));
        vm.prank(address(buyer)); ledger.register();
        _buy(box.raise() / 10); receiver.collect(address(0));
        _fill(); box.graduate(); receiver.collect(address(0));
        uint256 bought; uint256 paid; uint256 burned; uint256 tips;
        for (uint256 i; i < 100; ++i) {
            vm.roll(block.number + 1);
            (, uint256 spent, uint256 t, uint256 tip) = receiver.buyBack(address(0xBEEF));
            bought += t; tips += tip;
            receiver.collect(address(0)); // Purchase-generated fees also join the pending queue.
            if (settleEach) {
                (uint256 p, uint256 b) = _exitHolderT(ledger); paid += p; burned += b;
                assertEq(paid + burned, bought, "every purchase can exit before the next trade");
            }
            if (spent == 0) break;
        }
        uint256 pending = PayInTReceiver(address(receiver)).rewardsPendingP();
        assertGt(tips, 0); assertGt(pending, 0); assertLt(pending, listings.listing(0).q.swapStepMinQ);
        emit log_named_uint("AF1 pending P tail", pending);
        vm.roll(block.number + 1);
        (, uint256 retrySpent,,) = receiver.buyBack(address(0)); assertEq(retrySpent, 0);
        vm.expectRevert(); box.fail();
        (uint256 lastPaid, uint256 lastBurned) = _exitHolderT(ledger);
        paid += lastPaid; burned += lastBurned;
        assertGt(paid, 0); assertEq(paid + burned, bought, "all bought T exits without another trade");
        assertEq(pm.balanceOf(address(ledger), uint160(address(token))), 0);
        (lastPaid, lastBurned) = _exitHolderT(ledger); assertEq(lastPaid + lastBurned, 0, "no replay");
        _booked();
    }
    function _exitHolderT(IHolderLedgerV2 ledger) private returns (uint256 paid, uint256 burned) {
        for (uint256 id = 1; id < hook.currentTradeBatch(true); id += 2) {
            // Never skip a batch just because its P has not all been converted.
            while (!ledger.settleBatch(id, 64)) {}
            uint256 credit = ledger.claimable(id, address(buyer));
            if (credit != 0) {
                uint256 before_ = token.balanceOf(address(buyer));
                vm.prank(address(buyer)); paid += ledger.claim(id, address(buyer));
                assertEq(token.balanceOf(address(buyer)) - before_, credit);
            }
            uint256 supply = token.totalSupply();
            uint256 residue = ledger.flushResidue(id); burned += residue;
            assertEq(supply - token.totalSupply(), residue);
        }
    }
    function _rewardSpec(bool items, bool sellers) internal view returns (BoxSpec memory s) {
        s = items ? _items(1, 1) : _spec();
        Branch memory b = Branch(2, items ? 8 : 6, "", abi.encode(uint8(items ? 1 : 2)));
        if (sellers) s.sellers.a = b; else s.buyers.a = b;
        if (items) {
            s.n = 10; s.firstId = 1;
            (uint256[] memory positions, bytes32[] memory leaves) = _tree();
            s.revealRoot = SparseBoxTree.root(4, positions, leaves);
        }
    }
    function _tree() private pure returns (uint256[] memory positions, bytes32[] memory leaves) {
        positions = new uint256[](10); leaves = new bytes32[](10);
        for (uint256 i; i < 10; ++i) { positions[i] = i; leaves[i] = SparseBoxTree.leaf(i + 1, 0, bytes32(i + 1), 0, 0, 0); }
    }
    function _reveal(uint256 id) internal {
        (uint256[] memory positions, bytes32[] memory leaves) = _tree();
        BoxCollectionV2(box.collection()).reveal(id, 0, bytes32(id), 0, 0, 0, SparseBoxTree.proof(4, id - 1, positions, leaves));
    }
    function test_T01_holderBuyersAdmissionAndFailureExit() public { _failure(false, false); }
    function test_T02_holderSellersAdmissionAndFailureExit() public { _failure(false, true); }
    function test_T03_itemsBuyersAdmissionAndFailureExit() public { _failure(true, false); }
    function test_T04_itemsSellersAdmissionAndFailureExit() public { _failure(true, true); }
    function _failure(bool items, bool sellers) internal {
        _start(_rewardSpec(items, sellers));
        assertEq(uint8(sellers ? receiver.sellersChoice() : receiver.buyersChoice()), items ? 8 : 7);
        _buy(box.raise() / 10);
        if (sellers) buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 2, layout.sqrtPriceStartX96);
        receiver.collect(address(0));
        uint256 pending = PayInTReceiver(address(receiver)).rewardsPendingP();
        if (sellers) assertEq(pending, 0, "curve T fees burn"); else assertGt(pending, 0);
        assertEq(pm.balanceOf(items ? box.roleAddress(16) : box.roleAddress(17), uint160(address(token))), 0);
        vm.expectRevert(); receiver.buyBack(address(0));
        vm.warp(box.deadline()); box.fail();
        assertEq(PayInTReceiver(address(receiver)).rewardsPendingP(), 0);
        (uint256 pot,) = box.claimState(); assertGt(pot, pending);
        _claimBuyer(); _booked();
        _gift(address(receiver), 150); receiver.collect(address(0));
        assertGe(receiver.fitOwed(), 150);
    }

    function test_T06_itemsKeepStashPaysTToCurrentOwnerAndSeparatesP() public {
        _start(_rewardSpec(true, false)); _fill(); box.graduate(); receiver.collect(address(0));
        ItemLedgerV2 items = ItemLedgerV2(box.roleAddress(16));
        vm.roll(block.number + 1); receiver.buyBack(address(0)); items.sync(32);
        BoxVaultV2 vault = BoxVaultV2(box.vault()); uint256 id = vault.firstId();
        (uint256 outsideT, uint256 stashT) = items.itemCreditT(id);
        assertEq(outsideT, 0); assertGt(stashT, 0);
        uint256[] memory ids = new uint256[](1); ids[0] = id;
        vm.expectRevert(); items.claimT(ids, address(this));
        _reveal(id);
        vm.etch(address(buyer), address(new RewardItemOwner()).code);
        vm.startPrank(address(buyer)); token.approve(address(vault), type(uint256).max);
        vault.withdraw(id, type(uint256).max, block.timestamp);
        vm.stopPrank(); items.sync(32);
        BoxCollectionV2 collection = BoxCollectionV2(box.collection());
        vm.prank(address(buyer)); collection.transferFrom(address(buyer), address(0xA11CE), id);
        uint256 before_ = token.balanceOf(address(0xA11CE));
        vm.prank(address(0xA11CE)); assertEq(items.claimT(ids, address(0xA11CE)), stashT);
        assertEq(token.balanceOf(address(0xA11CE)) - before_, stashT);
        (outsideT, stashT) = items.itemCreditT(id); assertEq(outsideT + stashT, 0);
        assertEq(items.payoutAsset(), box.q(), "mixed legacy entry remains P");
        _booked();
    }
    function test_T15_bothTChoicesShareStepBudgetAndConserveClaims() public {
        BoxSpec memory spec = _rewardSpec(true, false);
        spec.sellers.a = Branch(2, 6, "", abi.encode(uint8(2)));
        _start(spec); _buy(box.raise() / 10);
        buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 2, layout.sqrtPriceStartX96);
        receiver.collect(address(0)); _fill(); box.graduate(); receiver.collect(address(0));
        // Build an independently executable sellers' queue; each queue keeps Burn's step minimum.
        vm.roll(block.number + 1);
        uint256 sellerBatch = hook.currentTradeBatch(false);
        buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 4, layout.sqrtPriceStartX96);
        for (uint256 round; round < 16 && !receiver.holderBatchClosed(sellerBatch); ++round) {
            _sellFeeP();
            for (uint256 page; page < 16; ++page) receiver.collect(address(0));
            if (!receiver.holderBatchClosed(sellerBatch)) {
                // New fees lift the old source's sub-minimum tail; it may not settle at zero.
                buyer.swap(hook.poolKey(), true, box.raise() / 4, TickMath.MIN_SQRT_PRICE + 1);
                buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 4, TickMath.MAX_SQRT_PRICE - 1);
            }
        }
        assertTrue(receiver.holderBatchClosed(sellerBatch));
        uint256 initial = PayInTReceiver(address(receiver)).rewardsPendingP();
        uint256 spent; uint256 bought;
        for (uint256 i; i < 8; ++i) {
            vm.roll(block.number + 1);
            (, uint256 p, uint256 t,) = receiver.buyBack(address(0)); spent += p; bought += t;
            (, uint256 again,,) = receiver.buyBack(address(0)); assertEq(again, 0, "one step per pool block");
        }
        assertEq(initial, spent + PayInTReceiver(address(receiver)).rewardsPendingP());
        uint256 holders = pm.balanceOf(box.roleAddress(17), uint160(address(token)));
        uint256 items = pm.balanceOf(box.roleAddress(16), uint160(address(token)));
        assertGt(holders, 0); assertGt(items, 0); assertEq(bought, holders + items);
        _booked();
    }
    function test_T07_itemsInsideBuyBackBurnConsumesTAndLeavesNoInsideCredit() public {
        BoxSpec memory spec = _rewardSpec(true, false);
        spec.buyers.a.destParams = abi.encode(uint8(2));
        _start(spec); _fill(); box.graduate(); receiver.collect(address(0));
        uint256 supply = token.totalSupply();
        vm.roll(block.number + 1); (, uint256 spent, uint256 bought,) = receiver.buyBack(address(0));
        assertGt(spent, 0); assertGt(bought, 0);
        assertEq(supply - token.totalSupply(), bought - bought % BoxVaultV2(box.vault()).collectionSize());
        ItemLedgerV2 items = ItemLedgerV2(box.roleAddress(16)); items.sync(32);
        (uint256 outsideT, uint256 stashT) = items.itemCreditT(BoxVaultV2(box.vault()).firstId());
        assertEq(outsideT + stashT, 0);
        uint256 residue = items.flushResidueT(); assertEq(residue, bought % BoxVaultV2(box.vault()).collectionSize());
        assertEq(supply - token.totalSupply(), bought); _booked();
    }
    function test_T05_holderHistoryEarnsBoughtTokenAfterGraduation() public {
        _start(_rewardSpec(false, false));
        IHolderLedgerV2 ledger = IHolderLedgerV2(box.roleAddress(17));
        vm.prank(address(buyer)); ledger.register();
        _buy(box.raise() / 10); receiver.collect(address(0));
        _fill(); box.graduate(); receiver.collect(address(0));
        uint256 beforeSupply = token.totalSupply();
        for (uint256 i; i < 12 && PayInTReceiver(address(receiver)).rewardsPendingP() != 0; ++i) {
            vm.roll(block.number + 1); receiver.buyBack(address(0));
        }
        assertEq(token.totalSupply(), beforeSupply, "holder purchases are not burns");
        assertGt(pm.balanceOf(address(ledger), uint160(address(token))), 0);
        for (uint256 id = 1; id < hook.currentTradeBatch(true); id += 2) {
            for (uint256 i; i < 32 && !ledger.settleBatch(id, 64); ++i) {}
            uint256 credit = ledger.claimable(id, address(buyer));
            if (credit != 0) {
                uint256 before_ = token.balanceOf(address(buyer));
                vm.prank(address(buyer)); ledger.claim(id, address(buyer));
                assertEq(token.balanceOf(address(buyer)) - before_, credit);
            }
            ledger.flushResidue(id);
        }
        assertEq(pm.balanceOf(address(ledger), uint160(address(token))), 0);
        _booked();
    }
}

contract RewardItemOwner { function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) { return 0x150b7a02; } receive() external payable {} }
