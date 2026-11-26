// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {CoreImpls} from "../../conformance/core/CoreBox0Kit.sol";
import {AuditU1ClaudeSurfaceTable as T} from "./AuditU1ClaudeSurfaceTable.sol";
import {AuditU1ClaudeLeakyVault, AuditU1ClaudeShapes, AuditU1ClaudeSurfaceBase} from "./AuditU1ClaudeSurfaceWorld.sol";

/// @title AuditU1ClaudeSurfaceTest
/// @notice SH-AUDIT-B0 U1, lens L2 (P1.4, P1.5, P1.6) on box 0 right after its creation, osaka.
/// forge-config: default.evm_version = "osaka"
contract AuditU1ClaudeSurfaceTest is AuditU1ClaudeSurfaceBase {
    AuditU1ClaudeShapes internal shapes;

    function setUp() public override {
        super.setUp();
        _buildProbe();
        shapes = new AuditU1ClaudeShapes();
    }

    /// P1.4 / BC-010 ("every state-changing function is fuzzed from random callers"; "no function is gated on
    /// msg.sender except to one fixed contract set at creation"): a random (target, selector, caller, calldata) whose
    /// caller is not in the documented table for that function (or whose selector is a view or unknown) reverts or
    /// changes nothing: no storage slot of any account and no ETH. Box 0 as created (Upcoming).
    function testFuzz_AUDIT_U1_strangersChangeNothingAtCreation(
        uint256 targetSeed,
        uint256 selSeed,
        uint256 callerSeed,
        uint256 nWords,
        bytes32[6] memory words
    ) public {
        probe.probe(targetSeed, selSeed, callerSeed, nWords, words);
        _assertProbeClean();
    }

    /// P1.4 / BC-010, the census: 4,000 probes from a fixed seed, counted (the fuzz runs above do not keep counters,
    /// each run starts from setUp). Every probe whose caller the table does not allow reverts or changes nothing, and
    /// every target kind gets restricted probes.
    function testProperty_AUDIT_U1_strangerCensus() public {
        vm.pauseGasMetering();
        for (uint256 i; i < 4_000; ++i) {
            bytes32[6] memory w;
            for (uint256 j; j < 6; ++j) {
                w[j] = keccak256(abi.encode("u1.census.word", i, j));
            }
            uint256 r = uint256(keccak256(abi.encode("u1.census", i)));
            probe.probe(r, r >> 64, r >> 128, r >> 192, w);
        }
        vm.resumeGasMetering();
        emit log_named_uint("probes", probe.probes());
        emit log_named_uint("allowed by the table (not checked)", probe.allowedSkipped());
        emit log_named_uint("restricted", probe.restricted());
        emit log_named_uint("restricted: reverted", probe.restrictedReverted());
        emit log_named_uint("restricted: succeeded, changed nothing", probe.restrictedNoOp());
        emit log_named_uint("violations", probe.violations());
        for (uint8 k; k < 19; ++k) {
            emit log_named_uint(string.concat("restricted probes of kind ", vm.toString(k)), probe.restrictedOfKind(k));
        }
        _assertProbeClean();
        assertEq(probe.probes(), 4_000);
        assertGt(probe.restricted(), 2_000, "most probes are checked");
        for (uint8 k; k < 19; ++k) {
            assertGt(probe.restrictedOfKind(k), 0, "every kind probed");
        }
    }

    /// P1.4 / BC-010 from address(0) (not a possible sender on Ethereum: no key and no code there, system calls come
    /// from 0xff..fe; so the campaign above leaves it out): every selector of all 37 targets with four argument shapes,
    /// the sender pranked to address(0). The only state it changes is the one Proof 02 pins: box 0's collection
    /// `unlockReveal(id)` (its unlocker is zero, and zero is only "nobody" while no call comes from it); nothing else.
    function testProperty_AUDIT_U1_zeroSenderSweep() public {
        vm.pauseGasMetering();
        uint256 n = probe.targetCount();
        bytes32[4] memory args = [bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(0x20)), bytes32(0)];
        uint256 swept;
        for (uint256 t; t < n; ++t) {
            (address at, uint8 kind) = probe.targetAt(t);
            bytes4[] memory sels = probe.selectorsOf(kind);
            for (uint256 s; s < sels.length; ++s) {
                for (uint256 k; k < 4; ++k) {
                    uint256 before = probe.violations();
                    bytes memory data = abi.encodePacked(sels[s], args[k], args[(k + 1) % 4], args[(k + 2) % 4]);
                    probe.probeExact(at, kind, data, address(0));
                    ++swept;
                    if (probe.violations() != before) {
                        assertEq(at, a.collection, "only box 0's collection");
                        assertEq(sels[s], bytes4(keccak256("unlockReveal(uint256)")), "only unlockReveal");
                    }
                }
            }
        }
        vm.resumeGasMetering();
        emit log_named_uint("zero-sender probes", swept);
        emit log_named_uint("zero-sender writes (all unlockReveal on box 0's collection)", probe.violations());
        assertEq(probe.violations(), 3, "unlockReveal(1), (2) and (32): the three shapes whose first word is an id");
    }

    /// The probe's positive control: a stand-in vault whose `openGate` writes for any caller is reported as a
    /// violation from a stranger and passes from its documented caller (so a clean run above is a real result).
    function testProperty_AUDIT_U1_probeCatchesALeak() public {
        AuditU1ClaudeLeakyVault leaky = new AuditU1ClaudeLeakyVault();
        probe.allow(address(leaky), T.COORDINATOR, a.coordinator);
        bytes memory data = abi.encodeWithSignature("openGate()");
        assertFalse(probe.probeExact(address(leaky), T.K_VAULT, data, a.coordinator), "the documented caller: skipped");
        assertTrue(probe.probeExact(address(leaky), T.K_VAULT, data, stranger), "a stranger's write is caught");
        assertEq(probe.violations(), 1);
        assertFalse(probe.probeExact(a.vault, T.K_VAULT, data, stranger), "box 0's vault refuses the stranger");
        assertEq(probe.violations(), 1, "and that is no violation");
    }

    /// P1.5 (ADR-0016 § 4 items 2-5, `docs/decisions/0016-custody-clones.md:131`; BC-100; review of sh-core-v1 #1,
    /// whose fix this pins): no implementation can be initialised directly, by a stranger, by the address its own code
    /// names as coordinator, by box 0's coordinator or by any other clone of the coordinator implementation; a
    /// stranger's clone of each initialisable implementation carrying box 0's exact arguments refuses every caller but
    /// the coordinator its arguments name (box 0's, which initialises only its own role addresses, once, inside
    /// `launch`); every coordinator clone refuses `deploy` and `launch` from anyone but the factory, and box 0's refuses
    /// both even from the factory now; and the shape checks tell the two proxies apart: the 6-byte receiving proxy is
    /// never a standard clone (so it can never pass an `initialize` gate) and a standard clone is never a receiving
    /// one; an EIP-7702 delegation to box 0's coordinator is no clone either.
    function testProperty_AUDIT_U1_strangerClonesAndImplementationsAreInert() public {
        CoreImpls memory im = kit.impls();
        address[7] memory imps =
            [im.hook, im.launchRouter, im.receiver, im.collection, im.vault, im.tickets, im.itemStream];
        address sCoord = strangerClones[0];
        for (uint256 i; i < imps.length; ++i) {
            address own = _read(imps[i], "coordinator()");
            address[5] memory callers = [stranger, a.coordinator, sCoord, own, im.coordinator];
            for (uint256 j; j < callers.length; ++j) {
                _initRefused(imps[i], callers[j]);
            }
            // The stranger's copy of box 0's clone (index i + 1 in strangerClones).
            address copy = strangerClones[i + 1];
            address[4] memory notNamed = [stranger, sCoord, im.coordinator, address(this)];
            for (uint256 j; j < notNamed.length; ++j) {
                _initRefused(copy, notNamed[j]);
            }
        }
        // Every coordinator clone but through the factory: deploy and launch refuse every other caller.
        bytes[] memory none = new bytes[](0);
        address[4] memory coords = [sCoord, a.coordinator, im.coordinator, strangerClones[0]];
        address[3] memory notFactory = [stranger, a.coordinator, address(kit)];
        for (uint256 i; i < coords.length; ++i) {
            for (uint256 j; j < notFactory.length; ++j) {
                vm.prank(notFactory[j]);
                vm.expectRevert(abi.encodeWithSelector(IBoxCoordinator.NotFactory.selector, notFactory[j]));
                BoxCoordinator(coords[i]).deploy(none, "", bytes32(0), 0);
                vm.prank(notFactory[j]);
                vm.expectRevert(abi.encodeWithSelector(IBoxCoordinator.NotFactory.selector, notFactory[j]));
                BoxCoordinator(coords[i]).launch();
            }
        }
        // Box 0's coordinator (and the implementation) refuse both even from the factory: once each.
        vm.prank(address(factory));
        vm.expectRevert(BoxCoordinator.AlreadyDeployed.selector);
        BoxCoordinator(a.coordinator).deploy(none, "", bytes32(0), 0);
        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSignature("AlreadyLaunched()"));
        BoxCoordinator(a.coordinator).launch();
        vm.prank(address(factory));
        vm.expectRevert(BoxCoordinator.AlreadyDeployed.selector);
        BoxCoordinator(im.coordinator).deploy(none, "", bytes32(0), 0);
        // Shapes.
        assertTrue(shapes.isCloneOf(a.coordinator, im.coordinator), "box 0's coordinator is a standard clone");
        assertTrue(shapes.isReceivingCloneOf(a.royaltyRouter, im.royaltyRouter), "the router is a receiving clone");
        assertFalse(shapes.isCloneOf(a.royaltyRouter, im.royaltyRouter), "a receiving clone is no standard clone");
        assertFalse(shapes.isReceivingCloneOf(a.vault, im.vault), "a standard clone is no receiving clone");
        address recvCoord = makeAddr("u1.receivingCoordinator");
        vm.etch(recvCoord, BoxClones.receivingRuntime(im.coordinator, ""));
        assertFalse(shapes.isCloneOf(recvCoord, im.coordinator), "a receiving-shaped coordinator is no clone");
        assertTrue(shapes.isReceivingCloneOf(recvCoord, im.coordinator));
        address delegated = makeAddr("u1.delegatedToCoordinator");
        vm.etch(delegated, abi.encodePacked(hex"ef0100", a.coordinator));
        assertFalse(shapes.isCloneOf(delegated, im.coordinator), "a 7702 delegation is no clone");
        assertFalse(shapes.isCloneOf(address(0xdead), im.coordinator), "no code is no clone");
        assertFalse(shapes.isCloneOf(im.coordinator, im.coordinator), "the implementation is no clone of itself");
        address[9] memory own = [
            im.coordinator,
            im.hook,
            im.launchRouter,
            im.receiver,
            im.collection,
            im.vault,
            im.tickets,
            im.itemStream,
            im.royaltyRouter
        ];
        for (uint256 i; i < 8; ++i) {
            assertTrue(
                shapes.isCloneOf(strangerClones[i], own[i]), "a stranger's clone is a clone of its implementation"
            );
            assertFalse(shapes.isCloneOf(strangerClones[i], im.coordinator) && i != 0, "and of no other");
        }
        assertTrue(shapes.isReceivingCloneOf(strangerClones[8], im.royaltyRouter), "the router copy is receiving");
        // A receiving-shaped coordinator as the named coordinator of a fresh clone still fails the gate.
        bytes memory args = new bytes(203);
        for (uint256 k; k < 20; ++k) {
            args[143 + k] = bytes20(recvCoord)[k];
        }
        address hookCopy = makeAddr("u1.hookNamingAReceivingCoordinator");
        vm.etch(hookCopy, BoxClones.runtime(im.hook, args));
        _initRefused(hookCopy, recvCoord);
        // The stranger's copies hold nothing and changed nothing.
        assertEq(BoxHook(strangerClones[1]).deployBlock(), 0, "the stranger's hook copy is uninitialised");
    }

    /// @dev `initialize()` from `caller` on `target` reverts.
    function _initRefused(address target, address caller) internal {
        vm.prank(caller);
        (bool ok,) = target.call(abi.encodeWithSignature("initialize()"));
        assertFalse(ok, string.concat("initialize refused: ", vm.toString(target), " from ", vm.toString(caller)));
    }

    /// P1.6 (ADR-0016 § 5, `docs/decisions/0016-custody-clones.md:169`; F23 C2, `docs/decisions/DECISION-LOG.md:38`;
    /// BC-010): the external functions of every box 0 contract, implementation, extension, the factory, planner,
    /// registry and both sources, enumerated from the compiled ABIs, are exactly the documented table (both ways),
    /// and none is an owner, admin, pause, upgrade, setter, rescue, mint or ownership function: the only names that
    /// hold such a word are the collection's `owner()` view (the spec's marketplaceOwner, read by no function, F26 (4))
    /// and the ERC-721 `setApprovalForAll` of the collection and the tickets. No box 0 contract or implementation has
    /// an EIP-1967 implementation, admin or beacon slot set.
    function testProperty_AUDIT_U1_selectorsAreTheDocumentedTable() public view {
        string[18] memory names = T.names();
        uint256 total;
        for (uint8 k; k < 18; ++k) {
            string memory json =
                vm.readFile(string.concat(vm.projectRoot(), "/out/", names[k], ".sol/", names[k], ".json"));
            string[] memory keys = vm.parseJsonKeys(json, ".methodIdentifiers");
            (string[] memory s, uint8[] memory c) = T.table(k);
            assertEq(keys.length, s.length, string.concat(names[k], ": as many functions as the table"));
            for (uint256 i; i < keys.length; ++i) {
                assertTrue(_inList(keys[i], s), string.concat(names[k], ": undocumented function ", keys[i]));
            }
            for (uint256 i; i < s.length; ++i) {
                _assertNoAdminName(names[k], s[i], c[i] == T.VIEW);
            }
            for (uint256 i; i < s.length; ++i) {
                assertTrue(_inList(s[i], keys), string.concat(names[k], ": documented but absent ", s[i]));
            }
            total += keys.length;
        }
        assertEq(total, 553, "every external function counted");
        CoreImpls memory im = kit.impls();
        address[23] memory all = [
            a.coordinator,
            a.hook,
            a.launchRouter,
            a.receiver,
            a.collection,
            a.vault,
            a.tickets,
            a.itemStream,
            a.royaltyRouter,
            a.token,
            a.executor,
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
            im.royaltyRouter,
            address(factory)
        ];
        bytes32[3] memory eip1967 = [
            bytes32(0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc),
            bytes32(0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103),
            bytes32(0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50)
        ];
        for (uint256 i; i < all.length; ++i) {
            for (uint256 j; j < 3; ++j) {
                assertEq(vm.load(all[i], eip1967[j]), bytes32(0), "no EIP-1967 slot");
            }
        }
    }

    function _inList(string memory x, string[] memory list) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(x));
        for (uint256 i; i < list.length; ++i) {
            if (keccak256(bytes(list[i])) == h) return true;
        }
        return false;
    }

    /// @dev No state-changing function's name holds an admin word, and no view's names an admin role or a proxy
    /// target, but the two documented exceptions. Names in capitals are public constants (the registry's ROLE_* record
    /// indexes, MW_* and IMPL_* refusal ids), not entry points.
    function _assertNoAdminName(string memory contractName, string memory sig, bool isView) internal pure {
        if (_isConstantName(sig)) return;
        bytes memory name = _lowerName(sig);
        if (keccak256(name) == keccak256("setapprovalforall")) return;
        if (keccak256(bytes(contractName)) == keccak256("BoxCollection") && keccak256(name) == keccak256("owner")) {
            return;
        }
        if (isView) {
            // A view cannot act; only a getter of an admin role or a proxy target (by its usual name) would hint at
            // one. The version's `implementations()` and each implementation's `coordinatorImplementation()` are
            // immutable wiring, not proxy targets.
            string[7] memory roles =
                ["owner", "admin", "implementation", "paused", "pendingowner", "getowner", "proxiableuuid"];
            for (uint256 i; i < roles.length; ++i) {
                assertFalse(
                    keccak256(name) == keccak256(bytes(roles[i])), string.concat(contractName, ": admin view ", sig)
                );
            }
            return;
        }
        // A camel-case setter (`setX`), admin actions by their usual leading words, role words anywhere in the name.
        bytes memory raw = bytes(sig);
        bool setter =
            raw.length > 3 && raw[0] == "s" && raw[1] == "e" && raw[2] == "t" && raw[3] >= "A" && raw[3] <= "Z";
        assertFalse(setter, string.concat(contractName, ": a setter ", sig));
        string[16] memory prefixes = [
            "pause",
            "unpause",
            "upgrade",
            "transferownership",
            "renounce",
            "grant",
            "revoke",
            "kill",
            "destroy",
            "emergency",
            "rescue",
            "recover",
            "skim",
            "drain",
            "mint",
            "withdrawall"
        ];
        for (uint256 i; i < prefixes.length; ++i) {
            assertFalse(_startsWith(name, bytes(prefixes[i])), string.concat(contractName, ": admin-like name ", sig));
        }
        string[3] memory words = ["owner", "admin", "role"];
        for (uint256 i; i < words.length; ++i) {
            assertFalse(_contains(name, bytes(words[i])), string.concat(contractName, ": admin-like name ", sig));
        }
    }

    function _startsWith(bytes memory hay, bytes memory prefix) internal pure returns (bool) {
        if (prefix.length > hay.length) return false;
        for (uint256 i; i < prefix.length; ++i) {
            if (hay[i] != prefix[i]) return false;
        }
        return true;
    }

    function _isConstantName(string memory sig) internal pure returns (bool) {
        bytes memory b = bytes(sig);
        for (uint256 i; i < b.length && b[i] != "("; ++i) {
            if (b[i] >= "a" && b[i] <= "z") return false;
        }
        return true;
    }

    function _lowerName(string memory sig) internal pure returns (bytes memory out) {
        bytes memory b = bytes(sig);
        uint256 n;
        while (n < b.length && b[n] != "(") ++n;
        out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            bytes1 c = b[i];
            out[i] = c >= "A" && c <= "Z" ? bytes1(uint8(c) + 32) : c;
        }
    }

    function _contains(bytes memory hay, bytes memory needle) internal pure returns (bool) {
        if (needle.length > hay.length) return false;
        for (uint256 i; i + needle.length <= hay.length; ++i) {
            bool same = true;
            for (uint256 j; j < needle.length; ++j) {
                if (hay[i + j] != needle[j]) {
                    same = false;
                    break;
                }
            }
            if (same) return true;
        }
        return false;
    }
}

/// @title AuditU1ClaudeSurfaceGraduatedTest
/// @notice P1.4 / BC-010 on box 0 after graduation (the world's graduated phase: the gate open, the receiver settled,
/// the stream started, the reward credited and unclaimed, the graduation word requested), osaka.
/// forge-config: default.evm_version = "osaka"
contract AuditU1ClaudeSurfaceGraduatedTest is AuditU1ClaudeSurfaceBase {
    function setUp() public override {
        super.setUp();
        _toGraduated();
        _buildProbe();
    }

    /// P1.4 / BC-010 after graduation: as at creation, a caller outside the documented table changes nothing.
    function testFuzz_AUDIT_U1_strangersChangeNothingAfterGraduation(
        uint256 targetSeed,
        uint256 selSeed,
        uint256 callerSeed,
        uint256 nWords,
        bytes32[6] memory words
    ) public {
        probe.probe(targetSeed, selSeed, callerSeed, nWords, words);
        _assertProbeClean();
    }
}
