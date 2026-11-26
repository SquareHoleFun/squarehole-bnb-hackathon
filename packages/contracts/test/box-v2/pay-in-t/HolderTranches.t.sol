// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {HolderFixture} from "../m2-30/HolderFixture.sol";
import {HolderLedgerV2} from "../../../src/box-v2/HolderLedgerV2.sol";
import {IHolderLedgerV2} from "../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {M2SeamArgs} from "../../../src/box-v2/libraries/M2SeamArgs.sol";

contract HolderTranchesTest is HolderFixture {
    function setUp() public override {
        super.setUp();
        ledger = IHolderLedgerV2(BoxClones.create(BoxClones.initCode(address(new HolderLedgerV2(pm)),
            abi.encodePacked(M2SeamArgs.holder(address(coord), address(t), address(hook), address(receiver), address(p)), uint8(1)))));
        t.wire(address(ledger)); hook.wire(address(ledger));
    }
    function test_AF1_fundingDuringPagesKeepsSnapshotAndEarlierCredit() public {
        _move(SYSTEM, ALICE, 100, false); _move(SYSTEM, BOB, 100, false);
        _trade(1, 100, false, true); hook.receipt(1, 1000, true);
        receiver.close(1, 100); assertTrue(ledger.settleBatch(1, 64));
        assertEq(ledger.claimable(1, ALICE), 50);
        // Current ownership and additional holders never rewrite this closed batch's history.
        _move(ALICE, BOB, 100, false); _move(SYSTEM, PUSHER, 100, false);
        receiver.close(1, 180);
        (bool complete,,,) = ledger.batchState(1); assertFalse(complete, "new funding needs settlement");
        assertFalse(ledger.settleBatch(1, 1));
        assertEq(ledger.claimable(1, ALICE), 50, "old credit remains available while new credit is staged");
        receiver.close(1, 300); // This purchase belongs to the next tranche.
        assertTrue(ledger.settleBatch(1, 1));
        assertEq(ledger.claimable(1, ALICE), 90); assertEq(ledger.claimable(1, BOB), 90);
        (complete,,,) = ledger.batchState(1); assertFalse(complete);
        assertTrue(ledger.settleBatch(1, 64));
        assertEq(ledger.claimable(1, ALICE), 150); assertEq(ledger.claimable(1, BOB), 150);
        assertEq(ledger.claimable(1, PUSHER), 0);
        assertTrue(ledger.settleBatch(1, 64)); assertEq(ledger.claimable(1, ALICE), 150);
    }
    function testFuzz_AF1_tranchesConserveWithMissingNoticesAndRounding(uint128 seed) public {
        _move(SYSTEM, ALICE, 100, false); _move(SYSTEM, BOB, 37, false);
        _trade(1, 101, false, true); _trade(1, 43, false, false); _trade(1, 19, true, false);
        hook.receipt(1, 1000, true);
        uint256 total;
        for (uint256 i; i < 12; ++i) {
            total += uint256(keccak256(abi.encode(seed, i))) % 1e24;
            receiver.close(1, total); assertTrue(ledger.settleBatch(1, 64));
            (bool complete,,, uint256 residue) = ledger.batchState(1); assertTrue(complete);
            assertEq(ledger.claimable(1, ALICE) + ledger.claimable(1, BOB) + residue, total);
        }
    }
    function test_AF1_oppositePSideKeepsSingleSettlementAndPClaim() public {
        _move(SYSTEM, ALICE, 100, false); _trade(2, 100, false, true); _close(2, 1000);
        assertTrue(ledger.settleBatch(2, 64));
        vm.prank(ALICE); assertEq(ledger.claim(2, ALICE), 1000); assertEq(p.balanceOf(ALICE), 1000);
        assertTrue(ledger.settleBatch(2, 64)); assertEq(ledger.claimable(2, ALICE), 0);
        assertEq(ledger.flushResidue(2), 0);
    }
}
