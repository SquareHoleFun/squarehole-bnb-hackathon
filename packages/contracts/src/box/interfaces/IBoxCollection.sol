// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RoyaltyDestination} from "./BoxTypes.sol";

/// @notice EIP-721's receiver callback, under EIP-721's own name (v2 declares it as `IERC721Receiver` in
/// src/v2/interfaces/IMisfitsCollection.sol:62; a separate name keeps both importable in one test). Selector
/// 0x150b7a02.
interface IERC721TokenReceiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

/// @title IBoxCollection (slice S3; per-box clone with immutable arguments, F61 A1)
/// @notice The box's ERC-721 collection: N ids from `firstId()`, all the vault's from creation without N writes
/// (implicit ownership, one ERC-2309 event per at most 5,000 ids; BC-009). Generalises MisfitsCollection
/// (src/v2/MisfitsCollection.sol:87-712) with N, names, texts, cover, hidden art, royalties and observers as data
/// (V `:91-96` are constants today).
///
/// - **Commit-reveal** as today (`:42-55`): a fixed-depth binary Merkle root over positions id − firstId, depth
///   ⌈log₂ N⌉ (`treeDepth()`); leaf = keccak256(abi.encode(id, traitsPacked, imageSha256, avatarSha256, modelSha256,
///   salt)); `reveal` is permissionless, once per id, after its trigger: REVEAL_ON_EXIT (1, the id has left the vault),
///   REVEAL_ON_UNLOCK (2, the tickets add-on unlocked it), REVEAL_ALWAYS (4, open art: the reveal list is public at
///   creation, BC-052). The root, table and generator hash never change (BC-062).
/// - **Hidden view** (hook point `collection.hiddenView`): an unrevealed id shows the placeholders add-on's hidden
///   description and SVG; without the add-on (open art) the collection description and the collection cover (field
///   28; P, founder question: the cover or the logo).
/// - **Royalties** (add-on 4, F65, F68 (4); hook point `collection.royaltyInfo`): unenforced ERC-2981, no 721C, no
///   operator filter. With the add-on, `supportsInterface(0x2a55205a)` is true and `royaltyInfo(id, price)` =
///   (receiver, floor(price × bps / 10,000)) for every id, bps a preset (0, 100, 250, 500): the receiver is the
///   box's royalty router at every destination; for Creator the router flushes to the receiver's `fundCreator()`,
///   credited to the one creator payee (F72 (1), (3); review of sh-core-v1: a payee that refuses ETH cannot block
///   royalty-paying sales). Box 0: 250 bps to its router (BC-112). Without the add-on ERC-2981 is unset (BC-113), but
///   for template 0 factory v1's planner writes FeeHandling as the destination whether or not the add-on is present,
///   so such a collection still reports ERC-2981 and `royaltyInfo` answers (address(0), 0) (box 0's own review
///   W3-U1-1, F147; box 0 keeps the add-on, F65).
/// - **Marketplace views:** `owner()` = the spec's `marketplaceOwner` (box 0: the platform Safe), read-only, checked
///   by no function (F26 (4)); `contractURI()` (ERC-7572, F71): fixed on-chain JSON with name, description, image
///   (the collection cover, BoxSpec field 28 since F74 U3), banner and `external_link` (add-on 6, when set) and
///   `generator_hash`.
/// - **Refused sends** (F24 (d), F25 (3); BC-042, BC-044): a transfer to the vault reverts unless the vault is the
///   caller pulling a return; transfers to the collection and to T always revert. `transferFrom` checks no receiver:
///   an item sent with it to a contract that cannot move it, box 0's own contracts other than the vault included, has
///   no exit; at the stream its share is never paid or burned, at another box contract anyone may claim it into that
///   contract (an accepted no-exit class: box 0's own review W3-U7-1, R66-LOST, F147). `safeTransferFrom` refuses them.
/// - **Observer** (hook point `collection.transferObserver`, add-on 2): `IBoxTransferObserver`, capped, fail-safe.
/// - Fixed forever (F72 (2), F23 C2): no mint, burn, admin, pause, upgrade, base URI or setter.
/// @dev Invariants: Σ balances == N; every id has exactly one owner; an id is revealed at most once and only with a
/// valid proof against `revealRoot()`; `royaltyInfo` never reverts for any id or price.
interface IBoxCollection {
    // ERC-721, ERC-2309, ERC-4906, ERC-7572
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event ConsecutiveTransfer(
        uint256 indexed fromTokenId, uint256 toTokenId, address indexed fromAddress, address indexed toAddress
    );
    event MetadataUpdate(uint256 _tokenId);
    /// @notice ERC-7572; emitted once, by `initialize`, so indexers read the fixed JSON.
    event ContractURIUpdated();

