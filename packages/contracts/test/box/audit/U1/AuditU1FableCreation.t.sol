// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxFactoryV1} from "../../../../src/box/BoxFactoryV1.sol";
import {BoxFactoryV1Planner} from "../../../../src/box/BoxFactoryV1Planner.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {IBoxCollection} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxFactoryV1} from "../../../../src/box/interfaces/IBoxFactoryV1.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxItemStream} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxLaunchRouter} from "../../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxRegistry} from "../../../../src/box/interfaces/IBoxRegistry.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {BoxPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {BackedSourcePins} from "../../../../src/box/randomness/BackedSourcePins.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {DrandSource} from "../../../../src/box/randomness/DrandSource.sol";
import {DrandSourcePins} from "../../../../src/box/randomness/DrandSourcePins.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";
import {
    BoxBuildGuard as RehearsalGuard,
    BoxBuildV1 as RehearsalBuildV1
} from "../../../../src/box/build/rehearsal/BoxBuildV1.sol";
import {CoreV1Deployment} from "../../../../script/lib/CoreV1Deployment.sol";
import {PinnedBackedSource} from "../../randomness/utils/PinnedBackedSource.sol";
import {PinnedDrandSource} from "../../randomness/utils/PinnedDrandSource.sol";
import {AuditU1FablePreWorld} from "./AuditU1FableBase.sol";

/// @notice TEST ONLY: a contract of the rehearsal build's guard, deployable in this (mainnet) build to show what the
/// guard does on each chain (P1.18, F78).
contract AuditU1FableRehearsalGuarded is RehearsalGuard {}

/// @notice TEST ONLY: the deploy script's steps (`CoreV1Deployment`) callable here, the sources through the local
/// CREATE2 deployer as the S7 tests do, to show the script's source-skip rule (P1.17).
contract AuditU1FableDeployer is CoreV1Deployment {
    function deployVersion(CoreV1Config memory c) external returns (CoreV1Version memory) {
        return _deployCoreV1(c);
    }

    function _deployDrandSource(address pinned) internal override {
        require(address(PinnedDrandSource.deploy(vm)) == pinned, "u1: the pinned source");
    }

    function _deployBackedSource(address pinned) internal override {
        require(address(PinnedBackedSource.deploy(vm)) == pinned, "u1: the pinned backed source");
    }
}

/// @notice SH-AUDIT-B0 U1 (Fable), creation and identity on the world one step before `createBox`: value flow (L1
/// P1.1), the refusals and once-only steps (L2 P1.3), the calls `createBox` makes (L3 P1.7), the hook's flags and the
/// pool's identity (L6 P1.10, P1.11), the nonce plan (L8 P1.14), the CREATE2 pins and the script's skip rule (P1.17)
/// and the build profiles (P1.18). Every test here starts with the version deployed and nothing of box 0 created.
/// forge-config: default.evm_version = "osaka"
contract AuditU1FableCreationTest is AuditU1FablePreWorld {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    // ============================================================================================================
    // L1 · value flow at creation (P1.1; BoxFactoryV1.sol:75-76, :240-260; BC-004)

    /// P1.1: before the creation the factory, planner and registry hold nothing; the creation moves exactly
    /// BOOTSTRAP_ETH, which ends as the pool's reserves (the PoolManager's balance), its T burned; afterwards the
    /// factory, planner, registry and every box address but the PoolManager hold 0 wei, the coordinator holds exactly
    /// the pool share of T, the PoolManager the curve's T less the bootstrap's, and supply + burned == the issuance.
    function testProperty_AUDIT_U1_creationMovesOnlyTheBootstrap() public {
        assertEq(address(factory).balance + address(planner).balance + address(registry).balance, 0, "before: 0");
        uint256 pmBefore = address(pm).balance;
        uint256 kitBefore = address(kit).balance;
        _createNow();
        assertEq(address(kit).balance, kitBefore, "the kit dealt itself the bootstrap and spent exactly it");
        assertEq(address(pm).balance - pmBefore, BoxSpecV1.BOOTSTRAP_ETH, "the bootstrap is the pool's reserve");
        assertEq(address(factory).balance, 0, "factory");
        assertEq(address(planner).balance, 0, "planner");
        assertEq(address(registry).balance, 0, "registry");
        address[12] memory list = _predictedList();
        for (uint256 i; i < list.length; ++i) {
            assertEq(list[i].balance, 0, "a box address holds no ETH at creation");
        }
        BoxToken t = token;
        uint256 burned = t.totalBurned();
        assertGt(burned, 0, "the bootstrap's T was burned");
        assertEq(t.totalSupply() + burned, BoxSpecV1.ISSUANCE, "supply + burned == issuance");
        assertEq(t.balanceOf(a.coordinator), curve.poolShare, "the coordinator holds the pool share");
        assertEq(t.balanceOf(a.coordinator) + t.balanceOf(address(pm)), t.totalSupply(), "all T in the box");
        assertEq(t.balanceOf(address(kit)), 0, "the creator got no T");
        assertEq(pm.balanceOf(a.coordinator, 0), 0, "no ETH claims at the coordinator yet");
        assertEq(pm.balanceOf(a.receiver, 0), 0, "no ETH claims at the receiver yet");
        assertEq(pm.balanceOf(a.hook, 0), 0, "no ETH claims at the hook yet");
        _bookWorld();
        _assertGhostLedger();
    }

    // ============================================================================================================
    // L2 · who may create, once, with exactly the value, code and spec (P1.3; BC-011, BC-034, BC-064)

    /// P1.3: any caller but the box-0 creator is refused `NotBox0Creator` whatever it sends, with nothing created.
    function testFuzz_AUDIT_U1_onlyTheCreatorCreates(address caller, uint96 value, bytes32 salt) public {
        vm.assume(caller != address(kit));
        BoxSpecV1.BoxSpec memory s = _preSpec();
        vm.deal(caller, value);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.NotBox0Creator.selector, caller));
        factory.createBox{value: value}(s, salt, _executorCode());
        _assertNothingCreated();
    }

    /// P1.3: the creator with any value but BOOTSTRAP_ETH is refused `WrongValue`; with the right value and any
    /// executor code but the pinned one `ExecutorCodeMismatch`; nothing is created either way.
    function testFuzz_AUDIT_U1_wrongValueOrExecutorCodeCreatesNothing(uint96 value, bytes calldata otherCode) public {
        vm.assume(value != BoxSpecV1.BOOTSTRAP_ETH);
        bytes memory executorCode = _executorCode();
        vm.assume(keccak256(otherCode) != keccak256(executorCode));
        BoxSpecV1.BoxSpec memory s = _preSpec();
        bytes32 salt = kit.hookSalt();
        vm.deal(address(kit), uint256(value) + BoxSpecV1.BOOTSTRAP_ETH);
        vm.prank(address(kit));
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.WrongValue.selector, value, BoxSpecV1.BOOTSTRAP_ETH));
        factory.createBox{value: value}(s, salt, executorCode);
        vm.prank(address(kit));
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.ExecutorCodeMismatch.selector, keccak256(otherCode)));
        factory.createBox{value: BoxSpecV1.BOOTSTRAP_ETH}(s, salt, otherCode);
        _assertNothingCreated();
    }

    /// P1.3: a spec the planner refuses (any field it rules on, mutated at random) makes `createBox` revert with
    /// exactly `refusal()`'s data, before any value, code or salt is looked at, and creates nothing; a spec it accepts
    /// is template 0 by the planner's own rules.
    function testFuzz_AUDIT_U1_refusedSpecsCreateNothing(uint8 field, uint256 v) public {
        BoxSpecV1.BoxSpec memory s = _mutate(_preSpec(), field % 12, v);
        bytes memory err = factory.refusal(s, address(kit));
        if (err.length == 0) {
            assertEq(planner.refusal(s, factory.platformSafe()).length, 0, "accepted: template 0");
            assertLe(s.openAt, block.timestamp + BoxSpecV1.MAX_OPEN_AHEAD_SECONDS, "accepted: within the horizon");
            return;
        }
        vm.deal(address(kit), 1 ether);
        vm.prank(address(kit));
        vm.expectRevert(err);
        // A wrong value, a wrong code and an unmined salt: the spec's refusal comes first.
        factory.createBox{value: 1}(s, bytes32(0), "");
        _assertNothingCreated();
    }

    /// P1.3, BC-034: after box 0 exists every further `createBox` by the creator is `Box0Exists`, for the same spec
    /// and for any other, and every once-only step of the creation refuses a second run from its own documented
    /// caller: the coordinator's `deploy` and `launch` (the factory), every clone's `initialize` and the hook's
    /// `launch` (the coordinator), the registry's `record` (the factory).
    function testProperty_AUDIT_U1_onceOnlyStepsHappenOnce() public {
        _createNow();
        BoxSpecV1.BoxSpec memory s = _preSpec();
        bytes memory codeE = _executorCode();
        bytes32 salt = kit.hookSalt();
        vm.deal(address(kit), BoxSpecV1.BOOTSTRAP_ETH);
        vm.prank(address(kit));
        vm.expectRevert(IBoxFactoryV1.Box0Exists.selector);
        factory.createBox{value: BoxSpecV1.BOOTSTRAP_ETH}(s, salt, codeE);
        s.openAt = uint32(block.timestamp + 2 hours);
        assertEq(factory.refusal(s, address(kit)), abi.encodeWithSelector(IBoxFactoryV1.Box0Exists.selector));
        assertEq(registry.boxCount(), 1);
        // The coordinator: deploy and launch once (the factory is their caller).
        bytes[] memory none = new bytes[](0);
        vm.startPrank(address(factory));
        vm.expectRevert(BoxCoordinator.AlreadyDeployed.selector);
        coordinator.deploy(none, "", bytes32(0), 0);
        vm.expectRevert(IBoxCoordinator.AlreadyLaunched.selector);
        coordinator.launch{value: 0}();
        vm.expectRevert(abi.encodeWithSelector(IBoxRegistry.AlreadyRecorded.selector, a.coordinator));
        registry.record(a.coordinator, bytes32(0), abi.encode(s));
        vm.stopPrank();
        // Every clone initialises once; the hook launches once (the coordinator is their caller).
        vm.startPrank(a.coordinator);
        vm.expectRevert(IBoxCollection.AlreadyInitialised.selector);
        collection.initialize();
        vm.expectRevert(IBoxVault.AlreadyInitialised.selector);
        vault.initialize();
        vm.expectRevert(IBoxTickets.AlreadyInitialised.selector);
        tickets.initialize();
        vm.expectRevert(IBoxHook.AlreadyInitialised.selector);
        hook.initialize();
        vm.expectRevert(IBoxLaunchRouter.AlreadyInitialised.selector);
        launchRouter.initialize();
        vm.expectRevert(IBoxReceiver.AlreadyInitialised.selector);
        receiver.initialize();
        vm.expectRevert(IBoxItemStream.AlreadyInitialised.selector);
        stream.initialize();
        vm.expectRevert(IBoxHook.AlreadyLaunched.selector);
        hook.launch();
        vm.expectRevert(IBoxLaunchRouter.AlreadyBootstrapped.selector);
        launchRouter.bootstrap{value: 0}();
        vm.stopPrank();
    }

    // ============================================================================================================
    // L3 · what createBox calls (P1.7; BoxFactoryV1.sol:240-262)

    /// P1.7: inside `createBox` every CALL, STATICCALL, DELEGATECALL and CREATE reaches a contract of the version
    /// (the factory, planner, registry, the implementations and extensions), a contract of box 0 (the coordinator, the
    /// ten nonce addresses, the hook) or the PoolManager, never the WETH, a source, the Safe or any other address; the
    /// only value-carrying calls are the factory's `launch`, the coordinator's `bootstrap` and the router's settlement
    /// into the PoolManager, each with the bootstrap and all the gas (no stipend send exists in this unit); and the
    /// contracts outside box 0 the creation touches (the PoolManager) are called only after every re-entrant path
    /// into the factory is closed (`createBox` is not re-enterable: `Box0Exists` would refuse, and nothing it calls
    /// can call it before the registry's record).
    function testProperty_AUDIT_U1_createBoxCallsOnlyTheVersionTheBoxAndThePoolManager() public {
        vm.startStateDiffRecording();
        kit.create();
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        _bindHandles();
        uint256 valueCalls;
        uint256 calls;
        for (uint256 i; i < acc.length; ++i) {
            VmSafe.AccountAccessKind k = acc[i].kind;
            bool isCall = k == VmSafe.AccountAccessKind.Call || k == VmSafe.AccountAccessKind.StaticCall
                || k == VmSafe.AccountAccessKind.DelegateCall || k == VmSafe.AccountAccessKind.CallCode
                || k == VmSafe.AccountAccessKind.Create;
            if (!isCall) continue;
            ++calls;
            assertTrue(_allowedCallee(acc[i].account), string.concat("callee: ", vm.toString(acc[i].account)));
            // A clone's DELEGATECALL to its implementation carries the frame's msg.value (no transfer): not a send.
            if (k == VmSafe.AccountAccessKind.DelegateCall || acc[i].value == 0) continue;
            ++valueCalls;
            assertEq(acc[i].value, BoxSpecV1.BOOTSTRAP_ETH, "every value call carries the bootstrap");
            bool known = (acc[i].accessor == address(kit) && acc[i].account == address(factory))
                || (acc[i].accessor == address(factory) && acc[i].account == a.coordinator)
                || (acc[i].accessor == a.coordinator && acc[i].account == a.launchRouter)
                || (acc[i].accessor == a.launchRouter && acc[i].account == address(pm));
            assertTrue(known, "a value call outside the bootstrap's path");
        }
        assertEq(valueCalls, 4, "kit -> factory -> coordinator -> router -> PoolManager");
        assertGt(calls, 50, "the creation was recorded");
        assertEq(address(kit.weth()).balance, 0, "WETH never touched");
    }

    function _allowedCallee(address x) internal view returns (bool) {
        if (x == address(factory) || x == address(planner) || x == address(registry) || x == address(pm)) return true;
        if (x == address(kit)) return true; // the test driver's own frame (the creator)
        address[12] memory list = _predictedList();
        for (uint256 i; i < list.length; ++i) {
            if (x == list[i]) return true;
        }
        address[11] memory v = [
            impls.coordinator,
            impls.hook,
            impls.hookExtension,
            impls.launchRouter,
            impls.receiver,
            impls.receiverExtension,
            impls.collection,
            impls.vault,
            impls.tickets,
            impls.royaltyRouter,
            impls.itemStream
        ];
        for (uint256 i; i < v.length; ++i) {
            if (x == v[i]) return true;
        }
        return false;
    }

    // ============================================================================================================
    // L6 · the hook's address and the pool's identity (P1.10, P1.11; BoxFactoryV1.sol:361-366, :503-512)

    /// P1.10: for any salt, `predictHook` is CREATE2(coordinator, salt, hookInitCodeHash(openAt)); the factory
    /// accepts the salt exactly when the address carries the flags 0x2AE0 in its low 14 bits and no 0x91 prefix, and
    /// refuses it `HookSaltNotMined` before any state changes; the mined salt's hook is exactly the one created.
    function testFuzz_AUDIT_U1_hookSaltAcceptedOnlyWithTheFlags(bytes32 salt) public {
        BoxSpecV1.BoxSpec memory s = _preSpec();
        address predictedHook = factory.predictHook(s.openAt, salt);
        assertEq(
            predictedHook,
            vm.computeCreate2Address(salt, factory.hookInitCodeHash(s.openAt), predicted.coordinator),
            "predictHook is CREATE2 by the coordinator"
        );
        uint160 h = uint160(predictedHook);
        bool mined = (h & 0x3FFF) == BoxSpecV1.HOOK_FLAGS && (h >> 152) != BoxSpecV1.HOOK_FORBIDDEN_ADDRESS_PREFIX;
        if (!mined) {
            vm.deal(address(kit), BoxSpecV1.BOOTSTRAP_ETH);
            vm.prank(address(kit));
            vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.HookSaltNotMined.selector, predictedHook));
            factory.createBox{value: BoxSpecV1.BOOTSTRAP_ETH}(s, salt, _executorCode());
            _assertNothingCreated();
            return;
        }
        // A mined salt (the miner's or a lucky fuzz value): the hook is created exactly there, with the flags v4 reads.
        vm.deal(address(kit), BoxSpecV1.BOOTSTRAP_ETH);
        vm.prank(address(kit));
        (, address c, address hookAt) = factory.createBox{value: BoxSpecV1.BOOTSTRAP_ETH}(s, salt, _executorCode());
        assertEq(hookAt, predictedHook, "the hook at its predicted address");
        assertEq(c, predicted.coordinator);
        assertEq(uint160(hookAt) & 0x3FFF, 0x2AE0, "exactly the six flags");
        assertTrue(Hooks.isValidHookAddress(IHooks(hookAt), BoxSpecV1.LP_FEE), "v4 accepts the address");
        assertEq(IBoxCoordinator(c).hook(), hookAt, "the coordinator names it");
    }

    /// P1.10: the world's mined salt is the first salt (counting from 0) whose address carries the flags, so anyone
    /// recomputes it from public data; the flags are exactly the hook's declared permissions.
    function testProperty_AUDIT_U1_theMinedSaltIsPublicAndMinimal() public view {
        bytes32 salt = kit.hookSalt();
        bytes32 h = factory.hookInitCodeHash(_preSpec().openAt);
        for (uint256 s; s < uint256(salt); ++s) {
            address at = BoxClones.predict(predicted.coordinator, bytes32(s), h);
            uint160 u = uint160(at);
            assertFalse((u & 0x3FFF) == 0x2AE0 && (u >> 152) != 0x91, "an earlier salt would do");
        }
        uint160 mined = uint160(factory.predictHook(_preSpec().openAt, salt));
        assertEq(mined & 0x3FFF, 0x2AE0);
        assertTrue(mined >> 152 != 0x91);
        assertEq(BoxSpecV1.HOOK_FLAGS, 0x2AE0, "BoxSpecV1.HOOK_FLAGS");
        assertEq(
            uint160(
                Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                    | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG
            ),
            0x2AE0,
            "the six permissions the hook declares"
        );
    }

    /// P1.11: nobody can take box 0's pool before the creation: `PoolManager.initialize` with the predicted hook
    /// reverts (the hook's beforeInitialize flag is set and no code answers there), and a pool of the same currencies
    /// with another fee or no hook has another id; after the creation the factory's re-read (the hook's pool id, fee
    /// 1%, spacing 60, the curve's liquidity active, the price inside the curve) is the pool the hook initialised,
    /// and the stranger's other pool changes nothing of it.
    function testProperty_AUDIT_U1_thePoolReReadIsTheHooksOwn() public {
        PoolKey memory key = poolKey;
        PoolId id = key.toId();
        // Before: the predicted hook has no code; v4 calls its beforeInitialize and gets no answer.
        vm.expectRevert();
        pm.initialize(key, curve.sqrtPriceUpperX96);
        (uint160 price,,,) = pm.getSlot0(id);
        assertEq(price, 0, "no pool before the creation");
        // A stranger's pool of the same currencies without the hook: another id, initialised fine, not box 0's.
        PoolKey memory other = PoolKey(key.currency0, key.currency1, 3_000, 60, IHooks(address(0)));
        vm.prank(eoa[0]);
        pm.initialize(other, curve.sqrtPriceUpperX96);
        assertTrue(PoolId.unwrap(other.toId()) != PoolId.unwrap(id), "another pool id");
        _createNow();
        assertEq(PoolId.unwrap(hook.poolId()), PoolId.unwrap(id), "the hook's pool id is the key's");
        assertEq(PoolId.unwrap(hook.poolId()), keccak256(abi.encode(key)), "keccak256(abi.encode(key))");
        (uint160 sqrtPrice, int24 tick,, uint24 lpFee) = pm.getSlot0(id);
        assertEq(lpFee, BoxSpecV1.LP_FEE, "1% static fee");
        assertTrue(tick >= curve.tickLower && tick < curve.tickUpper, "inside the curve");
        assertLt(sqrtPrice, curve.sqrtPriceUpperX96, "below P0 after the bootstrap buy");
        assertEq(pm.getLiquidity(id), curve.liquidity, "the curve's liquidity is active");
        assertEq(registry.recordOf(0).poolId, PoolId.unwrap(id), "the record carries it");
        (uint160 otherPrice,,,) = pm.getSlot0(other.toId());
        assertEq(otherPrice, curve.sqrtPriceUpperX96, "the stranger's pool is untouched and separate");
        assertEq(pm.getLiquidity(other.toId()), 0, "and empty");
    }

    // ============================================================================================================
    // L8 · the nonce plan, the pins and the build profiles (P1.14, P1.17, P1.18)

    /// P1.14 (Osaka; Cancun and Amsterdam in AuditU1FableGas): the planner's nonce plan is the coordinator's actual
    /// CREATE order: table 1, T 2, vault 3, collection 4, receiver 5, launch router 6, FIT's executor 7, tickets 8,
    /// per-item stream 9, royalty router 10; the coordinator is the factory's nonce 2 and the registry its nonce 1.
    function testProperty_AUDIT_U1_noncePlanIsTheCreateOrder() public {
        _createNow();
        _assertNoncePlan();
    }

    function _assertNoncePlan() internal view {
        address c = a.coordinator;
        assertEq(c, vm.computeCreateAddress(address(factory), 2), "coordinator: the factory's nonce 2");
        assertEq(address(registry), vm.computeCreateAddress(address(factory), 1), "registry: nonce 1");
        assertEq(collection.metadataTable(), vm.computeCreateAddress(c, 1), "table: nonce 1");
        assertEq(coordinator.token(), vm.computeCreateAddress(c, 2), "T: nonce 2");
        assertEq(coordinator.vault(), vm.computeCreateAddress(c, 3), "vault: nonce 3");
        assertEq(coordinator.collection(), vm.computeCreateAddress(c, 4), "collection: nonce 4");
        assertEq(coordinator.receiver(), vm.computeCreateAddress(c, 5), "receiver: nonce 5");
        assertEq(coordinator.launchRouter(), vm.computeCreateAddress(c, 6), "launch router: nonce 6");
        assertEq(coordinator.executor(), vm.computeCreateAddress(c, 7), "FIT's executor: nonce 7");
        assertEq(coordinator.tickets(), vm.computeCreateAddress(c, 8), "tickets: nonce 8");
        assertEq(coordinator.itemStream(), vm.computeCreateAddress(c, 9), "per-item stream: nonce 9");
        assertEq(coordinator.royaltyRouter(), vm.computeCreateAddress(c, 10), "royalty router: nonce 10");
        assertEq(vm.getNonce(c), 12, "ten CREATEs by the coordinator, then the hook's CREATE2 (a nonce too)");
        assertEq(vm.getNonce(address(factory)), 3, "two CREATEs by the factory");
        IBoxFactoryV1.Box0Addresses memory p = factory.box0Addresses();
        assertEq(p.table, collection.metadataTable());
        assertEq(p.token, coordinator.token());
        assertEq(p.vault, coordinator.vault());
        assertEq(p.collection, coordinator.collection());
        assertEq(p.receiver, coordinator.receiver());
        assertEq(p.launchRouter, coordinator.launchRouter());
        assertEq(p.executor, coordinator.executor());
        assertEq(p.tickets, coordinator.tickets());
        assertEq(p.itemStream, coordinator.itemStream());
        assertEq(p.royaltyRouter, coordinator.royaltyRouter());
        for (uint8 role; role < 9; ++role) {
            uint256 nonce = coordinator.nonceOf(role);
            assertTrue(nonce >= 2 && nonce <= 10, "every role's nonce in 2..10");
        }
    }

    /// P1.17: both CREATE2 pins equal CREATE2(Arachnid deployer, salt, keccak256(creation code)) of the sources this
    /// build compiles, the runtime at each pin hashes to the pinned code hash, and a second deployment of the same
    /// init code gives byte-for-byte the same runtime (the sources read no chain state at construction): "present
    /// but different" cannot arise from the deployer; the deploy script skips a source when any code is present
    /// (`CoreV1Deployment._deploySources`), and the hash gate is the factory's constructor, which refuses the
    /// version (`SourceNotPinned`) when the code at a pin is not the pinned one.
    function testProperty_AUDIT_U1_pinsAreTheCompiledSourcesAndTheScriptsGateIsTheFactory() public {
        assertEq(keccak256(type(DrandSource).creationCode), DrandSourcePins.INIT_CODE_HASH, "DrandSource init hash");
        assertEq(
            keccak256(type(BoxBackedSource).creationCode), BackedSourcePins.INIT_CODE_HASH, "BoxBackedSource init hash"
        );
        assertEq(
            vm.computeCreate2Address(DrandSourcePins.SALT, DrandSourcePins.INIT_CODE_HASH, DrandSourcePins.DEPLOYER),
            DrandSourcePins.ADDRESS_MAINNET,
            "DrandSource pin"
        );
        assertEq(
            vm.computeCreate2Address(BackedSourcePins.SALT, BackedSourcePins.INIT_CODE_HASH, BackedSourcePins.DEPLOYER),
            BackedSourcePins.ADDRESS_MAINNET,
            "BoxBackedSource pin"
        );
        assertEq(DrandSourcePins.ADDRESS_MAINNET.codehash, DrandSourcePins.CODE_HASH_MAINNET, "DrandSource code");
        assertEq(BackedSourcePins.ADDRESS_MAINNET.codehash, BackedSourcePins.CODE_HASH_MAINNET, "backed code");
        assertEq(PinnedDrandSource.predict(), DrandSourcePins.ADDRESS_MAINNET);
        assertEq(PinnedBackedSource.predict(), BackedSourcePins.ADDRESS_MAINNET);
        assertEq(factory.randomness(), BackedSourcePins.ADDRESS_MAINNET, "the factory's source is the pin");
        // Determinism: the same init code elsewhere gives the same runtime (no chain state in the constructors).
        address twinDrand = address(new DrandSource());
        address twinBacked = address(new BoxBackedSource());
        assertEq(twinDrand.code, DrandSourcePins.ADDRESS_MAINNET.code, "DrandSource runtime is deterministic");
        assertEq(twinBacked.code, BackedSourcePins.ADDRESS_MAINNET.code, "BoxBackedSource runtime is deterministic");
        assertEq(address(BoxBackedSource(twinBacked).DRAND()), DrandSourcePins.ADDRESS_MAINNET, "names the pin");
        // The script's rule: a source is deployed only when its pin has no code (the world's run found both present).
        AuditU1FableDeployer d = new AuditU1FableDeployer();
        CoreV1Deployment.CoreV1Config memory c = CoreV1Deployment.CoreV1Config({
            deployer: address(d),
            callsTakeNonce: false,
            poolManager: pm,
            weth: address(kit.weth()),
            platformSafe: BoxSpecV1.PLATFORM_SAFE_MAINNET,
            box0Creator: address(this)
        });
        CoreV1Deployment.CoreV1Version memory v = d.deployVersion(c);
        assertFalse(v.drandDeployed, "present: not deployed again");
        assertFalse(v.randomnessDeployed, "present: not deployed again");
        assertEq(BoxFactoryV1(v.factory).randomness(), BackedSourcePins.ADDRESS_MAINNET);
        // Absent: deployed through the deployer, landing at the pin with the pinned code.
        uint256 snap = vm.snapshotState();
        vm.etch(BackedSourcePins.ADDRESS_MAINNET, "");
        vm.resetNonce(BackedSourcePins.ADDRESS_MAINNET);
        v = d.deployVersion(c);
        assertTrue(v.randomnessDeployed, "absent: deployed");
        assertEq(BackedSourcePins.ADDRESS_MAINNET.codehash, BackedSourcePins.CODE_HASH_MAINNET);
        vm.revertToState(snap);
        // Present but different (a state the deployer cannot produce; etched here): the script skips the source and
        // the factory's constructor refuses the version (`SourceNotPinned`, seen directly), so the script's step after
        // the twelve implementations fails (its CREATE wrapper reports the failed step).
        vm.etch(BackedSourcePins.ADDRESS_MAINNET, hex"6000");
        _expectFactoryRefuses(BackedSourcePins.ADDRESS_MAINNET);
        vm.expectRevert(bytes("core v1: CREATE failed: BoxFactoryV1 (and its BoxRegistry)"));
        d.deployVersion(c);
        vm.revertToState(snap);
        vm.etch(DrandSourcePins.ADDRESS_MAINNET, hex"6000");
        _expectFactoryRefuses(DrandSourcePins.ADDRESS_MAINNET);
        vm.expectRevert(bytes("core v1: CREATE failed: BoxFactoryV1 (and its BoxRegistry)"));
        d.deployVersion(c);
    }

    /// @dev A factory constructed now with the world's implementations reverts `SourceNotPinned(at)`.
    function _expectFactoryRefuses(address at) internal {
        IBoxFactoryV1.Implementations memory i = factory.implementations();
        address weth = factory.weth();
        bytes32 h = factory.executorInitCodeHash();
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.SourceNotPinned.selector, at));
        new BoxFactoryV1(
            pm, i, planner, BackedSourcePins.ADDRESS_MAINNET, weth, BoxSpecV1.PLATFORM_SAFE_MAINNET, address(this), h
        );
    }

    /// P1.18 (F78): the rehearsal build's guard refuses chain id 1 in every constructor that inherits it and nothing
    /// else (11155111 and any other chain pass); the two builds differ in BoxBuildV1's seven mainnet numbers (the
    /// raise and six fixed ETH amounts, each exactly 1/10) and the five creator-fee-cap presets of version 2 (1/10
    /// too), the profile name, the rehearsal flag, the refused chain and the scale; the mainnet build refuses no
    /// chain. (The compiled codes of the two builds are not compared here: the rehearsal profile is a separate
    /// 7-minute build; see the evidence's Limitations.)
    function testProperty_AUDIT_U1_buildProfilesDifferInSevenNumbersAndTheGuard() public {
        assertEq(BoxBuildV1.REFUSED_CHAIN_ID, 0, "mainnet build refuses no chain");
        assertFalse(BoxBuildV1.REHEARSAL);
        assertEq(BoxBuildV1.SCALE_NUMERATOR, 1);
        assertEq(BoxBuildV1.SCALE_DENOMINATOR, 1);
        assertEq(keccak256(bytes(BoxBuildV1.PROFILE)), keccak256("mainnet"));
        assertEq(RehearsalBuildV1.REFUSED_CHAIN_ID, 1, "rehearsal refuses chain id 1");
        assertTrue(RehearsalBuildV1.REHEARSAL);
        assertEq(RehearsalBuildV1.SCALE_NUMERATOR, 1);
        assertEq(RehearsalBuildV1.SCALE_DENOMINATOR, 10);
        assertEq(keccak256(bytes(RehearsalBuildV1.PROFILE)), keccak256("rehearsal"));
        assertEq(RehearsalBuildV1.RAISE * 10, BoxBuildV1.RAISE, "raise");
        assertEq(RehearsalBuildV1.BOOTSTRAP_ETH * 10, BoxBuildV1.BOOTSTRAP_ETH, "bootstrap");
        assertEq(RehearsalBuildV1.FEE_BATCH_MIN_ETH * 10, BoxBuildV1.FEE_BATCH_MIN_ETH, "batch minimum");
        assertEq(RehearsalBuildV1.FEE_BATCH_TIP_MAX_ETH * 10, BoxBuildV1.FEE_BATCH_TIP_MAX_ETH, "tip cap");
        assertEq(RehearsalBuildV1.SWAP_STEP_MIN_Q * 10, BoxBuildV1.SWAP_STEP_MIN_Q, "swap step");
        assertEq(RehearsalBuildV1.DEPTH_CONVERT_MIN_Q * 10, BoxBuildV1.DEPTH_CONVERT_MIN_Q, "depth conversion");
        assertEq(RehearsalBuildV1.PLATFORM_CAP_WEI * 10, BoxBuildV1.PLATFORM_CAP_WEI, "platform cap");
        assertEq(RehearsalBuildV1.CREATOR_FEE_CAP_PRESET_0 * 10, BoxBuildV1.CREATOR_FEE_CAP_PRESET_0);
        assertEq(RehearsalBuildV1.CREATOR_FEE_CAP_PRESET_1 * 10, BoxBuildV1.CREATOR_FEE_CAP_PRESET_1);
        assertEq(RehearsalBuildV1.CREATOR_FEE_CAP_PRESET_2 * 10, BoxBuildV1.CREATOR_FEE_CAP_PRESET_2);
        assertEq(RehearsalBuildV1.CREATOR_FEE_CAP_PRESET_3 * 10, BoxBuildV1.CREATOR_FEE_CAP_PRESET_3);
        assertEq(RehearsalBuildV1.CREATOR_FEE_CAP_PRESET_4 * 10, BoxBuildV1.CREATOR_FEE_CAP_PRESET_4);
        assertEq(BoxBuildV1.RAISE, 4_206_980_085_000_000_000, "the reviewed raise");
        assertEq(BoxBuildV1.BOOTSTRAP_ETH, 0.0015 ether);
        assertEq(BoxBuildV1.PLATFORM_CAP_WEI, 32 ether);
        assertEq(BoxSpecV1.BOOTSTRAP_ETH, BoxBuildV1.BOOTSTRAP_ETH, "BoxSpecV1 reads the build");
        assertEq(BoxSpecV1.qListV1()[0].raisePresets[0], BoxBuildV1.RAISE, "the raise preset is the build's");
        // The guard: chain id 1 refused, every other chain accepted.
        assertEq(block.chainid, 1);
        vm.expectRevert(abi.encodeWithSelector(RehearsalGuard.RehearsalBuildRefusesChain.selector, 1));
        new AuditU1FableRehearsalGuarded();
        vm.chainId(11_155_111);
        assertGt(address(new AuditU1FableRehearsalGuarded()).code.length, 0, "Sepolia passes");
        vm.chainId(31_337);
        assertGt(address(new AuditU1FableRehearsalGuarded()).code.length, 0, "any other chain passes the guard");
        vm.chainId(1);
    }

    // ============================================================================================================
    // helpers

    /// @dev Box 0's spec with field `f` set from `v` (every field the factory or the planner rules on).
    function _mutate(BoxSpecV1.BoxSpec memory s, uint256 f, uint256 v)
        internal
        view
        returns (BoxSpecV1.BoxSpec memory)
    {
        if (f == 0) {
            s.version = uint16(v % 4);
        } else if (f == 1) {
            s.boxType = uint8(v % 5);
        } else if (f == 2) {
            s.q = v % 3 == 0 ? address(0) : address(uint160(v));
        } else if (f == 3) {
            s.qStream = uint8(v % 9);
        } else if (f == 4) {
            s.tStream = uint8(v % 9);
        } else if (f == 5) {
            s.artMode = uint8(v % 4);
        } else if (f == 6) {
            s.marketplaceOwner = v % 3 == 0 ? BoxSpecV1.PLATFORM_SAFE_MAINNET : address(uint160(v));
        } else if (f == 7) {
            s.openAt = uint32(bound(v, 0, block.timestamp + 20 days));
        } else if (f == 8) {
            s.n = uint32(bound(v, 0, 12_000));
        } else if (f == 9) {
            s.raise = v % 2 == 0 ? BoxBuildV1.RAISE : bound(v, 0, 100 ether);
        } else if (f == 10) {
            s.deadlineDays = uint16(v % 400);
        } else if (f == 11) {
            s.creatorBuy = v % 2 == 0 ? 0 : bound(v, 1, 1 ether);
        }
        return s;
    }
}
