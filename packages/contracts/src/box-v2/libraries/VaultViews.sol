// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {BoxShuffle} from "../../box/libraries/BoxShuffle.sol";
import {IBoxVaultV2} from "../interfaces/IBoxVaultV2.sol";

/// @notice Stateless vault code part, fixed at implementation construction; ordinary STATICCALL only.
/// Holds no storage or funds; all quotes use explicit pre-operation inputs supplied by the vault.
contract VaultViews {
    /// @notice Anyone may compute the unchanged inverse item permutation; no funds move.
    function invert(bytes32 word, uint256 offset, uint256 n) external pure returns (uint256) {
        (uint256 u, uint256 v) = BoxShuffle.halves(n);
        return BoxShuffle.invert(word, offset, n, u, v);
    }

    /// @notice Anyone may compute a withdrawal principal; the vault owns custody and caller checks.
    function quoteWithdraw(uint256 k, uint256 n, uint256 a) external pure returns (uint256) {
        if (k == 0 || k > n) revert IBoxVaultV2.InvalidQuantity(k, n);
        if (k == n) revert IBoxVaultV2.LastItem();
        return FullMath.mulDivRoundingUp(a, k, n);
    }

    /// @notice Anyone may compute a return principal, with the original quantity and unit-floor refusals.
    function quoteReturn(uint256 k, uint256 n, uint256 m, uint256 a) external pure returns (uint256 principal) {
        if (k == 0 || k > m) revert IBoxVaultV2.InvalidQuantity(k, m);
        principal = FullMath.mulDiv(a, k, n);
        if (principal < k) revert IBoxVaultV2.ReturnBelowUnit(principal, k);
    }

    /// @notice Anyone may compute the rounded-up fee in full precision; no funds move.
    function fee(uint256 principal, uint256 bps) external pure returns (uint256) {
        return bps == 0 ? 0 : FullMath.mulDivRoundingUp(principal, bps, 10_000);
    }

    /// @notice Anyone may compute the live escrow surplus; failure accounting remains in the vault.
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