    event Revealed(uint256 indexed id, uint128 traitsPacked, bytes32 imageHash, bytes32 avatarHash, bytes32 modelHash);
    event RevealUnlocked(uint256 indexed id);
    /// @notice The transfer observer failed (reverted or ran out of its gas) and was skipped; the transfer happened.
    event TransferObserverFailed(address indexed from, address indexed to, uint256 indexed id);
    /// @notice Once, by `initialize`: the collection's wiring and commitments.
    event CollectionInitialized(
        address vault,
        address token,
        uint256 collectionSize,
        uint256 firstId,
        bytes32 revealRoot,
        uint8 revealTriggers,
        address revealUnlocker,
        address transferObserver,
        bytes32 metadataTableHash,
        bytes32 generatorHash,
        bytes32 collectionCoverSha256
    );

    // ERC-6093 names for the ERC-721 cases (as MisfitsCollection.sol:211-217)
    error ERC721InvalidOwner(address owner);
    error ERC721NonexistentToken(uint256 tokenId);
    error ERC721IncorrectOwner(address sender, uint256 tokenId, address owner);
    error ERC721InvalidReceiver(address receiver);
    error ERC721InsufficientApproval(address operator, uint256 tokenId);
    error ERC721InvalidApprover(address approver);
    error ERC721InvalidOperator(address operator);
    error DirectSendRefused(address to);
    error NotRevealUnlocker(address caller);
    error NotRevealable(uint256 id);
    error AlreadyRevealed(uint256 id);
    error NotRevealed(uint256 id);
    error InvalidProof(uint256 id);
    /// @notice Sent with too little gas to give the transfer observer its whole cap.
    error ObserverGasTooLow(uint256 gasLeft, uint256 required);
    /// @notice `initialize` from anyone but the box's coordinator (BC-100), or a second time.
    error NotCoordinator(address caller);
    error AlreadyInitialised();
    /// @notice A state-changing call to a clone its coordinator never initialised (SH-S0-spikes decision 9; BC-100).
    /// Added by S3 (docs/evidence/SH-S3-items.md, interface changes).
    error NotInitialised();
    /// @notice `initialize` found no well-formed v1 table behind `metadataTable()` with `metadataTableHash()`: the first
    /// bad offset, or `type(uint256).max` for a missing STOP prefix or a hash mismatch. Added by S3 (the spec's
    /// `validate()` bounds only the table's length; `tokenJSON` relies on the format).
    error InvalidMetadataTable(uint256 offset);
    /// @notice `initialize` found a byte in add-on 6's link that would break contractURI's JSON string ('"', '\\', a
    /// control byte below 0x20 or DEL), at `offset`. Added by SH-F74-polish: validate()'s URL rule refuses them too, but
    /// the collection does not rely on a factory having run it.
    error InvalidExternalLink(uint256 offset);

    /// @notice The box's coordinator only (the `coordinator` argument, a clone of `coordinatorImplementation()`), once,
    /// in createBox: the vault's balance = N and the ERC-2309 events in chunks of at most 5,000 ids (BC-009), then
    /// `ContractURIUpdated` and `CollectionInitialized`.
    function initialize() external;

    // ------------------------------------------------------------------ ERC-165, ERC-721, metadata
    /// @notice True for 0x01ffc9a7, 0x80ac58cd, 0x5b5e139f, 0x49064906, and 0x2a55205a while `royaltyDestination()` is
    /// not `None`: with the royalties add-on, and for template 0 also without it (factory v1's planner writes
    /// FeeHandling whether or not the add-on is present; `royaltyInfo` then answers (address(0), 0); W3-U1-1, F147).
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    /// @notice N, always: every id exists from creation.
    function totalSupply() external view returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
    function ownerOf(uint256 id) external view returns (address);
    function getApproved(uint256 id) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function approve(address to, uint256 id) external;
    function setApprovalForAll(address operator, bool approved) external;
    function transferFrom(address from, address to, uint256 id) external;
    function safeTransferFrom(address from, address to, uint256 id) external;
    function safeTransferFrom(address from, address to, uint256 id, bytes calldata data) external;
    /// @notice "data:application/json;base64," + the JSON of `tokenJSON(id)`.
    function tokenURI(uint256 id) external view returns (string memory);
    function tokenJSON(uint256 id) external view returns (string memory);

