// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Gas allocations for the measured rehearsal specimens. Creation adds intrinsic
/// to its measured entry budget; the remaining envelopes already include intrinsic gas.
/// Production callees retain their named stipends and EIP-150 admission checks.
library SepoliaV2Gas {
    uint256 internal constant CAP = 16_777_216;
    uint256 internal constant CREATE = 16_500_000;
    uint256 internal constant GRADUATE = 13_500_000;
    /// @dev fail() / failClosed(): the keeper's 15M floor and the Sepolia runbook's live row (a price coin that exhausts
    /// the router sweep, the inbox sweep and the tip needs up to 12,815,029 submitted gas on Amsterdam, rc7 GK-1).
    uint256 internal constant FAIL = 15_000_000;
    uint256 internal constant ORDINARY = 15_000_000;
    uint256 internal constant RETURN_STARTER = 2_000_000;

    function creationEnvelope(bytes memory data) internal pure returns (uint256 envelope) {
        envelope = CREATE + intrinsic(data);
        require(envelope <= CAP, "Sepolia creation transaction cap");
    }

    /// @dev All calldata bytes treated as nonzero at the calldata floor, without refunds.
    function intrinsic(bytes memory data) internal pure returns (uint256) {
        return 21_000 + 40 * data.length;
    }

    function callGas(uint256 envelope, bytes memory data) internal pure returns (uint256) {
        require(envelope <= CAP, "Sepolia transaction cap");
        return envelope - intrinsic(data);
    }

    /// @dev A test/script CALL needs an extra EIP-150 reserve to deliver the full top-level
    /// transaction budget. This outer harness reserve is not added to the signed transaction.
    function requireCallerGas(uint256 budget) internal view {
        require(gasleft() >= budget + (budget + 62) / 63 + 50_000, "rehearsal EIP-150 reserve");
    }
}
