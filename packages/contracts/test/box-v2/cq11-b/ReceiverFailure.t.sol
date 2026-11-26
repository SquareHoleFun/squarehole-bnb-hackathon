// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Vm} from "forge-std/Vm.sol";
import {HeldKind, FailRoute} from "../../../src/box-v2/interfaces/FailureTableV2.sol";
import {ReceiverFixture} from "./ReceiverFixture.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";

contract ReceiverFailureTest is ReceiverFixture {
    function test_failureMenuRoutesReserveAndFeesOnceWhilePaused() public {
        for (uint8 choice = 1; choice <= 3; choice++) {
            r = _receiver(choice, choice, 1, address(p), true);
            _fees(150, 300);
            r.collect(address(0));
            _royalty(address(p), 75);
            _fees(15, 30); // final harvest plus recorded D6 reserve already transferred as P claims
            p.setPaused(true);
            coord.failure(r);
            assertEq(r.platformOwed(), 33);
            assertEq(r.fitOwed(), 66);
            assertEq(_balance(address(coord)), 471);
            assertEq(r.creatorP(), 0);
            assertEq(r.buyBackP(), 0);
            assertEq(r.poolHeldP(), 0);
            assertEq(r.growHeldP(), 0);
            assertEq(r.royaltyHeldP(), 0);
            _booked();
            uint256 fit = r.fitOwed();
            uint256 pot = _balance(address(coord));
            vm.prank(address(coord));
            r.enterFailure();
            assertEq(r.fitOwed(), fit);
            assertEq(_balance(address(coord)), pot);
            p.setPaused(false);
            coord = _newCoordinator();
        }
    }

    function test_failureCarriesAndLateDonationJoinHolderPot() public {
        _fees(16, 17);
        r.collect(address(0));
        coord.failure(r);
        assertEq(r.fitOwed(), 4);
        assertEq(r.platformOwed(), 2);
        assertEq(_balance(address(coord)), 27);
        _fees(100, 0);
        r.collect(TIP);
        assertEq(r.fitOwed(), 4);
        assertEq(r.platformOwed(), 2);
        assertEq(_balance(address(coord)), 127);
        _booked();
    }

    function test_growAndBothCarriesUseDistinctFailureLabels() public {
        r = _receiver(3, 3, 1, address(p), true);
        _fees(16, 17); r.collect(address(0));
        vm.recordLogs(); coord.failure(r);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 grow; uint256 carries; uint256 carryEvents;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(r) || logs[i].topics[0] != keccak256("FailureRouted(uint8,uint8,address,uint256)")) continue;
            uint256 kind = uint256(logs[i].topics[1]);
            if (kind != uint256(HeldKind.DEPTH_BRANCH) && kind != uint256(HeldKind.SIDE_CARRY)) continue;
            assertEq(uint256(logs[i].topics[2]), uint256(FailRoute.CLOSING_POOL));
            uint256 amount = abi.decode(logs[i].data, (uint256));
            if (kind == uint256(HeldKind.DEPTH_BRANCH)) grow += amount;
            else { carries += amount; ++carryEvents; }
        }
        assertEq(grow, 20); assertEq(carries, 3); assertEq(carryEvents, 2);
        assertEq(_balance(address(coord)), 27);
        assertEq(r.fitOwed(), 4); assertEq(r.platformOwed(), 2);
    }

    function test_failureOnlyWhenFailedAndNotGraduated() public {
        vm.prank(address(coord));
        vm.expectRevert();
        r.enterFailure();
        coord.graduation(r);
        vm.expectRevert();
        coord.failure(r);
    }

    function test_failedBoxCannotClaimCreatorOrBuyBack() public {
        _fees(150, 0);
        r.collect(address(0));
        coord.failure(r);
        vm.prank(PAYEE);
        vm.expectRevert(IBoxReceiverV2.BoxFailed.selector);
        r.claimCreator(address(p), PAYEE);
        vm.expectRevert(IBoxReceiverV2.BoxFailed.selector);
        r.buyBack(TIP);
    }
}
