// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxFactoryV1Planner} from "../../../../src/box/BoxFactoryV1Planner.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxItemStream} from "../../../../src/box/BoxItemStream.sol";
import {BoxLaunchRouter} from "../../../../src/box/BoxLaunchRouter.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxRegistry} from "../../../../src/box/BoxRegistry.sol";
import {BoxRoyaltyRouter} from "../../../../src/box/BoxRoyaltyRouter.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {IBoxFactoryV1} from "../../../../src/box/interfaces/IBoxFactoryV1.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {CoreBox0Kit, CoreImpls} from "../../conformance/core/CoreBox0Kit.sol";
import {AuditBox0World} from "../common/AuditBox0World.sol";
import {AuditPhases} from "../common/AuditPhases.sol";
import {AuditU1FableTables as T} from "./AuditU1FableTables.sol";

/// @notice One contract of box 0's surface: where it is, its selector table and the role it plays.
struct AuditU1Target {
    address at;
    string label;
    bytes table;
    string sigs;
    /// An implementation or an extension (never a box: every entry but the PoolManager's callbacks is class NOBODY).
    bool implementation;
}

/// @title AuditU1FableWorld
/// @notice TEST ONLY (SH-AUDIT-B0 U1, Fable). The audit world (box 0 created by factory v1 on the mainnet build, the
/// shared `AuditPhases`) plus what unit U1 needs: the surface of box 0 (every live contract, every implementation and
/// extension, the factory, its planner and registry, each with its selector table), the set of addresses whose storage
/// is box 0's, the planner's plan of the world's box 0, stranger clones of every implementation, and the state-diff
/// helpers that count the storage writes a call made.
abstract contract AuditU1FableWorld is AuditPhases {
    uint256 internal constant TX_GAS_CAP = 16_777_216;
    uint256 internal constant EIP170 = 24_576;
    uint256 internal constant EIP3860 = 49_152;

    CoreImpls internal impls;
    BoxRegistry internal registry;
    BoxFactoryV1Planner internal planner;
    /// @notice Every account whose storage belongs to box 0's system (its contracts, the version, the PoolManager, the
    /// sources): a write there by an undocumented caller is a BC-010 violation.
    mapping(address => bool) internal isBox0Storage;
    address[] internal box0Storage;
    AuditU1Target[] internal targets;
    /// @notice A stranger's standard clone of each implementation (index as `_implList`), with box 0's own arguments.
    address[] internal strangerClones;
    address internal stranger;

    function setUp() public virtual override {
        super.setUp();
        impls = kit.impls();
        registry = BoxRegistry(factory.registry());
        planner = factory.planner();
        stranger = makeAddr("audit.u1.stranger");
        _buildStorageSet();
        _buildTargets();
    }

    // ================================================================================================ the spec and plan

    function _worldSpec() internal view returns (BoxSpecV1.BoxSpec memory) {
        return kit.spec();
    }

    /// @notice The planner's plan of the world's box 0 (codes as the planner gives them: T's and the executor's hold
    /// only their constructor arguments).
    function _worldPlan() internal view returns (BoxFactoryV1Planner.Plan memory) {
        BoxSpecV1.BoxSpec memory s = _worldSpec();
        return planner.plan(s, factory.version(), address(kit), kit.hookSalt(), keccak256(abi.encode(s)));
    }

    // ================================================================================================ the surface

    function _buildStorageSet() internal {
        address[] memory sys = ghostSystem();
        for (uint256 i; i < sys.length; ++i) {
            _addStorage(sys[i]);
        }
        _addStorage(address(planner));
        address[11] memory list = _implList();
        for (uint256 i; i < list.length; ++i) {
            _addStorage(list[i]);
        }
    }

    function _addStorage(address x) internal {
        if (x == address(0) || isBox0Storage[x]) return;
        isBox0Storage[x] = true;
        box0Storage.push(x);
    }

    /// @notice The version's eleven code deployments: 9 implementations and the two extensions.
    function _implList() internal view returns (address[11] memory list) {
        list = [
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
    }

    function _buildTargets() internal {
        _target(a.coordinator, "coordinator", T.BOX_COORDINATOR, T.BOX_COORDINATOR_SIGS, false);
        _target(a.hook, "hook", T.BOX_HOOK, T.BOX_HOOK_SIGS, false);
        _target(a.launchRouter, "launch router", T.BOX_LAUNCH_ROUTER, T.BOX_LAUNCH_ROUTER_SIGS, false);
        _target(a.receiver, "receiver", T.BOX_RECEIVER, T.BOX_RECEIVER_SIGS, false);
        _target(a.collection, "collection", T.BOX_COLLECTION, T.BOX_COLLECTION_SIGS, false);
        _target(a.vault, "vault", T.BOX_VAULT, T.BOX_VAULT_SIGS, false);
        _target(a.tickets, "tickets", T.BOX_TICKETS, T.BOX_TICKETS_SIGS, false);
        _target(a.royaltyRouter, "royalty router", T.BOX_ROYALTY_ROUTER, T.BOX_ROYALTY_ROUTER_SIGS, false);
        _target(a.itemStream, "item stream", T.BOX_ITEM_STREAM, T.BOX_ITEM_STREAM_SIGS, false);
        _target(a.token, "T", T.BOX_TOKEN, T.BOX_TOKEN_SIGS, false);
        _target(a.executor, "FIT's executor", T.FIT_BUYBACK_EXECUTOR, T.FIT_BUYBACK_EXECUTOR_SIGS, false);
        _target(address(factory), "factory", T.BOX_FACTORY_V1, T.BOX_FACTORY_V1_SIGS, false);
        _target(address(registry), "registry", T.BOX_REGISTRY, T.BOX_REGISTRY_SIGS, false);
        _target(address(planner), "planner", T.BOX_FACTORY_V1_PLANNER, T.BOX_FACTORY_V1_PLANNER_SIGS, false);
        _target(impls.coordinator, "impl coordinator", T.BOX_COORDINATOR, T.BOX_COORDINATOR_SIGS, true);
        _target(impls.hook, "impl hook", T.BOX_HOOK, T.BOX_HOOK_SIGS, true);
        _target(impls.hookExtension, "hook extension", T.BOX_HOOK_EXTENSION, T.BOX_HOOK_EXTENSION_SIGS, true);
        _target(impls.launchRouter, "impl launch router", T.BOX_LAUNCH_ROUTER, T.BOX_LAUNCH_ROUTER_SIGS, true);
        _target(impls.receiver, "impl receiver", T.BOX_RECEIVER, T.BOX_RECEIVER_SIGS, true);
        _target(
            impls.receiverExtension, "receiver extension", T.BOX_RECEIVER_EXTENSION, T.BOX_RECEIVER_EXTENSION_SIGS, true
        );
        _target(impls.collection, "impl collection", T.BOX_COLLECTION, T.BOX_COLLECTION_SIGS, true);
        _target(impls.vault, "impl vault", T.BOX_VAULT, T.BOX_VAULT_SIGS, true);
        _target(impls.tickets, "impl tickets", T.BOX_TICKETS, T.BOX_TICKETS_SIGS, true);
        _target(impls.royaltyRouter, "impl royalty router", T.BOX_ROYALTY_ROUTER, T.BOX_ROYALTY_ROUTER_SIGS, true);
        _target(impls.itemStream, "impl item stream", T.BOX_ITEM_STREAM, T.BOX_ITEM_STREAM_SIGS, true);
    }

    function _target(address at, string memory label, bytes memory table, string memory sigs, bool implementation)
        internal
    {
        targets.push(AuditU1Target({at: at, label: label, table: table, sigs: sigs, implementation: implementation}));
    }

    /// @notice The documented caller class of entry `i` of `t`, as it applies at `t.at`: on an implementation every
    /// entry but a PoolManager callback is NOBODY (ADR-0016 § 4 item 5).
    function _classAt(AuditU1Target memory t, uint256 i) internal pure returns (bytes4 selector, uint8 class) {
        (selector, class) = T.entry(t.table, i);
        if (t.implementation && class != T.VIEW && class != T.POOL_MANAGER) class = T.NOBODY;
    }

    /// @notice The one address a class names on box 0 (zero for ANYONE, VIEW and NOBODY).
    function _callerOfClass(uint8 class) internal view returns (address) {
        if (class == T.FACTORY) return address(factory);
        if (class == T.COORDINATOR) return a.coordinator;
        if (class == T.POOL_MANAGER) return address(pm);
        if (class == T.RECEIVER) return a.receiver;
        if (class == T.COLLECTION) return a.collection;
        if (class == T.VAULT) return a.vault;
        if (class == T.TICKETS) return a.tickets;
        if (class == T.EXECUTOR_OR_HOOK) return a.executor;
        if (class == T.CREATOR) return address(kit);
        return address(0);
    }

    /// @notice Whether `caller` may change storage through an entry of `class` (the hook is the second caller of the
    /// receiver's fee notes).
    function _documented(uint8 class, address caller) internal view returns (bool) {
        if (class == T.ANYONE) return true;
        if (class == T.VIEW || class == T.NOBODY) return false;
        if (class == T.EXECUTOR_OR_HOOK) return caller == a.executor || caller == a.hook;
        return caller == _callerOfClass(class);
    }

    // ================================================================================================ stranger clones

    /// @notice A stranger's standard clone of every implementation carrying box 0's own arguments (the planner's), so
    /// each names box 0's real coordinator; the royalty router's as the receiving shape.
    function _makeStrangerClones() internal {
        if (strangerClones.length != 0) return;
        BoxFactoryV1Planner.Plan memory p = _worldPlan();
        address[11] memory list = _implList();
        bytes[11] memory init;
        init[0] = p.coordinatorInit;
        init[1] = p.hookInit;
        init[2] = BoxClones.initCode(impls.hookExtension, "");
        init[3] = p.codes[planner.NONCE_ROUTER() - 1];
        init[4] = p.codes[planner.NONCE_RECEIVER() - 1];
        init[5] = BoxClones.initCode(impls.receiverExtension, "");
        init[6] = p.codes[planner.NONCE_COLLECTION() - 1];
        init[7] = p.codes[planner.NONCE_VAULT() - 1];
        init[8] = p.codes[planner.NONCE_TICKETS() - 1];
        init[9] = p.codes[planner.NONCE_ROYALTY() - 1];
        init[10] = p.codes[planner.NONCE_STREAM() - 1];
        vm.startPrank(stranger);
        for (uint256 i; i < 11; ++i) {
            address c = BoxClones.create(init[i]);
            require(c != list[i] && c.code.length >= 45, "u1: the stranger's clone");
            strangerClones.push(c);
        }
        vm.stopPrank();
    }

    /// @notice FIT's executor's bare creation code, what `createBox` takes (the factory appends the arguments).
    function _executorCode() internal pure returns (bytes memory) {
        return type(FitBuybackExecutor).creationCode;
    }

    // ================================================================================================ state diffs

    /// @notice The storage writes of a recorded call that stuck (not reverted) and changed a slot of one of box 0's
    /// storage accounts: their count, and the first one's account and slot.
    function _box0Writes(VmSafe.AccountAccess[] memory acc)
        internal
        view
        returns (uint256 n, address firstAccount, bytes32 firstSlot)
    {
        for (uint256 i; i < acc.length; ++i) {
            VmSafe.StorageAccess[] memory s = acc[i].storageAccesses;
            for (uint256 j; j < s.length; ++j) {
                if (!s[j].isWrite || s[j].reverted || s[j].previousValue == s[j].newValue) continue;
                if (!isBox0Storage[s[j].account]) continue;
                if (n == 0) (firstAccount, firstSlot) = (s[j].account, s[j].slot);
                ++n;
            }
        }
    }

    /// @notice One recorded low-level call from `caller` with `value` and `data`, 3,000,000 gas.
    function _recordedCall(address caller, address target, uint256 value, bytes memory data)
        internal
        returns (bool ok, VmSafe.AccountAccess[] memory acc)
    {
        if (value != 0) vm.deal(caller, caller.balance + value);
        vm.startStateDiffRecording();
        vm.prank(caller);
        (ok,) = target.call{value: value, gas: 3_000_000}(data);
        acc = vm.stopAndReturnStateDiff();
    }

    // ================================================================================================ code helpers

    /// @notice The runtime a `BoxClones.initCode` returns: everything after the 10-byte constructor.
    function _runtimeOf(bytes memory initCode) internal pure returns (bytes memory r) {
        r = new bytes(initCode.length - 10);
        for (uint256 i; i < r.length; ++i) {
            r[i] = initCode[10 + i];
        }
    }

    /// @notice The arguments of a clone's init code (after the constructor and the proxy).
    function _argsOf(bytes memory initCode, bool receiving) internal pure returns (bytes memory r) {
        uint256 from = 10 + (receiving ? BoxClones.RECEIVING_ARGS_OFFSET : BoxClones.ARGS_OFFSET);
        r = new bytes(initCode.length - from);
        for (uint256 i; i < r.length; ++i) {
            r[i] = initCode[from + i];
        }
    }

    function _label(uint256 i) internal view returns (string memory) {
        return targets[i].label;
    }
}

/// @title AuditU1FablePreWorld
/// @notice TEST ONLY (SH-AUDIT-B0 U1, Fable). The audit world one step before `createBox`: the version deployed by
/// `CoreBox0Kit` exactly as `AuditBox0World` does it (chain id 1, the mainnet build, the pinned sources, the world's
/// spec with N 1,969 and the open an hour ahead), the spec prepared (addresses predicted, the hook salt mined), box 0
/// not yet created. `_createNow()` creates it and fills the world's handles. Needs no EIP-2537 (nothing posts a
/// signature here), so it also runs under Cancun; it makes the eight plain EOAs only (no EIP-7702 delegation, which a
/// pre-Prague EVM has not got).
abstract contract AuditU1FablePreWorld is AuditBox0World {
    bytes internal preSpecEncoded;
    BoxRegistry internal registry;
    BoxFactoryV1Planner internal planner;
    CoreImpls internal impls;
    IBoxFactoryV1.Box0Addresses internal predicted;

    function setUp() public virtual override {
        _loadBoxDrand();
        r0 = _localFirst();
        vm.pauseGasMetering();
        kit = new CoreBox0Kit();
        vm.resumeGasMetering();
        kit.setUpWorld();
        pm = kit.pm();
        src = kit.source();
        drand = kit.drand();
        factory = kit.factory();
        registry = BoxRegistry(factory.registry());
        planner = factory.planner();
        impls = kit.impls();
        vm.warp(src.roundTime(r0) - 1 days);
        vm.fee(AUDIT_BASE_FEE);
        for (uint256 i; i < 8; ++i) {
            (eoa[i], eoaKey[i]) = makeAddrAndKey(string.concat("audit.eoa.", vm.toString(i)));
        }
        keeper = eoa[6];
        poster = eoa[7];
        BoxSpecV1.BoxSpec memory s = _auditSpec();
        editionSize = s.n;
        raise = s.raise;
        preSpecEncoded = abi.encode(s);
        kit.prepare(s);
        createdAt = vm.getBlockTimestamp();
        createdAtBlock = vm.getBlockNumber();
        a = kit.addresses();
        predicted = factory.box0Addresses();
        poolKey = kit.poolKey();
        curve = kit.curve();
        safe = a.platform;
    }

    function _preSpec() internal view returns (BoxSpecV1.BoxSpec memory) {
        return abi.decode(preSpecEncoded, (BoxSpecV1.BoxSpec));
    }

    /// @notice FIT's executor's bare creation code, what `createBox` takes (the factory appends the arguments).
    function _executorCode() internal pure returns (bytes memory) {
        return type(FitBuybackExecutor).creationCode;
    }

    /// @notice Creates box 0 now (the kit is the box-0 creator) and fills the handles.
    function _createNow() internal {
        kit.create();
        _bindHandles();
    }

    function _bindHandles() internal {
        a = kit.addresses();
        coordinator = BoxCoordinator(a.coordinator);
        hook = BoxHook(a.hook);
        launchRouter = BoxLaunchRouter(payable(a.launchRouter));
        receiver = BoxReceiver(payable(a.receiver));
        executor = FitBuybackExecutor(payable(a.executor));
        tickets = BoxTickets(a.tickets);
        vault = BoxVault(a.vault);
        collection = BoxCollection(a.collection);
        stream = BoxItemStream(a.itemStream);
        royaltyRouter = BoxRoyaltyRouter(payable(a.royaltyRouter));
        token = BoxToken(a.token);
    }

    /// @notice Every address the factory fixed for box 0 (the hook as predicted for the world's salt), in one list.
    function _predictedList() internal view returns (address[12] memory list) {
        list = [
            predicted.coordinator,
            predicted.table,
            predicted.token,
            predicted.vault,
            predicted.collection,
            predicted.receiver,
            predicted.launchRouter,
            predicted.executor,
            predicted.tickets,
            predicted.itemStream,
            predicted.royaltyRouter,
            a.hook
        ];
    }

    /// @notice Nothing of box 0 exists: no code at any fixed address, no record, the factory's nonce at 2, no pool.
    function _assertNothingCreated() internal view {
        address[12] memory list = _predictedList();
        for (uint256 i; i < list.length; ++i) {
            assertEq(list[i].code.length, 0, "u1: nothing created");
        }
        assertEq(registry.boxCount(), 0, "u1: no record");
        assertEq(vm.getNonce(address(factory)), 2, "u1: the factory created only its registry");
    }
}
