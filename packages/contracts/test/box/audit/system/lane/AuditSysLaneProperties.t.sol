// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditSysLaneWorld} from "./AuditSysLaneWorld.sol";
import {IBoxCoordinator} from "../../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxReceiver} from "../../../../../src/box/interfaces/IBoxReceiver.sol";

/// @notice Deterministic boundary and accepted-behaviour properties supplement the stochastic menu.
/// forge-config: default.evm_version = "osaka"
/// forge-config: deep.evm_version = "osaka"
contract AuditSysLanePropertiesTest is AuditSysLaneWorld {
    function setUp() public override {
        _laneSetup(0);
    }

    function _reachGraduated(bool posted) internal {
        _warpTo(hook.openAt());
        _run(Act.Window, 2 ether);
        _run(Act.Take, 2);
        _warpTo(_requestTimeFor(r0));
        _run(Act.Close, 0);
        _run(Act.Graduate, 0);
        if (posted) {
            _warpTo(src.roundTime(r0));
            _run(Act.Post, 0);
            _run(Act.Accept, 0);
        }
    }

    /// @notice Property X11: backup starts strictly after five days and no later than five days eighteen hours.
    function test_laneBackupStartEdges() public {
        _reachGraduated(false);
        uint256[5] memory elapsed = [uint256(5 days - 1), 5 days, 5 days + 1, 5 days + 18 hours, 5 days + 18 hours + 1];
        for (uint256 i; i < elapsed.length; ++i) {
            uint256 snapshot = vm.snapshotState();
            _warpTo(src.roundTime(r0) + elapsed[i]);
            if (i < 2 || i == 4) vm.expectRevert();
            _startBackup(r0, keeper);
            if (i == 2 || i == 3) {
                (uint64 started,,,) = src.backupOf(r0);
                assertGt(started, 0, "X11 backup start at allowed edge");
            }
            assertTrue(vm.revertToStateAndDelete(snapshot), "lane: snapshot restored");
        }
    }

    /// @notice Property X11: EIP-2935 proves the target at age 8191, while age 8192 is unavailable.
    function test_laneBackupHistoryEdges() public {
        _reachGraduated(false);
        _warpTo(src.roundTime(r0) + 5 days + 1);
        uint256 target = _startBackup(r0, keeper);
        uint256 snapshot = vm.snapshotState();
        _advance(target + 8191 - vm.getBlockNumber());
        bytes32 mix = keccak256("lane history edge");
        assertEq(_fixBackup(r0, mix, poster), mix, "X11 last provable header");
        assertTrue(vm.revertToStateAndDelete(snapshot), "lane: snapshot restored");
        _advance(target + 8192 - vm.getBlockNumber());
        bytes memory header = _mineHeader(target, mix);
        vm.expectRevert();
        src.fixBackup(r0, header);
    }

    /// @notice Property X12: the silent head is live at seven days and terminal immediately after the deadline.
    function test_laneSilenceDeadlineEdges() public {
        _reachGraduated(false);
        uint256 deadline = uint256(tickets.status().wordRequestedAt) + 7 days;
        _warpTo(deadline);
        vm.expectRevert();
        tickets.enterTerminal();
        _warpTo(deadline + 1);
        _run(Act.Terminal, 0);
        while (_enabled(Act.HandBack)) _run(Act.HandBack, 0);
        assertEq(vault.pendingTickets(), 0, "X12 numberless tickets exit");
    }

    /// @notice Property X07/W1-U4-2: credits respect thirty-day epochs even when one payout exceeds 32 ETH.
    function test_laneCreditCapAndDelayedReceipt() public {
        _reachGraduated(true);
        _run(Act.Fees, 399 ether);
        uint256 graduation = coordinator.graduatedAt();
        _warpTo(graduation + 30 days - 1);
        (uint256 epoch,,) = receiver.platformEpoch();
        assertEq(epoch, 0, "X07 last second of epoch zero");
        _warpTo(graduation + 30 days);
        (epoch,,) = receiver.platformEpoch();
        assertEq(epoch, 1, "X07 first second of epoch one");
        _run(Act.Fees, 399 ether);
        _run(Act.PayPlatform, 0);
        assertEq(platformPaid, 64 ether, "W1-U4-2 delayed receipts cross credit epochs");
        assertEq(exceptions["W1-U4-2"], 1, "W1-U4-2 named exception");
    }

    /// @notice Property W2-U2-1: a quote after a window close may answer; a further buy is still refused.
    function test_laneClosedWindowQuoteIsNamedException() public {
        _warpTo(hook.openAt());
        _warpTo(hook.openAt() + 31 * 12);
        _run(Act.Window, 3 ether - 1);
        _run(Act.Window, 3 ether - 1);
        assertTrue(hook.closed(), "lane: close inside window");
        (uint256 tax, uint256 net) = launchRouter.quote(1 ether);
        assertEq(tax + net, 1 ether, "W2-U2-1 quote still partitions input");
        ++exceptions["W2-U2-1"];
        _fund(eoa[0], 1 ether);
        vm.prank(eoa[0]);
        vm.expectRevert();
        launchRouter.buy{value: 1 ether}(1 ether, 1, eoa[0], vm.getBlockTimestamp());
    }

    /// @notice Property X20: a destination with no payable entry cannot consume a keeper's reward credit.
    function test_laneRefusedRewardRemainsClaimable() public {
        _reachGraduated(false);
        uint256 beforeCredit = rewardCredit;
        vm.prank(keeper);
        vm.expectRevert();
        coordinator.claimReward(address(nonPayable));
        assertEq(coordinator.rewardOf(keeper), beforeCredit, "X20 refusal keeps reward");
        _run(Act.Reward, 0);
    }

    /// @notice Property W2-U6-1/X13: very late settlement saturates its recorded hours and still settles in order.
    function test_laneLateSettlementSaturatesHours() public {
        _reachGraduated(true);
        _run(Act.Draw, 0);
        (, uint64 round) = src.requestOf(a.tickets, 1);
        _warpTo(src.roundTime(round));
        while (_postable() <= round && _postable() != 0) _run(Act.Post, 0);
        _warpTo(vm.getBlockTimestamp() + (uint256(type(uint16).max) + 1) * 1 hours);
        _run(Act.Settle, 0);
        assertEq(exceptions["W2-U6-1"], 1, "W2-U6-1 named saturation");
        assertEq(tickets.status().drawsSettled, 1, "X13 old usable word remains settleable");
    }

    /// @notice Property X01: an unbooked wei is detected by conservation, rather than silently treated as a gift.
    function test_laneConservationDetectsUnbookedWei() public {
        vm.deal(a.tickets, a.tickets.balance + 1);
        vm.expectRevert();
        this.checkConservation();
    }

    /// @notice Property X02: temporal checks detect a forged increase in supply within the action transaction.
    function test_laneTemporalCheckDetectsSupplyIncrease() public {
        _save();
        --oldSupply;
        vm.expectRevert();
        this.checkTemporal();
    }

    /// @notice Property X06: a gas-limited failed graduation is atomic and can be retried with the runbook budget.
    function test_laneGraduationFailureIsAtomic() public {
        _warpTo(hook.windowEndsAt());
        _run(Act.Close, 0);
        uint256 held = _ghostSystemEth();
        uint256 supply = token.totalSupply();
        vm.prank(keeper);
        (bool ok,) = a.coordinator.call{gas: 50_000}(abi.encodeCall(IBoxCoordinator.graduate, ()));
        assertFalse(ok, "X06 insufficient gas refuses graduation");
        assertFalse(coordinator.graduated(), "X06 phase rollback");
        assertFalse(vault.gateOpen(), "X06 gate rollback");
        assertEq(_ghostSystemEth(), held, "X06 ETH rollback");
        assertEq(token.totalSupply(), supply, "X06 supply rollback");
        _run(Act.Graduate, 0);
    }

    /// @notice Property W2-U2-2: T sent to the coordinator joins migration; an empty sentinel is allowed.
    function test_laneCoordinatorGiftJoinsMigration() public {
        _warpTo(hook.windowEndsAt());
        _run(Act.Close, 0);
        uint256 amount = token.balanceOf(eoa[0]) / 2;
        _transferT(eoa[0], a.coordinator, amount);
        directT[a.coordinator] += amount;
        _run(Act.Graduate, 0);
        assertEq(exceptions["W2-U2-2"], 1, "W2-U2-2 named migration gift");
        assertEq(token.balanceOf(a.coordinator), 0, "X02 gift migrated or burned");
    }

    /// @notice Property X10: uncollected fees cannot hide an owner-liability deficit beyond N-1 raw T.
    function test_laneCoverageChecksUncollectedFees() public {
        _reachGraduated(true);
        _run(Act.Buy, 0.79 ether);
        uint256 snapshot = vm.snapshotState();
        this.laneCollect(); // Prove this state has a valid collection before injecting the accounting fault.
        assertTrue(vm.revertToStateAndDelete(snapshot), "lane: collection restored");
        vm.mockCall(a.itemStream, abi.encodeWithSignature("liabilities()"), abi.encode(type(uint256).max / 2));
        vm.expectRevert();
        this.checkAll();
    }

    /// @notice Property X11: the accepted graduation word must still equal its source after all placeholders open.
    function test_laneAcceptedWordRemainsTiedToSource() public {
        _reachGraduated(true);
        while (_enabled(Act.Open)) _run(Act.Open, 0);
        vm.mockCall(a.tickets, abi.encodeWithSignature("graduationWord()"), abi.encode(bytes32(uint256(1))));
        vm.expectRevert();
        this.checkAll();
    }

    /// @notice Property X01: conserved ETH moved to an unnamed system destination is still an accounting violation.
    function test_laneConservationRequiresNamedEthDestination() public {
        _reachGraduated(true);
        vm.deal(address(pm), address(pm).balance - 1);
        vm.deal(a.tickets, a.tickets.balance + 1);
        vm.expectRevert();
        this.checkAll();
    }

    /// @notice Property X16: an empty migrated sentinel requires the named coordinator-token-gift exception.
    function test_laneEmptySentinelRequiresNamedException() public {
        _reachGraduated(true);
        (uint128 ask, uint128 bid, uint128 sentinel) = hook.graduatedLayout();
        assertGt(sentinel, 0, "lane: ordinary migration has a sentinel");
        vm.mockCall(a.hook, abi.encodeWithSignature("graduatedLayout()"), abi.encode(ask, bid, uint128(0)));
        vm.expectRevert();
        this.checkAll();
    }

    /// @notice Property W1-U4-3/X09 (review): a stranger's claims at the receiver wait in no ledger as its next batch, a
    /// refused subminimum collect leaves them, and the next collect books all of them.
    function test_laneClaimsGiftWaitsAsNextBatch() public {
        _reachGraduated(true);
        _run(Act.GiftClaims, 0.004 ether);
        assertEq(nextQ, 0.004 ether + 1, "W1-U4-3 the gift waits as the next batch");
        _run(Act.Collect, 0);
        assertEq(counts[uint256(Act.Collect)].passed, 0, "X09 a subminimum batch is refused");
        assertEq(nextQ, 0.004 ether + 1, "W1-U4-3 a refused collect leaves the next batch");
        _run(Act.GiftClaims, 0.004 ether);
        _run(Act.Collect, 0);
        assertEq(counts[uint256(Act.Collect)].passed, 1, "X09 the batch above the minimum is collected");
        assertEq(nextQ, 0, "X09 the collect books the whole next batch");
        assertEq(exceptions["W1-U4-3"], 3, "W1-U4-3 counted after each call that left it");
    }

    /// @notice Property X08 (review): before graduation FIT's share and the platform's share wait. The campaign's menu
    /// offers these payouts only after graduation, so their refusal before it is pinned here.
    function test_lanePayoutsWaitForGraduation() public {
        _run(Act.Fees, 300 ether);
        assertGt(receiver.fitOwed(), 0, "lane: FIT's share is owed before graduation");
        assertGt(receiver.platformHeld(), 0, "lane: the platform's share is held before graduation");
        vm.prank(keeper);
        vm.expectRevert(IBoxReceiver.NotGraduated.selector);
        receiver.payFit();
        vm.prank(keeper);
        vm.expectRevert(IBoxReceiver.NothingOwed.selector);
        receiver.payPlatform();
        _run(Act.Fees, 1 ether);
    }

    /// @notice Property: documented deepen and execution no-ops cannot inflate the campaign's successful-action counts.
    function test_laneNoopWorkDoesNotCountAsSuccess() public {
        _run(Act.Deepen, 0);
        _run(Act.Execute, 0);
        assertEq(counts[uint256(Act.Deepen)].calls, 1, "lane: attempted deepen counted");
        assertEq(counts[uint256(Act.Execute)].calls, 1, "lane: attempted execution counted");
        assertEq(counts[uint256(Act.Deepen)].passed, 0, "lane: no-op deepen is not successful work");
        assertEq(counts[uint256(Act.Execute)].passed, 0, "lane: no-op execution is not successful work");
    }

    /// @notice Property X01-X21: the same whole-state checks apply to negative controls and campaign transitions.
    function checkAll() external {
        _check();
    }

    function checkConservation() external view {
        _conservation();
    }

    function checkTemporal() external {
        _temporal(Act.Post);
    }
}
