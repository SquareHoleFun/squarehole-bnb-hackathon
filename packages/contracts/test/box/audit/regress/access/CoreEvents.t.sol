// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {VmSafe} from "forge-std/Vm.sol";
import {AuditRegressEventChecks, Vm} from "./EventChecks.sol";
import {CoreBox0Kit, CoreBoxAddresses} from "../../../conformance/core/CoreBox0Kit.sol";
import {BoxSpecV1} from "../../../../../src/box/BoxSpecV1.sol";
import {BoxLayoutV1} from "../../../../../src/box/BoxLayoutV1.sol";
import {BoxHook} from "../../../../../src/box/BoxHook.sol";
import {BoxCoordinator} from "../../../../../src/box/BoxCoordinator.sol";
import {BoxReceiver} from "../../../../../src/box/BoxReceiver.sol";
import {BoxToken} from "../../../../../src/box/BoxToken.sol";
import {BoxLaunchRouter} from "../../../../../src/box/BoxLaunchRouter.sol";
import {BoxTickets} from "../../../../../src/box/BoxTickets.sol";
import {FitBuybackExecutor} from "../../../../../src/box/FitBuybackExecutor.sol";
import {IBoxReceiver} from "../../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxItemStream} from "../../../../../src/box/interfaces/IBoxItemStream.sol";
import {FeeBatch, DepthKind, DeepenSkip} from "../../../../../src/box/interfaces/BoxTypes.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {ClaimsDuster} from "../../../s7/BoxS7Base.sol";
import {ClaimsFunder} from "../../../../utils/ClaimsFunder.sol";

