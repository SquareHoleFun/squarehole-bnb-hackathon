// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Core v2 M1: a wave-1 library frozen as a stub before wave 1 (wave 0's integrated review, finding M3; file map § 2, §
// 1 rule 8). Its owner, M1-40-a, writes the bodies and may add entries; the entries below are called by the vault copy
// (M1-30-b) in wave 1, so a change to one goes through the integrator. Signatures [P]: the integrator's, from the
// frozen interfaces they serve. Bodies: M1-40-a (BC-232; ADR-0017 § 2). Pure, so it keeps no storage (rule 3).

/// @title VaultCountIntegral (the vault's count integral)
/// @notice `Ctx`'s time-averaged vault count (ADR-0017 § 2; `IBoxVaultCountV2`).
library VaultCountIntegral {
    /// @notice An entry its owner has not built yet.
    error NotBuilt();

    /// @notice The vault's count integral carried from `since` to `at` at `insideCount` items inside (item-seconds;
    /// `IBoxVaultCountV2.insideIntegral`).
    /// @dev No time (or `at` before `since`): no change, so a stale reading never lowers the integral.
    function advance(uint256 integral, uint64 since, uint32 insideCount, uint64 at) internal pure returns (uint256) {
        if (at <= since) return integral;
        return integral + uint256(insideCount) * (at - since);
    }

    /// @notice `insideAvgBps` = (toIntegral - fromIntegral) x 10,000 / (collectionSize x (toTime - fromTime)), 0 for a
    /// token-only box (`Ctx.insideAvgBps`).
    /// @dev Rounded down; 0 with no time between the readings or an integral that did not rise; at most 10,000.
    function insideAvgBps(
        uint256 fromIntegral,
        uint64 fromTime,
        uint256 toIntegral,
        uint64 toTime,
        uint32 collectionSize
    ) internal pure returns (uint16) {
        if (collectionSize == 0 || toTime <= fromTime || toIntegral <= fromIntegral) return 0;
        uint256 bps = (toIntegral - fromIntegral) * 10_000 / (uint256(collectionSize) * (toTime - fromTime));
        // casting to 'uint16' is safe because bps is at most 10,000 here
        // forge-lint: disable-next-line(unsafe-typecast)
        return bps > 10_000 ? 10_000 : uint16(bps);
    }
}
