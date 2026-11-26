// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M363Base, LifeCustody} from "./Fixture.sol";
import {M332ModelJournal} from "../m3-32/ModelJournal.sol";
import {ItemModel} from "../m3-00/ItemModel.sol";
import {ItemHistoryModel} from "../m3-00/ItemHistoryModel.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {BoxTicketsV2} from "../../../src/box-v2/BoxTicketsV2.sol";
import {BoxCollectionV2} from "../../../src/box-v2/BoxCollectionV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2, IBoxReceiverItemsV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxVaultV2, IBoxVaultItemsV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {ListingClass} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {ItemReveal} from "../../../src/box/interfaces/BoxTypes.sol";
import {ItemLedgerV2} from "../../../src/box-v2/ItemLedgerV2.sol";
import {PileVaultV2} from "../../../src/box-v2/PileVaultV2.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {MockDrandSource, SparseBoxTree} from "../../box/items/BoxItemsKit.sol";
import {PoolDriver} from "../kit/BoxV2TestBase.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

/// Original M3-32 money assertions, now against every production release part without S6 doubles.
contract M363ProductionLifecycleTest is M363Base {
    address private constant ALICE = address(0xA332);
    address private constant BOB = address(0xB332);
    ItemLedgerV2 private ledger;
    ItemModel private model;
    M332ModelJournal private journal;
    uint256 private paid;
    uint256 private flushed;

    function test_S2_S3_S4_itemsRealTradesReverseDrawsTransferClaimReturnAgainstOracle() public {
        BoxSpec memory s = _hiddenSpec();
        // The frozen oracle deliberately enumerates a small collection; production replay never does.
        s.n = 10;
        s.firstId = 1;
        (uint256[] memory positions, bytes32[] memory leaves) = _tree();
        s.revealRoot = SparseBoxTree.root(4, positions, leaves);
        s.buyers.a = Branch(1, 8, "", abi.encode(uint8(1)));
        s.sellers.a = Branch(1, 8, "", abi.encode(uint8(2)));
        _start(s);
        uint256 money = _money();
        _fill();
        receiver.collect(address(0));
        assertGt(receiver.itemsHeldP(), 0, "real swaps fund held Items");
        assertEq(IBoxReceiverItemsV2(address(receiver)).itemFundingCount(), 0);
        box.graduate();
        receiver.collect(address(0));
        assertTrue(box.graduated());
        assertEq(receiver.itemsHeldP(), 0);
        ledger = ItemLedgerV2(box.roleAddress(16));
        journal = new M332ModelJournal(box.vault(), address(receiver), address(ledger));
        model = new ItemModel(ItemHistoryModel(address(journal)));
        _compare();

        (uint256 aid, uint256 bid) = _reverseDraws();
        _ownershipAndReturn(aid, bid);
        uint256 depth = pm.balanceOf(box.hook(), 0);
        flushed = ledger.flushResidue();
        assertEq(flushed, model.flushResidue());
        assertEq(pm.balanceOf(box.hook(), 0), depth + flushed);
        _compare();
        assertEq(_money() + ALICE.balance + BOB.balance, money, "all native P conserved");
    }

    function _reverseDraws() private returns (uint256 aid, uint256 bid) {
        uint256 held = token.balanceOf(address(buyer));
        vm.prank(address(buyer));
        token.transfer(ALICE, held);
        BoxTicketsV2 tickets = BoxTicketsV2(box.tickets());
        vm.prank(ALICE);
        token.approve(address(tickets), type(uint256).max);
        uint256 a = _draw(tickets);
        _gift(address(receiver), 3 ether / 100);
        receiver.collect(address(0));
        uint256 b = _draw(tickets);
        uint256 cancel = _draw(tickets);
        IBoxVaultItemsV2 history = IBoxVaultItemsV2(box.vault());
        assertEq(history.itemLifecycle(1).at, history.itemLifecycle(2).at, "one second, different funding cursors");
        assertLt(history.itemLifecycle(1).fundingCursor, history.itemLifecycle(2).fundingCursor);
        MockDrandSource drand = MockDrandSource(release.randomness);
        drand.post(address(tickets), a, keccak256("first"));
        drand.post(address(tickets), b, keccak256("second"));
        assertEq(tickets.settle(3), 2);
        _compare();
        vm.warp(block.timestamp + tickets.REVEAL_GRACE() + 1);
        ItemReveal memory reveal = _proof(tickets.drawTicket(b).itemId);
        vm.prank(ALICE);
        bid = tickets.openDraw(b, ALICE, reveal);
        reveal = _proof(tickets.drawTicket(a).itemId);
        vm.prank(ALICE);
        aid = tickets.openDraw(a, ALICE, reveal);
        tickets.enterTerminal();
        tickets.cancelDraw(cancel);
        _compare();
        (uint256 ac,) = ledger.itemCredit(aid);
        (uint256 bc,) = ledger.itemCredit(bid);
        assertGt(ac, bc, "earlier request keeps its own outside earnings");

    }

    function _ownershipAndReturn(uint256 aid, uint256 bid) private {
        BoxCollectionV2 collection = BoxCollectionV2(box.collection());
        vm.prank(ALICE);
        collection.transferFrom(ALICE, BOB, aid);
        uint256[] memory ids = new uint256[](1);
        ids[0] = aid;
        vm.prank(ALICE);
        vm.expectRevert(ItemLedgerV2.Unauthorized.selector);
        ledger.claim(ids, ALICE);
        LifeCustody refusing = new LifeCustody();
        refusing.setRefusing(true);
        vm.prank(BOB);
        vm.expectRevert(ItemLedgerV2.PayoutFailed.selector);
        ledger.claim(ids, address(refusing));
        _compare();
        _claim(aid, BOB);

        address vault = box.vault();
        vm.prank(ALICE);
        collection.setApprovalForAll(vault, true);
        vm.prank(ALICE);
        IBoxVaultV2(vault).returnItem(bid, 0, block.timestamp);
        _gift(address(receiver), 1 ether / 100);
        receiver.collect(address(0));
        vm.prank(ALICE);
        token.approve(vault, type(uint256).max);
        vm.prank(ALICE);
        IBoxVaultV2(vault).withdraw(bid, type(uint256).max, block.timestamp);
        _compare();
        _claim(bid, ALICE);
    }

    function test_S5_nativePileRealFillMinOutRefusalAndRedemption() public {
        _startPile(address(0), 3 ether);
        PileVaultV2 pile = PileVaultV2(payable(box.vault()));
        _fill();
        box.graduate();
        uint256 tIn = token.balanceOf(address(buyer)) / 2;
        uint256 supply = token.totalSupply();
        uint256 quote = FullMath.mulDiv(3 ether, tIn, supply);
        assertGt(quote, 0);
        assertEq(pile.quoteRedeem(tIn), quote);
        vm.prank(address(buyer));
        token.approve(address(pile), type(uint256).max);
        vm.prank(address(buyer));
        vm.expectRevert(PileVaultV2.BelowMinimum.selector);
        pile.redeem(tIn, quote + 1, BOB);
        LifeCustody refusing = new LifeCustody();
        refusing.setRefusing(true);
        vm.prank(address(buyer));
        vm.expectRevert();
        pile.redeem(tIn, quote, address(refusing));
        assertEq(token.totalSupply(), supply);
        assertEq(address(pile).balance, 3 ether);
        vm.prank(address(buyer));
        assertEq(pile.redeem(tIn, quote, BOB), quote);
        assertEq(BOB.balance, quote);
        assertEq(address(pile).balance + BOB.balance, 3 ether);
        assertEq(token.totalSupply(), supply - tIn);
        assertEq(token.balanceOf(address(pile)), 0);
        assertEq(pile.quoteRedeem(tIn), FullMath.mulDiv(3 ether - quote, tIn, supply - tIn));
    }

    function test_S5_erc20SeedSeparatePermissionlessPullAndFailedReturnRetries() public {
        HostileToken asset = _listedSeed(6);
        uint256 seed = 3e6;
        asset.mint(CREATOR, seed);
        _startPile(address(asset), seed);
        PileVaultV2 pile = PileVaultV2(payable(box.vault()));
        _buy(box.raise() / 5);
        asset.setPaused(true);
        vm.warp(box.deadline());
        box.fail();
        assertTrue(box.failed());
        vm.expectRevert();
        pile.returnSeed();
        assertEq(asset.balanceOf(address(pile)), seed);
        uint256 held = token.balanceOf(address(buyer));
        (uint256 pot, uint256 count) = box.claimState();
        assertEq(count, held);
        vm.startPrank(address(buyer));
        token.approve(address(box), held);
        assertEq(box.claim(held, address(buyer)), pot);
        vm.stopPrank();
        asset.setPaused(false);
        vm.prank(BOB);
        assertEq(pile.returnSeed(), seed);
        assertEq(asset.balanceOf(CREATOR), seed);
        assertEq(asset.balanceOf(BOB), 0);
        assertEq(asset.balanceOf(address(pile)), 0);
        vm.expectRevert(PileVaultV2.WrongPhase.selector);
        pile.returnSeed();
    }

    function _listedSeed(uint8 decimals) private returns (HostileToken asset) {
        asset = new HostileToken("Seed", "SEED", decimals);
        asset.mint(address(this), 10_000);
        asset.approve(address(listings), 10_000);
        listings.add(address(asset), ListingClass.OTHER, 10 ** uint256(decimals));
    }

    function _startPile(address asset, uint256 seed) private {
        BoxSpec memory s = _pile(asset, seed);
        box = _create(s);
        PileVaultV2 pile = PileVaultV2(payable(box.vault()));
        assertFalse(box.gateOpen());
        if (asset == address(0)) {
            vm.prank(CREATOR);
            pile.loadSeed{value: seed}();
        } else {
            assertEq(HostileToken(asset).balanceOf(CREATOR), seed, "factory never pulls seed");
            vm.prank(CREATOR);
            HostileToken(asset).approve(address(pile), seed);
            vm.prank(BOB);
            pile.loadSeed();
        }
        assertTrue(box.gateOpen());
        layout = BoxLayoutV2.curve(s.raise, s.layout == 2);
        token = BoxTokenV2(box.token());
        hook = IBoxHookV2(box.hook());
        receiver = IBoxReceiverV2(box.receiver());
        buyer = new PoolDriver(pm);
        vm.deal(address(buyer), s.raise * 10);
        vm.warp(box.effectiveOpenAt() + 384);
        vm.roll(block.number + 1);
    }

    function _draw(BoxTicketsV2 tickets) private returns (uint256) {
        vm.prank(ALICE);
        return tickets.draw(type(uint256).max, block.timestamp);
    }

    function _tree() private pure returns (uint256[] memory positions, bytes32[] memory leaves) {
        positions = new uint256[](10);
        leaves = new bytes32[](10);
        for (uint256 i; i < 10; ++i) {
            positions[i] = i;
            leaves[i] = SparseBoxTree.leaf(i + 1, 0, bytes32(i + 1), 0, 0, 0);
        }
    }

    function _proof(uint256 id) private pure returns (ItemReveal memory r) {
        (uint256[] memory positions, bytes32[] memory leaves) = _tree();
        r.imageHash = bytes32(id);
        r.proof = SparseBoxTree.proof(4, id - 1, positions, leaves);
    }

    function _compare() private {
        ledger.sync(32);
        model.sync(32);
        assertEq(ledger.fundingCursor(), model.fundingCursor());
        assertEq(ledger.lifecycleCursor(), model.lifecycleCursor());
        for (uint256 i = 1; i <= journal.n(); ++i) {
            (uint256 ap, uint256 astash) = ledger.itemCredit(journal.firstId() + i - 1);
            (uint256 mp, uint256 mstash) = model.itemCredit(i);
            assertEq(ap, mp, "per-item outside credit");
            assertEq(astash, mstash, "per-item retained stash");
        }
        assertEq(model.accounted(), journal.ledgerTransferred());
        assertEq(pm.balanceOf(address(ledger), 0) + paid + flushed, journal.ledgerTransferred());
        _booked();
    }

    function _claim(uint256 id, address owner) private {
        uint256[] memory ids = new uint256[](1);
        ids[0] = id - journal.firstId() + 1;
        vm.prank(owner);
        uint256 expected = model.claim(ids, owner);
        ids[0] = id;
        uint256 before = owner.balance;
        vm.prank(owner);
        uint256 actual = ledger.claim(ids, owner);
        assertEq(actual, expected);
        assertEq(owner.balance - before, actual);
        paid += actual;
        _compare();
    }
}
