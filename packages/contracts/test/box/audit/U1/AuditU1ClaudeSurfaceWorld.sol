// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {CoreImpls} from "../../conformance/core/CoreBox0Kit.sol";
import {AuditPhases} from "../common/AuditPhases.sol";
import {AuditU1ClaudeCloner, AuditU1ClaudeProbe} from "./AuditU1ClaudeSurfaceKit.sol";
import {AuditU1ClaudeSurfaceTable as T} from "./AuditU1ClaudeSurfaceTable.sol";

/// @notice TEST ONLY: a stand-in that writes for any caller (the probe's positive control: a vault whose `openGate`
/// forgot its caller check).
contract AuditU1ClaudeLeakyVault {
    uint256 public opened;

    function openGate() external {
        opened = block.timestamp;
    }
}

/// @notice TEST ONLY: `BoxClones`' two shape checks, as external calls.
contract AuditU1ClaudeShapes {
    function isCloneOf(address account, address implementation) external view returns (bool) {
        return BoxClones.isCloneOf(account, implementation);
    }

    function isReceivingCloneOf(address account, address implementation) external view returns (bool) {
        return BoxClones.isReceivingCloneOf(account, implementation);
    }
}

/// @title AuditU1ClaudeSurfaceBase
/// @notice TEST ONLY. The audit world's box 0 (`AuditPhases`, osaka) plus the BC-010 probe: 37 targets (box 0's twelve
/// contracts, the factory, planner and registry, the eleven implementations and extensions, both sources, and nine
/// strangers' clones: a stranger's CREATE of each of box 0's clone runtimes, so each runs the version's implementation
/// with box 0's own arguments at an address that is not box 0's) and 46 listed callers (every one of those but the
/// sources, plus the PoolManager, the kit (box 0's creator), the Safe, this test, the stranger and six EOAs) beside
/// fresh random ones; never address(0), which no Ethereum call can come from (swept on its own, see
/// `testProperty_AUDIT_U1_zeroSenderSweep`). Each target's documented callers are the addresses its own wiring names
/// for each class.
abstract contract AuditU1ClaudeSurfaceBase is AuditPhases {
    AuditU1ClaudeProbe internal probe;
    AuditU1ClaudeCloner internal cloner;
    address internal stranger;
    /// @dev The strangers' clones, in the order coordinator, hook, router, receiver, collection, vault, tickets,
    /// stream, royalty router.
    address[9] internal strangerClones;

    function _buildProbe() internal {
        probe = new AuditU1ClaudeProbe();
        cloner = new AuditU1ClaudeCloner();
        stranger = makeAddr("u1.surface.stranger");
        CoreImpls memory im = kit.impls();
        address[9] memory box0 = [
            a.coordinator,
            a.hook,
            a.launchRouter,
            a.receiver,
            a.collection,
            a.vault,
            a.tickets,
            a.itemStream,
            a.royaltyRouter
        ];
        uint8[9] memory kinds = [
            T.K_COORDINATOR,
            T.K_HOOK,
            T.K_ROUTER,
            T.K_RECEIVER,
            T.K_COLLECTION,
            T.K_VAULT,
            T.K_TICKETS,
            T.K_STREAM,
            T.K_ROYALTY
        ];
        for (uint256 i; i < 9; ++i) {
            vm.prank(stranger);
            strangerClones[i] = cloner.deploy(box0[i].code);
            assertEq(strangerClones[i].code, box0[i].code, "the stranger's clone runs box 0's runtime");
        }
        // Targets.
        for (uint256 i; i < 9; ++i) {
            probe.addTarget(box0[i], kinds[i]);
            _allowBox0Roles(box0[i], kinds[i]);
            probe.addTarget(strangerClones[i], kinds[i]);
            _allowBox0Roles(strangerClones[i], kinds[i]);
        }
        probe.addTarget(a.token, T.K_TOKEN);
        probe.addTarget(a.executor, T.K_EXECUTOR);
        probe.allow(a.executor, T.POOL_MANAGER, address(pm));
        probe.addTarget(a.table, T.K_TABLE);
        probe.addTarget(address(factory), T.K_FACTORY);
        probe.allow(address(factory), T.CREATOR, address(kit));
        probe.addTarget(im.planner, T.K_PLANNER);
        probe.addTarget(im.registry, T.K_REGISTRY);
        probe.allow(im.registry, T.FACTORY, address(factory));
        probe.addTarget(address(drand), T.K_DRAND);
        probe.addTarget(address(src), T.K_BACKED);
        address[11] memory imps = [
            im.coordinator,
            im.hook,
            im.hookExtension,
            im.launchRouter,
            im.receiver,
            im.receiverExtension,
            im.collection,
            im.vault,
            im.tickets,
            im.itemStream,
            im.royaltyRouter
        ];
        uint8[11] memory impKinds = [
            T.K_COORDINATOR,
            T.K_HOOK,
            T.K_HOOK_EXT,
            T.K_ROUTER,
            T.K_RECEIVER,
            T.K_RECEIVER_EXT,
            T.K_COLLECTION,
            T.K_VAULT,
            T.K_TICKETS,
            T.K_STREAM,
            T.K_ROYALTY
        ];
        for (uint256 i; i < 11; ++i) {
            probe.addTarget(imps[i], impKinds[i]);
            _allowOwnWiring(imps[i]);
        }
        probe.allow(im.coordinator, T.FACTORY, address(factory));
        // Callers.
        for (uint256 i; i < 11; ++i) {
            probe.addCaller(imps[i]);
        }
        for (uint256 i; i < 9; ++i) {
            probe.addCaller(strangerClones[i]);
            probe.addCaller(box0[i]);
        }
        address[7] memory more = [a.token, a.executor, a.table, address(factory), im.planner, im.registry, address(pm)];
        for (uint256 i; i < more.length; ++i) {
            probe.addCaller(more[i]);
        }
        probe.addCaller(address(kit));
        probe.addCaller(safe);
        probe.addCaller(address(this));
        // Not address(0): no transaction or call on Ethereum has msg.sender == address(0) (no key, no code there;
        // system calls come from 0xff..fe). `testProperty_AUDIT_U1_zeroSenderSweep` probes it on its own.
        probe.addCaller(stranger);
        for (uint256 i; i < 6; ++i) {
            probe.addCaller(eoa[i]);
        }
    }

    /// @dev The documented callers of a box 0 clone (and of a stranger's copy of it, which names box 0's contracts).
    function _allowBox0Roles(address at, uint8 kind) internal {
        probe.allow(at, T.POOL_MANAGER, address(pm));
        if (kind == T.K_COORDINATOR) probe.allow(at, T.FACTORY, address(factory));
        if (kind == T.K_RECEIVER) {
            probe.allow(at, T.EXECUTOR_OR_HOOK, a.executor);
            probe.allow(at, T.EXECUTOR_OR_HOOK, a.hook);
        }
        if (kind == T.K_HOOK) probe.allow(at, T.RECEIVER, a.receiver);
        if (kind == T.K_VAULT) probe.allow(at, T.TICKETS, a.tickets);
        if (kind == T.K_STREAM) {
            probe.allow(at, T.COLLECTION, a.collection);
            probe.allow(at, T.VAULT, a.vault);
            probe.allow(at, T.RECEIVER, a.receiver);
        }
        if (kind != T.K_COORDINATOR && kind != T.K_ROYALTY) probe.allow(at, T.COORDINATOR, a.coordinator);
    }

    /// @dev An implementation's documented callers are what its own (argument-less) code names: the PoolManager
    /// immutable, and for the roles whatever its getters read from its own code bytes (an address nobody controls).
    function _allowOwnWiring(address impl) internal {
        probe.allow(impl, T.POOL_MANAGER, address(pm));
        _allowIf(impl, T.COORDINATOR, _read(impl, "coordinator()"));
        _allowIf(impl, T.RECEIVER, _read(impl, "receiver()"));
        _allowIf(impl, T.COLLECTION, _read(impl, "collection()"));
        _allowIf(impl, T.VAULT, _read(impl, "vault()"));
        _allowIf(impl, T.TICKETS, _read(impl, "ticketAdapter()"));
        _allowIf(impl, T.EXECUTOR_OR_HOOK, _read(impl, "executor()"));
        _allowIf(impl, T.EXECUTOR_OR_HOOK, _read(impl, "hook()"));
    }

    function _allowIf(address target, uint8 class_, address caller) internal {
        if (caller != address(0)) probe.allow(target, class_, caller);
    }

    function _read(address at, string memory sig) internal view returns (address r) {
        (bool ok, bytes memory ret) = at.staticcall(abi.encodeWithSignature(sig));
        if (ok && ret.length >= 32) r = address(uint160(uint256(bytes32(ret))));
    }

    function _assertProbeClean() internal {
        if (probe.violations() != 0) {
            (
                address at,
                uint8 kind,
                bytes4 sel,
                address caller,
                bytes memory data,
                address where,
                bytes32 slot,
                bool moved
            ) = abi.decode(probe.firstViolation(), (address, uint8, bytes4, address, bytes, address, bytes32, bool));
            emit log_named_address("violation target", at);
            emit log_named_uint("kind", kind);
            emit log_named_bytes32("selector", bytes32(sel));
            emit log_named_address("caller", caller);
            emit log_named_bytes("calldata", data);
            emit log_named_address("wrote at", where);
            emit log_named_bytes32("slot", slot);
            emit log_named_uint("eth moved", moved ? 1 : 0);
        }
        assertEq(probe.violations(), 0, "BC-010: a caller outside the documented table changed state");
    }
}
