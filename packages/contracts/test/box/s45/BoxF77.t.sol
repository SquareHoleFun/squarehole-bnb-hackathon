// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxRoyaltyRouter} from "../../../src/box/BoxRoyaltyRouter.sol";
import {IBoxLaunchRouter} from "../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {IBoxReceiver} from "../../../src/box/interfaces/IBoxReceiver.sol";
import {DeepenSkip, DepthKind, FeeBatch, RoyaltyDestination} from "../../../src/box/interfaces/BoxTypes.sol";
import {ClaimsFunder} from "../../utils/ClaimsFunder.sol";
import {CodeScan} from "../conformance/CodeScan.sol";
import {BoxS45Base} from "./BoxS45Base.sol";
import {EthClaimsMinter, MockItemStream, MockWETH, SettablePriceAverage, SupplyFloorStandIn} from "./BoxS45Mocks.sol";
import {OpenTime} from "../utils/OpenTime.sol";

/// @notice F77 (the Misfits like all the others; docs/design/box0-like-others.md): box 0's sellers' fees split 13/15
/// burned (or streamed) and 2/15 into its own pool (BC-139), and one hold rule for every box's depth parts with the
/// settlement inside the poke budget (BC-143). The buyers' side (11/15, 2/15, 2/15 under the cap) is BC-015 and BC-106
/// in BoxReceiver.t.sol.
contract BoxF77ReceiverTest is BoxS45Base {
    using StateLibrary for IPoolManager;

    EthClaimsMinter internal minter;
    ClaimsFunder internal funder;

    function setUp() public {
        _setUpWorld();
        minter = new EthClaimsMinter(pm);
        funder = new ClaimsFunder(pm);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Fixtures

    function _fees(Box memory b, uint256 q) internal {
        vm.deal(address(this), address(this).balance + q);
        minter.mintTo{value: q}(address(b.receiver));
    }

    function _tFees(Box memory b, uint256 t) internal {
        deal(address(b.t), bob, b.t.balanceOf(bob) + t);
        funder.deposit(address(b.t), bob, t, address(b.receiver));
    }

    function _graduated(Params memory p) internal returns (Box memory b) {
        b = _buildAndLaunch(p);
        _skipWindow(b);
        _closeAndGraduate(b);
    }

    struct Tot {
        uint256 toFit;
        uint256 toPlatform;
        uint256 qToDepth;
        uint256 tToDepth;
        uint256 tBurned;
        uint256 qToCreator;
        uint256 tToCreator;
    }

    function _tot(Box memory b) internal view returns (Tot memory x) {
        (x.toFit, x.toPlatform, x.qToDepth, x.tToDepth, x.tBurned, x.qToCreator, x.tToCreator) = b.receiver.totals();
    }

    /// @dev The BatchSplit events' T parts (depth, burned) emitted by the receiver.
    function _tParts(Vm.Log[] memory logs, address emitter) internal pure returns (uint256 tDepth, uint256 tBurned) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != emitter || logs[i].topics[0] != IBoxReceiver.BatchSplit.selector) continue;
            (,,,,,, uint256 td, uint256 tb) =
                abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256));
            (tDepth, tBurned) = (tDepth + td, tBurned + tb);
        }
    }

    // ============================================================================================================
    // BC-139: box 0's sellers' fees: 13/15 burned or streamed, 2/15 into its own pool

    /// Before graduation the curve's sell fees split 13/15 burned and 2/15 held in the receiver; the settlement moves
    /// the held T whole to the hook's claims; after graduation the 2/15 goes to the hook at once. Exact fifteenths with
    /// the remainder carried.
    function test_BC139_box0SellersFeesThirteenBurnedTwoToItsPool() public {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        (uint256 t,) = _buy(b, alice, 1 ether, 0);
        _sell(b, alice, t / 2);
        uint256 supply0 = b.t.totalSupply();
        vm.recordLogs();
        FeeBatch memory fb = b.receiver.collect(keeper);
        (uint256 tDepth, uint256 tBurned) = _tParts(vm.getRecordedLogs(), address(b.receiver));
        assertGt(fb.t, 15, "fixture: sellers paid T fees");
        uint256 unit = fb.t / 15;
        assertEq(tBurned, unit * BoxSpecV1.BOX0_FEE_SHARE_T_BURN, "13/15 burned");
        assertEq(tDepth, unit * BoxSpecV1.FEE_SHARE_DEPTH, "2/15 to its own pool");
        (, uint256 tCarry) = b.receiver.carried();
        assertEq(tCarry, fb.t % 15, "the remainder carried");
        assertEq(supply0 - b.t.totalSupply(), tBurned, "the burn lowered T's supply by exactly 13/15");
        (, uint256 heldT) = b.receiver.depthHeld();
        assertEq(heldT, tDepth, "held in the receiver before graduation");
        (, uint256 hookT) = b.hook.depthBudget();
        assertEq(hookT, 0, "nothing in the hook before graduation");
        Tot memory x = _tot(b);
        assertEq(x.tToDepth, tDepth, "counted when credited");
        assertEq(x.tBurned, tBurned);
        // The settlement moves the held T whole to the hook's claims.
        _closeAndGraduate(b);
        (, heldT) = b.receiver.depthHeld();
        assertEq(heldT, 0, "nothing held after the settlement");
        (, hookT) = b.hook.depthBudget();
        assertEq(hookT, tDepth, "the held 2/15 is the hook's T budget");
        // After graduation: the 2/15 to the hook at once, 13/15 burned.
        (, uint256 carry0) = b.receiver.carried();
        supply0 = b.t.totalSupply();
        _tFees(b, 150e18 + 7);
        _fees(b, 0.01 ether);
        b.receiver.collect(keeper);
        unit = (150e18 + 7 + carry0) / 15;
        (, uint256 hookT2) = b.hook.depthBudget();
        assertEq(hookT2 - hookT, unit * 2, "2/15 into its pool at once");
        assertEq(supply0 - b.t.totalSupply(), unit * 13, "13/15 burned");
        (, tCarry) = b.receiver.carried();
        assertEq(tCarry, (150e18 + 7 + carry0) % 15, "the remainder carried");
    }

    /// A burn the vault's floor refuses waits in `tBurnPending` and is never counted as burned (BC-016); the 2/15 depth
    /// part is never redeemed, so it reaches the hook whatever the burn does.
    function test_BC139_aRefusedBurnNeverTouchesTheDepthPart() public {
        Box memory b = _graduated(_box0Params());
        SupplyFloorStandIn floor = new SupplyFloorStandIn();
        address vaultAddr = b.t.vault();
        vm.etch(vaultAddr, address(floor).code);
        SupplyFloorStandIn(vaultAddr).setFloor(type(uint256).max);
        (, uint256 hookT0) = b.hook.depthBudget();
        (, uint256 carry0) = b.receiver.carried();
        uint256 supply0 = b.t.totalSupply();
        _tFees(b, 150e18 - carry0);
        _fees(b, 0.01 ether);
        b.receiver.collect(keeper);
        assertEq(b.t.totalSupply(), supply0, "refused: nothing burned");
        assertEq(b.receiver.tBurnPending(), 130e18, "13/15 waits");
        (,,,, uint256 tBurned,,) = b.receiver.totals();
        assertEq(tBurned, 0, "never counted as burned");
        (, uint256 hookT1) = b.hook.depthBudget();
        assertEq(hookT1 - hookT0, 20e18, "the 2/15 reached the hook anyway");
        SupplyFloorStandIn(vaultAddr).setFloor(0);
        _fees(b, 0.01 ether);
        b.receiver.collect(keeper);
        assertEq(supply0 - b.t.totalSupply(), 130e18, "burned once the floor allows it");
        (, uint256 hookT2) = b.hook.depthBudget();
        assertEq(hookT2, hookT1, "the burn never takes depth T");
    }

    /// After graduation with a per-item stream (S8): the stream receives exactly 13/15 of the T side, never the 2/15;
    /// a stream whose notice reverts or burns its gas changes neither.
    function test_BC139_streamGetsExactlyThirteenFifteenths() public {
        MockItemStream stream = new MockItemStream();
        Params memory p = _box0Params();
        p.tStream = BoxSpecV1.T_STREAM_PER_ITEM_STREAM;
        p.stream = address(stream);
        Box memory b = _graduated(p);
        (, uint256 hookT0) = b.hook.depthBudget();
        (, uint256 carry0) = b.receiver.carried();
        _tFees(b, 30e18 - carry0);
        _fees(b, 0.01 ether);
        b.receiver.collect(keeper);
        assertEq(b.t.balanceOf(address(stream)), 26e18, "13/15 to the stream");
        assertEq(stream.notified(), 26e18);
        (, uint256 hookT1) = b.hook.depthBudget();
        assertEq(hookT1 - hookT0, 4e18, "2/15 into its pool, never to the stream");
        stream.setMode(true, false);
        _tFees(b, 15e18);
        _fees(b, 0.01 ether);
        b.receiver.collect(keeper);
        assertEq(b.t.balanceOf(address(stream)), 39e18, "a reverting notice: the 13/15 arrived");
        (, uint256 hookT2) = b.hook.depthBudget();
        assertEq(hookT2 - hookT1, 2e18, "the 2/15 unaffected");
        // A notice that burns all the gas it is given (STREAM_NOTIFY_GAS): the collect still completes.
        stream.setMode(false, true);
        _tFees(b, 15e18);
        _fees(b, 0.01 ether);
        b.receiver.collect(keeper);
        assertEq(b.t.balanceOf(address(stream)), 52e18, "a notice that burns its gas: the 13/15 arrived");
        (, uint256 hookT3) = b.hook.depthBudget();
        assertEq(hookT3 - hookT2, 2e18, "the 2/15 unaffected");
        assertEq(stream.notified(), 26e18, "neither failed notice was counted by the stand-in");
    }

    /// The T parts plus the carry equal the T in, to the raw unit, for any batches (fuzzed).
    function testFuzz_BC139_box0TPartsPlusCarryEqualTheInput(uint96 a1, uint96 a2, uint96 a3) public {
        Box memory b = _graduated(_box0Params());
        Tot memory x0 = _tot(b);
        (, uint256 carry0) = b.receiver.carried();
        (, uint256 hookT0) = b.hook.depthBudget();
        uint256 sum;
        uint256[3] memory xs = [bound(a1, 0, 1e26), bound(a2, 0, 1e26), bound(a3, 0, 1e26)];
        for (uint256 i; i < 3; ++i) {
            if (xs[i] == 0) continue;
            _tFees(b, xs[i]);
            _fees(b, 0.01 ether);
            b.receiver.collect(keeper);
            sum += xs[i];
        }
        Tot memory x1 = _tot(b);
        (, uint256 carry1) = b.receiver.carried();
        uint256 burned = x1.tBurned - x0.tBurned + b.receiver.tBurnPending();
        uint256 depth = x1.tToDepth - x0.tToDepth;
        assertEq(burned + depth + carry1, sum + carry0, "every raw unit burned, in depth or carried");
        assertLt(carry1, 15);
        assertEq(depth * BoxSpecV1.BOX0_FEE_SHARE_T_BURN, burned * BoxSpecV1.FEE_SHARE_DEPTH, "13 : 2");
        (, uint256 hookT1) = b.hook.depthBudget();
        assertEq(hookT1 - hookT0, depth, "the hook's T claims are the depth part");
    }

    // ============================================================================================================
    // BC-143: one hold rule, and the settlement within the poke budget

    /// Every box (box 0 included since F77) holds its depth parts (2/15 of both sides and `fundDepth()`) in the
    /// receiver before graduation; the settlement moves them whole to the hook's claims.
    function test_BC143_everyBoxHoldsItsDepthPartsUntilTheSettlement() public {
        _holdsThenMoves(_box0Params());
        _holdsThenMoves(_standardParams(address(0)));
    }

    function _holdsThenMoves(Params memory p) internal {
        Box memory b = _buildAndLaunch(p);
        _skipWindow(b);
        (uint256 t,) = _buy(b, alice, 1 ether, 0);
        _sell(b, alice, t / 2);
        b.receiver.collect(keeper);
        vm.deal(bob, 0.5 ether);
        vm.prank(bob);
        b.receiver.fundDepth{value: 0.5 ether}();
        (uint256 dq, uint256 dt) = b.receiver.depthHeld();
        assertGt(dq, 0.5 ether, "the Q 2/15 and the gift, held");
        assertGt(dt, 0, "the T 2/15, held");
        Tot memory x = _tot(b);
        assertEq(x.qToDepth, dq, "credited when held");
        assertEq(x.tToDepth, dt);
        (uint256 hq, uint256 ht) = b.hook.depthBudget();
        assertEq(hq | ht, 0, "nothing in the hook before graduation");
        _closeAndGraduate(b);
        (uint256 dq1, uint256 dt1) = b.receiver.depthHeld();
        assertEq(dq1 | dt1, 0, "moved at the settlement");
        (hq, ht) = b.hook.depthBudget();
        Tot memory y = _tot(b);
        assertEq(hq, y.qToDepth, "the hook's Q claims are every Q depth credit");
        assertEq(ht, y.tToDepth, "and its T claims every T depth credit");
        assertGe(hq, dq);
        assertEq(ht, dt, "the closing buy paid no T fees");
        (uint256 qb, uint256 tb) = b.receiver.booked();
        assertEq(_claims(address(b.receiver), address(0)), qb, "every Q claim booked");
        assertEq(_claims(address(b.receiver), address(b.t)), tb, "every T claim booked");
    }

    /// Box 0's held platform share is capped in epoch 0 first, however late the settlement runs, and its held depth
    /// moves with no effect on the cap.
    function test_BC143_box0LateSettlementCapsTheHeldShareInEpochZeroAndMovesTheDepth() public {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        (uint256 t,) = _buy(b, alice, 2 ether, 0);
        _sell(b, alice, t / 2);
        b.receiver.collect(keeper);
        uint256 heldP = b.receiver.platformHeld();
        (uint256 dq, uint256 dt) = b.receiver.depthHeld();
        assertEq(dq, heldP, "box 0: depth and platform shares are both 2/15");
        assertGt(dt, 0);
        _close(b, carol);
        b.coord.setSkipPokes(true);
        b.coord.graduate();
        vm.warp(block.timestamp + 31 days);
        vm.recordLogs();
        b.receiver.onGraduation();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 creditedInEpoch0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(b.receiver)) continue;
            if (logs[i].topics[0] != IBoxReceiver.PlatformCredited.selector) continue;
            assertEq(uint256(logs[i].topics[1]), 0, "epoch 0");
            (uint256 kept,,) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            creditedInEpoch0 += kept;
        }
        assertGe(creditedInEpoch0, heldP, "the held share kept in epoch 0");
        assertGe(b.receiver.platformOwed(), heldP);
        (uint256 epoch, uint256 keptNow, uint256 remaining) = b.receiver.platformEpoch();
        assertEq(epoch, 1);
        assertEq(keptNow, 0, "the late settlement charged nothing to epoch 1");
        assertEq(remaining, BoxSpecV1.PLATFORM_CAP_WEI);
        (uint256 hq, uint256 ht) = b.hook.depthBudget();
        assertGe(hq, dq, "the held Q depth moved");
        assertEq(ht, dt, "the held T depth moved");
    }

    /// Box 0's `onGraduation` (with held Q and T depth, held platform and FIT shares and a final batch) stays within
    /// POKE_GAS (BoxSpecV1's, 2,600,000 since F95) under today's schedule and Glamsterdam, every account cold.
    function test_BC143_box0OnGraduationWithinPokeGas() public {
        Params memory p = _box0Params();
        Box memory b = _buildAndLaunch(p);
        _skipWindow(b);
        (uint256 t,) = _buy(b, alice, 2 ether, 0);
        _sell(b, alice, t / 2);
        b.receiver.collect(keeper);
        (t,) = _buy(b, alice, 0.5 ether, 0);
        _sell(b, alice, t / 2); // the final harvest's batch has both sides too
        _close(b, carol);
        b.coord.setSkipPokes(true);
        b.coord.graduate();
        uint256 snap = vm.snapshotState();
        uint256[2] memory used;
        for (uint256 i; i < 2; ++i) {
            vm.setEvmVersion(i == 0 ? "osaka" : "amsterdam");
            vm.cool(address(pm));
            vm.cool(address(b.hook));
            vm.cool(address(b.receiver));
            vm.cool(address(b.coord));
            vm.cool(address(b.t));
            uint256 g0 = gasleft();
            b.receiver.onGraduation();
            used[i] = g0 - gasleft();
            vm.revertToState(snap);
        }
        vm.setEvmVersion("osaka");
        emit log_named_uint("F77|box 0 onGraduation with held Q and T depth|today", used[0]);
        emit log_named_uint("F77|box 0 onGraduation with held Q and T depth|glamsterdam", used[1]);
        assertLt(used[0], BoxSpecV1.POKE_GAS, "today");
        assertLt(used[1], BoxSpecV1.POKE_GAS, "Glamsterdam");
    }
}

