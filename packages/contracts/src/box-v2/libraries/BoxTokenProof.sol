// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxCoordinator} from "../../box/interfaces/IBoxCoordinator.sol";
import {IBoxRegistry} from "../../box/interfaces/IBoxRegistry.sol";
import {IBoxToken} from "../../box/interfaces/IBoxToken.sol";
import {BoxClones} from "../../box/libraries/BoxClones.sol";
import {IBoxFactoryV2} from "../interfaces/IBoxCoordinatorV2.sol";
import {BoxRolesV2, IBoxRegistryV2} from "../interfaces/IBoxRegistryV2.sol";
import {BoxTokenV2Args} from "../interfaces/IBoxTokenV2.sol";
import {IListingRegistry, ListingRefusal} from "../interfaces/IListingRegistry.sol";

/// @title BoxTokenProof
/// @notice Internal listing callers authenticate a box coin through this release or its fixed directory, then
/// require graduation. No sampler, outside route or price read; no funds move. The untrusted initialHolder read
/// is bounded; recorded coordinator/registry reads fail closed. This release's T must be its exact clone at nonce 1.
library BoxTokenProof {
    /// @dev Integrator decision 2026-10-07, M1 change queue 9: T is the coordinator's FIRST CREATE (EIP-161).
    /// RLP below supports nonce 1 only.
    uint256 private constant TOKEN_CREATE_NONCE = 1;

    /// @notice The gas the `initialHolder()` read may spend. The cold-clone test in
    /// `test/box-v2/m1-20c/BoxTokenProof.t.sol` proves at least twice the measured need, including caller overhead,
    /// under the default EVM and Amsterdam. M1-60 must measure the final wired release token again.
    uint256 internal constant INITIAL_HOLDER_GAS = 30_000;

    /// @notice A box proved through a registry: where it was read and what its coordinator names.
    struct Proof {
        uint8 registryIndex;
        uint256 boxId;
        /// This release's box registry (index 0) or `directory()[registryIndex - 1]`.
        address registry;
        /// `registry.coordinatorOf(boxId)`.
        address coordinator;
        /// `coordinator.token()`.
        address token;
        /// `coordinator.hook()`, recorded identity only.
        address hook;
        /// `coordinator.q()`: the box's pricing token (address(0): ETH).
        address pricingToken;
    }

    /// @notice The `initialHolder()` read could not get its whole cap: the caller passed too little gas, so a false
    /// answer would not be a proof (fail closed).
    error HolderReadGasShort();

    // ============================================================================================ the reverse proof

    /// @notice Whether `token` is a Square Hole box token of this release's registry or one in its directory.
    function isBoxToken(address boxRegistry, address token) internal view returns (bool) {
        (bool found,) = findBox(boxRegistry, token);
        return found;
    }

    /// @notice Internal admission callers obtain the authenticated reverse proof; no funds move or price is read.
    function findBox(address boxRegistry, address token) internal view returns (bool found, Proof memory proof) {
        (bool clean, address holder) = _initialHolder(token);
        if (!clean) return (false, proof);
        address[] memory registries = registriesOf(boxRegistry);
        for (uint256 i; i < registries.length; ++i) {
            IBoxRegistry registry = IBoxRegistry(registries[i]);
            // forge-lint: disable-next-line(calls-loop)
            (bool recorded, uint256 boxId) = registry.boxIdOf(holder);
            if (!recorded) continue;
            // forge-lint: disable-next-line(calls-loop)
            if (boxId >= registry.boxCount() || registry.coordinatorOf(boxId) != holder) return (false, proof);
            // forge-lint: disable-next-line(calls-loop)
            if (IBoxCoordinator(holder).token() != token || (i == 0 && !_isReleaseToken(boxRegistry, holder, token))) return (false, proof);
            if (i > type(uint8).max) _refuse(ListingRefusal.REGISTRY_UNKNOWN);
            // The fixed directory index was bounded above; coordinator views belong to the trusted registry.
            // forge-lint: disable-next-line(unsafe-typecast)
            proof = Proof(uint8(i), boxId, registries[i], holder, token, IBoxCoordinator(holder).hook(), IBoxCoordinator(holder).q());
            return (true, proof);
        }
    }

    // ============================================================================================ proof and state

    /// @notice The forward proof and the state together: what manual admission checks.
    function proveBox(address boxRegistry, uint8 registryIndex, uint256 boxId)
        internal
        view
        returns (Proof memory proof)
    {
        proof = prove(boxRegistry, registryIndex, boxId);
        checkState(proof);
    }

    /// @notice Registry, coordinator, token, hook and pricing token of box `boxId` at `registryIndex`; no state read.
    function prove(address boxRegistry, uint8 registryIndex, uint256 boxId) internal view returns (Proof memory proof) {
        address[] memory registries = registriesOf(boxRegistry);
        if (registryIndex >= registries.length) _refuse(ListingRefusal.REGISTRY_UNKNOWN);
        IBoxRegistry registry = IBoxRegistry(registries[registryIndex]);
        if (boxId >= registry.boxCount()) _refuse(ListingRefusal.BOX_UNKNOWN);
        IBoxCoordinator coordinator = IBoxCoordinator(registry.coordinatorOf(boxId));
        (bool recorded, uint256 returnedId) = registry.boxIdOf(address(coordinator));
        if (!recorded || returnedId != boxId) _refuse(ListingRefusal.BOX_UNKNOWN);
        address token = coordinator.token();
        (bool clean, address holder) = _initialHolder(token);
        if (!clean || holder != address(coordinator)) _refuse(ListingRefusal.BOX_UNKNOWN);
        if (registryIndex == 0 && !_isReleaseToken(boxRegistry, address(coordinator), token)) {
            _refuse(ListingRefusal.BOX_UNKNOWN);
        }
        proof = Proof({
            registryIndex: registryIndex,
            boxId: boxId,
            registry: address(registry),
            coordinator: address(coordinator),
            token: token,
            hook: coordinator.hook(),
            pricingToken: coordinator.q()
        });
    }

    /// @notice Manual admission requires graduation; no sampler or price readiness.
    function checkState(Proof memory proof) internal view {
        if (!IBoxCoordinator(proof.coordinator).graduated()) _refuse(ListingRefusal.NOT_GRADUATED);
    }

    /// @notice The registries a box may be proved through, in index order: this release's, then its fixed directory.
    function registriesOf(address boxRegistry) internal view returns (address[] memory registries) {
        address[] memory directory = IBoxRegistryV2(boxRegistry).directory();
        registries = new address[](directory.length + 1);
        registries[0] = boxRegistry;
        for (uint256 i; i < directory.length; ++i) {
            registries[i + 1] = directory[i];
        }
    }

    // ============================================================================================ helpers

    /// This release only: v1's full token in the directory is not a clone and has its own CREATE plan.
    function _isReleaseToken(address boxRegistry, address coordinator, address token) private view returns (bool) {
        if (token.code.length != BoxClones.ARGS_OFFSET + BoxTokenV2Args.LENGTH) return false;
        // RLP([coordinator, 1]) = 0xd6 (22-byte list) || 0x94 (20-byte address) || coordinator || 0x01.
        // The fixed nonce fits one byte.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes32 hash = keccak256(abi.encodePacked(hex"d694", coordinator, uint8(TOKEN_CREATE_NONCE)));
        // CREATE intentionally takes the low 160 bits of that hash.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (token != address(uint160(uint256(hash)))) return false;
        // Fixed factory views; the reverse loop reaches these at most once, then immediately returns.
        // forge-lint: disable-next-line(calls-loop)
        address factory = IBoxRegistryV2(boxRegistry).factory();
        // forge-lint: disable-next-line(calls-loop)
        return BoxClones.isCloneOf(token, IBoxFactoryV2(factory).implementation(BoxRolesV2.ROLE_TOKEN));
    }

    /// The token's `initialHolder()` by a staticcall capped at `INITIAL_HOLDER_GAS`: `clean` only for exactly one word
    /// with no bits above the address. Reverts `HolderReadGasShort` when the call could not have had its whole cap.
    function _initialHolder(address token) private view returns (bool clean, address holder) {
        bytes4 selector = IBoxToken.initialHolder.selector;
        uint256 cap = INITIAL_HOLDER_GAS;
        bool ok;
        uint256 word;
        assembly ("memory-safe") {
            mstore(0, selector)
            ok := staticcall(cap, token, 0, 4, 0, 32)
            ok := and(ok, eq(returndatasize(), 32))
            word := mload(0)
        }
        // EIP-150: a read starved below its need was handed some g < need and leaves this frame at most g / 63 <
        // need / 63 <= cap / 63; a read that got its whole cap leaves at least cap / 63, less a few gas after the call.
        if (gasleft() < cap / 63) revert HolderReadGasShort();
        clean = ok && word >> 160 == 0;
        // forge-lint: disable-next-line(unsafe-typecast)
        holder = address(uint160(word));
    }

    function _refuse(ListingRefusal reason) private pure {
        revert IListingRegistry.ListingRefused(reason);
    }
}
