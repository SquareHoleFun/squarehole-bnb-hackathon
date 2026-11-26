// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverFixture, ReceiverCoordinator, ReceiverForeignUnlock} from "./ReceiverFixture.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {IBoxReceiverV2, FeeBatchV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {ReceiverArgs} from "../../../src/box-v2/libraries/BoxReceiverV2Args.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

contract ReceiverMoneyTest is ReceiverFixture {
    function test_menuMatrixAndBothFeeSides() public {
        for (uint8 b = 1; b <= 3; b++) {
            for (uint8 s = 1; s <= 3; s++) {
                r = _receiver(b, s, 1, address(p), true);
                _fees(150, 300);
                FeeBatchV2 memory batch = r.collect(address(0));
                assertEq(batch.buyersP, 150);
                assertEq(batch.sellersP, 300);
                assertEq(r.fitOwed(), 60);
                assertEq(r.platformOwed(), 30);
                assertEq(r.poolHeldP(), 60);
                assertEq(r.creatorP(), (b == 1 ? uint256(100) : 0) + (s == 1 ? uint256(200) : 0));
                assertEq(r.buyBackP(), (b == 2 ? uint256(100) : 0) + (s == 2 ? uint256(200) : 0));
                assertEq(r.growHeldP(), (b == 3 ? uint256(100) : 0) + (s == 3 ? uint256(200) : 0));
                assertEq(r.booked(address(p)), 450);
                _booked();
            }
        }
    }

    function test_zeroLedgerAndInvalidChoicesRefused() public {
        for (uint8 choice = 0; choice < 8; choice++) {
            if (choice >= 1 && choice <= 3) continue;
            r = _receiver(choice, 1, 1, address(p), false);
            vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector);
            coord.initialize(r);
            r = _receiver(1, choice, 1, address(p), false);
            vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector);
            coord.initialize(r);
        }
    }

    function test_holderLedgerAdmittedAndItemsRequireAuthenticatedWiring() public {
        for (uint8 choice = 4; choice <= 5; choice++) {
            ReceiverArgs memory a = _args(choice, 1, 1, address(p));
            a.holderLedger = address(0xB1);
            a.itemLedger = address(0xB2);
            r = _clone(a);
            if (choice == 5) vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector);
            coord.initialize(r);
            if (choice == 4) assertEq(r.holderLedger(), a.holderLedger);
        }
    }

    function test_initializeOnlyCoordinatorOnce() public {
        r = _receiver(1, 1, 1, address(p), false);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiverV2.NotCoordinator.selector, address(this)));
        r.initialize();
        coord.initialize(r);
        vm.expectRevert(IBoxReceiverV2.AlreadyInitialised.selector);
        coord.initialize(r);
    }

    function testFuzz_conservationAndCarries(uint96 a, uint96 b, uint96 c) public {
        _fees(a, b);
        r.collect(address(0));
        _booked();
        _fees(c, 0);
        r.collect(address(0));
        _booked();
        assertEq(r.booked(address(p)), uint256(a) + b + c);
        uint256 units = (uint256(a) + c) / 15 + uint256(b) / 15;
        assertEq(r.fitOwed(), 2 * units);
        assertEq(r.platformOwed(), units);
        assertEq(r.creatorP(), 10 * units);
        assertEq(r.poolHeldP(), 2 * units);
    }

    function test_donationsAreBuyersAndCounterIsClipped() public {
        r = _receiver(1, 2, 1, address(p), true);
        driver.mintClaims(Currency.wrap(address(p)), address(r), 150);
        r.collect(address(0));
        assertEq(r.creatorP(), 100);
        driver.mintClaims(Currency.wrap(address(p)), address(r), 30);
        hook.script(0, 300, 0);
        FeeBatchV2 memory batch = r.collect(address(0));
        assertEq(batch.sellersP, 30);
        assertEq(batch.buyersP, 0);
        assertEq(r.buyBackP(), 20);
        _booked();
    }

    function test_fitAndPlatformPaidBeforeGraduationSeparately() public {
        _fees(150, 0);
        r.collect(address(0));
        assertEq(r.payFit(), 20);
        assertEq(r.payPlatform(), 10);
        assertEq(p.balanceOf(FIT), 20);
        assertEq(p.balanceOf(PLATFORM), 10);
        assertEq(r.payFit(), 0);
        assertEq(r.payPlatform(), 0);
        _booked();
    }

    function test_blockedSafeDoesNotLockOtherPayoutOrFees() public {
        _fees(150, 0);
        r.collect(address(0));
        p.setBlocked(FIT, true);
        assertEq(r.payFit(), 0);
        assertEq(r.fitOwed(), 20);
        assertEq(r.payPlatform(), 10);
        r.collect(TIP);
        p.setBlocked(FIT, false);
        assertEq(r.payFit(), 20);
        _booked();
    }

    function test_pausedPLeavesTipUnbookedAndFeesLive() public {
        _fees(1500, 0);
        p.setPaused(true);
        FeeBatchV2 memory batch = r.collect(TIP);
        assertEq(batch.tip, 0);
        assertEq(p.balanceOf(TIP), 1);
        assertEq(_balance(address(r)) - r.booked(address(p)), 75);
        assertEq(r.payFit(), 0);
        assertEq(r.payPlatform(), 0);
        r.collect(address(0));
        _booked();
        assertEq(r.booked(address(p)), 1500);
        p.setPaused(false);
        assertGt(r.payFit(), 0);
    }

    function test_tipsAreLastCappedRealPAndBelowBatchNoTip() public {
        _fees(900, 0);
        assertEq(r.collect(TIP).tip, 0);
        _fees(3000, 1500);
        FeeBatchV2 memory batch = r.collect(TIP);
        assertEq(batch.tip, 100);
        assertEq(p.balanceOf(TIP), 101);
        assertEq(pm.balanceOf(TIP, uint160(address(p))), 0);
        assertEq(batch.buyersP, 2900);
        assertEq(batch.sellersP, 1500);
        _booked();
    }

    function test_sellerOnlyCollectNeverPaysTip() public {
        _fees(0, 3000);
        assertEq(r.collect(TIP).tip, 0);
        assertEq(r.creatorP(), 2000);
        _booked();
    }

    function test_graduationReleasesPoolAndPayeeOnlyClaim() public {
        _fees(150, 0);
        r.collect(address(0));
        vm.prank(PAYEE);
        vm.expectRevert(IBoxReceiverV2.NotGraduated.selector);
        r.claimCreator(address(p), PAYEE);
        coord.setGraduated(); // lazy settlement
        vm.prank(PAYEE);
        assertEq(r.claimCreator(address(p), PAYEE), 100);
        assertEq(_balance(address(hook)), 20);
        assertTrue(r.graduationSettled());
        _booked();
    }

    function test_payeeHandoverOnlyAndNoZeroRecipient() public {
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiverV2.NotPayee.selector, address(this)));
        r.proposeCreatorPayee(TIP);
        vm.prank(PAYEE);
        r.proposeCreatorPayee(TIP);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiverV2.NotPendingPayee.selector, address(this)));
        r.acceptCreatorPayee();
        vm.prank(TIP);
        r.acceptCreatorPayee();
        assertEq(r.creatorPayee(), TIP);
        _fees(150, 0);
        r.collect(address(0));
        coord.graduation(r);
        vm.prank(TIP);
        vm.expectRevert(IBoxReceiverV2.ZeroAddress.selector);
        r.claimCreator(address(p), address(0));
        vm.prank(TIP);
        assertEq(r.claimCreator(address(p), PAYEE), 100);
    }

    function test_bookedDeficitClipsWithoutLockingOrInventingMoney() public {
        _fees(150, 150);
        r.collect(address(0));
        vm.prank(address(r));
        pm.transfer(address(0xBEEF), uint160(address(p)), 100);
        r.collect(address(0));
        assertEq(r.booked(address(p)), 200);
        _booked();
        coord.failure(r);
        _booked();
        assertEq(_balance(address(r)) + _balance(address(coord)), 200);
    }

    function test_foreignUnlockAndUnauthorizedFailureRefused() public {
        ReceiverForeignUnlock f = new ReceiverForeignUnlock(pm);
        vm.expectRevert(IBoxReceiverV2.ForeignUnlock.selector);
        f.attempt(address(r), abi.encodeCall(r.collect, (TIP)));
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiverV2.NotCoordinator.selector, address(this)));
        r.enterFailure();
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiverV2.NotCoordinator.selector, address(this)));
        r.onGraduation();
    }
}
