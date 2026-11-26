// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title BoxCloneArgs
/// @notice The immutable-argument layouts of slice S3's clones (BoxCollection, BoxVault, BoxTickets, BoxRoyaltyRouter)
/// and their encoders: what the box's coordinator (S6, deployed by the factory S7) appends to each clone's runtime
/// (`BoxClones.initCode`). Every field is packed big-endian at the fixed offset named below; the implementations read
/// them with the same offsets (`BoxCloneBase`), and `test/box/items` round-trips every field. Strings of the collection
/// and the tickets add-on follow their fixed part: a header of lengths, then the bytes.
///
/// Settings that were constructor arguments or code constants in v2 (MisfitsCollection.sol:91-171, MisfitsVault.sol:
/// 237-285, MisfitsPlaceholders.sol:188-232, PublicNames.sol) are arguments here, so one reviewed implementation serves
/// every box (F53, F61 A1). The factory builds them from a validated BoxSpec (`BoxSpecV1.validate`); an implementation
/// re-checks at `initialize` only what its own invariants need (the collection its table, the vault its custody).
/// @dev Written for Square Hole (MIT).
library BoxCloneArgs {
    error TextTooLong(uint256 length, uint256 max);

    // ------------------------------------------------------------------------------------------------ collection
    uint256 internal constant C_COORDINATOR = 0;
    uint256 internal constant C_VAULT = 20;
    uint256 internal constant C_TOKEN = 40;
    uint256 internal constant C_RECEIVER = 60;
    uint256 internal constant C_REVEAL_UNLOCKER = 80;
    uint256 internal constant C_TRANSFER_OBSERVER = 100;
    uint256 internal constant C_ROYALTY_ROUTER = 120;
    uint256 internal constant C_MARKETPLACE_OWNER = 140;
    uint256 internal constant C_METADATA_TABLE = 160;
    /// @dev uint32
    uint256 internal constant C_COLLECTION_SIZE = 180;
    /// @dev uint8: REVEAL_ON_EXIT 1 | REVEAL_ON_UNLOCK 2 | REVEAL_ALWAYS 4
    uint256 internal constant C_REVEAL_TRIGGERS = 184;
    /// @dev uint16
    uint256 internal constant C_ROYALTY_BPS = 185;
    /// @dev uint8 (RoyaltyDestination)
    uint256 internal constant C_ROYALTY_DESTINATION = 187;
    uint256 internal constant C_FIRST_ID = 188;
    uint256 internal constant C_REVEAL_ROOT = 220;
    uint256 internal constant C_METADATA_TABLE_HASH = 252;
    uint256 internal constant C_GENERATOR_HASH = 284;
    /// @dev The collection cover (BoxSpecV1 field 28, collectionCoverSha256; F74 U3): contractURI's image.
    uint256 internal constant C_COLLECTION_COVER_SHA256 = 316;
    uint256 internal constant C_BANNER_SHA256 = 348;
    /// @dev Text header: uint8 name length, uint8 symbol length, uint16 description, hidden description and hidden SVG
    /// lengths, uint8 external link length; the six texts follow in that order.
    uint256 internal constant C_TEXTS = 380;
    uint256 internal constant C_TEXT_BYTES = 389;

    struct CollectionArgs {
        address coordinator;
        address vault;
        address token;
        /// The box's receiver: the Creator royalty destination pays its current creator payee (F72 (3)).
        address receiver;
        /// The tickets add-on when the triggers include REVEAL_ON_UNLOCK, else zero.
        address revealUnlocker;
        /// The per-item stream (add-on 2), or zero.
        address transferObserver;
        /// The royalty router (FeeHandling, PoolDepth), or zero (Creator, or no royalties add-on).
        address royaltyRouter;
        /// The spec's marketplaceOwner (box 0: the platform Safe), returned by `owner()` only.
        address marketplaceOwner;
        /// The data contract 0x00 ‖ table (`BoxData.write`).
        address metadataTable;
        uint32 collectionSize;
        uint8 revealTriggers;
        uint16 royaltyBps;
        uint8 royaltyDestination;
        uint256 firstId;
        bytes32 revealRoot;
        bytes32 metadataTableHash;
        bytes32 generatorHash;
        /// The collection cover: the spec's collectionCoverSha256 (field 28, F74 U3), not its logo (field 23).
        bytes32 collectionCoverSha256;
        /// Add-on 6's bannerSha256, or zero.
        bytes32 bannerSha256;
        string name;
        string symbol;
        string description;
        /// The placeholders add-on's hidden description and SVG (params 4, 5); empty without the add-on.
        string hiddenDescription;
        string hiddenSvg;
        /// Add-on 6's externalLink (contractURI's external_link; empty = none). Written into JSON unescaped: the
        /// factory's validate() admits only the URL rule's bytes, and the collection's initialize refuses '"', '\\',
        /// control bytes and DEL itself (`InvalidExternalLink`), with or without a factory.
        string externalLink;
    }

    function collection(CollectionArgs memory a) internal pure returns (bytes memory) {
        bytes memory head = abi.encodePacked(
            a.coordinator, a.vault, a.token, a.receiver, a.revealUnlocker, a.transferObserver, a.royaltyRouter
        );
        bytes memory mid = abi.encodePacked(
            a.marketplaceOwner,
            a.metadataTable,
            a.collectionSize,
            a.revealTriggers,
            a.royaltyBps,
            a.royaltyDestination,
            a.firstId,
            a.revealRoot,
            a.metadataTableHash
        );
        bytes memory tail = abi.encodePacked(a.generatorHash, a.collectionCoverSha256, a.bannerSha256);
        return bytes.concat(head, mid, tail, _collectionTexts(a));
    }

    function _collectionTexts(CollectionArgs memory a) private pure returns (bytes memory) {
        bytes memory n = bytes(a.name);
        bytes memory s = bytes(a.symbol);
        bytes memory d = bytes(a.description);
        bytes memory hd = bytes(a.hiddenDescription);
        bytes memory hs = bytes(a.hiddenSvg);
        bytes memory link = bytes(a.externalLink);
        _bound(n.length, type(uint8).max);
        _bound(s.length, type(uint8).max);
        _bound(d.length, type(uint16).max);
        _bound(hd.length, type(uint16).max);
        _bound(hs.length, type(uint16).max);
        _bound(link.length, type(uint8).max);
        return abi.encodePacked(
            // forge-lint: disable-next-line(unsafe-typecast)
            uint8(n.length), // each length bounded above
            // forge-lint: disable-next-line(unsafe-typecast)
            uint8(s.length),
            // forge-lint: disable-next-line(unsafe-typecast)
            uint16(d.length),
            // forge-lint: disable-next-line(unsafe-typecast)
            uint16(hd.length),
            // forge-lint: disable-next-line(unsafe-typecast)
            uint16(hs.length),
            // forge-lint: disable-next-line(unsafe-typecast)
            uint8(link.length),
            n,
            s,
            d,
            hd,
            hs,
            link
        );
    }

    // ------------------------------------------------------------------------------------------------ vault
    uint256 internal constant V_COORDINATOR = 0;
    uint256 internal constant V_TOKEN = 20;
    uint256 internal constant V_COLLECTION = 40;
    uint256 internal constant V_TICKET_ADAPTER = 60;
    uint256 internal constant V_OBSERVER = 80;
    /// @dev uint64 (the width of the packed counts)
    uint256 internal constant V_COLLECTION_SIZE = 100;
    /// @dev uint16 each
    uint256 internal constant V_DRAW_FEE_BPS = 108;
    uint256 internal constant V_PICK_FEE_BPS = 110;
    uint256 internal constant V_RETURN_FEE_BPS = 112;
    uint256 internal constant V_FIRST_ID = 114;
    uint256 internal constant V_LENGTH = 146;

    struct VaultArgs {
        address coordinator;
        address token;
        address collection;
        /// The tickets add-on, or zero (then no item is hidden).
        address ticketAdapter;
        /// The per-item stream (add-on 2), or zero.
        address observer;
        uint64 collectionSize;
        uint16 drawFeeBps;
        uint16 pickFeeBps;
        uint16 returnFeeBps;
        uint256 firstId;
    }

    function vault(VaultArgs memory a) internal pure returns (bytes memory) {
        return abi.encodePacked(
            a.coordinator,
            a.token,
            a.collection,
            a.ticketAdapter,
            a.observer,
            a.collectionSize,
            a.drawFeeBps,
            a.pickFeeBps,
            a.returnFeeBps,
            a.firstId
        );
    }

    // ------------------------------------------------------------------------------------------------ tickets
    uint256 internal constant T_COORDINATOR = 0;
    uint256 internal constant T_VAULT = 20;
    uint256 internal constant T_COLLECTION = 40;
    uint256 internal constant T_TOKEN = 60;
    uint256 internal constant T_SOURCE = 80;
    /// @dev uint32 (BoxSpecV1 openAt, Unix seconds; 0 = Now)
    uint256 internal constant T_OPEN_AT = 100;
    /// @dev uint32 (MisfitsPlaceholders.sol:219 caps N at 2^32 − 1)
    uint256 internal constant T_COLLECTION_SIZE = 104;
    uint256 internal constant T_FIRST_ID = 108;
    /// @dev Text header: uint8 name length, uint8 symbol length, uint16 description length; the texts follow.
    uint256 internal constant T_TEXTS = 140;
    uint256 internal constant T_TEXT_BYTES = 144;

    struct TicketsArgs {
        address coordinator;
        address vault;
        address collection;
        address token;
        /// The chain's pinned drand source (IDrandSource; F61 R4).
        address source;
        uint32 openAt;
        uint32 collectionSize;
        uint256 firstId;
        /// The placeholders add-on's params 1-3: the placeholder's name, symbol and description.
        string name;
        string symbol;
        string description;
    }

    function tickets(TicketsArgs memory a) internal pure returns (bytes memory) {
        bytes memory n = bytes(a.name);
        bytes memory s = bytes(a.symbol);
        bytes memory d = bytes(a.description);
        _bound(n.length, type(uint8).max);
        _bound(s.length, type(uint8).max);
        _bound(d.length, type(uint16).max);
        bytes memory head = abi.encodePacked(
            a.coordinator, a.vault, a.collection, a.token, a.source, a.openAt, a.collectionSize, a.firstId
        );
        return bytes.concat(
            head,
            abi.encodePacked(
                // forge-lint: disable-next-line(unsafe-typecast)
                uint8(n.length), // bounded above
                // forge-lint: disable-next-line(unsafe-typecast)
                uint8(s.length),
                // forge-lint: disable-next-line(unsafe-typecast)
                uint16(d.length),
                n,
                s,
                d
            )
        );
    }

    // ------------------------------------------------------------------------------------------------ royalty router
    /// @dev The router is a receiving clone (BoxClones.initCodeReceiving): its arguments start at byte 51.
    uint256 internal constant R_COORDINATOR = 0;
    uint256 internal constant R_RECEIVER = 20;
    uint256 internal constant R_WETH = 40;
    /// @dev uint8 (RoyaltyDestination: FeeHandling or PoolDepth)
    uint256 internal constant R_DESTINATION = 60;
    uint256 internal constant R_LENGTH = 61;

    struct RouterArgs {
        address coordinator;
        address receiver;
        address weth;
        uint8 destination;
    }

    function router(RouterArgs memory a) internal pure returns (bytes memory) {
        return abi.encodePacked(a.coordinator, a.receiver, a.weth, a.destination);
    }

    // ------------------------------------------------------------------------------------------------ item stream
    /// @dev Slice S8 (add-on 2, BoxItemStream). The curve's ticks name box 0's graduated positions (BoxLayoutV1:
    /// the ask [MIN, P1 tick], the bid [P1 tick, MAX], the sentinel [P0 tick, MAX]; the pair [MIN, MAX]).
    uint256 internal constant S_COORDINATOR = 0;
    uint256 internal constant S_TOKEN = 20;
    uint256 internal constant S_COLLECTION = 40;
    uint256 internal constant S_VAULT = 60;
    /// @dev The tickets add-on, or zero.
    uint256 internal constant S_TICKETS = 80;
    uint256 internal constant S_RECEIVER = 100;
    uint256 internal constant S_HOOK = 120;
    /// @dev int24 each: the curve's lower and upper tick (the hook's `curve()`).
    uint256 internal constant S_TICK_LOWER = 140;
    uint256 internal constant S_TICK_UPPER = 143;
    /// @dev uint32
    uint256 internal constant S_COLLECTION_SIZE = 146;
    uint256 internal constant S_FIRST_ID = 150;
    uint256 internal constant S_LENGTH = 182;

    struct StreamArgs {
        address coordinator;
        address token;
        address collection;
        address vault;
        /// The tickets add-on, or zero.
        address tickets;
        address receiver;
        address hook;
        int24 tickLower;
        int24 tickUpper;
        uint32 collectionSize;
        uint256 firstId;
    }

    function stream(StreamArgs memory a) internal pure returns (bytes memory) {
        return abi.encodePacked(
            a.coordinator,
            a.token,
            a.collection,
            a.vault,
            a.tickets,
            a.receiver,
            a.hook,
            a.tickLower,
            a.tickUpper,
            a.collectionSize,
            a.firstId
        );
    }

    function _bound(uint256 length, uint256 max) private pure {
        if (length > max) revert TextTooLong(length, max);
    }
}
