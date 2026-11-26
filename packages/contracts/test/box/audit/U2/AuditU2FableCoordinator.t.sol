// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxHook, IBoxPriceAverage} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxItemStream} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxLaunchRouter} from "../../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {TransientReentrancyGuard} from "../../../../src/libraries/TransientReentrancyGuard.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";
import {CoreImpls} from "../../conformance/core/CoreBox0Kit.sol";
import {AuditActor} from "../common/AuditActors.sol";
import {EthIn, EthOut, TIn} from "../common/AuditGhostLedger.sol";
import {AuditU2FableBase, AuditU2FableForeignUnlocker, AuditU2FableHostilePoke} from "./AuditU2FableBase.sol";

/// @notice TEST ONLY (SH-AUDIT-B0-U2-F). A reward recipient whose `receive` re-enters the coordinator, the router and
/// the receiver while the PoolManager pays it the reward (inside the coordinator's own unlock).
contract AuditU2FableReentrantRecipient {
    event Reentry(bytes4 call, bool ok, bytes4 err);

    address public immutable coordinator;
    address public immutable router;
    address public immutable receiverAddr;

    constructor(address coordinator_, address router_, address receiver_) {
        coordinator = coordinator_;
        router = router_;
        receiverAddr = receiver_;
    }

    function claim() external returns (uint256) {
        return IBoxCoordinator(coordinator).claimReward(address(this));
    }

    function graduate() external returns (uint256) {
        return IBoxCoordinator(coordinator).graduate();
    }

    receive() external payable {
        _try(coordinator, abi.encodeCall(IBoxCoordinator.claimReward, (address(this))));
        _try(coordinator, abi.encodeCall(IBoxCoordinator.graduate, ()));
        _try(router, abi.encodeCall(IBoxLaunchRouter.sweep, ()));
        _try(receiverAddr, abi.encodeCall(IBoxReceiver.collect, (address(this))));
    }

    function _try(address target, bytes memory data) private {
        (bool ok, bytes memory ret) = target.call(data);
        emit Reentry(bytes4(data), ok, ret.length >= 4 ? bytes4(ret) : bytes4(0));
    }
}

