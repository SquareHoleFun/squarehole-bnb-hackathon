// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M360Items, BoxTicketsV2, MockDrandSource, IBoxVaultV2, IBoxVaultItemsV2} from "./Items.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IItemLedgerV2} from "../../../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxReceiverV2, IBoxReceiverItemsV2} from "../../../../src/box-v2/interfaces/IBoxReceiverV2.sol";

contract M360LifecycleTest is M360Items {
    function test_freshPlaceholderRequestReleaseAndDelivery() public {
        _itemStart(0, false);
        (bytes memory ret,) = _measure(
            "placeholder request",
            address(tickets),
            ALICE,
            abi.encodeCall(IBoxTickets.take, (1, type(uint256).max, block.timestamp)),
            CUSTODY_LIMIT
        );
        uint256 id = abi.decode(ret, (uint256));
        _measure(
            "placeholder release",
            address(tickets),
            ALICE,
            abi.encodeCall(IBoxTickets.handBack, (_one(id), 0, block.timestamp)),
            CUSTODY_LIMIT
        );
        _measure(
            "placeholder request again",
            address(tickets),
            ALICE,
            abi.encodeCall(IBoxTickets.take, (1, type(uint256).max, block.timestamp)),
            CUSTODY_LIMIT
        );
        box.graduate();
        receiver.collect(address(0));
        MockDrandSource(release.randomness).post(address(tickets), 0, keccak256("M360 placeholder"));
        tickets.acceptGraduationWord();
        uint256 number = tickets.numberOf(id + 1);
        _measure(
            "placeholder delivery and reveal",
            address(tickets),
            ALICE,
            abi.encodeCall(IBoxTickets.open, (id + 1, _proof(number))),
            CUSTODY_LIMIT
        );
        assertEq(collection.ownerOf(number), ALICE);
        assertEq(IBoxVaultItemsV2(address(vault)).itemLifecycleCount(), 4);
        _measure(
            "sync placeholder journal", address(ledger), BOB, abi.encodeCall(IItemLedgerV2.sync, (32)), CUSTODY_LIMIT
        );
        assertEq(ledger.lifecycleCursor(), 4);
    }

    function test_freshDrawDeliveryReturnWithdrawAndCancel() public {
        _itemStart(0, true);
        (bytes memory ret,) = _measure(
            "draw request",
            address(tickets),
            ALICE,
            abi.encodeCall(IBoxTickets.draw, (type(uint256).max, block.timestamp)),
            CUSTODY_LIMIT
        );
        uint256 draw = abi.decode(ret, (uint256));
        _gift(address(receiver), 3000);
        receiver.collect(address(0));
        MockDrandSource(release.randomness).post(address(tickets), draw, keccak256("M360 measured"));
        tickets.settle(1);
        vm.warp(block.timestamp + tickets.REVEAL_GRACE() + 1);
        uint256 id = tickets.drawTicket(draw).itemId;
        _measure(
            "draw delivery and reveal",
            address(tickets),
            ALICE,
            abi.encodeCall(IBoxTickets.openDraw, (draw, ALICE, _proof(id))),
            CUSTODY_LIMIT
        );
        _measure(
            "known item return",
            address(vault),
            ALICE,
            abi.encodeCall(IBoxVaultV2.returnItem, (id, 0, block.timestamp)),
            CUSTODY_LIMIT
        );
        _gift(address(receiver), 3000);
        receiver.collect(address(0));
        _measure(
            "largest named withdrawal batch",
            address(vault),
            ALICE,
            abi.encodeCall(IBoxVaultV2.withdrawBatch, (_one(id), type(uint256).max, block.timestamp)),
            CUSTODY_LIMIT
        );
        _measure(
            "largest named return batch",
            address(vault),
            ALICE,
            abi.encodeCall(IBoxVaultV2.returnItems, (_one(id), 0, block.timestamp)),
            CUSTODY_LIMIT
        );
        vm.prank(ALICE);
        uint256 cancel = tickets.draw(type(uint256).max, block.timestamp);
        vm.warp(block.timestamp + tickets.REVEAL_GRACE() + 1);
        tickets.enterTerminal();
        _measure(
            "draw cancellation", address(tickets), BOB, abi.encodeCall(IBoxTickets.cancelDraw, (cancel)), CUSTODY_LIMIT
        );
        _measure(
            "sync mixed lifecycle journal",
            address(ledger),
            BOB,
            abi.encodeCall(IItemLedgerV2.sync, (32)),
            CUSTODY_LIMIT
        );
        assertEq(ledger.lifecycleCursor(), IBoxVaultItemsV2(address(vault)).itemLifecycleCount());
        assertEq(collection.ownerOf(id), address(vault));
        uint256 beforeDepth = pm.balanceOf(box.hook(), 0);
        (ret,) = _measure(
            "item residue flush", address(ledger), BOB, abi.encodeCall(IItemLedgerV2.flushResidue, ()), 1_000_000
        );
        assertEq(pm.balanceOf(box.hook(), 0), beforeDepth + abi.decode(ret, (uint256)));
        _booked();
    }

    function test_oneEntryCapsRefuseLargerBatchesAtomically() public {
        _itemStart(0, true);
        uint256 id = _drawAndOpen();
        uint256 beforeCount = IBoxVaultItemsV2(address(vault)).itemLifecycleCount();
        uint256[] memory ids = new uint256[](2);
        ids[0] = id;
        ids[1] = id + 1;
        vm.expectRevert(abi.encodeWithSelector(IBoxVaultItemsV2.ItemBatchTooLarge.selector, 2, 1));
        vm.prank(ALICE);
        vault.returnItems(ids, 0, block.timestamp);
        vm.expectRevert();
        vm.prank(ALICE);
        ledger.claim(ids, ALICE);
        assertEq(collection.ownerOf(id), ALICE);
        assertEq(IBoxVaultItemsV2(address(vault)).itemLifecycleCount(), beforeCount);
    }

    function test_everyColdCallbackHasTwoTimesHeadroomWithBacklog() public {
        _itemStart(0, true);
        _drawAndOpen();
        for (uint256 i; i < 40; ++i) {
            _gift(address(receiver), 1500);
            receiver.collect(address(0));
        }
        uint256 beforeCursor = ledger.fundingCursor();
        bytes[5] memory calls = [
            abi.encodeWithSignature("onTicketsOpened(uint256,uint256)", 1, 1),
            abi.encodeWithSignature("onTicketsReleased(address,uint256,uint256,uint256)", ALICE, 1, 0, 0),
            abi.encodeWithSignature("onWithdrawn(address,uint256[])", ALICE, _one(1)),
            abi.encodeWithSignature("onReturned(address,uint256[])", ALICE, _one(1)),
            abi.encodeWithSignature("onDelivered(uint256,address,uint64)", 1, ALICE, uint64(block.timestamp))
        ];
        uint256 cap = vault.ITEM_LEDGER_GAS();
        for (uint256 i; i < calls.length; ++i) {
            (, uint256 used) = _measure(
                string.concat("cold callback ", vm.toString(i)), address(ledger), address(vault), calls[i], cap / 2
            );
            assertLt(used * 2, cap, "2x includes conservative transaction overhead");
        }
        assertEq(ledger.fundingCursor(), beforeCursor, "callbacks defer replay");
        _measure(
            "maximum 32 receipt sync page", address(ledger), BOB, abi.encodeCall(IItemLedgerV2.sync, (32)), 12_000_000
        );
        assertEq(ledger.fundingCursor(), beforeCursor + 32);
    }

    function test_collectBothSidesAndRefusingLedger() public {
        _itemStart(0, true);
        _drawAndOpen();
        _gift(address(receiver), 15000);
        buyer.swap(hook.poolKey(), true, box.raise() / 2, TickMath.MIN_SQRT_PRICE + 1);
        buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 2, TickMath.MAX_SQRT_PRICE - 1);
        _sellFeeP();
        uint256 prior = IBoxReceiverItemsV2(address(receiver)).itemFundingCount();
        vm.etch(address(ledger), hex"5f5ffd");
        _measure(
            "collect both item sides with refusing ledger",
            address(receiver),
            BOB,
            abi.encodeCall(IBoxReceiverV2.collect, (address(0))),
            12_000_000
        );
        assertGt(IBoxReceiverItemsV2(address(receiver)).itemFundingCount(), prior);
        bool buyers;
        bool sellers;
        IBoxReceiverItemsV2 history = IBoxReceiverItemsV2(address(receiver));
        for (uint256 id = prior + 1; id <= history.itemFundingCount(); ++id) {
            if (history.itemFunding(id).side == 1) buyers = true;
            if (history.itemFunding(id).side == 2) sellers = true;
        }
        assertTrue(buyers && sellers, "both sides publish actual receipts");
        _booked();
    }
}
