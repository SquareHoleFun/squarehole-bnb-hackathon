// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The collection copy's views of the placeholders' texts, which the tickets copy's `tokenURI` reads (the
/// `Texts` part's last text and the hidden SVG; ticket M1-30-b, review round 1, M3). In no frozen interface (change
/// request 7).
interface IBoxCollectionTextsV2 {
    /// @notice The placeholders add-on's description (its param 3), from the `Texts` chunks (`PartNotLoaded` while the
    /// part is incomplete; empty with no such part).
    /// @dev Anyone may read placeholderDescription; no funds move.
    function placeholderDescription() external view returns (string memory);
    /// @notice The two texts a placeholder's `tokenURI` reads, from one read of the `Texts` chunks: the placeholders'
    /// description and the hidden SVG's bytes.
    /// @dev Anyone may read placeholderTexts; no funds move.
    function placeholderTexts() external view returns (string memory description, bytes memory hiddenSvg);
}

/// @title BoxCollectionV2Args (the collection copy's clone arguments and its `Texts` chunk part; ticket M1-30-b, file
/// map § 1 rule 9)
/// @notice The layout `BoxCollectionV2` reads from its clone's code (`abi.encodePacked`, from byte 45 of the clone).
/// v1's `BoxCloneArgs.CollectionArgs` (`BoxCloneArgs.sol:17-133`) less what loads after creation in chunks (F96 R20C;
/// ADR-0017 § 6): the metadata table's data contract and hash (the table is the coordinator's `ChunkPart.Table`, its
/// hash the chunk root), and the texts `tokenURI` and `contractURI` read (`ChunkPart.Texts`, in the encoding `texts`
/// gives). Also gone: the transfer observer (add-on 2, the per-item stream, is box 0's only and not in format 2). N is 4
/// bytes, as v1's. The names stay arguments (ADR-0017 § 6: names and symbols stay on chain).
library BoxCollectionV2Args {
    /// @notice The encoder received text exceeding its packed field ; refusal reverts all money movement.
    error TextTooLong(uint256 length, uint256 max);

    /// @dev Encoders/readers use COORDINATOR as data; no funds move.
    uint256 internal constant COORDINATOR = 0;
    /// @dev Encoders/readers use VAULT as data; no funds move.
    uint256 internal constant VAULT = 20;
    /// @dev Encoders/readers use TOKEN as data; no funds move.
    uint256 internal constant TOKEN = 40;
    /// @dev Encoders/readers use RECEIVER as data; no funds move.
    uint256 internal constant RECEIVER = 60;
    /// @dev The tickets add-on when the triggers include REVEAL_ON_UNLOCK, else address(0).
    /// @dev Encoders/readers use REVEAL_UNLOCKER as data; no funds move.
    uint256 internal constant REVEAL_UNLOCKER = 80;
    /// @dev The royalty router (add-on 4), or address(0).
    /// @dev Encoders/readers use ROYALTY_ROUTER as data; no funds move.
    uint256 internal constant ROYALTY_ROUTER = 100;
    /// @dev The spec's marketplaceOwner, read by `owner()` only.
    /// @dev Encoders/readers use MARKETPLACE_OWNER as data; no funds move.
    uint256 internal constant MARKETPLACE_OWNER = 120;
    /// @dev uint32
    /// @dev Encoders/readers use COLLECTION_SIZE as data; no funds move.
    uint256 internal constant COLLECTION_SIZE = 140;
    /// @dev uint8: REVEAL_ON_EXIT 1 | REVEAL_ON_UNLOCK 2 | REVEAL_ALWAYS 4
    /// @dev Encoders/readers use REVEAL_TRIGGERS as data; no funds move.
    uint256 internal constant REVEAL_TRIGGERS = 144;
    /// @dev uint16
    /// @dev Encoders/readers use ROYALTY_BPS as data; no funds move.
    uint256 internal constant ROYALTY_BPS = 145;
    /// @dev uint8 (RoyaltyDestination)
    /// @dev Encoders/readers use ROYALTY_DESTINATION as data; no funds move.
    uint256 internal constant ROYALTY_DESTINATION = 147;
    /// @dev Encoders/readers use FIRST_ID as data; no funds move.
    uint256 internal constant FIRST_ID = 148;
    /// @dev Encoders/readers use REVEAL_ROOT as data; no funds move.
    uint256 internal constant REVEAL_ROOT = 180;
    /// @dev Encoders/readers use GENERATOR_HASH as data; no funds move.
    uint256 internal constant GENERATOR_HASH = 212;
    /// @dev Encoders/readers use COLLECTION_COVER_SHA256 as data; no funds move.
    uint256 internal constant COLLECTION_COVER_SHA256 = 244;
    /// @dev Encoders/readers use BANNER_SHA256 as data; no funds move.
    uint256 internal constant BANNER_SHA256 = 276;
    /// @dev uint8 name length, uint8 symbol length; the two texts follow.
    /// @dev Encoders/readers use NAMES as data; no funds move.
    uint256 internal constant NAMES = 308;
    /// @dev Encoders/readers use NAME_BYTES as data; no funds move.
    uint256 internal constant NAME_BYTES = 310;

    // The `Texts` chunk part [P until M1-10's generated library names its encoding; change request 7]: a 9-byte header
    // (uint16 the collection description's length, uint16 the hidden description's, uint16 the hidden SVG's, uint8 the
    // external link's, uint16 the placeholders' description's), then the five texts in that order. Empty when all five
    // are empty (the box then has no such part). What reads them: `tokenURI` (an unrevealed item: the hidden
    // description and SVG, or with no hidden SVG the description), `contractURI` (the description and the link) and
    // the tickets' `tokenURI` (the placeholders' description and the hidden SVG). v1's numbers in `BoxCollectionV2`:
    // 2, 3, 4, 5, then 6 for the placeholders' description.
    /// @dev Encoders/readers use TX_DESCRIPTION as data; no funds move.
    uint256 internal constant TX_DESCRIPTION = 0;
    /// @dev Encoders/readers use TX_HIDDEN_DESCRIPTION as data; no funds move.
    uint256 internal constant TX_HIDDEN_DESCRIPTION = 2;
    /// @dev Encoders/readers use TX_HIDDEN_SVG as data; no funds move.
    uint256 internal constant TX_HIDDEN_SVG = 4;
    /// @dev Encoders/readers use TX_LINK as data; no funds move.
    uint256 internal constant TX_LINK = 6;
    /// @dev Encoders/readers use TX_PLACEHOLDER_DESCRIPTION as data; no funds move.
    uint256 internal constant TX_PLACEHOLDER_DESCRIPTION = 7;
    /// @dev Encoders/readers use TX_BYTES as data; no funds move.
    uint256 internal constant TX_BYTES = 9;

    struct Args {
        /// @dev Encoders/readers use coordinator as data; no funds move.
        address coordinator;
        /// @dev Encoders/readers use vault as data; no funds move.
        address vault;
        /// @dev Encoders/readers use token as data; no funds move.
        address token;
        /// @dev Encoders/readers use receiver as data; no funds move.
        address receiver;
        /// @dev Encoders/readers use revealUnlocker as data; no funds move.
        address revealUnlocker;
        /// @dev Encoders/readers use royaltyRouter as data; no funds move.
        address royaltyRouter;
        /// @dev Encoders/readers use marketplaceOwner as data; no funds move.
        address marketplaceOwner;
        /// @dev Encoders/readers use collectionSize as data; no funds move.
        uint32 collectionSize;
        /// @dev Encoders/readers use revealTriggers as data; no funds move.
        uint8 revealTriggers;
        /// @dev Encoders/readers use royaltyBps as data; no funds move.
        uint16 royaltyBps;
        /// @dev Encoders/readers use royaltyDestination as data; no funds move.
        uint8 royaltyDestination;
        /// @dev Encoders/readers use firstId as data; no funds move.
        uint256 firstId;
        /// @dev Encoders/readers use revealRoot as data; no funds move.
        bytes32 revealRoot;
        /// @dev Encoders/readers use generatorHash as data; no funds move.
        bytes32 generatorHash;
        /// @dev Encoders/readers use collectionCoverSha256 as data; no funds move.
        bytes32 collectionCoverSha256;
        /// @dev Encoders/readers use bannerSha256 as data; no funds move.
        bytes32 bannerSha256;
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
        bytes memory head = abi.encodePacked(
            a.coordinator, a.vault, a.token, a.receiver, a.revealUnlocker, a.royaltyRouter, a.marketplaceOwner
        );
        bytes memory mid = abi.encodePacked(
            a.collectionSize,
            a.revealTriggers,
            a.royaltyBps,
            a.royaltyDestination,
            a.firstId,
            a.revealRoot,
            a.generatorHash,
            a.collectionCoverSha256,
            a.bannerSha256
        );
        // casting to 'uint8' is safe because both lengths were bounded above; the texts cannot collide because their
        // lengths come first, and the result is clone code, never a hash key
        // forge-lint: disable-next-line(unsafe-typecast, encode-packed-collision)
        return bytes.concat(head, mid, abi.encodePacked(uint8(n.length), uint8(s.length), n, s));
    }

    /// @notice The `Texts` chunk part (see the layout above); empty when every text is.
    /// @dev Internal callers may read texts; no funds move.
    function texts(
        string memory description,
        string memory hiddenDescription,
        string memory hiddenSvg,
        string memory externalLink,
        string memory placeholderDescription
    ) internal pure returns (bytes memory) {
        /// @dev Encoders/readers use d as data; no funds move.
        bytes memory d = bytes(description);
        /// @dev Encoders/readers use hd as data; no funds move.
        bytes memory hd = bytes(hiddenDescription);
        /// @dev Encoders/readers use hs as data; no funds move.
        bytes memory hs = bytes(hiddenSvg);
        /// @dev Encoders/readers use link as data; no funds move.
        bytes memory link = bytes(externalLink);
        /// @dev Encoders/readers use pd as data; no funds move.
        bytes memory pd = bytes(placeholderDescription);
        if (d.length + hd.length + hs.length + link.length + pd.length == 0) return "";
        _bound(d.length, type(uint16).max);
        _bound(hd.length, type(uint16).max);
        _bound(hs.length, type(uint16).max);
        _bound(link.length, type(uint8).max);
        _bound(pd.length, type(uint16).max);
        // forge-lint: disable-start(unsafe-typecast, encode-packed-collision)
        // casting is safe because each length was bounded above; the texts cannot collide because their lengths come
        // first, and the part is chunk data, never a hash key
        bytes memory head = abi.encodePacked(
            uint16(d.length), uint16(hd.length), uint16(hs.length), uint8(link.length), uint16(pd.length)
        );
        return bytes.concat(head, d, hd, hs, link, pd);
        // forge-lint: disable-end(unsafe-typecast, encode-packed-collision)
    }

    /// @dev Anyone may read _bound; no funds move.
    function _bound(uint256 length, uint256 max) private pure {
        if (length > max) revert TextTooLong(length, max);
    }
}
