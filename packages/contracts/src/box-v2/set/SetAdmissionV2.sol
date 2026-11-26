// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetReason as R} from "./SetConstantsV2.sol";
import {SetRefused} from "./SetTypesV2.sol";

/// @notice Stateless, code-only admission for the existing-NFT add-on; never a guarantee of future transferability.
/// @dev All foreign execution is STATICCALL. Call requireToken on EVERY intake, even after prior admission.
/// Do not call admission from failure entry/recovery: later issuer restrictions must not gate recovery attempts.
library SetAdmissionV2 {
    uint256 internal constant PROBE_GAS = 30_000;
    // At the check immediately before STATICCALL: 30,000 + ceil(30,000/63) + 2,600 cold access
    // + instruction/memory overhead + a reserve for the refusal. Covers EIP-150 on both supported EVMs.
    uint256 internal constant MIN_PROBE_GAS = 40_000;
    // ERC721A ownerOf walks uninitialized ownership slots. Keep interface/optional probes at 30k.
    uint256 internal constant OWNER_GAS = 300_000;
    // 300k + ceil(300k/63) + 2,600 cold access + instruction/memory/refusal reserve.
    uint256 internal constant MIN_OWNER_GAS = 320_000;
    bytes4 private constant ERC165 = 0x01ffc9a7;
    bytes4 private constant ERC721 = 0x80ac58cd;
    bytes4 private constant ERC5192 = 0xb45a3c0e;

    /// @notice Factory-level checks. The return value is an observation, never a cacheable intake permission.
    function requireCollection(address collection) internal view returns (bool supportsLocks) {
        if (collection.code.length == 0) revert SetRefused(R.COLLECTION_NO_CODE, 10);
        if (!_interface(collection, ERC165) || _interface(collection, 0xffffffff) || !_interface(collection, ERC721)) {
            revert SetRefused(R.INTERFACE_REFUSED, 10);
        }

        (bool ok, uint256 size,) = _probe(collection, abi.encodeWithSignature("getTransferValidator()"));
        // Every nonempty successful answer is refused: canonical addresses (including zero) and malformed data.
        // Revert/OOG/empty means undetected, not a claim that the collection has no transfer restrictions.
        if (ok && size != 0) revert SetRefused(R.TRANSFER_VALIDATOR, 10);
        return _interface(collection, ERC5192);
    }

    /// @notice Repeat collection rules and, when advertised, require canonical locked(id) == false.
    function requireToken(address collection, uint256 id) internal view {
        if (requireCollection(collection)) {
            (bool ok, uint256 size, uint256 word) = _probe(collection, abi.encodeWithSignature("locked(uint256)", id));
            if (!ok || size != 32 || word != 0) revert SetRefused(R.LOCK_REFUSED, 10);
        }
    }

    /// @notice Bounded exact owner observation for before/after custody checks; approval is not ownership.
    /// @dev Does not imply membership or a transfer occurred. E-03 must also bind/consume the expected receipt.
    function requireOwner(address collection, uint256 id, address expected) internal view {
        (bool ok, uint256 size, uint256 word) =
            _probe(collection, abi.encodeWithSelector(bytes4(0x6352211e), id), OWNER_GAS, MIN_OWNER_GAS);
        if (!ok || size != 32 || expected == address(0) || word != uint256(uint160(expected))) {
            revert SetRefused(R.OWNER_MISMATCH, 10);
        }
    }

    function _interface(address collection, bytes4 id) private view returns (bool) {
        (bool ok, uint256 size, uint256 word) = _probe(collection, abi.encodeWithSelector(ERC165, id));
        if (!ok || size != 32 || word > 1) revert SetRefused(R.INTERFACE_REFUSED, 10);
        return word == 1;
    }

    function _probe(address target, bytes memory data) private view returns (bool ok, uint256 size, uint256 word) {
        return _probe(target, data, PROBE_GAS, MIN_PROBE_GAS);
    }

    function _probe(address target, bytes memory data, uint256 stipend, uint256 minimum)
        private
        view
        returns (bool ok, uint256 size, uint256 word)
    {
        // A caller must not starve an optional query and turn a present validator into an apparent absence.
        if (gasleft() < minimum) revert SetRefused(R.PROBE_GAS, 10);
        assembly ("memory-safe") {
            mstore(0, 0)
            ok := staticcall(stipend, target, add(data, 32), mload(data), 0, 32)
            size := returndatasize()
            word := mload(0)
        }
    }
}
