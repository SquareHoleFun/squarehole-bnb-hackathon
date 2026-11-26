// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetPoolFixture, SetSpecV2, HostileToken} from "./SetPoolFixture.sol";
import {HostileERC721} from "./fixtures/HostileERC721.sol";
import {SetVaultV2} from "../../../src/box-v2/set/SetVaultV2.sol";
import {IBoxCoordinatorV2, FailCause} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxVaultV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";

contract SetPoolFailureTest is SetPoolFixture {
    HostileERC721 private art;

    function _prepare(bool erc20, uint256 creatorBuy) private returns (bytes32[] memory suffix) {
        art = new HostileERC721();
        for (uint256 i; i < 10; ++i) {
            art.mint(CREATOR, _id(i));
        }
        SetSpecV2 memory s;
        (s, suffix) = _terms(address(art), 10);
        if (erc20) {
            (SetSpecV2 memory priced,) = _pricing();
            s.pricing = priced.pricing;
            s.raise = priced.raise;
        }
        s.creatorBuy = creatorBuy == 0 ? 0 : s.raise / 20;
        _start(s);
    }

    function test_E07_closedEmptyCreatorClaimAndLateReceipts() public {
        _closed(0, false);
    }

    function test_E07_closedPartialCreatorBuyAndRecovery() public {
        _closed(4, false);
    }

    function test_E07_closedFullUncompletedErc20AndRecovery() public {
        _closed(10, true);
    }

    function _closed(uint256 loaded, bool erc20) private {
        bytes32[] memory suffix = _prepare(erc20, loaded);
        if (loaded != 0) _page(0, loaded, suffix[loaded]);
        uint256 end = box.openAt() + 14 days;
        vm.warp(end - 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.GateCapNotReached.selector, end));
        box.failClosed();
        vm.warp(end);
        box.failClosed();
        assertEq(uint8(box.failCause()), uint8(FailCause.ClosedPastCap));
        _frozen(suffix);
        (, uint256 left) = box.claimState();
        assertEq(left, token.balanceOf(CREATOR));
        uint256 quote = box.quoteClaim(left);
        if (loaded != 0) {
            assertEq(vault.releaseToCreator(_ids(0, loaded)), loaded);
            assertEq(vault.inside(), 0);
            assertEq(box.quoteClaim(left), quote);
            vm.prank(CREATOR);
            token.approve(address(box), left);
        }
        uint256 before = _balance(CREATOR);
        vm.prank(CREATOR);
        assertEq(box.claim(left, CREATOR), quote);
        assertEq(_balance(CREATOR) - before, quote);
        if (left == 0) {
            // This template has no royalty inbox. Late gifts cannot reopen the fixed creator right.
            _gift(address(box), 12345);
            vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector);
            box.quoteClaim(0);
            vm.prank(CREATOR);
            vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector);
            box.claim(0, CREATOR);
        }
        _noPayouts();
    }

    function test_E07_deadlineNativeClaimsLateReceiptsAndIsolatedRecovery() public {
        _deadline(false);
    }

    function test_E07_deadlineErc20ClaimsLateReceiptsAndIsolatedRecovery() public {
        _deadline(true);
    }

    function _deadline(bool erc20) private {
        bytes32[] memory suffix = _prepare(erc20, 0);
        _open(suffix);
        _routerBuy(box.raise() / 5);
        _gift(address(receiver), 15000);
        receiver.collect(address(0));
        assertGt(receiver.growHeldP(), 0);
        vm.warp(box.deadline() - 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.DeadlineNotReached.selector, box.deadline()));
        box.fail();
        vm.warp(box.deadline());
        art.setPaused(true);
        box.fail();
        assertEq(uint8(box.failCause()), uint8(FailCause.Deadline));
        _frozen(suffix);
        (uint256 pot, uint256 left) = box.claimState();
        assertGt(pot, 0);
        assertEq(left, token.balanceOf(ALICE));
        assertEq(receiver.poolHeldP() + receiver.growHeldP(), 0);
        assertEq(vault.escrowPrincipal(), 0);
        (uint256 k, uint256 rem) = vault.escrowSurplus();
        assertEq(k + rem, 0);
        assertEq(vault.releaseToCreator(_ids(0, 10)), 0);
        art.setPaused(false);
        art.setTransferMode(_id(0), HostileERC721.TransferMode.BurnGas);
        art.setTransferMode(_id(1), HostileERC721.TransferMode.NoOp);
        uint256 quote = box.quoteClaim(left);
        assertEq(vault.releaseToCreator(_ids(0, 10)), 8);
        assertEq(box.quoteClaim(left), quote, "recovery cannot reprice P claims");
        assertEq(vault.inside(), 2);
        _holderClaims(left);
        art.setTransferMode(_id(0), HostileERC721.TransferMode.Normal);
        art.setTransferMode(_id(1), HostileERC721.TransferMode.Normal);
        assertEq(vault.releaseToCreator(_ids(0, 10)), 2);
        assertEq(vault.releaseToCreator(_ids(0, 10)), 0);
        assertEq(vault.inside(), 0);
        for (uint256 i; i < 10; ++i) {
            assertEq(art.actualOwner(_id(i)), CREATOR);
        }
        _noPayouts();
    }

    function _holderClaims(uint256 left) private {
        vm.prank(ALICE);
        token.approve(address(box), left);
        uint256 half = left / 2;
        uint256 quote = box.quoteClaim(half);
        uint256 before = _balance(ALICE);
        vm.prank(ALICE);
        assertEq(box.claim(half, ALICE), quote);
        assertEq(_balance(ALICE) - before, quote);
        (uint256 pot, uint256 remaining) = box.claimState();
        assertEq(remaining, left - half);
        uint256 fit = receiver.fitOwed();
        uint256 platform = receiver.platformOwed();
        _gift(address(receiver), 54321);
        receiver.collect(address(0));
        _gift(address(hook), 777);
        _directGift(address(router), 333);
        router.sweep();
        _gift(address(box), 12345);
        // The final claim drains all readable late inboxes; no further fee split or NFT-dependent action.
        quote = box.quoteClaim(remaining);
        assertEq(quote, pot + 54321 + 333 + 12345);
        // Hook-held late claims are forwarded at claim entry, after the preview.
        quote += 777;
        before = _balance(ALICE);
        vm.prank(ALICE);
        assertEq(box.claim(remaining, ALICE), quote);
        assertEq(_balance(ALICE) - before, quote);
        assertEq(receiver.fitOwed(), fit);
        assertEq(receiver.platformOwed(), platform);
        (pot, remaining) = box.claimState();
        assertEq(pot + remaining, 0);
        _gift(address(receiver), 99);
        receiver.collect(address(0));
        _gift(address(box), 101);
        (pot, remaining) = box.claimState();
        assertEq(pot, 200, "late receipts after final holder stay locked");
        assertEq(remaining, 0);
        vm.prank(CREATOR);
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector);
        box.claim(0, CREATOR);
        vm.prank(ALICE);
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector);
        box.claim(0, ALICE);
        before = _balance(release.fitSafe);
        assertEq(receiver.payFit(), fit);
        assertEq(_balance(release.fitSafe) - before, fit);
        before = _balance(release.platformSafe);
        assertEq(receiver.payPlatform(), platform);
        assertEq(_balance(release.platformSafe) - before, platform);
    }

    function test_E07_filledTimeoutBoundaryAndFailedGraduationRetry() public {
        bytes32[] memory suffix = _prepare(false, 0);
        _open(suffix);
        _fill();
        uint256 end = hook.closedAt() + 7 days;
        vm.warp(end - 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.GraduationEscapeNotReached.selector, end));
        box.fail();
        (bool ok,) = address(box).call{gas: 100_000}(abi.encodeCall(box.graduate, ()));
        assertFalse(ok);
        assertFalse(box.graduated());
        assertEq(hook.closedAt() + 7 days, end);
        vm.warp(end);
        box.fail();
        assertEq(uint8(box.failCause()), uint8(FailCause.GraduationTimedOut));
        _frozen(suffix);
        uint256 held = token.balanceOf(address(buyer));
        (, uint256 left) = box.claimState();
        assertEq(left, held);
        vm.prank(address(buyer));
        token.transfer(ALICE, held);
        assertEq(vault.releaseToCreator(_ids(0, 10)), 10);
        _holderClaims(left);
    }

    function _frozen(bytes32[] memory suffix) private {
        assertTrue(vault.failed());
        assertFalse(vault.gateOpen());
        assertFalse(vault.seedReady());
        vm.expectRevert(IBoxVaultV2.GateClosed.selector);
        vault.quoteWithdraw(1);
        vm.expectRevert(IBoxVaultV2.GateClosed.selector);
        vault.quoteReturn(1);
        vm.expectRevert(IBoxVaultV2.GateClosed.selector);
        vault.withdrawBatch(_ids(0, 1), type(uint256).max, block.timestamp);
        vm.expectRevert(IBoxVaultV2.GateClosed.selector);
        vault.returnItems(_ids(0, 1), 0, block.timestamp);
        vm.expectRevert();
        _page(0, 1, suffix[1]);
        vm.expectRevert();
        loader.complete();
        vm.expectRevert(IBoxCoordinatorV2.AlreadyFailed.selector);
        box.graduate();
        vm.expectRevert(IBoxCoordinatorV2.AlreadyFailed.selector);
        box.fail();
    }

    function test_E07_failureEntryNeverCallsCollection() public {
        bytes32[] memory suffix = _prepare(false, 0);
        _open(suffix);
        vm.warp(box.deadline());
        vm.expectCall(address(art), bytes(""), uint64(0));
        box.fail();
        assertTrue(vault.failed());
    }

    function _balance(address who) private view returns (uint256) {
        return box.q() == address(0) ? who.balance : HostileToken(box.q()).balanceOf(who);
    }

    function _directGift(address to, uint256 amount) private {
        if (box.q() == address(0)) {
            vm.deal(to, to.balance + amount);
        } else {
            HostileToken(box.q()).mint(to, amount);
        }
    }
}
