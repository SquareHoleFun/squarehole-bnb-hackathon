// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ItemAccountingBase} from "./Accounting.t.sol";
import {ItemLedgerV2} from "../../../src/box-v2/ItemLedgerV2.sol";
import {IItemLedgerV2} from "../../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {IItemLedgerCalls} from "../../../src/box-v2/interfaces/ILedgerCalls.sol";
import {ItemFundingV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {ItemLifecycleV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";

contract ItemAdversarialTest is ItemAccountingBase {
    function test_assignmentBetweenSideGraduationReleasesKeepsBothBaseShares() public {
        _setup(1, 1, 1);
        j.fund(1, 2, 0, 40);
        j.fund(2, 2, 0, 80);
        bytes32 key = _key(1);
        j.request(key);
        _page(32);
        j.graduate();
        j.deliver(key, 1, ALICE);
        // A delayed second release follows delivery in immutable opposite-cursor order.
        ItemLifecycleV2 memory op = h.itemLifecycle(2);
        op.fundingCursor = 1;
        j.corruptOperation(2, op);
        ItemFundingV2 memory r = h.itemFunding(2);
        r.lifecycleCursor = 2;
        j.corrupt(2, r);
        ledger.sync(32);
        assertEq(ledger.fundingCursor(), 2);
        assertEq(ledger.lifecycleCursor(), 2);
        (uint256 outsideP, uint256 stash) = ledger.itemCredit(1);
        assertEq(outsideP, 0);
        assertEq(stash, 30);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        vm.prank(ALICE);
        assertEq(ledger.claim(ids, ALICE), 30);
        (outsideP, stash) = ledger.itemCredit(1);
        assertEq(outsideP + stash, 0);
        assertEq(pm.balanceOf(address(ledger), 0), 90);
    }

    function test_rejectGraduationReceiptWithStaleCustodyCounts() public {
        j.fund(1, 2, 0, 43);
        j.fund(2, 2, 0, 29);
        j.graduate();
        // Move the pick before release and update only the first receipt. The second still claims four
        // inside/hidden slots although only three remain; late base never excuses inconsistent counts.
        j.pick(1, ALICE);
        ItemLifecycleV2 memory op = h.itemLifecycle(1);
        op.fundingCursor = 0;
        j.corruptOperation(1, op);
        ItemFundingV2 memory r = h.itemFunding(1);
        r.lifecycleCursor = 1;
        r.insideCount = 3;
        r.hiddenCount = 3;
        j.corrupt(1, r);
        vm.expectRevert(ItemLedgerV2.InvalidRecord.selector);
        ledger.sync(32);
    }

    function test_badCountsSourcesAndDuplicateReleaseRevertAtomically() public {
        j.graduate();
        _page(32);
        j.fund(1, 1, 1, 43);
        ItemFundingV2 memory r = h.itemFunding(3);
        r.insideCount = 3;
        j.corrupt(3, r);
        vm.expectRevert();
        ledger.sync(32);
        r = h.itemFunding(3);
        r.hiddenCount = 3;
        j.corrupt(3, r);
        vm.expectRevert();
        ledger.sync(32);
        r = h.itemFunding(3);
        r.source = 3;
        r.batchId = 0;
        j.corrupt(3, r);
        vm.expectRevert();
        ledger.sync(32);
        r = h.itemFunding(3);
        r.batchId = 2;
        j.corrupt(3, r);
        vm.expectRevert();
        ledger.sync(32);
        r = h.itemFunding(3);
        r.side = 0;
        j.corrupt(3, r);
        vm.expectRevert();
        ledger.sync(32);
        r = h.itemFunding(3);
        r.source = 0;
        j.corrupt(3, r);
        vm.expectRevert();
        ledger.sync(32);
        r = h.itemFunding(3);
        r.lifecycleCursor = 99;
        j.corrupt(3, r);
        vm.expectRevert();
        ledger.sync(32);
        assertEq(ledger.fundingCursor(), 2);
        j.corrupt(0, r);
        _page(32);
    }

    function test_claimBacklogErrorPreservesEachLiability() public {
        j.graduate();
        _page(32);
        j.pick(1, ALICE);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        bytes memory pending = abi.encodeWithSelector(IItemLedgerV2.ItemSyncPending.selector, 2, 0);
        vm.expectRevert(pending);
        ledger.claim(ids, ALICE);
        _page(32);
        vm.expectRevert(ItemLedgerV2.Unauthorized.selector);
        ledger.claim(ids, ALICE);
        // F127: only the owner claims; caught-up zero credit is still not claimable.
        vm.prank(ALICE);
        vm.expectRevert(bytes4(keccak256("InvalidClaim()")));
        ledger.claim(ids, ALICE);
        _compare();
    }

    function test_cappedNoticeHeadroomAndLowGasRefusal() public {
        bytes memory data = abi.encodeCall(IItemLedgerCalls.onTicketsOpened, (1, 4));
        j.request(_key(1));
        (bool ok, uint256 used) = j.cappedNotice(data);
        assertTrue(ok);
        assertLt(used * 2, 1_000_000);
        emit log_named_uint("notice gas including call", used);
        vm.expectRevert();
        j.cappedNotice{gas: 1_000_000}(data);
        assertEq(ledger.lifecycleCursor(), 0);
        _page(32);
    }

    function testFuzz_mixedLifecycleStateMachine(uint256 seed, uint8 policy) public {
        uint8 b = uint8(1 + policy % 2);
        uint8 s = uint8(1 + (policy / 2) % 2);
        _setup(b, s, 1);
        j.fund(1, 2, 0, seed % 1000);
        _page(32);
        j.request(_key(1));
        _page(32);
        j.fund(2, 2, 0, (seed >> 16) % 1000);
        _page(32);
        j.graduate();
        _page(32);
        uint256 next = 2;
        // Reproducible varied histories; compare every record after every action, including partial replay.
        for (uint256 step; step < 32; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 op = seed % 7;
            uint256 id = 1 + (seed >> 8) % 4;
            if (op == 0) {
                j.fund(uint8(1 + (seed >> 16) % 2), 2, 0, (seed >> 32) % 1000);
            } else if (op == 1 && h.hidden() != 0) {
                j.request(_key(next++));
            } else if (op == 2 && h.ownerOf(id) == address(0) && (h.known(id) || h.hidden() != 0)) {
                j.pick(id, ALICE);
            } else if (op == 3 && h.ownerOf(id) != address(0)) {
                j.back(id);
            } else if (op == 4 && h.ownerOf(id) != address(0)) {
                j.move(id, BOB);
            } else if (op >= 5) {
                for (uint256 x; x < keys.length; ++x) {
                    (,, bool open) = ledger.ticketCredit(keys[x]);
                    if (!open) continue;
                    if (op == 5) {
                        j.cancel(keys[x]);
                    } else {
                        for (uint256 y = 1; y <= 4; ++y) {
                            if (!h.known(y)) {
                                j.deliver(keys[x], y, BOB);
                                break;
                            }
                        }
                    }
                    break;
                }
            }
            _compare();
            _page(1);
            _page(32);
            if (step % 7 == 0) {
                assertEq(ledger.flushResidue(), m.flushResidue());
                _compare();
            }
        }
    }
}