/// @notice F77 on the hook: no box places rungs any more, so the rung code is gone from every box's hook (BC-010's ABI
/// part; box 0's pair and lock is BC-119 to BC-123 in BoxHookDepth.t.sol).
contract BoxF77HookTest is BoxS45Base {
    function setUp() public {
        _setUpWorld();
    }

    /// BC-010 (F77): the hook (and its fixed extension) dispatches no `pokeRungs`, `rungAt`, `rungCount` or
    /// `lastHarvestTick`, and has no rung or harvest-step constants; `deepen()` and `pairedLiquidity()` stay.
    function test_BC010_hookHasNoRungEntryPoints() public view {
        uint32[] memory words = CodeScan.pushedWords(bytes.concat(address(hookImpl).code, address(hookExt).code));
        string[8] memory gone = [
            "pokeRungs(uint256,uint256)",
            "rungAt(uint256)",
            "rungCount()",
            "lastHarvestTick()",
            "RUNG_GRID_TICKS()",
            "RUNG_WIDTH_TICKS()",
            "RUNG_GAP_TICKS()",
            "HARVEST_STEP_TICKS()"
        ];
        for (uint256 i; i < gone.length; ++i) {
            assertFalse(CodeScan.pushes(words, bytes4(keccak256(bytes(gone[i])))), gone[i]);
        }
        assertTrue(CodeScan.pushes(words, bytes4(keccak256("deepen(address)"))), "control: deepen()");
        assertTrue(CodeScan.pushes(words, bytes4(keccak256("pairedLiquidity()"))), "control: pairedLiquidity()");
    }
}

