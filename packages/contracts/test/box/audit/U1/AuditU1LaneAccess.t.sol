// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {AuditU1LaneBase} from "./AuditU1LaneBase.sol";
import {AuditU1LaneSelectors as Table} from "./AuditU1LaneSelectors.sol";
import {CoreImpls} from "../../conformance/core/CoreBox0Kit.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {BoxFactoryV1Planner} from "../../../../src/box/BoxFactoryV1Planner.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";

/// @notice The only invariant target. A probe records every accessed storage key (mapping keys included), captures
/// after-values, rolls back, then reads before-values with vm.load. Unauthorized calls may fail; the handler does
/// not abort. Public/holder entry points have no excluded caller and are not falsely required to be read-only.
contract AuditU1LaneAccessHandler is Test {
    address[] internal targets;
    uint256[] internal kinds;
    address[] internal actors;
    address internal manager;
    address internal creator;
    uint256 public probes;
    uint256 public badChanges;

    constructor(address[] memory t, uint256[] memory k, address[] memory actors_, address manager_, address creator_) {
        targets = t;
        kinds = k;
        actors = actors_;
        manager = manager_;
        creator = creator_;
    }

    function probe(uint256 targetSeed, uint256 selectorSeed, uint256 callerSeed, bytes32 random, bytes calldata tail)
        external
    {
        uint256 at = targetSeed % targets.length;
        uint256 kind = kinds[at];
        address caller = callerSeed % (actors.length + 1) == actors.length
            ? address(uint160(uint256(random)))
            : actors[callerSeed % (actors.length + 1)];
        if (caller == address(vm)) caller = address(0x123456);
        bytes memory data;
        if (kind == 18 || selectorSeed % 4 == 0) {
            bytes4 selector = bytes4(random);
            bytes memory known = kind == 18 ? bytes("") : Table.selectors(kind);
            // Unknown selector only: known public functions are allowed to write for arbitrary callers.
            for (uint256 j; j < known.length; j += 4) {
                if (bytes4(_at(known, j)) == selector) return;
            }
            data = abi.encodePacked(selector, tail);
        } else {
            bytes memory authorities = Table.authorities(kind);
            uint256 idx = selectorSeed % authorities.length;
            uint8 rule = uint8(authorities[idx]);
            if (rule == 0 || _permitted(rule, caller)) return;
            data = Table.sample(kind, idx);
            // Half are valid zero ABI tuples, half retain the selector and fuzz the whole argument body.
            if (selectorSeed & 1 != 0) data = abi.encodePacked(bytes4(data), tail);
        }
        _compare(targets[at], caller, data);
    }

    function exhaustive(uint256 at, uint256 index, address caller) external {
        uint256 kind = kinds[at];
        if (kind == 18) return;
        uint8 rule = uint8(Table.authorities(kind)[index]);
        if (rule == 0 || _permitted(rule, caller)) return;
        _compare(targets[at], caller, Table.sample(kind, index));
    }

    function _at(bytes memory b, uint256 n) internal pure returns (bytes32 x) {
        assembly ("memory-safe") { x := mload(add(add(b, 32), n)) }
    }

    function _permitted(uint8 rule, address c) internal view returns (bool) {
        if (rule == 1) return c == targets[0];
        if (rule == 2) return c == targets[12];
        if (rule == 3) return c == manager;
        if (rule == 4) return c == targets[5];
        if (rule == 5) return c == targets[8];
        if (rule == 6) return c == targets[4];
        if (rule == 7) return c == targets[3];
        if (rule == 8) return c == targets[7] || c == targets[11];
        if (rule == 9) return c == creator;
        return false; // box 0 has no creator payee, swap module or reveal unlocker
    }

    function _compare(address target, address caller, bytes memory data) internal {
        uint256 snapshot = vm.snapshotState();
        vm.record();
        vm.prank(caller);
        // Return/revert data is immaterial: only actual persistent storage changes count.
        (bool success,) = target.call{gas: 2_000_000}(data);
        success;
        bytes32[][] memory slots = new bytes32[][](targets.length);
        bytes32[][] memory afters = new bytes32[][](targets.length);
        for (uint256 i; i < targets.length; ++i) {
            (slots[i],) = vm.accesses(targets[i]);
            afters[i] = new bytes32[](slots[i].length);
            for (uint256 j; j < slots[i].length; ++j) {
                afters[i][j] = vm.load(targets[i], slots[i][j]);
            }
        }
        vm.revertToStateAndDelete(snapshot);
        for (uint256 i; i < targets.length; ++i) {
            for (uint256 j; j < slots[i].length; ++j) {
                if (afters[i][j] != vm.load(targets[i], slots[i][j])) ++badChanges;
            }
        }
        ++probes;
    }
}

