// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditRegressEventChecks} from "./EventChecks.sol";
import {IBoxReceiver} from "../../../../../src/box/interfaces/IBoxReceiver.sol";
import {Vm} from "forge-std/Vm.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BoxS7Base} from "../../../s7/BoxS7Base.sol";
import {BoxSpecV1} from "../../../../../src/box/BoxSpecV1.sol";
import {BoxCoordinator} from "../../../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../../../src/box/BoxHook.sol";
import {BoxLaunchRouter} from "../../../../../src/box/BoxLaunchRouter.sol";
import {BoxCollection} from "../../../../../src/box/BoxCollection.sol";
import {BoxToken} from "../../../../../src/box/BoxToken.sol";
import {FitBuybackExecutor} from "../../../../../src/box/FitBuybackExecutor.sol";
import {IBoxFactoryV1} from "../../../../../src/box/interfaces/IBoxFactoryV1.sol";
import {IBoxRegistry} from "../../../../../src/box/interfaces/IBoxRegistry.sol";
import {IBoxHook} from "../../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxTickets} from "../../../../../src/box/interfaces/IBoxTickets.sol";
import {BoxClones} from "../../../../../src/box/libraries/BoxClones.sol";

/// @notice Independent access/setup review. Real CoreV1Deployment, factory, clones and PoolManager;
/// only the deterministic deployer is supplied by the existing offline fixture. No fork or broadcast.
/// forge-config: default.evm_version = "osaka"
contract AuditRegressAccessSetupReviewTest is BoxS7Base, AuditRegressEventChecks {
    using PoolIdLibrary for PoolKey;

    address internal constant STRANGER = address(0xBAD);

    function _denied(address target, bytes memory data, string memory errorSignature) internal {
        vm.prank(STRANGER);
        (bool ok, bytes memory result) = target.call(data);
        assertFalse(ok, string.concat("unauthorized success: ", vm.toString(target), " ", vm.toString(data)));
        assertGe(result.length, 4, "must fail at the caller guard");
        assertEq(bytes4(result), bytes4(keccak256(bytes(errorSignature))), "wrong refusal");
    }

    function test_AR01_AR14_privilegedCallersAndDormantBox0Roles() public {
        (, address c, address h) = _create(_box0Spec());
        IBoxFactoryV1.Box0Addresses memory a = factory.box0Addresses();
        // Negative control is opt-in and mutates only this test EVM, never a source file.
        if (vm.envOr("SH_ACCESS_NEGATIVE_CONTROL", false)) {
            vm.mockCall(a.vault, abi.encodeWithSignature("openGate()"), "");
        }
        _denied(c, abi.encodeCall(BoxCoordinator.launch, ()), "NotFactory(address)");
        _denied(
            c, abi.encodeCall(BoxCoordinator.deploy, (new bytes[](0), hex"00", bytes32(0), 0)), "NotFactory(address)"
        );
        _denied(address(registry), abi.encodeCall(IBoxRegistry.record, (c, bytes32(0), hex"00")), "NotFactory(address)");
        _denied(h, abi.encodeWithSignature("launch()"), "NotCoordinator(address)");
        _denied(h, abi.encodeWithSignature("migrate(uint256)", 0), "NotCoordinator(address)");
        _denied(h, abi.encodeWithSignature("harvest()"), "NotReceiver(address)");
        _denied(a.launchRouter, abi.encodeWithSignature("bootstrap()"), "NotCoordinator(address)");
        _denied(
            a.launchRouter,
            abi.encodeWithSignature("creatorBuy(address,uint256)", STRANGER, 1),
            "NotCoordinator(address)"
        );
        _denied(a.vault, abi.encodeWithSignature("openGate()"), "NotCoordinator(address)");
        _denied(a.vault, abi.encodeWithSignature("waiveHandBackFee()"), "NotCoordinator(address)");
        _denied(a.vault, abi.encodeWithSignature("openTickets(uint256,uint256)", 1, 0), "NotAdapter(address)");
        _denied(
            a.vault,
            abi.encodeWithSignature("releaseTickets(uint256,address,uint256)", 1, STRANGER, 0),
            "NotAdapter(address)"
        );
        _denied(a.vault, abi.encodeWithSignature("deliverTicket(uint256,address)", 1, STRANGER), "NotAdapter(address)");
        _denied(a.collection, abi.encodeWithSignature("unlockReveal(uint256)", 1), "NotRevealUnlocker(address)");
        _denied(
            a.collection,
            abi.encodeWithSignature("approve(address,uint256)", STRANGER, 1),
            "ERC721InvalidApprover(address)"
        );
        _denied(
            a.collection,
            abi.encodeWithSignature("transferFrom(address,address,uint256)", a.vault, STRANGER, 1),
            "ERC721InsufficientApproval(address,uint256)"
        );
        _denied(a.receiver, abi.encodeWithSignature("noteModuleFees(uint256,uint256)", 1, 1), "NotModule(address)");
        _denied(a.receiver, abi.encodeWithSignature("pullForModule()"), "NotModule(address)");
        _denied(a.receiver, abi.encodeWithSignature("moduleProceeds(uint8,uint256)", 0, 1), "NotModule(address)");
        _denied(a.receiver, abi.encodeWithSignature("claimCreator(address)", STRANGER), "NotPayee(address)");
        _denied(a.receiver, abi.encodeWithSignature("proposeCreatorPayee(address)", STRANGER), "NotPayee(address)");
        _denied(a.receiver, abi.encodeWithSignature("acceptCreatorPayee()"), "NotPendingPayee(address)");
        _denied(a.receiver, abi.encodeWithSignature("fundCreator()"), "NotCreatorRoyalties()");
        _denied(a.itemStream, abi.encodeWithSignature("onStreamFunds(uint256)", 1), "NotReceiver(address)");
        _denied(
            a.itemStream,
            abi.encodeWithSignature("onItemTransfer(address,address,uint256)", a.vault, STRANGER, 1),
            "NotCollection(address)"
        );
        _denied(
            a.itemStream,
            abi.encodeWithSignature("onVaultAction(uint8,address,uint256,uint256)", 0, STRANGER, 1, 4269),
            "NotVault(address)"
        );
        _denied(version.hookExtension, abi.encodeWithSignature("launch()"), "NotDelegated()");
        _denied(version.receiverExtension, abi.encodeWithSignature("initialize()"), "NotDelegated()");
        assertEq(registry.boxCount(), 1);
        assertEq(BoxCollection(a.collection).balanceOf(a.vault), _box0Spec().n);
    }

    function test_AR22_AR21_E34_E36_hookFeeNotesUseSeparateQOnlyLedgerAndClipT() public {
        (,, address hook) = _create(_box0Spec());
        IBoxFactoryV1.Box0Addresses memory a = factory.box0Addresses();
        IBoxReceiver receiver = IBoxReceiver(a.receiver);
        vm.prank(a.executor);
        receiver.noteModuleFees(31, 11);
        vm.recordLogs();
        vm.prank(hook);
        receiver.noteModuleFees(100, 7);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(receiver.hookFeesPending(), 100);
        (uint256 q, uint256 t) = receiver.moduleFeesPending();
        assertEq(q, 31);
        assertEq(t, 11);
        _event(
            logs,
            a.receiver,
            "ModuleFeesNoted(address,uint256,uint256)",
            abi.encode(hook),
            abi.encode(uint256(100), uint256(0))
        );
        _event(
            logs,
            a.receiver,
            "ModuleFeesClipped(address,uint256,uint256)",
            abi.encode(hook),
            abi.encode(uint256(0), uint256(7))
        );
        vm.recordLogs();
        _denied(a.receiver, abi.encodeCall(IBoxReceiver.noteModuleFees, (100, 7)), "NotModule(address)");
        _noEvent(vm.getRecordedLogs(), a.receiver, "ModuleFeesNoted(address,uint256,uint256)");
        assertEq(receiver.hookFeesPending(), 100);
        vm.prank(hook);
        receiver.noteModuleFees(23, 0);
        assertEq(receiver.hookFeesPending(), 123);
    }

    function test_AR01_AR21_box0CreatorBuyCannotEmit() public {
        _create(_box0Spec());
        IBoxFactoryV1.Box0Addresses memory a = factory.box0Addresses();
        vm.recordLogs();
        vm.prank(a.coordinator);
        (bool ok, bytes memory result) =
            a.launchRouter.call(abi.encodeWithSignature("creatorBuy(address,uint256)", STRANGER, 1));
        assertFalse(ok);
        assertEq(bytes4(result), bytes4(keccak256("NoCreatorBuy()")));
        _noEvent(vm.getRecordedLogs(), a.launchRouter, "CreatorBought(address,uint256,uint256)");
    }

    function test_AR02_cloneInitializationIsOnceAndVersionBound() public {
        (, address c, address h) = _create(_box0Spec());
        IBoxFactoryV1.Box0Addresses memory a = factory.box0Addresses();
        address[7] memory targets = [h, a.launchRouter, a.receiver, a.collection, a.vault, a.tickets, a.itemStream];
        for (uint256 i; i < targets.length; ++i) {
            _denied(targets[i], abi.encodeWithSignature("initialize()"), "NotCoordinator(address)");
            vm.prank(c);
            (bool ok, bytes memory err) = targets[i].call(abi.encodeWithSignature("initialize()"));
            assertFalse(ok);
            assertEq(bytes4(err), bytes4(keccak256("AlreadyInitialised()")));
            // A new copy of the real clone, with the first immutable argument changed to an EOA.
            bytes memory code = targets[i].code;
            for (uint256 j; j < 20; ++j) {
                code[45 + j] = bytes20(STRANGER)[j];
            }
            address rogue = BoxClones.create(BoxClones.initCode(code));
            _denied(rogue, abi.encodeWithSignature("initialize()"), "NotCoordinator(address)");
        }
        // A coordinator clone from this version cannot be driven by its creator either.
        address rogueCoordinator = BoxClones.create(BoxClones.initCode(version.impls.coordinator, new bytes(154)));
        _denied(rogueCoordinator, abi.encodeCall(BoxCoordinator.launch, ()), "NotFactory(address)");
    }

    function test_AR09_AR20_callbacksCannotBeCalledOutsideTheOwningOperation() public {
        (, address c, address h) = _create(_box0Spec());
        IBoxFactoryV1.Box0Addresses memory a = factory.box0Addresses();
        address[5] memory guarded = [c, a.launchRouter, a.receiver, a.executor, h];
        bytes memory callback = abi.encodeWithSignature("unlockCallback(bytes)", abi.encode(uint256(0)));
        for (uint256 i; i < guarded.length; ++i) {
            _denied(guarded[i], callback, "NotPoolManager()");
            if (guarded[i] == h) continue; // Hook authority is PoolManager's unlock-caller invariant.
            vm.prank(address(pm));
            (bool ok, bytes memory err) = guarded[i].call(callback);
            assertFalse(ok);
            assertEq(bytes4(err), bytes4(keccak256("NotPoolManager()")));
        }
    }

    function test_AR09_hookCallbackPermissionsAndForeignPools() public {
        (,, address h) = _create(_box0Spec());
        PoolKey memory key = FitBuybackExecutor(payable(factory.box0Addresses().executor)).poolKey();
        ModifyLiquidityParams memory lp = ModifyLiquidityParams(0, 60, 1, bytes32(0));
        SwapParams memory swap = SwapParams(true, -1, 1);
        bytes[5] memory calls = [
            abi.encodeCall(BoxHook.beforeInitialize, (STRANGER, key, uint160(1))),
            abi.encodeCall(BoxHook.beforeAddLiquidity, (STRANGER, key, lp, bytes(""))),
            abi.encodeCall(BoxHook.beforeRemoveLiquidity, (STRANGER, key, lp, bytes(""))),
            abi.encodeCall(BoxHook.beforeDonate, (STRANGER, key, 1, 1, bytes(""))),
            abi.encodeCall(BoxHook.beforeSwap, (STRANGER, key, swap, bytes("")))
        ];
        string[4] memory refusals =
            ["ForeignInitialize()", "LiquidityLocked()", "LiquidityLocked()", "DonationsDisabled()"];
        for (uint256 i; i < calls.length; ++i) {
            _denied(h, calls[i], "NotPoolManager()");
            if (i == refusals.length) continue;
            vm.prank(address(pm));
            (bool ok, bytes memory result) = h.call(calls[i]);
            assertFalse(ok);
            assertEq(bytes4(result), bytes4(keccak256(bytes(refusals[i]))));
        }
        key.fee = 500;
        bytes memory afterSwap =
            abi.encodeCall(BoxHook.afterSwap, (STRANGER, key, swap, BalanceDelta.wrap(0), bytes("")));
        _denied(h, afterSwap, "NotPoolManager()");
        vm.prank(address(pm));
        (bool accepted, bytes memory refusal) = h.call(afterSwap);
        assertFalse(accepted);
        assertEq(bytes4(refusal), bytes4(keccak256("UnknownPool()")));
    }

    function test_AR19_tokenSpendsOnlyOwnersBalanceOrGrantedAllowance() public {
        (, address c,) = _create(_box0Spec());
        IBoxFactoryV1.Box0Addresses memory a = factory.box0Addresses();
        BoxToken token = BoxToken(a.token);
        vm.prank(c);
        token.transfer(address(this), 100);
        _denied(
            a.token,
            abi.encodeWithSignature("transferFrom(address,address,uint256)", address(this), STRANGER, 1),
            "InsufficientAllowance(uint256,uint256)"
        );
        token.approve(STRANGER, 7);
        vm.prank(STRANGER);
        token.transferFrom(address(this), STRANGER, 7);
        assertEq(token.balanceOf(address(this)), 93);
        assertEq(token.balanceOf(STRANGER), 7);
        assertEq(token.allowance(address(this), STRANGER), 0);
        _denied(a.token, abi.encodeWithSignature("burn(uint256)", 8), "InsufficientBalance(uint256,uint256)");
        _denied(a.token, abi.encodeWithSignature("transfer(address,uint256)", a.vault, 1), "DirectSendRefused(address)");
        assertEq(token.balanceOf(address(this)), 93);
    }

    function test_AR01_AR04_AR09_AR21_E01_E02_noncePlanPoolKeyAndRegistryEvents() public {
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        IBoxFactoryV1.Box0Addresses memory a = factory.box0Addresses();
        assertEq(address(registry), vm.computeCreateAddress(address(factory), 1));
        assertEq(a.coordinator, vm.computeCreateAddress(address(factory), 2));
        address[10] memory predicted = [
            a.table,
            a.token,
            a.vault,
            a.collection,
            a.receiver,
            a.launchRouter,
            a.executor,
            a.tickets,
            a.itemStream,
            a.royaltyRouter
        ];
        for (uint256 i; i < predicted.length; ++i) {
            assertEq(predicted[i], vm.computeCreateAddress(a.coordinator, i + 1));
        }
        vm.recordLogs();
        (, address c, address h) = _create(s);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < predicted.length; ++i) {
            assertGt(predicted[i].code.length, 0);
        }
        assertEq(vm.getNonce(c), 12, "ten CREATEs and one CREATE2");
        assertEq(uint160(h) & 0x3fff, 0x2ae0);
        assertTrue(uint160(h) >> 152 != 0x91);
        PoolKey memory key = FitBuybackExecutor(payable(a.executor)).poolKey();
        assertEq(Currency.unwrap(key.currency0), address(0));
        assertEq(Currency.unwrap(key.currency1), a.token);
        assertEq(key.fee, 10_000);
        assertEq(key.tickSpacing, 60);
        assertEq(address(key.hooks), h);
        assertEq(PoolId.unwrap(key.toId()), PoolId.unwrap(IBoxHook(h).poolId()));
        _assertRegistryLogs(logs, s);
        vm.expectRevert(IBoxFactoryV1.Box0Exists.selector);
        factory.createBox(s, bytes32(0), _executorCode());
    }

    function _assertRegistryLogs(Vm.Log[] memory logs, BoxSpecV1.BoxSpec memory s) internal view {
        IBoxRegistry.BoxRecord memory row = registry.recordOf(0);
        (,,, bytes32 specHash, bytes32 recordHash) = registry.entry(0);
        assertEq(specHash, keccak256(abi.encode(s)));
        assertEq(recordHash, keccak256(abi.encode(row)));
        uint256 specs;
        uint256 created;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(registry)) continue;
            if (logs[i].topics[0] == keccak256("BoxSpec(uint256,bytes)")) {
                ++specs;
                assertEq(logs[i].topics.length, 2);
                assertEq(logs[i].data, abi.encode(abi.encode(s)));
                assertEq(logs[i].topics[1], bytes32(0));
                assertEq(abi.decode(logs[i].data, (bytes)), abi.encode(s));
            } else {
                ++created;
                assertEq(logs[i].topics[0], IBoxRegistry.BoxCreated.selector);
                assertEq(logs[i].topics.length, 4);
                assertEq(logs[i].topics[1], bytes32(0));
                assertEq(logs[i].topics[2], factory.templateIdOf(s));
                assertEq(logs[i].topics[3], specHash);
                assertEq(logs[i].data, abi.encode(row));
            }
        }
        assertEq(specs, 1);
        assertEq(created, 1);
    }

    function test_AR15_openingClocksAndWindowEdges() public {
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        s.openAt = uint32(block.timestamp + 1 hours);
        (,, address h) = _create(s);
        IBoxFactoryV1.Box0Addresses memory a = factory.box0Addresses();
        assertEq(IBoxHook(h).openAt(), s.openAt);
        assertEq(BoxLaunchRouter(a.launchRouter).openAt(), s.openAt);
        assertEq(IBoxTickets(a.tickets).openAt(), s.openAt);
        vm.roll(block.number + 1);
        vm.warp(s.openAt - 1);
        _swapGate(h, a.launchRouter, true, "TradingNotOpen(uint256)");
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotOpenYet.selector, s.openAt));
        IBoxTickets(a.tickets).take(1, type(uint256).max, type(uint256).max);
        vm.warp(s.openAt);
        _swapGate(h, STRANGER, true, "BuyThroughLaunchRouter(address,uint256)");
        _swapGate(h, STRANGER, false, "");
        _swapGate(h, a.launchRouter, true, "");
        vm.warp(uint256(s.openAt) + 383);
        _swapGate(h, STRANGER, true, "BuyThroughLaunchRouter(address,uint256)");
        vm.warp(uint256(s.openAt) + 384);
        _swapGate(h, STRANGER, true, "");
        vm.expectRevert(abi.encodeWithSignature("WindowClosed(uint256)", uint256(s.openAt) + 384));
        BoxLaunchRouter(a.launchRouter).quote(1 ether);
    }

    function test_AR15_nowMeansTimestampPlusOneAcrossAllThreeClocks() public {
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        s.openAt = 0;
        (,, address h) = _create(s);
        IBoxFactoryV1.Box0Addresses memory a = factory.box0Addresses();
        assertEq(IBoxHook(h).openAt(), block.timestamp + 1);
        assertEq(BoxLaunchRouter(a.launchRouter).openAt(), block.timestamp + 1);
        assertEq(IBoxTickets(a.tickets).openAt(), block.timestamp + 1);
    }

    function test_AR01_factoryRefusalsAreAtomicAndCallerSpecific() public {
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.NotBox0Creator.selector, STRANGER));
        factory.createBox(s, bytes32(0), _executorCode());
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.WrongValue.selector, 0, BoxSpecV1.BOOTSTRAP_ETH));
        factory.createBox(s, bytes32(0), _executorCode());
        vm.deal(address(this), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.ExecutorCodeMismatch.selector, keccak256(hex"00")));
        factory.createBox{value: BoxSpecV1.BOOTSTRAP_ETH}(s, bytes32(0), hex"00");
        s.openAt = uint32(block.timestamp + 14 days + 1);
        _assertRefused(
            s, abi.encodeWithSelector(IBoxFactoryV1.OpenAtTooFar.selector, s.openAt, block.timestamp + 14 days)
        );
        _assertNothingCreated();
    }

    function test_AR04_existingSourceKeepsDeploymentNoncePlan() public {
        assertTrue(version.randomnessDeployed, "first deployment supplied the missing source");
        uint256 nonce = vm.getNonce(address(this));
        uint256 steps = _coreV1StepCount();
        CoreV1Version memory second = _deployCoreV1(_config());
        assertFalse(second.randomnessDeployed);
        assertEq(second.randomness, version.randomness);
        assertEq(second.factory, vm.computeCreateAddress(address(this), nonce + 12));
        assertEq(_coreV1StepCount() - steps, 13, "twelve implementations/planner, then factory");
        assertEq(BoxCoordinator(second.impls.coordinator).factory(), second.factory);
    }

    function test_AR02_sameRuntimeAtAnotherCoordinatorImplementationIsRefused() public {
        (,, address h) = _create(_box0Spec());
        IBoxFactoryV1.Box0Addresses memory a = factory.box0Addresses();
        address twin = address(0xC0DE);
        vm.etch(twin, version.impls.coordinator.code);
        vm.etch(STRANGER, BoxClones.runtime(twin, new bytes(154)));
        assertFalse(BoxClones.isCloneOf(STRANGER, version.impls.coordinator));
        address[7] memory targets = [h, a.launchRouter, a.receiver, a.collection, a.vault, a.tickets, a.itemStream];
        for (uint256 i; i < targets.length; ++i) {
            bytes memory code = targets[i].code;
            for (uint256 j; j < 20; ++j) {
                code[45 + j] = bytes20(STRANGER)[j];
            }
            address rogue = BoxClones.create(BoxClones.initCode(code));
            _denied(rogue, abi.encodeWithSignature("initialize()"), "NotCoordinator(address)");
        }
    }

    function test_AR20_publicFundingAndExecutionCannotChooseAPayee() public {
        _create(_box0Spec());
        IBoxFactoryV1.Box0Addresses memory a = factory.box0Addresses();
        FitBuybackExecutor executor = FitBuybackExecutor(payable(a.executor));
        vm.deal(STRANGER, 19 wei);
        vm.prank(STRANGER);
        executor.fundBudget{value: 19 wei}();
        assertEq(executor.budget(), 19);
        vm.prank(STRANGER);
        (uint256 chunks, uint256 spent, uint256 burned) = executor.execute(1);
        assertEq(chunks | spent | burned, 0, "no purchases before graduation");
        assertEq(STRANGER.balance, 0, "permissionless executor pays no caller");
        assertEq(executor.budget(), 19);
        vm.prank(STRANGER);
        executor.poke();
    }

    function _swapGate(address h, address sender, bool buy, string memory errorSignature) internal {
        PoolKey memory unused;
        SwapParams memory params = SwapParams(buy, -int256(1), 1);
        vm.prank(address(pm));
        (bool ok, bytes memory result) = h.staticcall(abi.encodeCall(BoxHook.beforeSwap, (sender, unused, params, "")));
        if (bytes(errorSignature).length == 0) {
            assertTrue(ok);
        } else {
            assertFalse(ok);
            assertEq(bytes4(result), bytes4(keccak256(bytes(errorSignature))));
        }
    }
}
