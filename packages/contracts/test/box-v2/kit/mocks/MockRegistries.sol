// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolId} from "v4-core/src/types/PoolId.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {BoxRolesV2, IBoxRegistryV2} from "../../../../src/box-v2/interfaces/IBoxRegistryV2.sol";
import {IBoxCoordinatorV2} from "../../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";

/// @title MockBoxRegistryV2
/// @notice TEST ONLY (M1-03). Registry v2 of one release, over mock boxes (`IBoxRegistryV2`). Follows:
/// - ADR-0017 § 12: 24 roles (`BoxRolesV2`), each read from the box's `roleAddress`, zero where unused, `UnknownRole`
///   from 24; the record carries `address[24]` and `bytes32[24]`.
/// - v1's record rule (`BoxRegistry.sol:61-87`; F23 C2): written once per box, by the factory only, its box id checked
///   against the coordinator's `boxId()` and the spec's hash against its `specHash()`; `BoxCreated` then `BoxSpec`
///   (ADR-0017 § 6: the spec as calldata, only its hash kept); `recordOf` rebuilt from the box now. No owner or setter.
/// - ADR-0017 § 10: a fixed directory of earlier registries, set at deployment: index 0 is this registry, i ≥ 1 is
///   `directory()[i - 1]`, anything else `UnknownRegistry`.
/// Not modeled: the template id, which the factory computes (M1-32); this registry records what it is given.
contract MockBoxRegistryV2 is IBoxRegistryV2 {
    struct Entry {
        address coordinator;
        uint64 creationBlock;
        bytes32 templateId;
        bytes32 specHash;
        bytes32 recordHash;
    }

    address public immutable factory;
    address[] private _directory;
    Entry[] private _entries;
    mapping(address => uint256) private _idPlusOne;

    constructor(address factory_, address[] memory directory_) {
        factory = factory_;
        _directory = directory_;
    }

    function record(address coordinator, bytes32 templateId, bytes calldata encodedSpec)
        external
        returns (uint256 boxId)
    {
        if (msg.sender != factory) revert NotFactory(msg.sender);
        if (_idPlusOne[coordinator] != 0) revert AlreadyRecorded(coordinator);
        boxId = _entries.length;
        uint256 named = IBoxCoordinator(coordinator).boxId();
        if (named != boxId) revert BoxIdMismatch(boxId, named);
        bytes32 h = keccak256(encodedSpec);
        bytes32 specHash_ = IBoxCoordinator(coordinator).specHash();
        if (h != specHash_) revert SpecHashMismatch(h, specHash_);
        _idPlusOne[coordinator] = boxId + 1;
        BoxRecordV2 memory r = _build(boxId, coordinator, templateId, block.number);
        // forge-lint: disable-next-line(unsafe-typecast)
        _entries.push(Entry(coordinator, uint64(block.number), templateId, specHash_, keccak256(abi.encode(r))));
        emit BoxCreated(boxId, templateId, specHash_, r);
        emit BoxSpec(boxId, encodedSpec);
    }

    function VERSION() external pure returns (uint16) {
        return 2;
    }

    function ROLE_COUNT() external pure returns (uint256) {
        return BoxRolesV2.ROLE_COUNT;
    }

    function boxCount() external view returns (uint256) {
        return _entries.length;
    }

    function coordinatorOf(uint256 boxId) external view returns (address) {
        return _entry(boxId).coordinator;
    }

    function boxIdOf(address coordinator) external view returns (bool recorded, uint256 boxId) {
        uint256 v = _idPlusOne[coordinator];
        recorded = v != 0;
        if (recorded) boxId = v - 1;
    }

    function entry(uint256 boxId)
        external
        view
        returns (address coordinator, uint256 creationBlock, bytes32 templateId, bytes32 specHash, bytes32 recordHash)
    {
        Entry storage e = _entry(boxId);
        return (e.coordinator, e.creationBlock, e.templateId, e.specHash, e.recordHash);
    }

    function recordOf(uint256 boxId) external view returns (BoxRecordV2 memory) {
        Entry storage e = _entry(boxId);
        return _build(boxId, e.coordinator, e.templateId, e.creationBlock);
    }

    function roleOf(uint256 boxId, uint256 role) external view returns (address) {
        if (role >= BoxRolesV2.ROLE_COUNT) revert UnknownRole(role);
        return IBoxCoordinatorV2(_entry(boxId).coordinator).roleAddress(role);
    }

    function directory() external view returns (address[] memory) {
        return _directory;
    }

    function registryAt(uint8 registryIndex) external view returns (address) {
        if (registryIndex == 0) return address(this);
        if (registryIndex > _directory.length) revert UnknownRegistry(registryIndex);
        return _directory[registryIndex - 1];
    }

    function _entry(uint256 boxId) private view returns (Entry storage) {
        if (boxId >= _entries.length) revert UnknownBox(boxId);
        return _entries[boxId];
    }

    function _build(uint256 boxId, address coordinator, bytes32 templateId, uint256 creationBlock)
        private
        view
        returns (BoxRecordV2 memory r)
    {
        IBoxCoordinator c = IBoxCoordinator(coordinator);
        IBoxCoordinatorV2 c2 = IBoxCoordinatorV2(coordinator);
        r.boxId = boxId;
        r.templateId = templateId;
        r.specHash = c.specHash();
        r.creator = c.creator();
        r.pricingListingId = c2.pricingListingId();
        r.q = c.q();
        r.raise = c.raise();
        r.poolManager = c.poolManager();
        r.creationBlock = creationBlock;
        r.openAt = c2.openAt();
        r.randomness = c.randomness();
        r.contracts[BoxRolesV2.ROLE_COORDINATOR] = coordinator;
        for (uint256 i = 1; i < BoxRolesV2.ROLE_COUNT; ++i) {
            r.contracts[i] = c2.roleAddress(i);
        }
        address hook = r.contracts[BoxRolesV2.ROLE_HOOK];
        if (hook != address(0)) r.poolId = PoolId.unwrap(IBoxHook(hook).poolId());
        for (uint256 i; i < BoxRolesV2.ROLE_COUNT; ++i) {
            if (r.contracts[i] != address(0)) r.codeHashes[i] = r.contracts[i].codehash;
        }
    }
}

