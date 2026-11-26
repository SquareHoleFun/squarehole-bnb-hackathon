// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxVaultV2, IBoxVaultItemsV2, ItemLifecycleV2} from "../interfaces/IBoxVaultV2.sol";

/// @notice Vault-owned timestamps and append-only recovery history. Internal calls only; no funds move.
library ItemTimes {
    struct Times {
        uint64 lastExit;
        uint64 lastEntry;
    }

    struct State {
        ItemLifecycleV2[] operations;
        mapping(uint256 => Times) times;
        // 0 unused, 1 reserved, 2 closed forever. Identity cannot be reused after delivery/cancellation.
        mapping(bytes32 => uint8) tickets;
    }

    /// @notice The vault records one validated custody transition before its optional ledger notice.
    /// @dev Only the vault's authenticated adapter paths supply nonzero keys. The initial batch cap is one.
    function record(State storage s, bytes32 key, uint256 id, uint256 funding, uint8 kind, uint64 exitAt) internal {
        if (kind <= 3) {
            if (key == bytes32(0) || s.tickets[key] != (kind == 1 ? 0 : 1)) revert IBoxVaultV2.InvalidIdList();
            s.tickets[key] = kind == 1 ? 1 : 2;
        }
        // Block timestamps and adapter times use the existing 40-bit lifetime bound.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 at = uint64(block.timestamp);
        if (kind == 2 || kind == 4 || kind == 6) s.times[id].lastExit = kind == 2 ? exitAt : at;
        else if (kind == 5) s.times[id].lastEntry = at;
        s.operations.push(ItemLifecycleV2(key, id, funding, at, kind));
        emit IBoxVaultItemsV2.ItemLifecycleRecorded(s.operations.length, key, id, funding, at, kind);
    }

    /// @notice Anyone through the vault may read a committed sequence; zero and future sequences revert.
    function operation(State storage s, uint256 sequence) internal view returns (ItemLifecycleV2 memory) {
        if (sequence == 0 || sequence > s.operations.length) {
            revert IBoxVaultV2.InvalidQuantity(sequence, s.operations.length);
        }
        return s.operations[sequence - 1];
    }
}