/// The full factory-built box0, real pool, receiver and executor. No fork or broadcast.
/// forge-config: default.evm_version = "osaka"
contract AuditRegressCoreEventsReviewTest is AuditRegressEventChecks {
    using StateLibrary for IPoolManager;
    CoreBox0Kit internal kit;
    CoreBoxAddresses internal a;
    BoxHook internal h;
    BoxReceiver internal r;
    BoxToken internal t;
    IPoolManager internal pm;
    PoolId internal pid;
    bytes internal creationData;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    function setUp() public {
        kit = new CoreBox0Kit();
        kit.setUpWorld();
        BoxSpecV1.BoxSpec memory s = abi.decode(
            vm.parseJsonBytes(vm.readFile("test/vectors/box-spec/box-spec-v1.json"), ".columns.encoded[0]"),
            (BoxSpecV1.BoxSpec)
        );
        kit.prepare(s);
        vm.recordLogs();
        kit.create();
        creationData = abi.encode(vm.getRecordedLogs());
        a = kit.addresses();
        h = BoxHook(a.hook);
        r = BoxReceiver(payable(a.receiver));
        t = BoxToken(a.token);
        pm = IPoolManager(a.poolManager);
        pid = h.poolId();
    }

    function test_AR21_E04_E05_E07_E15_E18_E45_creationPoolAndBootstrapEvents() public view {
        Vm.Log[] memory creation = abi.decode(creationData, (VmSafe.Log[]));
        BoxLayoutV1.Curve memory c = kit.curve();
        _event(
            creation,
            a.poolManager,
            "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)",
            abi.encode(pid, address(0), a.token),
            abi.encode(uint24(10_000), int24(60), a.hook, c.sqrtPriceStartX96, c.tickStart)
        );
        _event(
            creation,
            a.poolManager,
            "ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)",
            abi.encode(pid, a.hook),
            abi.encode(c.tickLower, c.tickUpper, int256(uint256(c.liquidity)), bytes32(0))
        );
        _event(
            creation,
            a.hook,
            "PoolLaunched(bytes32,int24,int24,uint128,uint160,uint256)",
            abi.encode(pid),
            abi.encode(c.tickLower, c.tickUpper, c.liquidity, c.sqrtPriceStartX96, c.curveT)
        );
        _event(
            creation,
            a.token,
            "Transfer(address,address,uint256)",
            abi.encode(address(0), a.coordinator),
            abi.encode(BoxSpecV1.ISSUANCE)
        );
        uint256 burned = BoxSpecV1.ISSUANCE - t.totalSupply();
        _event(
            creation,
            a.launchRouter,
            "Bootstrapped(address,uint256,uint256)",
            abi.encode(a.coordinator),
            abi.encode(BoxSpecV1.BOOTSTRAP_ETH, burned)
        );
        _event(
            creation,
            a.coordinator,
            "BoxLaunched(uint256,uint256,uint256,uint256,uint256)",
            abi.encode(uint256(0)),
            abi.encode(h.openAt(), burned, uint256(0), uint256(0))
        );
        _event(
            creation,
            a.collection,
            "ConsecutiveTransfer(uint256,uint256,address,address)",
            abi.encode(uint256(1), address(0), a.vault),
            abi.encode(uint256(4269))
        );
    }

    function test_AR21_E03_E14_E17_taxedBuySwapAndSweepEvents() public {
        vm.warp(h.openAt() + 36);
        vm.roll(block.number + 3);
        BoxLaunchRouter router = BoxLaunchRouter(a.launchRouter);
        vm.deal(ALICE, 0.02 ether);
        uint256 beforeTax = router.totalTaxCollected();
        vm.recordLogs();
        vm.prank(ALICE);
        uint256 out = router.buy{value: 0.02 ether}(0.02 ether, 1, BOB, block.timestamp);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _event(
            logs,
            a.launchRouter,
            "TaxedBuy(address,address,uint256,uint256,uint256,uint256,uint256)",
            abi.encode(ALICE, BOB),
            abi.encode(uint256(3), uint256(0.02 ether), router.totalTaxCollected() - beforeTax, out, ALICE.balance)
        );
        assertEq(t.balanceOf(BOB), out);
        _event(logs, a.token, "Transfer(address,address,uint256)", abi.encode(a.poolManager, BOB), abi.encode(out));
        (uint160 price, int24 tick,,) = pm.getSlot0(pid);
        _event(
            logs,
            a.poolManager,
            "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)",
            abi.encode(pid, a.launchRouter),
            abi.encode(
                -int256(0.02 ether - (router.totalTaxCollected() - beforeTax)),
                int256(out),
                price,
                pm.getLiquidity(pid),
                tick,
                uint24(10_000)
            )
        );
        kit.toClosed();
        BoxCoordinator(a.coordinator).graduate();
        uint256 amount = a.launchRouter.balance;
        uint256 claims = pm.balanceOf(a.hook, 0);
        vm.recordLogs();
        router.sweep();
        _event(
            vm.getRecordedLogs(),
            a.launchRouter,
            "Swept(address,uint256,bool)",
            abi.encode(a.hook),
            abi.encode(amount, true)
        );
        assertEq(pm.balanceOf(a.hook, 0) - claims, amount);
    }

    function test_AR21_E08_E09_E19_E20_E21_E31_closeMigrationGraduationRewardAndPokeFailureEvents() public {
        kit.toBonding();
        vm.recordLogs();
        kit.buy(ALICE, 3 * kit.spec().raise, kit.curve().sqrtPriceEndX96);
        _event(
            vm.getRecordedLogs(),
            a.hook,
            "CurveClosed(bytes32,uint256,uint160)",
            abi.encode(pid),
            abi.encode(block.number, kit.curve().sqrtPriceEndX96)
        );
        uint256 share = t.balanceOf(a.coordinator);
        BoxLayoutV1.Graduated memory layout =
            BoxLayoutV1.graduated(kit.curve(), kit.spec().gradLayout, kit.spec().raise, share);
        uint256 fitHeld = r.fitOwed();
        uint256 platformHeld = r.platformHeld();
        // A capped observer may fail; force only that dependency's call to exercise the real catch-and-emit path.
        vm.mockCallRevert(a.itemStream, abi.encodeCall(IBoxItemStream.onGraduation, ()), "observer failed");
        vm.recordLogs();
        vm.prank(ALICE);
        uint256 reward = BoxCoordinator(a.coordinator).graduate();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _event(
            logs,
            a.coordinator,
            "Graduated(address,uint256,uint256,uint256,uint256)",
            abi.encode(ALICE),
            abi.encode(block.number, share, layout.tDust, reward)
        );
        _migrationEvent(logs, layout, share);
        _event(
            logs,
            a.coordinator,
            "PokeFailed(address,bytes4)",
            abi.encode(a.itemStream),
            abi.encode(IBoxItemStream.onGraduation.selector)
        );
        _event(
            logs,
            a.receiver,
            "GraduationSettled(uint256,uint256,uint256,uint256,uint256)",
            "",
            abi.encode(fitHeld, platformHeld, uint256(0), uint256(0), uint256(0))
        );
        vm.clearMockedCalls();
        assertTrue(BoxCoordinator(a.coordinator).graduated());
        assertTrue(r.graduationSettled());
        vm.recordLogs();
        vm.prank(ALICE);
        BoxCoordinator(a.coordinator).claimReward(BOB);
        _event(
            vm.getRecordedLogs(),
            a.coordinator,
            "RewardClaimed(address,address,uint256)",
            abi.encode(ALICE),
            abi.encode(BOB, reward)
        );
        assertEq(BOB.balance, reward);
        vm.recordLogs();
        vm.prank(ALICE);
        (bool ok,) = a.coordinator.call(abi.encodeCall(BoxCoordinator.claimReward, (BOB)));
        assertFalse(ok);
        _noEvent(vm.getRecordedLogs(), a.coordinator, "RewardClaimed(address,address,uint256)");
    }

    function _migrationEvent(Vm.Log[] memory logs, BoxLayoutV1.Graduated memory layout, uint256 share) internal view {
        bytes memory data = abi.encode(
            kit.spec().raise,
            uint256(0),
            layout.ask.liquidity,
            layout.bid.liquidity,
            layout.sentinel.liquidity,
            share - layout.tDust,
            layout.qDust
        );
        _event(
            logs,
            a.hook,
            "Migrated(bytes32,uint256,uint256,uint128,uint128,uint128,uint256,uint256)",
            abi.encode(pid),
            data
        );
    }

    function test_AR21_E23_E24_E25_E26_E27_E28_E29_E30_feeFundingDepthAndPaymentEvents() public {
        vm.deal(ALICE, 1500);
        vm.recordLogs();
        vm.prank(ALICE);
        r.fundFees{value: 1500}();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _event(logs, a.receiver, "FeesFunded(address,uint256)", abi.encode(ALICE), abi.encode(uint256(1500)));
        _event(
            logs,
            a.receiver,
            "BatchSplit(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
            "",
            abi.encode(
                uint256(0), uint256(1100), uint256(200), uint256(0), uint256(0), uint256(0), uint256(0), uint256(0)
            )
        );
        _event(logs, a.receiver, "DepthHeld(uint256,uint256)", "", abi.encode(uint256(200), uint256(0)));
        assertEq(r.fitOwed(), 1100);
        assertEq(r.platformHeld(), 200);
        vm.deal(BOB, 23);
        vm.recordLogs();
        vm.prank(BOB);
        r.fundDepth{value: 23}();
        logs = vm.getRecordedLogs();
        _event(logs, a.receiver, "DepthGifted(address,uint256)", abi.encode(BOB), abi.encode(uint256(23)));
        _event(logs, a.receiver, "DepthHeld(uint256,uint256)", "", abi.encode(uint256(23), uint256(0)));
        kit.toClosed();
        BoxCoordinator(a.coordinator).graduate();
        (uint256 epoch, uint256 kept,) = r.platformEpoch();
        vm.deal(ALICE, 1500);
        vm.recordLogs();
        vm.prank(ALICE);
        r.fundFees{value: 1500}();
        logs = vm.getRecordedLogs();
        _event(
            logs,
            a.receiver,
            "PlatformCredited(uint256,uint256,uint256,uint256)",
            abi.encode(epoch),
            abi.encode(uint256(200), uint256(0), kept + 200)
        );
        _event(logs, a.receiver, "DepthFunded(uint256,uint256)", "", abi.encode(uint256(200), uint256(0)));
        uint256 amount = r.platformOwed();
        uint256 before = a.platform.balance;
        vm.recordLogs();
        r.payPlatform();
        _event(
            vm.getRecordedLogs(),
            a.receiver,
            "PlatformPaid(address,uint256)",
            abi.encode(a.platform),
            abi.encode(amount)
        );
        assertEq(a.platform.balance - before, amount);
        amount = r.fitOwed();
        before = FitBuybackExecutor(payable(a.executor)).budget();
        vm.recordLogs();
        r.payFit();
        _event(vm.getRecordedLogs(), a.receiver, "FitPaid(address,uint256)", abi.encode(a.executor), abi.encode(amount));
        assertEq(FitBuybackExecutor(payable(a.executor)).budget() - before, amount);
    }

    function test_AR21_E10_E22_E32_E33_E35_harvestCollectFeeReturnAndStreamNotificationEvents() public {
        kit.toClosed();
        BoxCoordinator(a.coordinator).graduate();
        uint256 bought = kit.buy(ALICE, 0.1 ether, 0);
        kit.sell(ALICE, bought / 2);
        vm.recordLogs();
        vm.prank(a.receiver);
        (uint256 q, uint256 tt, uint256 reserve) = h.harvest();
        _event(
            vm.getRecordedLogs(),
            a.hook,
            "Harvested(bytes32,uint256,uint256,uint256)",
            abi.encode(pid),
            abi.encode(q, tt, reserve)
        );
        assertGt(q, 0);
        assertGt(tt, 0);
        vm.prank(a.hook);
        r.noteModuleFees(100, 0);
        vm.prank(a.executor);
        r.noteModuleFees(31, 0);
        vm.deal(address(this), 0.015 ether);
        new ClaimsDuster(pm).dust{value: 0.015 ether}(a.receiver, 0.015 ether);
        // The failed notification leaves the delivered tokens intact; their balance delta pins its amount.
        uint256 streamBefore = t.balanceOf(a.itemStream);
        vm.mockCallRevert(a.itemStream, abi.encodeWithSelector(IBoxItemStream.onStreamFunds.selector), "notify failed");
        vm.recordLogs();
        FeeBatch memory batch = r.collect(BOB);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 expectedStream = t.balanceOf(a.itemStream) - streamBefore;
        assertGt(expectedStream, 0);
        _event(
            logs,
            a.receiver,
            "Collected(address,address,uint256,uint256,uint256,uint256)",
            abi.encode(address(this)),
            abi.encode(BOB, batch.q, batch.t, batch.qToReserve, batch.tip)
        );
        _event(
            logs,
            a.receiver,
            "ModuleFeesReturned(uint256,uint256,uint256)",
            "",
            abi.encode(uint256(31), uint256(0), uint256(100))
        );
        _event(
            logs,
            a.receiver,
            "StreamNotifyFailed(address,uint256)",
            abi.encode(a.itemStream),
            abi.encode(expectedStream)
        );
        assertEq(t.balanceOf(a.itemStream), expectedStream);
        assertEq(r.hookFeesPending(), 0);
        vm.clearMockedCalls();
        uint256 amount = 1500;
        new ClaimsFunder(pm).deposit(a.token, ALICE, amount, a.receiver);
        vm.deal(address(this), 0.015 ether);
        new ClaimsDuster(pm).dust{value: 0.015 ether}(a.receiver, 0.015 ether);
        vm.recordLogs();
        r.collect(BOB);
        _event(
            vm.getRecordedLogs(),
            a.receiver,
            "StreamFunded(address,uint256)",
            abi.encode(a.itemStream),
            abi.encode(uint256(1300))
        );
    }

    function _average(FitBuybackExecutor executor) internal {
        (, int24 spot,,) = pm.getSlot0(pid);
        for (uint256 i; i < 1000 && executor.latestSampleTick() != spot; ++i) {
            vm.roll(block.number + 1);
            vm.warp(block.timestamp + 12);
            executor.poke();
        }
        for (uint256 i; i < 13; ++i) {
            vm.roll(block.number + 25);
            vm.warp(block.timestamp + 300);
            executor.poke();
        }
        (bool ready,,) = executor.twap();
        assertTrue(ready);
    }

    struct Execution {
        int24 avg;
        uint160 beforePrice;
        uint256 supply;
        uint256 budget;
        uint256 chunks;
        uint256 spent;
        uint256 burned;
    }

    function test_AR21_E69_E70_E71_E72_E77_executorBuyBurnAndFeeReportEvents() public {
        kit.toClosed();
        BoxCoordinator(a.coordinator).graduate();
        FitBuybackExecutor executor = FitBuybackExecutor(payable(a.executor));
        _average(executor);
        vm.deal(address(this), 1 ether);
        executor.fundBudget{value: 1 ether}();
        Execution memory x;
        (, x.avg,) = executor.twap();
        (x.beforePrice,,,) = pm.getSlot0(pid);
        x.supply = t.totalSupply();
        x.budget = executor.budget();
        vm.recordLogs();
        (x.chunks, x.spent, x.burned) = executor.execute(1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(x.chunks, 1);
        assertGt(x.burned, 0);
        assertEq(x.supply - t.totalSupply(), x.burned);
        assertEq(x.budget - executor.budget(), x.spent);
        (uint160 afterPrice,,,) = pm.getSlot0(pid);
        uint160 floor = TickMath.getSqrtPriceAtTick(x.avg - executor.TWAP_BAND_TICKS());
        uint256 impact = FullMath.mulDivRoundingUp(
            x.beforePrice, TickMath.getSqrtPriceAtTick(-executor.MAX_IMPACT_TICKS()), 1 << 96
        );
        _event(
            logs,
            a.executor,
            "ChunkBought(uint256,uint256,uint256,uint160,uint160,uint160)",
            abi.encode(uint256(0)),
            abi.encode(x.spent, x.burned, x.beforePrice, afterPrice, impact > floor ? impact : floor)
        );
        _event(logs, a.executor, "TokensBurned(uint256,uint256)", "", abi.encode(x.burned, uint256(0)));
        _event(
            logs,
            a.executor,
            "Executed(uint256,uint256,uint256,uint256,int24,uint160,uint8)",
            "",
            abi.encode(x.chunks, x.spent, x.burned, x.burned, x.avg, floor, uint8(FitBuybackExecutor.Stop.MaxChunks))
        );
        uint256 note = x.spent / 100 - 2 * (uint256(uint24(executor.MAX_IMPACT_TICKS())) / 60 + 4);
        _event(logs, a.executor, "ModuleFeesReported(uint256)", "", abi.encode(note));
        (uint256 pending,) = r.moduleFeesPending();
        assertEq(pending, note);
        _event(
            logs, a.token, "Transfer(address,address,uint256)", abi.encode(a.executor, address(0)), abi.encode(x.burned)
        );
    }
}
