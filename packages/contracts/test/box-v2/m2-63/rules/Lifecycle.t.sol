// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../../rc5-a/NoFailureSweep.sol";
import {M244Base} from "../../m2-44/Fixture.sol";
import {BoxSpec} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxTokenV2} from "../../../../src/box-v2/BoxTokenV2.sol";
import {IShopVaultV2, IStarterSetLoaderV2} from "../../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {IBoxCoordinatorV2, FailCause} from "../../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {HostileCollection} from "../../kit/m2/ShopDoubles.sol";

contract M263LifecycleTest is M244Base {
    function test_P07_realSeedOnlyShopRequiresCustodyAndExplicitCompletion() public {
        _unfundedShop();
        vm.prank(CREATOR); token.approve(address(shop), 100 ether);
        vm.expectRevert(); loader.complete(); // approval is not seed custody
        vm.prank(ALICE); shop.fundSeed();
        assertFalse(box.gateOpen());
        vm.prank(ALICE); loader.complete();
        assertTrue(box.gateOpen()); assertFalse(box.starterSetPending());
        assertEq(box.effectiveOpenAt(), vm.getBlockTimestamp() + 1);
        vm.expectRevert(); loader.complete();
    }

    function test_P08_unopenedFailureBoundaryAndLateCompletionNeverReopens() public {
        _unfundedShop();
        uint256 end = box.openAt() + 14 days;
        vm.warp(end - 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.GateCapNotReached.selector, end)); box.failClosed();
        assertFalse(box.failed());
        vm.warp(end); vm.prank(ALICE); box.failClosed();
        assertEq(uint256(box.failCause()), uint256(FailCause.ClosedPastCap));
        vm.expectRevert(); loader.complete();
        vm.expectRevert(); shop.fundSeed();
        assertFalse(box.gateOpen()); assertEq(box.effectiveOpenAt(), 0);
        vm.expectRevert(); box.failClosed(); vm.expectRevert(); box.graduate();
    }

    function test_P09_deadlineBoundaryUsesPermissionlessAtomicFailure() public {
        _createShop(0, 1000 ether, true, true); _trade();
        uint256 end = box.deadline();
        vm.warp(end - 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.DeadlineNotReached.selector, end)); box.fail();
        assertFalse(box.failed()); assertEq(shop.budgetT(), 1000 ether);
        vm.warp(end); vm.prank(ALICE); box.fail();
        assertEq(uint256(box.failCause()), uint256(FailCause.Deadline));
        assertEq(shop.budgetT(), 0); assertEq(shop.failedT(), 1000 ether);
        assertTrue(receiver.holderBatchClosed(1)); assertTrue(receiver.holderBatchClosed(2));
        vm.expectRevert(); box.fail(); vm.expectRevert(); box.graduate();
    }

    function test_P10_timePreservesFailurePotButNeverHolderFeeCredits() public {
        _createShop(0, 1000 ether, false, true); _trade();
        vm.warp(box.deadline()); box.fail(); ledger.settleBatch(1, 64);
        uint256 credit = ledger.claimable(1, CREATOR); assertGt(credit, 0);
        (uint256 pot, uint256 left) = box.claimState();
        assertGt(pot, 0); assertGt(left, 0);
        shop.burnFailedT();
        (, uint256 afterBurn) = box.claimState(); assertEq(afterBurn, left, "R40A: never recount");
        uint256 yearEnd = box.failedAt() + 365 days;
        vm.warp(yearEnd - 1); NoFailureSweep.check(address(box));
        uint256 fit = receiver.fitOwed();
        vm.warp(yearEnd); vm.prank(ALICE); NoFailureSweep.check(address(box));
        assertEq(receiver.fitOwed(), fit);
        assertEq(ledger.claimable(1, CREATOR), credit);
        vm.prank(CREATOR); assertEq(ledger.claim(1, CREATOR), credit);
        assertEq(box.quoteClaim(left), pot);
        NoFailureSweep.check(address(box));
    }

    function test_P11_realPartialStarterNeverOpensUntilTheExactSetIsComplete() public {
        _createShop(0, 100 ether, true, false);
        _page(0, 9);
        vm.expectRevert(); loader.complete();
        assertFalse(box.gateOpen()); assertTrue(box.starterSetPending());
        _page(9, 1); assertFalse(box.gateOpen());
        vm.prank(ALICE); loader.complete();
        assertTrue(box.gateOpen()); assertFalse(box.starterSetPending());
        assertEq(shop.inside(), 10); assertEq(box.effectiveOpenAt(), vm.getBlockTimestamp() + 1);
    }

    function _unfundedShop() private {
        BoxSpec memory s = _shop(address(new HostileCollection()), 0, 0, 100 ether);
        box = _create(s); token = BoxTokenV2(box.token());
        shop = IShopVaultV2(box.vault()); loader = IStarterSetLoaderV2(box.starterSetLoader());
        assertFalse(box.gateOpen()); assertTrue(box.starterSetPending());
    }
}
