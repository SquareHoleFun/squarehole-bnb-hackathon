// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {BoxShuffle} from "../../../src/box/libraries/BoxShuffle.sol";
import {IBoxVaultV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {BoxRolesV2} from "../../../src/box-v2/interfaces/IBoxRegistryV2.sol";
import {ReleaseConstantsV2} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";

// SIZE-2: frozen arithmetic/check bodies from a592d29f356ccc9b57de94ff5d8b37189d1887d9.
// Visibility and nonce reading are adapted for differential calls.
// M3-40 adds the single authenticated pile loader/vault structural alias.
contract ReferenceViews {
    error InvalidNonces();

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
            if (role == BoxRolesV2.ROLE_STARTER_SET_LOADER && nonce == uint8(nonces[BoxRolesV2.ROLE_VAULT])) continue;
            if (
                role == BoxRolesV2.ROLE_COORDINATOR || role == BoxRolesV2.ROLE_HOOK || role == BoxRolesV2.ROLE_EXECUTOR
                    || role == BoxRolesV2.ROLE_ITEM_STREAM || role == BoxRolesV2.ROLE_METADATA_TABLE || nonce > n
                    || seen & (1 << nonce) != 0
            ) revert InvalidNonces();
            seen |= 1 << nonce;
        }
    }

    function quoteClaim(uint256 pot, uint256 t, uint256 left) external pure returns (uint256) {
        return t == left ? pot : FullMath.mulDiv(pot, t, left);
    }

    function invert(bytes32 word, uint256 offset, uint256 n) external pure returns (uint256) {
        (uint256 u, uint256 v) = BoxShuffle.halves(n);
        return BoxShuffle.invert(word, offset, n, u, v);
    }

    function quoteWithdraw(uint256 k, uint256 n, uint256 a) external pure returns (uint256) {
        if (k == 0 || k > n) revert IBoxVaultV2.InvalidQuantity(k, n);
        if (k == n) revert IBoxVaultV2.LastItem();
        return FullMath.mulDivRoundingUp(a, k, n);
    }

    function quoteReturn(uint256 k, uint256 n, uint256 m, uint256 a) external pure returns (uint256 principal) {
        if (k == 0 || k > m) revert IBoxVaultV2.InvalidQuantity(k, m);
        principal = FullMath.mulDiv(a, k, n);
        if (principal < k) revert IBoxVaultV2.ReturnBelowUnit(principal, k);
    }

    function fee(uint256 principal, uint256 bps) external pure returns (uint256) {
        return bps == 0 ? 0 : FullMath.mulDivRoundingUp(principal, bps, 10_000);
    }

    function surplus(uint256 e, uint256 m, uint256 a, uint256 n)
        external
        pure
        returns (uint256 kFloor, uint256 kRemainder)
    {
        kFloor = e - FullMath.mulDivRoundingUp(m, a, n);
        uint256 r0 = mulmod(m, a, n);
        kRemainder = r0 == 0 ? 0 : n - r0;
    }
}
