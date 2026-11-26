// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {ItemModel} from "./ItemModel.sol";
import {ItemHistoryModel} from "./ItemHistoryModel.sol";
import {IItemLedgerV2} from "../../../src/box-v2/interfaces/IItemLedgerV2.sol";

contract M300ItemsTest is Test {
    ItemHistoryModel h;
    ItemModel m;
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    bytes32 constant A = keccak256("draw A");
    bytes32 constant B = keccak256("draw B");
    function setUp() public { h = new ItemHistoryModel(4, 1, 2); m = new ItemModel(h); }
    function sync() internal {
        m.sync(32); assertEq(m.accounted(), h.ledgerTransferred()); assertEq(h.accounted(),h.received());
    }
    function item(uint256 id, uint256 credit, uint256 stash) internal view {
        (uint256 c, uint256 s) = m.itemCredit(id); assertEq(c, credit); assertEq(s, stash);
    }
    function ticket(bytes32 key, uint256 start, uint256 credit, uint256 stash, bool open) internal view {
        (uint256 s, uint256 c, bool o) = m.ticketCredit(key);
        assertEq(s, start); assertEq(c, credit); assertEq(o, open); assertEq(m.ticketStash(key), stash);
    }
    function test_S2_S3_sameSecondReverseDeliveryMixedPolicies() public {
        h.graduate(); h.request(A); h.fund(1, 1, 1, 40); h.request(B); h.fund(2, 1, 2, 40);
        sync(); ticket(A, 0, 20, 0, true); ticket(B, 10, 10, 10, true);
        assertEq(h.buyBackP(), 20); assertEq(m.hiddenStash(), 20);
        h.deliver(B, 3, BOB); h.deliver(A, 1, ALICE); sync();
        item(1, 20, 0); item(3, 10, 10); item(2, 0, 0); item(4, 0, 0);
        ticket(A, 0, 0, 0, false); ticket(B, 10, 0, 0, false);
        assertEq(h.itemLifecycle(1).at, h.itemLifecycle(2).at);
    }
    function test_S4_cancelRestoresHiddenStashWithoutEnrichingOpenTicket() public {
        h.graduate(); h.fund(1, 2, 0, 40); h.request(A); h.fund(1, 2, 0, 40); h.request(B); sync();
        ticket(A, 10, 10, 10, true); ticket(B, 20, 0, 20, true); assertEq(m.hiddenStash(), 40);
        h.cancel(A); sync(); ticket(B, 20, 0, 20, true); assertEq(m.hiddenStash(), 50);
        assertEq(m.residue(), 10); h.request(keccak256("C")); sync();
        assertEq(m.ticketStash(keccak256("C")), 16); assertEq(m.hiddenStash(), 34);
        h.deliver(B, 4, BOB); sync(); item(4, 0, 20);
        assertEq(m.flushResidue(), 10); assertEq(m.hiddenStash(), 34); sync();
        vm.expectRevert(); h.request(A);
    }
    function test_S4_preGraduationBaseIsSeparateAndFollowsKnownItem() public {
        h.request(A); h.fund(1, 1, 1, 43); h.fund(2, 1, 2, 29); sync();
        assertEq(h.itemsHeldP(), 72); assertEq(h.itemFundingCount(), 0);
        h.graduate(); h.deliver(A, 2, ALICE); h.fund(1, 2, 0, 40); sync();
        item(2, 10, 10); assertEq(m.hiddenStash(), 30); assertEq(m.baseUnassigned(), 30);
        assertEq(h.buyBackP(), 29); assertEq(m.residue(), 3);
        h.move(2, BOB); h.back(2); h.fund(1, 2, 0, 40); h.pick(2, BOB); sync();
        item(2, 10, 20); assertEq(m.hiddenStash(), 60);
        vm.prank(ALICE); vm.expectRevert(); m.claim(_ids(2), ALICE);
    }
    function test_S3_S4_missedCallbacksBoundedReplayAndNoCurrentStateGuess() public {
        h.graduate(); h.pick(1, ALICE); h.fund(1, 2, 0, 40); h.back(1);
        h.fund(2, 2, 0, 40); h.pick(1, BOB); h.fund(1, 2, 0, 40);
        vm.prank(BOB); vm.expectRevert(abi.encodeWithSelector(IItemLedgerV2.ItemSyncPending.selector, 0, 0));
        m.claim(_ids(1), BOB);
        for (uint256 i; i < 8; ++i) {
            uint256 f = m.fundingCursor(); uint256 l = m.lifecycleCursor(); m.sync(1);
            assertLe(m.fundingCursor() - f, 1); assertLe(m.lifecycleCursor() - l, 1);
            assertEq(m.accounted(), h.ledgerTransferred());
        }
        item(1, 20, 0); assertEq(m.fundingCursor(), 5); assertEq(m.lifecycleCursor(), 3);
        vm.expectRevert(); m.sync(0); vm.expectRevert(); m.sync(33);
        h.back(1); m.sync(1); assertEq(m.lifecycleCursor(), 4);
    }
    function test_S2_atomicReceiptsZeroSourcesAndAuthentication() public {
        h.graduate(); assertEq(h.itemFundingCount(), 2);
        assertEq(h.itemFunding(1).source, 3); assertEq(h.itemFunding(2).ledgerP, 0);
        h.refuseTransfer(true); vm.expectRevert(); h.fund(1, 1, 1, 40);
        assertEq(h.itemFundingCount(), 2); assertEq(h.ledgerTransferred(), 0);
        h.refuseTransfer(false); vm.prank(ALICE); vm.expectRevert(); h.fund(1, 1, 1, 40);
        h.fund(1, 1, 1, 40); sync(); m.sync(32); assertEq(m.hiddenStash(), 40);
        vm.expectRevert(); h.itemFunding(0); vm.expectRevert(); h.itemLifecycle(1);
        vm.expectRevert(); h.fund(2, 1, 1, 40); // buyer batch cannot be relabelled sellers
    }
    function test_S2_zeroOneAllOutsideAndTwoLevelConservation() public {
        h.graduate(); h.fund(2,2,0,40); sync(); assertEq(h.buyBackP(),40);
        h.fund(1,2,0,40); h.pick(1,ALICE); h.fund(2,2,0,40); sync(); item(1,10,10);
        for (uint256 id = 2; id <= 4; ++id) h.pick(id,BOB);
        h.fund(2,2,0,40); sync(); item(1,20,10);
        for (uint256 id = 2; id <= 4; ++id) item(id,10,10);
        assertEq(m.hiddenStash(),0); assertEq(h.received(),160); assertEq(h.buyBackP(),70);
    }
    function test_S4_invalidItemIdsAndFinalHiddenSlotRemainder() public {
        vm.expectRevert(); m.itemCredit(0); vm.expectRevert(); m.itemCredit(5);
        h.graduate(); h.fund(1,2,0,40); h.request(A); h.fund(1,2,0,40); h.request(B); h.cancel(A);
        bytes32 c = keccak256("C"); bytes32 d = keccak256("D"); bytes32 e = keccak256("E");
        h.request(c); h.request(d); h.request(e); sync();
        assertEq(m.ticketStash(c),16); assertEq(m.ticketStash(d),17); assertEq(m.ticketStash(e),17);
        assertEq(m.hiddenStash(),0); ticket(B,20,0,20,true); assertEq(m.residue(),10);
    }
    function test_R8_pickCollectTimingGapRemains() public {
        h.graduate(); h.pick(1, ALICE); h.fund(1, 2, 0, 400); sync();
        vm.prank(ALICE); assertEq(m.claim(_ids(1), ALICE), 100);
        assertEq(uint256(100) - (1000 * 100 / 10_000 + 1000 * 500 / 10_000), 40);
        h.back(1); sync(); item(1, 0, 0);
    }
    function testFuzz_S4_reverseDeliveryPerItem(uint128 x, uint128 y, bool reverse) public {
        h.graduate(); h.request(A); h.fund(1, 2, 0, x); sync();
        uint256 q = uint256(x) / 4; uint256 r = uint256(y) / 4;
        ticket(A, 0, q, 0, true); assertEq(m.hiddenStash(), 3*q);
        h.request(B); h.fund(2, 2, 0, y); sync();
        ticket(A, 0, q+r, 0, true); ticket(B, q, r, q, true);
        if (reverse) { h.deliver(B, 4, BOB); sync(); item(4, r, q); h.deliver(A, 2, ALICE); }
        else { h.deliver(A, 2, ALICE); sync(); item(2, q+r, 0); h.deliver(B, 4, BOB); }
        sync(); item(2, q+r, 0); item(4, r, q); assertEq(m.hiddenStash(), 2*q);
        assertEq(m.residue(), uint256(x)%4 + uint256(y)%4); assertEq(h.buyBackP(), 2*r);
    }
    function _ids(uint256 id) internal pure returns (uint256[] memory ids) { ids = new uint256[](1); ids[0] = id; }
}
