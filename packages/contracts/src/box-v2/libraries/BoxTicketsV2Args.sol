// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title BoxTicketsV2Args (the tickets copy's clone arguments; ticket M1-30-b, file map § 1 rule 9)
/// @notice The layout `BoxTicketsV2` reads from its clone's code (`abi.encodePacked`, from byte 45 of the clone).
/// v1's `BoxCloneArgs.TicketsArgs` (`BoxCloneArgs.sol:180-238`) without the spec's `openAt`: the tickets take their
/// open from the coordinator (`IBoxOpenGateV2`; ADR-0017 § 6), never from the spec (`BoxTickets.sol:112-115`). And
/// without the placeholders' description, which loads after creation in the collection's `Texts` part (ADR-0017 § 6,
/// means 1: the placeholders' texts load with the table); the name and the symbol stay (names stay on chain).
library BoxTicketsV2Args {
    /// @notice The encoder received text exceeding its packed field ; refusal reverts all money movement.
    error TextTooLong(uint256 length, uint256 max);

    /// @dev Encoders/readers use COORDINATOR as data; no funds move.
    uint256 internal constant COORDINATOR = 0;
    /// @dev Encoders/readers use VAULT as data; no funds move.
    uint256 internal constant VAULT = 20;
    /// @dev Encoders/readers use COLLECTION as data; no funds move.
    uint256 internal constant COLLECTION = 40;
    /// @dev Encoders/readers use TOKEN as data; no funds move.
    uint256 internal constant TOKEN = 60;
    /// @dev The chain's pinned drand source (IDrandSource; F61 R4).
    /// @dev Encoders/readers use SOURCE as data; no funds move.
    uint256 internal constant SOURCE = 80;
    /// @dev uint32
    /// @dev Encoders/readers use COLLECTION_SIZE as data; no funds move.
    uint256 internal constant COLLECTION_SIZE = 100;
    /// @dev Encoders/readers use FIRST_ID as data; no funds move.
    uint256 internal constant FIRST_ID = 104;
    /// @dev uint8 name length, uint8 symbol length; the two texts follow.
    /// @dev Encoders/readers use TEXTS as data; no funds move.
    uint256 internal constant TEXTS = 136;
    /// @dev Encoders/readers use TEXT_BYTES as data; no funds move.
    uint256 internal constant TEXT_BYTES = 138;

    struct Args {
        /// @dev Encoders/readers use coordinator as data; no funds move.
        address coordinator;
        /// @dev Encoders/readers use vault as data; no funds move.
        address vault;
        /// @dev Encoders/readers use collection as data; no funds move.
        address collection;
        /// @dev Encoders/readers use token as data; no funds move.
        address token;
        /// @dev Encoders/readers use source as data; no funds move.
        address source;
        /// @dev Encoders/readers use collectionSize as data; no funds move.
        uint32 collectionSize;
        /// @dev Encoders/readers use firstId as data; no funds move.
        uint256 firstId;
        /// The placeholders add-on's params 1 and 2: the placeholder's name and symbol (param 3, its description, is
        /// the collection's `Texts` part).
        /// @dev Encoders/readers use name as data; no funds move.
        string name;
        /// @dev Encoders/readers use symbol as data; no funds move.
        string symbol;
    }

    /// @dev Internal callers may read encode; no funds move.
    function encode(Args memory a) internal pure returns (bytes memory) {
        /// @dev Encoders/readers use n as data; no funds move.
        bytes memory n = bytes(a.name);
        /// @dev Encoders/readers use s as data; no funds move.
        bytes memory s = bytes(a.symbol);
        _bound(n.length, type(uint8).max);
        _bound(s.length, type(uint8).max);
        bytes memory head =
            abi.encodePacked(a.coordinator, a.vault, a.collection, a.token, a.source, a.collectionSize, a.firstId);
        // forge-lint: disable-start(unsafe-typecast, encode-packed-collision)
        // casting is safe because each length was bounded above; the texts cannot collide because their lengths come
        // first, and the result is clone code, never a hash key
        return bytes.concat(head, abi.encodePacked(uint8(n.length), uint8(s.length), n, s));
        // forge-lint: disable-end(unsafe-typecast, encode-packed-collision)
    }

    /// @dev Anyone may read _bound; no funds move.
    function _bound(uint256 length, uint256 max) private pure {
        if (length > max) revert TextTooLong(length, max);
    }
}
