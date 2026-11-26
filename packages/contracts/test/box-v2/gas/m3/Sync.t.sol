// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M360Items, IBoxVaultItemsV2} from "./Items.sol";
import {BoxSpec} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {IItemLedgerV2} from "../../../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {IBoxReceiverItemsV2} from "../../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {SparseBoxTree} from "../../../box/items/BoxItemsKit.sol";

contract M360SyncTest is M360Items {
    function test_maximumInterleavedPageWith32FreshTicketsAndReceipts() public {
        BoxSpec memory s = _hiddenItems(1, 2);
        s.n = 64;
        uint256[] memory positions = new uint256[](64);
        bytes32[] memory leaves = new bytes32[](64);
        for (uint256 i; i < 64; ++i) {
            positions[i] = i;
            leaves[i] = SparseBoxTree.leaf(i + 1, 0, bytes32(i + 1), 0, 0, 0);
        }
        s.revealRoot = SparseBoxTree.root(6, positions, leaves);
        _itemStartSpec(s, true);
        uint256 funding = ledger.fundingCursor();
        for (uint256 i; i < 32; ++i) {
            vm.prank(ALICE);
            tickets.draw(type(uint256).max, block.timestamp);
            _gift(address(receiver), 15000);
            receiver.collect(address(0));
        }
        uint256 backing = pm.balanceOf(address(ledger), 0);
        bytes memory data = abi.encodeCall(IItemLedgerV2.sync, (32));
        _cold();
        vm.prank(BOB);
        (bool ok,) = address(ledger).call{gas: 3_000_000}(data);
        assertFalse(ok, "current keeper allowance cannot replay the fresh page");
        assertEq(ledger.lifecycleCursor(), 0, "failed sync is atomic");
        assertEq(ledger.fundingCursor(), funding);
        assertEq(pm.balanceOf(address(ledger), 0), backing);
        _measure("32 fresh tickets and interleaved receipts", address(ledger), BOB, data, 16_000_000);
        assertEq(ledger.lifecycleCursor(), 32);
        assertEq(ledger.fundingCursor(), funding + 32);
        assertEq(ledger.fundingCursor(), IBoxReceiverItemsV2(address(receiver)).itemFundingCount());
        assertEq(pm.balanceOf(address(ledger), 0), backing, "sync does not move backing");
        uint256 last = type(uint256).max;
        for (uint256 i = 1; i <= 32; ++i) {
            bytes32 key = IBoxVaultItemsV2(address(vault)).itemLifecycle(i).ticketKey;
            (, uint256 credit, bool open) = ledger.ticketCredit(key);
            assertTrue(open);
            assertGt(credit, 0);
            assertLt(credit, last);
            last = credit;
        }
        _measure(
            "caught-up sync is idempotent", address(ledger), BOB, abi.encodeCall(IItemLedgerV2.sync, (32)), 1_000_000
        );
        assertEq(ledger.lifecycleCursor(), 32);
        assertEq(ledger.fundingCursor(), funding + 32);
    }
}