/// @title AuditU2FableCoordinatorTest
/// @notice SH-AUDIT-B0-U2-F, the coordinator on the factory's box 0 (mainnet build, Osaka): L1 the reward and third-
/// party gifts of Q claims and T (P2.3, P2.4), what the coordinator holds (IBoxCoordinator.sol:24-25), L2 the caller
/// rules (P2.7, P2.17), L3 the callbacks and re-entry (P2.8), L5 nothing a third party does blocks graduation (P2.12),
/// L7 the cap and the packed words (P2.16), L8 the planned nonces (P2.17). `AuditU2FableCoordinatorAmsterdamTest`
/// runs the same under Amsterdam.
/// forge-config: default.evm_version = "osaka"
contract AuditU2FableCoordinatorTest is AuditU2FableBase {
    bytes4 internal constant NO_CREATOR_BUY = bytes4(keccak256("NoCreatorBuy()"));

    // ============================================================================================ L1 the reward

    /// P2.3 / BC-027 / D6 / F75 W2: at a real close the hook minted the reserve to the cap (0.1% of R) from the
    /// curve's Q fees; `graduate()` credits min(minted, cap, held) to its caller as a claim; Q claims a third party
    /// transferred to the coordinator before graduation never raise it and go to the receiver as next-batch fees
    /// (`ClaimsForwarded`), so nothing is stuck; after the claim the coordinator holds no Q claims at all.
    function testProperty_AUDIT_U2_rewardIsMinOfReserveCapAndHeldAndGiftsAreForwarded() public {
        _toClosed();
        uint256 cap = coordinator.rewardCap();
        assertEq(cap, raise * BoxSpecV1.GRADUATION_REWARD_CAP_BPS / 10_000);
        assertEq(hook.reserveMinted(), cap, "a real close pays at least 1% of R in fees: the reserve is full");
        assertEq(_claims(a.coordinator), cap, "the coordinator holds exactly the reserve");
        assertEq(coordinator.reserve(), cap);
        _giftClaims(a.coordinator, 0.5 ether);
        assertEq(_claims(a.coordinator), cap + 0.5 ether);
        assertEq(coordinator.reserve(), cap, "reserve() is min(minted, held): a gift does not raise it");
        uint256 inside0 = _claims(a.receiver) + _claims(a.hook);
        (uint256 reward, uint256 failures, Migrated memory m, uint256 forwarded) = _graduateMeasured(eoa[3]);
        assertEq(failures, 0);
        assertTrue(m.seen);
        assertEq(reward, cap, "credited exactly the cap");
        assertEq(coordinator.rewardOf(eoa[3]), cap);
        assertEq(coordinator.rewardOf(keeper), 0);
        assertEq(forwarded, 0.5 ether, "the gift went to the receiver");
        // The receiver's settlement poke ran in the same call and moved its depth parts to the hook: the gift is in
        // the receiver's ledgers or the hook's depth budget, plus the migration's dust and last fees.
        assertGe(_claims(a.receiver) + _claims(a.hook), inside0 + 0.5 ether + m.qDust, "the gift stayed inside");
        assertEq(_claims(a.coordinator), cap, "the coordinator keeps only the credited reward");
        assertEq(coordinator.reserve(), 0, "0 once credited");
        assertEq(_claimReward(eoa[3], eoa[3]), cap);
        assertEq(_claims(a.coordinator), 0);
        assertEq(coordinator.rewardOf(eoa[3]), 0);
        _assertGhostLedger();
    }

    /// P2.3 / BC-027: a `collect()` just before `graduate()` (a searcher's front-run) cannot empty the reward: the
    /// reserve was set aside before every split; the reward is still the cap.
    function testProperty_AUDIT_U2_collectBeforeGraduationCannotEmptyTheReward() public {
        _toClosed();
        _collect(eoa[5], eoa[5]);
        assertEq(hook.reserveMinted(), coordinator.rewardCap());
        (uint256 reward,,,) = _graduateMeasured(keeper);
        assertEq(reward, coordinator.rewardCap());
        _assertGhostLedger();
    }

    /// P2.16 / BC-027 / BoxSpecV1.sol:94: the cap is 0.1% of the active build's raise, the same number in the
    /// coordinator and the hook; the reserve never exceeds it in any phase.
    function testProperty_AUDIT_U2_rewardCapIsPointOnePercentOfTheActiveBuildsRaise() public {
        uint256 cap = BoxBuildV1.RAISE * 10 / 10_000;
        assertEq(coordinator.rewardCap(), cap);
        assertEq(hook.reserveCap(), cap);
        assertEq(coordinator.raise(), BoxBuildV1.RAISE);
        if (!BoxBuildV1.REHEARSAL) assertEq(cap, 4_206_980_085_000_000, "mainnet: 0.004206980085 ETH");
        assertLe(hook.reserveMinted(), cap);
        _toWindow();
        assertLe(hook.reserveMinted(), cap);
        _toBonding();
        assertEq(hook.reserveMinted(), cap, "the first batch topped the reserve up to the cap");
        _toClosed();
        assertEq(hook.reserveMinted(), cap);
        assertEq(_claims(a.coordinator), cap);
    }

    /// IBoxCoordinator.sol:24-25 / BC-026 / BC-027: before graduation the coordinator holds the pool share (T) and the
    /// reserve (Q claims) and nothing else: no ETH, no T claims; after graduation no T and only the credited reward;
    /// after the claim nothing.
    function testProperty_AUDIT_U2_coordinatorHoldsOnlyItsShareAndReserve() public {
        uint256 share = token.balanceOf(a.coordinator);
        assertEq(share, coordinator.poolShare());
        assertEq(share, BoxSpecV1.ISSUANCE - curve.curveT, "the issuance less the curve's T");
        assertEq(
            token.balanceOf(address(pm)), curve.curveT - token.totalBurned(), "the curve less the bootstrap's burn"
        );
        _holdsOnly(share, 0);
        _toWindow();
        _holdsOnly(share, 0);
        _toBonding();
        _holdsOnly(share, hook.reserveMinted());
        _toClosed();
        _holdsOnly(share, hook.reserveMinted());
        (uint256 reward,,,) = _graduateMeasured(keeper);
        assertEq(coordinator.poolShare(), 0, "0 once graduated");
        _holdsOnly(0, reward);
        _claimReward(keeper, eoa[0]);
        _holdsOnly(0, 0);
        _assertGhostLedger();
    }

    function _holdsOnly(uint256 t, uint256 q) internal view {
        assertEq(token.balanceOf(a.coordinator), t, "T held");
        assertEq(_claims(a.coordinator), q, "Q claims held");
        assertEq(_tClaims(a.coordinator), 0, "no T claims");
        assertEq(a.coordinator.balance, 0, "no ETH");
    }

    // ============================================================================================ L1 gifts of T

    /// P2.4 / BC-043 / IBoxCoordinator.sol:14: T sent to the coordinator before graduation joins the pool share: the
    /// whole balance is handed to `hook.migrate`, the ask takes it (its liquidity rises against the no-gift
    /// graduation of the same state), R is unchanged, the dust is burned, nothing is stuck and graduation passes.
    function testProperty_AUDIT_U2_giftedTJoinsTheAskAndIsBurnedWithTheDust() public {
        _toClosed();
        uint256 share = token.balanceOf(a.coordinator);
        uint256 snap = vm.snapshotState();
        (,, Migrated memory m0,) = _graduateMeasured(keeper);
        vm.revertToState(snap);
        uint256 gift = token.balanceOf(eoa[2]) / 2;
        _transferT(eoa[2], a.coordinator, gift);
        assertEq(coordinator.poolShare(), share + gift, "the gift joined the share");
        uint256 pm0 = address(pm).balance;
        (, uint256 failures, Migrated memory m,) = _graduateMeasured(keeper);
        assertEq(failures, 0);
        assertEq(m.sharePassed, share + gift, "the whole balance went to migrate");
        assertEq(m.qFromCurve, m0.qFromCurve, "R is what it was");
        assertGt(m.askLiquidity, m0.askLiquidity, "the ask grew");
        assertGe(m.bidLiquidity, m0.bidLiquidity, "the bid never shrinks");
        assertEq(m.tokenPulled + m.dustBurned, share + gift, "pulled into the ask or burned");
        assertEq(token.balanceOf(a.coordinator), 0, "nothing stuck");
        assertEq(address(pm).balance, pm0, "no ETH moved");
        (uint128 askL,,) = hook.graduatedLayout();
        assertEq(askL, m.askLiquidity);
        assertEq(token.totalSupply() + token.totalBurned(), BoxSpecV1.ISSUANCE);
        _assertGhostLedger();
    }

    /// P2.4 / P2.12: a gift of every outside holder's whole T (the largest gift possible) still graduates: the bid is
    /// capped by R and the sentinel may end empty, but nothing reverts and the T is in the ask or burned.
    function testProperty_AUDIT_U2_aGiftOfAllOutsideTStillGraduates() public {
        _toClosed();
        address[8] memory holders = [eoa[0], eoa[1], eoa[2], eoa[3], eoa[4], eoa[5], address(contractDrawer), eoa7702];
        uint256 gifted;
        for (uint256 i; i < holders.length; ++i) {
            uint256 bal = token.balanceOf(holders[i]);
            if (bal == 0) continue;
            _transferT(holders[i], a.coordinator, bal);
            gifted += bal;
        }
        assertGt(gifted, curve.curveT / 2, "most of the curve's T came back as a gift");
        (, uint256 failures, Migrated memory m,) = _graduateMeasured(keeper);
        assertEq(failures, 0);
        assertTrue(coordinator.graduated());
        assertEq(token.balanceOf(a.coordinator), 0);
        assertEq(m.tokenPulled + m.dustBurned, m.sharePassed);
        assertEq(_sqrtPrice(), curve.sqrtPriceLowerX96, "the price is P1");
        _assertGhostLedger();
    }

    /// BC-029 with gifts: a gift of T to the coordinator before graduation deepens the full-range bid (up to all of R),
    /// so the question is whether the closer can lower the round trip's cost (fill to P1, graduate, sell back) by
    /// gifting part of its T first. It cannot: for gifts of 10%, 50%, 90% and 99% of the closer's T the net cost is
    /// never below the no-gift cost, which stays above BC-029's 0.670 ETH bound at this fill.
    function testProperty_AUDIT_U2_giftedTNeverLowersTheRoundTripCost() public {
        _toWindow();
        _warpTo(hook.windowEndsAt());
        uint256 base = _roundTrip(0);
        assertGt(base, 0.67 ether, "BC-029: the round trip from a thin fill costs more than 0.670 ETH");
        uint16[4] memory pct = [uint16(1_000), 5_000, 9_000, 9_900];
        for (uint256 i; i < 4; ++i) {
            uint256 cost = _roundTrip(pct[i]);
            assertGe(cost, base, "a gift never lowers the round trip's cost");
        }
    }

    /// The closer (eoa[5]) fills the curve to P1, gifts `giftBps` of its T to the coordinator, graduates and sells all
    /// its T back; returns its net ETH cost. Run from a snapshot of the current state.
    function _roundTrip(uint256 giftBps) internal returns (uint256 cost) {
        uint256 snap = vm.snapshotState();
        address closer = eoa[5];
        // `_buyTo` funds the closer with 3 x R itself: count it as the closer's own capital.
        uint256 before = closer.balance + 3 * raise;
        _buyTo(closer, 3 * raise, curve.sqrtPriceLowerX96);
        require(hook.closed(), "round trip: closed");
        uint256 held = token.balanceOf(closer);
        if (giftBps != 0) _transferT(closer, a.coordinator, held * giftBps / 10_000);
        _graduate(closer);
        _claimReward(closer, closer);
        _sell(closer, token.balanceOf(closer));
        uint256 after_ = closer.balance;
        cost = before > after_ ? before - after_ : 0;
        emit log_named_uint("round trip cost (wei) with gift bps", giftBps);
        emit log_named_uint("  cost", cost);
        _assertGhostLedger();
        vm.revertToState(snap);
    }

    // ============================================================================================ L2 callers

    /// P2.7 / P2.17 / BC-026 / BC-100: `deploy` and `launch` only by the factory and only once (a second call by the
    /// factory itself is refused); `graduate` by anyone, only after the close, once; the implementation itself is never
    /// a box.
    function testProperty_AUDIT_U2_coordinatorCallerRules() public {
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinator.NotFactory.selector, eoa[0]));
        coordinator.launch();
        vm.prank(address(factory));
        vm.expectRevert(IBoxCoordinator.AlreadyLaunched.selector);
        coordinator.launch();
        bytes[] memory codes = new bytes[](1);
        codes[0] = hex"00";
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinator.NotFactory.selector, eoa[0]));
        coordinator.deploy(codes, hex"00", bytes32(0), 0);
        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("AlreadyDeployed()"))));
        coordinator.deploy(codes, hex"00", bytes32(0), 0);
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxCoordinator.NotClosed.selector);
        coordinator.graduate();
        _toWindow();
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxCoordinator.NotClosed.selector);
        coordinator.graduate();
        _toBonding();
        vm.prank(address(contractDrawer));
        vm.expectRevert(IBoxCoordinator.NotClosed.selector);
        coordinator.graduate();
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxCoordinator.NothingToClaim.selector);
        coordinator.claimReward(eoa[0]);
        _toClosed();
        assertEq(uint8(coordinator.phase()), uint8(BoxPhase.Closed));
        (uint256 reward, uint256 failures,,) = _graduateMeasured(address(contractDrawer));
        assertEq(failures, 0);
        assertEq(reward, coordinator.rewardCap());
        assertTrue(coordinator.graduated());
        assertEq(uint8(coordinator.phase()), uint8(BoxPhase.Graduated));
        assertEq(coordinator.graduatedAt(), vm.getBlockTimestamp());
        assertEq(coordinator.graduatedAtBlock(), vm.getBlockNumber());
        assertEq(coordinator.graduatedAtBlock(), hook.migratedAtBlock());
        vm.prank(eoa[1]);
        vm.expectRevert(IBoxCoordinator.AlreadyGraduated.selector);
        coordinator.graduate();
        vm.prank(address(contractDrawer));
        vm.expectRevert(IBoxCoordinator.AlreadyGraduated.selector);
        coordinator.graduate();
        // The implementation: launched and deployed from its constructor, graduate reverts on its non-hook.
        IBoxCoordinator impl = IBoxCoordinator(kit.impls().coordinator);
        assertFalse(impl.graduated());
        vm.prank(address(factory));
        vm.expectRevert(IBoxCoordinator.AlreadyLaunched.selector);
        impl.launch();
        vm.expectRevert();
        impl.graduate();
    }

    /// P2.7 / BC-026: the closing block itself graduates (no block wait), by a caller other than the closer.
    function testProperty_AUDIT_U2_graduateInTheClosingBlock() public {
        _toClosed();
        assertEq(hook.closedAtBlock(), vm.getBlockNumber(), "same block as the close");
        (uint256 reward, uint256 failures,,) = _graduateMeasured(eoa7702);
        assertEq(failures, 0);
        assertEq(reward, coordinator.rewardCap());
        assertEq(coordinator.rewardOf(eoa7702), reward);
        _assertGhostLedger();
    }

    /// P2.7: `claimReward` is the credited graduator's only, to any non-zero address; a recipient that refuses Q, one
    /// that uses all gas, the receiver (it takes ETH only inside its own guarded calls) and the PoolManager (no receive)
    /// each make the claim fail as a whole and the claim stays; a box address that accepts (the royalty router) keeps
    /// the ETH inside; an EIP-7702 payer receives it (the PoolManager's native transfer sends all gas); a second claim
    /// is refused.
    function testProperty_AUDIT_U2_claimRewardRules() public {
        _toClosed();
        (uint256 reward,,,) = _graduateMeasured(keeper);
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxCoordinator.NothingToClaim.selector);
        coordinator.claimReward(eoa[0]);
        vm.prank(keeper);
        vm.expectRevert(IBoxCoordinator.ZeroAddress.selector);
        coordinator.claimReward(address(0));
        address[4] memory refusers = [address(ethRefuser), address(gasBurner), a.receiver, address(pm)];
        for (uint256 i; i < 4; ++i) {
            vm.prank(keeper);
            (bool ok, bytes memory err) =
                a.coordinator.call{gas: 30_000_000}(abi.encodeCall(IBoxCoordinator.claimReward, (refusers[i])));
            assertFalse(ok, "a refusing recipient fails the claim");
            assertEq(_selector(err), IBoxCoordinator.ClaimFailed.selector);
            assertEq(coordinator.rewardOf(keeper), reward, "the claim stays");
            assertEq(_claims(a.coordinator), reward);
        }
        uint256 snap = vm.snapshotState();
        assertEq(_claimReward(keeper, a.royaltyRouter), reward, "a box address that accepts: inside");
        assertEq(a.royaltyRouter.balance, reward);
        _assertGhostLedger();
        vm.revertToState(snap);
        uint256 e0 = eoa7702.balance;
        assertEq(_claimReward(keeper, eoa7702), reward);
        assertEq(eoa7702.balance, e0 + reward, "the 7702 account received the reward");
        emit log_named_string("evm", vm.getEvmVersion());
        vm.prank(keeper);
        vm.expectRevert(IBoxCoordinator.NothingToClaim.selector);
        coordinator.claimReward(keeper);
        assertEq(coordinator.rewardOf(keeper), 0);
        assertEq(_claims(a.coordinator), 0);
        _assertGhostLedger();
    }

    // ============================================================================================ L3 callbacks

    /// P2.8: the coordinator's and the router's `unlockCallback` act only inside that contract's own guarded unlock: a
    /// direct call, a call by the PoolManager outside such a call (pranked), and a call from inside a stranger's
    /// unlock all revert NotPoolManager and move nothing.
    function testProperty_AUDIT_U2_unlockCallbacksOnlyInsideTheirOwnUnlock() public {
        _toClosed();
        _graduate(keeper);
        bytes memory claim = abi.encode(eoa[0], coordinator.rewardOf(keeper));
        bytes memory sweepData = abi.encode(uint8(2), abi.encode(uint256(1), a.hook));
        uint256 c0 = _claims(a.coordinator);
        uint256 e0 = eoa[0].balance;
        vm.expectRevert(IBoxCoordinator.NotPoolManager.selector);
        coordinator.unlockCallback(claim);
        vm.prank(address(pm));
        vm.expectRevert(IBoxCoordinator.NotPoolManager.selector);
        coordinator.unlockCallback(claim);
        vm.expectRevert(IBoxLaunchRouter.NotPoolManager.selector);
        launchRouter.unlockCallback(sweepData);
        vm.prank(address(pm));
        vm.expectRevert(IBoxLaunchRouter.NotPoolManager.selector);
        launchRouter.unlockCallback(sweepData);
        AuditU2FableForeignUnlocker stranger = new AuditU2FableForeignUnlocker(pm);
        stranger.run(a.coordinator, claim);
        assertEq(_selector(stranger.lastError()), IBoxCoordinator.NotPoolManager.selector);
        stranger.run(a.launchRouter, sweepData);
        assertEq(_selector(stranger.lastError()), IBoxLaunchRouter.NotPoolManager.selector);
        assertEq(_claims(a.coordinator), c0, "no claim burned");
        assertEq(eoa[0].balance, e0, "nothing paid");
        assertEq(coordinator.rewardOf(keeper), c0);
    }

    /// P2.9 / L3: a reward recipient that re-enters while the PoolManager pays it: `claimReward` and `graduate` meet
    /// the lock, `sweep` meets the PoolManager's own lock (AlreadyUnlocked) and `collect` the hook's ForeignUnlock
    /// guard; the claim itself completes once and the reward arrives.
    function testProperty_AUDIT_U2_rewardRecipientCannotReenter() public {
        _toClosed();
        AuditU2FableReentrantRecipient r = new AuditU2FableReentrantRecipient(a.coordinator, a.launchRouter, a.receiver);
        _ghostAddOutside(address(r));
        uint256 reward = r.graduate();
        assertEq(coordinator.rewardOf(address(r)), reward);
        vm.recordLogs();
        assertEq(r.claim(), reward);
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(r)) continue;
            (bytes4 call_, bool ok, bytes4 err) = abi.decode(logs[i].data, (bytes4, bool, bytes4));
            ++n;
            assertFalse(ok, "every re-entry refused");
            if (call_ == IBoxCoordinator.claimReward.selector || call_ == IBoxCoordinator.graduate.selector) {
                assertEq(err, TransientReentrancyGuard.Reentrancy.selector);
            } else if (call_ == IBoxLaunchRouter.sweep.selector) {
                assertEq(err, IPoolManager.AlreadyUnlocked.selector);
            } else {
                assertEq(err, IBoxHook.ForeignUnlock.selector);
            }
        }
        assertEq(n, 4);
        assertEq(address(r).balance, reward);
        assertEq(coordinator.rewardOf(address(r)), 0);
        _noteEthOut(EthOut.Reward, reward);
        _assertGhostLedger();
    }

    // ============================================================================================ L5 liveness

    /// P2.12 / BC-098: once the curve is closed no third party can keep `graduate()` from succeeding at the documented
    /// gas: after Q claims and T are sent to the coordinator and ETH is forced into every box contract, graduation
    /// passes with no failed poke at the least gas of the undisturbed state plus the forwarding transfer's cost, and
    /// at an ample cap; nothing a third party did changed the reward.
    function testProperty_AUDIT_U2_thirdPartyActionsNeverBlockGraduation() public {
        _toClosed();
        uint256 least0 = _leastGraduate(keeper, 15_000_000, 0);
        emit log_named_uint("least gas to graduate, undisturbed (real pokes)", least0);
        _giftClaims(a.coordinator, 1 ether);
        _transferT(eoa[2], a.coordinator, token.balanceOf(eoa[2]));
        _transferT(eoa[0], a.coordinator, token.balanceOf(eoa[0]) / 3);
        address[10] memory targets = [
            a.coordinator,
            a.hook,
            a.launchRouter,
            a.receiver,
            a.executor,
            a.tickets,
            a.itemStream,
            a.vault,
            a.collection,
            address(pm)
        ];
        for (uint256 i; i < targets.length; ++i) {
            _forceEth(targets[i], 0.25 ether);
        }
        uint256 least1 = _leastGraduate(keeper, 15_000_000, 0);
        emit log_named_uint("least gas to graduate, after the gifts and forced ETH", least1);
        assertLe(least1, least0 + 60_000, "at most the claims transfer's cost more");
        Probe memory at = _probe(keeper, least1, 0);
        assertTrue(at.ok);
        assertEq(at.pokeFailed, 0, "every poke ran at the least gas");
        (uint256 reward, uint256 failures,,) = _graduateMeasured(keeper);
        assertEq(failures, 0);
        assertEq(reward, coordinator.rewardCap(), "the reward is unchanged");
        assertEq(token.balanceOf(a.coordinator), 0);
        assertEq(_claims(a.coordinator), reward);
        _assertGhostLedger();
    }

    /// P2.12 / BC-025: a close that overshoots P1 (an exact-input buy to the far limit: the price runs past P1 across
    /// empty ticks) graduates too; `migrate` walks the price back to exactly P1 and the reward is the cap.
    function testProperty_AUDIT_U2_overshootCloseGraduatesAndWalksBackToP1() public {
        _toBonding();
        _buy(eoa[2], 3 * raise);
        assertTrue(hook.closed());
        assertLt(_sqrtPrice(), curve.sqrtPriceLowerX96, "overshot past P1");
        uint256 least = _leastGraduate(keeper, 15_000_000, 0);
        emit log_named_uint("least gas to graduate after an overshoot", least);
        (uint256 reward, uint256 failures, Migrated memory m,) = _graduateMeasured(keeper);
        assertEq(failures, 0);
        assertEq(reward, coordinator.rewardCap());
        assertEq(_sqrtPrice(), curve.sqrtPriceLowerX96, "back to exactly P1");
        assertLe(raise - m.qFromCurve, 2);
        _assertGhostLedger();
    }

    /// F126 / M28 / BC-098: the stream baseline (`streamStartBalance`, `streamStartClaims`) is written before any poke,
    /// from T and the PoolManager alone, so even four failing pokes leave graduation, the gate and the reward
    /// committed with the baseline in place; once the targets work again anyone repeats each poke (M21).
    function testProperty_AUDIT_U2_baselineIsRecordedBeforeThePokesAndFailedPokesAreRepeatable() public {
        _toClosed();
        address[4] memory t = _pokeTargets();
        bytes[4] memory saved;
        for (uint256 i; i < 4; ++i) {
            saved[i] = t[i].code;
        }
        _etchPokeTargets(_hostileCode(AuditU2FableHostilePoke.Mode.Revert));
        uint256 streamT = token.balanceOf(a.itemStream);
        uint256 receiverTClaims = _tClaims(a.receiver);
        (uint256 reward, uint256 failures,,) = _graduateMeasured(keeper);
        assertEq(failures, 4, "every poke failed");
        assertTrue(coordinator.graduated());
        assertTrue(vault.gateOpen());
        assertEq(coordinator.rewardOf(keeper), reward);
        assertEq(coordinator.streamStartBalance(), streamT, "the stream's T at graduation");
        assertGe(
            coordinator.streamStartClaims(), receiverTClaims, "the receiver's T claims after the migration's harvest"
        );
        for (uint256 i; i < 4; ++i) {
            vm.etch(t[i], saved[i]);
        }
        vm.prank(eoa[4]);
        receiver.onGraduation();
        assertTrue(receiver.graduationSettled());
        vm.prank(eoa[4]);
        stream.onGraduation();
        assertTrue(stream.started());
        vm.prank(eoa[4]);
        tickets.requestGraduationWord();
        assertGt(tickets.status().wordRequestedAt, 0);
        vm.prank(eoa[4]);
        executor.poke();
        _assertGhostLedger();
    }

    // ============================================================================================ L7 packed words

    /// P2.16: `_w` holds the graduation timestamp in 40 bits: a graduation at 2^40 - 1 is recorded exactly, the box
    /// is graduated, and the claim works. (At 2^40 the field would wrap to 0: outside the stated lifetime, year
    /// 36,812; observed and recorded in the evidence, not a finding.)
    function testProperty_AUDIT_U2_packedWordsHoldTimestampsBelow2Pow40() public {
        _toClosed();
        uint256 snap = vm.snapshotState();
        vm.warp((1 << 40) - 1);
        (uint256 reward,,,) = _graduateMeasured(keeper);
        assertEq(coordinator.graduatedAt(), (1 << 40) - 1);
        assertTrue(coordinator.graduated());
        assertEq(uint8(coordinator.phase()), uint8(BoxPhase.Graduated));
        assertEq(coordinator.rewardOf(keeper), reward);
        assertEq(_claimReward(keeper, keeper), reward);
        vm.revertToState(snap);
        vm.warp(1 << 40);
        _graduateMeasured(keeper);
        assertEq(coordinator.graduatedAt(), 0, "observed: the 40-bit field wraps at 2^40 (beyond the stated bound)");
        assertTrue(hook.migratedAtBlock() != 0, "the hook migrated regardless");
    }

    // ============================================================================================ L8 deployment

    /// P2.17 / BC-012 (this unit's part): `deploy` CREATEd each role at the planned nonce of the coordinator's own
    /// address (token 1 … executor 9, each once), CREATE2'd the hook at the mined salt over the factory's init-code
    /// hash, every clone is a clone of the version's implementation, and the coordinator sits at the factory's fixed
    /// box 0 address.
    function testProperty_AUDIT_U2_deployCreatedThePlannedCodesAtThePlannedNonces() public view {
        assertEq(a.coordinator, factory.box0Addresses().coordinator);
        assertEq(coordinator.factory(), address(factory));
        assertEq(coordinator.boxId(), 0);
        address[9] memory roles = [
            a.token,
            a.vault,
            a.collection,
            a.receiver,
            a.launchRouter,
            a.tickets,
            a.royaltyRouter,
            a.itemStream,
            a.executor
        ];
        uint256 seen;
        for (uint8 r = 0; r < 9; ++r) {
            uint256 nonce = coordinator.nonceOf(r);
            assertTrue(nonce >= 1 && nonce <= 10, "a nonce in 1..10 (the ten codes: nine roles and the table)");
            assertEq(seen & (1 << nonce), 0, "each nonce once");
            seen |= 1 << nonce;
            assertEq(vm.computeCreateAddress(a.coordinator, nonce), roles[r], "the role lives at its planned nonce");
            assertGt(roles[r].code.length, 0);
        }
        // The tenth code is the metadata table (no role): it took the one nonce the roles left.
        uint256 tableNonce;
        for (uint256 n = 1; n <= 10; ++n) {
            if (vm.computeCreateAddress(a.coordinator, n) == a.table) tableNonce = n;
        }
        assertGt(tableNonce, 0, "the table at a nonce of the coordinator");
        assertEq(seen | (1 << tableNonce), 0x7FE, "nonces 1..10, each exactly once");
        assertEq(coordinator.nonceOf(9), 0, "no tenth role");
        assertEq(coordinator.token(), a.token);
        assertEq(coordinator.vault(), a.vault);
        assertEq(coordinator.collection(), a.collection);
        assertEq(coordinator.receiver(), a.receiver);
        assertEq(coordinator.launchRouter(), a.launchRouter);
        assertEq(coordinator.tickets(), a.tickets);
        assertEq(coordinator.royaltyRouter(), a.royaltyRouter);
        assertEq(coordinator.itemStream(), a.itemStream);
        assertEq(coordinator.executor(), a.executor);
        assertEq(coordinator.hook(), a.hook);
        bytes32 initHash = factory.hookInitCodeHash(uint32(hook.openAt()));
        assertEq(
            vm.computeCreate2Address(kit.hookSalt(), initHash, a.coordinator), a.hook, "the hook at its mined salt"
        );
        CoreImpls memory impls = kit.impls();
        assertTrue(BoxClones.isCloneOf(a.coordinator, impls.coordinator), "coordinator clone");
        assertTrue(BoxClones.isCloneOf(a.hook, impls.hook), "hook clone");
        assertTrue(BoxClones.isCloneOf(a.launchRouter, impls.launchRouter), "launch router clone");
        assertTrue(BoxClones.isCloneOf(a.receiver, impls.receiver), "receiver clone");
        assertTrue(BoxClones.isCloneOf(a.vault, impls.vault), "vault clone");
        assertTrue(BoxClones.isCloneOf(a.collection, impls.collection), "collection clone");
        assertTrue(BoxClones.isCloneOf(a.tickets, impls.tickets), "tickets clone");
        assertTrue(
            BoxClones.isReceivingCloneOf(a.royaltyRouter, impls.royaltyRouter), "royalty router: a receiving clone"
        );
        assertTrue(BoxClones.isCloneOf(a.itemStream, impls.itemStream), "item stream clone");
        assertFalse(BoxClones.isCloneOf(a.token, impls.coordinator), "T is a full contract, not a clone");
        assertEq(token.initialHolder(), a.coordinator);
        assertEq(coordinator.randomness(), address(src));
        assertEq(coordinator.poolManager(), address(pm));
    }

    // ============================================================================================ proof tests

    // W2-U2-2, accepted as built (FQ-17, R66-GIFT, F147): gifted T joins the ask; BC-027/029/067 now say so.
    /// @notice PROOF TEST (severity: Note; passes while the texts and the code disagree).
    /// Property and sources: BC-027's "then" (docs/design/launch-pipeline/conformance-cases.json): "the graduated
    /// positions hold exactly R and the pool share (ask, full-range bid and bid sentinel, BC-067)"; U2.md P2.4: "T
    /// sent to the coordinator by anyone before graduation does not change the `tokenBudget` handed to
    /// `hook.migrate` (the planned pool share)".
    /// Expected (by those texts): the ask holds the pool share, whatever T third parties sent to the coordinator.
    /// Observed: BoxCoordinator.sol:253-256 hands `t.balanceOf(address(this))`, the pool share plus every gift, to
    /// `hook.migrate`; BoxHookExtension.sol:208-223 sizes the ask from that whole amount, so the ask holds the pool
    /// share plus the gift (less rounding dust), and the full-range bid, capped by the ask's liquidity, deepens with it
    /// up to all of R (the sentinel then empty). IBoxCoordinator.sol:14 and BC-043 say the gift "joins" the share, so
    /// the project's own texts disagree with each other; no value leaks and graduation always passes
    /// (`testProperty_AUDIT_U2_giftedTJoinsTheAskAndIsBurnedWithTheDust`, `testFuzz_AUDIT_U2_giftedTNeverBlocksGraduation`).
    /// Steps: close the curve (the world's `_toClosed`); eoa[2] sends half its T to the coordinator; `graduate()`.
    /// Amounts (mainnet build): pool share 201,862,030,679,196,583,428,034,117 raw T; gift 98,687,920,347,402,235,043,966,774
    /// raw T (half of eoa[2]'s 1.97e26); the ask takes share + gift less dust below 1e6 raw; R unchanged.
    function testAccepted_AUDIT_U2_25_giftedTEnlargesTheAskBeyondBC027sExactPoolShare() public {
        _toClosed();
        uint256 share = token.balanceOf(a.coordinator);
        uint256 gift = token.balanceOf(eoa[2]) / 2;
        _transferT(eoa[2], a.coordinator, gift);
        (, uint256 failures, Migrated memory m,) = _graduateMeasured(keeper);
        assertEq(failures, 0);
        uint256 askAmount = m.tokenPulled + m.tFromCurve;
        assertEq(m.sharePassed, share + gift, "observed: the whole balance, gift included, went to migrate");
        assertGt(askAmount, share, "observed: the ask holds more than the pool share");
        assertGe(askAmount + 1e6, share + gift, "the gift is in the ask, less rounding dust");
        assertEq(m.dustBurned, share + gift - m.tokenPulled, "the rest burned");
        assertLe(raise - m.qFromCurve, 2, "R unchanged");
        _assertGhostLedger();
    }
}

