// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title BoxVaultV2Args (the vault copy's clone arguments; ticket M1-30-b, file map § 1 rule 9)
/// @notice The layout `BoxVaultV2` reads from its clone's code (`abi.encodePacked`, 138 bytes, from byte 45 of the
/// clone, `BoxClones.ARGS_OFFSET`). v1's `BoxCloneArgs.VaultArgs` (`BoxCloneArgs.sol:139-178`) with three changes:
/// the observer is role 16's item ledger (`IBoxVaultV2.itemLedger`); N is 4 bytes (the counts word holds 32-bit counts,
/// N ≤ 10,000); and only the pick fee is an argument (the spec's preset, field 31: 100, 500 or 2,500 bps), since draws
/// (1%) and returns (5%) are fixed for every v2 box (BC-235), so they are constants of the vault. M1-32-a's planner
/// encodes it with `encode`; the vault reads it at these offsets.
library BoxVaultV2Args {
    /// @dev address: the box's coordinator (only it initialises, BC-100).
    /// @dev Encoders/readers use COORDINATOR as data; no funds move.
    uint256 internal constant COORDINATOR = 0;
    /// @dev address: T.
    /// @dev Encoders/readers use TOKEN as data; no funds move.
    uint256 internal constant TOKEN = 20;
    /// @dev address: the collection.
    /// @dev Encoders/readers use COLLECTION as data; no funds move.
    uint256 internal constant COLLECTION = 40;
    /// @dev address: the tickets add-on, or address(0) (open art: no item hidden, no draw).
    /// @dev Encoders/readers use TICKET_ADAPTER as data; no funds move.
    uint256 internal constant TICKET_ADAPTER = 60;
    /// @dev address: registry role 16, the item ledger (M3), or address(0) (every M1 box).
    /// @dev Encoders/readers use ITEM_LEDGER as data; no funds move.
    uint256 internal constant ITEM_LEDGER = 80;
    /// @dev uint32: N.
    /// @dev Encoders/readers use COLLECTION_SIZE as data; no funds move.
    uint256 internal constant COLLECTION_SIZE = 100;
    /// @dev uint16: the named pick's fee, the spec's preset.
    /// @dev Encoders/readers use PICK_FEE_BPS as data; no funds move.
    uint256 internal constant PICK_FEE_BPS = 104;
    /// @dev uint256: the first id.
    /// @dev Encoders/readers use FIRST_ID as data; no funds move.
    uint256 internal constant FIRST_ID = 106;
    /// @dev Encoders/readers use LENGTH as data; no funds move.
    uint256 internal constant LENGTH = 138;

    struct Args {
        /// @dev Encoders/readers use coordinator as data; no funds move.
        address coordinator;
        /// @dev Encoders/readers use token as data; no funds move.
        address token;
        /// @dev Encoders/readers use collection as data; no funds move.
        address collection;
        /// @dev Encoders/readers use ticketAdapter as data; no funds move.
        address ticketAdapter;
        /// @dev Encoders/readers use itemLedger as data; no funds move.
        address itemLedger;
        /// @dev Encoders/readers use collectionSize as data; no funds move.
        uint32 collectionSize;
        /// @dev Encoders/readers use pickFeeBps as data; no funds move.
        uint16 pickFeeBps;
        /// @dev Encoders/readers use firstId as data; no funds move.
        uint256 firstId;
    }

    /// @dev Internal callers may read encode; no funds move.
    function encode(Args memory a) internal pure returns (bytes memory) {
        return abi.encodePacked(
            a.coordinator,
            a.token,
            a.collection,
            a.ticketAdapter,
            a.itemLedger,
            a.collectionSize,
            a.pickFeeBps,
            a.firstId
        );
    }
}
