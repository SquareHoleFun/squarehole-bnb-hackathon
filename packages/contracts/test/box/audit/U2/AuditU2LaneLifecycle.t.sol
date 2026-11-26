// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {AuditU2LaneBase} from "./AuditU2LaneBase.sol";
import {CoreBox0Kit} from "../../conformance/core/CoreBox0Kit.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxLaunchRouter} from "../../../../src/box/BoxLaunchRouter.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxLaunchRouter} from "../../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

/// @notice Factory lifecycle boundary tests. The common world requires a scheduled open, so Now is created using
/// its underlying CoreBox0Kit with the same mainnet factory and fixture, without the scheduled-only assertion.
/// forge-config: default.evm_version = "osaka"
contract AuditU2LaneCreation is AuditU2LaneBase {
    function setUp() public override {
        _requireEip2537();
        vm.pauseGasMetering();
        kit = new CoreBox0Kit();
        vm.resumeGasMetering();
        kit.setUpWorld();
        pm = kit.pm();
        factory = kit.factory();
        src = kit.source();
    }

    function _createLane(uint32 open) internal {
        BoxSpecV1.BoxSpec memory s = _auditSpec();
        s.openAt = open;
        kit.prepare(s);
        vm.recordLogs();
        kit.create();
        a = kit.addresses();
        coordinator = BoxCoordinator(a.coordinator);
        hook = BoxHook(a.hook);
        launchRouter = BoxLaunchRouter(payable(a.launchRouter));
        tickets = BoxTickets(a.tickets);
        token = BoxToken(a.token);
        vault = BoxVault(a.vault);
    }

    function testProperty_AUDIT_U2_bothOpenKindsAndCreationBurnEvents() public {
        uint256 snap = vm.snapshotState();
        for (uint256 kind; kind < 2; ++kind) {
            vm.revertToState(snap);
            uint256 now_ = block.timestamp;
            uint32 requested = kind == 0 ? 0 : uint32(now_ + 1 hours);
            _createLane(requested);
            uint256 expected = kind == 0 ? now_ + 1 : requested;
            assertEq(hook.openAt(), expected);
            assertEq(launchRouter.openAt(), expected);
            assertEq(tickets.openAt(), expected);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            uint256 bought;
            uint256 burned;
            uint256 reported;
            for (uint256 i; i < logs.length; ++i) {
                Vm.Log memory l = logs[i];
                if (l.emitter == a.launchRouter && l.topics[0] == IBoxLaunchRouter.Bootstrapped.selector) {
                    (uint256 q, uint256 t) = abi.decode(l.data, (uint256, uint256));
                    assertEq(q, BoxSpecV1.BOOTSTRAP_ETH);
                    bought += t;
                }
                if (
                    l.emitter == a.token && l.topics.length == 3
                        && l.topics[0] == keccak256("Transfer(address,address,uint256)") && l.topics[2] == bytes32(0)
                ) {
                    assertEq(address(uint160(uint256(l.topics[1]))), a.coordinator);
                    burned += abi.decode(l.data, (uint256));
                }
                if (l.emitter == a.coordinator && l.topics[0] == IBoxCoordinator.BoxLaunched.selector) {
                    (uint256 open, uint256 t, uint256 q, uint256 creatorT) =
                        abi.decode(l.data, (uint256, uint256, uint256, uint256));
                    assertEq(open, expected);
                    assertEq(q, 0);
                    assertEq(creatorT, 0);
                    reported += t;
                }
            }
            assertGt(bought, 0);
            assertEq(burned, bought);
            assertEq(reported, bought);
            assertEq(token.totalBurned(), bought);
            vm.warp(expected);
            for (uint256 step; step < 32; ++step) {
                vm.warp(expected + 12 * step + 11);
                (uint256 tax,) = launchRouter.quote(1 ether);
                assertEq(tax, launchRouter.taxFor(1 ether, step));
            }
        }
    }

    /// @dev uint32 spec timestamps do not truncate the computed Now timestamp kept in the packed uint40 word.
    function testFuzz_AUDIT_U2_nowPacked40BitTime(uint40 raw) public {
        uint256 time = bound(raw, uint256(type(uint32).max) + 1, uint256(type(uint40).max) - 1);
        vm.warp(time);
        _createLane(0);
        assertEq(hook.openAt(), time + 1);
        assertEq(launchRouter.openAt(), time + 1);
        assertEq(tickets.openAt(), time + 1);
        assertTrue(launchRouter.bootstrapped());
        assertFalse(launchRouter.creatorBought());
        vm.warp(time + 1);
        (uint256 tax,) = launchRouter.quote(1 ether);
        assertEq(tax, launchRouter.taxFor(1 ether, 0));
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU2LaneLifecycle is AuditU2LaneBase {
    /// @dev Every box role tolerates forced ETH; deposits do not change the documented 15m graduation budget.
    function testFuzz_AUDIT_U2_graduateAfterUnrequestedAssets(uint96 raw, uint8 role, bool overshoot) public {
        _warpTo(hook.openAt() + 384);
        _buyTo(eoa[0], 2 * raise, overshoot ? TickMath.MIN_SQRT_PRICE + 1 : curve.sqrtPriceLowerX96);
        assertTrue(hook.closed());
        uint256 gift = bound(raw, 1, raise);
        _giftClaimsLane(gift);
        vm.prank(eoa[0]);
        token.transfer(a.coordinator, gift);
        address[12] memory roles = [
            a.coordinator,
            a.token,
            a.vault,
            a.collection,
            a.hook,
            a.receiver,
            a.launchRouter,
            a.tickets,
            a.royaltyRouter,
            a.itemStream,
            a.executor,
            a.table
        ];
        _forceEth(roles[role % 12], gift);
        vm.prank(keeper);
        coordinator.graduate{gas: 15_000_000}();
        assertTrue(coordinator.graduated());
        assertEq(_priceLane(), curve.sqrtPriceLowerX96);
        assertEq(coordinator.rewardOf(keeper), raise / 1000);
        assertEq(token.balanceOf(a.coordinator), 0);
    }

    function testProperty_AUDIT_U2_allForcedEthRolesGraduate() public {
        _closeLane();
        address[12] memory roles = [
            a.coordinator,
            a.token,
            a.vault,
            a.collection,
            a.hook,
            a.receiver,
            a.launchRouter,
            a.tickets,
            a.royaltyRouter,
            a.itemStream,
            a.executor,
            a.table
        ];
        for (uint256 i; i < roles.length; ++i) {
            _forceEth(roles[i], 1 ether);
        }
        coordinator.graduate{gas: 15_000_000}();
        assertTrue(coordinator.graduated());
        assertEq(token.balanceOf(a.coordinator), 0);
    }

    /// @dev Closed-phase swaps cannot move the price back towards P0, even for the T holder who closed it.
    function testProperty_AUDIT_U2_closedPoolCannotBeMovedBack() public {
        _closeLane();
        uint160 before = _priceLane();
        vm.expectRevert();
        // External trampoline keeps expectRevert scoped over the real swap and its helper's approval call.
        this.sellClosedLane();
        assertEq(_priceLane(), before);
        coordinator.graduate{gas: 15_000_000}();
        assertTrue(coordinator.graduated());
    }

    function sellClosedLane() external {
        _sell(eoa[0], 1 ether);
    }

    function testProperty_AUDIT_U2_graduationPackedTimestampMaximum() public {
        _closeLane();
        vm.warp(type(uint40).max);
        coordinator.graduate{gas: 15_000_000}();
        assertEq(coordinator.graduatedAt(), type(uint40).max);
        assertEq(vault.gateOpenedAt(), type(uint40).max);
        assertTrue(coordinator.graduated());
        assertEq(coordinator.hook(), a.hook);
        assertEq(coordinator.boxId(), 0);
    }

    /// @dev BC-027 unit boundaries against real claims. Impersonation removes reserve claims only to exercise
    /// held < minted, a state external users cannot create through the coordinator's public API.
    function testFuzz_AUDIT_U2_rewardClampedToClaimsHeld(uint96 raw) public {
        _closeLane();
        receiver.collect(keeper);
        uint256 minted = hook.reserveMinted();
        uint256 held = pm.balanceOf(a.coordinator, 0);
        assertEq(held, minted);
        uint256 leave = bound(raw, 0, held);
        vm.prank(a.coordinator);
        pm.transfer(eoa[1], 0, held - leave);
        vm.prank(keeper);
        uint256 reward = coordinator.graduate();
        assertEq(reward, leave);
        assertEq(coordinator.rewardOf(keeper), leave);
        assertEq(pm.balanceOf(a.coordinator, 0), leave);
    }

    /// @dev BC-027 defensive arithmetic: only reserveMinted's answer is substituted. The hook still performs its
    /// real migration and all claims are ETH-backed. Above-cap reports are unreachable from the real hook.
    function testFuzz_AUDIT_U2_rewardClampedToReportedReserveAndCap(uint96 raw) public {
        _closeLane();
        receiver.collect(keeper);
        _giftClaimsLane(raise);
        uint256 cap = coordinator.rewardCap();
        uint256 reported = bound(raw, 0, 2 * cap);
        vm.mockCall(a.hook, abi.encodeCall(IBoxHook.reserveMinted, ()), abi.encode(reported));
        vm.prank(keeper);
        uint256 reward = coordinator.graduate();
        assertEq(reward, reported < cap ? reported : cap);
        assertEq(pm.balanceOf(a.coordinator, 0), reward);
        vm.clearMockedCalls();
    }

    /// @dev BC-027: intercept the optional settlement poke, proving a gift is first unbooked next-batch fees.
    /// A reverting receiver poke is the sole stand-in; its later real settlement is restored and completed.
    function testProperty_AUDIT_U2_giftIsNextBatchBeforeSettlement() public {
        _closeLane();
        receiver.collect(keeper);
        uint256 snap = vm.snapshotState();
        vm.mockCallRevert(a.receiver, abi.encodeCall(IBoxReceiver.onGraduation, ()), "hostile optional poke");
        vm.mockCallRevert(a.itemStream, abi.encodeCall(IBoxReceiver.onGraduation, ()), "defer stream settlement");
        coordinator.graduate();
        (uint256 booked0,) = receiver.booked();
        uint256 pending0 = pm.balanceOf(a.receiver, 0) - booked0;
        vm.revertToState(snap);
        vm.clearMockedCalls();
        _giftClaimsLane(1 ether);
        vm.mockCallRevert(a.receiver, abi.encodeCall(IBoxReceiver.onGraduation, ()), "hostile optional poke");
        vm.mockCallRevert(a.itemStream, abi.encodeCall(IBoxReceiver.onGraduation, ()), "defer stream settlement");
        coordinator.graduate();
        (uint256 booked1,) = receiver.booked();
        assertEq(booked1, booked0);
        assertEq(pm.balanceOf(a.receiver, 0) - booked1, pending0 + 1 ether);
        vm.clearMockedCalls();
        receiver.onGraduation();
        assertTrue(receiver.graduationSettled());
    }
}
