// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {IItemLedgerV2} from "../../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {IItemLedgerCalls} from "../../../src/box-v2/interfaces/ILedgerCalls.sol";
import {ItemFundingV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {ItemModel} from "../m3-00/ItemModel.sol";
import {ItemHistoryModel} from "../m3-00/ItemHistoryModel.sol";
import {ItemKit} from "../kit/m3/ItemKit.sol";
import {ItemCoordinatorDouble, JournalDouble, ItemLedgerProbe} from "./Fixture.sol";

abstract contract ItemAccountingBase is Test {
    IPoolManager pm;
    ItemCoordinatorDouble c;
    JournalDouble j;
    ItemHistoryModel h;
    ItemModel m;
    ItemLedgerProbe ledger;
    ItemLedgerProbe implementation;
    bytes32[] keys;
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    address constant DEPTH = address(0xD3);

    function setUp() public {
        _setup(1, 2, 1);
    }

    function _setup(uint8 b, uint8 s, uint256 first) internal {
        _setupCount(b, s, first, 4);
    }

    function _setupCount(uint8 b, uint8 s, uint256 first, uint32 n) internal {
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        address ci = address(new ItemCoordinatorDouble());
        c = ItemCoordinatorDouble(BoxClones.create(BoxClones.initCode(ci, "")));
        j = new JournalDouble(pm, n, b, s);
        h = j.history();
        m = new ItemModel(h);
        implementation = new ItemLedgerProbe(pm, ci);
        bytes memory args = abi.encodePacked(
            address(c), address(j), address(j), address(j), address(j), DEPTH, address(0), b, s, uint256(1), uint256(10)
        );
        ledger = ItemLedgerProbe(BoxClones.create(BoxClones.initCode(address(implementation), args)));
        j.wire(address(c), address(ledger), first);
        c.configure(address(pm), address(j), DEPTH, address(ledger));
        vm.deal(address(j), type(uint128).max);
        vm.etch(DEPTH, hex"00");
        c.initializeLedger();
    }

    function _key(uint256 id) internal returns (bytes32 k) {
        k = keccak256(abi.encode(address(j), uint8(2), id));
        keys.push(k);
    }

    function _page(uint256 n) internal {
        uint256 f = ledger.fundingCursor();
        uint256 l = ledger.lifecycleCursor();
        ledger.sync(n);
        m.sync(n);
        assertLe(ledger.fundingCursor() - f, n);
        assertLe(ledger.lifecycleCursor() - l, n);
        _compare();
    }

    function _compare() internal view {
        if (j.firstId() == 1) {
            ItemKit.compare(m, ledger, 1, 4, keys);
        } else {
            for (uint256 i = 1; i <= 4; ++i) {
                (uint256 a, uint256 b) = ledger.itemCredit(j.firstId() + i - 1);
                (uint256 x, uint256 y) = m.itemCredit(i);
                assertEq(a, x);
                assertEq(b, y);
            }
        }
        for (uint256 i; i < keys.length; ++i) {
            assertEq(ledger.ticketStash(keys[i]), m.ticketStash(keys[i]));
        }
        (uint256 hidden, uint256 stash, uint256 base, uint256 unit, uint256 residue, uint256 liability) =
            ledger.totals();
        assertEq(hidden, m.hidden());
        assertEq(stash, m.hiddenStash());
        assertEq(base, m.baseUnassigned());
        assertEq(unit, m.basePerItem());
        assertEq(residue, m.residue());
        uint256 sum = stash + base + residue;
        for (uint256 i; i < 4; ++i) {
            (uint256 a, uint256 b) = ledger.itemCredit(j.firstId() + i);
            sum += a + b;
        }
        for (uint256 i; i < keys.length; ++i) {
            (, uint256 p,) = ledger.ticketCredit(keys[i]);
            sum += p + ledger.ticketStash(keys[i]);
        }
        assertEq(sum, liability, "every ledger liability");
        uint256 pending;
        for (uint256 i = ledger.fundingCursor() + 1; i <= h.itemFundingCount(); ++i) {
            pending += h.itemFunding(i).ledgerP;
        }
        assertEq(pm.balanceOf(address(ledger), 0), sum + pending, "PM backing including backlog");
        assertEq(pm.balanceOf(DEPTH, 0), m.depth());
        assertEq(m.accounted(), h.ledgerTransferred());
        assertEq(h.accounted(), h.received());
    }
}

contract ItemAccountingTest is ItemAccountingBase {
    function test_sameSecondReverseDeliveryAndMixedPolicies() public {
        j.graduate();
        _page(32);
        bytes32 a = _key(1);
        bytes32 b = _key(2);
        j.request(a);
        _page(32);
        j.fund(1, 1, 1, 40);
        _page(32);
        j.request(b);
        _page(32);
        j.fund(2, 1, 2, 40);
        _page(32);
        j.deliver(b, 3, BOB);
        _page(32);
        j.deliver(a, 1, ALICE);
        _page(32);
        (uint256 outside,) = ledger.itemCredit(1);
        assertEq(outside, 20);
        (outside,) = ledger.itemCredit(3);
        assertEq(outside, 10);
        assertEq(h.itemLifecycle(1).at, h.itemLifecycle(2).at);
    }

    function test_cancelOnlyOneKeyRestoresHiddenRemainder() public {
        j.graduate();
        _page(32);
        j.fund(1, 2, 0, 40);
        _page(32);
        bytes32 a = _key(1);
        bytes32 b = _key(2);
        j.request(a);
        _page(32);
        j.fund(1, 2, 0, 40);
        _page(32);
        j.request(b);
        _page(32);
        j.cancel(a);
        _page(32);
        for (uint256 i = 3; i <= 5; ++i) {
            j.request(_key(i));
            _page(32);
        }
        assertEq(ledger.ticketStash(keys[2]), 16);
        assertEq(ledger.ticketStash(keys[3]), 17);
        assertEq(ledger.ticketStash(keys[4]), 17);
        assertEq(ledger.ticketStash(b), 20);
        assertEq(ledger.flushResidue(), m.flushResidue());
        _compare();
        j.deliver(b, 4, BOB);
        _page(32);
    }

    function test_unopenedPlaceholdersGraduationTransferReturnRepick() public {
        bytes32 a = _key(1);
        j.request(a);
        _page(32);
        j.fund(1, 1, 1, 43);
        _page(32);
        j.fund(2, 1, 2, 29);
        _page(32);
        assertEq(h.itemFundingCount(), 0);
        j.graduate();
        _page(32);
        j.deliver(a, 2, ALICE);
        _page(32);
        j.fund(1, 2, 0, 40);
        _page(32);
        j.move(2, BOB);
        _page(32);
        j.back(2);
        _page(32);
        j.fund(1, 2, 0, 40);
        _page(32);
        j.pick(2, BOB);
        _page(32);
        (uint256 p, uint256 stash) = ledger.itemCredit(2);
        assertEq(p, 10);
        assertEq(stash, 20);
        assertEq(h.buyBackP(), 29);
    }

    function test_missedNoticesReplayBothJournalsOneStepAndLifecycleOnly() public {
        j.graduate();
        _compare();
        j.pick(1, ALICE);
        _compare();
        j.fund(1, 2, 0, 40);
        _compare();
        j.back(1);
        _compare();
        j.fund(2, 2, 0, 40);
        _compare();
        j.pick(1, BOB);
        _compare();
        j.fund(1, 2, 0, 40);
        _compare();
        for (uint256 i; i < 8; ++i) {
            _page(1);
        }
        assertEq(ledger.fundingCursor(), 5);
        assertEq(ledger.lifecycleCursor(), 3);
        j.back(1);
        _page(1);
        assertEq(ledger.lifecycleCursor(), 4);
        _page(32);
    }

    function test_zeroOneAllOutsideAndBothKeepSides() public {
        _setup(1, 1, 1);
        j.fund(1, 2, 0, 41);
        _page(32);
        j.fund(2, 2, 0, 82);
        _page(32);
        j.graduate();
        _page(1);
        _page(1);
        j.fund(1, 2, 0, 40);
        _page(32);
        for (uint256 i = 1; i <= 4; ++i) {
            j.pick(i, ALICE);
            _page(32);
            j.fund(2, 2, 0, 43);
            _page(32);
        }
        assertEq(h.buyBackP(), 0);
        assertEq(ledger.flushResidue(), m.flushResidue());
        _compare();
    }

    function test_bothBurnAndSingleEnabledSide() public {
        _setup(2, 2, 1);
        j.fund(1, 2, 0, 41);
        j.graduate();
        _page(32);
        j.fund(2, 2, 0, 43);
        _page(32);
        assertEq(h.buyBackP(), 81);
        j.pick(1, ALICE);
        _page(32);
        j.fund(1, 2, 0, 43);
        _page(32);
        _setup(0, 1, 1);
        j.graduate();
        _page(32);
        j.fund(2, 2, 0, 41);
        _page(32);
    }

    function test_firstIdAndKnownPickBeforeCollectGapBound() public {
        _setup(1, 2, 100);
        j.graduate();
        _page(32);
        j.pick(1, ALICE);
        _page(32);
        j.fund(1, 2, 0, 400);
        _page(32);
        (uint256 p,) = ledger.itemCredit(100);
        assertEq(p, 100);
        assertEq(p - (1000 * 100 / 10_000 + 1000 * 500 / 10_000), 40);
        assertLe(p, 400 / 4);
        vm.expectRevert();
        ledger.itemCredit(99);
        vm.expectRevert();
        ledger.itemCredit(104);
    }

    function test_failureBeforeGraduationNeverFundsItems() public {
        j.request(_key(1));
        _page(32);
        j.fund(1, 2, 0, 43);
        _page(32);
        j.fund(2, 2, 0, 29);
        _page(32);
        j.fail();
        _page(32);
        assertEq(h.pot(), 72);
        j.cancel(keys[0]);
        _page(32);
        j.fund(1, 2, 0, 9);
        _page(32);
        assertEq(h.fit(), 0);
        assertEq(h.pot(), 81);
        assertEq(ledger.fundingCursor(), 0);
    }

    function test_cancelUnopenedPlaceholderKeepsOtherKeysAndBaseSeparate() public {
        bytes32 a = _key(1);
        bytes32 b = _key(2);
        j.request(a);
        _page(32);
        j.request(b);
        _page(32);
        j.fund(1, 2, 0, 43);
        _page(32);
        j.cancel(a);
        _page(32);
        j.graduate();
        _page(32);
        j.fund(1, 2, 0, 40);
        _page(32);
        j.deliver(b, 3, ALICE);
        _page(32);
        (uint256 p, uint256 stash) = ledger.itemCredit(3);
        assertEq(p, 10);
        assertEq(stash, 10);
        j.pick(2, BOB);
        _page(32);
        (p, stash) = ledger.itemCredit(2);
        assertEq(p, 0);
        assertEq(stash, 20);
    }

    function test_residueDoesNotSweepBacklogOrAnyStash() public {
        j.graduate();
        _page(32);
        j.fund(1, 2, 0, 43);
        _page(32);
        j.request(_key(1));
        _page(32);
        j.fund(1, 2, 0, 49);
        _compare();
        assertEq(ledger.flushResidue(), 3);
        assertEq(m.flushResidue(), 3);
        _compare();
        _page(32);
        assertEq(ledger.flushResidue(), 1);
        assertEq(m.flushResidue(), 1);
        _compare();
    }

    function test_donationsCannotManufactureCredits() public {
        j.graduate();
        _page(32);
        j.gift(777);
        ledger.sync(32);
        assertEq(ledger.flushResidue(), 0);
        assertEq(ledger.fundingCursor(), 2);
        for (uint256 i = 1; i <= 4; ++i) {
            (uint256 p, uint256 s) = ledger.itemCredit(i);
            assertEq(p + s, 0);
        }
    }

    function test_invalidOrUnbackedReceiptRollsBackPage() public {
        j.graduate();
        _page(32);
        j.setSkipBacking(true);
        j.fund(1, 2, 0, 40);
        vm.expectRevert();
        ledger.sync(32);
        assertEq(ledger.fundingCursor(), 2);
        ItemFundingV2 memory r = h.itemFunding(3);
        r.ledgerP = 39;
        j.corrupt(3, r);
        j.gift(100);
        vm.expectRevert();
        ledger.sync(32);
        assertEq(ledger.fundingCursor(), 2);
    }

    function test_noticesAuthenticateButNeverNeedReplayOrFunding() public {
        vm.expectRevert();
        ledger.onTicketsOpened(1, 4);
        bytes[] memory notices = new bytes[](5);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        notices[0] = abi.encodeCall(IItemLedgerCalls.onTicketsOpened, (1, 4));
        notices[1] = abi.encodeCall(IItemLedgerCalls.onTicketsReleased, (ALICE, 1, 3, 1));
        notices[2] = abi.encodeCall(IItemLedgerCalls.onWithdrawn, (ALICE, ids));
        notices[3] = abi.encodeCall(IItemLedgerCalls.onReturned, (ALICE, ids));
        notices[4] = abi.encodeCall(IItemLedgerCalls.onDelivered, (1, ALICE, uint64(1)));
        j.graduate();
        j.request(_key(1));
        j.fund(1, 2, 0, 40);
        for (uint256 i; i < 5; ++i) {
            assertTrue(j.notice(notices[i]));
        }
        assertEq(ledger.fundingCursor(), 0);
        assertEq(ledger.lifecycleCursor(), 0);
        _page(32);
    }

    function test_initializationAndBounds() public {
        vm.expectRevert();
        implementation.initialize();
        vm.expectRevert();
        implementation.sync(1);
        vm.expectRevert();
        c.initializeLedger();
        vm.expectRevert();
        ledger.sync(0);
        vm.expectRevert();
        ledger.sync(33);
        vm.expectRevert();
        ledger.itemCredit(0);
        vm.expectRevert();
        ledger.itemCredit(5);
        (uint8 b, uint8 s) = ledger.insidePolicies();
        assertEq(b, 1);
        assertEq(s, 2);
    }

    function testFuzz_reverseDeliveryAfterEveryAction(uint128 x, uint128 y, bool reverse) public {
        j.graduate();
        _page(32);
        bytes32 a = _key(1);
        bytes32 b = _key(2);
        j.request(a);
        _page(32);
        j.fund(1, 2, 0, uint256(x) / 2);
        _page(32);
        j.request(b);
        _page(32);
        j.fund(2, 2, 0, uint256(y) / 2);
        _page(32);
        if (reverse) {
            j.deliver(b, 4, BOB);
            _page(32);
            j.deliver(a, 2, ALICE);
        } else {
            j.deliver(a, 2, ALICE);
            _page(32);
            j.deliver(b, 4, BOB);
        }
        _page(32);
    }
}
