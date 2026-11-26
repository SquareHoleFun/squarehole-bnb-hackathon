// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverCodeV21} from "../../../src/box-v2/interfaces/IFeeModulesV21.sol";
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";
// CQ11-B replaces cap/converter/recipe deferrals with the receiver's surviving access and money boundaries.
import {
    ReceiverFixture,
    ReceiverCoordinator,
    ReceiverForeignUnlock,
    ReceiverGasSink
} from "../cq11-b/ReceiverFixture.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {ReceiverArgs} from "../../../src/box-v2/libraries/BoxReceiverV2Args.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

contract ReceiverBoundaryTest is ReceiverFixture {
    function test_safeAddressesAreFixedAndZeroSafeRefused() public {
        ReceiverCodeV21 memory code;
        assertEq(r.FIT_SAFE(), FIT);
        assertEq(r.PLATFORM_SAFE(), PLATFORM);
        code = ReceiverDeploy.code(pm);
        vm.expectRevert(IBoxReceiverV2.ZeroAddress.selector);
        new BoxReceiverV2(pm, coordinatorCode, address(0), PLATFORM, code);
        code = ReceiverDeploy.code(pm);
        vm.expectRevert(IBoxReceiverV2.ZeroAddress.selector);
        new BoxReceiverV2(pm, coordinatorCode, FIT, address(0), code);

    }

    function test_zeroPayeeOnlyAllowedWithoutCreatorDestinations() public {
        ReceiverArgs memory a = _args(1, 2, 1, address(p));
        a.creatorPayee = address(0);
        r = _clone(a);
        vm.expectRevert(IBoxReceiverV2.ZeroAddress.selector);
        coord.initialize(r);
        a.buyersChoice = 2;
        a.royaltyDestination = 2;
        r = _clone(a);
        vm.expectRevert(IBoxReceiverV2.ZeroAddress.selector);
        coord.initialize(r);
        a.royaltyDestination = 1;
        r = _clone(a);
        coord.initialize(r);
        _fees(150, 0);
        r.collect(address(0));
        assertEq(r.buyBackP(), 100);
    }

    function test_collectFivePercentBelowCapFromBuyersOnly() public {
        _fees(1500, 1500);
        assertEq(r.collect(TIP).tip, 75);
        assertEq(p.balanceOf(TIP), 76);
        _booked();
    }

    function test_freshTipRecipientPaidExactlyOrLeftUnbookedWithoutClaimsFallback() public {
        address fresh = address(0xB0B);
        _fees(1500, 0);
        uint256 paid = r.collect(fresh).tip;
        assertTrue(paid == 0 || paid == 75);
        assertEq(p.balanceOf(fresh), paid);
        assertEq(pm.balanceOf(fresh, uint160(address(p))), 0);
        assertEq(_balance(address(r)) - r.booked(address(p)), 75 - paid);
        r.collect(address(0));
        _booked();
        assertEq(_balance(address(r)), 1500 - paid);
    }

    function test_payoutChecksExactReceiptAndRetainsLedgerOnShortTransfer() public {
        _fees(1500, 0);
        r.collect(address(0));
        p.setFeeBps(1000);
        assertEq(r.payFit(), 0);
        assertEq(r.fitOwed(), 200);
        assertEq(p.balanceOf(FIT), 0);
        p.setFeeBps(0);
        assertEq(r.payFit(), 200);
        _booked();
    }

    function test_creatorClaimRefusalIsAtomicAndRetryCanChooseAnotherAddress() public {
        _fees(150, 0);
        r.collect(address(0));
        coord.graduation(r);
        p.setBlocked(PAYEE, true);
        vm.prank(PAYEE);
        vm.expectRevert();
        r.claimCreator(address(p), PAYEE);
        assertEq(r.creatorP(), 100);
        vm.prank(PAYEE);
        assertEq(r.claimCreator(address(p), TIP), 100);
        _booked();
    }

    function test_oneBlockedNativeSafeAndGasBurningTipDoNotLockOtherMoney() public {
        r = _receiver(1, 1, 1, address(0), true);
        ReceiverGasSink sink = new ReceiverGasSink();
        vm.etch(FIT, address(sink).code);
        vm.etch(TIP, address(sink).code);
        _fees(1500, 0);
        assertEq(r.collect(TIP).tip, 0);
        assertEq(r.payFit(), 0);
        assertGt(r.payPlatform(), 0);
        _booked();
        coord.failure(r);
        assertGt(_balance(address(coord)), 0);
        _booked();
    }

    function test_callbackCannotBeCalledByStrangerOrForeignUnlock() public {
        vm.expectRevert();
        IUnlockCallback(address(r)).unlockCallback(abi.encode(uint256(1), address(p), PAYEE, uint256(1)));
        vm.prank(address(pm));
        vm.expectRevert();
        IUnlockCallback(address(r)).unlockCallback(abi.encode(uint256(1), address(p), PAYEE, uint256(1)));
    }

    function test_lowGasTipAttemptRollsBackAllAccountingAndCounter() public {
        _fees(1500, 1500);
        (bool ok,) = address(r).call{gas: 100_000}(abi.encodeCall(r.collect, (TIP)));
        assertFalse(ok);
        assertEq(r.booked(address(p)), 0);
        assertEq(hook.sellers(), 1500);
        r.collect(TIP);
        _booked();
    }

    function testFuzz_repeatedCollectPayoutsAndFailureConserve(uint96 seed) public {
        uint256 total;
        for (uint256 i; i < 12; i++) {
            uint256 amount = uint256(keccak256(abi.encode(seed, i))) % 1e12;
            total += amount;
            _fees(amount / 2, amount - amount / 2);
            r.collect(address(0));
            if (i % 2 == 0) r.payFit();
            else r.payPlatform();
            _booked();
            assertEq(_balance(address(r)) + p.balanceOf(FIT) + p.balanceOf(PLATFORM), total);
        }
        coord.failure(r);
        r.payFit();
        r.payPlatform();
        _booked();
        assertEq(_balance(address(coord)) + p.balanceOf(FIT) + p.balanceOf(PLATFORM), total);
        assertEq(_balance(address(r)), 0);
    }

    function test_failedFlagBeforeReceiverSettlementCannotStealFinalSplit() public {
        _fees(150, 0);
        coord.setFailed();
        vm.expectRevert(IBoxReceiverV2.BoxFailed.selector);
        r.collect(address(0));
        vm.prank(address(coord));
        r.enterFailure();
        assertEq(r.fitOwed(), 20);
        assertEq(r.platformOwed(), 10);
        assertEq(_balance(address(coord)), 120);
    }
}
