// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../rc5-a/NoFailureSweep.sol";

import {CQ11ARealFixture} from "../cq11-a/RealFixture.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {BoxRolesV2} from "../../../src/box-v2/interfaces/IBoxRegistryV2.sol";
import {FeeBatchV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";

contract FableMoneyExitsTest is CQ11ARealFixture {
    using StateLibrary for IPoolManager;
    // Later roles use the coordinator's frozen roleAddress seam; money still uses the real PoolManager.
    function _recipients() private returns (address[] memory recipients) {
        recipients = new address[](BoxRolesV2.ROLE_COUNT + 1);
        for (uint256 role; role < BoxRolesV2.ROLE_COUNT; ++role) {
            address part = box.roleAddress(role);
            if (part == address(0)) {
                part = address(uint160(0xD000 + role));
                vm.mockCall(address(box), abi.encodeWithSignature("roleAddress(uint256)", role), abi.encode(part));
            }
            recipients[role] = part;
            p.mint(part, 1); // A funded recipient cannot incidentally fail the stipend under Amsterdam.
        }
        recipients[BoxRolesV2.ROLE_COUNT] = address(pm);
    }

    function test_item7_collectRefusesEveryOwnPartAndManagerLeavingTipUnbooked() public {
        receiver.collect(address(0));
        address[] memory recipients = _recipients();
        for (uint256 i; i < recipients.length; ++i) {
            uint256 snapshot = vm.snapshotState();
            trader.gift(address(p), address(receiver), 1500);
            uint256 claimsBefore = _claims(address(receiver));
            uint256 tokensBefore = p.balanceOf(recipients[i]);
            FeeBatchV2 memory batch = receiver.collect(recipients[i]);
            assertEq(batch.tip, 0, "system recipient must not receive a tip");
            assertEq(_claims(address(receiver)), claimsBefore);
            assertEq(p.balanceOf(recipients[i]), tokensBefore);
            assertEq(_claims(address(receiver)) - receiver.booked(address(p)), 75);
            vm.revertToState(snapshot);
        }
    }

    function test_item7_buyBackRefusesEveryOwnPartAndManagerKeepingBudget() public {
        choice = 2; _make(RAISE); _graduate();
        trader.gift(address(p), address(receiver), RAISE / 100);
        receiver.collect(address(0));
        address[] memory recipients = _recipients();
        for (uint256 i; i < recipients.length; ++i) {
            uint256 snapshot = vm.snapshotState();
            vm.roll(block.number + 1);
            uint256 beforeBudget = receiver.buyBackP();
            uint256 tokensBefore = p.balanceOf(recipients[i]);
            (, uint256 spent,, uint256 tip) = receiver.buyBack(recipients[i]);
            assertGt(spent, 0);
            assertEq(tip, 0);
            assertEq(receiver.buyBackP(), beforeBudget - spent);
            // PoolManager pays out no P during this claims-funded buy.
            assertEq(p.balanceOf(recipients[i]), tokensBefore);
            vm.revertToState(snapshot);
        }
    }

    function test_item7_deepenRefusesEveryOwnPartAndManagerKeepingDepth() public {
        _graduate();
        address[] memory recipients = _recipients();
        address keeper = address(0xC011EC7);
        p.mint(keeper, 1);
        vm.roll(block.number + 1);
        uint256 baseline = vm.snapshotState();
        (,,, uint256 paid) = hook.deepen(keeper);
        assertGt(paid, 0, "ordinary keeper still receives the tip");
        uint256 budgetAfterPaidTip = hook.depthBudget();
        uint256 liquidityAfter = pm.getLiquidity(hook.poolId());
        vm.revertToState(baseline);
        for (uint256 i; i < recipients.length; ++i) {
            uint256 snapshot = vm.snapshotState();
            uint256 tokensBefore = p.balanceOf(recipients[i]);
            (,,, uint256 tip) = hook.deepen(recipients[i]);
            assertEq(tip, 0);
            assertEq(hook.depthBudget(), budgetAfterPaidTip + paid, "entire refused tip stays as depth");
            assertEq(pm.getLiquidity(hook.poolId()), liquidityAfter);
            assertEq(p.balanceOf(recipients[i]), tokensBefore);
            vm.revertToState(snapshot);
        }
    }

    function test_item7_ordinaryKeeperCollectAndBuyBackStillPay() public {
        choice = 2; _make(RAISE); _graduate();
        address keeper = address(0xC011EC7);
        p.mint(keeper, 1);
        trader.gift(address(p), address(receiver), RAISE / 100);
        uint256 collectTip = receiver.collect(keeper).tip;
        assertGt(collectTip, 0);
        vm.roll(block.number + 1);
        (,,, uint256 buyTip) = receiver.buyBack(keeper);
        assertGt(buyTip, 0);
        assertEq(p.balanceOf(keeper), 1 + collectTip + buyTip);
    }

    function test_item7_partReadRefusalCannotBlockCollection() public {
        receiver.collect(address(0));
        trader.gift(address(p), address(receiver), 1500);
        address keeper = address(0xC011EC7);
        vm.mockCallRevert(address(box), abi.encodeWithSignature("roleAddress(uint256)", uint256(0)), "read refused");
        assertEq(receiver.collect(keeper).tip, 0);
        assertEq(_claims(address(receiver)) - receiver.booked(address(p)), 75);
        assertEq(p.balanceOf(keeper), 0);
    }

    function _failWithHolder() private returns (uint256 left) {
        _open(); _buy(RAISE / 10);
        vm.warp(box.deadline()); box.fail();
        (, left) = box.claimState();
        assertEq(left, t.balanceOf(address(trader)));
        vm.prank(address(trader)); t.approve(address(box), left);
    }

    function test_item8_lateHookClaimsJoinHolderPotOnce() public {
        uint256 left = _failWithHolder();
        uint256 pot = _claims(address(box));
        trader.gift(address(p), address(hook), 12345);
        vm.prank(address(trader));
        assertEq(box.claim(left, address(trader)), pot + 12345);
        assertEq(_claims(address(hook)), 0);
        assertEq(_claims(address(box)), 0);
        NoFailureSweep.check(address(box));
    }

    function test_item8_lateHookClaimsAfterLastClaimStayPut() public {
        uint256 left = _failWithHolder();
        vm.prank(address(trader)); box.claim(left, address(trader));
        uint256 owed = receiver.fitOwed();
        trader.gift(address(p), address(hook), 98765);
        NoFailureSweep.check(address(box));
        assertEq(receiver.fitOwed(), owed);
        assertEq(_claims(address(hook)), 98765);
        NoFailureSweep.check(address(box));
        assertEq(receiver.payFit(), owed);
    }

    function test_item8_lateHookClaimsNeverIncreaseFixedNoBuyerReturn() public {
        vm.warp(box.deadline()); box.fail();
        (uint256 pot, uint256 left) = box.claimState(); assertEq(left, 0);
        trader.gift(address(p), address(hook), 4321);
        NoFailureSweep.check(address(box));
        assertEq(box.claim(0, address(this)), pot);
        assertEq(_claims(address(hook)), 0);
    }

    function test_item8_repeatedCloseOnlyMovesPAndRemainsCoordinatorOnly() public {
        _failWithHolder();
        uint256 supply = t.totalSupply();
        uint256 residue = hook.closedTResidue();
        uint256 pot = _claims(address(box));
        trader.gift(address(p), address(hook), 123);
        vm.expectRevert(abi.encodeWithSelector(IBoxHookV2.NotCoordinator.selector, address(this)));
        hook.close();
        vm.prank(address(box)); (uint256 moved, uint256 burned) = hook.close();
        assertEq(moved, 123); assertEq(burned, 0);
        vm.prank(address(box)); (moved, burned) = hook.close();
        assertEq(moved, 0); assertEq(burned, 0);
        assertEq(t.totalSupply(), supply); assertEq(hook.closedTResidue(), residue);
        assertEq(_claims(address(box)), pot + 123);
    }

    function test_item8_failedPayoutRollsBackLateForwardForRetry() public {
        uint256 left = _failWithHolder();
        uint256 pot = _claims(address(box));
        trader.gift(address(p), address(hook), 321);
        vm.mockCallRevert(address(p), abi.encodeWithSignature("transfer(address,uint256)", address(trader), pot + 321), "paused");
        vm.prank(address(trader));
        vm.expectRevert(bytes4(keccak256("ClaimFailed()")));
        box.claim(left, address(trader));
        assertEq(_claims(address(hook)), 321);
        assertEq(_claims(address(box)), pot);
        (, uint256 stillLeft) = box.claimState(); assertEq(stillLeft, left);
        assertEq(t.balanceOf(address(trader)), left);
        vm.clearMockedCalls();
        vm.prank(address(trader)); assertEq(box.claim(left, address(trader)), pot + 321);
    }

    function test_item11_anyCallerSweepsFailedRouterToCoordinatorPot() public {
        _failWithHolder();
        uint256 pot = _claims(address(box));
        uint256 hookClaims = _claims(address(hook));
        uint256 creatorClaims = _claims(address(this));
        p.mint(address(router), 999);
        vm.prank(address(0xCA11)); assertEq(router.sweep(), 999);
        assertEq(_claims(address(box)), pot + 999);
        assertEq(_claims(address(hook)), hookClaims);
        assertEq(_claims(address(this)), creatorClaims);
    }
}
