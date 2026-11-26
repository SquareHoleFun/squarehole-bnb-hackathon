// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M361Harness, MockDrandSource, SparseBoxTree, HostileToken} from "./MenuHarness.sol";
import {LifeCustody} from "../../kit/FactoryLife.sol";
import {ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {BoxTicketsV2} from "../../../../src/box-v2/BoxTicketsV2.sol";
import {BoxCollectionV2} from "../../../../src/box-v2/BoxCollectionV2.sol";
import {ItemLedgerV2} from "../../../../src/box-v2/ItemLedgerV2.sol";
import {IBoxVaultV2, IBoxVaultItemsV2} from "../../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IBoxReceiverItemsV2, ItemFundingV2} from "../../../../src/box-v2/interfaces/IBoxReceiverV2.sol";

/// Only a fault injection for the named fail-safe notices, restored before reconciliation or payout.
contract M361RefusingNotice { fallback() external { revert("notice refused"); } }

abstract contract M361ItemLife is M361Harness {
    uint256 internal firstItem;
    uint256 internal secondItem;
    uint256 internal pageSize;

    function _prepareItems(uint8 decimals, uint8 b, uint8 s) internal {
        _open(1, decimals, b, s);
        _trade(true, box.raise() / 10);
        _trade(false, token.balanceOf(address(buyer)) / 9);
        _fillTracked(); _collect(0);
        if (buys == 5 || buys == 6) assertGt(receiver.itemsHeldP(), 0);
        else assertEq(receiver.itemsHeldP(), 0, "curve seller fees burn");
        box.graduate(); receiver.collect(address(0)); _settleHolders(); _compareItems(1);
        uint256 held = token.balanceOf(address(buyer));
        vm.prank(address(buyer)); token.transfer(ALICE, held); _trackT();
        address tickets = box.tickets();
        vm.prank(ALICE); token.approve(tickets, type(uint256).max);
    }

    function _drawItem(BoxTicketsV2 tickets) internal returns (uint256 id) {
        vm.prank(ALICE); id = tickets.draw(type(uint256).max, block.timestamp);
        IBoxVaultItemsV2 h = IBoxVaultItemsV2(box.vault());
        bytes32 key = h.itemLifecycle(h.itemLifecycleCount()).ticketKey;
        assertEq(key, keccak256(abi.encode(address(tickets), uint8(2), id)), "authenticated draw domain");
        ticketKeys.push(key); _trackT();
    }
    function _fundLive(uint256 amount) internal {
        uint256 start = IBoxReceiverItemsV2(address(receiver)).itemFundingCount();
        uint256 inside = IBoxVaultV2(box.vault()).inside();
        uint256 hidden = IBoxVaultV2(box.vault()).hiddenCount();
        uint256 cursor = IBoxVaultItemsV2(box.vault()).itemLifecycleCount();
        _gift(address(receiver), amount); receiver.collect(address(0));
        uint256 end = IBoxReceiverItemsV2(address(receiver)).itemFundingCount();
        if (buys >= 5) {
            assertEq(end, start + 1);
            ItemFundingV2 memory r = IBoxReceiverItemsV2(address(receiver)).itemFunding(end);
            uint256 choice = 10 * (amount / 15);
            assertEq(r.choiceP, choice); assertEq(r.side, 1); assertEq(r.source, 2); assertEq(r.batchId, 0);
            assertEq(r.lifecycleCursor, cursor); assertEq(r.insideCount, inside); assertEq(r.hiddenCount, hidden);
            assertEq(r.ledgerP, buys == 5 ? choice : choice - inside * (choice / journal.n()));
        } else assertEq(end, start, "non-trade holders never acquire Items money");
        _settleHolders(); _state();
    }
    function _proof(uint256 id) internal pure returns (ItemReveal memory r) {
        (uint256[] memory positions, bytes32[] memory leaves) = _tree();
        r.imageHash = bytes32(id); r.proof = SparseBoxTree.proof(4, id - 1, positions, leaves);
    }
    function _claimItem(uint256 id, address owner) internal {
        _compareItems(pageSize);
        (uint256 credit, uint256 stash) = items.itemCredit(id);
        if (credit + stash == 0) return;
        uint256[] memory ids = new uint256[](1); ids[0] = id;
        uint256 before = _balance(owner);
        vm.prank(owner); uint256 expected = itemModel.claim(ids, owner);
        vm.prank(owner); uint256 actual = items.claim(ids, owner);
        assertEq(actual, expected); assertEq(_balance(owner) - before, expected); itemPaid += actual;
        vm.prank(owner); vm.expectRevert(); items.claim(ids, owner);
        _compareItems(pageSize); _state();
    }
    function _deliver(BoxTicketsV2 tickets, uint256 id) internal returns (uint256 nft) {
        ItemReveal memory r = _proof(tickets.drawTicket(id).itemId);
        vm.prank(ALICE); nft = tickets.openDraw(id, ALICE, r); _trackT();
    }
    function _itemLife(uint8 decimals, uint8 b, uint8 s, uint256 seed, bool missed) internal {
        pageSize = 1 + seed % 3;
        _prepareItems(decimals, b, s);
        BoxTicketsV2 tickets = BoxTicketsV2(box.tickets());
        bytes memory code = address(items).code;
        if (missed) vm.etch(address(items), address(new M361RefusingNotice()).code);
        uint256 a = _drawItem(tickets);
        _fundLive(1501 + seed % 900);
        uint256 second = _drawItem(tickets);
        uint256 cancelled = _drawItem(tickets);
        _fundLive(3017 + seed % 800);
        if (missed) vm.etch(address(items), code);
        _compareItems(pageSize);
        IBoxVaultItemsV2 h = IBoxVaultItemsV2(box.vault());
        assertEq(h.itemLifecycle(1).at, h.itemLifecycle(2).at);
        if (b >= 5) assertLt(h.itemLifecycle(1).fundingCursor, h.itemLifecycle(2).fundingCursor);
        // With holders on the buying side, use real seller fees to earn on both pending tickets.
        if (b == 4) {
            uint256 sale = token.balanceOf(ALICE) / 2;
            vm.prank(ALICE); token.transfer(address(buyer), sale); _trackT();
            _trade(false, sale); receiver.collect(address(0)); _settleHolders(); _compareItems(pageSize);
        }
        MockDrandSource drand = MockDrandSource(release.randomness);
        drand.post(address(tickets), a, keccak256(abi.encode(seed, "first")));
        drand.post(address(tickets), second, keccak256(abi.encode(seed, "second")));
        assertEq(tickets.settle(3), 2); _compareItems(pageSize);
        vm.warp(vm.getBlockTimestamp() + tickets.REVEAL_GRACE() + 1);
        if (missed) vm.etch(address(items), address(new M361RefusingNotice()).code);
        secondItem = _deliver(tickets, second);
        firstItem = _deliver(tickets, a);
        tickets.enterTerminal(); tickets.cancelDraw(cancelled); _trackT();
        if (missed) vm.etch(address(items), code);
        _compareItems(pageSize);
        for (uint256 i; i < ticketKeys.length; ++i) {
            (, uint256 p, bool open) = items.ticketCredit(ticketKeys[i]); assertEq(p, 0); assertFalse(open);
        }
        _ownershipAndReturn(missed, code, seed);
        uint256 depth = pm.balanceOf(box.hook(), uint160(box.q()));
        uint256 residue = itemModel.flushResidue(); assertEq(items.flushResidue(), residue); itemFlushed += residue;
        assertEq(pm.balanceOf(box.hook(), uint160(box.q())) - depth, residue);
        assertEq(items.flushResidue(), 0); _compareItems(pageSize); _state();
    }
    function _ownershipAndReturn(bool missed, bytes memory code, uint256 seed) private {
        BoxCollectionV2 collection = BoxCollectionV2(box.collection());
        vm.prank(ALICE); collection.transferFrom(ALICE, BOB, firstItem);
        uint256[] memory ids = new uint256[](1); ids[0] = firstItem;
        vm.prank(ALICE); vm.expectRevert(ItemLedgerV2.Unauthorized.selector); items.claim(ids, ALICE);
        // Both native and ERC-20 failures preserve exact credit and backing for the current owner.
        if (box.q() == address(0)) {
            LifeCustody refusing = new LifeCustody(); refusing.setRefusing(true);
            vm.prank(BOB); vm.expectRevert(ItemLedgerV2.PayoutFailed.selector); items.claim(ids, address(refusing));
        } else {
            HostileToken p = HostileToken(box.q()); p.setPaused(true);
            vm.prank(BOB); vm.expectRevert(ItemLedgerV2.PayoutFailed.selector); items.claim(ids, BOB); p.setPaused(false);
        }
        _compareItems(pageSize); _claimItem(firstItem, BOB);
        address vault = box.vault();
        vm.prank(ALICE); collection.setApprovalForAll(vault, true);
        vm.prank(ALICE); token.approve(vault, type(uint256).max);
        if (missed) vm.etch(address(items), address(new M361RefusingNotice()).code);
        vm.prank(ALICE); IBoxVaultV2(vault).returnItem(secondItem, 0, block.timestamp); _trackT();
        _fundLive(1517 + seed % 700);
        vm.prank(ALICE); IBoxVaultV2(vault).withdraw(secondItem, type(uint256).max, block.timestamp); _trackT();
        // Out/return/out in the same second, with an intervening receipt and deliberately missed callbacks.
        vm.prank(ALICE); IBoxVaultV2(vault).returnItem(secondItem, 0, block.timestamp); _trackT();
        _fundLive(3029 + seed % 600);
        vm.prank(ALICE); IBoxVaultV2(vault).withdraw(secondItem, type(uint256).max, block.timestamp); _trackT();
        if (missed) vm.etch(address(items), code);
        _compareItems(pageSize); _claimItem(secondItem, ALICE); _claimItem(firstItem, BOB);
    }
}