/// @title MockEarlierRegistry
/// @notice TEST ONLY (M1-03). One entry of registry v2's fixed directory: an earlier core's registry, v1's included
/// (FIT is box 0 there). Follows ADR-0017 § 10: v2 reads an earlier registry only through v1's `coordinatorOf`,
/// `boxIdOf` and `boxCount` (`IBoxRegistry.sol:69-73`, pinned by M1-02), so this mock answers no v2 view, and a v2 part
/// that calls one on a directory entry fails here; an earlier core never sees a later one. Boxes are added once each,
/// by its factory, never edited (v1's record rule). Not modeled: v1's record struct and `recordOf`.
contract MockEarlierRegistry {
    error NotFactory(address caller);
    error AlreadyRecorded(address coordinator);
    error UnknownBox(uint256 boxId);

    address public immutable factory;
    address[] private _boxes;
    mapping(address => uint256) private _idPlusOne;

    constructor(address factory_) {
        factory = factory_;
    }

    function recordBox(address coordinator) external returns (uint256 boxId) {
        if (msg.sender != factory) revert NotFactory(msg.sender);
        if (_idPlusOne[coordinator] != 0) revert AlreadyRecorded(coordinator);
        boxId = _boxes.length;
        _boxes.push(coordinator);
        _idPlusOne[coordinator] = boxId + 1;
    }

    function boxCount() external view returns (uint256) {
        return _boxes.length;
    }

    function coordinatorOf(uint256 boxId) external view returns (address) {
        if (boxId >= _boxes.length) revert UnknownBox(boxId);
        return _boxes[boxId];
    }

    function boxIdOf(address coordinator) external view returns (bool recorded, uint256 boxId) {
        uint256 v = _idPlusOne[coordinator];
        recorded = v != 0;
        if (recorded) boxId = v - 1;
    }
}
