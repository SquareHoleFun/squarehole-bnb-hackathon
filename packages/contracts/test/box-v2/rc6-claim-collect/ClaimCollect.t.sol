// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M244Base} from "../m2-44/Fixture.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxLaunchRouter} from "../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {IBoxReceiverFailedV21} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";

contract RefusingClaimReceiver {
    uint256 private immutable mode;
    constructor(uint256 mode_) { mode = mode_; }
    fallback() external {
        if (mode == 1) revert("receiver refusal");
        if (mode == 2) { assembly ("memory-safe") { for {} 1 {} {} } }
        if (mode == 3) { assembly ("memory-safe") { revert(0, 65536) } }
        assembly ("memory-safe") { return(0, 1) }
    }
}

/// RC6-CC-01..05: actual factory parts, PoolManager custody and funded holder-ledger residue.
contract ClaimCollectTest is M244Base {
    uint256 private residue;
    uint256 private fitDebt;
    uint256 private platformDebt;

    function _failedBox(uint8 decimals) private {
        _createShop(decimals, 1000 ether, false, true);
        _trade();
        uint256 aliceT = token.balanceOf(address(buyer)) / 3;
        vm.prank(address(buyer)); token.transfer(ALICE, aliceT);
        vm.warp(box.deadline()); box.fail();
        assertTrue(ledger.settleBatch(1, 64));
        (,,, residue) = ledger.batchState(1);
        assertGt(residue, 0);
        fitDebt = receiver.fitOwed();
        platformDebt = receiver.platformOwed();
        assertGt(fitDebt, 0); assertGt(platformDebt, 0);
        _assertOutstanding();
    }

    function test_allSixOrders_nativeP_allReceiptTimings() public { _orders(0); }
    function test_allSixOrders_erc20P_allReceiptTimings() public { _orders(6); }

    function _orders(uint8 decimals) private {
        _failedBox(decimals);
        address[3] memory holders = [CREATOR, ALICE, address(buyer)];
        uint256 snapshot = vm.snapshotState();
        for (uint256 first; first < 3; ++first) {
            for (uint256 second; second < 3; ++second) {
                if (second == first) continue;
                // Residue arrives before the first, second, third, or after the last claim.
                for (uint256 arrival; arrival < 4; ++arrival) {
                    _order([holders[first], holders[second], holders[3 - first - second]], arrival);
                    assertTrue(vm.revertToState(snapshot));
                }
            }
        }
    }

    function _order(address[3] memory holders, uint256 arrival) private {
        uint256 pot = _pClaims(address(box));
        uint256 left = token.balanceOf(CREATOR) + token.balanceOf(ALICE) + token.balanceOf(address(buyer));
        uint256 paid;
        uint256 received = pot;
        for (uint256 i; i < 3; ++i) {
            uint256 incoming = _receipt(i, arrival);
            received += incoming; pot += incoming;
            uint256 t = token.balanceOf(holders[i]);
            uint256 expected = FullMath.mulDiv(pot, t, left);
            (uint256 previewPot, uint256 previewLeft) = box.claimState();
            assertEq(previewPot, pot, "preview includes collectable receiver P");
            assertEq(previewLeft, left);
            assertEq(box.quoteClaim(t), expected, "quote equals next payout");
            uint256 beforeBalance = _balance(holders[i]);
            assertEq(_claimT(holders[i]), expected, "floor(live P * surrendered T / remaining T)");
            assertEq(_balance(holders[i]) - beforeBalance, expected);
            paid += expected; pot -= expected; left -= t;
            assertEq(_pClaims(address(box)), pot);
            assertEq(_pClaims(address(receiver)), fitDebt + platformDebt, "no collectable P left behind");
            assertEq(receiver.fitOwed(), fitDebt); assertEq(receiver.platformOwed(), platformDebt);
        }
        assertEq(paid, received, "last claimant gets all rounding remainder");
        assertEq(pot, 0); assertEq(left, 0);
        uint256 late = _receipt(3, arrival);
        vm.expectRevert(); box.quoteClaim(1);
        vm.expectRevert(); box.claim(0, CREATOR);
        receiver.collect(ALICE);
        assertEq(_pClaims(address(receiver)), fitDebt + platformDebt);
        assertEq(_pClaims(address(box)), late, "post-last receipts stay locked under F136");
        assertEq(receiver.payFit(), fitDebt); assertEq(receiver.payPlatform(), platformDebt);
        assertEq(_pClaims(address(receiver)), 0, "only preserved debts remained");
    }

    function _receipt(uint256 stage, uint256 arrival) private returns (uint256 incoming) {
        uint256 royalty = 101 + stage;
        if (box.q() == address(0)) {
            vm.deal(address(this), royalty);
            receiver.fundRoyalty{value: royalty}(address(0), royalty);
        } else {
            HostileToken p = HostileToken(box.q());
            p.mint(address(this), royalty); p.approve(address(receiver), royalty);
            receiver.fundRoyalty(address(p), royalty);
        }
        // Put new P in the receiver AFTER royalty intake (which already forwards its own P).
        uint256 gift = 37 + stage;
        _gift(address(receiver), gift);
        incoming = royalty + gift;
        if (stage == arrival) {
            assertEq(ledger.flushResidue(1), residue);
            incoming += residue;
        }
    }

    function test_claimCollectsWithoutAnyPreviewOrPublicCollect() public {
        _failedBox(0);
        uint256 pot = _pClaims(address(box));
        uint256 left = token.balanceOf(CREATOR) + token.balanceOf(ALICE) + token.balanceOf(address(buyer));
        assertEq(ledger.flushResidue(1), residue);
        uint256 expected = FullMath.mulDiv(pot + residue, token.balanceOf(CREATOR), left);
        assertEq(_claimT(CREATOR), expected);
        assertEq(_pClaims(address(receiver)), fitDebt + platformDebt);
    }

    function test_revertingReceiverCannotBlockPotClaims() public { _refusal(1); }
    function test_gasSinkReceiverCannotBlockPotClaims() public { _refusal(2); }
    function test_largeRevertReceiverCannotBlockPotClaims() public { _refusal(3); }
    function test_shortReturnReceiverCannotBreakPreview() public { _refusal(4); }

    function _refusal(uint256 mode) private {
        _failedBox(0);
        uint256 pot = _pClaims(address(box));
        _gift(address(receiver), 73);
        vm.etch(address(receiver), address(new RefusingClaimReceiver(mode)).code);
        (uint256 preview,) = box.claimState(); assertEq(preview, pot);
        uint256 left = token.balanceOf(CREATOR) + token.balanceOf(ALICE) + token.balanceOf(address(buyer));
        assertEq(box.quoteClaim(token.balanceOf(CREATOR)), FullMath.mulDiv(pot, token.balanceOf(CREATOR), left));
        assertEq(_claimT(CREATOR) + _claimT(ALICE) + _claimT(address(buyer)), pot);
        assertEq(_pClaims(address(receiver)), fitDebt + platformDebt + 73);
    }

    function test_collectRefusalPaysOnlyActualPotEvenIfPreviewSucceeded() public {
        _failedBox(0);
        uint256 pot = _pClaims(address(box));
        _gift(address(receiver), 73);
        vm.mockCallRevert(address(receiver), abi.encodeCall(IBoxReceiverV2.collect, (address(0))), "collect refused");
        (uint256 preview,) = box.claimState(); assertEq(preview, pot + 73);
        assertEq(_claimT(CREATOR) + _claimT(ALICE) + _claimT(address(buyer)), pot);
        assertEq(_pClaims(address(receiver)), fitDebt + platformDebt + 73);
    }

    function test_routerSweepRefusalStillCollectsReceiverAndPays() public {
        _failedBox(0);
        uint256 pot = _pClaims(address(box));
        _gift(address(receiver), 73);
        vm.mockCallRevert(box.launchRouter(), abi.encodeCall(IBoxLaunchRouter.sweep, ()), "sweep refused");
        assertEq(_claimT(CREATOR) + _claimT(ALICE) + _claimT(address(buyer)), pot + 73);
        assertEq(_pClaims(address(receiver)), fitDebt + platformDebt);
    }

    function test_routerSweepStillAddsUnsweptTaxOnClaim() public {
        _failedBox(0);
        uint256 pot = _pClaims(address(box));
        vm.deal(box.launchRouter(), 19);
        _gift(address(receiver), 73);
        (uint256 preview,) = box.claimState();
        assertEq(preview, pot + 73, "router tax excluded from preview as before");
        assertEq(_claimT(CREATOR) + _claimT(ALICE) + _claimT(address(buyer)), pot + 73 + 19);
        assertEq(box.launchRouter().balance, 0);
    }

    function test_refusedPayoutRollsBackCollectionAndCanRetry() public {
        _failedBox(6);
        _gift(address(receiver), 73);
        uint256 pot = _pClaims(address(box));
        uint256 t = token.balanceOf(CREATOR);
        uint256 quote = box.quoteClaim(t);
        (, uint256 left) = box.claimState();
        vm.prank(CREATOR); token.approve(address(box), t);
        HostileToken(box.q()).setPaused(true);
        vm.expectRevert(); vm.prank(CREATOR); box.claim(t, CREATOR);
        assertEq(_pClaims(address(box)), pot);
        assertEq(_pClaims(address(receiver)), fitDebt + platformDebt + 73);
        assertEq(token.balanceOf(CREATOR), t);
        assertEq(token.allowance(CREATOR, address(box)), t);
        (, uint256 afterLeft) = box.claimState(); assertEq(afterLeft, left);
        HostileToken(box.q()).setPaused(false);
        assertEq(_claimT(CREATOR), quote);
        assertEq(_pClaims(address(receiver)), fitDebt + platformDebt);
    }

    function test_receiverDebtDeficitIsNotCollectableAndRefillProtectsBothDebts() public {
        _failedBox(0);
        uint256 pot = _pClaims(address(box));
        // Model a receiver backing shortfall, leaving its earned debt untouched.
        vm.prank(address(receiver)); pm.transfer(ALICE, 0, fitDebt + platformDebt);
        _gift(address(receiver), fitDebt);
        assertEq(IBoxReceiverFailedV21(address(receiver)).failedCollectableP(), 0);
        (uint256 preview,) = box.claimState(); assertEq(preview, pot);
        uint256 quote = box.quoteClaim(token.balanceOf(CREATOR));
        assertEq(_claimT(CREATOR), quote);
        assertEq(receiver.fitOwed(), fitDebt); assertEq(receiver.platformOwed(), platformDebt);
        _gift(address(receiver), platformDebt + 73);
        assertEq(IBoxReceiverFailedV21(address(receiver)).failedCollectableP(), 73);
        assertEq(_claimT(ALICE) + _claimT(address(buyer)), pot - quote + 73);
        assertEq(_pClaims(address(receiver)), fitDebt + platformDebt);
    }

    function test_coldFailedCollectionHasAtLeastTwofoldStipendHeadroom() public {
        _failedBox(0);
        // Exercise the costly zero-to-nonzero coordinator claims balance as well as cold receiver books.
        uint256 pot = _pClaims(address(box));
        vm.prank(address(box)); pm.transfer(ALICE, 0, pot);
        _gift(address(receiver), 73);
        address receiverAddress = address(receiver);
        ReceiverDeploy.cool(receiverAddress);
        vm.cool(release.implementations[5]);
        vm.cool(address(pm));
        uint256 beforeGas = gasleft();
        assertEq(receiver.collect{gas: C.FAILED_COLLECT_GAS}(ALICE).buyersP, 73);
        uint256 used = beforeGas - gasleft();
        emit log_named_uint("cold failed collect gas (zero pot)", used);
        assertLt(used, C.FAILED_COLLECT_GAS / 2);
        assertEq(_pClaims(address(box)), 73);
        assertEq(_pClaims(address(receiver)), fitDebt + platformDebt);
    }

    function test_liveReceiverPreviewIsZeroAndNoBuyerRemainderCannotGrow() public {
        _start(_holders());
        _gift(address(box), 1000);
        assertEq(IBoxReceiverFailedV21(address(receiver)).failedCollectableP(), 0);
        vm.warp(box.deadline()); box.fail();
        uint256 fixedClaim = box.quoteClaim(0);
        _gift(address(receiver), 73);
        assertEq(box.quoteClaim(0), fixedClaim);
        vm.prank(CREATOR); assertEq(box.claim(0, CREATOR), fixedClaim);
        assertEq(_pClaims(address(receiver)), receiver.fitOwed() + receiver.platformOwed());
        assertEq(_pClaims(address(box)), 73, "late P cannot increase the fixed no-buyer return");
    }

    function test_claimGasWithReceiverReceipt() public {
        _failedBox(0);
        ledger.flushResidue(1);
        uint256 t = token.balanceOf(CREATOR);
        vm.prank(CREATOR); token.approve(address(box), t);
        vm.prank(CREATOR);
        uint256 beforeGas = gasleft();
        box.claim(t, CREATOR);
        emit log_named_uint("claim gas (same transaction fixture, no preview)", beforeGas - gasleft());
    }
}
