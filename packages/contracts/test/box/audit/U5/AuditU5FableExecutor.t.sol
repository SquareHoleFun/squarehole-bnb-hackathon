// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {FitBuybackExecutor, IBurnableToken} from "../../../../src/box/FitBuybackExecutor.sol";
import {TransientReentrancyGuard} from "../../../../src/libraries/TransientReentrancyGuard.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {EthIn} from "../common/AuditGhostLedger.sol";
import {AuditU5FableBase, AuditU5FableExecLogs, AuditU5FableReads} from "./AuditU5FableBase.sol";

/// @notice TEST ONLY: a receiver stand-in for an executor of the unit's own code (`FitBuybackExecutor`, immutable
/// `receiver`): its `noteModuleFees` tries to re-enter the executor that called it (L3, P5.8) and records what each
/// attempt answered; it never reverts itself, so the outer `execute` runs to its end.
contract AuditU5FableReentrantReceiver {
    bytes public errExecute;
    bytes public errPoke;
    bytes public errFund;
    bytes public errReceive;
    bytes public errCallback;
    uint256 public notes;
    uint256 public lastQ;

    function noteModuleFees(uint256 qFee, uint256) external {
        ++notes;
        lastQ = qFee;
        FitBuybackExecutor x = FitBuybackExecutor(payable(msg.sender));
        try x.execute(1) {}
        catch (bytes memory e) {
            errExecute = e;
        }
        try x.poke() {}
        catch (bytes memory e) {
            errPoke = e;
        }
        try x.fundBudget{value: 1}() {}
        catch (bytes memory e) {
            errFund = e;
        }
        (bool ok, bytes memory ret) = payable(address(x)).call{value: 1}("");
        if (!ok) errReceive = ret;
        try x.unlockCallback("") {}
        catch (bytes memory e) {
            errCallback = e;
        }
    }

    receive() external payable {}
}

/// @notice TEST ONLY: a launch phase stand-in whose `graduated()` is settable (L6, P5.13: the latch).
contract AuditU5FablePhase {
    bool public graduated;

    function set(bool g) external {
        graduated = g;
    }
}

