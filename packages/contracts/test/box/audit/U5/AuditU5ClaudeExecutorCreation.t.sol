// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {FitBuybackExecutor, IBurnableToken} from "../../../../src/box/FitBuybackExecutor.sol";
import {EthIn} from "../common/AuditGhostLedger.sol";
import {AuditU5ClaudeBase} from "./AuditU5ClaudeBase.sol";

/// @title AuditU5ClaudeExecutorCreationTest
/// @notice SH-AUDIT-B0 U5 (Claude): FIT's executor from box 0's creation to its graduation, on the factory's box 0 as
/// the shared world creates it (before the open). The deployment lens (L8: the code the factory pinned, the wiring,
/// the seed) and the pre-graduation rules: nothing bought before graduation whatever the budget (BC-020), every
/// call answers, and the curve-time samples, which do count (the keeper duty SH-misfits-line.md:428-432 records).
/// forge-config: default.evm_version = "osaka"
contract AuditU5ClaudeExecutorCreationTest is AuditU5ClaudeBase {
    using PoolIdLibrary for PoolKey;

    // ================================================================================================ L8

    /// P5.16 (BoxFactoryV1.sol:228-236, :451-467; BC-063, BC-064): FIT's executor is the code the factory pinned by
    /// hash (`executorInitCodeHash` = keccak256 of FitBuybackExecutor's creation code), its runtime is byte for byte a
    /// fresh deployment's with the same constructor arguments, and it names box 0's PoolManager, T, coordinator (as
    /// its launch phase), hook and receiver; its pool id is box 0's key's, its bounds are the version's, and its first
    /// sample is P1 (the curve's lower tick, the Misfits-line #4 fix), stamped at creation, with no budget.
    function testProperty_AUDIT_U5_executorIsThePinnedCodeWiredToBox0() public {
        assertEq(factory.executorInitCodeHash(), keccak256(type(FitBuybackExecutor).creationCode), "the pinned code");
        FitBuybackExecutor twin =
            new FitBuybackExecutor(pm, IBurnableToken(a.token), a.coordinator, a.hook, a.receiver, curve.tickLower);
        assertEq(a.executor.code, address(twin).code, "the runtime of the pinned code with box 0's arguments");
        assertEq(address(executor.poolManager()), address(pm));
        assertEq(address(executor.token()), a.token);
        assertEq(executor.launchPhase(), a.coordinator);
        assertEq(executor.hooks(), a.hook);
        assertEq(executor.receiver(), a.receiver);
        assertEq(coordinator.executor(), a.executor, "the coordinator names it");
        assertEq(receiver.executor(), a.executor, "the receiver pays it");
        assertEq(address(hook.priceAverage()), a.executor, "box 0's hook reads its average");
        PoolKey memory k = executor.poolKey();
        assertEq(Currency.unwrap(k.currency0), address(0), "native ETH");
        assertEq(Currency.unwrap(k.currency1), a.token);
        assertEq(k.fee, BoxSpecV1.LP_FEE);
        assertEq(k.tickSpacing, BoxSpecV1.TICK_SPACING);
        assertEq(address(k.hooks), a.hook);
        assertEq(executor.poolId(), PoolId.unwrap(poolKey.toId()), "box 0's pool");
        assertEq(executor.MAX_IMPACT_TICKS(), 49);
        assertEq(executor.TWAP_BAND_TICKS(), 99);
        assertEq(executor.MAX_OBSERVATION_STEP(), 100);
        assertEq(executor.MAX_CHUNKS_PER_BLOCK(), 1);
        assertEq(executor.TWAP_WINDOW(), 3_600);
        assertEq(executor.MIN_SQRT_PRICE_X96(), BoxSpecV1.EXECUTOR_MIN_SQRT_PRICE_X96);
        FitBuybackExecutor.Oracle memory o = executor.oracle();
        assertEq(o.tick, curve.tickLower, "seeded at P1");
        assertEq(curve.tickLower, curve.tickEnd, "P1 is the graduation edge");
        assertEq(o.time, createdAt, "stamped at creation");
        assertEq(o.filled, 1);
        assertEq(executor.checkpointAt(0).time, createdAt);
        assertEq(executor.budget(), 0);
        assertEq(executor.totalToBudget(), 0);
        assertFalse(executor.fitGraduated());
        assertFalse(executor.graduationSeen());
    }

    // ================================================================================================ pre-graduation

    /// BC-020 (IFitBuybackExecutor: "It buys nothing before box 0 graduates"): with any budget, at every phase before
    /// graduation (window, bonding, closed), `execute` answers `NotGraduated`, spends nothing and never reverts; FIT
    /// sent to it unasked is burned even then; the budget waits whole for graduation.
    function testFuzz_AUDIT_U5_nothingBoughtBeforeGraduation(uint256 budget, uint256 maxChunks, uint256 gift) public {
        budget = bound(budget, 0, 100 ether);
        gift = bound(gift, 0, 1_000 ether);
        if (budget != 0) _fundBudget(eoa[3], budget);
        for (uint256 p; p < 3; ++p) {
            if (p == 0) _toWindow();
            else if (p == 1) _toBonding();
            else _toClosed();
            if (gift != 0 && token.balanceOf(eoa[0]) >= gift) _transferT(eoa[0], a.executor, gift);
            uint256 supply0 = token.totalSupply();
            uint256 held = token.balanceOf(a.executor);
            vm.recordLogs();
            (bool ok, bytes memory ret) = a.executor.call(abi.encodeCall(FitBuybackExecutor.execute, (maxChunks)));
            assertTrue(ok, "never reverts");
            (uint256 chunks, uint256 spent, uint256 burned) = abi.decode(ret, (uint256, uint256, uint256));
            assertEq(chunks, 0);
            assertEq(spent, 0, "nothing bought");
            assertEq(burned, held, "only unasked FIT burned");
            assertEq(token.totalSupply(), supply0 - held);
            assertEq(executor.budget(), budget, "the budget waits whole");
            assertEq(executor.totalEthSpent(), 0);
            _assertStop(FitBuybackExecutor.Stop.NotGraduated);
            _advance(1);
        }
        assertFalse(executor.fitGraduated());
        _assertGhostLedger();
    }

    /// The last `Executed` event's stop reason.
    function _assertStop(FitBuybackExecutor.Stop want) internal view {
        bytes32 sel = FitBuybackExecutor.Executed.selector;
        uint256 seen;
        uint8 reason;
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.executor && logs[i].topics[0] == sel) {
                (,,,,,, FitBuybackExecutor.Stop r) = abi.decode(
                    logs[i].data, (uint256, uint256, uint256, uint256, int24, uint160, FitBuybackExecutor.Stop)
                );
                reason = uint8(r);
                ++seen;
            }
        }
        assertEq(seen, 1, "one Executed");
        assertEq(reason, uint8(want), "the stop reason");
    }

    /// The executor's samples before graduation count (FitBuybackExecutor.sol:366-386 has no graduation check, and
    /// `execute` samples before it checks graduation): pokes on the curve walk the sample up from P1 toward the curve's
    /// price at most 100 ticks a block, the 1-hour average follows, and after `graduate()` (which leaves the price at
    /// P1) both must walk back before the first buy. Pinned: the keeper duty recorded at SH-misfits-line.md:428-432
    /// ("If anyone poked the executor during the curve, its sample sits at that poke's curve price and the same loop
    /// walks it back at 100 ticks a block"); the walk back here and its length are logged, and `execute` neither
    /// reverts nor buys during it (`AtCeiling`).
    function testProperty_AUDIT_U5_curveTimeSamplesCountAndAreWalkedBack() public {
        _toBonding();
        int24 curveTick = _tick();
        int24 seed = executor.latestSampleTick();
        assertEq(seed, curve.tickLower, "still the seed");
        _sampledBlocks(300);
        int24 walked = executor.latestSampleTick();
        int24 expect = seed + 300 * 100 < curveTick ? seed + 300 * 100 : curveTick;
        assertEq(walked, expect, "the curve-time samples walked toward the curve's price");
        emit log_named_int("curve tick before the close", curveTick);
        emit log_named_int("sample after an hour of curve-time pokes", walked);
        _toClosed();
        _toGraduated();
        assertTrue(executor.fitGraduated());
        _payFit(keeper);
        _fundBudget(eoa[3], 1 ether);
        uint256 samples;
        uint256 chunks;
        while (chunks == 0 && samples < 2_000) {
            _advance(1);
            ++samples;
            (bool ok, bytes memory ret) = a.executor.call(abi.encodeCall(FitBuybackExecutor.execute, (1)));
            assertTrue(ok, "execute never reverts during the walk back");
            (chunks,,) = abi.decode(ret, (uint256, uint256, uint256));
        }
        emit log_named_uint("samples (one execute per block) from graduation to the first buy", samples);
        assertEq(chunks, 1, "it buys once both are back");
        uint256 walkBack = uint256(int256(walked - curve.tickLower) / 100);
        assertGt(samples, walkBack, "at least the sample's walk back");
        assertLe(samples, walkBack + 2 * 305, "within the walk plus about two windows of samples");
    }

    /// The same keeper duty at its worst: pokes early on the curve (in the window, the price still near the curve's
    /// start P0) walk the sample up to that price (at most 300 samples of 100 ticks) and leave it there until
    /// graduation. After `graduate()` the first buy then waits for the walk back and for the hour's average, about as
    /// long as the P0 seed made it wait before the Misfits-line #4 fix (the 576th sample there,
    /// SH-misfits-line.md:425). Logged; `execute` never reverts during it. The cost to whoever pokes is one `poke()` a
    /// block for up to an hour, any time before graduation.
    function testProperty_AUDIT_U5_earlyCurvePokesBringBackTheP0Walk() public {
        _toWindow();
        int24 curveTick = _tick();
        emit log_named_int("ticks from P1 to the window's price", curveTick - curve.tickLower);
        emit log_named_int("ticks from P1 to P0", curve.tickStart - curve.tickEnd);
        _sampledBlocks(300);
        int24 walked = executor.latestSampleTick();
        assertEq(walked, curveTick, "the samples reached the window's price");
        _toGraduated();
        (, int24 avg,) = executor.twap();
        emit log_named_int("ticks from P1 to the average at graduation", avg - curve.tickLower);
        assertGt(avg, walked - 100, "the average at graduation is still the early sample");
        _payFit(keeper);
        _fundBudget(eoa[3], 1 ether);
        uint256 samples;
        uint256 chunks;
        while (chunks == 0 && samples < 3_000) {
            _advance(1);
            ++samples;
            (bool ok, bytes memory ret) = a.executor.call(abi.encodeCall(FitBuybackExecutor.execute, (1)));
            assertTrue(ok, "execute never reverts during the walk back");
            (chunks,,) = abi.decode(ret, (uint256, uint256, uint256));
        }
        emit log_named_uint("samples (one execute per block) from graduation to the first buy", samples);
        assertEq(chunks, 1, "it buys once both are back");
        uint256 walkBack = uint256(int256(walked - curve.tickLower) / 100);
        assertGt(samples, walkBack, "at least the sample's walk back");
        assertLe(samples, walkBack + 2 * 305, "within the walk plus about two windows of samples");
    }

    /// The control for the walk back: with no curve-time poke the sample is P1 at graduation, the average is P1, and a
    /// budget above one batch buys in graduate()'s own block (the Misfits-line #4 fix).
    function testProperty_AUDIT_U5_noCurveTimePokeBuysAtGraduation() public {
        _toGraduated();
        assertEq(executor.latestSampleTick(), _tick(), "sampled at P1 by graduate()'s poke");
        (, int24 avg,) = executor.twap();
        assertEq(avg, curve.tickLower, "the average is P1");
        _payFit(keeper);
        (uint256 chunks,,) = executor.execute(1);
        assertEq(chunks, 1, "the first batch buys at once");
    }

    /// `fundBudget` and `receive` accept ETH before graduation, credited whole (BC-108), and the budget is spent only
    /// after it. One `execute` on the curve (anyone's, a day before graduation here) buys nothing, but it samples: its
    /// sample, 100 ticks above P1, then holds until graduation, so at graduation the 1-hour average is that sample (the
    /// average of the newest checkpoint older than an hour, held a day), and the first buy waits until the average has
    /// an hour of post-graduation samples (logged): one curve-time call is enough to delay FIT's first buy by about an
    /// hour, the documented keeper duty's case (SH-misfits-line.md:428-432).
    function testProperty_AUDIT_U5_budgetBeforeGraduationWaits() public {
        _toBonding();
        _fundBudget(eoa[3], 0.5 ether);
        vm.deal(eoa[4], 0.25 ether);
        vm.prank(eoa[4]);
        (bool ok,) = a.executor.call{value: 0.25 ether}("");
        assertTrue(ok);
        _noteEthIn(EthIn.FundBudget, 0.25 ether);
        assertEq(executor.budget(), 0.75 ether);
        assertEq(executor.totalToBudget(), 0.75 ether);
        int24 seed = executor.latestSampleTick();
        (uint256 chunks,,) = executor.execute(5);
        assertEq(chunks, 0, "nothing bought before graduation");
        assertEq(executor.latestSampleTick(), seed + 100, "but the call sampled the curve");
        _toGraduated();
        (, int24 avg,) = executor.twap();
        assertEq(avg, seed + 100, "the average at graduation is that one sample, held a day");
        (chunks,,) = executor.execute(1);
        assertEq(chunks, 0, "so graduate()'s own block buys nothing");
        uint256 samples;
        while (chunks == 0 && samples < 1_000) {
            _advance(1);
            ++samples;
            (chunks,,) = executor.execute(1);
        }
        emit log_named_uint("samples from graduation to the first buy after one curve-time execute", samples);
        assertEq(chunks, 1, "spent after graduation");
        assertEq(executor.budget() + executor.totalEthSpent(), 0.75 ether);
        _assertGhostLedger();
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU5ClaudeExecutorCreationAmsterdamTest is AuditU5ClaudeExecutorCreationTest {}
