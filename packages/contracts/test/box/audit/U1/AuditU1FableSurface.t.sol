// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxFactoryV1Planner} from "../../../../src/box/BoxFactoryV1Planner.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {IBoxCollection} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxFactoryV1} from "../../../../src/box/interfaces/IBoxFactoryV1.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxItemStream} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxLaunchRouter} from "../../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {AuditU1FableTables as T} from "./AuditU1FableTables.sol";
import {AuditU1FableWorld, AuditU1Target} from "./AuditU1FableBase.sol";

/// @notice TEST ONLY: asks `isCloneOf` about itself while still in its constructor (no code yet: never a clone).
contract AuditU1FableConstructorProbe {
    bool public cloneOfSelfInConstructor;

    constructor(address implementation) {
        cloneOfSelfInConstructor = BoxClones.isCloneOf(address(this), implementation);
    }
}

/// @notice SH-AUDIT-B0 U1 (Fable), L2: the whole state-changing surface of box 0 (P1.4 BC-010, P1.6) and the clone
/// gate (P1.5): every box 0 contract, every implementation and extension, the factory, planner and registry dispatch
/// exactly the selectors of their build artifacts (the tables), none of which is an owner, admin, pause, upgrade,
/// setter, mint or rescue function (ADR-0016 § 5; F23 C2); every state-changing entry driven from every caller class
/// with empty, zero and 0xff calldata, with and without value, changes storage only when its documented caller
/// calls it or it is a permissionless entry; a stranger's clone of any implementation, and every implementation,
/// cannot be initialised by any reachable caller (ADR-0016 § 4; BC-100).
/// forge-config: default.evm_version = "osaka"
contract AuditU1FableSurfaceTest is AuditU1FableWorld {
    /// @dev The artifact of each target, in the order of `_buildTargets`.
    string[25] internal artifacts = [
        "BoxCoordinator",
        "BoxHook",
        "BoxLaunchRouter",
        "BoxReceiver",
        "BoxCollection",
        "BoxVault",
        "BoxTickets",
        "BoxRoyaltyRouter",
        "BoxItemStream",
        "BoxToken",
        "FitBuybackExecutor",
        "BoxFactoryV1",
        "BoxRegistry",
        "BoxFactoryV1Planner",
        "BoxCoordinator",
        "BoxHook",
        "BoxHookExtension",
        "BoxLaunchRouter",
        "BoxReceiver",
        "BoxReceiverExtension",
        "BoxCollection",
        "BoxVault",
        "BoxTickets",
        "BoxRoyaltyRouter",
        "BoxItemStream"
    ];

    /// @dev EIP-1967 slots (implementation, admin, beacon).
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 internal constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
    bytes32 internal constant BEACON_SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;

    uint256 internal callsMade;
    uint256 internal writesAllowed;
    uint256 internal successes;

    function setUp() public override {
        super.setUp();
        _makeStrangerClones();
    }

    // ============================================================================================================
    // P1.6 · the surface is exactly the artifacts', and none of it is an admin entry

    /// P1.6: each target's table equals the selector set of its build artifact (`methodIdentifiers`), and every
    /// selector of a live contract's table is pushed by the code that serves it (the implementation's, for a clone):
    /// an ABI change fails here until the table is regenerated and the new entry classified.
    function testProperty_AUDIT_U1_selectorTablesAreTheArtifacts() public view {
        for (uint256 t; t < targets.length; ++t) {
            string memory json =
                vm.readFile(string.concat(vm.projectRoot(), "/out/", artifacts[t], ".sol/", artifacts[t], ".json"));
            string[] memory keys = vm.parseJsonKeys(json, ".methodIdentifiers");
            uint256 n = T.count(targets[t].table);
            assertEq(keys.length, n, string.concat(targets[t].label, ": function count"));
            bytes memory code = _servingCode(t);
            for (uint256 i; i < keys.length; ++i) {
                bytes4 sel = bytes4(keccak256(bytes(keys[i])));
                bool found;
                for (uint256 j; j < n; ++j) {
                    (bytes4 s,) = T.entry(targets[t].table, j);
                    if (s == sel) {
                        found = true;
                        assertEq(
                            keccak256(bytes(T.signature(targets[t].sigs, j))),
                            keccak256(bytes(keys[i])),
                            "the table's signature is the artifact's"
                        );
                        break;
                    }
                }
                assertTrue(found, string.concat(targets[t].label, ": not in the table: ", keys[i]));
                assertTrue(_pushes(code, sel), string.concat(targets[t].label, ": not dispatched: ", keys[i]));
            }
        }
    }

    /// @dev The runtime that serves a target's calls: the implementation's for a clone, its own otherwise.
    function _servingCode(uint256 t) internal view returns (bytes memory) {
        address at = targets[t].at;
        if (at == a.coordinator) return impls.coordinator.code;
        if (at == a.hook) return impls.hook.code;
        if (at == a.launchRouter) return impls.launchRouter.code;
        if (at == a.receiver) return impls.receiver.code;
        if (at == a.collection) return impls.collection.code;
        if (at == a.vault) return impls.vault.code;
        if (at == a.tickets) return impls.tickets.code;
        if (at == a.royaltyRouter) return impls.royaltyRouter.code;
        if (at == a.itemStream) return impls.itemStream.code;
        return at.code;
    }

    /// @dev Whether `code` pushes `sel` (solc's dispatcher compares every selector it serves against a PUSHed
    /// immediate; the optimizer strips leading zero bytes, so a selector starting 0x00 is a PUSH3 or shorter; the
    /// extension-forwarded entries of the hook and receiver are compared in the hot half too).
    function _pushes(bytes memory code, bytes4 sel) internal pure returns (bool) {
        uint256 width = 4;
        uint32 v = uint32(sel);
        while (width > 1 && (v >> (8 * (width - 1))) == 0) {
            --width;
        }
        bytes1 op = bytes1(uint8(0x5f + width)); // PUSH1 is 0x60
        for (uint256 i; i + width < code.length; ++i) {
            if (code[i] != op) continue;
            uint32 got;
            for (uint256 j; j < width; ++j) {
                got = (got << 8) | uint8(code[i + 1 + j]);
            }
            if (got == v) return true;
        }
        return false;
    }

    /// P1.6 (ADR-0016 § 5, F23 C2): no owner, admin, pause, unpause, upgrade, setter, mint, blacklist or rescue
    /// signature anywhere on the surface (46 signatures, against the tables, which equal the ABIs); no EIP-1967
    /// implementation, admin or beacon slot holds a value in any contract of the version or the box; no system address
    /// carries an EIP-7702 delegation; every clone's code is exactly its proxy plus its arguments.
    function testProperty_AUDIT_U1_noAdminSurfaceNoProxySlotsNoDelegation() public view {
        string[46] memory denied = [
            "transferOwnership(address)",
            "renounceOwnership()",
            "setOwner(address)",
            "pause()",
            "unpause()",
            "setPaused(bool)",
            "upgradeTo(address)",
            "upgradeToAndCall(address,bytes)",
            "changeAdmin(address)",
            "admin()",
            "implementation()",
            "setImplementation(address)",
            "setFee(uint256)",
            "setFees(uint256,uint256)",
            "setRoyalty(uint256)",
            "setRoyaltyInfo(address,uint96)",
            "setDefaultRoyalty(address,uint96)",
            "setBaseURI(string)",
            "setTokenURI(uint256,string)",
            "setContractURI(string)",
            "rescueETH(address)",
            "rescueTokens(address,address,uint256)",
            "rescueERC20(address,uint256)",
            "recoverERC20(address,uint256)",
            "withdrawETH(address)",
            "emergencyWithdraw()",
            "withdrawAll()",
            "mint(address,uint256)",
            "mint(uint256)",
            "mintTo(address,uint256)",
            "burnFrom(address,uint256)",
            "blacklist(address)",
            "setBlacklist(address,bool)",
            "setMaxTx(uint256)",
            "setTreasury(address)",
            "setSource(address)",
            "setRandomness(address)",
            "setHook(address)",
            "setCoordinator(address)",
            "setExecutor(address)",
            "grantRole(bytes32,address)",
            "revokeRole(bytes32,address)",
            "destroy()",
            "kill()",
            "initialize(address)",
            "reinitialize()"
        ];
        for (uint256 t; t < targets.length; ++t) {
            bytes memory table = targets[t].table;
            uint256 n = T.count(table);
            for (uint256 d; d < denied.length; ++d) {
                bytes4 sel = bytes4(keccak256(bytes(denied[d])));
                for (uint256 j; j < n; ++j) {
                    (bytes4 s,) = T.entry(table, j);
                    assertTrue(s != sel, string.concat(targets[t].label, " dispatches ", denied[d]));
                }
            }
        }
        for (uint256 i; i < box0Storage.length; ++i) {
            address x = box0Storage[i];
            assertEq(vm.load(x, IMPL_SLOT), bytes32(0), "EIP-1967 implementation slot");
            assertEq(vm.load(x, ADMIN_SLOT), bytes32(0), "EIP-1967 admin slot");
            assertEq(vm.load(x, BEACON_SLOT), bytes32(0), "EIP-1967 beacon slot");
            if (x.code.length >= 3) assertTrue(bytes3(x.code) != bytes3(hex"ef0100"), "no EIP-7702 delegation");
        }
        BoxFactoryV1Planner.Plan memory p = _worldPlan();
        assertEq(a.coordinator.code, _runtimeOf(p.coordinatorInit), "coordinator: proxy + 154 bytes");
        assertEq(a.hook.code, _runtimeOf(p.hookInit), "hook: proxy + 203 bytes");
        assertEq(a.vault.code, _runtimeOf(p.codes[2]), "vault");
        assertEq(a.collection.code, _runtimeOf(p.codes[3]), "collection");
        assertEq(a.receiver.code, _runtimeOf(p.codes[4]), "receiver");
        assertEq(a.launchRouter.code, _runtimeOf(p.codes[5]), "launch router");
        assertEq(a.tickets.code, _runtimeOf(p.codes[7]), "tickets");
        assertEq(a.itemStream.code, _runtimeOf(p.codes[8]), "per-item stream");
        assertEq(a.royaltyRouter.code, _runtimeOf(p.codes[9]), "royalty router (receiving)");
        assertEq(a.coordinator.code.length, 45 + BoxCoordinator(impls.coordinator).ARGS_LENGTH());
        assertEq(a.royaltyRouter.code.length, 51 + 61);
    }

    // ============================================================================================================
    // P1.4 · BC-010: every state-changing entry from every caller class

    /// @dev The caller classes a target is driven from: a fresh EOA, an actor EOA, a contract, the EIP-7702 EOA, the
    /// implementation of the target's kind (or the live clone, for an implementation), the stranger's clone of that
    /// kind, and every documented caller address of box 0.
    function _callers(uint256 t) internal view returns (address[16] memory c) {
        c[0] = _fresh(string.concat("audit.u1.caller.", vm.toString(t)));
        c[1] = eoa[0];
        c[2] = address(contractDrawer);
        c[3] = eoa7702;
        (c[4], c[5]) = _kindPeers(t);
        c[6] = address(pm);
        c[7] = a.coordinator;
        c[8] = address(factory);
        c[9] = a.receiver;
        c[10] = a.vault;
        c[11] = a.collection;
        c[12] = a.tickets;
        c[13] = a.executor;
        c[14] = a.hook;
        c[15] = address(kit);
    }

    /// @dev For a live clone: its implementation and the stranger's clone of that implementation; for an
    /// implementation: the live clone and the stranger's clone; otherwise two fresh addresses.
    function _kindPeers(uint256 t) internal view returns (address impl, address strangerClone) {
        string memory label = targets[t].label;
        address[11] memory list = _implList();
        address[11] memory live = [
            a.coordinator,
            a.hook,
            address(0),
            a.launchRouter,
            a.receiver,
            address(0),
            a.collection,
            a.vault,
            a.tickets,
            a.royaltyRouter,
            a.itemStream
        ];
        for (uint256 i; i < 11; ++i) {
            if (targets[t].at == list[i]) {
                return (live[i] == address(0) ? _fresh("audit.u1.none") : live[i], strangerClones[i]);
            }
            if (targets[t].at == live[i]) return (list[i], strangerClones[i]);
        }
        return (_fresh(string.concat("audit.u1.peerA.", label)), _fresh(string.concat("audit.u1.peerB.", label)));
    }

    /// P1.4 (BC-010, exhaustive): for every target, every state-changing entry of its table, every caller class,
    /// three calldata tails (empty, 256 zero bytes, 256 0xff bytes) and two values (0 and 1 wei): a call that
    /// changes a storage slot of any system account is one whose documented caller made it, or a permissionless
    /// entry (the table's class ANYONE); nothing an undocumented caller does writes anything, on the live contracts,
    /// the implementations, the extensions, the factory, the planner or the registry.
    function testProperty_AUDIT_U1_everyEntryFromEveryCallerWritesOnlyAsDocumented() public {
        bytes memory zeros = new bytes(256);
        bytes memory ones = new bytes(256);
        for (uint256 i; i < 256; ++i) {
            ones[i] = 0xff;
        }
        for (uint256 t; t < targets.length; ++t) {
            // Each target starts from the created state; the counters (this contract's storage) survive the revert.
            uint256 snap = vm.snapshotState();
            (uint256 c0, uint256 s0, uint256 w0) = (callsMade, successes, writesAllowed);
            _sweepTarget(t, zeros, ones);
            (uint256 c1, uint256 s1, uint256 w1) = (callsMade, successes, writesAllowed);
            vm.revertToState(snap);
            (callsMade, successes, writesAllowed) = (c1 + c0 - c0, s1 + s0 - s0, w1 + w0 - w0);
        }
        emit log_named_uint("U1|BC010|calls", callsMade);
        emit log_named_uint("U1|BC010|calls that succeeded", successes);
        emit log_named_uint("U1|BC010|calls that wrote (documented or permissionless)", writesAllowed);
        assertGt(callsMade, 10_000, "the sweep ran");
    }

    function _sweepTarget(uint256 t, bytes memory zeros, bytes memory ones) internal {
        address[16] memory callers = _callers(t);
        uint256 n = T.count(targets[t].table);
        for (uint256 e; e < n; ++e) {
            (bytes4 sel, uint8 class) = _classAt(targets[t], e);
            if (class == T.VIEW) continue;
            for (uint256 c; c < callers.length; ++c) {
                _drive(t, e, sel, class, callers[c], "");
                _drive(t, e, sel, class, callers[c], zeros);
                _drive(t, e, sel, class, callers[c], ones);
            }
        }
    }

    /// @dev One entry from one caller with `tail`, with 0 and with 1 wei; memory is reset after each round.
    function _drive(uint256 t, uint256 e, bytes4 sel, uint8 class, address caller, bytes memory tail) internal {
        uint256 fmp;
        assembly ("memory-safe") {
            fmp := mload(0x40)
        }
        _check(t, e, caller, 0, bytes.concat(sel, tail), class);
        _check(t, e, caller, 1, bytes.concat(sel, tail), class);
        assembly ("memory-safe") {
            mstore(0x40, fmp)
        }
    }

    function _check(uint256 t, uint256 e, address caller, uint256 value, bytes memory data, uint8 class) internal {
        (bool ok, VmSafe.AccountAccess[] memory acc) = _recordedCall(caller, targets[t].at, value, data);
        ++callsMade;
        if (ok) ++successes;
        (uint256 n, address firstAccount, bytes32 firstSlot) = _box0Writes(acc);
        if (n == 0) return;
        if (_documented(class, caller)) {
            ++writesAllowed;
            return;
        }
        revert(_violation(targets[t].label, T.signature(targets[t].sigs, e), caller, firstAccount, firstSlot));
    }

    /// @dev "BC-010: <label>.<entry> from <caller> wrote <account> slot <slot>".
    function _violation(string memory label, string memory entry, address caller, address account, bytes32 slot)
        internal
        pure
        returns (string memory)
    {
        string memory head = string.concat("BC-010: ", label, ".", entry);
        string memory tail = string.concat(" wrote ", vm.toString(account), " slot ", vm.toString(slot));
        return string.concat(head, " from ", vm.toString(caller), tail);
    }

    /// P1.4 (BC-010, fuzzed): a random target, a random entry (one call in ten with a random selector), a random
    /// caller class (random EOA included), random calldata and a random value: the same rule.
    function testFuzz_AUDIT_U1_randomEntryRandomCallerWritesOnlyAsDocumented(
        uint256 targetSeed,
        uint256 entrySeed,
        uint256 callerSeed,
        bytes calldata tail,
        uint8 valueSeed
    ) public {
        uint256 t = targetSeed % targets.length;
        bytes4 sel;
        uint8 class;
        if (entrySeed % 10 == 0) {
            sel = bytes4(bytes32(entrySeed));
            class = _classOfSelector(t, sel);
        } else {
            (sel, class) = _classAt(targets[t], (entrySeed / 10) % T.count(targets[t].table));
        }
        address[16] memory callers = _callers(t);
        address caller = callerSeed % 17 == 16 ? address(uint160(callerSeed)) : callers[callerSeed % 16];
        if (caller == address(0) || caller == address(vm) || caller == address(this)) caller = eoa[1];
        uint256 value = valueSeed % 3 == 0 ? 0 : valueSeed % 3 == 1 ? 1 : 0.01 ether;
        bytes memory data = bytes.concat(sel, tail.length > 320 ? tail[:320] : tail);
        _checkOne(t, sel, class, caller, value, data);
    }

    function _checkOne(uint256 t, bytes4 sel, uint8 class, address caller, uint256 value, bytes memory data) internal {
        (, VmSafe.AccountAccess[] memory acc) = _recordedCall(caller, targets[t].at, value, data);
        (uint256 n, address firstAccount, bytes32 firstSlot) = _box0Writes(acc);
        if (n == 0 || _documented(class, caller)) return;
        revert(_violation(targets[t].label, vm.toString(sel), caller, firstAccount, firstSlot));
    }

    /// @dev The class of a selector on target `t`: its table's, or VIEW for a selector the contract does not serve
    /// (a call it must refuse or ignore without writing).
    function _classOfSelector(uint256 t, bytes4 sel) internal view returns (uint8) {
        uint256 n = T.count(targets[t].table);
        for (uint256 j; j < n; ++j) {
            (bytes4 s, uint8 class) = _classAt(targets[t], j);
            if (s == sel) return class;
        }
        return T.VIEW;
    }

    // ============================================================================================================
    // P1.5 · the clone gate: strangers' clones and the implementations cannot be initialised

    /// P1.5 (ADR-0016 § 4; BC-100): a stranger's standard clone of each initialisable implementation, carrying box
    /// 0's own arguments (so it names box 0's real coordinator), refuses `initialize` from the stranger, the factory,
    /// the creator, the PoolManager, the implementation, a clone of the coordinator implementation the stranger made,
    /// and the EIP-7702 EOA, each with `NotCoordinator(caller)`; the one address that could pass its check, box 0's
    /// coordinator, has no entry point left that initialises anything (`launch` refuses `AlreadyLaunched`).
    function testProperty_AUDIT_U1_strangersClonesCannotInitialise() public {
        address[7] memory callers =
            [stranger, address(factory), address(kit), address(pm), impls.coordinator, strangerClones[0], eoa7702];
        uint256[7] memory idx = [uint256(1), 3, 4, 6, 7, 8, 10];
        for (uint256 k; k < idx.length; ++k) {
            address clone = strangerClones[idx[k]];
            for (uint256 c; c < callers.length; ++c) {
                vm.prank(callers[c]);
                (bool ok, bytes memory ret) = clone.call(abi.encodeWithSignature("initialize()"));
                assertFalse(ok, "a stranger's clone initialised");
                assertEq(bytes4(ret), IBoxHook.NotCoordinator.selector, "NotCoordinator(caller)");
                assertEq(ret.length, 36, "the error names the caller");
                assertEq(address(uint160(uint256(bytes32(_slice(ret, 4, 36))))), callers[c]);
            }
        }
        // The stranger's coordinator clone: deploy and launch only from the factory, whose only entry is spent.
        BoxCoordinator sc = BoxCoordinator(strangerClones[0]);
        assertTrue(BoxClones.isCloneOf(address(sc), impls.coordinator), "a clone of the real coordinator code");
        bytes[] memory none = new bytes[](0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinator.NotFactory.selector, stranger));
        sc.deploy(none, "", bytes32(0), 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinator.NotFactory.selector, stranger));
        sc.launch{value: 0}();
        vm.prank(address(kit));
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinator.NotFactory.selector, address(kit)));
        sc.deploy(none, "", bytes32(0), 1);
        BoxSpecV1.BoxSpec memory s = _worldSpec();
        bytes32 salt = kit.hookSalt();
        vm.deal(address(kit), BoxSpecV1.BOOTSTRAP_ETH);
        vm.prank(address(kit));
        vm.expectRevert(IBoxFactoryV1.Box0Exists.selector);
        factory.createBox{value: BoxSpecV1.BOOTSTRAP_ETH}(s, salt, _executorCode());
        // Box 0's coordinator itself: launched, so it never calls initialize again.
        vm.prank(address(factory));
        vm.expectRevert(IBoxCoordinator.AlreadyLaunched.selector);
        coordinator.launch{value: 0}();
    }

    /// P1.5: no implementation can be initialised directly, by any caller, box 0's coordinator and the factory
    /// included: the coordinator implementation is marked deployed and launched, the hook's, router's and receiver's
    /// initialised, and the collection's, vault's, tickets' and stream's `coordinator` argument reads their own code
    /// bytes, an address no caller has.
    function testProperty_AUDIT_U1_implementationsCannotBeInitialised() public {
        address[6] memory callers = [stranger, a.coordinator, address(factory), address(kit), address(pm), eoa7702];
        bytes[] memory none = new bytes[](0);
        for (uint256 c; c < callers.length; ++c) {
            address who = callers[c];
            vm.prank(who);
            (bool ok, bytes memory ret) =
                impls.coordinator.call(abi.encodeCall(BoxCoordinator.deploy, (none, "", bytes32(0), 0)));
            assertFalse(ok);
            assertEq(
                bytes4(ret),
                who == address(factory) ? BoxCoordinator.AlreadyDeployed.selector : IBoxCoordinator.NotFactory.selector
            );
            vm.prank(who);
            (ok, ret) = impls.coordinator.call(abi.encodeCall(BoxCoordinator.launch, ()));
            assertFalse(ok);
            assertEq(
                bytes4(ret),
                who == address(factory) ? IBoxCoordinator.AlreadyLaunched.selector : IBoxCoordinator.NotFactory.selector
            );
            address[8] memory inits = [
                impls.hook,
                impls.launchRouter,
                impls.receiver,
                impls.collection,
                impls.vault,
                impls.tickets,
                impls.itemStream,
                impls.hookExtension
            ];
            for (uint256 i; i < inits.length; ++i) {
                vm.prank(who);
                (ok, ret) = inits[i].call(abi.encodeWithSignature("initialize()"));
                assertFalse(ok, "an implementation initialised");
                if (i < 7) {
                    assertEq(bytes4(ret), IBoxHook.NotCoordinator.selector, "NotCoordinator on the implementation");
                }
            }
        }
    }

    /// P1.5 (both proxy shapes): `isCloneOf` accepts exactly a standard clone of the named implementation and
    /// `isReceivingCloneOf` exactly a receiving one; each refuses the other shape, a clone of another
    /// implementation, an EOA, an EIP-7702 delegation, a contract still in its constructor and the implementation
    /// itself; box 0's clones answer as created (the royalty router is a receiving clone and not a standard one).
    function testProperty_AUDIT_U1_cloneShapesAreToldApart() public {
        address[11] memory list = _implList();
        for (uint256 i; i < 11; ++i) {
            address std = BoxClones.create(BoxClones.initCode(list[i], hex"c0ffee"));
            address rcv = BoxClones.create(BoxClones.initCodeReceiving(list[i], hex"c0ffee"));
            assertTrue(BoxClones.isCloneOf(std, list[i]), "standard clone of itself");
            assertFalse(BoxClones.isReceivingCloneOf(std, list[i]), "standard is not receiving");
            assertTrue(BoxClones.isReceivingCloneOf(rcv, list[i]), "receiving clone of itself");
            assertFalse(BoxClones.isCloneOf(rcv, list[i]), "receiving is not standard");
            assertFalse(BoxClones.isCloneOf(list[i], list[i]), "the implementation is not its own clone");
            assertFalse(BoxClones.isReceivingCloneOf(list[i], list[i]));
            address other = list[(i + 1) % 11];
            assertFalse(BoxClones.isCloneOf(std, other), "a clone of another implementation");
            assertFalse(BoxClones.isReceivingCloneOf(rcv, other));
            assertFalse(BoxClones.isCloneOf(eoa[0], list[i]), "an EOA");
            assertFalse(BoxClones.isCloneOf(eoa7702, list[i]), "a 7702 delegation");
            assertFalse(BoxClones.isReceivingCloneOf(eoa7702, list[i]));
            assertFalse(new AuditU1FableConstructorProbe(list[i]).cloneOfSelfInConstructor(), "in its constructor");
        }
        assertTrue(BoxClones.isCloneOf(a.coordinator, impls.coordinator));
        assertTrue(BoxClones.isCloneOf(a.hook, impls.hook));
        assertTrue(BoxClones.isCloneOf(a.launchRouter, impls.launchRouter));
        assertTrue(BoxClones.isCloneOf(a.receiver, impls.receiver));
        assertTrue(BoxClones.isCloneOf(a.collection, impls.collection));
        assertTrue(BoxClones.isCloneOf(a.vault, impls.vault));
        assertTrue(BoxClones.isCloneOf(a.tickets, impls.tickets));
        assertTrue(BoxClones.isCloneOf(a.itemStream, impls.itemStream));
        assertTrue(BoxClones.isReceivingCloneOf(a.royaltyRouter, impls.royaltyRouter));
        assertFalse(BoxClones.isCloneOf(a.royaltyRouter, impls.royaltyRouter), "the router is the receiving shape");
        assertFalse(BoxClones.isCloneOf(a.hook, impls.coordinator), "the hook is not a coordinator clone");
        assertFalse(BoxClones.isCloneOf(a.token, impls.coordinator), "T is a full contract");
        assertFalse(BoxClones.isCloneOf(a.executor, impls.coordinator));
    }

    /// P1.5 (fuzzed): one byte of a standard clone's 45-byte proxy changed (any position, any other value) is no
    /// longer a clone of the implementation; any change after byte 45 (the arguments) leaves it one.
    function testFuzz_AUDIT_U1_isCloneOfAcceptsOnlyTheExactProxy(uint8 pos, uint8 value, uint8 implSeed) public {
        address impl = _implList()[implSeed % 11];
        bytes memory runtime = BoxClones.runtime(impl, hex"0102030405060708090a0b0c0d0e0f10");
        uint256 at = uint256(pos) % runtime.length;
        vm.assume(runtime[at] != bytes1(value));
        runtime[at] = bytes1(value);
        address probe = makeAddr(string.concat("audit.u1.shape.", vm.toString(pos), ".", vm.toString(value)));
        vm.etch(probe, runtime);
        assertEq(BoxClones.isCloneOf(probe, impl), at >= BoxClones.ARGS_OFFSET, "exactly the 45 proxy bytes");
        bytes memory receiving = BoxClones.receivingRuntime(impl, hex"0102030405060708090a0b0c0d0e0f10");
        at = uint256(pos) % receiving.length;
        vm.assume(receiving[at] != bytes1(value));
        receiving[at] = bytes1(value);
        vm.etch(probe, receiving);
        assertEq(
            BoxClones.isReceivingCloneOf(probe, impl), at >= BoxClones.RECEIVING_ARGS_OFFSET, "exactly the 51 bytes"
        );
    }

    /// @dev A fresh address from a name, without labelling (usable from a view).
    function _fresh(string memory name) internal pure returns (address) {
        return address(uint160(uint256(keccak256(bytes(name)))));
    }

    function _slice(bytes memory b, uint256 from, uint256 to) internal pure returns (bytes memory out) {
        out = new bytes(to - from);
        for (uint256 i; i < out.length; ++i) {
            out[i] = b[from + i];
        }
    }
}