/// @title AuditU5FableExecutorTest
/// @notice SH-AUDIT-B0-U5-F, FIT's buy-and-burn executor on the factory's box 0 (mainnet build, Osaka): the eight
/// lenses as passing property and fuzz tests. Sources: `FitBuybackExecutor.sol:27-49` (the three changes from
/// BuybackBurner), `:208-334`, `:414-421`; `BoxSpecV1.sol:96-108`; BC-019, BC-020, BC-041, BC-108; F67 (2).
/// forge-config: default.evm_version = "osaka"
contract AuditU5FableExecutorTest is AuditU5FableBase {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    // ================================================================================================ L1 value flow

    /// P5.1: the budget is the ETH balance at every point: `fundBudget`, `receive`, `payFit` and ETH forced in all
    /// count (BC-108: the whole amount, no treasury cut); `totalToBudget` books only what was sent as `msg.value`.
    /// The threshold and the chunk use the same quantity, so forced ETH alone can open a batch and is spent.
    function testProperty_AUDIT_U5_executorBudgetIsItsBalanceForcedEthIncluded() public {
        _toGraduated();
        uint256 credited = executor.totalToBudget();
        assertEq(executor.budget(), a.executor.balance, "budget == balance (graduated)");
        _fundBudget(eoa[0], 0.001 ether);
        credited += 0.001 ether;
        assertEq(executor.budget(), a.executor.balance, "after fundBudget");
        _fund(eoa[1], 0.002 ether);
        vm.prank(eoa[1]);
        (bool ok,) = a.executor.call{value: 0.002 ether}("");
        assertTrue(ok, "receive()");
        _noteEthIn(EthIn.FundBudget, 0.002 ether);
        credited += 0.002 ether;
        assertEq(executor.budget(), a.executor.balance, "after receive");
        uint256 fit = _payFit(keeper);
        credited += fit;
        assertEq(executor.budget(), a.executor.balance, "after payFit");
        assertEq(executor.totalToBudget(), credited, "totalToBudget == every msg.value credited");
        // Spend what is there, then force ETH alone above the threshold.
        _advance(1);
        while (executor.budget() >= executor.batchThreshold()) {
            _execute(keeper, 1);
            _advance(1);
        }
        uint256 threshold = executor.batchThreshold();
        uint256 missing = threshold - executor.budget();
        _forceEth(a.executor, missing);
        assertEq(executor.budget(), a.executor.balance, "forced ETH is budget");
        assertEq(executor.totalToBudget(), credited, "forced ETH is not credited");
        assertGe(executor.budget(), threshold, "the forced wei open the batch");
        AuditU5FableExecLogs.ExecLog memory e = _execute(eoa[2], 1);
        assertEq(e.chunks, 1, "a chunk bought on a budget that forced ETH completed");
        assertEq(executor.budget(), a.executor.balance, "still the balance");
        assertEq(executor.totalEthSpent() + executor.budget(), credited + missing, "credited + forced == spent + held");
        _assertGhostLedger();
    }

    /// P5.1: ETH leaves the executor only as swap input settled to the PoolManager inside its own unlock; nobody else
    /// gains a wei from an execution (no payee, no tip, BuybackBurner.sol:385-406; `FitBuybackExecutor.sol:30-33`).
    function testProperty_AUDIT_U5_executorEthLeavesOnlyAsSwapInput() public {
        _toGraduated();
        _payFit(keeper);
        address[6] memory watched = [eoa[2], address(contractDrawer), safe, a.receiver, a.hook, a.coordinator];
        uint256[6] memory before;
        for (uint256 i; i < 6; ++i) {
            before[i] = watched[i].balance;
        }
        uint256 x0 = a.executor.balance;
        uint256 p0 = address(pm).balance;
        AuditU5FableExecLogs.ExecLog memory e = _execute(eoa[2], 1);
        assertEq(e.chunks, 1, "bought");
        assertEq(x0 - a.executor.balance, e.ethSpent, "the executor lost exactly ethSpent");
        assertEq(address(pm).balance - p0, e.ethSpent, "the PoolManager gained exactly ethSpent");
        for (uint256 i; i < 6; ++i) {
            assertEq(watched[i].balance, before[i], "nobody else moved");
        }
        _assertGhostLedger();
    }

    /// P5.1: what an execution buys is burned in the same call; the executor holds no T between calls; T's supply
    /// falls by exactly what was burned (`_burnHeld`, FitBuybackExecutor.sol:513-524; BC-004 supply identity).
    function testProperty_AUDIT_U5_executorBurnsWhatItBuysInTheSameCall() public {
        _toGraduated();
        _payFit(keeper);
        uint256 s0 = token.totalSupply();
        uint256 b0 = token.totalBurned();
        uint256 burnedBefore = executor.totalBurned();
        AuditU5FableExecLogs.ExecLog memory e = _execute(eoa[1], 1);
        assertEq(e.chunks, 1);
        assertEq(e.fitBurned, e.fitBought, "burned == bought (nothing unsolicited)");
        assertEq(e.unsolicitedBurned, 0);
        assertEq(token.balanceOf(a.executor), 0, "no T held after");
        assertEq(s0 - token.totalSupply(), e.fitBurned, "supply fell by the burn");
        assertEq(token.totalBurned() - b0, e.fitBurned);
        assertEq(executor.totalBurned() - burnedBefore, e.fitBurned);
        assertEq(token.totalSupply() + token.totalBurned(), BoxSpecV1.ISSUANCE, "supply + burned == issuance");
        _assertGhostLedger();
    }

    /// P5.1 / P5.2: T sent to the executor by anyone (unsolicited) is burned at the next execution, even one that
    /// buys nothing (`_burnHeld` runs on every execute); the figure is reported as unsolicited.
    function testProperty_AUDIT_U5_executorBurnsUnsolicitedTWithoutBuying() public {
        _toGraduated();
        uint256 gift = 123 ether;
        _transferT(eoa[2], a.executor, gift);
        assertEq(token.balanceOf(a.executor), gift);
        assertLt(executor.budget(), executor.batchThreshold(), "no batch: nothing to buy");
        uint256 s0 = token.totalSupply();
        AuditU5FableExecLogs.ExecLog memory e = _execute(eoa[5], 1);
        assertEq(uint256(e.reason), uint256(FitBuybackExecutor.Stop.BelowBatch));
        assertEq(e.ethSpent, 0);
        assertEq(e.fitBurned, gift, "the gift burned");
        assertEq(e.unsolicitedBurned, gift);
        assertEq(s0 - token.totalSupply(), gift);
        assertEq(token.balanceOf(a.executor), 0);
        _assertGhostLedger();
    }

    /// REV-16 (BC-019; `FitBuybackExecutor.sol:36-39`, `:262-272`): the fee an execution reports to the receiver is
    /// a lower bound of the LP fee its chunks paid the positions (currency0, by StateLibrary before and after), never
    /// more; it lands in `moduleFeesPending` and the next collect returns it whole to `fitOwed` before the split.
    function testProperty_AUDIT_U5_executorFeeReportIsALowerBoundOfLpFees() public {
        _toGraduated();
        _payFit(keeper);
        (uint256 owed0Before,) = _uncollected();
        AuditU5FableExecLogs.ExecLog memory e = _execute(keeper, 1);
        (uint256 owed0After,) = _uncollected();
        uint256 earned = owed0After - owed0Before;
        assertEq(e.chunks, 1);
        assertGt(e.feeReported, 0, "a fee reported");
        assertLe(e.feeReported, earned, "reported <= what the positions earned");
        // Tight: the report is the LP share of ethSpent less 2 raw units per possible step, rounding the only gap.
        uint256 slack =
            2 * (uint256(uint24(BoxSpecV1.EXECUTOR_MAX_IMPACT_TICKS)) / uint256(uint24(BoxSpecV1.TICK_SPACING)) + 4);
        assertGe(e.feeReported + slack + 8, earned, "within the stated slack of the positions' fee");
        assertEq(e.feeReported, e.ethSpent * BoxSpecV1.LP_FEE / 1_000_000 - slack, "ethSpent x LP_FEE - slack");
        (uint256 pendingQ, uint256 pendingT) = receiver.moduleFeesPending();
        assertEq(pendingQ, e.feeReported, "booked as the executor's pending note");
        assertEq(pendingT, 0);
        uint256 fitOwed0 = receiver.fitOwed();
        _collectWithQ(keeper);
        (pendingQ,) = receiver.moduleFeesPending();
        assertEq(pendingQ, 0, "returned at the next collect");
        assertGe(receiver.fitOwed() - fitOwed0, e.feeReported, "the whole note went to FIT's share first");
        _assertGhostLedger();
    }

    /// No treasury, no payee (F67 (2), BC-108): the Safe's balance and credit never change through the executor; the
    /// receiver's platform ledger is untouched by executions and by budget intake.
    function testProperty_AUDIT_U5_executorNoTreasuryNoPayee() public {
        _toGraduated();
        uint256 owed = receiver.platformOwed();
        uint256 safe0 = safe.balance;
        _fundBudget(eoa[3], 1 ether);
        _execute(eoa[3], 1);
        _advance(1);
        _execute(address(contractDrawer), 1);
        assertEq(receiver.platformOwed(), owed, "the platform ledger is not touched");
        assertEq(safe.balance, safe0, "the Safe got nothing");
        assertEq(executor.totalToBudget(), executor.totalEthSpent() + executor.budget(), "credited == spent + held");
        _assertGhostLedger();
    }

    // ================================================================================================ L2 access

    /// P5.6: `execute`, `poke`, `fundBudget` and `receive` are open to any account (an EOA, a contract, an EIP-7702
    /// EOA, a contract whose `receive` burns gas) and make the same progress whoever calls.
    function testProperty_AUDIT_U5_executorEntryPointsOpenToAnyoneSameProgress() public {
        _toGraduated();
        _payFit(keeper);
        address[4] memory callers = [eoa[2], address(contractDrawer), eoa7702, address(gasBurner)];
        uint256 snap = vm.snapshotState();
        AuditU5FableExecLogs.ExecLog memory ref = _execute(callers[0], 1);
        int24 sampleRef = executor.latestSampleTick();
        vm.revertToState(snap);
        for (uint256 i = 1; i < 4; ++i) {
            AuditU5FableExecLogs.ExecLog memory e = _execute(callers[i], 1);
            assertEq(e.chunks, ref.chunks, "same chunks");
            assertEq(e.ethSpent, ref.ethSpent, "same spend");
            assertEq(e.fitBurned, ref.fitBurned, "same burn");
            assertEq(executor.latestSampleTick(), sampleRef, "same sample");
            vm.revertToState(snap);
        }
        for (uint256 i; i < 4; ++i) {
            vm.prank(callers[i]);
            executor.poke();
            _fundBudget(callers[i], 1 wei);
        }
        _assertGhostLedger();
    }

    /// P5.8: `unlockCallback` runs only for the PoolManager inside the executor's own guarded call: a stranger, and
    /// the PoolManager's address itself outside an execution, are refused (`NotPoolManager`).
    function testFuzz_AUDIT_U5_executorRefusesForeignUnlockCallbacks(address caller, bytes calldata data) public {
        _toGraduated();
        vm.assume(caller != address(pm));
        vm.expectRevert(FitBuybackExecutor.NotPoolManager.selector);
        vm.prank(caller);
        executor.unlockCallback(data);
        // The PoolManager itself, outside any execution: the lock is not held.
        vm.expectRevert(FitBuybackExecutor.NotPoolManager.selector);
        vm.prank(address(pm));
        executor.unlockCallback(data);
    }

    // ================================================================================================ L3 reentrancy

    /// P5.8: every re-entry into an executor while its `execute` runs meets the transient lock: `execute`, `poke`,
    /// `fundBudget` and `receive` answer `Reentrancy()`, `unlockCallback` `NotPoolManager()`. Stand-in: an executor of
    /// the unit's own code on box 0's pool, T and hook, whose immutable receiver is a contract that re-enters from
    /// `noteModuleFees` (the one external call `execute` makes to a non-PoolManager party after its swap).
    function testProperty_AUDIT_U5_executorReentryMeetsTheLock() public {
        _toGraduated();
        AuditU5FableReentrantReceiver r = new AuditU5FableReentrantReceiver();
        vm.deal(address(r), 1 ether);
        FitBuybackExecutor x =
            new FitBuybackExecutor(pm, IBurnableToken(a.token), a.coordinator, a.hook, address(r), curve.tickLower);
        vm.deal(address(x), 0.05 ether);
        _warpTo(vm.getBlockTimestamp() + 1 hours + 1);
        vm.prank(eoa[2]);
        (uint256 chunks, uint256 spent,) = x.execute(1);
        assertEq(chunks, 1, "the stand-in executor bought in box 0's pool");
        assertGt(spent, 0);
        assertEq(r.notes(), 1, "one note after the buy");
        bytes memory reentrancy = abi.encodeWithSelector(TransientReentrancyGuard.Reentrancy.selector);
        assertEq(r.errExecute(), reentrancy, "execute re-entry locked");
        assertEq(r.errPoke(), reentrancy, "poke re-entry locked");
        assertEq(r.errFund(), reentrancy, "fundBudget re-entry locked");
        assertEq(r.errReceive(), reentrancy, "receive re-entry locked");
        assertEq(r.errCallback(), abi.encodeWithSelector(FitBuybackExecutor.NotPoolManager.selector), "callback");
        assertEq(token.balanceOf(address(x)), 0, "burned");
        assertEq(address(x).balance, 0.05 ether - spent, "nothing entered during the lock");
    }

    // ================================================================================================ L4 the average

    /// P5.9: one sample per timestamp, each at most 100 ticks from the previous (`_observe`,
    /// FitBuybackExecutor.sol:366-386); a second poke in the same block records nothing.
    function testProperty_AUDIT_U5_sampleOnePerTimestampAndAtMost100Ticks() public {
        _toGraduated();
        int24 s0 = executor.latestSampleTick();
        // The price sits exactly on sqrt(P1) after migrate; v4 reports the tick below it (P1 - 1) for a swap that
        // ended on the boundary, so the sample is P1 - 1.
        assertEq(_poolSqrt(), curve.sqrtPriceLowerX96, "the price is exactly sqrt(P1)");
        assertEq(s0, _poolTick(), "the sample is the pool's tick after graduation's poke");
        assertLe(_abs(int256(s0) - int256(curve.tickLower)), 1, "within a tick of P1");
        _buy(eoa[2], 2 ether);
        int24 spot = _poolTick();
        assertLt(spot, s0 - 300, "the push moved the price by more than three samples' worth");
        _advance(1);
        vm.recordLogs();
        vm.prank(eoa[5]);
        executor.poke();
        vm.prank(eoa[4]);
        executor.poke();
        AuditU5FableExecLogs.ExecLog memory e = _decodeExec(vm.getRecordedLogs());
        assertEq(e.observed, 1, "one sample per timestamp");
        assertEq(executor.latestSampleTick(), s0 - BoxSpecV1.EXECUTOR_MAX_OBSERVATION_STEP, "exactly 100 ticks");
        _advance(1);
        vm.prank(eoa[5]);
        executor.poke();
        assertEq(executor.latestSampleTick(), s0 - 2 * BoxSpecV1.EXECUTOR_MAX_OBSERVATION_STEP, "another 100");
        // Back within 100 ticks of the sample: the sample lands on the spot itself.
        _sell(eoa[2], token.balanceOf(eoa[2]));
        _advance(1);
        int24 spot2 = _poolTick();
        vm.prank(eoa[5]);
        executor.poke();
        int24 s = executor.latestSampleTick();
        assertLe(_abs(int256(s) - int256(s0 - 200)), 100, "bounded step");
        if (_abs(int256(spot2) - int256(s0 - 200)) <= 100) assertEq(s, spot2, "within reach: the spot");
    }

    /// P5.9: a price held for b blocks moves the sample by at most 100·b ticks, whatever the price did (fuzz).
    function testFuzz_AUDIT_U5_sampleWalksAtMost100TicksPerBlock(uint256 push, uint256 blocks, bool sellSide) public {
        _toGraduated();
        blocks = bound(blocks, 1, 40);
        push = bound(push, 0.01 ether, 5 ether);
        int24 s0 = executor.latestSampleTick();
        if (sellSide) _sell(eoa[2], bound(push, 1, token.balanceOf(eoa[2])));
        else _buy(eoa[2], push);
        int24 spot = _poolTick();
        for (uint256 i; i < blocks; ++i) {
            _advance(1);
            vm.prank(eoa[5]);
            executor.poke();
        }
        int24 s = executor.latestSampleTick();
        assertLe(_abs(int256(s) - int256(s0)), 100 * blocks, "at most 100 ticks per block");
        uint256 walk = _abs(int256(spot) - int256(s0));
        if (walk <= 100 * blocks) assertEq(s, spot, "reached the spot");
    }

    /// P5.9 / Misfits-line #4 (fixed, seed P1): with no poke during the curve, the average is P1 at graduation and the
    /// first execution buys in graduation's own block. Samples are recorded whenever the pool has liquidity, the curve
    /// included: pokes during the curve walk the sample towards the curve's price and the first buy then waits for
    /// the walk back at 100 ticks a block plus the hour's average (the keeper duty recorded in SH-misfits-line).
    function testProperty_AUDIT_U5_firstBuyAtGraduationUnlessPokedDuringTheCurve() public {
        uint256 snap = vm.snapshotState();
        _toGraduated();
        assertLe(_abs(int256(executor.latestSampleTick()) - int256(curve.tickLower)), 1, "P1 (v4's boundary tick)");
        (bool ready, int24 tw,) = executor.twap();
        assertTrue(ready);
        assertEq(tw, curve.tickLower, "the hour's average is P1");
        _payFit(keeper);
        AuditU5FableExecLogs.ExecLog memory e = _execute(keeper, 1);
        assertEq(e.chunks, 1, "bought in graduation's block");
        vm.revertToState(snap);
        reached = AuditPhase.Created;

        // The same box, poked every block during bonding (400 blocks).
        _toBonding();
        int24 curveTick = _poolTick();
        for (uint256 i; i < 400; ++i) {
            _advance(1);
            vm.prank(eoa[5]);
            executor.poke();
        }
        assertEq(executor.latestSampleTick(), curveTick, "the sample followed the curve's price");
        _toGraduated();
        _payFit(keeper);
        uint256 walk = _abs(int256(executor.latestSampleTick()) - int256(curve.tickLower));
        uint256 blocks;
        for (; blocks < 2_000; ++blocks) {
            vm.prank(keeper);
            (uint256 c,,) = executor.execute(1);
            if (c != 0) break;
            _advance(1);
        }
        emit log_named_uint("blocks until the first buy after curve pokes", blocks);
        uint256 window = (uint256(BoxSpecV1.EXECUTOR_TWAP_WINDOW_SECONDS) + executor.CHECKPOINT_SPACING()) / SLOT + 2;
        assertGe(blocks, walk / 100, "at least the walk back");
        assertLe(blocks, walk / 100 + window, "at most the walk back plus the hour's window");
    }

    /// P5.9: every chunk stays within 49 ticks of its start and above the floor, which is max(sample, average) − 99
    /// ticks; a price pushed far below the floor buys nothing (fuzz over the budget and a push either way).
    function testFuzz_AUDIT_U5_chunkWithin49TicksAndAboveTheFloor(uint256 budget, uint256 push, bool sellSide) public {
        _toGraduated();
        budget = bound(budget, 0, 50 ether);
        push = bound(push, 0, 3 ether);
        _fundBudget(eoa[3], budget);
        if (push != 0) {
            if (sellSide) _sell(eoa[2], bound(push, 1, token.balanceOf(eoa[2])));
            else _buy(eoa[2], push);
        }
        _advance(1);
        int24 tickBefore = _poolTick();
        AuditU5FableExecLogs.ExecLog memory e = _execute(eoa[4], 3);
        int24 sample = executor.latestSampleTick();
        assertLe(e.chunks, 1, "one chunk per block");
        if (e.chunks == 1) {
            assertEq(e.floorSqrt, _expectedFloor(sample, e.twapTick), "the floor is max(sample, twap) - 99 ticks");
            int24 tb = _tickOf(e.lastSqrtBefore);
            int24 ta = _tickOf(e.lastSqrtAfter);
            assertLe(int256(tb) - int256(ta), int256(BoxSpecV1.EXECUTOR_MAX_IMPACT_TICKS), "<= 49 ticks per chunk");
            assertGe(e.lastSqrtAfter, e.lastLimit, "never past the limit");
            assertGe(e.lastLimit, e.floorSqrt, "the limit is above the floor");
            assertLe(e.ethSpent, budget + 1 ether, "spent from the budget only");
        } else if (uint256(e.reason) == uint256(FitBuybackExecutor.Stop.AtCeiling)) {
            assertLe(_poolSqrt(), e.floorSqrt, "at the ceiling: the price is at or below the floor");
            assertEq(_poolTick(), tickBefore, "nothing moved");
        }
        _assertGhostLedger();
    }

    // ================================================================================================ L5 liveness

    /// P5.11: `execute` never reverts after graduation: any budget, any push of the price either way, any number of
    /// idle blocks with or without pokes, any `maxChunks`, any caller (fuzz); and the block limit holds.
    function testFuzz_AUDIT_U5_executeNeverRevertsAfterGraduation(
        uint256 budget,
        uint256 push,
        bool sellSide,
        uint256 blocks,
        uint256 maxChunks,
        uint256 who
    ) public {
        _toGraduated();
        budget = bound(budget, 0, 100 ether);
        push = bound(push, 0, 20 ether);
        blocks = bound(blocks, 0, 600);
        maxChunks = bound(maxChunks, 0, 10);
        address caller = [eoa[0], eoa[2], address(contractDrawer), eoa7702, address(gasBurner)][who % 5];
        if (budget != 0) _fundBudget(eoa[3], budget);
        if (push != 0) {
            if (sellSide) _sell(eoa[2], bound(push, 1, token.balanceOf(eoa[2])));
            else _buy(eoa[2], push);
        }
        for (uint256 i; i < blocks; i += 50) {
            _advance(50);
            if (i % 100 == 0) {
                vm.prank(eoa[5]);
                executor.poke();
            }
        }
        bool batchOpen = executor.budget() >= executor.batchThreshold();
        AuditU5FableExecLogs.ExecLog memory e = _execute(caller, maxChunks);
        assertLe(e.chunks, 1);
        if (maxChunks == 0 && batchOpen) assertEq(uint256(e.reason), uint256(FitBuybackExecutor.Stop.MaxChunks));
        if (!batchOpen) assertEq(uint256(e.reason), uint256(FitBuybackExecutor.Stop.BelowBatch));
        bool stillOpen = executor.budget() >= executor.batchThreshold();
        AuditU5FableExecLogs.ExecLog memory again = _execute(caller, maxChunks);
        assertEq(again.chunks, 0, "second call in the block buys nothing");
        if (e.chunks == 1) {
            // The block limit, unless the chunk took the budget below a batch (that check comes first).
            assertEq(
                uint256(again.reason),
                uint256(stillOpen ? FitBuybackExecutor.Stop.BlockLimit : FitBuybackExecutor.Stop.BelowBatch)
            );
        }
        assertEq(token.balanceOf(a.executor), 0);
        assertEq(executor.budget(), a.executor.balance);
        _assertGhostLedger();
    }

    /// BC-020 / P5.11 before graduation: with a budget on the curve and after the close, `execute` buys nothing
    /// (`Stop.NotGraduated`), spends nothing and `fitGraduated()` reads false; `graduationSeen` latches only after.
    function testProperty_AUDIT_U5_executeBeforeGraduationBuysNothing() public {
        _toBonding();
        _fundBudget(eoa[3], 5 ether);
        assertFalse(executor.fitGraduated());
        AuditU5FableExecLogs.ExecLog memory e = _execute(eoa[3], 1);
        assertEq(uint256(e.reason), uint256(FitBuybackExecutor.Stop.NotGraduated));
        assertEq(e.ethSpent, 0);
        assertFalse(executor.graduationSeen());
        _toClosed();
        e = _execute(eoa[3], 1);
        assertEq(uint256(e.reason), uint256(FitBuybackExecutor.Stop.NotGraduated));
        assertEq(executor.budget(), 5 ether, "nothing spent before graduation");
        _toGraduated();
        assertTrue(executor.fitGraduated(), "reads the coordinator");
        assertFalse(executor.graduationSeen(), "not latched by a view");
        e = _execute(eoa[3], 1);
        assertTrue(executor.graduationSeen(), "latched by the first execute after graduation");
        // The two executions before graduation sampled the curve's price, and the sample sat there for a day: the
        // hour's average is the curve's price until a checkpoint taken after graduation is an hour old. The first
        // buy comes within the window plus one checkpoint spacing (the keeper duty of SH-misfits-line).
        assertEq(uint256(e.reason), uint256(FitBuybackExecutor.Stop.AtCeiling), "the average still says the curve");
        uint256 blocks;
        for (; e.chunks == 0 && blocks < 1_000; ++blocks) {
            _advance(1);
            e = _execute(eoa[3], 1);
        }
        emit log_named_uint("blocks until the first buy after two samples on the curve", blocks);
        assertEq(e.chunks, 1, "bought after graduation");
        assertLe(blocks, (uint256(BoxSpecV1.EXECUTOR_TWAP_WINDOW_SECONDS) + executor.CHECKPOINT_SPACING()) / SLOT + 2);
        assertEq(executor.budget(), 5 ether - e.ethSpent, "only after graduation was anything spent");
        _assertGhostLedger();
    }

    /// X18: the gas of one execution that buys, from cold, at graduation's state; the measured figure is logged and
    /// bounded (the keeper's loop runs it every block until the first buy).
    function testProperty_AUDIT_U5_executeGasBounded() public {
        _toGraduated();
        _payFit(keeper);
        vm.prank(keeper);
        uint256 g0 = gasleft();
        (uint256 c,,) = executor.execute(1);
        uint256 used = g0 - gasleft();
        assertEq(c, 1);
        emit log_named_uint("execute(1) with a buy, from cold, gas", used);
        assertLt(used, 350_000, "an execution that buys stays under 350k gas");
        vm.prank(keeper);
        g0 = gasleft();
        (c,,) = executor.execute(1);
        used = g0 - gasleft();
        assertEq(c, 0);
        emit log_named_uint("execute(1) at the block limit, gas", used);
        assertLt(used, 80_000);
        // Drain the budget below a batch, then an execution in a new block that samples and buys nothing.
        while (executor.budget() >= executor.batchThreshold()) {
            _advance(1);
            _execute(keeper, 1);
        }
        _advance(1);
        vm.prank(keeper);
        g0 = gasleft();
        (c,,) = executor.execute(1);
        used = g0 - gasleft();
        assertEq(c, 0);
        emit log_named_uint("execute(1) below a batch in a new block (one sample), gas", used);
        assertLt(used, 100_000);
        _advance(1);
        vm.prank(keeper);
        g0 = gasleft();
        executor.poke();
        used = g0 - gasleft();
        emit log_named_uint("poke in a new block, gas", used);
        assertLt(used, 60_000);
    }

    // ================================================================================================ L6 external

    /// P5.13: `fitGraduated()` latches: once an execution read the coordinator's `graduated()` true, a phase that later
    /// reports false (stand-in) cannot pause buying nor flip the view (BuybackBurner.sol:558-563; `:413-419`).
    function testProperty_AUDIT_U5_fitGraduatedLatches() public {
        _toGraduated();
        AuditU5FablePhase phase = new AuditU5FablePhase();
        FitBuybackExecutor x =
            new FitBuybackExecutor(pm, IBurnableToken(a.token), address(phase), a.hook, a.receiver, curve.tickLower);
        assertFalse(x.fitGraduated());
        phase.set(true);
        assertTrue(x.fitGraduated(), "reads the phase");
        assertFalse(x.graduationSeen());
        vm.deal(address(x), 0.05 ether);
        _warpTo(vm.getBlockTimestamp() + 1 hours + 1);
        // Its note goes to box 0's real receiver, which refuses a stranger (NotModule): the stand-in executor's
        // report is not box 0's business, so expect the revert from the note and check the latch through `poke`-free
        // paths instead: a phase that reads true latches in execute's own frame before the note.
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotModule.selector, address(x)));
        x.execute(1);
        // A stand-in receiver instead, so the execution completes and the latch is written.
        AuditU5FableReentrantReceiver r = new AuditU5FableReentrantReceiver();
        FitBuybackExecutor y =
            new FitBuybackExecutor(pm, IBurnableToken(a.token), address(phase), a.hook, address(r), curve.tickLower);
        vm.deal(address(y), 0.05 ether);
        _warpTo(vm.getBlockTimestamp() + 1 hours + 1);
        (uint256 c,,) = y.execute(1);
        assertEq(c, 1);
        assertTrue(y.graduationSeen(), "latched");
        phase.set(false);
        assertTrue(y.fitGraduated(), "still true once seen");
        _advance(1);
        vm.deal(address(y), 0.05 ether);
        (c,,) = y.execute(1);
        assertEq(c, 1, "a phase reporting false cannot pause buying");
        assertFalse(x.fitGraduated(), "the one that never latched follows the phase");
    }

    /// L6: with a protocol fee on box 0's pool (Uniswap governance may set up to 0.1% on any pool), the executor's
    /// LP-share figure excludes the protocol's part and stays a lower bound of what the positions earned; its minimum
    /// output uses the combined fee, so the chunk still passes its own output check.
    function testProperty_AUDIT_U5_executorFeeReportUnderAProtocolFee() public {
        _toGraduated();
        _payFit(keeper);
        _setProtocolFee(1_000, 1_000);
        (uint256 owed0Before,) = _uncollected();
        AuditU5FableExecLogs.ExecLog memory e = _execute(keeper, 1);
        (uint256 owed0After,) = _uncollected();
        assertEq(e.chunks, 1, "bought under a protocol fee");
        uint256 earned = owed0After - owed0Before;
        assertLe(e.feeReported, earned, "reported <= the LP part");
        // The combined fee is 1% + 0.1% − 0.001%; the LPs' share of it is 1% − 0.001% of the input (v4's protocol
        // fee is taken from the whole input first, ProtocolFeeLibrary.calculateSwapFee).
        uint256 lpPips = BoxSpecV1.LP_FEE - uint256(1_000) * BoxSpecV1.LP_FEE / 1_000_000;
        uint256 slack =
            2 * (uint256(uint24(BoxSpecV1.EXECUTOR_MAX_IMPACT_TICKS)) / uint256(uint24(BoxSpecV1.TICK_SPACING)) + 4);
        assertEq(e.feeReported, e.ethSpent * lpPips / 1_000_000 - slack, "LP share less the slack");
        assertGe(e.feeReported + slack + 8, earned, "tight");
        _assertGhostLedger();
    }

    /// L6: the executor's `_slot0` and liquidity reads of the pool by `extsload` agree with StateLibrary's (the
    /// `POOLS_SLOT` 6 and liquidity offset 3 of the pinned PoolManager), seen through what it records and computes.
    function testProperty_AUDIT_U5_executorPoolReadsMatchStateLibrary() public {
        _toGraduated();
        int24 prev = executor.latestSampleTick();
        _buy(eoa[2], 0.3 ether);
        _advance(1);
        vm.recordLogs();
        vm.prank(eoa[5]);
        executor.poke();
        AuditU5FableExecLogs.ExecLog memory e = _decodeExec(vm.getRecordedLogs());
        (, int24 tick,,) = pm.getSlot0(_pid());
        assertEq(e.observed, 1);
        assertGt(pm.getLiquidity(_pid()), 0);
        // The recorded tick is StateLibrary's slot0 tick clamped to 100 ticks of the previous sample.
        int24 lo = prev - 100;
        int24 hi = prev + 100;
        int24 want = tick < lo ? lo : (tick > hi ? hi : tick);
        assertEq(e.observedRecorded, want, "the sample is StateLibrary's tick, clamped");
        assertEq(executor.latestSampleTick(), want);
        assertEq(executor.poolId(), bytes32(abi.encode(_pid())), "the pool id");
    }

    // ================================================================================================ L7 arithmetic

    /// P5.15: the batch threshold (0.05% of supply × ETH per FIT at the average) does not overflow at either end of
    /// the tick range for supply 1e27 (the arithmetic of `batchThreshold`, FitBuybackExecutor.sol:325-331, repeated
    /// with the same library at MIN_TICK and MAX_TICK), and the live value at graduation is about 0.01 ETH (P8).
    function testProperty_AUDIT_U5_batchThresholdNoOverflowAtTheExtremes() public {
        _toGraduated();
        uint256 supply = BoxSpecV1.ISSUANCE;
        uint256 atMin = _thresholdAt(supply, TickMath.MIN_TICK);
        uint256 atMax = _thresholdAt(supply, TickMath.MAX_TICK);
        uint256 atMinUsable = _thresholdAt(supply, BoxSpecV1.MIN_USABLE_TICK);
        // mcap at MIN_TICK = 1e27 x 2^192 / 4295128739^2 (about 1.7e65 wei); no FullMath revert on the way.
        assertApproxEqRel(
            atMin,
            FullMath.mulDiv(supply, uint256(1) << 192, 4_295_128_739 * uint256(4_295_128_739)) * 5 / 10_000,
            1e9,
            "MIN_TICK"
        );
        assertGt(atMin, 1e60, "the ETH value at the cheapest-ETH tick is astronomic but computable");
        assertEq(atMax, 0, "zero at MAX_TICK (T worth nothing)");
        assertGe(atMin, atMinUsable);
        emit log_named_uint("threshold at MIN_TICK (wei)", atMin);
        uint256 live = executor.batchThreshold();
        assertEq(live, _thresholdAt(token.totalSupply(), curve.tickLower), "the live figure at the P1 average");
        assertGt(live, 0.005 ether);
        assertLt(live, 0.02 ether, "about 0.01 ETH at graduation's price");
        emit log_named_uint("threshold at graduation (wei)", live);
    }

    function _thresholdAt(uint256 supply, int24 tick) internal pure returns (uint256) {
        uint256 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        uint256 mcap = FullMath.mulDiv(FullMath.mulDiv(supply, Q96, sqrtP), Q96, sqrtP);
        return mcap * BoxSpecV1.FIT_BURN_BATCH_MCAP_BPS / 10_000;
    }

    /// L7: the oracle's packed fields fit their lifetime: `tickCumulative` (int56) at the extreme tick for 136 years
    /// (uint32 time), the checkpoint ring's 8 × 515 s spacing covers the hour, `_chunksInBlock` ≤ 1.
    function testProperty_AUDIT_U5_oracleFieldsFitTheirLifetime() public view {
        int256 maxCum = int256(TickMath.MAX_TICK) * int256(uint256(type(uint32).max));
        assertLt(maxCum, int256(type(int56).max), "tickCumulative fits int56 for the uint32 lifetime");
        assertEq(executor.CHECKPOINT_SPACING(), 515);
        assertGe(
            uint256(executor.CHECKPOINT_SPACING()) * (executor.CHECKPOINTS() - 1),
            executor.TWAP_WINDOW(),
            "ring covers the window"
        );
        assertEq(executor.MAX_CHUNKS_PER_BLOCK(), 1);
        assertEq(executor.MAX_IMPACT_TICKS(), 49);
        assertEq(executor.TWAP_BAND_TICKS(), 99);
        assertEq(executor.MAX_OBSERVATION_STEP(), 100);
        assertEq(executor.MIN_SQRT_PRICE_X96(), TickMath.MIN_SQRT_PRICE + 1);
    }

    // ================================================================================================ L8 deployment

    /// P5.16: the executor is box 0's own: born in `deploy` from the creation code the factory pins by hash, wired to
    /// box 0's PoolManager, T, coordinator, hook and receiver, with box 0's pool id, seeded at P1; the coordinator,
    /// the receiver and the hook name it back.
    function testProperty_AUDIT_U5_executorIsBoxZerosOwn() public view {
        assertEq(factory.executorInitCodeHash(), keccak256(type(FitBuybackExecutor).creationCode), "the pinned code");
        assertEq(address(executor.poolManager()), address(pm));
        assertEq(address(executor.token()), a.token);
        assertEq(executor.launchPhase(), a.coordinator);
        assertEq(executor.hooks(), a.hook);
        assertEq(executor.receiver(), a.receiver);
        assertEq(executor.poolId(), bytes32(abi.encode(_pid())));
        assertEq(coordinator.executor(), a.executor, "the coordinator's");
        assertEq(receiver.executor(), a.executor, "the receiver's");
        assertEq(address(hook.priceAverage()), a.executor, "the hook's average");
        assertGt(coordinator.nonceOf(coordinator.ROLE_EXECUTOR()), 0, "born in the coordinator's deploy (BC-064)");
        FitBuybackExecutor.Oracle memory o = executor.oracle();
        assertEq(o.tick, curve.tickLower, "seeded at P1");
        assertEq(o.time, uint32(createdAt), "seeded at creation");
        assertEq(o.filled, 1);
        assertEq(executor.checkpointAt(0).time, uint32(createdAt));
        assertEq(a.executor.balance, 0, "no ETH at creation");
    }
}