    // ------------------------------------------------------------------ marketplace views
    /// @notice The spec's `marketplaceOwner` (box 0: the platform Safe). Read-only; no function checks it.
    function owner() external view returns (address);
    /// @notice ERC-7572 collection metadata, fixed, fully on chain (F71).
    function contractURI() external view returns (string memory);
    /// @notice ERC-2981. Without the royalties add-on: (address(0), 0).
    function royaltyInfo(uint256 tokenId, uint256 salePrice) external view returns (address receiver, uint256 amount);
    /// @notice The add-on's rate in basis points (0, 100, 250 or 500), 0 without the add-on.
    function royaltyBps() external view returns (uint16);
    /// @notice The add-on's destination; `None` without the add-on, except for template 0, whose planner (factory v1)
    /// writes FeeHandling whether or not the add-on is present (box 0's own review W3-U1-1, F147).
    function royaltyDestination() external view returns (RoyaltyDestination);
    /// @notice The box's royalty router (every destination); address(0) without the add-on.
    function royaltyRouter() external view returns (address);

    // ------------------------------------------------------------------ wiring and commitments
    /// @notice The box's coordinator (its deployer and the only caller of `initialize`).
    function coordinator() external view returns (address);
    /// @notice The version's coordinator implementation: only a clone of it may initialise this collection (BC-100).
    function coordinatorImplementation() external view returns (address);
    function vault() external view returns (address);
    function token() external view returns (address);
    /// @notice The box's receiver (its royalty router's sink).
    function receiver() external view returns (address);
    function collectionSize() external view returns (uint256);
    function firstId() external view returns (uint256);
    /// @notice ⌈log₂ N⌉.
    function treeDepth() external view returns (uint256);
    function revealRoot() external view returns (bytes32);
    /// @notice REVEAL_ON_EXIT 1 | REVEAL_ON_UNLOCK 2 | REVEAL_ALWAYS 4.
    function revealTriggers() external view returns (uint8);
    /// @notice The tickets add-on, or address(0).
    function revealUnlocker() external view returns (address);
    /// @notice The per-item stream (add-on 2), or address(0).
    function transferObserver() external view returns (address);
    /// @notice The observer's gas cap: a version constant (S3 fixes it from SH-S0-spikes § 3).
    function observerGas() external view returns (uint256);
    /// @notice The data contract holding the metadata table (code = 0x00 ‖ table), format v1 (`:60-64`).
    function metadataTable() external view returns (address);
    function metadataTableHash() external view returns (bytes32);
    function metadataTableBytes() external view returns (bytes memory);
    function generatorHash() external view returns (bytes32);
    /// @notice sha256 of the collection cover (BC-054; BoxSpec field 28, collectionCoverSha256, F74 U3): the image in
    /// `contractURI` and the open-art hidden view. The box's logo (BoxSpec field 23, named coverSha256 in the spec) is
    /// not on chain; this view and `CollectionInitialized` carry field 28's name so neither reads as the logo.
    function collectionCoverSha256() external view returns (bytes32);
    /// @notice sha256 of the banner (F71), or zero.
    function bannerSha256() external view returns (bytes32);
    /// @notice The collection description (≤ 1,024 bytes, the spec's string rule).
    function description() external view returns (string memory);
    /// @notice The placeholders add-on's hidden description and SVG; empty without the add-on.
    function hiddenDescription() external view returns (string memory);
    function hiddenSvg() external view returns (string memory);
    /// @notice Add-on 6's link (contractURI's `external_link`, F71 (2)), empty for none; never a '"', '\\', control
    /// byte or DEL (`initialize` refuses them).
    function externalLink() external view returns (string memory);

    // ------------------------------------------------------------------ reveal
    /// @notice The reveal unlocker only (zero: nobody, since no Ethereum call comes from address(0)); idempotent. The
    /// REVEAL_ON_UNLOCK clause is the reveal's, not this call's: without that trigger the flag it sets changes nothing
    /// (box 0's own review W3-U1-2, F147).
    function unlockReveal(uint256 id) external;
    /// @notice Anyone with the preimage, once per id, after its trigger.
    function reveal(
        uint256 id,
        uint128 traitsPacked,
        bytes32 imageHash,
        bytes32 avatarHash,
        bytes32 modelHash,
        bytes32 salt,
        bytes32[] calldata proof
    ) external;
    function leafOf(
        uint256 id,
        uint128 traitsPacked,
        bytes32 imageHash,
        bytes32 avatarHash,
        bytes32 modelHash,
        bytes32 salt
    ) external pure returns (bytes32);
    function isRevealed(uint256 id) external view returns (bool);
    function isRevealable(uint256 id) external view returns (bool);
    function revealState(uint256 id)
        external
        view
        returns (bool hasLeftVault, bool unlocked, bool revealed, bool revealable);
    function traitsOf(uint256 id)
        external
        view
        returns (bool revealed, uint128 traitsPacked, bytes32 imageHash, bytes32 modelHash);
    function revealedCount() external view returns (uint256);
    function imageCid(uint256 id) external view returns (string memory);
    function modelCid(uint256 id) external view returns (string memory);
}
