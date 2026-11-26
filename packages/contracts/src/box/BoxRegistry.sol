// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolId} from "v4-core/src/types/PoolId.sol";
import {IBoxCollection} from "./interfaces/IBoxCollection.sol";
import {IBoxCoordinator} from "./interfaces/IBoxCoordinator.sol";
import {IBoxHook} from "./interfaces/IBoxHook.sol";
import {IBoxReceiver} from "./interfaces/IBoxReceiver.sol";
import {IBoxRegistry} from "./interfaces/IBoxRegistry.sol";

/// @title BoxRegistry (slice S7)
/// @notice See `IBoxRegistry`. Created by its factory in the factory's constructor (so `factory` is fixed before any
/// box exists); one registry per factory version (versions beside versions, R F72), each written only by its own
/// factory. Five storage words per box: the coordinator and creation block, the template id, the spec hash, the record
/// hash, and the reverse lookup. The full record (every contract with its code hash) is in `BoxCreated` and is rebuilt
/// from the chain by `recordOf`, so storing it would only cost gas (≈ 30 more words per box).
/// @dev No owner, admin, pause, upgrade, setter or rescue (F23 C2). Written for Square Hole (MIT).
contract BoxRegistry is IBoxRegistry {
    /// @notice `BoxRecord.contracts` / `codeHashes` indexes.
    uint256 public constant ROLE_COORDINATOR = 0;
    uint256 public constant ROLE_TOKEN = 1;
    uint256 public constant ROLE_HOOK = 2;
    uint256 public constant ROLE_VAULT = 3;
    uint256 public constant ROLE_COLLECTION = 4;
    uint256 public constant ROLE_RECEIVER = 5;
    uint256 public constant ROLE_LAUNCH_ROUTER = 6;
    /// @dev The placeholders add-on's tickets (zero without it).
    uint256 public constant ROLE_TICKETS = 7;
    /// @dev The royalties add-on's router (zero without it).
    uint256 public constant ROLE_ROYALTY_ROUTER = 8;
    /// @dev FIT's buy-and-burn executor: created by box 0 (BC-064), named by every other box.
    uint256 public constant ROLE_EXECUTOR = 9;
    /// @dev The per-item stream (add-on 2, S8; box 0's, created by factory v1 with box 0; zero for a box without it).
    uint256 public constant ROLE_ITEM_STREAM = 10;
    /// @dev The box's swap module (every Standard box, S5.M1; zero for box 0).
    uint256 public constant ROLE_SWAP_MODULE = 11;
    /// @dev The metadata table's data contract (0x00 ‖ table).
    uint256 public constant ROLE_METADATA_TABLE = 12;
    uint256 public constant ROLE_COUNT = 13;

    struct Entry {
        address coordinator;
        uint64 creationBlock;
        bytes32 templateId;
        bytes32 specHash;
        bytes32 recordHash;
    }

    /// @inheritdoc IBoxRegistry
    address public immutable factory;

    uint256 public boxCount;
    mapping(uint256 => Entry) internal _entries;
    /// @dev boxId + 1 (zero: not recorded).
    mapping(address => uint256) internal _idPlusOne;

    constructor() {
        factory = msg.sender;
    }

    /// @inheritdoc IBoxRegistry
    function record(address coordinator, bytes32 templateId, bytes calldata encodedSpec)
        external
        returns (uint256 boxId)
    {
        if (msg.sender != factory) revert NotFactory(msg.sender);
        if (_idPlusOne[coordinator] != 0) revert AlreadyRecorded(coordinator);
        boxId = boxCount;
        IBoxCoordinator c = IBoxCoordinator(coordinator);
        uint256 named = c.boxId();
        if (named != boxId) revert BoxIdMismatch(boxId, named);
        bytes32 h = keccak256(encodedSpec);
        bytes32 specHash_ = c.specHash();
        if (h != specHash_) revert SpecHashMismatch(h, specHash_);
        boxCount = boxId + 1;
        _idPlusOne[coordinator] = boxId + 1;
        BoxRecord memory r = _build(boxId, coordinator, templateId, block.number);
        _entries[boxId] = Entry({
            coordinator: coordinator,
            // casting to 'uint64' is safe because a block number fits 64 bits for any foreseeable chain
            // forge-lint: disable-next-line(unsafe-typecast)
            creationBlock: uint64(block.number),
            templateId: templateId,
            specHash: specHash_,
            recordHash: keccak256(abi.encode(r))
        });
        emit BoxCreated(boxId, templateId, specHash_, r);
        emit BoxSpec(boxId, encodedSpec);
    }

    /// @inheritdoc IBoxRegistry
    function coordinatorOf(uint256 boxId) external view returns (address) {
        return _entry(boxId).coordinator;
    }

    /// @inheritdoc IBoxRegistry
    function boxIdOf(address coordinator) external view returns (bool recorded, uint256 boxId) {
        uint256 v = _idPlusOne[coordinator];
        recorded = v != 0;
        if (recorded) boxId = v - 1;
    }

    /// @inheritdoc IBoxRegistry
    function entry(uint256 boxId)
        external
        view
        returns (address coordinator, uint256 creationBlock, bytes32 templateId, bytes32 specHash, bytes32 recordHash)
    {
        Entry storage e = _entry(boxId);
        return (e.coordinator, e.creationBlock, e.templateId, e.specHash, e.recordHash);
    }

    /// @inheritdoc IBoxRegistry
    function recordOf(uint256 boxId) external view returns (BoxRecord memory) {
        Entry storage e = _entry(boxId);
        return _build(boxId, e.coordinator, e.templateId, e.creationBlock);
    }

    function _entry(uint256 boxId) private view returns (Entry storage e) {
        if (boxId >= boxCount) revert UnknownBox(boxId);
        return _entries[boxId];
    }

    /// @dev The record from the box's own wiring getters (every address but the coordinator's comes from them) and
    /// each contract's code hash.
    function _build(uint256 boxId, address coordinator, bytes32 templateId, uint256 creationBlock)
        private
        view
        returns (BoxRecord memory r)
    {
        IBoxCoordinator c = IBoxCoordinator(coordinator);
        IBoxHook h = IBoxHook(c.hook());
        r.boxId = boxId;
        r.templateId = templateId;
        r.specHash = c.specHash();
        r.creator = c.creator();
        r.q = c.q();
        r.raise = c.raise();
        r.poolManager = c.poolManager();
        r.poolId = PoolId.unwrap(h.poolId());
        r.creationBlock = creationBlock;
        r.openAt = h.openAt();
        r.randomness = c.randomness();
        address[13] memory a = r.contracts;
        a[ROLE_COORDINATOR] = coordinator;
        a[ROLE_TOKEN] = c.token();
        a[ROLE_HOOK] = address(h);
        a[ROLE_VAULT] = c.vault();
        a[ROLE_COLLECTION] = c.collection();
        a[ROLE_RECEIVER] = c.receiver();
        a[ROLE_LAUNCH_ROUTER] = c.launchRouter();
        a[ROLE_TICKETS] = c.tickets();
        a[ROLE_ROYALTY_ROUTER] = c.royaltyRouter();
        a[ROLE_EXECUTOR] = c.executor();
        a[ROLE_ITEM_STREAM] = c.itemStream();
        a[ROLE_SWAP_MODULE] = IBoxReceiver(a[ROLE_RECEIVER]).swapModule();
        a[ROLE_METADATA_TABLE] = IBoxCollection(a[ROLE_COLLECTION]).metadataTable();
        for (uint256 i; i < ROLE_COUNT; ++i) {
            if (a[i] != address(0)) r.codeHashes[i] = a[i].codehash;
        }
    }
}