/// The same under Amsterdam.
/// forge-config: default.evm_version = "amsterdam"
contract AuditU2FableCoordinatorAmsterdamTest is AuditU2FableCoordinatorTest {}

/// @notice L8: ETH forced onto every predicted box address (1 ETH each, the hook included) before the creation
/// transaction changes nothing: the box is created at the same addresses, the window buys conserve with the router's
/// forced ETH, graduation passes, `sweep()` moves the tax plus the router's forced ETH, the coordinator's forced ETH
/// stays where it was (no exit, the accepted M25 class) and T's identity holds.
/// forge-config: default.evm_version = "osaka"
contract AuditU2FablePrefundedTest is AuditU2FableBase {
    uint256 internal constant PREFUND = 1 ether;

    function setUp() public override {
        _setUpAuditWorldVariant(false, PREFUND);
    }

    function testProperty_AUDIT_U2_prefundedPredictedAddressesChangeNothing() public {
        assertEq(a.coordinator, factory.box0Addresses().coordinator);
        assertEq(a.coordinator.balance, PREFUND);
        assertEq(a.launchRouter.balance, PREFUND);
        assertEq(a.hook.balance, PREFUND);
        assertEq(a.token.balance, PREFUND);
        assertEq(token.balanceOf(address(kit)), 0, "the bootstrap's T was burned");
        assertEq(address(pm).balance, BoxSpecV1.BOOTSTRAP_ETH, "the pool holds the bootstrap only");
        _toWindow();
        assertEq(a.launchRouter.balance, PREFUND + launchRouter.totalTaxCollected(), "the router: forced + tax");
        Buy memory b = _measuredBuy(eoa[3], 0.1 ether, eoa[3], 1);
        assertTrue(b.ok);
        assertEq(0.1 ether, b.spent + b.tax + b.refund);
        _toClosed();
        (uint256 reward, uint256 failures,,) = _graduateMeasured(keeper);
        assertEq(failures, 0);
        assertEq(reward, coordinator.rewardCap());
        uint256 tax = launchRouter.totalTaxCollected();
        uint256 h0 = _claims(a.hook);
        assertEq(launchRouter.sweep(), tax + PREFUND, "tax plus the forced ETH");
        assertEq(_claims(a.hook) - h0, tax + PREFUND);
        assertEq(a.launchRouter.balance, 0);
        assertEq(a.coordinator.balance, PREFUND, "the coordinator's forced ETH has no exit (no receive, no rescue)");
        assertEq(token.balanceOf(a.coordinator), 0);
        assertEq(token.totalSupply() + token.totalBurned(), BoxSpecV1.ISSUANCE);
        _assertGhostLedger();
    }
}

