// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Internal M2 wiring encoders for the planner; plain boxes never use these argument layouts.
/// @dev Fixed fields are packed big-endian. The creator is read from the authenticated coordinator.
library M2SeamArgs {
    uint256 internal constant HOLDER_LENGTH = 100; // coordinator 0, token 20, hook 40, receiver 60, P 80
    uint256 internal constant SHOP_PREFIX_LENGTH = 60; // coordinator 0, token 20, loader 40, contents 60
    uint256 internal constant STARTER_LENGTH = 76; // coordinator 0, shop 20, setHash 40, uint32 count 72

    /// @notice Planner encodes immutable holder wiring; no funds move and no holder implementation is supplied.
    function holder(address c, address t, address h, address r, address p) internal pure returns (bytes memory) {
        return abi.encodePacked(c, t, h, r, p);
    }
    /// @notice Planner encodes shop wiring and the committed opaque contents payload; no funds move.
    function shop(address c, address t, address loader, bytes calldata contents) internal pure returns (bytes memory) {
        return abi.encodePacked(c, t, loader, contents);
    }
    /// @notice Planner encodes bounded starter commitment data; no NFTs are pulled by encoding or creation.
    function starter(address c, address shop_, bytes32 setHash, uint32 count) internal pure returns (bytes memory) {
        return abi.encodePacked(c, shop_, setHash, count);
    }
}
