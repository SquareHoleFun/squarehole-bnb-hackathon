// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {HolderFixture} from "../m2-30/HolderFixture.sol";
import {ShopFixture} from "../m2-32/ShopFixture.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

/// @notice Test callers exercise immutable-hook authority and public settlement/claim boundaries.
contract M262HolderGaps is HolderFixture {
    function test_authenticatedNoticeCannotCrossTheSideDomain() public {
        _move(SYSTEM, ALICE, 100, false);
        vm.startPrank(address(hook));
        vm.expectRevert(); ledger.onTradeFeeBatch(2, ALICE, true, 100);
        vm.expectRevert(); ledger.onTradeFeeBatch(1, ALICE, false, 100);
        vm.stopPrank();
    }

    function test_finishedHolderCannotClaimBeforeOtherHoldersAreSettled() public {
        _move(SYSTEM, ALICE, 100, false); _move(SYSTEM, BOB, 100, false);
        _trade(1, 100, false, true); _close(1, 1000);
        assertFalse(ledger.settleBatch(1, 1));
        (bool done, uint256 cursor,,) = ledger.batchState(1);
        assertFalse(done); assertEq(cursor, 1);
        assertEq(ledger.claimable(1, ALICE), 0, "partial batches expose no payable credit");
        vm.prank(ALICE); vm.expectRevert(); ledger.claim(1, ALICE);
        assertTrue(ledger.settleBatch(1, 1));
        assertEq(ledger.claimable(1, ALICE), 500); assertEq(ledger.claimable(1, BOB), 500);
    }

    function test_residueReplayCannotSpendAnotherBatchOrHolder() public {
        _move(SYSTEM, ALICE, 100, false);
        _trade(1, 100, false, true); _trade(1, 100, false, false); _close(1, 1000);
        _trade(3, 100, false, true); _close(3, 1000);
        _settle(1, 64); _settle(3, 64);
        assertEq(ledger.flushResidue(1), 500);
        assertEq(ledger.flushResidue(1), 0, "residue is an exit exactly once");
        vm.startPrank(ALICE);
        assertEq(ledger.claim(1, ALICE), 500); assertEq(ledger.claim(3, ALICE), 1000);
        vm.stopPrank();
        assertEq(p.balanceOf(ALICE), 1500);
    }
}

/// @notice Public picks replenish budget but cannot replenish a spent weekly allowance.
contract M262ShopGaps is ShopFixture {
    function test_donationsAndClaimsCannotRefillSpentSeedBudget() public {
        _fund(); _open(); _give(0, 1);
        assertEq(shop.budgetT(), 9990);
        vm.prank(ALICE); vm.expectRevert(); token.transfer(address(shop), 10);
        driver.mintClaims(Currency.wrap(address(token)), address(shop), 10);
        assertEq(pm.balanceOf(address(shop), uint160(address(token))), 10);
        assertEq(token.balanceOf(address(shop)), 9990);
        assertEq(shop.budgetT(), 9990, "PM claims are not live spending budget");
    }

    function test_largePickReceiptsCannotEnlargeCurrentCollectionAllowance() public {
        _fund();
        for (uint256 i = 100; i < 133; ++i) _load(i);
        _open();
        uint256 start = vm.getBlockTimestamp();
        for (uint256 i; i < 25; ++i) _give(0, i); // exhaust 250 of the 10000 snapshot
        for (uint256 i = 100; i < 132; ++i) {
            vm.prank(ALICE); shop.pick(address(nfts[0]), i, 13, ALICE);
        }
        assertEq(shop.budgetT(), 10166); // 10000 - 250 + 32 * 13
        vm.prank(ALICE); vm.expectRevert(); shop.give(address(nfts[0]), 100, 0);
        vm.warp(start + 7 days);
        vm.prank(ALICE); assertEq(shop.give(address(nfts[0]), 100, 0), 10);
        assertEq(shop.budgetT(), 10156);
    }
}
