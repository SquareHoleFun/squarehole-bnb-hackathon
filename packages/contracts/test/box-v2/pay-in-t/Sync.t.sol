// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M363Base} from "../m3-63-fix-create/Fixture.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {ItemLedgerV2} from "../../../src/box-v2/ItemLedgerV2.sol";
import {BoxTicketsV2} from "../../../src/box-v2/BoxTicketsV2.sol";
import {SparseBoxTree} from "../../box/items/BoxItemsKit.sol";
contract PayInTSyncTest is M363Base {
    address constant ALICE = address(0xA360);
    ItemLedgerV2 private ledger;
    BoxTicketsV2 private tickets;
    function _initializeCase() private {
        BoxSpec memory s = _hiddenSpec();
        s.buyers.a = Branch(2, 8, "", abi.encode(uint8(1)));
        s.sellers.a = Branch(1, 8, "", abi.encode(uint8(2)));
        s.n = 64; s.firstId = 1;
        uint256[] memory positions = new uint256[](64); bytes32[] memory leaves = new bytes32[](64);
        for (uint256 i; i < 64; ++i) { positions[i] = i; leaves[i] = SparseBoxTree.leaf(i + 1, 0, bytes32(i + 1), 0, 0, 0); }
        s.revealRoot = SparseBoxTree.root(6, positions, leaves);
        _start(s); _fill(); receiver.collect(address(0)); box.graduate(); receiver.collect(address(0));
        ledger = ItemLedgerV2(box.roleAddress(16)); tickets = BoxTicketsV2(box.tickets()); ledger.sync(32);
        uint256 held = token.balanceOf(address(buyer)); vm.prank(address(buyer)); token.transfer(ALICE, held);
        vm.prank(ALICE); token.approve(address(tickets), type(uint256).max);
    }
    function _cold() private {
        for (uint256 i; i < 24; ++i) {
            address part = box.roleAddress(i); if (part != address(0)) vm.cool(part);
            address impl = release.implementations[i]; if (impl != address(0)) vm.cool(impl);
        }
        vm.cool(address(pm)); vm.cool(ALICE);
    }
    function test_T16_keeperMixedCurrencyPageFitsWithTwoTimesHeadroom() public {
        _initializeCase();
        uint256 beforeFunding = ledger.fundingCursor();
        for (uint256 i; i < 8; ++i) {
            vm.prank(ALICE); tickets.draw(type(uint256).max, block.timestamp);
            _gift(address(receiver), box.raise() / 100); receiver.collect(address(0));
            vm.roll(block.number + 1); receiver.buyBack(address(0));
        }
        _cold(); uint256 beforeGas = gasleft(); ledger.sync(8); uint256 used = beforeGas - gasleft();
        emit log_named_uint("cold mixed item sync eight receipts and operations", used);
        assertLe(used * 2, 16_000_000);
        assertEq(ledger.lifecycleCursor(), 8); assertEq(ledger.fundingCursor(), beforeFunding + 8);
    }
}
