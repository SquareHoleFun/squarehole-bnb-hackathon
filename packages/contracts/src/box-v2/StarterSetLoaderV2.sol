// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxCloneBase} from "../box/BoxCloneBase.sol";
import {BoxClones} from "../box/libraries/BoxClones.sol";
import {TransientReentrancyGuard} from "../libraries/TransientReentrancyGuard.sol";
import {IBoxCoordinatorV2} from "./interfaces/IBoxCoordinatorV2.sol";
import {IStarterSetLoaderV2, IShopVaultV2, ShopLimitsV2 as L} from "./interfaces/IShopVaultV2.sol";
import {M2SeamArgs} from "./libraries/M2SeamArgs.sol";

/// @notice Role 19: bounded creator-approved starter loading, followed by permissionless completion.
/// @dev No initializer, custody, approvals, admin or recovery destination. The shop pulls and owns every NFT;
/// its failed-set return pays only the fixed creator. M2SeamArgs.starter is unchanged: c/shop/hash/count.
contract StarterSetLoaderV2 is IStarterSetLoaderV2, BoxCloneBase, TransientReentrancyGuard {
    /// @notice Invalid clone, commitment, page or phase; no partial custody or completion survives refusal.
    error InvalidRequest();
    /// @notice Only the fixed creator may submit a page; completion remains permissionless.
    error Unauthorized(address caller);
    /// @notice A full page reached shop custody; progress does not itself open the coordinator gate.
    event StarterProgress(uint32 loaded, bytes32 remainingHash);

    /// @notice Anyone reads the fixed release coordinator implementation; no money moves.
    address public immutable coordinatorImplementation;
    address private immutable _implementation;
    uint32 private _loaded;
    bool private _notified;
    bytes32 private _remaining;
    mapping(bytes32 => bool) private _seen;

    /// @notice Release deployer fixes coordinator authentication; clones start with zero storage.
    constructor(address coordinatorImpl) {
        if (coordinatorImpl.code.length == 0) revert InvalidRequest();
        coordinatorImplementation = coordinatorImpl;
        _implementation = address(this);
    }

    /// @inheritdoc IStarterSetLoaderV2
    function load(address[] calldata collections, uint256[] calldata ids, uint8[] calldata tiers, bytes32 nextHash)
        external nonReentrant
    {
        IBoxCoordinatorV2 c = _live();
        if (msg.sender != c.creator()) revert Unauthorized(msg.sender);
        uint256 n = ids.length;
        uint256 total = _argUint(72, 4);
        uint256 end = uint256(_loaded) + n;
        if (n == 0 || n > L.MAX_STARTER_BATCH || n != collections.length || n != tiers.length || end > total
            || (end == total) != (nextHash == bytes32(0))) revert InvalidRequest();
        bytes32 hash = nextHash;
        for (uint256 i = n; i != 0;) {
            --i;
            if (collections[i] == address(0) || tiers[i] > 3) revert InvalidRequest();
            hash = keccak256(abi.encode(collections[i], ids[i], tiers[i], hash));
        }
        if (hash != _remainingHash()) revert InvalidRequest();
        // Validate all duplicates before the first external pull, including duplicates within this page.
        // Every write rolls back if any later pull fails; the lock also excludes completion from NFT callbacks.
        for (uint256 i; i < n; ++i) {
            bytes32 key = keccak256(abi.encode(collections[i], ids[i]));
            if (_seen[key]) revert InvalidRequest();
            _seen[key] = true;
        }
        IShopVaultV2 shop = IShopVaultV2(_argAddress(20));
        for (uint256 i; i < n; ++i) shop.loadStarter(collections[i], ids[i], tiers[i]);
        // end <= committed uint32 count <= 10000, checked above.
        // forge-lint: disable-next-line(unsafe-typecast)
        _loaded = uint32(end);
        _remaining = nextHash;
        emit StarterProgress(_loaded, nextHash);
    }

    /// @inheritdoc IStarterSetLoaderV2
    function complete() external nonReentrant {
        IBoxCoordinatorV2 c = _live();
        if (_loaded != _argUint(72, 4) || _remainingHash() != bytes32(0)
            || !IShopVaultV2(_argAddress(20)).seedReady()) revert InvalidRequest();
        _notified = true;
        // Mandatory atomic notice, not an optional poke. Refusal undoes _notified for anyone to retry.
        c.starterSetLoaded();
    }

    /// @inheritdoc IStarterSetLoaderV2
    function progress() external view returns (uint32 loaded, bytes32 remainingHash, bool notified) {
        _configured();
        return (_loaded, _remainingHash(), _notified);
    }

    function _remainingHash() private view returns (bytes32) { return _loaded == 0 ? _argWord(40) : _remaining; }

    function _configured() private view {
        if (address(this).code.length != BoxClones.ARGS_OFFSET + M2SeamArgs.STARTER_LENGTH
            || !BoxClones.isCloneOf(address(this), _implementation)) revert InvalidRequest();
        uint256 n = _argUint(72, 4);
        if ((n == 0) != (_argWord(40) == bytes32(0)) || (n != 0 && (n < 10 || n > 10000))) revert InvalidRequest();
    }

    function _live() private view returns (IBoxCoordinatorV2 c) {
        _configured();
        c = IBoxCoordinatorV2(_argAddress(0));
        if (!BoxClones.isCloneOf(address(c), coordinatorImplementation) || c.starterSetLoader() != address(this)
            || c.vault() != _argAddress(20) || _notified || c.failed() || c.graduated() || c.gateOpen()) {
            revert InvalidRequest();
        }
    }
}
