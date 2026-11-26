// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TransientReentrancyGuard} from "../libraries/TransientReentrancyGuard.sol";
import {BoxCloneBase} from "./BoxCloneBase.sol";
import {RoyaltyDestination} from "./interfaces/BoxTypes.sol";
import {IBoxCollection, IERC721TokenReceiver} from "./interfaces/IBoxCollection.sol";
import {IBoxTransferObserver} from "./interfaces/IBoxItemStream.sol";
import {BoxCloneArgs as A} from "./libraries/BoxCloneArgs.sol";
import {BoxClones} from "./libraries/BoxClones.sol";
import {BoxData} from "./libraries/BoxData.sol";
import {BoxEncoding} from "./libraries/BoxEncoding.sol";
import {BoxMetadataTable} from "./libraries/BoxMetadataTable.sol";

/// @title BoxCollection (slice S3; the implementation of every box's collection clone, F61 A1)
/// @notice A box's ERC-721 collection: N ids from `firstId`, all the vault's from `initialize` on, without N writes or
/// N events (implicit ownership; one ERC-2309 `ConsecutiveTransfer` per at most 5,000 ids, BC-009). A copy of
/// MisfitsCollection (src/v2/MisfitsCollection.sol:87-712 at 46a030f6) with N, names, texts, cover, banner, hidden art,
/// royalties and observers as clone arguments (`BoxCloneArgs.CollectionArgs`; V `:91-122` are constants today).
/// No mint, burn, admin, pause, upgrade, base URI or setter (F23 C2, F72 (2)); every argument is fixed in the clone's
/// code for good.
///
/// - **Commit-reveal** as MisfitsCollection (`:42-55`), at depth ⌈log₂ N⌉ (`treeDepth`) over positions id − firstId:
///   leaf = keccak256(abi.encode(id, traitsPacked, imageSha256, avatarSha256, modelSha256, salt)); node =
///   keccak256(left ‖ right) by the bits of the position. Permissionless, once per id, after its trigger:
///   REVEAL_ON_EXIT (1: the id has left the vault), REVEAL_ON_UNLOCK (2: `revealUnlocker` unlocked it), REVEAL_ALWAYS
///   (4: open art, whose reveal list is public from creation; core-v1-interfaces § 5 decision 9).
/// - **Metadata table** (format v1, `BoxMetadataTable`) in a data contract the coordinator wrote; `initialize` checks
///   its STOP prefix, its keccak256 against the argument and its format, so `tokenJSON` never meets a malformed table.
/// - **Hidden view**: an unrevealed id shows the placeholders add-on's hidden description and SVG, or, without the
///   add-on (open art), the collection description and the cover.
/// - **Royalties** (add-on 4; F65, F68 (4), F72 (3)): unenforced ERC-2981, no 721C, no operator filter. With the add-on
///   `royaltyInfo(id, price)` = (the box's royalty router, ⌊price × bps / 10,000⌋) for every id and price and every
///   destination, never reverting (FullMath). The router never refuses a payment and flushes to the receiver:
///   `fundFees()`, `fundDepth()`, or `fundCreator()` for Creator, credited to the one creator payee (F72 (3)), so a
///   payee that refuses ETH cannot make royalty-paying sales revert (review of sh-core-v1; the payee was named directly
///   before).
/// - **Only the box's coordinator initialises**, and it must be a clone of the version's coordinator implementation
///   (`coordinatorImplementation`): a stranger's clone of this code stays inert (BC-100; review of sh-core-v1).
/// - **Marketplace views**: `owner()` = the spec's marketplaceOwner, read by no function (F26 (4)); `contractURI()`
///   (ERC-7572, F71): fixed JSON with name, symbol, description, the collection cover as `image` (ipfs:// + the raw CID
///   of its sha256, BC-054; BoxSpec field 28 since F74 U3, `collectionCoverSha256()`; the logo is field 23 and not on
///   chain), the banner and the `external_link` when set (add-on 6; `initialize` refuses a link holding '"', '\\', a
///   control byte or DEL, `InvalidExternalLink`), and `generator_hash` when set.
/// - **Refused sends** (F24 (d), F25 (3); BC-042, BC-044): a transfer to the vault reverts unless the vault is the
///   caller pulling a return from someone else; transfers to this contract and to T always revert. `transferFrom`
///   checks no receiver: an item sent with it to a contract that cannot move it, box 0's own contracts other than the
///   vault included, has no exit; at the stream its share is never paid or burned, at another box contract anyone may
///   claim it into that contract (an accepted no-exit class: box 0's own review W3-U7-1, R66-LOST, F147).
/// - **Transfer observer** (add-on 2): called after the checks and before any state change, capped at `OBSERVER_GAS`,
///   fail-safe (`TransferObserverFailed`), the transfer reverting `ObserverGasTooLow` only when sent with too little
///   gas to give the observer its whole cap (EIP-150). The cap is 460,000 (F90 R16H; S3's 250,000 before F87): 2.04x
///   the stream's worst path from cold after Glamsterdam (225,168, SH-box0-f126); a transfer needs 477,301 left.
/// @dev Invariants: Σ balances == N; every id has exactly one owner; an id is revealed at most once and only with a
/// valid proof against `revealRoot()`; `royaltyInfo` never reverts. Written for Square Hole (MIT; FullMath is the
/// pinned Uniswap v4-core library, MIT).
contract BoxCollection is IBoxCollection, BoxCloneBase, TransientReentrancyGuard {
    // ------------------------------------------------------------------------------------------------ constants
    uint8 public constant REVEAL_ON_EXIT = 1;
    uint8 public constant REVEAL_ON_UNLOCK = 2;
    uint8 public constant REVEAL_ALWAYS = 4;
    /// @notice The observer's gas cap (F90 R16H: 2.04x the worst stream path from cold after Glamsterdam; 250,000
    /// before F87, and v2's 100,000, MisfitsCollection.sol:103, which every checkpoint writing a new slot exceeds).
    uint256 public constant OBSERVER_GAS = 460_000;
    /// @dev gasleft() needed right before the observer call so it receives all of OBSERVER_GAS (EIP-150 keeps 1/64),
    /// plus the call's own cost with a margin (10,000 as the coordinator's pokes; about 3,050-3,450 from cold).
    uint256 private constant _OBSERVER_GAS_REQUIRED = OBSERVER_GAS + OBSERVER_GAS / 63 + 10_000;
    /// @dev ERC-2309 batch bound (OpenZeppelin's indexer default; BC-009).
    uint256 private constant _CHUNK = 5_000;
    uint256 private constant _BPS = 10_000;
    uint8 private constant _UNLOCKED = 1;
    uint8 private constant _REVEALED = 2;

    /// @dev Three slots per revealed id: traits and flags packed in the first, then the two digests (`:157-162`).
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

    // ------------------------------------------------------------------------------------------------ immutables
    /// @inheritdoc IBoxCollection
    address public immutable coordinatorImplementation;

    // ------------------------------------------------------------------------------------------------ state
    Status private _status;
    /// @dev Zero = never moved = the vault. Once an id moves it always holds its owner, the vault included, which also
    /// records that it has left the vault (the exit trigger survives a return).
    mapping(uint256 id => address) private _owners;
    mapping(address owner => uint256) private _balances;
    mapping(uint256 id => address) private _tokenApprovals;
    mapping(address owner => mapping(address operator => bool)) private _operatorApprovals;
    mapping(uint256 id => Metadata) private _metadata;

    /// @param coordinatorImplementation_ the version's BoxCoordinator implementation: only its clones may initialise.
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
        address table = metadataTable();
        bytes32 tableHash = metadataTableHash();
        if (table.code.length == 0 || _firstCodeByte(table) != 0) revert InvalidMetadataTable(type(uint256).max);
        bytes memory t = BoxData.read(table);
        if (keccak256(t) != tableHash) revert InvalidMetadataTable(type(uint256).max);
        BoxMetadataTable.validate(t);
        _checkExternalLink();
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
        _emitInitialized(v, n, first, tableHash);
    }

    function _emitInitialized(address v, uint256 n, uint256 first, bytes32 tableHash) private {
        emit CollectionInitialized(
            v,
            token(),
            n,
            first,
            revealRoot(),
            revealTriggers(),
            revealUnlocker(),
            transferObserver(),
            tableHash,
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
        return _argAddress(A.C_MARKETPLACE_OWNER);
    }

    /// @inheritdoc IBoxCollection
    function contractURI() external view returns (string memory) {
        bytes32 banner = bannerSha256();
        bytes32 generator = generatorHash();
        string memory json = string.concat(
            '{"name":"',
            name(),
            '","symbol":"',
            symbol(),
            '","description":"',
            description(),
            '","image":"ipfs://',
            BoxEncoding.rawCidV1(collectionCoverSha256())
        );
        if (banner != bytes32(0)) {
            json = string.concat(json, '","banner_image":"ipfs://', BoxEncoding.rawCidV1(banner));
        }
        bytes memory link = _text(5);
        if (link.length != 0) json = string.concat(json, '","external_link":"', string(link));
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
        // Every destination through the router (never the payee itself); none built: no royalty asked.
        receiver_ = _argAddress(A.C_ROYALTY_ROUTER);
        if (receiver_ == address(0)) amount = 0;
    }

    /// @inheritdoc IBoxCollection
    function royaltyBps() public view returns (uint16) {
        // casting to 'uint16' is safe because the argument is two bytes wide
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint16(_argUint(A.C_ROYALTY_BPS, 2));
    }

    /// @inheritdoc IBoxCollection
    function royaltyDestination() public view returns (RoyaltyDestination) {
        uint256 raw = _argUint(A.C_ROYALTY_DESTINATION, 1);
        // An unknown value reads as no add-on, so `royaltyInfo` never reverts on a bad enum (the factory refuses it).
        // casting to 'uint8' is safe because raw ≤ 3 here
        // forge-lint: disable-next-line(unsafe-typecast)
        return raw > uint8(RoyaltyDestination.PoolDepth) ? RoyaltyDestination.None : RoyaltyDestination(uint8(raw));
    }

    /// @inheritdoc IBoxCollection
    function royaltyRouter() public view returns (address) {
        if (royaltyDestination() == RoyaltyDestination.None) return address(0);
        return _argAddress(A.C_ROYALTY_ROUTER);
    }

    // ============================================================================================= ERC-721 views
    /// @inheritdoc IBoxCollection
    function name() public view returns (string memory) {
        return string(_argBytes(A.C_TEXT_BYTES, _argUint(A.C_TEXTS, 1)));
    }

    /// @inheritdoc IBoxCollection
    function symbol() public view returns (string memory) {
        return string(_argBytes(A.C_TEXT_BYTES + _argUint(A.C_TEXTS, 1), _argUint(A.C_TEXTS + 1, 1)));
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
        bytes memory table = metadataTableBytes();
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

    /// @dev Hidden art: the add-on's description and SVG (MisfitsCollection.sol:446-455). Open art (no hidden SVG):
    /// the collection description and the cover.
    function _hiddenJSON(string memory title) private view returns (string memory) {
        bytes memory svg = bytes(hiddenSvg());
        string memory body = svg.length != 0
            ? string.concat(hiddenDescription(), '","image":"data:image/svg+xml;base64,', BoxEncoding.base64(svg))
            : string.concat(description(), '","image":"ipfs://', BoxEncoding.rawCidV1(collectionCoverSha256()));
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
    function metadataTableBytes() public view returns (bytes memory) {
        return BoxData.read(metadataTable());
    }

    // ============================================================================================= wiring and texts
    /// @inheritdoc IBoxCollection
    function coordinator() public view returns (address) {
        return _argAddress(A.C_COORDINATOR);
    }

    /// @inheritdoc IBoxCollection
    function vault() public view returns (address) {
        return _argAddress(A.C_VAULT);
    }

    /// @inheritdoc IBoxCollection
    function token() public view returns (address) {
        return _argAddress(A.C_TOKEN);
    }

    /// @inheritdoc IBoxCollection
    function receiver() public view returns (address) {
        return _argAddress(A.C_RECEIVER);
    }

    /// @inheritdoc IBoxCollection
    function revealUnlocker() public view returns (address) {
        return _argAddress(A.C_REVEAL_UNLOCKER);
    }

    /// @inheritdoc IBoxCollection
    function transferObserver() public view returns (address) {
        return _argAddress(A.C_TRANSFER_OBSERVER);
    }

    /// @inheritdoc IBoxCollection
    function observerGas() external pure returns (uint256) {
        return OBSERVER_GAS;
    }

    /// @inheritdoc IBoxCollection
    function metadataTable() public view returns (address) {
        return _argAddress(A.C_METADATA_TABLE);
    }

    /// @inheritdoc IBoxCollection
    function metadataTableHash() public view returns (bytes32) {
        return _argWord(A.C_METADATA_TABLE_HASH);
    }

    /// @inheritdoc IBoxCollection
    function collectionSize() public view returns (uint256) {
        return _argUint(A.C_COLLECTION_SIZE, 4);
    }

    /// @inheritdoc IBoxCollection
    function firstId() public view returns (uint256) {
        return uint256(_argWord(A.C_FIRST_ID));
    }

    /// @inheritdoc IBoxCollection
    function treeDepth() public view returns (uint256 depth) {
        uint256 n = collectionSize();
        while ((uint256(1) << depth) < n) ++depth;
    }

    /// @inheritdoc IBoxCollection
    function revealRoot() public view returns (bytes32) {
        return _argWord(A.C_REVEAL_ROOT);
    }

    /// @inheritdoc IBoxCollection
    function revealTriggers() public view returns (uint8) {
        // casting to 'uint8' is safe because the argument is one byte wide
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8(_argUint(A.C_REVEAL_TRIGGERS, 1));
    }

    /// @inheritdoc IBoxCollection
    function generatorHash() public view returns (bytes32) {
        return _argWord(A.C_GENERATOR_HASH);
    }

    /// @inheritdoc IBoxCollection
    function collectionCoverSha256() public view returns (bytes32) {
        return _argWord(A.C_COLLECTION_COVER_SHA256);
    }

    /// @inheritdoc IBoxCollection
    function bannerSha256() public view returns (bytes32) {
        return _argWord(A.C_BANNER_SHA256);
    }

    /// @inheritdoc IBoxCollection
    function description() public view returns (string memory) {
        return string(_text(2));
    }

    /// @inheritdoc IBoxCollection
    function hiddenDescription() public view returns (string memory) {
        return string(_text(3));
    }

    /// @inheritdoc IBoxCollection
    function hiddenSvg() public view returns (string memory) {
        return string(_text(4));
    }

    /// @inheritdoc IBoxCollection
    function externalLink() external view returns (string memory) {
        return string(_text(5));
    }

    // ============================================================================================= internals
    /// @dev Text `index` of the argument texts (0 name, 1 symbol, 2 description, 3 hidden description, 4 hidden SVG,
    /// 5 external link).
    function _text(uint256 index) private view returns (bytes memory) {
        uint256 nameLength = _argUint(A.C_TEXTS, 1);
        uint256 symbolLength = _argUint(A.C_TEXTS + 1, 1);
        uint256 descriptionLength = _argUint(A.C_TEXTS + 2, 2);
        uint256 hiddenDescriptionLength = _argUint(A.C_TEXTS + 4, 2);
        uint256 hiddenSvgLength = _argUint(A.C_TEXTS + 6, 2);
        uint256 start = A.C_TEXT_BYTES + nameLength + symbolLength;
        if (index == 2) return _argBytes(start, descriptionLength);
        start += descriptionLength;
        if (index == 3) return _argBytes(start, hiddenDescriptionLength);
        start += hiddenDescriptionLength;
        if (index == 4) return _argBytes(start, hiddenSvgLength);
        return _argBytes(start + hiddenSvgLength, _argUint(A.C_TEXTS + 8, 1));
    }

    /// @dev contractURI writes the link unescaped: refuse a byte that would end or break its JSON string ('"', '\\', a
    /// control byte below 0x20 or DEL), so a box made without validate() (no factory yet) cannot serve broken collection
    /// metadata. Any other byte passes (UTF-8 included). Tests 32 bytes at a time with exact "some byte is" bit tricks,
    /// those of `BoxMetadataTable._wordOk` without its "above 0x7e" test (which would refuse UTF-8), the last word's
    /// tail padded with 'A'; only after a hit is the link walked byte by byte, from its start, for the offset.
    function _checkExternalLink() private view {
        uint256 n = _argUint(A.C_TEXTS + 8, 1);
        if (n == 0) return;
        bytes memory link = _text(5);
        bool hit;
        assembly ("memory-safe") {
            let ones := 0x0101010101010101010101010101010101010101010101010101010101010101
            let highs := 0x8080808080808080808080808080808080808080808080808080808080808080
            let d := add(link, 0x20)
            for { let p := 0 } lt(p, n) { p := add(p, 32) } {
                let w := mload(add(d, p))
                let left := sub(n, p)
                if lt(left, 32) {
                    let keep := shl(shl(3, sub(32, left)), not(0))
                    w := or(
                        and(w, keep),
                        and(0x4141414141414141414141414141414141414141414141414141414141414141, not(keep))
                    )
                }
                // Some byte below 0x20 (the "has less than" trick, exact for a threshold up to 0x80; not the link
                // length n), or equal to DEL, '"' or '\\' (a zero byte after the xor).
                let x := xor(w, 0x7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f)
                let q := xor(w, 0x2222222222222222222222222222222222222222222222222222222222222222)
                let b := xor(w, 0x5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c)
                let some :=
                    or(
                        and(
                            and(sub(w, 0x2020202020202020202020202020202020202020202020202020202020202020), not(w)),
                            highs
                        ),
                        or(
                            and(and(sub(x, ones), not(x)), highs),
                            or(and(and(sub(q, ones), not(q)), highs), and(and(sub(b, ones), not(b)), highs))
                        )
                    )
                if some {
                    hit := 1
                    break
                }
            }
        }
        if (!hit) return;
        for (uint256 i; i < n; ++i) {
            bytes1 c = link[i];
            if (c < 0x20 || c == 0x7f || c == 0x22 || c == 0x5c) revert InvalidExternalLink(i);
        }
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

    /// @dev Index-directed, fixed depth ⌈log₂ N⌉ (MisfitsCollection.sol:518-540): bit k of the position says whether
    /// the node is a right child.
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

    /// @dev Checks, observer, then state; locked so the observer cannot re-enter (MisfitsCollection.sol:545-572). The
    /// receiver hook of safeTransferFrom runs after the lock is released, so a receiver may move the item on.
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
        address observer = transferObserver();
        if (observer != address(0) && !_observe(observer, from, to, id)) emit TransferObserverFailed(from, to, id);
        // Cleared after the observer: an approval set from inside it must not pass to the new owner (`:563-565`).
        delete _tokenApprovals[id];
        unchecked {
            // fromBalance ≥ 1; no balance can exceed N.
            _balances[from] = fromBalance - 1;
            ++_balances[to];
        }
        _owners[id] = to;
        emit Transfer(from, to, id);
    }

    /// @dev The fail-safe observer call: at most OBSERVER_GAS, no return data copied, a failure reported as false.
    function _observe(address observer, address from, address to, uint256 id) private returns (bool ok) {
        uint256 left = gasleft();
        if (left < _OBSERVER_GAS_REQUIRED) revert ObserverGasTooLow(left, _OBSERVER_GAS_REQUIRED);
        bytes memory data = abi.encodeCall(IBoxTransferObserver.onItemTransfer, (from, to, id));
        assembly ("memory-safe") {
            ok := call(OBSERVER_GAS, observer, 0, add(data, 0x20), mload(data), 0, 0)
        }
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

    function _firstCodeByte(address a) private view returns (uint256 b) {
        assembly ("memory-safe") {
            mstore(0x00, 0)
            extcodecopy(a, 0x1f, 0, 1)
            b := mload(0x00)
        }
    }
}
