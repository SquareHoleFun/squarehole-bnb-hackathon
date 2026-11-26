// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {HolderFixture} from "test/box-v2/m2-30/HolderFixture.sol";
import {ShopFixture} from "test/box-v2/m2-32/ShopFixture.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

/// @notice M2-51 keeper calls against merged production parts; counterpart fixtures are M2-30/32's doubles.
contract KeeperHolderCallsTest is HolderFixture {
    function test_sixteenPairPagesThenOwnerClaims() public {
        for (uint256 i; i < 17; ++i) t.move(SYSTEM, address(uint160(0x1000 + i)), 100, false);
        hook.trade(1, 1700, false, true); _close(1, 17000);
        vm.cool(address(ledger)); vm.cool(address(t));
        uint256 start = gasleft();
        assertFalse(ledger.settleBatch{gas: 3_000_000}(1, 16));
        emit log_named_uint("settle16 cold call gas", start - gasleft());
        vm.expectRevert(); vm.prank(address(0x1000)); ledger.claim(1, address(0x1000));
        assertTrue(ledger.settleBatch{gas: 3_000_000}(1, 16));
        vm.cool(address(ledger)); vm.cool(address(p)); vm.cool(address(pm));
        vm.prank(address(0x1000)); start = gasleft();
        uint256 paid = ledger.claim{gas: 1_000_000}(1, address(0x1000));
        emit log_named_uint("claim cold call gas", start - gasleft());
        assertEq(paid, 1000);
        assertEq(p.balanceOf(address(0x1000)), 1000); assertEq(p.balanceOf(PUSHER), 0);
        assertEq(ledger.claimable(1, address(0x1000)), 0);
    }
    function test_pausedPAndOrdinaryContractRetryAfterFailureWithoutSubsidy() public {
        _move(SYSTEM, ALICE, 100, false); _trade(1, 100, false, true); _close(1, 1000); _settle(1, 16);
        _trade(3, 100, false, true); _close(3, 2000); _settle(3, 16); coord.fail();
        p.setPaused(true); vm.expectRevert(); vm.prank(ALICE); ledger.claim{gas: 1_000_000}(1, ALICE);
        assertEq(ledger.claimable(1, ALICE), 1000); assertEq(ledger.claimable(3, ALICE), 2000);
        p.setPaused(false); vm.etch(ALICE, hex"00");
        vm.expectRevert(); ledger.claim(1, ALICE);
        vm.etch(ALICE, hex"ef01000000000000000000000000000000000000000001");
        vm.prank(ALICE); ledger.claim{gas: 1_000_000}(1, ALICE);
        vm.expectRevert(); ledger.claim(1, ALICE);
        assertEq(ledger.claimable(3, ALICE), 2000);
        assertEq(pm.balanceOf(address(ledger), uint160(address(p))), 2000);
    }
    function test_zeroFundingSmallOwnerClaimAndResidueExit() public {
        _move(SYSTEM, ALICE, 100, false); _trade(1, 100, false, false); _close(1, 1000);
        _settle(1, 16); coord.fail(); vm.cool(address(ledger)); vm.cool(address(pm));
        uint256 start = gasleft(); assertEq(ledger.flushResidue{gas: 350_000}(1), 1000);
        emit log_named_uint("residue cold call gas", start - gasleft());
        assertEq(pm.balanceOf(address(receiver), uint160(address(p))), 1000);
        assertEq(ledger.flushResidue(1), 0);
        _trade(3, 100, false, true); _close(3, 0); assertTrue(_settle(3, 16));
        assertEq(ledger.claimable(3, ALICE), 0);
        _trade(5, 100, false, true); _close(5, 99); _settle(5, 16);
        vm.expectRevert(); ledger.claim(5, ALICE);
        vm.prank(ALICE); assertEq(ledger.claim(5, ALICE), 99);
    }
}
contract KeeperShopCallsTest is ShopFixture {
    // Linked to the production floor by m2-jobs.test.ts.
    uint256 constant KEEPER_RETURN_FLOOR = 2_000_000;

    function test_oneItemGasSinkDoesNotBlockOtherReturnsOrBurnRetry() public {
        _fund(); _load(1);
        nfts[1].mint(CREATOR, 2); vm.prank(LOADER); shop.loadStarter(address(nfts[1]), 2, 0);
        driver.mintClaims(Currency.wrap(address(token)), address(shop), 77); _fail();
        assertEq(shop.collectionSize(), 2);
        uint256[] memory indexes = new uint256[](1);
        nfts[0].hostile(3, address(0), ""); assertEq(shop.returnStarter{gas: KEEPER_RETURN_FLOOR}(indexes), 0);
        indexes[0] = 1; vm.cool(address(shop)); vm.cool(address(nfts[1]));
        uint256 start = gasleft(); assertEq(shop.returnStarter{gas: KEEPER_RETURN_FLOOR}(indexes), 1);
        emit log_named_uint("starter cold call gas", start - gasleft());
        assertEq(nfts[1].ownerOf(2), CREATOR); assertEq(shop.returnStarter(indexes), 0);
        nfts[0].hostile(0, address(0), ""); indexes[0] = 0;
        assertEq(shop.returnStarter{gas: KEEPER_RETURN_FLOOR}(indexes), 1);
        // Enumeration remains stable even when earlier indexes have returned.
        assertEq(shop.collectionSize(), 2); assertEq(shop.inside(), 0);
        uint256 before = token.balanceOf(CREATOR); uint256 supply = token.totalSupply();
        vm.cool(address(shop)); vm.cool(address(token)); vm.cool(address(pm));
        start = gasleft(); assertEq(shop.burnFailedT{gas: 5_000_000}(), 10077);
        emit log_named_uint("failed burn cold call gas", start - gasleft());
        assertEq(token.totalSupply(), supply - 10077); assertEq(token.balanceOf(CREATOR), before);
        assertEq(shop.failedT(), 0); assertEq(shop.burnFailedT(), 0);
    }
}
