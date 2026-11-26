// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title BoxLaunchRouterV2Args (core v2 M1, ticket M1-30-a; file map § 1 rule 9: the owner's layout)
/// @notice The launch router clone's immutable arguments, packed after the 45-byte EIP-1167 proxy (116 bytes). v1's
/// layout (`BoxLaunchRouter.sol:39-41`) less the kind (every v2 box is `Standard`) and the open (taken from the
/// coordinator, `IBoxOpenGateV2`), plus the box's `bootstrapQ` in P.
library BoxLaunchRouterV2Args {
    /// @notice A bootstrap above 2^128 − 1.
    error AmountTooLarge(uint256 amount);

    /// @dev Encoders/readers use P as data; no funds move.
    uint256 internal constant P = 0; // address (address(0): ETH); the pool's currency0
    /// @dev Encoders/readers use TOKEN as data; no funds move.
    uint256 internal constant TOKEN = 20; // address
    /// @dev Encoders/readers use HOOK as data; no funds move.
    uint256 internal constant HOOK = 40; // address
    /// @dev Encoders/readers use COORDINATOR as data; no funds move.
    uint256 internal constant COORDINATOR = 60; // address
    /// @dev Encoders/readers use SQRT_P1 as data; no funds move.
    uint256 internal constant SQRT_P1 = 80; // uint160: the curve's end, every buy's price limit
    /// @dev Encoders/readers use BOOTSTRAP_Q as data; no funds move.
    uint256 internal constant BOOTSTRAP_Q = 100; // uint128
    /// @dev Encoders/readers use LENGTH as data; no funds move.
    uint256 internal constant LENGTH = 116;

    /// @dev Internal callers may read encode; no funds move.
    function encode(address p, address token, address hook, address coordinator, uint160 sqrtP1, uint256 bootstrapQ)
        internal
        pure
        returns (bytes memory)
    {
        if (bootstrapQ > type(uint128).max) revert AmountTooLarge(bootstrapQ);
        // casting to 'uint128' is safe because the value was checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encodePacked(p, token, hook, coordinator, sqrtP1, uint128(bootstrapQ));
    }
}
