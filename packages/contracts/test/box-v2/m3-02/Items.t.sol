// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M234Base} from "../m2-34/Fixture.sol";
import {BackedItems} from "./BackedItems.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {IBoxCollection} from "../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxCoordinatorV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxVaultV2, IBoxVaultItemsV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IBoxReceiverItemsV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {ItemLedgerV2} from "../../../src/box-v2/ItemLedgerV2.sol";
import {ItemHistoryModel} from "../m3-00/ItemHistoryModel.sol";
import {ItemModel} from "../m3-00/ItemModel.sol";
import {ItemKit} from "../kit/m3/ItemKit.sol";
import {SparseBoxTree, MockDrandSource} from "../../box/items/BoxItemsKit.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {IBoxTicketsV2, IBoxTicketsItemsV2} from "../../../src/box-v2/interfaces/IBoxPeripheryV2.sol";
import {ItemReveal} from "../../../src/box/interfaces/BoxTypes.sol";

/// M302-JOURNAL: factory-created M1+M2 plus a local role-16/receiver handoff.
/// The factory has not wired M3 yet: the two mocked coordinator reads, patched vault argument and
/// net-funding producer remain local doubles. The real receiver's companion is now present (M3-23).
/// Token, vault, collection, ledger, hook and PoolManager code are real.
contract M302ItemsTest is M234Base {
    address private constant OWNER = address(0xA11CE);
    BackedItems private funding;
    IBoxVaultV2 private vault;
    ItemLedgerV2 private items;
    ItemModel private model;
    bytes32[] private keys;

    function _integrate(bool hidden) private {
        BoxSpec memory spec = hidden ? _hiddenSpec() : _collectionSpec();
        spec.n = 10;
        {
            (uint256[] memory positions, bytes32[] memory leaves) = _leaves();
            spec.revealRoot = SparseBoxTree.root(4, positions, leaves);
        }
        vm.etch(release.randomness, address(new MockDrandSource()).code);
        _start(spec);
        vault = IBoxVaultV2(box.vault());
        assertEq(vault.firstId(), 1, "oracle uses canonical ids starting at one");
        // The companion exists, but this factory's collection has no Items choice or role-16 wiring yet.
        // Keep explicit net-funding injection for the journal proof; never infer receipts from a balance.
        assertEq(IBoxReceiverItemsV2(address(receiver)).itemFundingCount(), 0);
        assertEq(receiver.itemLedger(), address(0));
        assertEq(box.roleAddress(16), address(0));
        funding = new BackedItems(pm, vault);
        address impl = deployCode("ItemLedgerV2.sol:ItemLedgerV2", abi.encode(pm, release.implementations[0]));
        items = ItemLedgerV2(
            BoxClones.create(
                BoxClones.initCode(
                    impl,
                    abi.encodePacked(
                        address(box),
                        address(vault),
                        box.collection(),
                        box.tickets(),
                        address(funding),
                        address(hook),
                        address(0),
                        uint8(1),
                        uint8(0),
                        uint256(0),
                        uint256(0)
                    )
                )
            )
        );
        funding.wire(address(items));
        bytes memory code = address(vault).code;
        bytes20 at = bytes20(address(items));
        for (uint256 i; i < 20; ++i) {
            code[45 + 80 + i] = at[i];
        }
        vm.etch(address(vault), code);
        vm.mockCall(address(box), abi.encodeCall(IBoxCoordinatorV2.roleAddress, (16)), abi.encode(address(items)));
        vm.mockCall(address(box), abi.encodeWithSignature("receiver()"), abi.encode(address(funding)));
        vm.prank(address(box));
        items.initialize();
        model = new ItemModel(ItemHistoryModel(address(funding)));
        _fill();
        box.graduate();
        if (!hidden) _revealFirst();
        uint256 ownerT = token.balanceOf(address(buyer)) / 2;
        vm.prank(address(buyer));
        token.transfer(OWNER, ownerT);
        vm.startPrank(OWNER);
        token.approve(address(vault), type(uint256).max);
        if (hidden) token.approve(box.tickets(), type(uint256).max);
        IBoxCollection(box.collection()).setApprovalForAll(address(vault), true);
        vm.stopPrank();
        vm.deal(address(this), 10 ether);
    }

    function _revealFirst() private {
        (uint256[] memory positions, bytes32[] memory leaves) = _leaves();
        IBoxCollection(box.collection())
            .reveal(1, 0, bytes32(uint256(1)), bytes32(uint256(2)), 0, 0, SparseBoxTree.proof(4, 0, positions, leaves));
    }

    function _leaves() private pure returns (uint256[] memory positions, bytes32[] memory leaves) {
        positions = new uint256[](10);
        leaves = new bytes32[](10);
        for (uint256 i; i < 10; ++i) {
            positions[i] = i;
            leaves[i] = SparseBoxTree.leaf(i + 1, 0, bytes32(uint256(1)), bytes32(uint256(2)), 0, 0);
        }
    }

    function test_receiptsRequireActualBackingAndResidueHasAnExit() public {
        _integrate(true);
        uint256 amount = vault.collectionSize() * 10 + 3;
        funding.publish{value: amount}(3);
        assertEq(pm.balanceOf(address(items), 0), amount, "a receipt is not real funding");
        _page(1);
        uint256 depth = pm.balanceOf(address(hook), 0);
        assertEq(items.flushResidue(), 3);
        assertEq(model.flushResidue(), 3);
        assertEq(pm.balanceOf(address(hook), 0), depth + 3);
        assertEq(pm.balanceOf(address(items), 0), amount - 3, "base stash cannot be swept");
        assertEq(items.flushResidue(), 0);
        _compare();
    }

    function test_openArtBaselineReplaysAuthenticInitialCounts() public {
        _integrate(false);
        assertEq(vault.hiddenCount(), 0);
        funding.publish{value: 100}(3);
        assertEq(pm.balanceOf(address(items), 0), 100);
        assertEq(funding.itemFundingCount(), 1);
        assertEq(funding.itemFunding(1).hiddenCount, 0);
        items.sync(1);
        assertEq(items.fundingCursor(), 1);
        (uint256 outsideP, uint256 stashP) = items.itemCredit(1);
        assertEq(outsideP, 0);
        assertEq(stashP, 10);
        assertEq(items.flushResidue(), 0);
        assertEq(pm.balanceOf(address(items), 0), 100);
    }

    function test_failedBackingTransferRollsBackReceiptAndAllowsExactRetry() public {
        _integrate(true);
        uint256 money = address(this).balance;
        uint256 custody = address(pm).balance;
        vm.prank(OWNER);
        vm.expectRevert(bytes("driver/wiring"));
        funding.publish(3);
        vm.expectRevert(bytes("manager/active"));
        funding.unlockCallback("");
        vm.mockCall(
            address(pm),
            abi.encodeWithSignature("transfer(address,uint256,uint256)", address(items), 0, 103),
            abi.encode(false)
        );
        vm.expectRevert(bytes("claims transfer"));
        funding.publish{value: 103}(3);
        assertEq(funding.itemFundingCount(), 0);
        assertEq(funding.ledgerTransferred(), 0);
        assertEq(pm.balanceOf(address(funding), 0), 0);
        assertEq(pm.balanceOf(address(items), 0), 0);
        assertEq(address(this).balance, money);
        assertEq(address(pm).balance, custody);
        // Remove the fault and restore the two explicit M3 wiring doubles.
        vm.clearMockedCalls();
        vm.mockCall(address(box), abi.encodeCall(IBoxCoordinatorV2.roleAddress, (16)), abi.encode(address(items)));
        vm.mockCall(address(box), abi.encodeWithSignature("receiver()"), abi.encode(address(funding)));
        funding.publish{value: 103}(3);
        assertEq(pm.balanceOf(address(items), 0), 103);
        assertEq(funding.itemFundingCount(), 1);
        _page(1);
    }

    function test_realTicketsReverseDeliveryReturnAndRepickMatchKitAfterMissedNotices() public {
        _integrate(true);
        uint256 ownerP = OWNER.balance;
        funding.publish{value: 100}(3);
        bytes memory code = address(items).code;
        // Fault injection preserves ledger storage; the real journal must recover every missed notice.
        vm.etch(address(items), hex"60006000fd");
        IBoxTicketsV2 tickets = IBoxTicketsV2(box.tickets());
        vm.prank(OWNER);
        uint256 a = tickets.draw(type(uint256).max, block.timestamp);
        funding.publish{value: 400}(2);
        vm.prank(OWNER);
        uint256 z = tickets.draw(type(uint256).max, block.timestamp);
        keys.push(keccak256(abi.encode(address(tickets), uint8(2), a)));
        keys.push(keccak256(abi.encode(address(tickets), uint8(2), z)));
        MockDrandSource(release.randomness).post(address(tickets), a, keccak256("a"));
        MockDrandSource(release.randomness).post(address(tickets), z, keccak256("z"));
        tickets.settle(2);
        uint256 zid = _open(tickets, z);
        uint256 aid = _open(tickets, a);
        vm.prank(OWNER);
        vault.returnItem(aid, 0, block.timestamp);
        funding.publish{value: 70}(2);
        vm.prank(OWNER);
        vault.withdraw(aid, type(uint256).max, block.timestamp);
        vm.etch(address(items), code);
        IBoxVaultItemsV2 journal = IBoxVaultItemsV2(address(vault));
        assertEq(journal.itemLifecycleCount(), 6);
        assertEq(journal.itemLifecycle(1).at, journal.itemLifecycle(6).at);
        assertEq(journal.itemLifecycle(1).fundingCursor, 1);
        assertEq(journal.itemLifecycle(2).fundingCursor, 2);
        assertEq(journal.itemLifecycle(6).fundingCursor, 3);
        for (uint256 i; i < 7; ++i) {
            _page(1);
        }
        (uint256 outside, uint256 stash) = items.itemCredit(aid);
        assertEq(outside, 40);
        assertEq(stash, 17);
        (outside, stash) = items.itemCredit(zid);
        assertEq(outside, 7);
        assertEq(stash, 50);
        assertEq(IBoxTicketsItemsV2(address(tickets)).activeItemTicket(0), bytes32(0));
        assertEq(pm.balanceOf(address(items), 0), 570);
        assertEq(token.balanceOf(address(vault)), vault.escrowPrincipal());
        assertEq(OWNER.balance, ownerP, "replay never pushes an item payout (F127)");

        // M3-21c now supplies the owner exit. Item earnings have no expiry; R40A's year
        // sweep belongs to failed coordinator pots, not to this graduated item ledger.
        vm.warp(block.timestamp + 366 days);
        uint256[] memory ids = new uint256[](1);
        ids[0] = aid;
        vm.expectRevert(ItemLedgerV2.Unauthorized.selector);
        items.claim(ids, OWNER);
        vm.startPrank(OWNER);
        assertEq(items.claim(ids, OWNER), 57);
        assertEq(model.claim(ids, OWNER), 57);
        ids[0] = zid;
        assertEq(items.claim(ids, OWNER), 57);
        assertEq(model.claim(ids, OWNER), 57);
        vm.expectRevert(ItemLedgerV2.InvalidClaim.selector);
        items.claim(ids, OWNER);
        vm.stopPrank();
        assertEq(OWNER.balance - ownerP, 114);
        assertEq(pm.balanceOf(address(items), 0), 456, "remaining inside stashes stay backed");
        assertEq(pm.balanceOf(address(items), 0) + OWNER.balance - ownerP, 570);
        _compare();
    }

    function _open(IBoxTicketsV2 tickets, uint256 ticket) private returns (uint256 id) {
        id = tickets.drawTicket(ticket).itemId;
        (uint256[] memory positions, bytes32[] memory leaves) = _leaves();
        ItemReveal memory proof;
        proof.imageHash = bytes32(uint256(1));
        proof.avatarHash = bytes32(uint256(2));
        proof.proof = SparseBoxTree.proof(4, id - 1, positions, leaves);
        vm.prank(OWNER);
        tickets.openDraw(ticket, OWNER, proof);
    }

    function _page(uint256 count) private {
        uint256 f = items.fundingCursor();
        uint256 l = items.lifecycleCursor();
        items.sync(count);
        model.sync(count);
        assertLe(items.fundingCursor() - f, count);
        assertLe(items.lifecycleCursor() - l, count);
        _compare();
    }

    function _compare() private view {
        ItemKit.compare(model, items, 1, vault.collectionSize(), keys);
    }
}
