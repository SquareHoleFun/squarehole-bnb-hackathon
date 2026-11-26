// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {AuditRouterSwapper} from "../common/AuditActors.sol";
import {AuditGhostLedger, EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU5FableBase, AuditU5FableExecLogs, AuditU5FableReads} from "./AuditU5FableBase.sol";

/// @title AuditU5FableExecutorHandler
/// @notice TEST ONLY (SH-AUDIT-B0-U5-F). The executor campaign's handler on the factory's box 0, started at Closed so
/// `graduate()` happens inside the run: random budget funding (`fundBudget`, `receive`, forced ETH, `payFit`), gifts of
/// T, pokes, executions by any caller with any `maxChunks`, price pushes both ways, batches, deepen, idle blocks and
/// time jumps. Every call is fail-safe; the ghosts record what must never happen, and its own ghost ledger books every
/// wei and T unit that crosses the system's boundary (the world's totals seeded at the hand-over).
contract AuditU5FableExecutorHandler is CommonBase, StdCheats, StdUtils, AuditGhostLedger {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using AuditU5FableExecLogs for VmSafe.Log[];

    struct World {
        IPoolManager pm;
        FitBuybackExecutor x;
        BoxToken t;
        BoxReceiver receiver;
        BoxHook hook;
        BoxCoordinator coordinator;
        AuditRouterSwapper swapper;
        PoolKey key;
        int24 p1;
        int24 p0;
        address keeper;
        address[] actors;
        address[] system;
        address[] outside;
        uint256 ethIn;
        uint256 ethOut;
        uint256 tIn;
        uint256 tOut;
        address weth;
    }

    IPoolManager internal pm;
    FitBuybackExecutor internal x;
    BoxToken internal t;
    BoxReceiver internal receiver;
    BoxHook internal hook;
    BoxCoordinator internal coordinator;
    AuditRouterSwapper internal swapper;
    PoolKey internal key;
    PoolId internal pid;
    AuditU5FableReads.Positions internal pos;
    address internal keeper;
    address[] internal actors;

    // ------------------------------------------------------------------ ghosts (must stay zero)
    uint256 public executeReverted;
    uint256 public spentBeforeGraduation;
    uint256 public chunkBlockViolations;
    uint256 public chunkBoundViolations;
    uint256 public floorViolations;
    uint256 public feeBoundViolations;
    uint256 public ethPathViolations;
    uint256 public sampleViolations;
    uint256 public supplyRose;
    uint256 public payeeViolations;
    bytes public lastUnexpected;

    // ------------------------------------------------------------------ ghosts (books)
    uint256 public credited;
    uint256 public forced;
    uint256 public giftedUnburned;
    uint256 public burnedByEvents;
    uint256 public spentByEvents;
    uint64 internal lastChunkBlock;
    bool internal anyChunk;
    int24 internal lastSample;
    uint32 internal lastSampleTime;
    uint256 internal lastSupply;

    // ------------------------------------------------------------------ coverage
    mapping(string => uint256) public calls;
    mapping(string => uint256) public oks;

    constructor(World memory w) {
        pm = w.pm;
        x = w.x;
        t = w.t;
        receiver = w.receiver;
        hook = w.hook;
        coordinator = w.coordinator;
        swapper = w.swapper;
        key = w.key;
        pid = w.key.toId();
        pos = AuditU5FableReads.Positions(w.p1, w.p0);
        keeper = w.keeper;
        actors = w.actors;
        for (uint256 i; i < w.system.length; ++i) {
            _ghostAddSystem(w.system[i]);
        }
        for (uint256 i; i < w.outside.length; ++i) {
            _ghostAddOutside(w.outside[i]);
        }
        _ghostAddOutside(address(this));
        _ghostToken = address(w.t);
        _ghostWeth = w.weth;
        (_ghostEthInTotal, _ghostEthOutTotal, _ghostTInTotal, _ghostTOutTotal) = (w.ethIn, w.ethOut, w.tIn, w.tOut);
        FitBuybackExecutor.Oracle memory o = x.oracle();
        lastSample = o.tick;
        lastSampleTime = o.time;
        lastSupply = t.totalSupply();
    }

    // ================================================================== budget intake

    /// `fundBudget` or a plain value call (`receive`) by an actor: credited whole.
    function fundBudget(uint256 who, uint256 amount, bool raw) external {
        calls["fundBudget"]++;
        address actor = actors[who % actors.length];
        amount = bound(amount, 0, 5 ether);
        vm.deal(actor, actor.balance + amount);
        uint256 e0 = actor.balance;
        bool ok;
        vm.prank(actor);
        if (raw) {
            (ok,) = address(x).call{value: amount}("");
        } else {
            try x.fundBudget{value: amount}() {
                ok = true;
            } catch {}
        }
        if (ok) {
            credited += amount;
            oks["fundBudget"]++;
        }
        _noteEthChange(e0, actor.balance, EthIn.FundBudget, EthOut.Other);
        _afterAny();
    }

    /// ETH forced onto the executor (no code runs): budget, never credited.
    function forceEth(uint256 amount) external {
        calls["forceEth"]++;
        amount = bound(amount, 0, 1 ether);
        vm.deal(address(x), address(x).balance + amount);
        forced += amount;
        _noteEthIn(EthIn.Forced, amount);
        oks["forceEth"]++;
        _afterAny();
    }

    /// T sent to the executor by this contract (bought first): unsolicited, burned at the next execution.
    function giftT(uint256 amount) external {
        calls["giftT"]++;
        uint256 held = t.balanceOf(address(this));
        if (held == 0) return;
        amount = bound(amount, 1, held);
        uint256 b0 = t.balanceOf(address(this));
        require(t.transfer(address(x), amount), "gift");
        _noteTChange(b0, t.balanceOf(address(this)), TIn.Direct, TOut.Other);
        giftedUnburned += amount;
        oks["giftT"]++;
        _afterAny();
    }

    /// The receiver's batch and FIT share into the budget (an inside move for the ETH ledger; the tip leaves).
    function collectAndPayFit() external {
        calls["collectAndPayFit"]++;
        uint256 k0 = keeper.balance;
        vm.prank(keeper);
        try receiver.collect(keeper) {
            oks["collectAndPayFit"]++;
        } catch (bytes memory e) {
            if (bytes4(e) != IBoxReceiver.BatchTooSmall.selector) lastUnexpected = e;
        }
        _noteEthChange(k0, keeper.balance, EthIn.Other, EthOut.Tip);
        uint256 x0 = address(x).balance;
        vm.prank(keeper);
        try receiver.payFit() returns (uint256 amount) {
            credited += amount;
            require(address(x).balance == x0 + amount, "payFit credited whole");
        } catch {}
        _afterAny();
    }

    // ================================================================== the executor

    function poke(uint256 who) external {
        calls["poke"]++;
        address actor = actors[who % actors.length];
        vm.recordLogs();
        vm.prank(actor);
        try x.poke() {
            oks["poke"]++;
        } catch (bytes memory e) {
            lastUnexpected = e;
            ++executeReverted;
        }
        _checkSamples(vm.getRecordedLogs().decode(address(x)));
        _afterAny();
    }

    function execute(uint256 who, uint256 maxChunks) external {
        calls["execute"]++;
        address actor = actors[who % actors.length];
        maxChunks = bound(maxChunks, 0, 5);
        bool graduated = coordinator.graduated();
        uint256 budgetBefore = x.budget();
        uint256 pmEth0 = address(pm).balance;
        uint256 xEth0 = address(x).balance;
        uint256 supply0 = t.totalSupply();
        uint256 actor0 = actor.balance;
        (uint256 owed0Before,) = AuditU5FableReads.uncollected(pm, pid, address(hook), pos);
        vm.recordLogs();
        vm.prank(actor);
        try x.execute(maxChunks) returns (uint256 c, uint256 spent, uint256 burned) {
            AuditU5FableExecLogs.ExecLog memory e = vm.getRecordedLogs().decode(address(x));
            oks["execute"]++;
            if (!e.seen || e.chunks != c || e.ethSpent != spent || e.fitBurned != burned) ++ethPathViolations;
            spentByEvents += spent;
            burnedByEvents += burned;
            if (!graduated && (spent != 0 || c != 0)) ++spentBeforeGraduation;
            if (c > 1 || e.chunkEvents != c) ++chunkBoundViolations;
            if (c == 1) {
                if (anyChunk && lastChunkBlock == uint64(vm.getBlockNumber())) ++chunkBlockViolations;
                lastChunkBlock = uint64(vm.getBlockNumber());
                anyChunk = true;
                int24 tb = TickMath.getTickAtSqrtPrice(e.lastSqrtBefore);
                int24 ta = TickMath.getTickAtSqrtPrice(e.lastSqrtAfter);
                if (int256(tb) - int256(ta) > int256(BoxSpecV1.EXECUTOR_MAX_IMPACT_TICKS)) ++chunkBoundViolations;
                if (e.lastSqrtAfter < e.lastLimit || e.lastLimit < e.floorSqrt) ++chunkBoundViolations;
                if (e.floorSqrt != AuditU5FableExecLogs.expectedFloor(x.latestSampleTick(), e.twapTick)) {
                    ++floorViolations;
                }
                if (spent > budgetBefore) ++ethPathViolations;
                (uint256 owed0After,) = AuditU5FableReads.uncollected(pm, pid, address(hook), pos);
                uint256 earned = owed0After - owed0Before;
                if (e.feeReported > earned) ++feeBoundViolations;
                if (e.feeReported + 16 < earned) ++feeBoundViolations;
            } else if (e.feeReported != 0) {
                ++feeBoundViolations;
            }
            // ETH: the executor lost exactly what the PoolManager gained; the caller got nothing.
            if (address(pm).balance != pmEth0 + spent || xEth0 != address(x).balance + spent) ++ethPathViolations;
            if (actor.balance != actor0) ++payeeViolations;
            // T: everything held was burned (bought plus gifts), nothing stays.
            if (t.balanceOf(address(x)) != 0) ++ethPathViolations;
            if (supply0 != t.totalSupply() + burned) ++ethPathViolations;
            if (e.unsolicitedBurned != giftedUnburned) ++ethPathViolations;
            giftedUnburned = 0;
            _checkSamples(e);
        } catch (bytes memory err) {
            ++executeReverted;
            lastUnexpected = err;
        }
        _afterAny();
    }

    // ================================================================== the price, time, graduation

    /// A trading actor: never the gas burner (a seller's ETH output would burn the whole call's gas in its receive).
    function _trader(uint256 who) internal view returns (address) {
        return actors[who % (actors.length - 1)];
    }

    function buy(uint256 who, uint256 amount) external {
        calls["buy"]++;
        address actor = _trader(who);
        amount = bound(amount, 1e15, 3 ether);
        vm.deal(actor, actor.balance + amount);
        uint256 e0 = actor.balance;
        uint256 t0 = t.balanceOf(actor);
        vm.prank(actor);
        try swapper.swapOne{value: amount}(
            key, SwapParams(true, -int256(amount), TickMath.MIN_SQRT_PRICE + 1), "", actor
        ) {
            oks["buy"]++;
        } catch (bytes memory e) {
            lastUnexpected = e;
        }
        _noteEthChange(e0, actor.balance, EthIn.SwapIn, EthOut.SwapOut);
        _noteTChange(t0, t.balanceOf(actor), TIn.Sell, TOut.Buy);
        _afterAny();
    }

    function sell(uint256 who, uint256 frac) external {
        calls["sell"]++;
        address actor = _trader(who);
        uint256 held = t.balanceOf(actor);
        if (held == 0) return;
        uint256 amount = held * bound(frac, 1, 100) / 100;
        if (amount == 0) return;
        vm.prank(actor);
        t.approve(address(swapper), type(uint256).max);
        uint256 e0 = actor.balance;
        vm.prank(actor);
        try swapper.swapOne(key, SwapParams(false, -int256(amount), TickMath.MAX_SQRT_PRICE - 1), "", actor) {
            oks["sell"]++;
        } catch (bytes memory e) {
            lastUnexpected = e;
        }
        _noteEthChange(e0, actor.balance, EthIn.SwapIn, EthOut.SwapOut);
        _noteTChange(held, t.balanceOf(actor), TIn.Sell, TOut.Buy);
        _afterAny();
    }

    /// Up to 200 blocks of 12 s, the keeper poking every tenth block.
    function hold(uint256 blocks, bool withPokes) external {
        calls["hold"]++;
        blocks = bound(blocks, 1, 200);
        for (uint256 b; b < blocks; b += 10) {
            uint256 step = blocks - b < 10 ? blocks - b : 10;
            vm.roll(vm.getBlockNumber() + step);
            vm.warp(vm.getBlockTimestamp() + 12 * step);
            if (withPokes) {
                vm.recordLogs();
                vm.prank(keeper);
                try x.poke() {} catch {}
                _checkSamples(vm.getRecordedLogs().decode(address(x)));
            }
        }
        oks["hold"]++;
        _afterAny();
    }

    /// Up to 40 days at once (new platform epochs), then one sample.
    function jump(uint256 secs) external {
        calls["jump"]++;
        secs = bound(secs, 1 hours, 40 days);
        vm.warp(vm.getBlockTimestamp() + secs);
        vm.roll(vm.getBlockNumber() + secs / 12);
        vm.recordLogs();
        vm.prank(keeper);
        try x.poke() {} catch {}
        _checkSamples(vm.getRecordedLogs().decode(address(x)));
        oks["jump"]++;
        _afterAny();
    }

    function deepen() external {
        calls["deepen"]++;
        uint256 k0 = keeper.balance;
        vm.recordLogs();
        vm.prank(keeper);
        try hook.deepen(keeper) {
            oks["deepen"]++;
        } catch (bytes memory e) {
            lastUnexpected = e;
        }
        _checkSamples(vm.getRecordedLogs().decode(address(x)));
        _noteEthChange(k0, keeper.balance, EthIn.Other, EthOut.Tip);
        _afterAny();
    }

    function fundDepth(uint256 amount) external {
        calls["fundDepth"]++;
        amount = bound(amount, 0, 2 ether);
        vm.deal(address(this), address(this).balance + amount);
        uint256 e0 = address(this).balance;
        try receiver.fundDepth{value: amount}() {
            oks["fundDepth"]++;
        } catch {}
        _noteEthChange(e0, address(this).balance, EthIn.FundDepth, EthOut.Other);
        _afterAny();
    }

    /// `graduate()` by any actor once the curve is closed (it is, from the start): must never be refused.
    function graduate(uint256 who) external {
        calls["graduate"]++;
        if (coordinator.graduated()) return;
        address actor = actors[who % actors.length];
        vm.recordLogs();
        vm.prank(actor);
        try coordinator.graduate() {
            oks["graduate"]++;
        } catch (bytes memory e) {
            lastUnexpected = e;
            ++executeReverted;
        }
        _checkSamples(vm.getRecordedLogs().decode(address(x)));
        _afterAny();
    }

    // ================================================================== bookkeeping

    /// One sample per timestamp, each within 100 ticks of the previous one.
    function _checkSamples(AuditU5FableExecLogs.ExecLog memory e) internal {
        if (e.observed > 1) ++sampleViolations;
        FitBuybackExecutor.Oracle memory o = x.oracle();
        if (o.time != lastSampleTime) {
            if (o.time < lastSampleTime) ++sampleViolations;
            int256 d = int256(o.tick) - int256(lastSample);
            if (d > 100 || d < -100) ++sampleViolations;
            if (e.observed != 1) ++sampleViolations;
        } else if (o.tick != lastSample || e.observed != 0) {
            ++sampleViolations;
        }
        lastSample = o.tick;
        lastSampleTime = o.time;
    }

    function _afterAny() internal {
        uint256 s = t.totalSupply();
        if (s > lastSupply) ++supplyRose;
        lastSupply = s;
    }

    function ghostBalanced() external view returns (bool ethOk, bool tOk) {
        (ethOk,,,) = _ghostEthBalanced();
        (tOk,,,) = _ghostTBalanced();
    }

    receive() external payable {}
}

