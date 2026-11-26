// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {EthIn} from "../common/AuditGhostLedger.sol";
import {AuditU5ClaudeBase} from "./AuditU5ClaudeBase.sol";

interface IOwned {
    function owner() external view returns (address);
}

interface IProtocolFees {
    function setProtocolFeeController(address controller) external;
    function setProtocolFee(PoolKey memory key, uint24 newProtocolFee) external;
}

/// @notice TEST ONLY. Where the re-entering stand-in records what it saw (its own storage would be the receiver's).
contract AuditU5ClaudeReentryRecorder {
    bytes4 public executeErr;
    bytes4 public pokeErr;
    bytes4 public fundErr;
    bool public receiveOk;
    uint256 public notes;

    function record(bytes4 e, bytes4 p, bytes4 f, bool r) external {
        (executeErr, pokeErr, fundErr, receiveOk) = (e, p, f, r);
        ++notes;
    }
}

/// @notice TEST ONLY. A stand-in for box 0's receiver (put at its address with `vm.etch` for one call): its
/// `noteModuleFees` re-enters the executor that is calling it, through every entry point, and records each answer.
/// Used only to show the executor's lock (P5.8); box 0's real receiver never calls back.
contract AuditU5ClaudeReenteringReceiver {
    FitBuybackExecutor internal immutable x;
    AuditU5ClaudeReentryRecorder internal immutable rec;

    constructor(FitBuybackExecutor x_, AuditU5ClaudeReentryRecorder rec_) {
        x = x_;
        rec = rec_;
    }

    function noteModuleFees(uint256, uint256) external {
        bytes4 e;
        bytes4 p;
        bytes4 f;
        try x.execute(1) {}
        catch (bytes memory err) {
            e = bytes4(err);
        }
        try x.poke() {}
        catch (bytes memory err) {
            p = bytes4(err);
        }
        try x.fundBudget{value: 1}() {}
        catch (bytes memory err) {
            f = bytes4(err);
        }
        (bool r,) = address(x).call{value: 1}("");
        rec.record(e, p, f, r);
    }

    receive() external payable {}
}

/// @notice TEST ONLY. Unlocks the PoolManager itself and, inside its own callback, calls FIT's executor's
/// `unlockCallback` (the only way a caller other than the executor gets a PoolManager callback context).
contract AuditU5ClaudeForeignUnlocker is IUnlockCallback {
    IPoolManager internal immutable pm;
    FitBuybackExecutor internal immutable x;
    bytes public answer;

    constructor(IPoolManager pm_, FitBuybackExecutor x_) {
        pm = pm_;
        x = x_;
    }

    function run(bytes calldata data) external {
        pm.unlock(data);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        try x.unlockCallback(data) {}
        catch (bytes memory e) {
            answer = e;
        }
        return "";
    }
}

/// @notice A contract that pays FIT's executor with a 2,300-gas stipend (Solidity's `transfer`/`send`) and with all
/// its gas.
contract AuditU5ClaudeStipendPayer {
    function sendStipend(address payable to, uint256 v) external returns (bool) {
        return to.send(v);
    }

    function callWithGas(address to, uint256 v, uint256 g) external returns (bool ok) {
        (ok,) = to.call{value: v, gas: g}("");
    }

    receive() external payable {}
}