abstract contract AuditU1LaneAccessBase is AuditU1LaneBase {
    AuditU1LaneAccessHandler internal handler;
    address[] internal watched;
    uint256[] internal kind;
    address[] internal callers;

    function setUp() public virtual override {
        super.setUp();
        _create();
        CoreImpls memory i = kit.impls();
        address[13] memory extra = [
            i.coordinator,
            i.hook,
            i.launchRouter,
            i.receiver,
            i.collection,
            i.vault,
            i.tickets,
            i.royaltyRouter,
            i.itemStream,
            i.hookExtension,
            i.receiverExtension,
            address(src),
            address(drand)
        ];
        uint256[15] memory initialKinds = [uint256(0), 18, 9, 5, 4, 3, 2, 10, 6, 8, 7, 1, 11, 12, 13];
        address[] memory initial = _targets();
        for (uint256 j; j < initial.length; ++j) {
            watched.push(initial[j]);
            kind.push(initialKinds[j]);
        }
        for (uint256 j; j < extra.length; ++j) {
            watched.push(extra[j]);
            kind.push(j < 9 ? j : j + 5);
            callers.push(extra[j]);
        }
        BoxFactoryV1Planner.Plan memory p =
            planner.plan(_spec(), factory.version(), address(this), a.hookSalt, keccak256(encoded));
        callers.push(BoxClones.create(p.coordinatorInit));
        callers.push(address(pm));
        callers.push(a.coordinator);
        callers.push(address(0x123456));
        handler = new AuditU1LaneAccessHandler(watched, kind, callers, address(pm), address(kit));
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU1LaneAccess is AuditU1LaneAccessBase {
    function testFuzz_AUDIT_U1_BC010_allTargets(
        uint256 target,
        uint256 selector,
        uint256 caller,
        bytes32 random,
        bytes memory data
    ) public {
        handler.probe(target, selector, caller, random, data);
        assertEq(handler.badChanges(), 0);
    }

    function testProperty_AUDIT_U1_BC010_everyRestrictedSelectorAndCallerClass() public {
        for (uint256 i; i < watched.length; ++i) {
            if (kind[i] == 18) continue;
            bytes memory rules = Table.authorities(kind[i]);
            for (uint256 j; j < rules.length; ++j) {
                if (rules[j] != 0) {
                    for (uint256 k; k < callers.length; ++k) {
                        handler.exhaustive(i, j, callers[k]);
                    }
                }
            }
        }
        assertGt(handler.probes(), 500, "non-vacuous caller matrix");
        assertEq(handler.badChanges(), 0);
        emit log_named_uint("U1-ACCESS-probes", handler.probes());
    }

    /// BC-010 / ADR-0016 section 5: compare the complete ABI, not just a deny list. Constants and the informational
    /// owner()/ERC721 setApprovalForAll()/payee handover are explicitly in the frozen table, without admin powers.
    function testProperty_AUDIT_U1_externalSelectorSetEqualsTable() public view {
        string memory output = BoxBuildV1.REHEARSAL ? "out-rehearsal/" : "out/";
        for (uint256 k; k < 18; ++k) {
            string memory name = Table.name(k);
            string memory artifact = vm.readFile(string.concat(output, name, ".sol/", name, ".json"));
            string[] memory signatures = vm.parseJsonKeys(artifact, ".methodIdentifiers");
            bytes memory expected = Table.selectors(k);
            assertEq(signatures.length * 4, expected.length, name);
            for (uint256 j; j < signatures.length; ++j) {
                bytes4 actual = bytes4(keccak256(bytes(signatures[j])));
                bytes4 want;
                assembly ("memory-safe") { want := mload(add(add(expected, 32), mul(j, 4))) }
                assertEq(actual, want, signatures[j]);
            }
        }
        assertEq(a.table.code[0], bytes1(0), "data contract has no dispatch");
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU1LaneAccessInvariants is AuditU1LaneAccessBase {
    function setUp() public override {
        super.setUp();
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = handler.probe.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_AUDIT_U1_unauthorizedCallsChangeNoBoxStorage() public view {
        assertEq(handler.badChanges(), 0);
    }
}
