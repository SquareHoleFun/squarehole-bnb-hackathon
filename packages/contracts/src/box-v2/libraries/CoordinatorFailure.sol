// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IBoxToken} from "../../box/interfaces/IBoxToken.sol";
import {IBoxVaultV2} from "../interfaces/IBoxVaultV2.sol";
import {IBoxCoordinatorV2, FailCause} from "../interfaces/IBoxCoordinatorV2.sol";
import {BoxCoordinatorV2Args as A} from "./BoxCoordinatorV2Args.sol";

/// @notice Internal failure state and the exact C11 denominator. The coordinator owns all caller checks and transfers.
library CoordinatorFailure {
    /// @custom:storage-location erc7201:squarehole.v2.BoxCoordinatorV2.CoordinatorFailure
    struct Layout {
        uint64 failedAt;
        FailCause cause;
        uint256 tLeft;
        // Failure-time pot less actual tip, plus subsequent completed inbox intake, less paid claims.
        uint256 creatorRemainder;
        bool creatorClaimPending;
        // Fixed at failure; never inferred from tLeft after holders finish claiming.
        bool creatorOnly;
    }

    bytes32 internal constant LAYOUT_SLOT = 0xb5b03c45a32d51b2ec8de44fb2808f326c10a8d334b29e9265d5e88bcc6c4c00;

    /// @notice Internal coordinator access to its namespaced state; no funds move.
    function _layout() internal pure returns (Layout storage s) {
        bytes32 slot = LAYOUT_SLOT;
        assembly ("memory-safe") { s.slot := slot }
    }

    /// @notice Coordinator only through its guarded failure entries; records once, before any failure step.
    function record(FailCause cause) internal {
        Layout storage s = _layout();
        if (s.cause != FailCause.None) revert IBoxCoordinatorV2.AlreadyFailed();
        assert(cause != FailCause.None);
        // The release's timestamps fit uint64.
        // forge-lint: disable-next-line(unsafe-typecast)
        s.failedAt = uint64(block.timestamp);
        s.cause = cause;
        emit IBoxCoordinatorV2.BoxFailed(msg.sender, cause, block.timestamp);
    }

    /// @notice Internal coordinator call after close, vault freeze and all burns. Reads balances once; no saturation.
    function fixOutstanding(IPoolManager pm, address token, address hook, address receiver, address vault, uint256 closedTResidue, uint8 vaultKind)
        internal
        returns (uint256 left)
    {
        IBoxToken t = IBoxToken(token);
        uint256 id = uint256(uint160(token));
        uint256 held = _heldT(pm, t, address(this), id) + _heldT(pm, t, hook, id) + _heldT(pm, t, receiver, id);
        uint256 k;
        if ((vaultKind == A.PILE_KIND || vaultKind == A.SHOP_KIND) && vault != address(0)) {
            // M2 rule 9 excludes quarantined SHOP custody. S5 adds authenticated PILE custody;
            // the kinds are exclusive, so neither receives a second exclusion or collection K.
            held += _heldT(pm, t, vault, id);
        } else if (vault != address(0)) {
            try IBoxVaultV2(vault).escrowSurplus() returns (uint256 floor, uint256) {
                k = floor;
            } catch {}
            uint256 balance = t.balanceOf(vault);
            if (k > balance) {
                emit IBoxCoordinatorV2.EscrowSurplusClipped(k, balance);
                k = balance;
            }
        }
        // The hook reports only its closed pool's exact inventory. Shared manager holdings can
        // also back outside claims/positions and must remain in the holder denominator.
        left = t.totalSupply() - held - k - closedTResidue;
        _layout().tLeft = left;
    }

    /// @dev Internal fixed-part custody read, including unredeemed T claims; no money moves.
    function _heldT(IPoolManager pm, IBoxToken t, address owner, uint256 id) private view returns (uint256) {
        return t.balanceOf(owner) + pm.balanceOf(owner, id);
    }

    /// @notice Internal state reader; no money moves.
    function failed() internal view returns (bool) {
        return _layout().cause != FailCause.None;
    }

    /// @notice Internal state reader; no money moves.
    function failedAt() internal view returns (uint256) {
        return _layout().failedAt;
    }

    /// @notice Internal state reader; no money moves.
    function failCause() internal view returns (FailCause) {
        return _layout().cause;
    }
}
