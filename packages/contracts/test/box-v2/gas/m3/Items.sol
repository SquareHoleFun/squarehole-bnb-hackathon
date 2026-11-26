// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M360Measure} from "./Measure.sol";
import {BoxSpec} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxTicketsV2} from "../../../../src/box-v2/BoxTicketsV2.sol";
import {BoxCollectionV2} from "../../../../src/box-v2/BoxCollectionV2.sol";
import {ItemLedgerV2} from "../../../../src/box-v2/ItemLedgerV2.sol";
import {IBoxVaultV2, IBoxVaultItemsV2} from "../../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IBoxReceiverItemsV2} from "../../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {MockDrandSource} from "../../../box/items/BoxItemsKit.sol";

abstract contract M360Items is M360Measure {
    BoxTicketsV2 internal tickets;
    BoxCollectionV2 internal collection;
    ItemLedgerV2 internal ledger;
    IBoxVaultV2 internal vault;

    function _itemStart(uint8 decimals, bool graduate) internal {
        BoxSpec memory s = _hiddenItems(1, 2);
        if (decimals != 0) {
            (BoxSpec memory priced,) = _priceSpec(3, 3, decimals);
            s.pricing = priced.pricing;
            s.raise = priced.raise;
        }
        _itemStartSpec(s, graduate);
    }

    function _itemStartSpec(BoxSpec memory s, bool graduate) internal {
        _start(s);
        tickets = BoxTicketsV2(box.tickets());
        collection = BoxCollectionV2(box.collection());
        ledger = ItemLedgerV2(box.roleAddress(16));
        vault = IBoxVaultV2(box.vault());
        assertEq(IBoxVaultItemsV2(address(vault)).ITEM_BATCH_MAX(), 1);
        _fill();
        receiver.collect(address(0));
        if (graduate) {
            box.graduate();
            receiver.collect(address(0));
            ledger.sync(32);
            assertEq(ledger.fundingCursor(), IBoxReceiverItemsV2(address(receiver)).itemFundingCount());
        }
        uint256 held = token.balanceOf(address(buyer));
        vm.prank(address(buyer));
        token.transfer(ALICE, held);
        vm.startPrank(ALICE);
        token.approve(address(tickets), type(uint256).max);
        token.approve(address(vault), type(uint256).max);
        collection.setApprovalForAll(address(vault), true);
        vm.stopPrank();
    }

    function _drawAndOpen() internal returns (uint256 id) {
        vm.prank(ALICE);
        uint256 draw = tickets.draw(type(uint256).max, block.timestamp);
        MockDrandSource(release.randomness).post(address(tickets), draw, keccak256("M360 draw"));
        tickets.settle(1);
        vm.warp(block.timestamp + tickets.REVEAL_GRACE() + 1);
        id = tickets.drawTicket(draw).itemId;
        vm.prank(ALICE);
        tickets.openDraw(draw, ALICE, _proof(id));
        ledger.sync(32);
    }
}
