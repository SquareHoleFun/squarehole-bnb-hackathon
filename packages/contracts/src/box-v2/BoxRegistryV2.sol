// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolId} from "v4-core/src/types/PoolId.sol";
import {IBoxCoordinator} from "../box/interfaces/IBoxCoordinator.sol";
import {IBoxHookV2} from "./interfaces/IBoxHookV2.sol";
import {IBoxCoordinatorV2} from "./interfaces/IBoxCoordinatorV2.sol";
import {BoxRolesV2, IBoxRegistryV2} from "./interfaces/IBoxRegistryV2.sol";

/// @title BoxRegistryV2 (ticket M1-32-b; ADR-0017 § 6, § 10, § 12)
/// @notice See `IBoxRegistryV2`. v1's registry (`BoxRegistry.sol`) with 24 roles and a fixed directory: written only by
/// its factory, once per box, never edited. Five storage words per box, as v1's: the coordinator and creation block,
/// the template id, the spec hash, the record hash, and the reverse lookup. The spec is only emitted (`BoxSpec`), and
/// the full record (custody at 3, item/holder ledgers at 16/17, loader at 19) is in `BoxCreated` and rebuilt from the
/// chain by `recordOf`, so a part whose code changes later shows against the stored hash (BC-214).
/// - **The directory** (ADR-0017 § 10; BC-221): the earlier registries this release reads, set in the constructor and
///   never written again. Index 0 is this registry, index i ≥ 1 `directory()[i - 1]` (v1's first, so FIT is box 0 at
///   index 1); an earlier core never sees a later one.
/// - **Deployment** (file map § 11 step 4): the factory's predicted address and the directory; the factory is the
///   only writer (BC-100 v2).
/// @dev No owner, admin, pause, upgrade, setter or rescue (F23 C2). Written for Square Hole (MIT).
contract BoxRegistryV2 is IBoxRegistryV2 {
    /// @notice A constructor argument that cannot be the release's: no factory, a directory entry with no code (every
    /// entry is an earlier registry, so it exists), or more entries than `registryAt`'s index reaches.
    error BadDeployment();

    struct Entry {
        address coordinator;
        uint64 creationBlock;
        bytes32 templateId;
        bytes32 specHash;
        bytes32 recordHash;
    }

    /// @inheritdoc IBoxRegistryV2
    address public immutable factory;

    /// @inheritdoc IBoxRegistryV2
    uint256 public boxCount;
    mapping(uint256 => Entry) internal _entries;
    /// @dev boxId + 1 (zero: not recorded).
    mapping(address => uint256) internal _idPlusOne;
    /// @dev The fixed directory, written once in the constructor.
    address[] private _directory;

    constructor(address factory_, address[] memory directory_) {
        uint256 noCode = 0;
        for (uint256 i; i < directory_.length; ++i) {
            if (directory_[i].code.length == 0) ++noCode;
        }
        if (factory_ == address(0) || directory_.length > type(uint8).max || noCode != 0) revert BadDeployment();
        factory = factory_;
        _directory = directory_;
    }

    /// @inheritdoc IBoxRegistryV2
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
        BoxRecordV2 memory r = _build(boxId, coordinator, templateId, block.number);
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

    // ================================================================== views

    /// @inheritdoc IBoxRegistryV2
    function VERSION() external pure returns (uint16) {
        return 2;
    }

    /// @inheritdoc IBoxRegistryV2
    function ROLE_COUNT() external pure returns (uint256) {
        return BoxRolesV2.ROLE_COUNT;
    }

    /// @inheritdoc IBoxRegistryV2
    function coordinatorOf(uint256 boxId) external view returns (address) {
        return _entry(boxId).coordinator;
    }

    /// @inheritdoc IBoxRegistryV2
    function boxIdOf(address coordinator) external view returns (bool recorded, uint256 boxId) {
        uint256 v = _idPlusOne[coordinator];
        recorded = v != 0;
        if (recorded) boxId = v - 1;
    }

    /// @inheritdoc IBoxRegistryV2
    function entry(uint256 boxId)
        external
        view
        returns (address coordinator, uint256 creationBlock, bytes32 templateId, bytes32 specHash, bytes32 recordHash)
    {
        Entry storage e = _entry(boxId);
        return (e.coordinator, e.creationBlock, e.templateId, e.specHash, e.recordHash);
    }

    /// @inheritdoc IBoxRegistryV2
    function recordOf(uint256 boxId) external view returns (BoxRecordV2 memory) {
        Entry storage e = _entry(boxId);
        return _build(boxId, e.coordinator, e.templateId, e.creationBlock);
    }

    /// @inheritdoc IBoxRegistryV2
    function roleOf(uint256 boxId, uint256 role) external view returns (address) {
        address coordinator = _entry(boxId).coordinator;
        if (role >= BoxRolesV2.ROLE_COUNT) revert UnknownRole(role);
        if (role == BoxRolesV2.ROLE_COORDINATOR) return coordinator;
        return IBoxCoordinatorV2(coordinator).roleAddress(role);
    }

    /// @inheritdoc IBoxRegistryV2
    function directory() external view returns (address[] memory) {
        return _directory;
    }

    /// @inheritdoc IBoxRegistryV2
    function registryAt(uint8 registryIndex) external view returns (address) {
        if (registryIndex == 0) return address(this);
        if (registryIndex > _directory.length) revert UnknownRegistry(registryIndex);
        return _directory[registryIndex - 1];
    }

    // ================================================================== private

    function _entry(uint256 boxId) private view returns (Entry storage e) {
        if (boxId >= boxCount) revert UnknownBox(boxId);
        return _entries[boxId];
    }

    /// @dev The record from the coordinator's own views (every role but its own from `roleAddress`, zero where the box
    /// does not use it) and each part's code hash now. Release implementation slots 20/21/22 are not box roles:
    /// their token/shop/pile clones are recorded at 1/3. A seeded pile's same clone/hash also occupies role 19.
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
        address[24] memory a = r.contracts;
        a[BoxRolesV2.ROLE_COORDINATOR] = coordinator;
        for (uint256 i = 1; i < BoxRolesV2.ROLE_COUNT; ++i) {
            // One view per role on the box's own coordinator, which its factory just created (frozen `roleAddress`).
            // forge-lint: disable-next-line(calls-loop)
            a[i] = c2.roleAddress(i);
        }
        address hook = a[BoxRolesV2.ROLE_HOOK];
        if (hook != address(0)) r.poolId = PoolId.unwrap(IBoxHookV2(hook).poolId());
        for (uint256 i; i < BoxRolesV2.ROLE_COUNT; ++i) {
            if (a[i] != address(0)) r.codeHashes[i] = a[i].codehash;
        }
    }
}
