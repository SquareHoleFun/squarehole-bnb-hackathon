// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {CoreBoxAddresses} from "../../conformance/core/CoreBox0Kit.sol";
import {AuditU1ClaudeKitBase} from "./AuditU1ClaudeBase.sol";

/// @title AuditU1ClaudeStorageTest
/// @notice SH-AUDIT-B0 U1, lens L8 (P1.15; BC-012 "only creation-dependent values (the deploy block and the open time)
/// and values derived from the clone's own address in storage, written once at creation", the check its `waitsT0`
/// names "still to write"), osaka. The whole creation transaction's storage writes, read from its state diff.
/// forge-config: default.evm_version = "osaka"
contract AuditU1ClaudeStorageTest is AuditU1ClaudeKitBase {
    uint256 internal constant MARK = 1 << 255;
    bytes32 internal constant MAX = bytes32(type(uint256).max);

    struct Write {
        address account;
        bytes32 slot;
        bytes32 first;
        bytes32 last;
        uint256 count;
    }

    /// P1.15 (BC-012): right after createBox every clone's storage holds exactly the slots listed here, each with a
    /// value fixed by the creation itself: the coordinator its hook (CREATE2 by its own address) and box id 0 with the
    /// launched bit; the hook its deploy block, its open time and the launched bit; the launch router its open time and
    /// the bootstrapped bit; the receiver its initialised bit; the vault N items inside and N hidden; the collection its
    /// initialised flag and the vault's balance N; the tickets their open time; the stream its initialised bit and its
    /// three non-zero marks; the royalty router and the table nothing. Beside them T holds its supply, the pool share,
    /// the pool's T and two allowances (the coordinator's to the hook, the tickets' to the vault), FIT's executor its first
    /// sample (P1 at the creation time) and checkpoint, the registry its count, record and reverse lookup; the factory and
    /// the planner write nothing. Every clone slot is written in the creation only; three words take a second SSTORE in
    /// that one transaction (the coordinator's and the hook's state word when `launch` sets the launched bit, the
    /// router's when `bootstrap` sets the bootstrapped bit), every other slot exactly one. The list is logged
    /// (`U1-STORAGE|<contract>|<slot>|<value>|<writes>`) as the write-surface allow-list for the system campaign (X17).
    function testProperty_AUDIT_U1_cloneStorageAtCreationIsCreationDependent() public {
        kit.prepare(_spec());
        CoreBoxAddresses memory a = kit.addresses();
        uint256 createdBlock = block.number;
        uint256 createdTime = block.timestamp;
        vm.startStateDiffRecording();
        kit.create();
        Write[] memory w = _writes(vm.stopAndReturnStateDiff());
        _checkClones(w, a, createdBlock);
        _checkTokenAndExecutor(w, a, createdTime);
        _checkRegistry(w, a, createdBlock);
        _checkCounts(w, a);
        _logList(w, a);
        assertEq(BoxCoordinator(a.coordinator).hook(), a.hook);
        assertEq(BoxCoordinator(a.coordinator).boxId(), 0);
        assertEq(BoxHook(a.hook).deployBlock(), createdBlock, "deploy block");
        assertEq(BoxHook(a.hook).openAt(), _spec().openAt, "open time");
    }

    function _checkClones(Write[] memory w, CoreBoxAddresses memory a, uint256 createdBlock) internal view {
        BoxSpecV1.BoxSpec memory s = _spec();
        _only(w, a.coordinator, _one(bytes32(0)), _one(bytes32(uint256(uint160(a.hook)) | (1 << 208))));
        _only(w, a.hook, _one(bytes32(0)), _one(bytes32(1 | (createdBlock << 8) | (uint256(s.openAt) << 48))));
        _only(w, a.launchRouter, _one(bytes32(0)), _one(bytes32(uint256(s.openAt) | (1 << 40))));
        _only(w, a.receiver, _one(bytes32(0)), _one(bytes32(uint256(1))));
        _only(w, a.vault, _one(bytes32(uint256(1))), _one(bytes32(uint256(s.n) | (uint256(s.n) << 64))));
        bytes32[] memory colSlots = new bytes32[](2);
        bytes32[] memory colValues = new bytes32[](2);
        (colSlots[0], colValues[0]) = (bytes32(0), bytes32(uint256(1) << 128));
        (colSlots[1], colValues[1]) = (keccak256(abi.encode(a.vault, uint256(2))), bytes32(uint256(s.n)));
        _only(w, a.collection, colSlots, colValues);
        _only(w, a.tickets, _one(bytes32(uint256(4))), _one(bytes32(uint256(s.openAt))));
        bytes32[] memory stSlots = new bytes32[](4);
        bytes32[] memory stValues = new bytes32[](4);
        (stSlots[0], stValues[0]) = (bytes32(0), bytes32(uint256(1)));
        for (uint256 i = 1; i < 4; ++i) {
            (stSlots[i], stValues[i]) = (bytes32(i), bytes32(MARK));
        }
        _only(w, a.itemStream, stSlots, stValues);
        _only(w, a.royaltyRouter, new bytes32[](0), new bytes32[](0));
        _only(w, a.table, new bytes32[](0), new bytes32[](0));
        _only(w, address(factory), new bytes32[](0), new bytes32[](0));
        _only(w, address(planner), new bytes32[](0), new bytes32[](0));
    }

    /// @dev T: supply, two balances, two allowances; FIT's executor: its first sample (P1's tick at the creation time,
    /// filled 1) and checkpoint 0.
    function _checkTokenAndExecutor(Write[] memory w, CoreBoxAddresses memory a, uint256 createdTime) internal view {
        BoxToken t = BoxToken(a.token);
        uint256 share = kit.curve().poolShare;
        bytes32[] memory tSlots = new bytes32[](5);
        bytes32[] memory tValues = new bytes32[](5);
        (tSlots[0], tValues[0]) = (bytes32(0), bytes32(t.totalSupply()));
        (tSlots[1], tValues[1]) = (keccak256(abi.encode(a.coordinator, uint256(1))), bytes32(share));
        (tSlots[2], tValues[2]) = (keccak256(abi.encode(address(pm), uint256(1))), bytes32(t.totalSupply() - share));
        (tSlots[3], tValues[3]) = (_allowanceSlot(a.coordinator, a.hook), MAX);
        (tSlots[4], tValues[4]) = (_allowanceSlot(a.tickets, a.vault), MAX);
        _only(w, a.token, tSlots, tValues);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 tick24 = uint256(uint24(kit.curve().tickLower));
        bytes32[] memory xSlots = new bytes32[](2);
        bytes32[] memory xValues = new bytes32[](2);
        (xSlots[0], xValues[0]) = (bytes32(uint256(3)), bytes32(tick24 | (createdTime << 24) | (uint256(1) << 120)));
        (xSlots[1], xValues[1]) = (bytes32(uint256(4)), bytes32(createdTime));
        _only(w, a.executor, xSlots, xValues);
    }

    /// @dev The registry: count, the record's four words and the reverse lookup.
    function _checkRegistry(Write[] memory w, CoreBoxAddresses memory a, uint256 createdBlock) internal view {
        (,, bytes32 templateId, bytes32 specHash, bytes32 recordHash) = registry.entry(0);
        bytes32 base = keccak256(abi.encode(uint256(0), uint256(1)));
        bytes32[] memory rSlots = new bytes32[](6);
        bytes32[] memory rValues = new bytes32[](6);
        (rSlots[0], rValues[0]) = (bytes32(0), bytes32(uint256(1)));
        (rSlots[1], rValues[1]) = (base, bytes32(uint256(uint160(a.coordinator)) | (createdBlock << 160)));
        (rSlots[2], rValues[2]) = (bytes32(uint256(base) + 1), templateId);
        (rSlots[3], rValues[3]) = (bytes32(uint256(base) + 2), specHash);
        (rSlots[4], rValues[4]) = (bytes32(uint256(base) + 3), recordHash);
        (rSlots[5], rValues[5]) = (keccak256(abi.encode(a.coordinator, uint256(2))), bytes32(uint256(1)));
        _only(w, address(registry), rSlots, rValues);
    }

    /// @dev Written once, but for the three state words that `launch` and `bootstrap` complete.
    function _checkCounts(Write[] memory w, CoreBoxAddresses memory a) internal pure {
        address[8] memory clones =
            [a.coordinator, a.hook, a.launchRouter, a.receiver, a.vault, a.collection, a.tickets, a.itemStream];
        for (uint256 i; i < w.length; ++i) {
            bool clone;
            for (uint256 k; k < clones.length; ++k) {
                if (w[i].account == clones[k]) clone = true;
            }
            if (!clone) continue;
            bool twice = w[i].slot == bytes32(0)
                && (w[i].account == a.coordinator || w[i].account == a.hook || w[i].account == a.launchRouter);
            assertEq(w[i].count, twice ? 2 : 1, "each clone slot written once (three state words twice)");
            assertEq(w[i].first, bytes32(0), "every clone slot starts from zero");
        }
    }

    function _one(bytes32 x) internal pure returns (bytes32[] memory l) {
        l = new bytes32[](1);
        l[0] = x;
    }

    function _allowanceSlot(address owner_, address spender) internal pure returns (bytes32) {
        return keccak256(abi.encode(spender, keccak256(abi.encode(owner_, uint256(2)))));
    }

    /// @dev `account`'s net writes are exactly `slots` with final `values`.
    function _only(Write[] memory w, address account, bytes32[] memory slots, bytes32[] memory values) internal pure {
        uint256 n;
        for (uint256 i; i < w.length; ++i) {
            if (w[i].account != account || w[i].first == w[i].last) continue;
            ++n;
            bool listed;
            for (uint256 k; k < slots.length; ++k) {
                if (slots[k] == w[i].slot) {
                    listed = true;
                    assertEq(w[i].last, values[k], "the slot's creation value");
                }
            }
            assertTrue(listed, "only the listed slots are written");
        }
        assertEq(n, slots.length, "every listed slot is written");
    }

    /// @dev Non-reverted writes per (account, slot): first previous value, last new value, count.
    function _writes(VmSafe.AccountAccess[] memory acc) internal pure returns (Write[] memory out) {
        uint256 m;
        for (uint256 i; i < acc.length; ++i) {
            m += acc[i].storageAccesses.length;
        }
        out = new Write[](m);
        uint256 k;
        for (uint256 i; i < acc.length; ++i) {
            for (uint256 j; j < acc[i].storageAccesses.length; ++j) {
                VmSafe.StorageAccess memory x = acc[i].storageAccesses[j];
                if (!x.isWrite || x.reverted) continue;
                uint256 at = k;
                for (uint256 y; y < k; ++y) {
                    if (out[y].account == x.account && out[y].slot == x.slot) {
                        at = y;
                        break;
                    }
                }
                if (at == k) {
                    out[k] = Write(x.account, x.slot, x.previousValue, x.newValue, 0);
                    ++k;
                }
                out[at].last = x.newValue;
                ++out[at].count;
            }
        }
        assembly ("memory-safe") {
            mstore(out, k)
        }
    }

    function _logList(Write[] memory w, CoreBoxAddresses memory a) internal {
        address[13] memory at = [
            a.coordinator,
            a.hook,
            a.launchRouter,
            a.receiver,
            a.vault,
            a.collection,
            a.tickets,
            a.itemStream,
            a.token,
            a.executor,
            address(registry),
            a.royaltyRouter,
            a.table
        ];
        string[13] memory names = [
            "coordinator",
            "hook",
            "launchRouter",
            "receiver",
            "vault",
            "collection",
            "tickets",
            "itemStream",
            "T",
            "executor",
            "registry",
            "royaltyRouter",
            "table"
        ];
        for (uint256 k; k < at.length; ++k) {
            for (uint256 i; i < w.length; ++i) {
                if (w[i].account != at[k]) continue;
                emit log(string.concat(
                        "U1-STORAGE|",
                        names[k],
                        "|",
                        vm.toString(w[i].slot),
                        "|",
                        vm.toString(w[i].last),
                        "|",
                        vm.toString(w[i].count)
                    ));
            }
        }
    }
}
