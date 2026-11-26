// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {HolderFixture, FundingFixture, PhaseFixture, HistoryFixture, BatchHookFixture} from "./HolderFixture.sol";
import {IHolderLedgerV2} from "../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {IBoxHolderBatchNoticeV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {M2SeamArgs} from "../../../src/box-v2/libraries/M2SeamArgs.sol";

contract HolderAdversarialTest is HolderFixture {
    function _creditAlice() private {
        _move(SYSTEM, ALICE, 100, false); _trade(1, 100, false, true); _close(1, 1000); _settle(1, 64);
    }
    function test_blockedHolderCannotBlockAnotherOwnersPayout() public {
        _move(SYSTEM, ALICE, 60, false); _move(SYSTEM, BOB, 40, false);
        _trade(1, 100, false, true); _close(1, 1000); _settle(1, 64);
        p.setBlocked(ALICE, true);
        vm.expectRevert(); vm.prank(ALICE); ledger.claim(1, ALICE);
        assertEq(ledger.claimable(1, ALICE), 600);
        vm.prank(BOB); assertEq(ledger.claim(1, BOB), 400);
        assertEq(ledger.claimable(1, ALICE), 600);
        p.setBlocked(ALICE, false); vm.prank(ALICE); assertEq(ledger.claim(1, ALICE), 600);
        assertEq(pm.balanceOf(address(ledger), uint160(address(p))), 0);
    }
    function test_feeOnTransferAndReentryLeaveEveryCreditForRetry() public {
        _creditAlice(); p.setFeeBps(100);
        vm.expectRevert(); vm.prank(ALICE); ledger.claim(1, ALICE);
        assertEq(ledger.claimable(1, ALICE), 1000); assertEq(p.balanceOf(ALICE), 0); p.setFeeBps(0);
        p.armReentry(address(ledger), abi.encodeCall(IHolderLedgerV2.claim, (1, ALICE)));
        vm.expectRevert(); vm.prank(ALICE); ledger.claim(1, ALICE);
        assertEq(ledger.claimable(1, ALICE), 1000); assertEq(p.balanceOf(ALICE), 0);
        p.armReentry(address(0), ""); vm.prank(ALICE); ledger.claim(1, ALICE); assertEq(p.balanceOf(ALICE), 1000);
    }
    function test_codeChangesNeverRestrictOwnerClaimsOrRewriteCredits() public {
        _creditAlice(); vm.etch(ALICE, hex"ef01000000000000000000000000000000000000000001");
        vm.prank(ALICE); ledger.claim(1, ALICE); assertEq(p.balanceOf(ALICE), 1000);
        _trade(3, 100, false, true); _close(3, 1000); _settle(3, 64);
        vm.etch(ALICE, hex"ef02000000000000000000000000000000000000000001");
        assertEq(ledger.claimable(3, ALICE), 1000);
        vm.prank(ALICE); ledger.claim(3, BOB); assertEq(p.balanceOf(BOB), 1000);
    }
    function test_eachPageDoesAtMost64PairsAndCannotReleasePartialCredit() public {
        _move(SYSTEM, ALICE, 100, false);
        for (uint256 i; i < 70; ++i) _trade(1, 100, false, true);
        _close(1, 7000); assertFalse(_settle(1, 64));
        (bool done, uint256 hc, uint256 nc, uint256 residue) = ledger.batchState(1);
        assertFalse(done); assertEq(hc, 0); assertEq(nc, 64); assertEq(residue, 0);
        vm.expectRevert(); vm.prank(ALICE); ledger.claim(1, ALICE);
        assertTrue(_settle(1, 6)); assertEq(ledger.claimable(1, ALICE), 7000);
    }
    function test_missingAllNoticesAndEmptyDenominatorOnlyHaveResidue() public {
        _move(SYSTEM, ALICE, 100, false); _trade(1, 100, false, false);
        _close(1, 1000); _settle(1, 1); assertEq(ledger.claimable(1, ALICE), 0);
        assertEq(ledger.flushResidue(1), 1000);
        _close(3, 150); _settle(3, 1); assertEq(ledger.flushResidue(3), 150);
    }
    function test_nativePClaimRefusalPreservesCreditWithoutClaimsFallback() public {
        address code = deployCode("out/HolderLedgerV2.sol/HolderLedgerV2.json", abi.encode(pm));
        ledger = IHolderLedgerV2(BoxClones.create(BoxClones.initCode(code,
            M2SeamArgs.holder(address(coord), address(t), address(hook), address(receiver), address(0)))));
        t.wire(address(ledger)); hook.wire(address(ledger));
        _move(SYSTEM, ALICE, 100, false); _trade(1, 100, false, true);
        hook.receipt(1, 1000, true); receiver.close(1, 1000);
        vm.deal(address(driver), 1000); driver.mintClaims(Currency.wrap(address(0)), address(ledger), 1000);
        ledger.settleBatch(1, 64); vm.etch(PUSHER, hex"5f5ffd");
        vm.expectRevert(); vm.prank(ALICE); ledger.claim(1, PUSHER);
        assertEq(ledger.claimable(1, ALICE), 1000); assertEq(pm.balanceOf(PUSHER, 0), 0);
        vm.prank(ALICE); assertEq(ledger.claim(1, ALICE), 1000); assertEq(ALICE.balance, 1000);
    }
    function test_fullPrecisionAndPayoutAboveInt128() public {
        uint256 funding = uint256(1) << 128;
        uint256 part = funding / 4;
        _move(SYSTEM, ALICE, type(uint128).max / 2, false);
        _trade(1, uint256(1) << 128, false, true);
        hook.receipt(1, funding, true); receiver.close(1, funding); model.close(1, funding);
        p.mint(address(driver), funding);
        for (uint256 i; i < 4; ++i) driver.mintClaims(Currency.wrap(address(p)), address(ledger), part);
        _settle(1, 64); assertEq(ledger.claimable(1, ALICE), funding);
        vm.prank(ALICE); ledger.claim(1, ALICE); assertEq(p.balanceOf(ALICE), funding);
        assertEq(pm.balanceOf(address(ledger), uint160(address(p))), 0);
    }
    function test_firstNoticeAndTokenHintFitFrozenCaps() public {
        _move(SYSTEM, ALICE, 100, false);
        vm.prank(address(hook));
        (bool ok,) = address(ledger).call{gas: C.HOLDER_NOTICE_GAS}(
            abi.encodeCall(IBoxHolderBatchNoticeV2.onTradeFeeBatch, (1, BOB, true, 100))
        );
        assertTrue(ok, "first notice within named cap");
        uint256 checkpoint = t.holderCheckpoint();
        vm.prank(address(t));
        (ok,) = address(ledger).call{gas: C.TOKEN_SETTLEMENT_GAS}(
            abi.encodeCall(IHolderLedgerV2.onTokenCheckpoint, (checkpoint, ALICE, BOB))
        );
        assertTrue(ok, "hint within named cap");
    }
    function test_productionRuntimeFitsGate() public view {
        assertLe(vm.getDeployedCode("out/HolderLedgerV2.sol/HolderLedgerV2.json").length, 22118);
    }
}