/// @notice F77 on the launch router: box 0's sniper tax goes into its own pool like every box's (BC-140), the
/// platform's only income is box 0's capped 2/15 (BC-141), and Q-only depth waits until T matches it (BC-142).
contract BoxF77LaunchTaxTest is BoxS45Base {
    EthClaimsMinter internal minter;
    ClaimsFunder internal funder;

    function setUp() public {
        _setUpWorld();
        minter = new EthClaimsMinter(pm);
        funder = new ClaimsFunder(pm);
    }

    function _routerBuy(Box memory b, address who, uint256 qIn) internal returns (uint256 tax) {
        vm.deal(who, who.balance + qIn);
        uint256 taxBefore = b.router.totalTaxCollected();
        vm.prank(who);
        b.router.buy{value: qIn}(qIn, 0, who, block.timestamp);
        tax = b.router.totalTaxCollected() - taxBefore;
    }

    /// @dev BC-110's window buys: 0.1 ETH at window block 0 and 1 ETH at block 31 leave 0.1737624 ETH of tax.
    function _windowBuys(Box memory b) internal returns (uint256 tax) {
        OpenTime.toStep(b.hook.openAt(), 0);
        tax = _routerBuy(b, alice, 0.1 ether);
        OpenTime.toStep(b.hook.openAt(), 31);
        tax += _routerBuy(b, alice, 1 ether);
    }

    function _box0() internal returns (Box memory b) {
        Params memory p = _box0Params();
        p.averageKind = 1;
        b = _buildAndLaunch(p);
    }

    // ============================================================================================================
    // BC-010 (router part): the router names no Safe

    /// F77: the launch router follows one rule for every box; it carries no Safe argument (105 bytes) and has no
    /// `platformSafe()`; `kind` stays only for box 0's refusal of a creator buy.
    function test_BC010_routerNamesNoSafe() public {
        uint32[] memory words = CodeScan.pushedWords(address(routerImpl).code);
        assertFalse(CodeScan.pushes(words, bytes4(keccak256("platformSafe()"))), "no platformSafe()");
        assertTrue(CodeScan.pushes(words, bytes4(keccak256("sweep()"))), "control: sweep()");
        assertEq(routerImpl.ARGS_LENGTH(), 105, "kind, q, token, hook, coordinator, sqrtP1, openAt (uint32)");
        Box memory b = _box0();
        assertEq(address(b.router).code.length, 45 + 105, "the clone carries 105 argument bytes");
        assertEq(b.router.hook(), address(b.hook));
    }

    // ============================================================================================================
    // BC-140: box 0's launch tax goes into its own pool

    function test_BC140_box0LaunchTaxGoesIntoItsOwnPool() public {
        Box memory b = _box0();
        uint256 safe0 = safe.balance;
        uint256 tax = _windowBuys(b);
        assertEq(tax, 0.1737624 ether, "BC-110's tax");
        assertEq(address(b.router).balance, tax, "held in the router");
        // Before graduation sweep() reverts and the tax stays.
        vm.expectRevert(IBoxLaunchRouter.NotGraduated.selector);
        b.router.sweep();
        assertEq(address(b.router).balance, tax);
        // graduate() never calls the router and never waits for the tax (BC-098).
        _skipWindow(b);
        _closeAndGraduate(b);
        assertTrue(b.coord.graduated());
        assertEq(address(b.router).balance, tax, "graduation never touched the router");
        // After graduation anyone's sweep() makes the tax (and any forced ETH) the hook's Q claims: its depth budget.
        vm.deal(address(b.router), address(b.router).balance + 3);
        (uint256 q0,) = b.hook.depthBudget();
        vm.prank(bob);
        assertEq(b.router.sweep(), tax + 3, "anyone sweeps");
        (uint256 q1,) = b.hook.depthBudget();
        assertEq(q1 - q0, tax + 3, "the hook's Q budget rises by exactly the tax and the forced ETH");
        assertEq(address(b.router).balance, 0);
        assertEq(b.router.totalSwept(), tax + 3);
        assertEq(safe.balance, safe0, "the Safe's balance never rises from the router");
        assertEq(_claims(safe, address(0)), 0, "nor its claims");
        // The tax is not P: it never counts in or against the cap.
        assertEq(b.receiver.platformOwed() + b.receiver.platformHeld(), _platformFromFees(b), "only fees are P");
        vm.expectRevert(IBoxLaunchRouter.NothingToSweep.selector);
        b.router.sweep();
    }

    /// @dev What the receiver credited the platform (kept, owed and paid) comes only from its own fee splits.
    function _platformFromFees(Box memory b) internal view returns (uint256) {
        (, uint256 toPlatform,,,,,) = b.receiver.totals();
        return toPlatform + b.receiver.platformHeld();
    }

    /// Box 0 has no deadline and no `fail()` (BC-063): if the Misfits never graduate, the tax stays in the router for
    /// good; nobody, the platform included, can move it (counsel, box0-like-others § 8).
    function test_BC140_withNoGraduationTheTaxStaysInTheRouter() public {
        Box memory b = _box0();
        uint256 tax = _windowBuys(b);
        _skipWindow(b);
        vm.warp(block.timestamp + 365 days);
        vm.roll(block.number + 2_628_000);
        vm.expectRevert(IBoxLaunchRouter.NotGraduated.selector);
        b.router.sweep();
        vm.prank(safe);
        vm.expectRevert(IBoxLaunchRouter.NotGraduated.selector);
        b.router.sweep();
        assertEq(address(b.router).balance, tax, "it stays");
        (bool ok,) = address(b.router).call(abi.encodeWithSignature("platformSafe()"));
        assertFalse(ok, "no Safe to sweep to");
    }

    // ============================================================================================================
    // BC-142: box 0's Q-only depth is placed in small steps (S5.M5), and its amounts can be read

    /// The tax and the platform's excess above the cap reach the hook as Q only. With the T side below MIN_ADD,
    /// deepen() converts one small capped step (S5.M5, BC-137) and keeps the rest; once sellers' 2/15 is worth MIN_ADD
    /// the pair adds, sized by the cap, and most of the Q still waits for later calls. Every figure the page shows is
    /// read from the chain.
    function test_BC142_box0QOnlyDepthIsPlacedInSmallStepsAndItsAmountsCanBeRead() public {
        (Box memory b, uint256 q0) = _qOnlyDepth();
        // Sellers' fees (T worth about 1 ETH at the price): their 2/15 is worth more than MIN_ADD.
        uint256 s = _sqrtP(b);
        _tFees(b, 1 ether * s / (1 << 96) * s / (1 << 96));
        _fees(b, 0.01 ether);
        b.receiver.collect(keeper);
        (, uint256 t2) = b.hook.depthBudget();
        assertGt(t2 * (1 << 96) / s * (1 << 96) / s, b.hook.minAdd(), "the T side reached MIN_ADD");
        vm.roll(block.number + 300);
        SettablePriceAverage(b.average).set(true, _tick(b), _tick(b));
        (DepthKind kind, DeepenSkip skip,, uint256 tUsed,) = b.hook.deepen(keeper);
        assertEq(uint256(skip), uint256(DeepenSkip.None));
        assertEq(uint256(kind), uint256(DepthKind.Pair), "the pair adds");
        assertGt(tUsed, 0);
        assertGt(b.hook.pairedLiquidity(), 0, "added: read from the hook");
        (uint256 q3,) = b.hook.depthBudget();
        assertGt(q3, q0 * 9 / 10, "most of the Q waits for later calls: read from the hook");
        assertEq(address(b.router).balance, 0, "nothing left in the router after the sweep");
    }

    /// @dev Box 0 graduated with its swept tax and 300 ETH of fees in epoch 0 (the excess above the cap) as Q-only
    /// depth; the first deepen() converts one capped step (about 0.01 ETH at graduation's depth) and keeps the rest.
    /// Returns the box and its Q budget after that call.
    function _qOnlyDepth() internal returns (Box memory b, uint256 q1) {
        b = _box0();
        uint256 tax = _windowBuys(b);
        _skipWindow(b);
        _closeAndGraduate(b);
        (uint256 qs,) = b.hook.depthBudget();
        b.router.sweep();
        (uint256 qt,) = b.hook.depthBudget();
        assertEq(qt - qs, tax, "the swept tax is the hook's Q claims");
        _fundFees(b, 300 ether); // P = 40 ETH in epoch 0: the excess above the cap joins the Q side
        (uint256 q0, uint256 t0) = b.hook.depthBudget();
        assertGt(q0, 40 ether + tax, "the 2/15, the excess and the tax: all Q");
        assertEq(t0, 0, "no T side yet");
        vm.roll(b.hook.migratedAtBlock() + 300);
        SettablePriceAverage(b.average).set(true, _tick(b), _tick(b));
        (DepthKind kind, DeepenSkip skip, uint256 qUsed, uint256 tUsed, uint256 tip) = b.hook.deepen(keeper);
        assertEq(uint256(skip), uint256(DeepenSkip.None));
        assertEq(uint256(kind), uint256(DepthKind.Convert), "the T side is below MIN_ADD: one capped conversion");
        assertEq(tUsed, 0, "nothing paired yet");
        assertLe(qUsed, 0.0102 ether, "one 49-tick step at graduation's depth: about 0.0099 ETH moved, plus the 1% fee");
        assertGt(qUsed, 0.0099 ether);
        uint256 t1;
        (q1, t1) = b.hook.depthBudget();
        assertEq(q0 - q1, qUsed + tip, "the rest of the budget stays");
        assertGt(t1, 0, "the T bought waits as depth");
        assertEq(b.hook.pairedLiquidity(), 0, "no add below MIN_ADD");
        assertEq(_claims(address(b.hook), address(0)), q1, "the hook's claims are its depth budget");
        assertEq(_claims(address(b.hook), address(b.t)), t1);
    }

    // ============================================================================================================
    // BC-141: the platform's only income is box 0's capped 2/15

    struct SafeBook {
        uint256 eth;
        uint256 claims;
    }

    function _safeBook() internal view returns (SafeBook memory x) {
        x = SafeBook(safe.balance, _claims(safe, address(0)));
    }

    function _assertSafeUnchanged(SafeBook memory before, string memory step) internal view {
        SafeBook memory now_ = _safeBook();
        assertEq(now_.eth, before.eth, string.concat(step, ": the Safe's ETH unchanged"));
        assertEq(now_.claims, before.claims, string.concat(step, ": the Safe's claims unchanged"));
    }

    function _fees(Box memory b, uint256 q) internal {
        vm.deal(address(this), address(this).balance + q);
        minter.mintTo{value: q}(address(b.receiver));
    }

    function _tFees(Box memory b, uint256 t) internal {
        deal(address(b.t), bob, b.t.balanceOf(bob) + t);
        funder.deposit(address(b.t), bob, t, address(b.receiver));
    }

    function _fundFees(Box memory b, uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        b.receiver.fundFees{value: amount}();
    }

    /// A full life of box 0 and of a version-2 box: creation, taxed window buys, the curve, graduation, sweeps,
    /// collects, deepens, royalty flushes, gifts and forced ETH over three epochs. The Safe's ETH and claims rise only
    /// through box 0's payPlatform(), by at most 32 ETH an epoch, never from a router, hook, executor, royalty router
    /// or the other box.
    function test_BC141_thePlatformsOnlyIncomeIsBox0sCappedShare() public {
        Box memory z = _box0();
        Params memory ps = _standardParams(z.executor);
        ps.averageKind = 1;
        Box memory o = _buildAndLaunch(ps);
        SafeBook memory book = _safeBook();
        assertEq(z.hook.openAt(), o.hook.openAt(), "fixture: one window");
        OpenTime.toStep(z.hook.openAt(), 0);
        _routerBuy(z, alice, 0.1 ether);
        _routerBuy(o, alice, 0.1 ether);
        OpenTime.toStep(z.hook.openAt(), 31);
        _routerBuy(z, alice, 1 ether);
        _routerBuy(o, alice, 1 ether);
        _assertSafeUnchanged(book, "window");
        _skipWindow(z);
        _skipWindow(o);
        _trade(z);
        _trade(o);
        z.receiver.collect(keeper);
        o.receiver.collect(keeper);
        _assertSafeUnchanged(book, "curve");
        _closeAndGraduate(z);
        _closeAndGraduate(o);
        _assertSafeUnchanged(book, "graduation");
        z.router.sweep();
        o.router.sweep();
        _assertSafeUnchanged(book, "sweeps");
        MockWETH weth = new MockWETH();
        BoxRoyaltyRouter rz = _royaltyRouter(z, address(weth), RoyaltyDestination.FeeHandling);
        ++boxSeed;
        BoxRoyaltyRouter ro = _royaltyRouter(o, address(weth), RoyaltyDestination.PoolDepth);
        uint256 g = block.timestamp;
        uint256 paid;
        for (uint256 epoch; epoch < 3; ++epoch) {
            vm.warp(g + epoch * BoxSpecV1.PLATFORM_EPOCH_SECONDS + 1);
            _roll(1);
            book = _safeBook();
            _trade(z);
            _trade(o);
            _fees(z, 0.01 ether);
            _fees(o, 0.01 ether);
            z.receiver.collect(keeper);
            o.receiver.collect(keeper);
            _fundFees(z, 150 ether); // P = 20 ETH a batch: two batches pass the cap
            _fundFees(z, 150 ether);
            _fundFees(o, 15 ether);
            vm.deal(address(this), address(this).balance + 2 ether);
            (bool ok,) = address(rz).call{value: 1 ether}("");
            (ok,) = address(ro).call{value: 1 ether}("");
            assertTrue(ok);
            rz.flush();
            ro.flush();
            vm.deal(address(z.receiver), address(z.receiver).balance + 1); // forced ETH: depth only
            z.receiver.fundDepth{value: 0}();
            vm.deal(address(this), address(this).balance + 1 ether);
            o.receiver.fundDepth{value: 1 ether}();
            vm.deal(address(this), address(this).balance + 1 ether);
            (ok,) = z.executor.call{value: 1 ether}(""); // FIT's executor: all to its budget (BC-108)
            assertTrue(ok);
            _deepen(z);
            _deepen(o);
            z.receiver.payFit();
            o.receiver.payFit();
            _assertSafeUnchanged(book, "fees, royalties, gifts, deepens and FIT payouts");
            uint256 owed = z.receiver.platformOwed();
            uint256 amount = z.receiver.payPlatform();
            SafeBook memory afterPay = _safeBook();
            assertEq(amount, owed);
            assertEq(afterPay.eth - book.eth, amount, "only payPlatform() pays the Safe");
            assertEq(afterPay.claims, book.claims);
            assertLe(amount, BoxSpecV1.PLATFORM_CAP_WEI, "at most 32 ETH in the epoch");
            paid += amount;
            vm.expectRevert(IBoxReceiver.NotBox0.selector);
            o.receiver.payPlatform();
        }
        assertLe(paid, 3 * BoxSpecV1.PLATFORM_CAP_WEI, "three epochs, at most 32 ETH each");
        assertGt(paid, 2 * BoxSpecV1.PLATFORM_CAP_WEI, "fixture: the cap bound in each epoch");
    }

    function _trade(Box memory b) internal {
        (uint256 t,) = _buy(b, carol, 0.5 ether, 0);
        _sell(b, carol, t / 2);
    }

    function _deepen(Box memory b) internal {
        _roll(300);
        SettablePriceAverage(b.average).set(true, _tick(b), _tick(b));
        b.hook.deepen(keeper);
    }
}
