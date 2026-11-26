// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Test-only conservative transaction accounting. No refund discount; the calldata floor is also imposed on
/// Cancun for one shared upper-bound rule, although that fork does not require the later calldata floor.
library GasBudget {
    function tokens(bytes memory data) internal pure returns (uint256 n) {
        for (uint256 i; i < data.length; ++i) {
            n += data[i] == 0 ? 1 : 4;
        }
    }

    function intrinsic(bytes memory data) internal pure returns (uint256) {
        return 21_000 + 4 * tokens(data);
    }

    function transaction(uint256 callDelta, bytes memory data) internal pure returns (uint256) {
        uint256 n = tokens(data);
        uint256 total = callDelta + 21_000 + 4 * n;
        uint256 floor = 21_000 + 10 * n;
        return total > floor ? total : floor;
    }
}
