// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Vm} from "forge-std/Vm.sol";
import {AuditU1LaneBase} from "./AuditU1LaneBase.sol";

/// forge-config: default.evm_version = "osaka"
contract AuditU1LaneStorage is AuditU1LaneBase {
    // W3-U1-3, accepted as built (F147, integrator text): three creation words, each written by two creation steps.
    /// @notice BC-012, coverage.v1.json:281; BoxCoordinator.sol:195,209. Expected: each creation slot written
    /// once. Observed: slot 0 is written twice, first hook/id by deploy, then launched by launch. Steps: createBox,
    /// count non-reverted SSTOREs to coordinator slot 0. Amount: one BOOTSTRAP_ETH; no loss, an atomic packed word.
    function testAccepted_AUDIT_U1_51_coordinatorCreationWordWrittenTwice() public {
        vm.startStateDiffRecording();
        _create();
        Vm.AccountAccess[] memory changes = vm.stopAndReturnStateDiff();
        uint256 writes;
        for (uint256 i; i < changes.length; ++i) {
            for (uint256 j; j < changes[i].storageAccesses.length; ++j) {
                Vm.StorageAccess memory s = changes[i].storageAccesses[j];
                if (s.account == a.coordinator && s.isWrite && !s.reverted && s.slot == bytes32(0)) ++writes;
            }
        }
        assertEq(writes, 2);
    }

    function testProperty_AUDIT_U1_creationStorageInventory() public {
        vm.startStateDiffRecording();
        _create();
        Vm.AccountAccess[] memory changes = vm.stopAndReturnStateDiff();
        address[] memory t = _targets();
        for (uint256 k; k < 12; ++k) {
            if (k == 1 || k == 2 || k == 7) continue; // data, ERC20 and full executor are not clones
            bytes32[] memory seen = new bytes32[](32);
            uint256[] memory counts = new uint256[](32);
            uint256 n;
            for (uint256 i; i < changes.length; ++i) {
                for (uint256 j; j < changes[i].storageAccesses.length; ++j) {
                    Vm.StorageAccess memory s = changes[i].storageAccesses[j];
                    if (s.account != t[k] || !s.isWrite || s.reverted) continue;
                    uint256 index;
                    while (index < n && seen[index] != s.slot) ++index;
                    if (index == n) seen[n++] = s.slot;
                    ++counts[index];
                }
            }
            uint256 expectedCount = k == 4 ? 2 : k == 9 ? 4 : k == 10 ? 0 : 1;
            assertEq(n, expectedCount, "exact number of creation slots");
            for (uint256 j; j < n; ++j) {
                _checkSlot(k, t[k], seen[j], counts[j]);
            }
        }
    }

    function _checkSlot(uint256 k, address target, bytes32 slot, uint256 count) internal {
        uint256 expected;
        uint256 writes = 1;
        uint256 open = _spec().openAt;
        uint256 size = _spec().n;
        if (k == 0) {
            assertEq(slot, bytes32(0));
            expected = uint160(a.hook) | (1 << 208);
            writes = 2;
        }
        if (k == 3) {
            assertEq(slot, bytes32(uint256(1)));
            expected = size | (size << 64);
        }
        if (k == 4) {
            if (slot == bytes32(0)) {
                expected = 1 << 128;
            } else {
                assertEq(slot, keccak256(abi.encode(a.vault, uint256(2))));
                expected = size;
            }
        }
        if (k == 5) {
            assertEq(slot, bytes32(0));
            expected = 1;
        }
        if (k == 6) {
            assertEq(slot, bytes32(0));
            expected = open | (1 << 40);
            writes = 2;
        }
        if (k == 8) {
            assertEq(slot, bytes32(uint256(4)));
            expected = open;
        }
        if (k == 9) {
            assertLt(uint256(slot), 4);
            expected = slot == bytes32(0) ? 1 : (1 << 255);
        }
        if (k == 11) {
            assertEq(slot, bytes32(0));
            expected = (block.number << 8) | (open << 48) | 1;
            writes = 2;
        }
        assertEq(vm.load(target, slot), bytes32(expected), "creation value follows spec/address/clock or sentinel");
        assertEq(count, writes, "exact SSTORE count");
        emit log_string(string.concat(
                "U1-SLOT|",
                vm.toString(k),
                "|",
                vm.toString(slot),
                "|writes=",
                vm.toString(count),
                "|value=",
                vm.toString(vm.load(target, slot))
            ));
    }
}