/// @title AuditU5ClaudeExecutorTest
/// @notice SH-AUDIT-B0 U5 (Claude), FIT's buy-back executor (`src/box/FitBuybackExecutor.sol`) on the factory's box 0
/// right after `graduate()` (the shared world's `_toGraduated`: every poke succeeded, the 1-hour average ready on the
/// executor's creation checkpoint, the sample at P1, 0.0302 ETH of FIT's share owed in the receiver). Lenses L1-L7 of
/// the U5 brief; the deployment pins (L8) and the curve-time behaviour are in `AuditU5ClaudeExecutorCreation.t.sol`.
/// forge-config: default.evm_version = "osaka"
contract AuditU5ClaudeExecutorTest is AuditU5ClaudeBase {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint256 internal constant PIPS = 1_000_000;
    /// FitBuybackExecutor `_maxSwapSteps`: 49 / 60 + 4.
    uint256 internal constant MAX_STEPS = 4;

    function setUp() public override {
        super.setUp();
        _toGraduated();
    }

    // ================================================================================================ L1

    /// P5.1 (FitBuybackExecutor.sol:30-33, :318-321; BC-108; F67 (2)): the budget is the ETH balance, whatever the
    /// route: `fundBudget()`, `receive()` with all gas and forced ETH (no code runs) all count, and only the first two
    /// count in `totalToBudget`. The batch threshold and the chunk use that same quantity: a credited budget below
    /// the threshold waits (`BelowBatch`), and forced ETH alone lifts it over and is then spent like any other.
    function testProperty_AUDIT_U5_budgetIsTheBalanceForcedEthIncluded() public {
        uint256 threshold = executor.batchThreshold();
        assertGt(threshold, 0, "the average is ready at graduation");
        _fundBudget(eoa[3], threshold / 2);
        AuditU5ClaudeStipendPayer payer = new AuditU5ClaudeStipendPayer();
        _ghostAddOutside(address(payer));
        vm.deal(address(payer), threshold / 4);
        assertTrue(payer.callWithGas(a.executor, threshold / 4, 100_000), "receive() with gas credits");
        _noteEthIn(EthIn.FundBudget, threshold / 4);
        assertEq(executor.totalToBudget(), threshold / 2 + threshold / 4, "both credited routes");
        assertEq(executor.budget(), a.executor.balance, "budget == balance");
        (uint256 chunks, uint256 spent,) = executor.execute(1);
        assertEq(chunks, 0, "below one batch: waits");
        assertEq(spent, 0);
        // Forced ETH: counted in the budget (the balance), not in totalToBudget.
        _forceEth(a.executor, threshold);
        assertEq(executor.budget(), threshold / 2 + threshold / 4 + threshold, "forced ETH is budget");
        assertEq(executor.totalToBudget(), threshold / 2 + threshold / 4, "and not credited intake");
        uint256 before = a.executor.balance;
        (chunks, spent,) = executor.execute(1);
        assertEq(chunks, 1, "the forced ETH lifted the budget over the threshold");
        assertGt(spent, 0);
        assertEq(a.executor.balance, before - spent, "the chunk spent from the same balance");
        assertEq(executor.budget(), a.executor.balance);
        assertEq(executor.totalEthSpent(), spent);
        _assertGhostLedger();
    }

    /// P5.1 (FitBuybackExecutor.sol:49, :308-312): ETH leaves the executor only as its swap's input, settled to the
    /// PoolManager inside its own unlock: over a whole `execute`, every value transfer the executor makes goes to the
    /// PoolManager and sums to `ethSpent`, and the PoolManager's balance rises by exactly that.
    function testProperty_AUDIT_U5_ethLeavesOnlyAsSwapInputToThePoolManager() public {
        _payFit(keeper);
        _fundBudget(eoa[3], 1 ether);
        uint256 pm0 = address(pm).balance;
        vm.startStateDiffRecording();
        (uint256 chunks, uint256 spent,) = executor.execute(1);
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        assertEq(chunks, 1);
        uint256 sent;
        for (uint256 i; i < acc.length; ++i) {
            if (acc[i].reverted || acc[i].value == 0) continue;
            if (acc[i].accessor == a.executor) {
                assertEq(acc[i].account, address(pm), "the executor pays only the PoolManager");
                sent += acc[i].value;
            }
            assertTrue(acc[i].account != address(0) && acc[i].account != safe, "nothing to the Safe or zero");
        }
        assertEq(sent, spent, "every wei it sent is its swap input");
        assertEq(address(pm).balance, pm0 + spent, "and settled in the PoolManager");
        _assertGhostLedger();
    }

    /// P5.1 (FitBuybackExecutor.sol:237-238, :513-524): every FIT a chunk buys is burned in the same call: T's supply
    /// falls by exactly `fitBurned`, which equals the FIT bought, and the executor holds no T after the call.
    function testProperty_AUDIT_U5_everyFitBoughtIsBurnedInTheSameCall() public {
        _payFit(keeper);
        uint256 supply0 = token.totalSupply();
        uint256 burned0 = executor.totalBurned();
        vm.recordLogs();
        (uint256 chunks,, uint256 burned) = executor.execute(1);
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        uint256 bought;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.executor && logs[i].topics[0] == FitBuybackExecutor.ChunkBought.selector) {
                (, uint256 fitOut,,,) = abi.decode(logs[i].data, (uint256, uint256, uint160, uint160, uint160));
                bought += fitOut;
            }
        }
        assertEq(chunks, 1);
        assertGt(bought, 0);
        assertEq(burned, bought, "burned exactly what it bought");
        assertEq(token.totalSupply(), supply0 - burned, "T's supply fell by it");
        assertEq(executor.totalBurned(), burned0 + burned);
        assertEq(token.balanceOf(a.executor), 0, "no T held after the call");
        _assertGhostLedger();
    }

    /// FIT sent to the executor (unsolicited) waits there until the next `execute`, which burns it with no buy
    /// (`TokensBurned(0, x)`): the executor's T balance is zero after every `execute`, not between a gift and it.
    function testProperty_AUDIT_U5_unsolicitedFitIsBurnedByTheNextExecute() public {
        uint256 gift = 123_456 ether;
        _transferT(eoa[2], a.executor, gift);
        assertEq(token.balanceOf(a.executor), gift, "held until an execute");
        uint256 supply0 = token.totalSupply();
        vm.expectEmit(true, true, true, true, a.executor);
        emit FitBuybackExecutor.TokensBurned(0, gift);
        (uint256 chunks, uint256 spent, uint256 burned) = executor.execute(0);
        assertEq(chunks, 0);
        assertEq(spent, 0);
        assertEq(burned, gift);
        assertEq(token.totalSupply(), supply0 - gift);
        assertEq(token.balanceOf(a.executor), 0);
        _assertGhostLedger();
    }

    /// BC-108, F67 (2): no treasury. ETH by `receive()` is credited whole; the treasury surface of the ancestor
    /// (BuybackBurner's `payTreasury`, `treasury`, `treasuryOwed`) does not exist, and the executor has no fallback, so
    /// any other call with data reverts and moves nothing.
    function testProperty_AUDIT_U5_noTreasuryNoPayee() public {
        vm.deal(eoa[3], 1 ether);
        vm.prank(eoa[3]);
        (bool ok,) = a.executor.call{value: 1 ether}("");
        assertTrue(ok);
        _noteEthIn(EthIn.FundBudget, 1 ether);
        assertEq(executor.budget(), 1 ether, "the whole amount");
        bytes4[4] memory gone = [
            bytes4(keccak256("payTreasury()")),
            bytes4(keccak256("treasury()")),
            bytes4(keccak256("treasuryOwed()")),
            bytes4(keccak256("sweep(address)"))
        ];
        for (uint256 i; i < gone.length; ++i) {
            vm.prank(eoa[5]);
            (ok,) = a.executor.call(abi.encodePacked(gone[i], bytes32(uint256(uint160(eoa[5])))));
            assertFalse(ok, "no such entry point");
        }
        vm.deal(eoa[5], 1);
        vm.prank(eoa[5]);
        (ok,) = a.executor.call{value: 1}(hex"deadbeef");
        assertFalse(ok, "no fallback");
        assertEq(executor.budget(), 1 ether);
        _assertGhostLedger();
    }

    /// P5.2 (BoxToken.sol:126-140; FitBuybackExecutor.sol:513-524): the executor burns without try/catch, so a refused
    /// burn would revert its whole `execute` (atomically: no ETH spent, the budget kept); the refusal is out of reach.
    /// T's floor is E + n and T's supply is E + every T outside the vault, so a burn of `x` is refused only when the T
    /// outside the vault other than the executor's is below n (at most 1,969 raw units). The PoolManager alone keeps
    /// the ask's T: after an absurd 5,000 ETH buy it still holds more than 10^25 raw units, and the executor's 49-tick
    /// chunk takes a vanishing part of it. Shown with the floor mocked to refuse (a stand-in for the unreachable
    /// state).
    function testProperty_AUDIT_U5_aRefusedBurnIsOutOfReach() public {
        // The refusal, mocked: execute reverts as a whole, nothing moves.
        _payFit(keeper);
        uint256 budget = executor.budget();
        vm.mockCall(a.vault, abi.encodeWithSignature("supplyFloor()"), abi.encode(type(uint256).max));
        vm.expectRevert();
        executor.execute(1);
        vm.clearMockedCalls();
        assertEq(executor.budget(), budget, "the budget is kept");
        (uint256 chunks,,) = executor.execute(1);
        assertEq(chunks, 1, "and spent once the floor allows the burn");
        // The real margin: supply − floor is T outside the vault less n, and the pool alone holds far more.
        _buy(eoa[4], 5_000 ether);
        uint256 pmT = token.balanceOf(address(pm));
        emit log_named_uint("PoolManager T after a 5,000 ETH buy (raw)", pmT);
        emit log_named_uint("supply - floor (raw)", token.totalSupply() - vault.supplyFloor());
        assertEq(vault.supplyFloor(), vault.escrowPrincipal() + vault.inside(), "floor = E + n");
        assertLe(vault.inside(), editionSize, "n <= 1,969");
        assertGt(pmT, 1e18 * editionSize, "the pool keeps the ask's T: above n by far more than 10^18 times");
        assertGt(token.totalSupply() - vault.supplyFloor(), pmT, "supply - floor exceeds all the pool's T");
    }

    // ================================================================================================ L2

    /// P5.6 (FitBuybackExecutor.sol:237-238): `execute` is anyone's and its progress does not depend on the caller:
    /// from the same state, the keeper's call and a random address's (EOA, contract, the receiver, the PoolManager)
    /// buy, spend, burn and sample the same.
    function testFuzz_AUDIT_U5_executeMakesTheSameProgressForAnyCaller(address caller, uint256 maxChunks) public {
        vm.assume(caller != address(0) && caller != a.executor);
        maxChunks = bound(maxChunks, 0, 3);
        _payFit(keeper);
        _advance(1);
        uint256 snap = vm.snapshotState();
        vm.prank(keeper);
        (uint256 c0, uint256 s0, uint256 b0) = executor.execute(maxChunks);
        FitBuybackExecutor.Oracle memory o0 = _oracle();
        uint256 bud0 = executor.budget();
        vm.revertToState(snap);
        vm.prank(caller);
        (uint256 c1, uint256 s1, uint256 b1) = executor.execute(maxChunks);
        FitBuybackExecutor.Oracle memory o1 = _oracle();
        assertEq(c1, c0, "chunks");
        assertEq(s1, s0, "spent");
        assertEq(b1, b0, "burned");
        assertEq(o1.tick, o0.tick, "sample");
        assertEq(executor.budget(), bud0, "budget");
    }

    /// P5.6: `poke` and `fundBudget` are anyone's and do the same for any caller.
    function testFuzz_AUDIT_U5_pokeAndFundBudgetAreAnyones(address caller, uint256 amount) public {
        vm.assume(caller != address(0) && caller != a.executor);
        amount = bound(amount, 1, 100 ether);
        _advance(1);
        vm.prank(caller);
        int24 t = executor.poke();
        assertEq(t, executor.latestSampleTick());
        vm.deal(caller, amount);
        vm.prank(caller);
        executor.fundBudget{value: amount}();
        assertEq(executor.budget(), amount);
        assertEq(executor.totalToBudget(), amount);
        _noteEthIn(EthIn.FundBudget, amount);
    }

    /// P5.8 (FitBuybackExecutor.sol:277-278): `unlockCallback` acts only inside the executor's own guarded unlock: any
    /// direct caller, and the PoolManager itself outside the executor's lock, is refused `NotPoolManager`.
    function testFuzz_AUDIT_U5_unlockCallbackOnlyInsideItsOwnUnlock(address caller, bytes calldata data) public {
        vm.prank(caller);
        vm.expectRevert(FitBuybackExecutor.NotPoolManager.selector);
        executor.unlockCallback(data);
        vm.prank(address(pm));
        vm.expectRevert(FitBuybackExecutor.NotPoolManager.selector);
        executor.unlockCallback(abi.encode(uint256(1), uint160(0), uint256(1 ether)));
    }

    /// P5.8: a contract that unlocks the PoolManager itself and calls the executor's callback from its own callback is
    /// refused (`msg.sender` is that contract): the PoolManager calls back only the account that unlocked it.
    function testProperty_AUDIT_U5_aForeignUnlockCannotDriveTheExecutor() public {
        _fundBudget(eoa[3], 1 ether);
        AuditU5ClaudeForeignUnlocker u = new AuditU5ClaudeForeignUnlocker(pm, executor);
        u.run(abi.encode(uint256(1), uint160(TickMath.MIN_SQRT_PRICE + 1), uint256(1 ether)));
        assertEq(bytes4(u.answer()), FitBuybackExecutor.NotPoolManager.selector);
        assertEq(executor.budget(), 1 ether, "nothing spent");
        assertEq(executor.totalEthSpent(), 0);
    }

    // ================================================================================================ L3

    /// P5.8 (TransientReentrancyGuard.sol:12-24): a re-entry from the receiver's `noteModuleFees` (a stand-in at the
    /// receiver's address: box 0's real receiver never calls back) meets the executor's lock on every entry point:
    /// `execute`, `poke`, `fundBudget` and `receive` each revert `Reentrancy()`, and the outer `execute` completes
    /// with one chunk only.
    function testProperty_AUDIT_U5_aReenteringReceiverMeetsTheLock() public {
        _payFit(keeper);
        bytes memory real = a.receiver.code;
        AuditU5ClaudeReentryRecorder r = new AuditU5ClaudeReentryRecorder();
        AuditU5ClaudeReenteringReceiver stand = new AuditU5ClaudeReenteringReceiver(executor, r);
        vm.etch(a.receiver, address(stand).code);
        vm.deal(a.receiver, 1 ether);
        (uint256 chunks,,) = executor.execute(1);
        assertEq(r.notes(), 1, "the note was made");
        bytes4 lock = bytes4(keccak256("Reentrancy()"));
        assertEq(r.executeErr(), lock, "execute");
        assertEq(r.pokeErr(), lock, "poke");
        assertEq(r.fundErr(), lock, "fundBudget");
        assertFalse(r.receiveOk(), "receive");
        assertEq(chunks, 1, "one chunk: the re-entry bought nothing");
        vm.etch(a.receiver, real);
        vm.deal(a.receiver, 0);
    }

    // ================================================================================================ L4

    /// P5.9 (FitBuybackExecutor.sol:366-386; IBoxPriceAverage `poke`): one sample per timestamp, and each sample moves
    /// at most MAX_OBSERVATION_STEP (100) ticks toward the pool's tick, whatever the push.
    function testFuzz_AUDIT_U5_oneSamplePerTimestampAtMost100Ticks(uint256 pushEth, uint8 pokes) public {
        pushEth = bound(pushEth, 0.001 ether, 20 ether);
        _buy(eoa[4], pushEth);
        int24 pool = _tick();
        for (uint256 b; b < 3; ++b) {
            _advance(1);
            int24 before = executor.latestSampleTick();
            uint256 k = bound(pokes, 1, 5);
            int24 first;
            for (uint256 i; i < k; ++i) {
                vm.prank(eoa[i % 8]);
                int24 got = executor.poke();
                if (i == 0) first = got;
                assertEq(got, first, "one sample per timestamp");
            }
            int24 step = first - before;
            assertLe(step < 0 ? -step : step, int24(100), "at most 100 ticks a sample");
            int24 want = pool < before - 100 ? before - 100 : (pool > before + 100 ? before + 100 : pool);
            assertEq(first, want, "toward the pool's tick, clamped");
        }
    }

    /// P5.9, derived bound: with an hour of samples at the price p0, a price held `b` blocks (12 s each) at any
    /// distance below p0, sampled every block, moves the 1-hour average by at most Σ_{k=1..b} 100·k·12 / 3600 =
    /// b(b+1)/6 ticks (plus 1 for the average's rounding up), and `execute` never pushes the price below
    /// max(sample, average) − 99 ticks nor more than 49 ticks in its chunk.
    function testFuzz_AUDIT_U5_heldPriceMovesTheAverageWithinTheDerivedBound(uint256 offsetTicks, uint256 blocks)
        public
    {
        offsetTicks = bound(offsetTicks, 1, 6_000);
        blocks = bound(blocks, 1, 40);
        _sampledBlocks(305); // an hour of samples at P1
        (, int24 avg0,) = executor.twap();
        int24 target = _tick() - int24(int256(offsetTicks));
        _pushTo(eoa[4], target);
        _sampledBlocks(blocks);
        (, int24 avg1,) = executor.twap();
        uint256 bound_ = blocks * (blocks + 1) / 6 + 1;
        int24 moved = avg0 - avg1;
        assertGe(moved, int24(0), "the average follows down only");
        assertLe(uint256(int256(moved)), bound_, "within b(b+1)/6 + 1 ticks");
        _payFit(keeper);
        _fundBudget(eoa[3], 10 ether);
        (uint160 floorSqrt,) = _execFloor();
        uint160 p0 = _sqrtPrice();
        int24 t0 = _tick();
        (uint256 chunks,,) = executor.execute(1);
        if (chunks == 0) {
            assertEq(_sqrtPrice(), p0, "no chunk: the price is the pusher's");
        } else {
            assertGe(_sqrtPrice(), floorSqrt, "never below the band");
            assertLe(t0 - _tick(), int24(50), "at most 49 ticks (one tick of v4's boundary convention)");
        }
        // Below the band (the push went further than the average's 99 ticks): the executor buys nothing.
        if (p0 < floorSqrt) assertEq(chunks, 0, "never chases a pushed price");
    }

    /// P5.9, the other side of "the reference only tightens" (FitBuybackExecutor.sol:501-504, the higher tick of the
    /// sample and the average): whoever takes a block's first sample with the price pushed up (T sold, cheaper FIT) and
    /// then pushes it back keeps that block's `execute` from buying (`AtCeiling`), and only that block's: the next
    /// sample walks back up to 100 ticks toward the pool, so the next block buys. The push and the push back pay box
    /// 0's pool fee twice (to box 0's own fee split); the round trip's cost per stalled block is logged.
    function testProperty_AUDIT_U5_aPushedSampleStallsOneBlockAtTheCostOfARoundTrip() public {
        _payFit(keeper);
        _fundBudget(eoa[3], 10 ether);
        _sampledBlocks(305); // an hour of samples at the price
        _advance(1);
        int24 t0 = _tick();
        uint160 p0 = _sqrtPrice();
        uint256 e0 = eoa[2].balance;
        uint256 tk0 = token.balanceOf(eoa[2]);
        _pushTo(eoa[2], t0 + 120); // T sold: ETH received
        uint256 e1 = eoa[2].balance;
        vm.prank(eoa[2]);
        executor.poke();
        assertEq(executor.latestSampleTick(), t0 + 100, "the block's sample: 100 ticks above the price");
        _buyTo(eoa[2], 1_000 ether, p0); // funded with 1,000 ETH, the rest refunded
        uint256 e2 = eoa[2].balance;
        assertEq(_sqrtPrice(), p0, "the price pushed back");
        vm.recordLogs();
        vm.prank(keeper);
        (uint256 chunks,,) = executor.execute(1);
        assertEq(chunks, 0, "this block buys nothing");
        _assertLastStop(FitBuybackExecutor.Stop.AtCeiling);
        // The round trip's cost: the ETH the buy back spent less the ETH the sell got, plus the T it lost at the price.
        uint256 ethLost = (e1 + 1_000 ether - e2) - (e1 - e0);
        uint256 tLost = tk0 - token.balanceOf(eoa[2]);
        uint256 tInEth = FullMath.mulDiv(FullMath.mulDiv(tLost, 1 << 96, p0), 1 << 96, p0);
        emit log_named_decimal_uint("ETH lost on the round trip", ethLost, 18);
        emit log_named_decimal_uint("T lost on the round trip, in ETH at the price", tInEth, 18);
        emit log_named_decimal_uint("cost of one stalled block (ETH)", ethLost + tInEth, 18);
        _advance(1);
        (chunks,,) = executor.execute(1);
        assertEq(chunks, 1, "the next block buys");
    }

    function _assertLastStop(FitBuybackExecutor.Stop want) internal view {
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.executor && logs[i].topics[0] == FitBuybackExecutor.Executed.selector) {
                (,,,,,, FitBuybackExecutor.Stop r) = abi.decode(
                    logs[i].data, (uint256, uint256, uint256, uint256, int24, uint160, FitBuybackExecutor.Stop)
                );
                assertEq(uint8(r), uint8(want), "the stop reason");
                seen = true;
            }
        }
        assertTrue(seen, "an Executed event");
    }

    /// P5.9 (FitBuybackExecutor.sol:427-453; BoxSpecV1 EXECUTOR_MAX_CHUNKS_PER_BLOCK 1): at most one chunk per block,
    /// whatever `maxChunks` and however often `execute` is called in the block.
    function testFuzz_AUDIT_U5_atMostOneChunkPerBlock(uint256 maxChunks, uint8 calls) public {
        maxChunks = bound(maxChunks, 1, type(uint256).max);
        _payFit(keeper);
        _fundBudget(eoa[3], 5 ether);
        uint256 total;
        uint256 k = bound(calls, 2, 6);
        for (uint256 i; i < k; ++i) {
            vm.prank(eoa[i % 8]);
            (uint256 c,,) = executor.execute(maxChunks);
            total += c;
        }
        assertEq(total, 1, "one chunk in the block");
        _advance(1);
        (uint256 again,,) = executor.execute(maxChunks);
        assertLe(again, 1);
    }

    /// P5.9: every chunk stays within its bounds, for any budget and any push of the price before it: the price after
    /// is at or above the band's floor (max(sample, average) − 99 ticks) and at most 49 ticks below the price before;
    /// a chunk that cannot (the price already below the band) spends nothing.
    function testFuzz_AUDIT_U5_executeBuysWithinTheBandAndTheImpact(uint256 budget, int256 push, uint256 blocks)
        public
    {
        budget = bound(budget, 0, 50 ether);
        push = bound(push, -3_000, 3_000);
        blocks = bound(blocks, 0, 30);
        _sampledBlocks(blocks);
        if (push != 0) _pushTo(eoa[2], _tick() + int24(push));
        _advance(1);
        _fundBudget(eoa[3], budget);
        (uint160 floorSqrt,) = _execFloorAfterPoke();
        uint160 p0 = _sqrtPrice();
        int24 t0 = _tick();
        uint256 bal0 = executor.budget();
        (uint256 chunks, uint256 spent,) = executor.execute(1);
        if (chunks == 0) {
            assertEq(spent, 0);
            assertEq(executor.budget(), bal0);
        } else {
            assertGe(_sqrtPrice(), floorSqrt, "at or above the band");
            assertLe(_sqrtPrice(), p0);
            assertLe(t0 - _tick(), int24(50), "at most 49 ticks of impact");
        }
    }

    /// The floor `execute` will use once its own `_observe` ran (a poke first: same timestamp, same sample).
    function _execFloorAfterPoke() internal returns (uint160 floorSqrt, int24 referenceTick) {
        executor.poke();
        return _execFloor();
    }

    // ================================================================================================ L5

    /// P5.11 (BuybackBurner's "execute never reverts", S5M4Invariants): after graduation `execute` never reverts, for
    /// any budget (0 to 200 ETH, forced ETH included), any push of the price either way, any gap in the samples (a
    /// block to 40 days), any Uniswap protocol fee on the buy direction (0 to its 1,000-pip maximum), any `maxChunks`
    /// and FIT sent to it unasked: it skips (`Stop`) instead.
    function testFuzz_AUDIT_U5_executeNeverRevertsAfterGraduation(
        uint256 budget,
        int256 push,
        uint256 gap,
        uint24 protocolFee,
        uint256 maxChunks,
        uint256 unsolicited
    ) public {
        budget = bound(budget, 0, 200 ether);
        push = bound(push, -20_000, 20_000);
        gap = bound(gap, 1, 40 days);
        protocolFee = uint24(bound(protocolFee, 0, 1_000));
        unsolicited = bound(unsolicited, 0, 1_000_000 ether);
        _setProtocolFee(protocolFee);
        if (unsolicited != 0) _transferT(eoa[2], a.executor, unsolicited);
        if (push != 0) _pushTo(eoa[2], _tick() + int24(push));
        _warpTo(vm.getBlockTimestamp() + gap);
        if (budget != 0) _forceEth(a.executor, budget);
        (bool ok, bytes memory ret) = a.executor.call(abi.encodeCall(FitBuybackExecutor.execute, (maxChunks)));
        assertTrue(ok, string(ret));
        assertEq(token.balanceOf(a.executor), 0, "no T left");
        // A second call in the same block, and one in the next block: still no revert.
        (ok,) = a.executor.call(abi.encodeCall(FitBuybackExecutor.execute, (maxChunks)));
        assertTrue(ok);
        _advance(1);
        (ok,) = a.executor.call(abi.encodeCall(FitBuybackExecutor.execute, (1)));
        assertTrue(ok);
        _assertGhostLedger();
    }

    function _setProtocolFee(uint24 zeroForOnePips) internal {
        if (zeroForOnePips == 0) return;
        address owner_ = IOwned(address(pm)).owner();
        vm.prank(owner_);
        IProtocolFees(address(pm)).setProtocolFeeController(address(this));
        IProtocolFees(address(pm)).setProtocolFee(poolKey, zeroForOnePips);
    }

    // ================================================================================================ L6

    /// P5.13 (FitBuybackExecutor.sol:129-130, :372-373, :526-528): the executor's raw reads of box 0's pool (`slot0`
    /// at keccak256(id, 6), liquidity at that slot + 3) are StateLibrary's: its `Observed` event names StateLibrary's
    /// tick, its `ChunkBought` StateLibrary's √price before and after, and its `poolId` is the key's.
    function testProperty_AUDIT_U5_executorPoolReadsAreStateLibrarys() public {
        assertEq(executor.poolId(), PoolId.unwrap(poolKey.toId()), "poolId");
        _buy(eoa[4], 0.3 ether);
        _advance(1);
        int24 pool = _tick();
        assertGt(pm.getLiquidity(poolKey.toId()), 0, "active liquidity");
        int24 prev = executor.latestSampleTick();
        int24 rec = pool < prev - 100 ? prev - 100 : (pool > prev + 100 ? prev + 100 : pool);
        vm.recordLogs();
        executor.poke();
        VmSafe.Log[] memory seen = vm.getRecordedLogs();
        bool observed;
        for (uint256 i; i < seen.length; ++i) {
            if (seen[i].emitter == a.executor && seen[i].topics[0] == FitBuybackExecutor.Observed.selector) {
                (int24 poolTick, int24 recorded,) = abi.decode(seen[i].data, (int24, int24, int56));
                assertEq(poolTick, pool, "the pool's tick, as StateLibrary reads it");
                assertEq(recorded, rec, "clamped to 100 ticks");
                observed = true;
            }
        }
        assertTrue(observed);
        _payFit(keeper);
        _sampledBlocks(300);
        uint160 before = _sqrtPrice();
        vm.recordLogs();
        (uint256 chunks,,) = executor.execute(1);
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        assertEq(chunks, 1);
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.executor && logs[i].topics[0] == FitBuybackExecutor.ChunkBought.selector) {
                (,, uint160 b, uint160 af,) = abi.decode(logs[i].data, (uint256, uint256, uint160, uint160, uint160));
                assertEq(b, before, "the price before, as StateLibrary reads it");
                assertEq(af, _sqrtPrice(), "the price after");
            }
        }
    }

    /// `fitGraduated()` (what v2's receivers read, V1Connection.t.sol) is true from box 0's graduation, and latched by
    /// the first `execute` after it (FitBuybackExecutor.sol:413-419): a coordinator answer of false later (mocked: the
    /// real coordinator never un-graduates) cannot pause it once latched. Before the first execute the latch is not set
    /// and the view follows the coordinator.
    function testProperty_AUDIT_U5_fitGraduatedLatchesAtTheFirstExecute() public {
        _payFit(keeper);
        assertTrue(executor.fitGraduated());
        assertFalse(executor.graduationSeen(), "graduate()'s poke does not latch");
        vm.mockCall(a.coordinator, abi.encodeWithSignature("graduated()"), abi.encode(false));
        assertFalse(executor.fitGraduated(), "unlatched: follows the coordinator");
        vm.clearMockedCalls();
        executor.execute(0);
        assertTrue(executor.graduationSeen());
        vm.mockCall(a.coordinator, abi.encodeWithSignature("graduated()"), abi.encode(false));
        assertTrue(executor.fitGraduated(), "latched");
        _advance(1);
        (uint256 chunks,,) = executor.execute(1);
        assertEq(chunks, 1, "and buying is not paused");
        vm.clearMockedCalls();
    }

    /// REV-16 (FitBuybackExecutor.sol:36-39, :262-272; BC-019, BC-133): the fee the executor reports for its own chunks
    /// is a lower bound of what box 0's positions got from them, under any Uniswap protocol fee (0 to 1,000 pips on
    /// the buy direction): per chunk, the positions' Q fees (v4's own formula through StateLibrary) are at least the
    /// note and exceed it by at most the slack 2 · 4 raw units plus v4's rounding (16 raw units here, BC-019's "within
    /// 16 wei").
    function testFuzz_AUDIT_U5_rev16NoteIsALowerBoundUnderAnyProtocolFee(uint24 protocolFee, uint256 budget) public {
        protocolFee = uint24(bound(protocolFee, 0, 1_000));
        budget = bound(budget, 0.011 ether, 30 ether);
        _setProtocolFee(protocolFee);
        _fundBudget(eoa[3], budget);
        for (uint256 k; k < 4; ++k) {
            (uint256 q0,) = _uncollected();
            (uint256 n0,) = receiver.moduleFeesPending();
            (uint256 chunks, uint256 spent,) = executor.execute(1);
            (uint256 q1,) = _uncollected();
            (uint256 n1,) = receiver.moduleFeesPending();
            uint256 got = q1 - q0;
            uint256 noted = n1 - n0;
            if (chunks == 0) {
                assertEq(noted, 0);
            } else {
                assertLe(noted, got, "the note never credits more than the positions got");
                assertLe(got - noted, 2 * MAX_STEPS + 8, "within 16 raw units");
                assertGt(spent, 0);
            }
            _sampledBlocks(1);
        }
    }

    // ================================================================================================ L7

    /// P5.15 (FitBuybackExecutor.sol:323-331): the batch threshold, 0.05% of totalSupply × the average's ETH per FIT,
    /// never overflows: for any average tick in [MIN_TICK, MAX_TICK] (the oracle written to that average: a state its
    /// 100-tick walk reaches) it answers, and equals FullMath's ⌊⌊S·2^96/√P⌋·2^96/√P⌋·5/10,000 at T's supply; at the
    /// supply's ceiling 1e27 the largest intermediate (at MIN_TICK) is below 2^218.
    function testFuzz_AUDIT_U5_batchThresholdNeverOverflows(int24 tick) public {
        tick = int24(bound(tick, TickMath.MIN_TICK, TickMath.MAX_TICK));
        _writeAverage(tick);
        (bool ready, int24 avg,) = executor.twap();
        assertTrue(ready);
        assertEq(avg, tick, "the written average");
        uint256 got = executor.batchThreshold();
        uint256 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        uint256 want =
            FullMath.mulDiv(FullMath.mulDiv(token.totalSupply(), 1 << 96, sqrtP), 1 << 96, sqrtP) * 5 / 10_000;
        assertEq(got, want);
        uint256 top = FullMath.mulDiv(BoxSpecV1.ISSUANCE, 1 << 96, TickMath.MIN_SQRT_PRICE);
        top = FullMath.mulDiv(top, 1 << 96, TickMath.MIN_SQRT_PRICE);
        assertLt(top, uint256(1) << 218, "1e27 at the minimum price fits with room");
    }

    /// Writes the executor's oracle so its 1-hour average is exactly `tick` (one checkpoint an hour back, the sample
    /// and the cumulative now).
    function _writeAverage(int24 tick) internal {
        uint256 nowTs = vm.getBlockTimestamp();
        int56 cum = int56(tick) * 3_600;
        // Oracle {tick, time, tickCumulative, head 0, filled 1} in slot 3; checkpoint 0 {time − 3600, 0} in slot 4.
        uint256 word =
            uint256(uint24(tick)) | (uint256(uint32(nowTs)) << 24) | (uint256(uint56(cum)) << 56) | (uint256(1) << 120);
        vm.store(a.executor, bytes32(uint256(3)), bytes32(word));
        vm.store(a.executor, bytes32(uint256(4)), bytes32(uint256(uint32(nowTs - 3_600))));
    }

    /// The executor's clock is `uint32` (FitBuybackExecutor.sol:198-200, :368-370: "safe until the year 2106"): it
    /// samples and executes at 2^32 − 1 s and reverts from 2^32 s (2106-02-07), the stated edge (pinned).
    function testProperty_AUDIT_U5_uint32ClockEdge() public {
        vm.warp(type(uint32).max);
        vm.roll(vm.getBlockNumber() + 1);
        executor.poke();
        executor.execute(1);
        vm.warp(uint256(type(uint32).max) + 1);
        vm.roll(vm.getBlockNumber() + 1);
        vm.expectRevert();
        executor.poke();
        vm.expectRevert();
        executor.execute(1);
    }

    /// The oracle's packed fields within their widths for the clock's whole life (FitBuybackExecutor.sol:65-71): the
    /// cumulative tick is an int56 (checked arithmetic, so an overflow would revert every sample), and before the
    /// uint32 clock ends (2106) it can reach at most |MAX_TICK| · (2^32 − the creation time) < 2^55; at box 0's own
    /// ticks (about 177,000) it reaches a fifth of that.
    function testProperty_AUDIT_U5_oracleCumulativeFitsBeforeTheClockEnds() public {
        uint256 life = uint256(type(uint32).max) - createdAt;
        uint256 worst = uint256(int256(TickMath.MAX_TICK)) * life;
        assertLt(worst, uint256(int256(type(int56).max)), "int56 never overflows before 2106");
        emit log_named_uint(
            "worst cumulative before 2106 / int56 max (x1000)", worst * 1000 / uint256(int256(type(int56).max))
        );
        assertLt(uint256(uint8(executor.CHECKPOINTS())), uint256(type(uint8).max), "head and filled in uint8");
    }

    // ================================================================================================ ETH sends

    /// The 2026-10-21 measurement (wave 1): under Amsterdam a value call to an EIP-7702-delegated EOA leaves its code
    /// about 3,000 gas less than a direct call, so a 2,300-gas stipend to such an account fails. The executor has no
    /// such send: over a life after graduation (a payFit, an execute with a chunk, a sell, a fee batch, the stream's
    /// burn), the only ETH it sends goes to the PoolManager (its swap input, with all gas), and the stream sends none.
    /// Its own `receive()` refuses a 2,300 stipend on either fork (documented, V1Connection.t.sol:132-135); the least
    /// gas it needs is logged. (The stream's T payouts to a 7702 EOA: `AuditU5ClaudeStreamTest`.)
    function testProperty_AUDIT_U5_noStipendOnlyEthSendToAChosenAddress() public {
        _payFit(keeper);
        vm.startStateDiffRecording();
        executor.execute(1);
        _sell(eoa[2], 1_000_000 ether);
        _buy(eoa[4], 0.6 ether);
        _collect(keeper, keeper);
        stream.burn();
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        for (uint256 i; i < acc.length; ++i) {
            if (acc[i].reverted || acc[i].value == 0) continue;
            if (acc[i].accessor == a.executor) assertEq(acc[i].account, address(pm), "executor: only the PoolManager");
            assertTrue(acc[i].accessor != a.itemStream, "the stream sends no ETH");
        }
        AuditU5ClaudeStipendPayer payer = new AuditU5ClaudeStipendPayer();
        vm.deal(address(payer), 1 ether);
        assertFalse(payer.sendStipend(payable(a.executor), 1), "2,300 gas refused (receive() writes storage)");
        uint256 least;
        for (uint256 g = 2_300; g <= 60_000; g += 100) {
            uint256 snap = vm.snapshotState();
            bool ok = payer.callWithGas(a.executor, 1, g);
            vm.revertToState(snap);
            if (ok) {
                least = g;
                break;
            }
        }
        emit log_named_string("evm", vm.getEvmVersion());
        emit log_named_uint("least gas for a value call to the executor's receive()", least);
        assertGt(least, 2_300);
    }
}

/// @notice The same suite under Amsterdam (Glamsterdam's gas schedule and EIP-7702 delegation costs).
/// forge-config: default.evm_version = "amsterdam"
contract AuditU5ClaudeExecutorAmsterdamTest is AuditU5ClaudeExecutorTest {}