/// @title AuditU5FableExecutorAmsterdamTest
/// @notice The ETH-send check of wave 1's measured fact, under Amsterdam: unit U5 has no stipend-only send to an
/// address a user chooses (the executor pays the PoolManager alone, by `settle{value}` with all gas; the stream pays
/// T, an ERC-20 transfer with no callback). An EIP-7702 EOA calls `execute`, funds the budget and receives claims on
/// Amsterdam exactly as on Osaka.
/// forge-config: default.evm_version = "amsterdam"
contract AuditU5FableExecutorAmsterdamTest is AuditU5FableBase {
    function testProperty_AUDIT_U5_noStipendOnlySendInTheUnitAmsterdam() public {
        _toDrawing();
        _payFit(keeper);
        uint256 p0 = address(pm).balance;
        uint256 x0 = a.executor.balance;
        uint256 c0 = eoa7702.balance;
        AuditU5FableExecLogs.ExecLog memory e = _execute(eoa7702, 1);
        assertEq(e.chunks, 1, "the 7702 EOA ran a buy on Amsterdam");
        assertEq(address(pm).balance - p0, e.ethSpent, "only the PoolManager received ETH");
        assertEq(x0 - a.executor.balance, e.ethSpent);
        assertEq(eoa7702.balance, c0, "the caller got nothing");
        _fundBudget(eoa7702, 0.01 ether);
        assertEq(executor.budget(), a.executor.balance);
        // T to a 7702 EOA, a contract whose receive burns gas, and a refuser: ERC-20 transfers, no stipend involved.
        _transferItem(eoa[3], eoa7702, itemA);
        _sell(eoa[2], token.balanceOf(eoa[2]) / 4);
        _collectWithQ(keeper);
        uint256 paid = _claimStreamFor(eoa[5], eoa7702, _ids(itemA));
        assertGt(paid, 0, "claimFor paid the 7702 EOA on Amsterdam");
        _transferItem(eoa7702, address(gasBurner), itemA);
        _sell(eoa[2], token.balanceOf(eoa[2]) / 4);
        _collectWithQ(keeper);
        paid = _claimStreamFor(eoa[5], address(gasBurner), _ids(itemA));
        assertGt(paid, 0, "claimFor paid the gas burner");
        _transferItem(address(gasBurner), address(ethRefuser), itemA);
        vm.prank(address(ethRefuser));
        collection.transferFrom(address(ethRefuser), eoa[0], itemA);
        _sell(eoa[2], token.balanceOf(eoa[2]) / 4);
        _collectWithQ(keeper);
        paid = _claimStream(eoa[0], _ids(itemA));
        assertGt(paid, 0);
        vm.prank(eoa[0]);
        paid = stream.claim(new uint256[](0), eoa7702);
        assertEq(paid, 0, "nothing left to claim right away (1 raw unit kept)");
        _assertGhostLedger();
    }
}
