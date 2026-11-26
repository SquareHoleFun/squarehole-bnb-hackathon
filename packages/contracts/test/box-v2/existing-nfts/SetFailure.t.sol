// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetFailureFixture, RecoveryVault, NonreceiverCreator} from "./SetFailureFixture.sol";
import {CustodyVault, SetStandardERC721} from "./SetVaultFixture.sol";
import {StarterSetLoaderV2} from "../../../src/box-v2/StarterSetLoaderV2.sol";
import {IBoxVaultV2 as V, IBoxVaultItemsV2 as B} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IBoxCoordinatorV2, FailCause} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {Vm, VmSafe} from "forge-std/Vm.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";

contract SetFailureTest is SetFailureFixture {
    using stdStorage for StdStorage;

    function test_emptyFailureHasNoReleasableItems() public {
        _start(10, 0, false);
        _failClosed();
        assertEq(recovery().releaseToCreator(_list(0, 10)), 0);
        assertEq(vault.inside(), 0);
        _assertOwners(0, 10, CREATOR);
    }

    function testFuzz_partialOrFullLoadingRecoversEveryLoadedIdIncludingLast(uint8 amount) public {
        uint256 loaded = bound(amount, 1, 33);
        _start(33, loaded, false);
        _failClosed(); // Even all loaded can fail while permissionless complete has not run.
        uint256 first = loaded > 32 ? 32 : loaded;
        vm.prank(ALICE); // Recovery is permissionless but has no recipient parameter.
        assertEq(recovery().releaseToCreator(_list(0, first)), first);
        if (loaded > first) assertEq(recovery().releaseToCreator(_list(first, loaded - first)), loaded - first);
        _assertOwners(0, 33, CREATOR);
        assertEq(vault.loaded(), loaded);
        assertEq(vault.inside(), 0);
        assertEq(vault.supplyFloor(), 0);
        for (uint256 i; i < loaded; ++i) {
            assertTrue(vault.eligible(ids[i]));
            assertFalse(vault.isOutside(ids[i]), "recovery is not a paid pick");
            assertEq(vault.memberAt(i), ids[i]);
        }
        assertEq(recovery().releaseToCreator(_list(0, first)), 0);
    }

    function test_deadlineAndFilledTimeoutBoundaries() public {
        _start(10, 10, false);
        loader.complete();
        uint256 end = box.deadline();
        vm.warp(end - 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.DeadlineNotReached.selector, end));
        box.fail();
        vm.warp(end);
        box.fail();
        assertEq(uint256(box.failCause()), uint256(FailCause.Deadline));
        assertEq(recovery().releaseToCreator(_list(0, 10)), 10);

        _start(10, 10, false);
        loader.complete();
        hook.fill();
        hook.setReject(false, true); // Graduation unavailable; timeout is still permissionless.
        end = hook.closedAt() + 7 days;
        vm.warp(end - 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.GraduationEscapeNotReached.selector, end));
        box.fail();
        vm.warp(end);
        box.fail();
        assertEq(uint256(box.failCause()), uint256(FailCause.GraduationTimedOut));
        assertEq(recovery().releaseToCreator(_list(0, 10)), 10);
        assertEq(vault.inside(), 0);
    }

    function test_failureEntryMakesNoExternalCallsAndCannotRepeat() public {
        _start(10, 7, false);
        vm.etch(collection, hex"fe");
        vm.startStateDiffRecording();
        vm.prank(address(box));
        vault.enterFailure();
        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        // Some Foundry versions include earlier accesses in the recording. Start at this exact entry.
        // Clone DELEGATECALL to its implementation is the only allowed nested execution.
        bool entered;
        for (uint256 i; i < accesses.length; ++i) {
            if (
                accesses[i].account == address(vault) && accesses[i].kind == VmSafe.AccountAccessKind.Call
                    && keccak256(accesses[i].data) == keccak256(abi.encodeCall(vault.enterFailure, ()))
            ) {
                entered = true;
                continue;
            }
            if (!entered) continue;
            assertTrue(
                accesses[i].kind != VmSafe.AccountAccessKind.Call
                    && accesses[i].kind != VmSafe.AccountAccessKind.StaticCall,
                "foreign call during failure"
            );
            if (accesses[i].kind == VmSafe.AccountAccessKind.DelegateCall) assertEq(accesses[i].account, vaultImpl);
        }
        assertTrue(entered);
        assertTrue(vault.failed());
        assertEq(vault.inside(), 7);
        vm.prank(address(box));
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        vault.enterFailure();
    }

    function test_nonreceiverContractCreatorRecoversViaTransferFrom() public {
        vm.etch(CREATOR, address(new NonreceiverCreator()).code);
        _start(10, 10, false);
        _failClosed();
        vm.prank(ALICE);
        assertEq(recovery().releaseToCreator(_list(0, 10)), 10);
        _assertOwners(0, 10, CREATOR);
    }

    function testFuzz_realCoordinatorFailureAndRecoverySurviveBrokenCollection(uint8 amount) public {
        uint256 loaded = bound(amount, 0, 10);
        _start(10, loaded, false);
        bytes memory originalCode = collection.code;
        vm.etch(collection, hex"fe");
        _failClosed();
        assertEq(recovery().releaseToCreator(_list(0, 10)), 0);
        assertEq(vault.inside(), loaded);
        vm.etch(collection, originalCode);
        assertEq(recovery().releaseToCreator(_list(0, 10)), loaded);
    }

    function test_recoveryShapePhaseAndSelfAuthentication() public {
        _start(33, 33, false);
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        recovery().releaseToCreator(_list(0, 1));
        _failClosed();
        vm.expectRevert(V.InvalidIdList.selector);
        recovery().releaseToCreator(new uint256[](0));
        vm.expectRevert(abi.encodeWithSelector(B.ItemBatchTooLarge.selector, 33, 32));
        recovery().releaseToCreator(_list(0, 33));
        vm.expectRevert(abi.encodeWithSelector(CustodyVault.Unauthorized.selector, address(this)));
        recovery().releaseOne(ids[0]);
        vm.prank(address(vault)); // Even a spoofed self caller needs the locked outer recovery frame.
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        recovery().releaseOne(ids[0]);
        assertEq(vault.inside(), 33);
    }

    function test_duplicatesUnloadedAndUnsafeGiftsCannotReleaseTwiceOrAcquireMembership() public {
        _start(10, 2, false);
        SetStandardERC721 nft = SetStandardERC721(collection);
        nft.mint(address(vault), 42);
        _failClosed();
        uint256[] memory requested = new uint256[](5);
        requested[0] = ids[0];
        requested[1] = ids[0];
        requested[2] = ids[1];
        requested[3] = ids[2]; // Committed but not loaded.
        requested[4] = 42; // Unsafe unlisted gift.
        uint256 supply = token.totalSupply();
        assertEq(recovery().releaseToCreator(requested), 2);
        assertEq(recovery().releaseToCreator(requested), 0);
        // Even a released item gifted back never becomes releasable again.
        vm.prank(CREATOR);
        nft.transferFrom(CREATOR, address(vault), ids[0]);
        assertEq(recovery().releaseToCreator(requested), 0);
        assertEq(nft.ownerOf(42), address(vault));
        assertEq(nft.ownerOf(ids[0]), address(vault));
        assertFalse(vault.eligible(42));
        assertEq(vault.inside(), 0);
        assertEq(token.totalSupply(), supply);
        assertEq(token.balanceOf(CREATOR), 0);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function test_allPostFailureLoadingQuotesAndConversionsStayClosedAfterLastRelease() public {
        _start(10, 7, false);
        _failClosed();
        _assertFrozen();
        assertEq(recovery().releaseToCreator(_list(0, 7)), 7);
        _assertFrozen();
    }

    function test_graduatedVaultCannotEnterFailureOrRecover() public {
        _ready(10, 1e18, false);
        vm.prank(address(box));
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        vault.enterFailure();
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        recovery().releaseToCreator(_list(0, 10));
    }

    function testFuzz_releaseOrderAndInterleavedClaimsKeepKAndDenominator(uint8 offset, bool claimsFirst) public {
        _start(10, 10, false);
        loader.complete();
        // Tiny balances also exercise claims whose best-effort burn hits the still-loaded NFT supply floor.
        uint256 unit = offset % 2 == 0 ? 1 : 100;
        _give(ALICE, 7 * unit);
        _give(BOB, 3 * unit);
        _fundPot(10_000);
        vm.warp(box.deadline());
        box.fail();
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(pot, 10_000);
        assertEq(left, 10 * unit);
        uint256 start = uint256(offset) % 10;
        for (uint256 i; i < 10; ++i) {
            if (i == (claimsFirst ? 0 : 5)) {
                vm.startPrank(ALICE);
                token.approve(address(box), 7 * unit);
                assertEq(box.claim(7 * unit, ALICE), 7_000);
                vm.stopPrank();
                pot -= 7_000;
                left -= 7 * unit;
            }
            uint256[] memory one = new uint256[](1);
            one[0] = ids[(start + i) % 10];
            uint256 supply = token.totalSupply();
            assertEq(recovery().releaseToCreator(one), 1);
            assertEq(recovery().releaseToCreator(one), 0);
            assertEq(token.totalSupply(), supply);
            (uint256 afterPot, uint256 afterLeft) = box.claimState();
            assertEq(afterPot, pot);
            assertEq(afterLeft, left);
            (uint256 k, uint256 remainder) = vault.escrowSurplus();
            assertEq(k, 0);
            assertEq(remainder, 0);
        }
        vm.startPrank(BOB);
        token.approve(address(box), 3 * unit);
        assertEq(box.claim(3 * unit, BOB), 3_000);
        vm.stopPrank();
        assertEq(ALICE.balance, 7_000);
        assertEq(BOB.balance, 3_000);
        assertEq(vault.inside(), 0);
        (pot, left) = box.claimState();
        assertEq(pot, 0);
        assertEq(left, 0);
    }

    function test_defensiveNonzeroEscrowKDoesNotFollowRecoveryCountOrExcludeAllVaultT() public {
        _start(10, 10, false);
        _give(ALICE, 700);
        vm.prank(address(box));
        token.approve(address(vault), 300);
        vm.prank(address(vault)); // Test-only excess T; the real token refuses unsolicited vault gifts.
        token.transferFrom(address(box), address(vault), 300);
        // Synthetic accounting seam: E>0 cannot arise before graduation in an ordinary failed set.
        stdstore.target(address(vault)).sig("escrowPrincipal()").checked_write(200);
        _fundPot(8_000);
        _failClosed();
        for (uint256 i; i < 10; ++i) {
            (uint256 k, uint256 remainder) = vault.escrowSurplus();
            assertEq(k, 200);
            assertEq(remainder, 0);
            (uint256 pot, uint256 left) = box.claimState();
            assertEq(pot, 8_000);
            assertEq(left, 800, "ordinary denominator subtracts K=200, not all vault T=300");
            assertEq(recovery().releaseToCreator(_list(i, 1)), 1);
        }
        (uint256 finalK, uint256 finalRemainder) = vault.escrowSurplus();
        assertEq(finalK, 200);
        assertEq(finalRemainder, 0);
        assertEq(vault.supplyFloor(), 200);
        assertEq(token.balanceOf(address(vault)), 300);
        vm.startPrank(ALICE);
        token.approve(address(box), 700);
        assertEq(box.claim(700, ALICE), 7_000);
        vm.stopPrank();
        assertEq(token.balanceOf(address(vault)), 300);
    }

    function _assertOwners(uint256 start, uint256 count, address owner) private view {
        for (uint256 i; i < count; ++i) {
            assertEq(SetStandardERC721(collection).ownerOf(ids[start + i]), owner);
        }
    }

    function _assertFrozen() private {
        assertFalse(vault.seedReady());
        vm.expectRevert(V.GateClosed.selector);
        conversion.quoteWithdraw(1);
        vm.expectRevert(V.GateClosed.selector);
        conversion.quoteReturn(1);
        uint256[] memory one = _list(0, 1);
        vm.expectRevert(V.GateClosed.selector);
        conversion.withdrawBatch(one, type(uint256).max, block.timestamp);
        vm.expectRevert(V.GateClosed.selector);
        conversion.returnItems(one, 0, block.timestamp);
        vm.prank(address(loader));
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        vault.loadStarter(collection, ids[7], 0);
        vm.expectRevert(StarterSetLoaderV2.InvalidRequest.selector);
        _page(7, 3);
        vm.expectRevert(StarterSetLoaderV2.InvalidRequest.selector);
        loader.complete();
        vm.prank(address(box));
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        vault.openGate();
        vm.expectRevert(IBoxCoordinatorV2.AlreadyFailed.selector);
        box.graduate();
    }
}
