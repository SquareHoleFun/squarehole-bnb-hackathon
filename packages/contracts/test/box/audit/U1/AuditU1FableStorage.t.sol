// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {AuditU1FablePreWorld} from "./AuditU1FableBase.sol";

/// @notice SH-AUDIT-B0 U1 (Fable), L8 P1.15 (BC-012, "the storage audit of box 0's clones at creation: a check still
/// to write"): every storage slot `createBox` writes, per account, with how often it was written and its final value.
/// Only box 0's own contracts, T, the registry and the PoolManager are written; no implementation, extension, the
/// factory, the planner, a source, the table or the royalty router (which has no storage) is; every written value
/// is creation-dependent (the hook's address, the creation block, the open time, N, the issuance and the bootstrap's
/// burn, the record) or a fixed mark; the slots written more than once are exactly the state words whose bits two
/// steps set and T's supply and balances the bootstrap moves. The per-contract slot list is the write-surface
/// allow-list the system campaign (X17) starts from; the evidence carries it.
/// forge-config: default.evm_version = "osaka"
contract AuditU1FableStorageTest is AuditU1FablePreWorld {
    struct SlotWrite {
        address account;
        bytes32 slot;
        uint256 writes;
        uint256 changes;
        bytes32 first;
        bytes32 last;
    }

    SlotWrite[] internal slots;
    mapping(bytes32 => uint256) internal slotIndex;
    address[] internal written;
    mapping(address => uint256) internal slotsOf;

    function _collect(VmSafe.AccountAccess[] memory acc) internal {
        for (uint256 i; i < acc.length; ++i) {
            VmSafe.StorageAccess[] memory s = acc[i].storageAccesses;
            for (uint256 j; j < s.length; ++j) {
                if (!s[j].isWrite || s[j].reverted) continue;
                _note(s[j]);
            }
        }
    }

    function _note(VmSafe.StorageAccess memory s) internal {
        bytes32 key = keccak256(abi.encode(s.account, s.slot));
        uint256 at = slotIndex[key];
        if (at == 0) {
            slots.push(
                SlotWrite({
                    account: s.account,
                    slot: s.slot,
                    writes: 0,
                    changes: 0,
                    first: s.previousValue,
                    last: s.previousValue
                })
            );
            at = slots.length;
            slotIndex[key] = at;
            if (slotsOf[s.account] == 0) written.push(s.account);
            ++slotsOf[s.account];
        }
        SlotWrite storage w = slots[at - 1];
        ++w.writes;
        if (s.previousValue != s.newValue) ++w.changes;
        w.last = s.newValue;
    }

    function _label(address x) internal view returns (string memory) {
        if (x == a.coordinator) return "coordinator";
        if (x == a.hook) return "hook";
        if (x == a.launchRouter) return "launchRouter";
        if (x == a.receiver) return "receiver";
        if (x == a.executor) return "executor";
        if (x == a.tickets) return "tickets";
        if (x == a.vault) return "vault";
        if (x == a.collection) return "collection";
        if (x == a.itemStream) return "itemStream";
        if (x == a.royaltyRouter) return "royaltyRouter";
        if (x == a.token) return "T";
        if (x == a.table) return "table";
        if (x == address(registry)) return "registry";
        if (x == address(pm)) return "PoolManager";
        if (x == address(factory)) return "factory";
        if (x == address(planner)) return "planner";
        if (x == address(kit)) return "kit (the test driver, not box 0)";
        return vm.toString(x);
    }

    function _expectedAccount(address x) internal view returns (bool) {
        return x == a.coordinator || x == a.hook || x == a.launchRouter || x == a.receiver || x == a.executor
            || x == a.tickets || x == a.vault || x == a.collection || x == a.itemStream || x == a.token
            || x == address(registry) || x == address(pm);
    }

    function _slotOf(address account, bytes32 slot) internal view returns (SlotWrite memory w) {
        uint256 at = slotIndex[keccak256(abi.encode(account, slot))];
        require(at != 0, string.concat("u1: slot not written: ", _label(account)));
        return slots[at - 1];
    }

    function _last(address account, bytes32 slot) internal view returns (uint256) {
        return uint256(_slotOf(account, slot).last);
    }

    /// @dev The one slot written at `account`.
    function _single(address account) internal view returns (SlotWrite memory w) {
        for (uint256 i; i < slots.length; ++i) {
            if (slots[i].account == account) return slots[i];
        }
        revert(string.concat("u1: nothing written at ", _label(account)));
    }

    function _mapSlot(bytes32 key, uint256 base) internal pure returns (bytes32) {
        return keccak256(abi.encode(key, base));
    }

    function _addrKey(address x) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(x)));
    }

    /// BC-012: the storage audit of box 0 at creation (see the contract notes). Each written slot is logged as
    /// `U1|BC012|<account>|<slot>|<writes>|<changes>|<final>`.
    function testProperty_AUDIT_U1_creationWritesOnlyCreationDependentSlots() public {
        vm.startStateDiffRecording();
        kit.create();
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        _bindHandles();
        _collect(acc);
        _log();
        _assertAccounts();
        _assertCoordinatorHookRouterReceiver();
        _assertItemsAndStream();
        _assertTokenRegistryExecutor();
        _assertWrittenOnce();
        emit log_named_uint("U1|BC012|accounts written (the kit included)", written.length);
        emit log_named_uint("U1|BC012|slots written", slots.length);
        emit log_named_uint("U1|BC012|PoolManager slots", slotsOf[address(pm)]);
    }

    function _log() internal {
        for (uint256 i; i < slots.length; ++i) {
            SlotWrite memory w = slots[i];
            string memory head = string.concat("U1|BC012|", _label(w.account), "|", vm.toString(w.slot));
            string memory tail = string.concat("|", vm.toString(w.writes), "|", vm.toString(w.changes));
            emit log_string(string.concat(head, tail, "|", vm.toString(w.last)));
        }
    }

    /// 1. Only box 0's contracts, T, the registry and the PoolManager are written.
    function _assertAccounts() internal view {
        for (uint256 i; i < written.length; ++i) {
            if (written[i] == address(kit)) continue; // the driver's own bookkeeping (creation block, time, gas)
            assertTrue(_expectedAccount(written[i]), string.concat("written outside the box: ", _label(written[i])));
        }
        assertEq(slotsOf[address(factory)], 0, "the factory holds no state");
        assertEq(slotsOf[address(planner)], 0, "the planner holds no state");
        assertEq(slotsOf[a.royaltyRouter], 0, "the royalty router has no storage");
        assertEq(slotsOf[a.table], 0, "the table is code only");
        assertEq(slotsOf[address(src)] + slotsOf[address(drand)], 0, "the sources are not touched");
        assertEq(slotsOf[impls.coordinator] + slotsOf[impls.hook] + slotsOf[impls.hookExtension], 0, "no impl");
        assertEq(slotsOf[impls.launchRouter] + slotsOf[impls.receiver] + slotsOf[impls.receiverExtension], 0);
        assertEq(slotsOf[impls.collection] + slotsOf[impls.vault] + slotsOf[impls.tickets], 0);
        assertEq(slotsOf[impls.royaltyRouter] + slotsOf[impls.itemStream], 0);
    }

    /// 2a. The state words: the coordinator (the hook, box id 0, launched; deploy and launch), the hook (launched,
    /// the creation block, the open; initialize and launch), the launch router (the open, bootstrapped; initialize
    /// and bootstrap), the receiver (initialised).
    function _assertCoordinatorHookRouterReceiver() internal view {
        uint256 open = hook.openAt();
        SlotWrite memory w = _slotOf(a.coordinator, bytes32(0));
        assertEq(uint256(w.last), uint256(uint160(a.hook)) | (1 << 208), "coordinator _w = hook | launched");
        assertEq(w.writes, 2, "coordinator _w: deploy, launch");
        assertEq(slotsOf[a.coordinator], 1, "coordinator: one slot");
        w = _slotOf(a.hook, bytes32(0));
        assertEq(uint256(w.last), 1 | (createdAtBlock << 8) | (open << 48), "hook _w = launched | block | open");
        assertEq(w.writes, 2, "hook _w: initialize, launch");
        assertEq(slotsOf[a.hook], 1, "hook: one slot (no reserve minted at creation)");
        w = _slotOf(a.launchRouter, bytes32(0));
        assertEq(uint256(w.last), open | (1 << 40), "router _s = open | bootstrapped");
        assertEq(w.writes, 2, "router _s: initialize, bootstrap");
        assertLe(slotsOf[a.launchRouter], 2, "router: the state word, at most the zero totals");
        if (slotsOf[a.launchRouter] == 2) {
            assertEq(_slotOf(a.launchRouter, bytes32(uint256(1))).changes, 0, "the untaxed bootstrap wrote 0 totals");
        }
        w = _slotOf(a.receiver, bytes32(0));
        assertEq(uint256(w.last), 1, "receiver _s = initialised");
        assertEq(w.writes, 1);
        assertEq(slotsOf[a.receiver], 1, "receiver: one slot (no ledger touched)");
    }

    /// 2b. The vault's counts, the collection's status and the vault's balance, the tickets' open, the stream's marks.
    function _assertItemsAndStream() internal view {
        uint256 n = editionSize;
        SlotWrite memory w = _slotOf(a.vault, bytes32(uint256(1)));
        assertEq(uint256(w.last), n | (n << 64), "vault counts = inside N | hidden N");
        assertEq(w.writes, 1);
        assertEq(slotsOf[a.vault], 1, "vault: one slot (no escrow)");
        assertEq(_last(a.collection, bytes32(0)), 1 << 128, "collection status = initialised, 0 revealed");
        assertEq(_last(a.collection, _mapSlot(_addrKey(a.vault), 2)), n, "collection _balances[vault] = N");
        assertEq(slotsOf[a.collection], 2, "collection: two slots (no owner written: ERC-2309)");
        assertEq(slotsOf[a.tickets], 1, "tickets: one slot");
        w = _single(a.tickets);
        assertEq(uint256(w.last), hook.openAt(), "tickets openAt");
        assertEq(uint256(w.slot), 4, "tickets openAt is slot 4 (after the placeholder token's four mappings)");
        assertEq(_last(a.itemStream, bytes32(0)), 1, "stream _s = initialised");
        assertEq(_last(a.itemStream, bytes32(uint256(1))), 1 << 255, "stream _book = mark");
        assertEq(_last(a.itemStream, bytes32(uint256(2))), 1 << 255, "stream _tix = mark");
        assertEq(_last(a.itemStream, bytes32(uint256(3))), 1 << 255, "stream _out = mark");
        assertEq(slotsOf[a.itemStream], 4, "stream: four slots");
    }

    /// 2c. T (the supply issued then burned by the bootstrap, the coordinator's and the PoolManager's balances, the
    /// two max allowances), the registry (the count, the entry's four words, the reverse lookup), FIT's executor
    /// (its oracle and first checkpoint, from the constructor).
    function _assertTokenRegistryExecutor() internal view {
        SlotWrite memory w = _slotOf(a.token, bytes32(0));
        assertEq(uint256(w.last), token.totalSupply(), "T totalSupply");
        assertEq(w.writes, 2, "T totalSupply: the issuance, the bootstrap's burn");
        assertEq(_last(a.token, _mapSlot(_addrKey(a.coordinator), 1)), curve.poolShare, "T balanceOf[coordinator]");
        assertEq(_last(a.token, _mapSlot(_addrKey(address(pm)), 1)), token.balanceOf(address(pm)), "T balanceOf[pm]");
        bytes32 inner = _mapSlot(_addrKey(a.coordinator), 2);
        assertEq(_last(a.token, _mapSlot(_addrKey(a.hook), uint256(inner))), type(uint256).max, "coordinator -> hook");
        inner = _mapSlot(_addrKey(a.tickets), 2);
        assertEq(_last(a.token, _mapSlot(_addrKey(a.vault), uint256(inner))), type(uint256).max, "tickets -> vault");
        assertEq(slotsOf[a.token], 5, "T: five slots");
        assertEq(_last(address(registry), bytes32(0)), 1, "boxCount");
        bytes32 entry0 = _mapSlot(bytes32(0), 1);
        assertEq(
            _last(address(registry), entry0),
            uint256(uint160(a.coordinator)) | (createdAtBlock << 160),
            "entry: coordinator | creation block"
        );
        (,, bytes32 templateId, bytes32 specHash, bytes32 recordHash) = registry.entry(0);
        assertEq(_slotOf(address(registry), bytes32(uint256(entry0) + 1)).last, templateId);
        assertEq(_slotOf(address(registry), bytes32(uint256(entry0) + 2)).last, specHash);
        assertEq(_slotOf(address(registry), bytes32(uint256(entry0) + 3)).last, recordHash);
        assertEq(_last(address(registry), _mapSlot(_addrKey(a.coordinator), 2)), 1, "_idPlusOne[coordinator]");
        assertEq(slotsOf[address(registry)], 6, "registry: six slots");
        assertEq(slotsOf[a.executor], 2, "executor: the oracle and checkpoint 0");
    }

    /// 3. Written once, except the state words two steps set and T's and the PoolManager's moving balances.
    function _assertWrittenOnce() internal view {
        for (uint256 i; i < slots.length; ++i) {
            SlotWrite memory w = slots[i];
            if (w.account == address(pm) || w.account == a.token || w.account == address(kit)) continue;
            bool twoStep = (w.account == a.coordinator || w.account == a.hook || w.account == a.launchRouter)
                && w.slot == bytes32(0);
            assertEq(w.writes, twoStep ? 2 : 1, string.concat("written once: ", _label(w.account)));
        }
    }
}
