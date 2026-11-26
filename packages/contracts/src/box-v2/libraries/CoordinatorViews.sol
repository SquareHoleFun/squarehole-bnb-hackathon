// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {BoxRolesV2} from "../interfaces/IBoxRegistryV2.sol";
import {ReleaseConstantsV2} from "../interfaces/ReleaseConstantsV2.sol";
import {IBoxFactoryPileV2} from "../interfaces/IBoxCoordinatorV2.sol";

/// @notice Stateless coordinator code part, fixed at implementation construction; ordinary STATICCALL only.
/// Holds no storage or funds. Factory/caller checks and every state transition remain in the coordinator.
contract CoordinatorViews {
    error InvalidNonces();

    /// @notice Anyone may validate a proposed nonce table; no storage or funds are accessed.
    function checkNonces(uint256 n, bytes24 nonces) external pure {
        if (n == 0 || n > 127) revert InvalidNonces();
        if (uint8(nonces[BoxRolesV2.ROLE_TOKEN]) != ReleaseConstantsV2.TOKEN_CREATE_NONCE) {
            revert InvalidNonces();
        }
        uint256 seen;
        for (uint256 role; role < BoxRolesV2.ROLE_COUNT; ++role) {
            uint256 nonce = uint8(nonces[role]);
            if (nonce == 0) {
                if (
                    role == BoxRolesV2.ROLE_TOKEN || role == BoxRolesV2.ROLE_RECEIVER
                        || role == BoxRolesV2.ROLE_LAUNCH_ROUTER
                ) revert InvalidNonces();
                continue;
            }
            // The sole structural alias. The coordinator authenticates the created pile
            // before initializing its gate; a shop/share vault cannot use this exception.
            if (role == BoxRolesV2.ROLE_STARTER_SET_LOADER && nonce == uint8(nonces[BoxRolesV2.ROLE_VAULT])) continue;
            if (
                role == BoxRolesV2.ROLE_COORDINATOR || role == BoxRolesV2.ROLE_HOOK || role == BoxRolesV2.ROLE_EXECUTOR
                    || role == BoxRolesV2.ROLE_ITEM_STREAM || role == BoxRolesV2.ROLE_METADATA_TABLE || nonce > n
                    || seen & (1 << nonce) != 0
            ) revert InvalidNonces();
            seen |= 1 << nonce;
        }
    }

    /// @notice Anyone may check a created vault against the fixed factory's pile implementation.
    /// No state or money moves. A role-19/role-3 alias requires positive pile authentication.
    function isPile(address factory, address vault, address loader) external view returns (bool pile) {
        if (vault == address(0)) return false;
        pile = IBoxFactoryPileV2(factory).isPileVault(vault);
        if (!pile && loader == vault) revert InvalidNonces();
    }

    /// @notice Anyone may compute the unchanged pro-rata claim; the coordinator owns admission and payment.
    function quoteClaim(uint256 pot, uint256 t, uint256 left) external pure returns (uint256) {
        return t == left ? pot : FullMath.mulDiv(pot, t, left);
    }
}