/// @title AuditU5FableExecutorInvariants
/// @notice SH-AUDIT-B0-U5-F: the executor's invariant campaign on the factory's box 0 (plan § 6 item 3, unit brief
/// P5.1, P5.2, P5.6, P5.9, P5.11): budget == balance; balance == credited + forced − spent; T held only when gifted;
/// burn-only; one chunk per block within 49 ticks and above the floor; the fee report a lower bound; ETH leaves only
/// to the PoolManager; nothing before graduation; execute never reverts; samples bounded; the ghost ledger.
/// forge-config: default.evm_version = "osaka"
contract AuditU5FableExecutorInvariants is AuditU5FableBase {
    AuditU5FableExecutorHandler internal h;

    function setUp() public override {
        super.setUp();
        _toClosed();
        address[] memory actors = new address[](9);
        for (uint256 i; i < 6; ++i) {
            actors[i] = eoa[i];
        }
        actors[6] = address(contractDrawer);
        actors[7] = eoa7702;
        actors[8] = address(gasBurner);
        (uint256 ethIn, uint256 ethOut, uint256 tIn, uint256 tOut) = ghostTotals();
        h = new AuditU5FableExecutorHandler(
            AuditU5FableExecutorHandler.World({
                pm: pm,
                x: executor,
                t: token,
                receiver: receiver,
                hook: hook,
                coordinator: coordinator,
                swapper: routerSwapper,
                key: poolKey,
                p1: curve.tickLower,
                p0: curve.tickUpper,
                keeper: keeper,
                actors: actors,
                system: ghostSystem(),
                outside: ghostOutside(),
                ethIn: ethIn,
                ethOut: ethOut,
                tIn: tIn,
                tOut: tOut,
                weth: a.weth
            })
        );
        // The handler holds T for gifts (a plain transfer between outside holders, after its creation: a pranked
        // address gets a nonce in forge, so it cannot be created at later).
        _ghostAddOutside(address(h));
        _transferT(eoa[2], address(h), 5e22);
        targetContract(address(h));
    }

    function invariant_AUDIT_U5_executorBudgetIsItsBalance() public view {
        assertEq(executor.budget(), a.executor.balance, "budget == balance");
    }

    function invariant_AUDIT_U5_executorBalanceIsCreditedPlusForcedLessSpent() public view {
        assertEq(a.executor.balance + executor.totalEthSpent(), h.credited() + h.forced(), "balance + spent == in");
        assertEq(executor.totalToBudget(), h.credited(), "totalToBudget books the credited value only");
        assertEq(executor.totalEthSpent(), h.spentByEvents(), "spent == the Executed events' sum");
    }

    function invariant_AUDIT_U5_executorHoldsOnlyUnsolicitedT() public view {
        assertEq(token.balanceOf(a.executor), h.giftedUnburned(), "T held == gifts since the last execution");
    }

    function invariant_AUDIT_U5_executorBurnOnly() public view {
        assertEq(executor.totalBurned(), h.burnedByEvents(), "burned == the events' sum");
        assertGe(BoxSpecV1.ISSUANCE - token.totalSupply(), executor.totalBurned(), "the supply fell by at least it");
        assertEq(h.supplyRose(), 0, "the supply never rose");
    }

    function invariant_AUDIT_U5_executeNeverReverts() public view {
        assertEq(h.executeReverted(), 0, "execute, poke and graduate never reverted");
    }

    function invariant_AUDIT_U5_nothingBeforeGraduation() public view {
        assertEq(h.spentBeforeGraduation(), 0, "no chunk before graduation");
    }

    function invariant_AUDIT_U5_oneChunkPerBlockWithinBounds() public view {
        assertEq(h.chunkBlockViolations(), 0, "one chunk per block");
        assertEq(h.chunkBoundViolations(), 0, "49 ticks, above the limit and the floor");
        assertEq(h.floorViolations(), 0, "the floor is max(sample, twap) - 99 ticks");
    }

    function invariant_AUDIT_U5_feeReportIsALowerBound() public view {
        assertEq(h.feeBoundViolations(), 0, "reported <= the positions' LP fee, within 16 raw units of it");
    }

    function invariant_AUDIT_U5_ethLeavesOnlyToThePool() public view {
        assertEq(h.ethPathViolations(), 0, "ETH to the PoolManager only, T burned whole");
        assertEq(h.payeeViolations(), 0, "no caller is paid");
    }

    function invariant_AUDIT_U5_sampleBounds() public view {
        assertEq(h.sampleViolations(), 0, "one sample per timestamp, within 100 ticks");
    }

    function invariant_AUDIT_U5_executorGhostLedger() public view {
        (bool ethOk, bool tOk) = h.ghostBalanced();
        assertTrue(ethOk, "system ETH == booked in - booked out");
        assertTrue(tOk, "outside T == booked out - booked in");
        assertEq(token.totalSupply() + token.totalBurned(), BoxSpecV1.ISSUANCE);
    }

    /// Coverage (reported, not an invariant): a scripted run of 500 pseudo-random handler calls; every action must
    /// have succeeded at least once, and the ghosts hold at the end.
    function testProperty_AUDIT_U5_executorHandlerCoverage() public {
        string[12] memory names = [
            "fundBudget",
            "forceEth",
            "giftT",
            "collectAndPayFit",
            "poke",
            "execute",
            "buy",
            "sell",
            "hold",
            "jump",
            "deepen",
            "graduate"
        ];
        for (uint256 i; i < 500; ++i) {
            uint256 r = uint256(keccak256(abi.encode("audit.u5.executor.coverage", i)));
            uint256 op = r % 100;
            if (op < 10) h.fundBudget(r >> 8, r >> 16, (r >> 24) & 1 == 1);
            else if (op < 13) h.forceEth(r >> 8);
            else if (op < 16) h.giftT(r >> 8);
            else if (op < 24) h.collectAndPayFit();
            else if (op < 32) h.poke(r >> 8);
            else if (op < 55) h.execute(r >> 8, r >> 16);
            else if (op < 65) h.buy(r >> 8, r >> 16);
            else if (op < 75) h.sell(r >> 8, r >> 16);
            else if (op < 85) h.hold(r >> 8, (r >> 24) & 1 == 1);
            else if (op < 88) h.jump(r >> 8);
            else if (op < 93) h.deepen();
            else if (op < 95) h.fundDepth(r >> 8);
            else h.graduate(r >> 8);
        }
        for (uint256 i; i < 12; ++i) {
            emit log_named_uint(string.concat(names[i], " calls"), h.calls(names[i]));
            emit log_named_uint(string.concat(names[i], " successes"), h.oks(names[i]));
            assertGt(h.oks(names[i]), 0, "every action succeeded at least once");
        }
        invariant_AUDIT_U5_executorBudgetIsItsBalance();
        invariant_AUDIT_U5_executorBalanceIsCreditedPlusForcedLessSpent();
        invariant_AUDIT_U5_executorHoldsOnlyUnsolicitedT();
        invariant_AUDIT_U5_executorBurnOnly();
        invariant_AUDIT_U5_executeNeverReverts();
        invariant_AUDIT_U5_nothingBeforeGraduation();
        invariant_AUDIT_U5_oneChunkPerBlockWithinBounds();
        invariant_AUDIT_U5_feeReportIsALowerBound();
        invariant_AUDIT_U5_ethLeavesOnlyToThePool();
        invariant_AUDIT_U5_sampleBounds();
        invariant_AUDIT_U5_executorGhostLedger();
        assertTrue(coordinator.graduated(), "graduated inside the run");
        assertGt(executor.totalEthSpent(), 0, "bought");
    }
}
