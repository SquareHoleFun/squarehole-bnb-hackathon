// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice TEST ONLY. The launch-window schedule written out independently of `LaunchTaxRouter`: research
/// docs/research/sniper-tax.md § 3.1, tax(b) = 1 − k^(−(32 − b) / 32) for b = 0 … 31, rounded to the nearest pip, with
/// k = P1 / P0 of the launch shape (`FitLaunchShape`: ticks 177,180 … 204,060, so k = 1.0001^26,880 ≈ 14.700266).
/// Computed with 80-digit Decimal arithmetic (`script-py/launch_tax_table.py`); no entry lies within 0.0128 pips of a
/// rounding boundary, so the on-chain recomputation from TickMath (`test/v2/LaunchTaxTable.t.sol`) must agree exactly.
/// The research's own list (k = 14.69, ADR-0013's value before tick alignment) is 20 to 96 pips lower per entry.
library LaunchTaxTestKit {
    uint256 internal constant WINDOW = 32;
    uint256 internal constant PIPS = 1_000_000;

    function pips(uint256 b) internal pure returns (uint256) {
        if (b >= WINDOW) return 0;
        uint24[32] memory t = [
            uint24(931_974),
            926_013,
            919_530,
            912_479,
            904_810,
            896_469,
            887_397,
            877_531,
            866_799,
            855_128,
            842_433,
            828_627,
            813_610,
            797_278,
            779_515,
            760_195,
            739_182,
            716_328,
            691_472,
            664_437,
            635_033,
            603_054,
            568_271,
            530_441,
            489_297,
            444_547,
            395_875,
            342_939,
            285_365,
            222_745,
            154_639,
            80_565
        ];
        return t[b];
    }

    /// @notice The tax on `value` wei sent in block `b` after the open: rounded up to the wei (research § 6).
    function tax(uint256 value, uint256 b) internal pure returns (uint256) {
        uint256 p = pips(b);
        return (value * p + PIPS - 1) / PIPS;
    }

    /// @notice Research § 3.1, the 32-entry list for k = 14.69 (for the comparison in the evidence only).
    function researchPips(uint256 b) internal pure returns (uint256) {
        uint24[32] memory t = [
            uint24(931_926),
            925_963,
            919_478,
            912_424,
            904_752,
            896_408,
            887_334,
            877_464,
            866_730,
            855_055,
            842_358,
            828_548,
            813_529,
            797_194,
            779_428,
            760_106,
            739_091,
            716_235,
            691_377,
            664_342,
            634_938,
            602_958,
            568_177,
            530_349,
            489_207,
            444_462,
            395_796,
            342_868,
            285_302,
            222_695,
            154_602,
            80_545
        ];
        return t[b];
    }
}
