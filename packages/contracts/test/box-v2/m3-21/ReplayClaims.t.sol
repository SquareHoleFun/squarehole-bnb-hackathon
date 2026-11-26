// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ItemClaimFixture} from "./Fixture.sol";
import {IItemLedgerV2} from "../../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {ItemLedgerV2} from "../../../src/box-v2/ItemLedgerV2.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {ItemAccountingTest} from "../m3-20/Accounting.t.sol";
import {ItemBoundariesTest} from "../m3-20/Boundaries.t.sol";
import {ItemClaimsTest} from "./Claims.t.sol";
import {HostileItemClaimsTest} from "./HostileClaims.t.sol";
import {ItemClaimGasTest} from "./Gas.t.sol";

// Unchanged accounting and clone/caller suites cover the now-extended production file.
contract ItemClaimAccountingCompatibilityTest is ItemAccountingTest {}

contract ItemClaimBoundaryCompatibilityTest is ItemBoundariesTest {}

// Reuse the original payout acceptance under the changed-file-only verification rule for this fix round.
contract ItemClaimPayoutCompatibilityTest is ItemClaimsTest {}

contract ItemClaimHostileCompatibilityTest is HostileItemClaimsTest {}

contract ItemClaimGasCompatibilityTest is ItemClaimGasTest {}

