// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TransientReentrancyGuard} from "../libraries/TransientReentrancyGuard.sol";
import {BoxCloneBase} from "../box/BoxCloneBase.sol";
import {RoyaltyDestination} from "../box/interfaces/BoxTypes.sol";
import {IBoxCollection, IERC721TokenReceiver} from "../box/interfaces/IBoxCollection.sol";
import {BoxClones} from "../box/libraries/BoxClones.sol";
import {BoxEncoding} from "../box/libraries/BoxEncoding.sol";
import {BoxMetadataTable} from "../box/libraries/BoxMetadataTable.sol";
import {ChunkPart, IBoxCoordinatorV2} from "./interfaces/IBoxCoordinatorV2.sol";
import {BoxCollectionV2Args as A, IBoxCollectionTextsV2} from "./libraries/BoxCollectionV2Args.sol";

/// @title BoxCollectionV2 (core v2 M1, ticket M1-30-b; the implementation of every v2 box's collection clone)
/// @notice v1's ERC-721 collection (`BoxCollection.sol`, copied, never edited; ADR-0017 § 10) reading its metadata
/// table and its `tokenURI` texts from the chunks its coordinator loaded after creation (F96 R20C; ADR-0017 § 6), not
/// from a data contract and clone arguments written at creation. What changes:
/// - **The table** is the coordinator's `ChunkPart.Table`: the chunks' data contracts (0x00 ‖ bytes, as v1's table) in
///   order, each checked on arrival against the hash the factory kept from the spec (`IBoxCoordinatorV2`'s hash
///   rule). `metadataTableHash()` is that chunk root (h_0) and `metadataTable()` the first chunk's data contract. Its
///   format is the spec's, checked by `validate()` at `createBox` (`box-spec-v2-draft.md` field 21), so `initialize`
///   reads no table: the chunks may arrive after it.
/// - **The texts** `tokenURI` and `contractURI` read (the description, the hidden description and SVG, the external
///   link), and the placeholders' description the tickets' `tokenURI` reads (`placeholderDescription()`), are the
///   coordinator's `ChunkPart.Texts`, in `BoxCollectionV2Args.texts`' encoding [P until M1-10 names it; change
///   request 7].
///   A link that would break `contractURI`'s JSON string is left out of it (v1 refused it at `initialize`; the link now
///   arrives later).
/// - **A part not yet complete** is refused by the views that read it (`PartNotLoaded`); the box does not open before
///   every part is in (the gate, `IBoxCoordinatorV2`).
/// - **No transfer observer**: add-on 2 (the per-item stream) is box 0's and not in format 2 (`transferObserver()` is
///   address(0)); item payouts are M3's item ledger, which the vault calls.
/// - Every other clause is v1's (`BoxCollection.sol:16-54`): implicit ownership with ERC-2309 batches, commit-reveal at
///   depth ⌈log₂ N⌉, the hidden view, unenforced ERC-2981 through the royalty router, `owner()` and `contractURI()`,
///   refused sends, and only the box's coordinator clone initialises (BC-100).
/// @dev No mint, burn, admin, pause, upgrade, base URI or setter (F23 C2, F72 (2)). Written for Square Hole (MIT;
/// FullMath is the pinned Uniswap v4-core library, MIT).
contract BoxCollectionV2 is IBoxCollection, IBoxCollectionTextsV2, BoxCloneBase, TransientReentrancyGuard {
    /// @notice The coordinator's chunks of `part` are not all in (or do not add up to its length).
    error PartNotLoaded(ChunkPart part);

    // ------------------------------------------------------------------------------------------------ constants
    uint8 public constant REVEAL_ON_EXIT = 1;
    uint8 public constant REVEAL_ON_UNLOCK = 2;
    uint8 public constant REVEAL_ALWAYS = 4;
    /// @notice v1's observer cap, kept as the view's answer; no observer is ever called (see the notes).
    uint256 public constant OBSERVER_GAS = 460_000;
    /// @dev ERC-2309 batch bound (OpenZeppelin's indexer default; BC-009).
    uint256 private constant _CHUNK = 5_000;
    uint256 private constant _BPS = 10_000;
    uint8 private constant _UNLOCKED = 1;
    uint8 private constant _REVEALED = 2;

    /// @dev Three slots per revealed id: traits and flags packed in the first, then the two digests.
    struct Metadata {
        uint128 traitsPacked;
        uint8 flags;
        bytes32 imageHash;
        bytes32 modelHash;
    }

    /// @dev One slot: the reveal count and the initialisation mark (an uninitialised clone refuses every write).
    struct Status {
        uint128 revealedCount;
        bool initialised;
    }

    /// @inheritdoc IBoxCollection
    address public immutable coordinatorImplementation;

    Status private _status;
    /// @dev Zero = never moved = the vault. Once an id moves it always holds its owner, the vault included.
    mapping(uint256 id => address) private _owners;
    mapping(address owner => uint256) private _balances;
    mapping(uint256 id => address) private _tokenApprovals;
    mapping(address owner => mapping(address operator => bool)) private _operatorApprovals;
    mapping(uint256 id => Metadata) private _metadata;

    /// @param coordinatorImplementation_ the release's coordinator implementation: only its clones may initialise.
    constructor(address coordinatorImplementation_) {
        coordinatorImplementation = coordinatorImplementation_;
    }

    // ============================================================================================= initialise
    /// @inheritdoc IBoxCollection
    function initialize() external {
        if (msg.sender != coordinator() || !BoxClones.isCloneOf(msg.sender, coordinatorImplementation)) {
            revert NotCoordinator(msg.sender);
        }
        if (_status.initialised) revert AlreadyInitialised();
        _status.initialised = true;
        address v = vault();
        uint256 n = collectionSize();
        uint256 first = firstId();
        _balances[v] = n;
        for (uint256 from; from < n; from += _CHUNK) {
            uint256 to = from + _CHUNK > n ? n : from + _CHUNK;
            emit ConsecutiveTransfer(first + from, first + to - 1, address(0), v);
        }
        emit ContractURIUpdated();
        emit CollectionInitialized(
            v,
            token(),
            n,
            first,
            revealRoot(),
            revealTriggers(),
            revealUnlocker(),
            address(0),
            metadataTableHash(),
            generatorHash(),
            collectionCoverSha256()
        );
    }

    // ============================================================================================= ERC-165
    /// @inheritdoc IBoxCollection
    function supportsInterface(bytes4 interfaceId) external view returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == 0x80ac58cd // ERC-721
            || interfaceId == 0x5b5e139f // ERC-721 metadata
            || interfaceId == 0x49064906 // ERC-4906
            || (interfaceId == 0x2a55205a && royaltyDestination() != RoyaltyDestination.None); // ERC-2981, add-on 4
    }

    // ============================================================================================= marketplace views
    /// @inheritdoc IBoxCollection
    function owner() external view returns (address) {
        return _argAddress(A.MARKETPLACE_OWNER);
    }

    /// @inheritdoc IBoxCollection
    function contractURI() external view returns (string memory) {
        bytes memory texts = _part(ChunkPart.Texts);
        bytes32 banner = bannerSha256();
        bytes32 generator = generatorHash();
        string memory json = string.concat(
            '{"name":"',
            name(),
            '","symbol":"',
            symbol(),
            '","description":"',
            string(_textOf(texts, 2)),
            '","image":"ipfs://',
            BoxEncoding.rawCidV1(collectionCoverSha256())
        );
        if (banner != bytes32(0)) {
            json = string.concat(json, '","banner_image":"ipfs://', BoxEncoding.rawCidV1(banner));
        }
        bytes memory link = _textOf(texts, 5);
        if (link.length != 0 && _linkOk(link)) json = string.concat(json, '","external_link":"', string(link));
        if (generator != bytes32(0)) {
            json = string.concat(json, '","generator_hash":"', BoxEncoding.toHexString(generator));
        }
        return string.concat("data:application/json;base64,", BoxEncoding.base64(bytes(string.concat(json, '"}'))));
    }

    /// @inheritdoc IBoxCollection
    function royaltyInfo(uint256, uint256 salePrice) external view returns (address receiver_, uint256 amount) {
        RoyaltyDestination d = royaltyDestination();
        if (d == RoyaltyDestination.None) return (address(0), 0);
        amount = FullMath.mulDiv(salePrice, royaltyBps(), _BPS); // ≤ salePrice: never overflows
        receiver_ = _argAddress(A.ROYALTY_ROUTER);
        if (receiver_ == address(0)) amount = 0;
    }

    /// @inheritdoc IBoxCollection
    function royaltyBps() public view returns (uint16) {
        // casting to 'uint16' is safe because the argument is two bytes wide
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint16(_argUint(A.ROYALTY_BPS, 2));
    }

    /// @inheritdoc IBoxCollection
    function royaltyDestination() public view returns (RoyaltyDestination) {
        uint256 raw = _argUint(A.ROYALTY_DESTINATION, 1);
        // An unknown value reads as no add-on, so `royaltyInfo` never reverts on a bad enum (the factory refuses it).
        // casting to 'uint8' is safe because raw ≤ 3 here
        // forge-lint: disable-next-line(unsafe-typecast)
        return raw > uint8(RoyaltyDestination.PoolDepth) ? RoyaltyDestination.None : RoyaltyDestination(uint8(raw));
    }

    /// @inheritdoc IBoxCollection
    function royaltyRouter() public view returns (address) {
        if (royaltyDestination() == RoyaltyDestination.None) return address(0);
        return _argAddress(A.ROYALTY_ROUTER);
    }

    // ============================================================================================= ERC-721 views
    /// @inheritdoc IBoxCollection
    function name() public view returns (string memory) {
        return string(_argBytes(A.NAME_BYTES, _argUint(A.NAMES, 1)));
    }

    /// @inheritdoc IBoxCollection
    function symbol() public view returns (string memory) {
        return string(_argBytes(A.NAME_BYTES + _argUint(A.NAMES, 1), _argUint(A.NAMES + 1, 1)));
    }

    /// @inheritdoc IBoxCollection
    function totalSupply() external view returns (uint256) {
        return collectionSize();
    }

    /// @inheritdoc IBoxCollection
    function balanceOf(address holder) external view returns (uint256) {
        if (holder == address(0)) revert ERC721InvalidOwner(address(0));
        return _balances[holder];
    }

    /// @inheritdoc IBoxCollection
    function ownerOf(uint256 id) public view returns (address) {
        _requireExists(id);
        address stored = _owners[id];
        return stored == address(0) ? vault() : stored;
    }

    /// @inheritdoc IBoxCollection
    function getApproved(uint256 id) external view returns (address) {
        _requireExists(id);
        return _tokenApprovals[id];
    }

    /// @inheritdoc IBoxCollection
    function isApprovedForAll(address holder, address operator) external view returns (bool) {
        return _operatorApprovals[holder][operator];
    }

    // ============================================================================================= ERC-721 writes
    /// @inheritdoc IBoxCollection
    function approve(address to, uint256 id) external {
        _requireInitialised();
        address holder = ownerOf(id);
        if (msg.sender != holder && !_operatorApprovals[holder][msg.sender]) revert ERC721InvalidApprover(msg.sender);
        _tokenApprovals[id] = to;
        emit Approval(holder, to, id);
    }

    /// @inheritdoc IBoxCollection
    function setApprovalForAll(address operator, bool approved) external {
        _requireInitialised();
        if (operator == address(0)) revert ERC721InvalidOperator(address(0));
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    /// @inheritdoc IBoxCollection
    function transferFrom(address from, address to, uint256 id) external {
        _transfer(from, to, id);
    }

    /// @inheritdoc IBoxCollection
    function safeTransferFrom(address from, address to, uint256 id) external {
        _transfer(from, to, id);
        _checkReceiver(from, to, id, "");
    }

    /// @inheritdoc IBoxCollection
    function safeTransferFrom(address from, address to, uint256 id, bytes calldata data) external {
        _transfer(from, to, id);
        _checkReceiver(from, to, id, data);
    }

    // ============================================================================================= reveal
    /// @inheritdoc IBoxCollection
    function unlockReveal(uint256 id) external {
        if (msg.sender != revealUnlocker()) revert NotRevealUnlocker(msg.sender); // unlocker 0 => nobody
        _requireInitialised();
        _requireExists(id);
        Metadata storage m = _metadata[id];
        if (m.flags != 0) return; // already unlocked or revealed
        m.flags = _UNLOCKED;
        emit RevealUnlocked(id);
    }

    /// @inheritdoc IBoxCollection
    function reveal(
        uint256 id,
        uint128 traitsPacked,
        bytes32 imageHash,
        bytes32 avatarHash,
        bytes32 modelHash,
        bytes32 salt,
        bytes32[] calldata proof
    ) external {
        Status memory st = _status;
        if (!st.initialised) revert NotInitialised();
        _requireExists(id);
        Metadata storage m = _metadata[id];
        uint8 flags = m.flags;
        if (flags & _REVEALED != 0) revert AlreadyRevealed(id);
        if (!_revealable(id, flags)) revert NotRevealable(id);
        bytes32 leaf = leafOf(id, traitsPacked, imageHash, avatarHash, modelHash, salt);
        if (!_verify(id, leaf, proof)) revert InvalidProof(id);
        m.traitsPacked = traitsPacked;
        m.flags = flags | _REVEALED;
        m.imageHash = imageHash;
        m.modelHash = modelHash;
        unchecked {
            ++st.revealedCount; // at most N reveals
        }
        _status = st;
        emit Revealed(id, traitsPacked, imageHash, avatarHash, modelHash);
        emit MetadataUpdate(id);
    }

    /// @inheritdoc IBoxCollection
    function leafOf(
        uint256 id,
        uint128 traitsPacked,
        bytes32 imageHash,
        bytes32 avatarHash,
        bytes32 modelHash,
        bytes32 salt
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(id, traitsPacked, imageHash, avatarHash, modelHash, salt));
    }

    /// @inheritdoc IBoxCollection
    function isRevealed(uint256 id) external view returns (bool) {
        _requireExists(id);
        return _metadata[id].flags & _REVEALED != 0;
    }

    /// @inheritdoc IBoxCollection
    function isRevealable(uint256 id) external view returns (bool) {
        _requireExists(id);
        uint8 flags = _metadata[id].flags;
        return flags & _REVEALED == 0 && _revealable(id, flags);
    }

    /// @inheritdoc IBoxCollection
    function revealState(uint256 id)
        external
        view
        returns (bool hasLeftVault, bool unlocked, bool revealed, bool revealable)
    {
        _requireExists(id);
        uint8 flags = _metadata[id].flags;
        hasLeftVault = _owners[id] != address(0);
        unlocked = flags & _UNLOCKED != 0;
        revealed = flags & _REVEALED != 0;
        revealable = !revealed && _revealable(id, flags);
    }

    /// @inheritdoc IBoxCollection
    function traitsOf(uint256 id)
        external
        view
        returns (bool revealed, uint128 traitsPacked, bytes32 imageHash, bytes32 modelHash)
    {
        _requireExists(id);
        Metadata storage m = _metadata[id];
        return (m.flags & _REVEALED != 0, m.traitsPacked, m.imageHash, m.modelHash);
    }

    /// @inheritdoc IBoxCollection
    function revealedCount() external view returns (uint256) {
        return _status.revealedCount;
    }

    // ============================================================================================= metadata
    /// @inheritdoc IBoxCollection
    function tokenURI(uint256 id) external view returns (string memory) {
        return string.concat("data:application/json;base64,", BoxEncoding.base64(bytes(tokenJSON(id))));
    }

    /// @inheritdoc IBoxCollection
    function tokenJSON(uint256 id) public view returns (string memory) {
        _requireExists(id);
        Metadata storage m = _metadata[id];
        string memory title = string.concat(name(), " #", BoxEncoding.toString(id));
        if (m.flags & _REVEALED == 0) return _hiddenJSON(title);
        bytes memory table = _part(ChunkPart.Table);
        string memory links = string.concat('","image":"ipfs://', BoxEncoding.rawCidV1(m.imageHash));
        bytes32 model = m.modelHash;
        if (model != bytes32(0)) {
            links = string.concat(links, '","animation_url":"ipfs://', BoxEncoding.rawCidV1(model));
        }
        return string.concat(
            '{"name":"',
            title,
            '","description":"',
            string(BoxMetadataTable.description(table)),
            links,
            '","attributes":[',
            string(BoxMetadataTable.attributes(table, m.traitsPacked)),
            "]}"
        );
    }

    /// @dev Hidden art: the placeholders' description and SVG. Open art (no hidden SVG): the collection description
    /// and the cover (v1's, `BoxCollection.sol:424-438`). Every text from the `Texts` part, read once.
    function _hiddenJSON(string memory title) private view returns (string memory) {
        bytes memory texts = _part(ChunkPart.Texts);
        bytes memory svg = _textOf(texts, 4);
        string memory body = svg.length != 0
            ? string.concat(string(_textOf(texts, 3)), '","image":"data:image/svg+xml;base64,', BoxEncoding.base64(svg))
            : string.concat(
                string(_textOf(texts, 2)), '","image":"ipfs://', BoxEncoding.rawCidV1(collectionCoverSha256())
            );
        return string.concat(
            '{"name":"',
            title,
            '","description":"',
            body,
            '","attributes":[{"trait_type":"Status","value":"Not revealed"}]}'
        );
    }

    /// @inheritdoc IBoxCollection
    function imageCid(uint256 id) external view returns (string memory) {
        _requireExists(id);
        Metadata storage m = _metadata[id];
        if (m.flags & _REVEALED == 0) revert NotRevealed(id);
        return BoxEncoding.rawCidV1(m.imageHash);
    }

    /// @inheritdoc IBoxCollection
    function modelCid(uint256 id) external view returns (string memory) {
        _requireExists(id);
        Metadata storage m = _metadata[id];
        if (m.flags & _REVEALED == 0) revert NotRevealed(id);
        return BoxEncoding.rawCidV1(m.modelHash);
    }

    /// @inheritdoc IBoxCollection
    function metadataTableBytes() external view returns (bytes memory) {
        return _part(ChunkPart.Table);
    }

    // ============================================================================================= wiring and texts
    /// @inheritdoc IBoxCollection
    function coordinator() public view returns (address) {
        return _argAddress(A.COORDINATOR);
    }

    /// @inheritdoc IBoxCollection
    function vault() public view returns (address) {
        return _argAddress(A.VAULT);
    }

    /// @inheritdoc IBoxCollection
    function token() public view returns (address) {
        return _argAddress(A.TOKEN);
    }

    /// @inheritdoc IBoxCollection
    function receiver() public view returns (address) {
        return _argAddress(A.RECEIVER);
    }

    /// @inheritdoc IBoxCollection
    function revealUnlocker() public view returns (address) {
        return _argAddress(A.REVEAL_UNLOCKER);
    }

    /// @inheritdoc IBoxCollection
    /// @dev Always address(0): format 2 has no per-item stream (add-on 2).
    function transferObserver() external pure returns (address) {
        return address(0);
    }

    /// @inheritdoc IBoxCollection
    function observerGas() external pure returns (uint256) {
        return OBSERVER_GAS;
    }

    /// @inheritdoc IBoxCollection
    /// @dev The first chunk of the coordinator's `Table` part (address(0) before it arrives, or with no table).
    function metadataTable() external view returns (address) {
        IBoxCoordinatorV2 c = IBoxCoordinatorV2(coordinator());
        (, uint256 loaded,) = c.chunkState(ChunkPart.Table);
        return loaded == 0 ? address(0) : c.chunkPointer(ChunkPart.Table, 0);
    }

    /// @inheritdoc IBoxCollection
    /// @dev The chunk root the factory kept from the spec (h_0 of `IBoxCoordinatorV2`'s hash rule), which binds every
    /// chunk of the table.
    function metadataTableHash() public view returns (bytes32 root) {
        (root,) = IBoxCoordinatorV2(coordinator()).chunkRoot(ChunkPart.Table);
    }

    /// @inheritdoc IBoxCollection
    function collectionSize() public view returns (uint256) {
        return _argUint(A.COLLECTION_SIZE, 4);
    }

    /// @inheritdoc IBoxCollection
    function firstId() public view returns (uint256) {
        return uint256(_argWord(A.FIRST_ID));
    }

    /// @inheritdoc IBoxCollection
    function treeDepth() public view returns (uint256 depth) {
        uint256 n = collectionSize();
        while ((uint256(1) << depth) < n) ++depth;
    }

    /// @inheritdoc IBoxCollection
    function revealRoot() public view returns (bytes32) {
        return _argWord(A.REVEAL_ROOT);
    }

    /// @inheritdoc IBoxCollection
    function revealTriggers() public view returns (uint8) {
        // casting to 'uint8' is safe because the argument is one byte wide
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8(_argUint(A.REVEAL_TRIGGERS, 1));
    }

    /// @inheritdoc IBoxCollection
    function generatorHash() public view returns (bytes32) {
        return _argWord(A.GENERATOR_HASH);
    }

    /// @inheritdoc IBoxCollection
    function collectionCoverSha256() public view returns (bytes32) {
        return _argWord(A.COLLECTION_COVER_SHA256);
    }

    /// @inheritdoc IBoxCollection
    function bannerSha256() public view returns (bytes32) {
        return _argWord(A.BANNER_SHA256);
    }

    /// @inheritdoc IBoxCollection
    function description() external view returns (string memory) {
        return string(_textOf(_part(ChunkPart.Texts), 2));
    }

    /// @inheritdoc IBoxCollection
    function hiddenDescription() external view returns (string memory) {
        return string(_textOf(_part(ChunkPart.Texts), 3));
    }

    /// @inheritdoc IBoxCollection
    function hiddenSvg() external view returns (string memory) {
        return string(_textOf(_part(ChunkPart.Texts), 4));
    }

    /// @inheritdoc IBoxCollection
    function externalLink() external view returns (string memory) {
        return string(_textOf(_part(ChunkPart.Texts), 5));
    }

    /// @inheritdoc IBoxCollectionTextsV2
    function placeholderDescription() external view returns (string memory) {
        return string(_textOf(_part(ChunkPart.Texts), 6));
    }

    /// @inheritdoc IBoxCollectionTextsV2
    function placeholderTexts() external view returns (string memory description_, bytes memory hiddenSvg_) {
        bytes memory texts = _part(ChunkPart.Texts);
        return (string(_textOf(texts, 6)), _textOf(texts, 4));
    }

    // ============================================================================================= internals
    /// @dev The coordinator's chunks of `part`, joined: each chunk's data contract (0x00 ‖ bytes) in order, their sum
    /// the part's length. Empty for a part the box has none of; `PartNotLoaded` while it is incomplete.
    function _part(ChunkPart part) private view returns (bytes memory out) {
        IBoxCoordinatorV2 c = IBoxCoordinatorV2(coordinator());
        (bytes32 next,, uint256 total) = c.chunkState(part);
        if (next != bytes32(0)) revert PartNotLoaded(part);
        if (total == 0) return out;
        (, uint256 length) = c.chunkRoot(part);
        out = new bytes(length);
        uint256 at;
        for (uint256 i; i < total; ++i) {
            address pointer = c.chunkPointer(part, i);
            uint256 size = pointer.code.length;
            if (size == 0 || at + size - 1 > length) revert PartNotLoaded(part);
            unchecked {
                size -= 1;
            }
            assembly ("memory-safe") {
                extcodecopy(pointer, add(add(out, 0x20), at), 1, size)
            }
            at += size;
        }
        if (at != length) revert PartNotLoaded(part);
    }

    /// @dev Text `index` of the `Texts` part (2 description, 3 hidden description, 4 hidden SVG, 5 external link: the
    /// numbers of v1's `_text`; 6 the placeholders' description), empty when the part is.
    function _textOf(bytes memory texts, uint256 index) private pure returns (bytes memory out) {
        if (texts.length < A.TX_BYTES) return out;
        uint256 start = A.TX_BYTES;
        uint256 length;
        for (uint256 i = 2; i <= index; ++i) {
            start += length;
            if (i == 5) length = uint8(texts[A.TX_LINK]);
            else length = _u16(texts, i == 6 ? A.TX_PLACEHOLDER_DESCRIPTION : (i - 2) * 2);
        }
        if (start + length > texts.length) revert PartNotLoaded(ChunkPart.Texts);
        out = new bytes(length);
        assembly ("memory-safe") {
            mcopy(add(out, 0x20), add(add(texts, 0x20), start), length)
        }
    }

    function _u16(bytes memory b, uint256 at) private pure returns (uint256) {
        return (uint256(uint8(b[at])) << 8) | uint8(b[at + 1]);
    }

    /// @dev Whether `contractURI` may write the link unescaped: no '"', '\\', control byte below 0x20 or DEL (the bytes
    /// v1's `initialize` refused, `BoxCollection.sol:588-639`); UTF-8 passes.
    function _linkOk(bytes memory link) private pure returns (bool) {
        for (uint256 i; i < link.length; ++i) {
            bytes1 c = link[i];
            if (c < 0x20 || c == 0x7f || c == 0x22 || c == 0x5c) return false;
        }
        return true;
    }

    function _requireExists(uint256 id) private view {
        uint256 first = firstId();
        if (id < first || id - first >= collectionSize()) revert ERC721NonexistentToken(id);
    }

    function _requireInitialised() private view {
        if (!_status.initialised) revert NotInitialised();
    }

    function _revealable(uint256 id, uint8 flags) private view returns (bool) {
        uint8 triggers = revealTriggers();
        return triggers & REVEAL_ALWAYS != 0 || (triggers & REVEAL_ON_UNLOCK != 0 && flags & _UNLOCKED != 0)
            || (triggers & REVEAL_ON_EXIT != 0 && _owners[id] != address(0));
    }

    /// @dev Index-directed, fixed depth ⌈log₂ N⌉ (v1's, `BoxCollection.sol:656-680`).
    function _verify(uint256 id, bytes32 leaf, bytes32[] calldata proof) private view returns (bool) {
        uint256 depth = treeDepth();
        if (proof.length != depth) return false;
        uint256 index = id - firstId();
        bytes32 node = leaf;
        for (uint256 i; i < depth; ++i) {
            bytes32 sibling = proof[i];
            assembly ("memory-safe") {
                switch and(index, 1)
                case 0 {
                    mstore(0x00, node)
                    mstore(0x20, sibling)
                }
                default {
                    mstore(0x00, sibling)
                    mstore(0x20, node)
                }
                node := keccak256(0x00, 0x40)
            }
            index >>= 1;
        }
        return node == revealRoot();
    }

    /// @dev Checks, then state, under the lock (v1's `_transfer` without the observer). The receiver hook of
    /// safeTransferFrom runs after the lock is released, so a receiver may move the item on.
    function _transfer(address from, address to, uint256 id) private nonReentrant {
        if (to == address(0)) revert ERC721InvalidReceiver(address(0));
        address v = vault();
        if (to == address(this) || to == token()) revert DirectSendRefused(to);
        if (to == v && (msg.sender != v || from == v)) revert DirectSendRefused(to);
        address holder = ownerOf(id);
        if (holder != from) revert ERC721IncorrectOwner(from, id, holder);
        address approved = _tokenApprovals[id];
        if (msg.sender != from && msg.sender != approved && !_operatorApprovals[from][msg.sender]) {
            revert ERC721InsufficientApproval(msg.sender, id);
        }
        // `from` owns `id`, so its balance is at least 1 in an initialised collection; only a clone nobody initialised
        // reads 0 here (every id is its vault's by implicit ownership).
        uint256 fromBalance = _balances[from];
        if (fromBalance == 0) revert NotInitialised();
        delete _tokenApprovals[id];
        unchecked {
            // fromBalance ≥ 1; no balance can exceed N.
            _balances[from] = fromBalance - 1;
            ++_balances[to];
        }
        _owners[id] = to;
        emit Transfer(from, to, id);
    }

    function _checkReceiver(address from, address to, uint256 id, bytes memory data) private {
        if (to.code.length == 0) return;
        try IERC721TokenReceiver(to).onERC721Received(msg.sender, from, id, data) returns (bytes4 selector) {
            if (selector != IERC721TokenReceiver.onERC721Received.selector) revert ERC721InvalidReceiver(to);
        } catch (bytes memory reason) {
            if (reason.length == 0) revert ERC721InvalidReceiver(to);
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
    }
}
