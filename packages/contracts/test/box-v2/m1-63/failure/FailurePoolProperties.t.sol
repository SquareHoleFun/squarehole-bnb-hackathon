// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../../rc5-a/NoFailureSweep.sol";

import {CQ11ARealFixture} from "../../cq11-a/RealFixture.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {IBoxHookV2} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxCoordinatorV2, FailCause, ChunkPart} from "../../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";

/// @notice Deployed real lifecycle parts and PoolManager; only P and the user's settlement driver are doubles.
contract FailurePoolPropertiesTest is CQ11ARealFixture {
    using StateLibrary for IPoolManager;

    function _claimAll() private returns (uint256 paid) {
        uint256 coins = t.balanceOf(address(trader));
        vm.startPrank(address(trader));
        t.approve(address(box), coins);
        paid = box.claim(coins, address(trader));
        vm.stopPrank();
    }

    function test_P01_hatchBoundaryFirstFillAndMutualExclusion() public {
        _fill();
        uint256 filled = hook.closedAt();
        uint256 end = filled + 7 days;
        vm.warp(end - 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.GraduationEscapeNotReached.selector, end));
        box.fail();
        // A refused migration cannot move the hook's first-fill clock or persist graduation.
        vm.mockCallRevert(address(hook), abi.encodeWithSelector(hook.migrate.selector), "migration refused");
        vm.expectRevert();
        box.graduate();
        vm.clearMockedCalls();
        assertEq(hook.closedAt(), filled);
        assertFalse(box.graduated());
        vm.warp(end);
        vm.prank(address(0xB0B));
        box.fail();
        assertLt(end, box.deadline());
        assertEq(uint256(box.failCause()), uint256(FailCause.GraduationTimedOut));
        assertEq(pm.getLiquidity(hook.poolId()), 0);
        assertEq(hook.closedAt(), filled);
        vm.expectRevert(IBoxCoordinatorV2.AlreadyFailed.selector);
        box.graduate();
        vm.expectRevert(IBoxCoordinatorV2.AlreadyFailed.selector);
        box.fail();
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(left, t.balanceOf(address(trader)));
        assertEq(_claimAll(), pot);
    }

    function test_P02_graduationWinningAtHatchBoundaryCannotThenFail() public {
        _fill();
        vm.warp(hook.closedAt() + 7 days);
        box.graduate();
        vm.expectRevert();
        box.fail();
        vm.expectRevert();
        box.failClosed();
        assertTrue(box.graduated());
        assertFalse(box.failed());
    }

    function test_P03_deadlineLowGasDirectRefusalAndForeignUnlockRollback() public {
        _open();
        _buy(RAISE / 10);
        vm.warp(box.deadline() - 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.DeadlineNotReached.selector, box.deadline()));
        box.fail();
        vm.warp(box.deadline());
        vm.expectRevert();
        _buy(1e9);
        pm.unlock(""); // invokes the foreign-unlock check below.
        (bool ok,) = address(box).call{gas: 300_000}(abi.encodeCall(box.fail, ()));
        assertFalse(ok);
        assertFalse(box.failed());
        uint256 supply = t.totalSupply();
        uint128 liquidity = pm.getLiquidity(hook.poolId());
        vm.mockCallRevert(address(receiver), abi.encodeCall(receiver.enterFailure, ()), "receiver refused");
        vm.expectRevert();
        box.fail();
        vm.clearMockedCalls();
        assertFalse(box.failed());
        assertFalse(hook.failed());
        assertEq(t.totalSupply(), supply);
        assertEq(pm.getLiquidity(hook.poolId()), liquidity);
        box.fail();
        assertEq(uint256(box.failCause()), uint256(FailCause.Deadline));
        assertFalse(hook.closed());
        vm.expectRevert();
        _buy(1e9);
        assertFalse(hook.closed());
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm));
        (bool ok, bytes memory result) = address(box).call(abi.encodeCall(box.fail, ()));
        assertFalse(ok);
        assertEq(result, abi.encodeWithSelector(IBoxCoordinatorV2.ForeignUnlock.selector));
        return "";
    }

    function test_P04_unopenedGateTimeoutCannotBeReopenedByFinalChunk() public {
        holdGate = true;
        _make(RAISE);
        uint256 end = box.openAt() + 14 days;
        vm.warp(end - 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.GateCapNotReached.selector, end));
        box.failClosed();
        vm.warp(end);
        box.failClosed();
        box.loadChunk(ChunkPart.Texts, hex"00", bytes32(0));
        assertFalse(box.gateOpen());
        assertEq(uint256(box.failCause()), uint256(FailCause.ClosedPastCap));
    }

    function test_P05_closedPoolResidueKeepsOutsideClaimsAndProtocolFeesClaimable() public {
        _open();
        _buy(RAISE / 10);
        pm.setProtocolFeeController(address(this));
        pm.setProtocolFee(key, 1000 << 12);
        trader.trade(key, false, -int256(t.balanceOf(address(trader)) / 3), layout.sqrtPriceStartX96);
        address outside = address(0xCAFE);
        uint256 outsideClaims = t.balanceOf(address(trader)) / 7;
        trader.gift(address(t), outside, outsideClaims);
        uint256 outstanding = t.balanceOf(address(trader)) + outsideClaims;
        uint256 protocolFees = pm.protocolFeesAccrued(Currency.wrap(address(t)));
        assertGt(protocolFees, 0);
        assertEq(hook.closedTResidue(), 0);
        vm.warp(box.deadline());
        box.fail();
        (, uint256 left) = box.claimState();
        assertEq(left, outstanding + protocolFees);
        assertEq(hook.closedTResidue(), t.balanceOf(address(pm)) - outsideClaims - protocolFees);
        assertEq(pm.balanceOf(outside, uint160(address(t))), outsideClaims);
        uint256 residue = hook.closedTResidue();
        pm.collectProtocolFees(outside, Currency.wrap(address(t)), 0);
        assertEq(hook.closedTResidue(), residue, "outside fee withdrawal is not this pool's residue");
    }

    function test_P06_refusedBurnStaysInHSeparatelyFromClosedPoolResidue() public {
        _open();
        _buy(RAISE / 10);
        uint256 coins = t.balanceOf(address(trader));
        vm.mockCallRevert(address(t), abi.encodeWithSelector(t.burn.selector), "burn refused");
        vm.warp(box.deadline());
        box.fail();
        (, uint256 left) = box.claimState();
        assertEq(left, coins);
        uint256 claims = pm.balanceOf(address(hook), uint160(address(t)));
        assertGt(claims, 0);
        assertEq(hook.closedTResidue(), t.balanceOf(address(pm)) - claims);
        _claimAll();
        assertEq(_claims(address(box)), 0);
    }

    function test_P07_lateHookGiftStaysLockedAfterLastClaim() public {
        _open();
        _buy(RAISE / 10);
        vm.warp(box.deadline());
        box.fail();
        _claimAll();
        assertEq(_claims(address(box)), 0);
        trader.gift(address(p), address(hook), 7);
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(pot, 0); // keeper cannot find the 7 P from claimState alone (F03).
        assertEq(left, 0);
        uint256 fit = receiver.fitOwed();
        NoFailureSweep.check(address(box));
        assertEq(receiver.fitOwed(), fit);
        NoFailureSweep.check(address(box));
    }

    function test_P08_realNoBuyerReturnExcludesClosedResidueAndLateGifts() public {
        vm.warp(box.deadline());
        vm.mockCallRevert(address(p), abi.encodeWithSelector(p.transfer.selector, address(this)), "tip refused");
        box.fail();
        vm.clearMockedCalls();
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(left, 0);
        assertGt(pot, 0);
        assertGt(hook.closedTResidue(), 0);
        trader.gift(address(p), address(hook), 7);
        p.mint(address(router), 11);
        router.sweep();
        assertEq(box.quoteClaim(0), pot);
        NoFailureSweep.check(address(box));
        assertEq(box.claim(0, address(0xB0B)), pot);
        assertEq(_claims(address(box)), 18);
    }

    function test_P09_closedPoolAndPartCallerRules() public {
        vm.expectRevert(abi.encodeWithSelector(IBoxHookV2.NotCoordinator.selector, address(this)));
        hook.close();
        vm.expectRevert(abi.encodeWithSelector(IBoxHookV2.NotReceiver.selector, address(this)));
        hook.harvest();
        vm.expectRevert();
        receiver.enterFailure();
        // Exercise the registered callbacks as the manager would for an outside pool operation.
        ModifyLiquidityParams memory change = ModifyLiquidityParams(-100, 100, 1, bytes32(0));
        vm.startPrank(address(pm));
        vm.expectRevert(IBoxHookV2.ForeignInitialize.selector);
        hook.beforeInitialize(address(this), key, 1 << 96);
        vm.expectRevert(IBoxHookV2.LiquidityLocked.selector);
        hook.beforeAddLiquidity(address(this), key, change, "");
        vm.expectRevert(IBoxHookV2.LiquidityLocked.selector);
        hook.beforeRemoveLiquidity(address(this), key, change, "");
        vm.expectRevert(IBoxHookV2.DonationsDisabled.selector);
        hook.beforeDonate(address(this), key, 1, 1, "");
        vm.stopPrank();
        assertFalse(box.failed());
        assertFalse(hook.failed());
    }
}
