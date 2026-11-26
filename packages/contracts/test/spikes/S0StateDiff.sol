// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";

/// @title S0StateDiff
/// @notice SPIKE ONLY: what a recorded call added to the state (Foundry `vm.stopAndReturnStateDiff()`): accounts
/// created, code bytes deployed and storage slots written from zero (first previous value 0, last new value non-zero,
/// per account and slot, reverted writes ignored). These are the units EIP-8037 prices as state gas.
library S0StateDiff {
    struct Counts {
        uint256 accounts;
        uint256 codeBytes;
        uint256 newSlots;
    }

    function count(VmSafe.AccountAccess[] memory accesses) internal pure returns (Counts memory c) {
        uint256 m;
        for (uint256 i; i < accesses.length; ++i) {
            m += accesses[i].storageAccesses.length;
        }
        address[] memory acc = new address[](m);
        bytes32[] memory slot = new bytes32[](m);
        bytes32[] memory first = new bytes32[](m);
        bytes32[] memory last = new bytes32[](m);
        uint256 k;
        for (uint256 i; i < accesses.length; ++i) {
            VmSafe.AccountAccess memory a = accesses[i];
            if (a.kind == VmSafe.AccountAccessKind.Create && !a.reverted) {
                ++c.accounts;
                c.codeBytes += a.deployedCode.length;
            }
            for (uint256 j; j < a.storageAccesses.length; ++j) {
                VmSafe.StorageAccess memory s = a.storageAccesses[j];
                if (!s.isWrite || s.reverted) continue;
                uint256 at = k;
                for (uint256 x; x < k; ++x) {
                    if (acc[x] == s.account && slot[x] == s.slot) {
                        at = x;
                        break;
                    }
                }
                if (at == k) {
                    (acc[k], slot[k], first[k]) = (s.account, s.slot, s.previousValue);
                    ++k;
                }
                last[at] = s.newValue;
            }
        }
        for (uint256 x; x < k; ++x) {
            if (first[x] == bytes32(0) && last[x] != bytes32(0)) ++c.newSlots;
        }
    }
}
