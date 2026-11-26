// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M340Base} from "../../m3-40/Fixture.sol";
import {M340ItemsTest} from "../../m3-40/Items.t.sol";
import {M340PilesTest} from "../../m3-40/Piles.t.sol";
import {M340SweepTest} from "../../m3-40/Sweep.t.sol";
import {LifeForeignUnlock} from "../../kit/FactoryLife.sol";
import {BoxSpec} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {IBoxCoordinatorV2, FailCause} from "../../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxHookV2} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";

contract RulesItemsFailureTest is M340ItemsTest {}
contract RulesPilesFailureTest is M340PilesTest {}
contract RulesYearSweepTest is M340SweepTest {}

contract RulesFailureLivenessTest is M340Base {
    function test_P05_revertingItemCannotStopFeesTradesTransfersOrFailureClaim() public {
        _hostileItems(hex"60006000fd");
    }

    function test_P05_exhaustingItemCannotStopFeesTradesTransfersOrFailureClaim() public {
        _hostileItems(hex"5b600056");
    }

    function _hostileItems(bytes memory badCode) private {
        for (uint256 mix; mix < 3; ++mix) {
            BoxSpec memory s = _items(mix == 2 ? 0 : 1, mix == 1 ? 0 : 2);
            if (mix != 0) {
                if (mix == 1) {
                    s.sellers.a.leg = 1;
                    s.sellers.a.dest = 6;
                    s.sellers.a.destParams = abi.encode(uint8(1));
                } else {
                    s.buyers.a.leg = 1;
                    s.buyers.a.dest = 6;
                    s.buyers.a.destParams = abi.encode(uint8(1));
                }
            }
            _start(s);
            address item = box.roleAddress(16);
            vm.etch(item, badCode);
            vm.expectCall(item, bytes(""), uint64(0));
            _buy(s.raise / 5);
            uint256 beforeT = token.balanceOf(address(buyer));
            buyer.swap(hook.poolKey(), false, beforeT / 8, layout.sqrtPriceStartX96);
            vm.prank(address(buyer));
            token.transfer(CREATOR, 1);
            vm.prank(CREATOR);
            token.transfer(address(buyer), 1);
            _gift(address(receiver), 1500);
            receiver.collect(address(0));
            if (mix == 2) assertEq(receiver.itemsHeldP(), 0, "curve seller fees burn");
            else assertGt(receiver.itemsHeldP(), 0);
            _booked();
            vm.warp(box.deadline());
            box.fail();
            assertEq(receiver.itemsHeldP(), 0);
            assertEq(pm.balanceOf(item, 0), 0);
            _claimBuyer();
        }
    }

    function test_P06_hatchBoundsRetryForeignUnlockAndLowGasWithBothM3Families() public {
        for (uint256 family; family < 2; ++family) {
            _start(family == 0 ? _items(1, 2) : _pile(address(0), 0));
            _fill();
            uint256 filledAt = hook.closedAt();
            uint256 boundary = filledAt + 7 days;
            assertLt(boundary, box.deadline());
            vm.warp(boundary - 1);
            vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.GraduationEscapeNotReached.selector, boundary));
            box.fail();
            vm.mockCallRevert(address(hook), abi.encodeWithSelector(IBoxHookV2.migrate.selector), "migration refused");
            vm.expectRevert(bytes("migration refused"));
            box.graduate();
            vm.clearMockedCalls();
            assertEq(hook.closedAt(), filledAt);
            assertFalse(box.graduated());
            vm.warp(boundary);
            LifeForeignUnlock foreign = new LifeForeignUnlock(pm);
            (bool ok, bytes memory reason) = foreign.attempt(address(box), abi.encodeWithSignature("fail()"));
            assertFalse(ok);
            assertEq(reason, abi.encodeWithSelector(IBoxCoordinatorV2.ForeignUnlock.selector));
            (ok,) = address(box).call{gas: 150_000}(abi.encodeWithSignature("fail()"));
            assertFalse(ok);
            assertFalse(box.failed());
            assertEq(box.failedAt(), 0);
            vm.prank(CREATOR);
            box.fail();
            assertEq(box.failedAt(), boundary);
            assertEq(uint256(box.failCause()), uint256(FailCause.GraduationTimedOut));
            vm.expectRevert(IBoxCoordinatorV2.AlreadyFailed.selector);
            box.fail();
            vm.expectRevert(IBoxCoordinatorV2.AlreadyFailed.selector);
            box.graduate();
            _claimBuyer();
        }
    }

    function test_P07_successfulGraduationWinsHatchRaceForBothM3Families() public {
        for (uint256 family; family < 2; ++family) {
            _start(family == 0 ? _items(1, 2) : _pile(address(0), 0));
            _fill();
            vm.warp(hook.closedAt() + 7 days);
            box.graduate();
            vm.expectRevert(IBoxCoordinator.AlreadyGraduated.selector);
            box.fail();
            vm.expectRevert(IBoxCoordinator.AlreadyGraduated.selector);
            box.failClosed();
            assertTrue(box.graduated());
            assertFalse(box.failed());
        }
    }
}
