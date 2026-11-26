// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReceiverGasSink, ReceiverSafe} from "../../cq11-b/ReceiverFixture.sol";
import {BookingFixture} from "../../m3-23/Fixture.sol";
import {HostileToken} from "../../kit/HostileToken.sol";
import {FeeBatchV2, IBoxReceiverV2} from "../../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {ReceiverArgs} from "../../../../src/box-v2/libraries/BoxReceiverV2Args.sol";

/// @notice Independent arithmetic and custody assertions around the production receiver and real claims.
contract CustodyBookingTest is BookingFixture {
    function testFuzz_twoSidesKeepTheirCarriesAndFailureOwners(uint96 a, uint96 b, uint96 c, uint96 d) public {
        for (uint8 buyers = 1; buyers <= 3; ++buyers) {
            for (uint8 sellers = 1; sellers <= 3; ++sellers) {
                uint256 snapshot = vm.snapshotState();
                r = _receiver(buyers, sellers, 1, address(p), true);
                _fees(a, b);
                r.collect(address(0));
                _fees(c, d);
                r.collect(address(0));
                uint256 ub = (uint256(a) + c) / 15;
                uint256 us = (uint256(b) + d) / 15;
                uint256 carries = (uint256(a) + c) % 15 + (uint256(b) + d) % 15;
                uint256 grow = (buyers == 3 ? 10 * ub : 0) + (sellers == 3 ? 10 * us : 0);
                uint256 total = uint256(a) + b + c + d;
                assertEq(r.fitOwed(), 2 * (ub + us));
                assertEq(r.platformOwed(), ub + us);
                assertEq(r.poolHeldP(), 2 * (ub + us));
                assertEq(r.creatorP(), (buyers == 1 ? 10 * ub : 0) + (sellers == 1 ? 10 * us : 0));
                assertEq(r.buyBackP(), (buyers == 2 ? 10 * ub : 0) + (sellers == 2 ? 10 * us : 0));
                assertEq(r.growHeldP(), grow);
                assertEq(r.booked(address(p)), total);
                assertEq(r.booked(address(p)) - _sum(), carries);
                _booked();

                // P is frozen: routing still moves claims, and neither Safe loses its entitlement.
                p.setPaused(true);
                coord.failure(r);
                uint256 pot = 12 * (ub + us) + carries;
                assertEq(_balance(address(coord)), pot);
                assertEq(r.fitOwed(), 2 * (ub + us));
                assertEq(r.platformOwed(), ub + us);
                assertEq(_balance(address(r)) + pot, total);
                assertEq(r.booked(address(p)), _balance(address(r)));
                coord.failure(r);
                assertEq(_balance(address(coord)), pot, "failure cannot route the same money twice");
                p.setPaused(false);
                uint256 fit = r.fitOwed();
                uint256 platform = r.platformOwed();
                assertEq(r.payFit(), fit);
                assertEq(r.payPlatform(), platform);
                assertEq(p.balanceOf(FIT) + p.balanceOf(PLATFORM) + pot, total);
                assertEq(r.booked(address(p)), 0);
                vm.revertToState(snapshot);
            }
        }
    }

    function test_blockedFitPayoutCannotSpendPlatformOrCreatorMoney() public {
        _fees(1500, 1500);
        r.collect(address(0));
        p.setBlocked(FIT, true);
        assertEq(r.payFit(), 0);
        assertEq(r.fitOwed(), 400);
        assertEq(r.payPlatform(), 200);
        assertEq(r.creatorP(), 2000);
        assertEq(r.booked(address(p)), 2800);
        coord.graduation(r);
        vm.prank(PAYEE);
        assertEq(r.claimCreator(address(p), PAYEE), 2000);
        assertEq(_balance(address(hook)), 400);
        p.setBlocked(FIT, false);
        assertEq(r.payFit(), 400);
        assertEq(r.payFit(), 0);
        assertEq(r.booked(address(p)), 0);
        assertEq(_balance(address(r)), 0);
    }

    function test_refusedTipRemainsUnbookedAndNextCollectionAccountsForIt() public {
        _fees(1500, 150);
        p.setBlocked(TIP, true);
        FeeBatchV2 memory first = r.collect(TIP);
        assertEq(first.tip, 0);
        assertEq(first.buyersP, 1425);
        assertEq(first.sellersP, 150);
        assertEq(_balance(address(r)) - r.booked(address(p)), 75);
        FeeBatchV2 memory next = r.collect(address(0));
        assertEq(next.buyersP, 75);
        assertEq(next.sellersP, 0);
        assertEq(r.booked(address(p)), 1650);
        assertEq(r.fitOwed(), 220);
        assertEq(r.platformOwed(), 110);
    }

    function test_nativeRoyaltyMenuHoldsWholeUntilGraduation() public {
        for (uint8 destination = 1; destination <= 3; ++destination) {
            uint256 snapshot = vm.snapshotState();
            r = _receiver(2, 1, destination, address(0), true);
            _royalty(address(0), 150);
            r.collect(TIP);
            assertEq(r.royaltyHeldP(), 150);
            assertEq(r.fitOwed(), 0);
            coord.graduation(r);
            assertEq(r.royaltyHeldP(), 0);
            assertEq(r.buyBackP(), 100);
            assertEq(r.creatorP(), 0);
            assertEq(_balance(address(hook)), 20);
            assertEq(r.payFit(), 20);
            assertEq(r.payPlatform(), 10);
            assertEq(_balance(address(r)) + _balance(address(hook)) + FIT.balance + PLATFORM.balance, 150);
            _booked();
            vm.revertToState(snapshot);
        }
    }

    /// F136 (SH-V21-RC5-INT fix round): a lot still waiting at the failure stays in the box for good; P returned for a
    /// lot the Safe took earlier joins the pot.
    function test_RC5_foreignRoyaltyRejectedBeforeCustody() public {
        uint256 beforeBalance = address(r).balance;
        (bool ok,) = address(r).call(abi.encodeWithSignature("fundRoyalty(address,uint256)", address(0xDEAD), 1));
        assertFalse(ok, "RC5: receiver accepts only P");
        assertEq(address(r).balance, beforeBalance);
    }

    function test_holderAndItemAdmissionRequireTheirAuthenticatedWiring() public {
        for (uint8 choice = 4; choice <= 5; ++choice) {
            for (uint256 side; side < 2; ++side) {
                uint256 snapshot = vm.snapshotState();
                ReceiverArgs memory args = _args(side == 0 ? choice : 1, side == 1 ? choice : 1, 1, address(p));
                r = _clone(args);
                vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector);
                coord.initialize(r);
                vm.expectRevert(bytes("ReceiverNotInitialized"));
                r.collect(address(0));
                assertEq(r.booked(address(p)), 0);
                assertEq(_balance(address(r)), 0);

                args.holderLedger = address(0xABCD);
                args.itemLedger = address(0xBCDE);
                r = _clone(args);
                // M3-23 admits Items only when role 16, policies, vault and source journal agree.
                if (choice == 5) vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector);
                coord.initialize(r);
                if (choice == 4) assertEq(r.holderLedger(), args.holderLedger);
                assertEq(r.booked(address(p)), 0);
                assertEq(_balance(args.holderLedger), 0);
                assertEq(_balance(args.itemLedger), 0);
                if (choice == 5) {
                    vm.expectRevert(bytes("ReceiverNotInitialized"));
                    r.collect(address(0));
                    // Real ItemLedgerV2 and receiver; the shared fixture supplies coordinator/vault/hook reads.
                    _items(side == 0 ? 5 : 1, side == 1 ? 5 : 1, side == 0 ? 1 : 0, side == 1 ? 1 : 0);
                    assertEq(r.itemLedger(), address(items));
                    assertEq(funding.itemFundingCount(), 0);
                    assertEq(r.booked(address(p)), 0);
                    assertEq(_balance(address(items)), 0);
                }
                assertTrue(vm.revertToState(snapshot));
            }
        }
    }
}