/// @notice Fuzz from the close (P2.3, P2.4): gifts of claims and of T of any size never raise the reward, never block
/// graduation and never leave T at the coordinator.
/// forge-config: default.evm_version = "osaka"
contract AuditU2FableClosedFuzzTest is AuditU2FableBase {
    function setUp() public override {
        super.setUp();
        _toClosed();
    }

    /// P2.3 / BC-027: Q claims gifted to the coordinator before graduation never raise the reward above the reserve,
    /// are forwarded whole to the receiver, and leave the coordinator holding only the credited reward.
    function testFuzz_AUDIT_U2_giftedClaimsNeverRaiseTheReward(uint96 giftRaw) public {
        uint256 gift = bound(uint256(giftRaw), 0, 20 ether);
        if (gift != 0) _giftClaims(a.coordinator, gift);
        uint256 minted = hook.reserveMinted();
        (uint256 reward, uint256 failures,, uint256 forwarded) = _graduateMeasured(eoa[1]);
        assertEq(failures, 0);
        assertEq(reward, minted < coordinator.rewardCap() ? minted : coordinator.rewardCap());
        assertEq(forwarded, gift, "the gift was forwarded whole");
        assertEq(_claims(a.coordinator), reward, "only the credited reward stays");
        assertEq(coordinator.rewardOf(eoa[1]), reward);
        _assertGhostLedger();
    }

    /// P2.4 / P2.12 / BC-043: T gifted to the coordinator by every outside holder, in any share from 0 to 100% of
    /// each balance, never blocks graduation: the whole balance goes into the ask (less dust burned), R is unchanged,
    /// the price is P1 and nothing stays at the coordinator.
    function testFuzz_AUDIT_U2_giftedTNeverBlocksGraduation(uint16 bpsRaw, uint8 mask) public {
        uint256 bps = uint256(bpsRaw) % 10_001;
        address[8] memory holders = [eoa[0], eoa[1], eoa[2], eoa[3], eoa[4], eoa[5], address(contractDrawer), eoa7702];
        uint256 gifted;
        for (uint256 i; i < 8; ++i) {
            if (mask & (1 << i) == 0) continue;
            uint256 amount = token.balanceOf(holders[i]) * bps / 10_000;
            if (amount == 0) continue;
            _transferT(holders[i], a.coordinator, amount);
            gifted += amount;
        }
        uint256 share = token.balanceOf(a.coordinator);
        (uint256 reward, uint256 failures, Migrated memory m,) = _graduateMeasured(keeper);
        assertEq(failures, 0);
        assertEq(reward, coordinator.rewardCap());
        assertEq(m.sharePassed, share);
        assertEq(m.tokenPulled + m.dustBurned, share, "into the ask or burned");
        assertLt(m.dustBurned, 1e9, "dust only");
        assertLe(raise - m.qFromCurve, 2);
        assertEq(token.balanceOf(a.coordinator), 0);
        assertEq(_sqrtPrice(), curve.sqrtPriceLowerX96);
        assertEq(token.totalSupply() + token.totalBurned(), BoxSpecV1.ISSUANCE);
        gifted;
        _assertGhostLedger();
    }
}
