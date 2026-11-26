// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverFixture, ReceiverRefuser, ReceiverGasSink} from "./ReceiverFixture.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";

contract ReceiverRoyaltyTest is ReceiverFixture {
    function test_PHeldWholeThenRoyaltyMenu() public {
        for (uint8 choice = 1; choice <= 3; choice++) {
            for (uint8 dest = 1; dest <= 3; dest++) {
                r = _receiver(choice, 1, dest, address(p), true);
                _royalty(address(p), 150);
                assertEq(r.royaltyHeldP(), 150);
                assertEq(r.creatorP(), 0);
                r.collect(TIP);
                assertEq(r.royaltyHeldP(), 150);
                coord.graduation(r);
                assertEq(r.royaltyHeldP(), 0);
                assertEq(r.fitOwed(), 20);
                assertEq(r.platformOwed(), 10);
                assertEq(r.creatorP(), choice == 1 ? 100 : 0);
                assertEq(r.buyBackP(), choice == 2 ? 100 : 0);
                _booked();
                // New coordinator provides an ungraduated phase for the next box.
                coord = _newCoordinator();
            }
        }
    }

    function test_returnedPAfterGraduationUsesBuyersChoice() public {
        r = _receiver(2, 1, 1, address(p), true);
        coord.graduation(r);
        _royalty(address(p), 150);
        assertEq(r.buyBackP(), 100);
        assertEq(_balance(address(hook)), 20);
        assertEq(r.fitOwed(), 20);
        _booked();
    }

    function test_RC5_foreignRoyaltyRejectedBeforeCustody() public {
        uint256 beforeBalance = address(r).balance;
        (bool ok,) = address(r).call(abi.encodeWithSignature("fundRoyalty(address,uint256)", address(0xDEAD), 1));
        assertFalse(ok, "RC5: receiver accepts only P");
        assertEq(address(r).balance, beforeBalance);
    }

    function test_intakeExactAndWrongValueRollBack() public {
        p.mint(address(this), 100);
        p.approve(address(r), 100);
        p.setFeeBps(1000);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiverV2.TransferNotExact.selector, 100, 90));
        r.fundRoyalty(address(p), 100);
        assertEq(p.balanceOf(address(this)), 100);
        assertEq(r.booked(address(p)), 0);
        p.setFeeBps(0);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiverV2.WrongValue.selector, 1, 0));
        r.fundRoyalty{value: 1}(address(p), 100);
        r = _receiver(1, 1, 1, address(0), true);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiverV2.WrongValue.selector, 1, 2));
        r.fundRoyalty{value: 1}(address(0), 2);
    }

    function test_returnedPAfterFailureAndAfterLastClaimAlwaysPot() public {
        _royalty(address(p), 150);
        coord.failure(r);
        assertEq(_balance(address(coord)), 150);
        _royalty(address(p), 75);
        assertEq(r.fitOwed(), 0);
        assertEq(_balance(address(coord)), 225);
        // Receiver never consults tLeft: later receipts always remain in coordinator custody.
        vm.prank(address(coord));
        pm.transfer(address(0xBEEF), uint160(address(p)), 225);
        _royalty(address(p), 30);
        assertEq(r.fitOwed(), 0);
        assertEq(_balance(address(coord)), 30);
        assertEq(r.payFit(), 0);
        assertEq(p.balanceOf(FIT), 0);
        _booked();
    }

    function test_reentrantRoyaltyCannotDoubleBookOrSteal() public {
        p.mint(address(this), 150);
        p.approve(address(r), 150);
        p.armReentry(address(r), abi.encodeCall(r.collect, (TIP)));
        vm.expectRevert();
        r.fundRoyalty(address(p), 150);
        assertEq(r.booked(address(p)), 0);
        assertEq(p.balanceOf(address(this)), 150);
    }

    function test_nativePRoyaltyAndSafePayouts() public {
        r = _receiver(1, 1, 1, address(0), true);
        _royalty(address(0), 150);
        coord.graduation(r);
        assertEq(r.payFit(), 20);
        assertEq(FIT.balance, 20);
        assertEq(r.payPlatform(), 10);
        vm.prank(PAYEE);
        assertEq(r.claimCreator(address(0), PAYEE), 100);
        assertEq(_balance(address(hook)), 20);
        _booked();
    }
}
