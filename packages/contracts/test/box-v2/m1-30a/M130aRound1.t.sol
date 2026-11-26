// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M130aBase, M130aPrice} from "./M130aBase.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxSwapBoundsV2 as Bounds} from "../../../src/box-v2/libraries/BoxSwapBoundsV2.sol";
import {BoxRolesV2} from "../../../src/box-v2/interfaces/IBoxRegistryV2.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {Slot0} from "v4-core/src/types/Slot0.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {CQAAsset} from "../cq11-a/Fixture.sol";

contract M130aRound1Test is M130aBase {
    function test_M130a_BC027_rewardAbove96BitsIsPaidWhole() public {
        _make(LARGE); _graduate(); uint256 reward = box.rewardOf(address(this)); assertGt(reward, type(uint96).max);
        assertEq(box.claimReward(address(0xCAFE)), reward); assertEq(p.balanceOf(address(0xCAFE)), reward);
    }
    function test_M130a_BC159_claimRewardRefusalsKeepTheClaim() public {
        _graduate(); uint256 owed = box.rewardOf(address(this)); M130aPrice coin = _hostile();
        coin.configure(address(0xBAD), false); vm.expectRevert(); box.claimReward(address(0xBAD));
        assertEq(box.rewardOf(address(this)), owed); assertEq(box.claimReward(address(0xCAFE)), owed);
    }
    function test_M130a_unlockCarryingAnotherActionIsRefused() public {
        vm.expectRevert(); box.unlockCallback(abi.encode(uint8(99), address(this), 1));
        vm.prank(address(pm)); vm.expectRevert(); box.unlockCallback(abi.encode(uint8(99), address(this), 1));
    }
    function test_M130a_failNeedsALaunchedBox() public {
        BoxCoordinatorV2 fresh = _undeployed(bytes24(0)); vm.expectRevert(); fresh.fail(); assertFalse(fresh.failed());
    }
    function test_M130a_nonceTableRefusesRolesTenAndTwelve() public {
        for (uint256 role = 10; role <= 12; role += 2) {
            bytes memory ns = new bytes(24); ns[BoxRolesV2.ROLE_TOKEN] = bytes1(uint8(1)); ns[role] = bytes1(uint8(2));
            BoxCoordinatorV2 fresh = _undeployed(bytes24(ns)); bytes[] memory codes = new bytes[](2);
            vm.expectRevert(BoxCoordinatorV2.InvalidNonces.selector);
            fresh.deploy(codes, "", 0, 1, [bytes32(0),bytes32(0)], [uint256(0),uint256(0)]);
        }
    }
    function test_M130a_BC159_reenteringPMeetsTheCoordinatorsLock() public {
        _graduate(); uint256 owed = box.rewardOf(address(this)); M130aPrice coin = _hostile();
        coin.arm(address(box), abi.encodeCall(box.claimReward, (address(0xBAD))));
        vm.expectRevert(); box.claimReward(address(this)); assertEq(box.rewardOf(address(this)), owed);
        coin.arm(address(0), ""); assertEq(box.claimReward(address(this)), owed);
    }
    function test_M130a_BC110_failSweepsTheTaxAndForwardsTheReserve() public {
        _window(); _taxBuy(RAISE / 10); uint256 tax = router.totalTaxCollected();
        vm.warp(box.deadline()); box.fail();
        assertEq(router.totalSwept(), tax); assertEq(p.balanceOf(address(router)), 0);
        assertGt(receiver.fitOwed(), 0); assertEq(hook.depthBudget(), 0); assertEq(box.reserve(), 0);
    }
    function test_M130a_BC159_failWithAPausedPStillFails() public {
        _open(); _buy(RAISE / 10); M130aPrice coin = _hostile(); coin.configure(address(0), true);
        vm.warp(box.deadline()); box.fail(); assertTrue(box.failed()); assertTrue(hook.failed());
        (uint256 pot, uint256 left) = box.claimState(); assertGt(pot, 0); assertEq(left, t.balanceOf(address(trader)));
    }
    function test_M130a_BC027_claimsReachingTheCoordinatorInTheStepsGoToTheReceiver() public {
        trader.gift(address(p), address(box), 123456); _graduate(); receiver.collect(address(0));
        assertEq(_claims(address(box)), box.rewardOf(address(this))); assertGe(receiver.booked(address(p)), 123456);
    }
    function test_M130a_taxTableIsV1s() public view {
        assertEq(keccak256(abi.encode(router.taxTable())), BoxSpecV1.LAUNCH_TAX_TABLE_HASH);
        assertEq(router.taxPips(32), 0);
    }
    function test_M130a_BC157_closingFillKeepsExactlyTheTaxOnWhatEntered() public {
        _window(); vm.warp(box.effectiveOpenAt() + 372); p.mint(address(this), RAISE * 2);
        uint256 beforeManager = p.balanceOf(address(pm)); _taxBuy(RAISE * 2);
        uint256 spent = p.balanceOf(address(pm)) - beforeManager;
        uint256 pips = router.taxPips(31);
        assertTrue(hook.closed()); assertEq(router.totalTaxCollected(), (spent * pips + 1000000 - pips - 1) / (1000000 - pips));
    }
    function test_M130a_BC110_sweepAtTheBoxsFailure() public {
        _open(); _buy(RAISE / 10); vm.warp(box.deadline()); box.fail();
        p.mint(address(router), 54321); uint256 before = _claims(address(box)); router.sweep();
        assertEq(_claims(address(box)), before + 54321);
    }
    function test_M130a_BC220_openOutOfRangeIsTheHooksError() public {
        holdGate = true; _make(RAISE);
        vm.prank(address(box)); vm.expectRevert(); hook.setOpen(0);
        vm.prank(address(box)); vm.expectRevert(); hook.setOpen(1 << 40);
    }
    function test_M130a_BC159_sweepRefusalsKeepTheTax() public {
        _window(); _taxBuy(RAISE / 10); uint256 tax = p.balanceOf(address(router));
        M130aPrice coin = _hostile(); coin.configure(address(router), false);
        _graduate(); assertEq(p.balanceOf(address(router)), tax); assertEq(router.totalSwept(), 0);
        coin.configure(address(0), false); router.sweep(); assertEq(router.totalSwept(), tax);
    }
    function test_M130a_BC159_refundToABlockedPayerRevertsWhole() public {
        // Only outgoing transfer is refused, so the incoming transferFrom still succeeds.
        _window(); vm.warp(box.effectiveOpenAt() + 372); p.mint(address(this), RAISE * 2);
        vm.mockCallRevert(address(p), abi.encodeWithSignature("transfer(address,uint256)", address(this)), "refund refused");
        uint256 before = p.balanceOf(address(this)); vm.expectRevert(); _taxBuy(RAISE * 2);
        assertEq(p.balanceOf(address(this)), before); assertEq(router.totalTaxCollected(), 0); assertFalse(hook.closed());
        vm.clearMockedCalls();
    }
    function test_M130a_BC159_reenteringPMeetsTheRoutersLock() public {
        _window(); M130aPrice coin = _hostile(); coin.arm(address(router), abi.encodeCall(router.buy, (1000, 0, address(this), block.timestamp)));
        uint256 before = p.balanceOf(address(this)); vm.expectRevert(); _taxBuy(RAISE / 100);
        assertEq(p.balanceOf(address(this)), before); assertEq(router.totalTaxCollected(), 0);
    }
    function test_M130a_taxTotalsKeepTheirOwnWords() public {
        _window(); _taxBuy(RAISE / 100); uint256 collected = router.totalTaxCollected();
        p.mint(address(router), 123); _graduate(); router.sweep();
        assertEq(router.totalTaxCollected(), collected); assertEq(router.totalSwept(), collected + 123);
    }
    function test_M130a_FL3_nativeSettleAfterAnotherSync() public {
        p = CQAAsset(address(0)); _make(RAISE); _open();
        pm.sync(Currency.wrap(address(t))); _buy(RAISE / 100); assertGt(t.balanceOf(address(trader)), 0);
    }
    function test_M130a_FM1_oneStepCrossesAtMostOneSpacing() public pure {
        uint160 spot = TickMath.getSqrtPriceAtTick(200);
        uint160 limit = Bounds.roomLimit(true, spot, 999); assertGe(TickMath.getTickAtSqrtPrice(limit), 151);
    }
    function test_M130a_FM1_v1sStepNameKept() public pure {
        assertEq(Bounds.MAX_IMPACT_TICKS, Bounds.STEP_TICKS); assertEq(Bounds.STEP_TICKS, 49);
    }
}