contract ReplayItemClaimsTest is ItemClaimFixture {
    function test_productionClonePaysAndUninitializedCopiesCannot() public {
        address implementation = deployCode("ItemLedgerV2", abi.encode(pm, ledger.coordinatorImplementation()));
        bytes memory args = abi.encodePacked(
            address(c),
            address(j),
            address(j),
            address(j),
            address(j),
            DEPTH,
            address(0),
            uint8(1),
            uint8(2),
            uint256(100),
            uint256(30)
        );
        IItemLedgerV2 actual = IItemLedgerV2(BoxClones.create(BoxClones.initCode(implementation, args)));
        vm.expectRevert(ItemLedgerV2.NotInitialized.selector);
        actual.claim(_ids(1), ALICE);
        vm.expectRevert(ItemLedgerV2.NotInitialized.selector);
        IItemLedgerV2(implementation).claim(_ids(1), ALICE);
        c.configure(address(pm), address(j), DEPTH, address(actual));
        j.wire(address(c), address(actual), 1);
        c.initializeLedger();
        j.graduate();
        j.pick(1, ALICE);
        j.fund(1, 2, 0, 400);
        actual.sync(32);
        (bool ok,) = address(actual).call(abi.encodeWithSignature("claimFor(uint256[])", _ids(1)));
        assertFalse(ok, "removed selector on production clone");
        (uint256 outside, uint256 stash) = actual.itemCredit(1);
        assertEq(outside + stash, 100);
        vm.prank(ALICE);
        assertEq(actual.claim(_ids(1), ALICE), 100);
        assertEq(ALICE.balance, 100);
        assertEq(KEEPER.balance, 0);
        assertEq(pm.balanceOf(address(actual), 0), 300);
    }

    function test_reverseDeliveryPaysEachTicketOnlyItsOwnCredit() public {
        bytes32 a = keccak256("request A");
        bytes32 b = keccak256("request B");
        j.fund(1, 2, 0, 400);
        j.graduate();
        j.request(a);
        j.fund(1, 2, 0, 80);
        j.request(b);
        j.fund(2, 2, 0, 40);
        j.deliver(b, 3, BOB);
        j.deliver(a, 1, ALICE);
        _sync();
        assertEq(_credit(1), 130);
        assertEq(_credit(3), 130); // B retained its own 20-unit pre-request Keep stash.
        vm.prank(ALICE);
        assertEq(ledger.claim(_ids(1), ALICE), 130);
        _debitModel(1, ALICE, 130);
        j.fund(2, 2, 0, 40);
        _sync();
        vm.prank(BOB);
        assertEq(ledger.claim(_ids(3), BOB), 140);
        _debitModel(3, BOB, 140);
        assertEq(_credit(1), 10);
        _conserved();
    }

    function test_backlogCannotSpendOrFlushPendingItemMoney() public {
        _funded(100);
        for (uint256 i; i < 40; ++i) {
            j.fund(1, 2, 0, 40);
        }
        vm.expectRevert(abi.encodeWithSelector(IItemLedgerV2.ItemSyncPending.selector, 3, 1));
        ledger.claim(_ids(1), ALICE);
        assertEq(ledger.flushResidue(), 0);
        _sync();
        vm.expectRevert(abi.encodeWithSelector(IItemLedgerV2.ItemSyncPending.selector, 35, 1));
        ledger.claim(_ids(1), ALICE);
        _conserved();
        _sync();
        vm.prank(ALICE);
        assertEq(ledger.claim(_ids(1), BOB), 500);
        _debitModel(1, ALICE, 500);
        _conserved();
    }

    function test_cancelledTicketEarningsGoToDepthWhileOtherClaimsExit() public {
        _funded(100);
        bytes32 key = keccak256("cancelled");
        j.request(key);
        j.fund(1, 2, 0, 43);
        j.cancel(key);
        _sync();
        assertEq(ledger.ticketStash(key), 0);
        (, uint256 credit, bool open) = ledger.ticketCredit(key);
        assertEq(credit, 0);
        assertFalse(open);
        assertEq(ledger.flushResidue(), 13);
        assertEq(model.flushResidue(), 13);
        vm.prank(ALICE);
        assertEq(ledger.claim(_ids(1), ALICE), 110);
        _debitModel(1, ALICE, 110);
        _conserved();
    }

    function test_creditAboveInt128ExitsThroughRepeatedBoundedClaims() public {
        _erc20(18);
        uint256 gross = uint256(1) << 128;
        token.mint(address(j), gross * 4);
        j.graduate();
        j.pick(1, ALICE);
        for (uint256 i; i < 16; ++i) {
            j.fund(1, 2, 0, uint256(1) << 126);
        }
        _sync();
        uint256 remaining = gross;
        while (remaining != 0) {
            uint256 tranche =
                remaining > uint256(uint128(type(int128).max)) ? uint256(uint128(type(int128).max)) : remaining;
            vm.prank(ALICE);
            assertEq(ledger.claim(_ids(1), BOB), tranche);
            remaining -= tranche;
            assertEq(_credit(1), remaining);
            assertEq(token.balanceOf(BOB), gross - remaining);
        }
        assertEq(token.balanceOf(BOB), gross);
        _debitModel(1, ALICE, gross);
        _conserved();
    }

    function test_pregraduationAndFailedHeldMoneyCannotBeClaimed() public {
        j.fund(1, 2, 0, 400);
        vm.expectRevert();
        ledger.claim(_ids(1), ALICE);
        j.fail();
        _sync();
        vm.expectRevert();
        ledger.claim(_ids(1), ALICE);
        assertEq(j.history().pot(), 400);
        assertEq(pm.balanceOf(address(ledger), 0), 0);
        assertEq(_credit(1), 0);
    }

    function testFuzz_transfersReturnsAndPayoutsMatchEveryItem(uint256 seed) public {
        _setup(address(0), 1, 30);
        j.graduate();
        for (uint256 id = 1; id <= 4; ++id) {
            j.pick(id, ALICE);
        }
        _sync();
        for (uint256 step; step < 32; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 id = 1 + seed % 4;
            uint256 op = (seed >> 8) % 5;
            address owner = j.ownerOf(id);
            if (op == 0) {
                j.fund(uint8(1 + (seed >> 16) % 2), 2, 0, 1 + (seed >> 32) % 10000);
            } else if (op == 1) {
                if (owner == address(0)) j.pick(id, ALICE);
                else j.back(id);
            } else if (op == 2 && owner != address(0)) {
                j.move(id, owner == ALICE ? BOB : ALICE);
            } else if (op >= 3 && owner != address(0) && _credit(id) != 0) {
                uint256 gross = _credit(id);
                uint256 beforeOwner = owner.balance;
                if (op == 3) {
                    vm.prank(owner);
                    assertEq(ledger.claim(_ids(id), owner), gross);
                    assertEq(owner.balance - beforeOwner, gross);
                } else {
                    uint256 beforeRecipient = KEEPER.balance;
                    vm.prank(owner);
                    assertEq(ledger.claim(_ids(id), KEEPER), gross);
                    assertEq(owner.balance, beforeOwner);
                    assertEq(KEEPER.balance - beforeRecipient, gross);
                }
                _debitModel(id, owner, gross);
            }
            _sync();
            _conserved();
        }
        // Every remaining item liability exits, including stashes accumulated on the shelf.
        for (uint256 id = 1; id <= 4; ++id) {
            address owner = j.ownerOf(id);
            if (owner == address(0)) {
                j.pick(id, ALICE);
                owner = ALICE;
                _sync();
            }
            uint256 gross = _credit(id);
            if (gross != 0) {
                vm.prank(owner);
                assertEq(ledger.claim(_ids(id), owner), gross);
                _debitModel(id, owner, gross);
            }
        }
        assertEq(ledger.flushResidue(), model.flushResidue());
        _conserved();
        assertEq(pm.balanceOf(address(ledger), 0), 0);
    }
}
