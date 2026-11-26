// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Immutable custody identity for the separate existing-NFT release, not BoxVaultV2's range layout.
struct SetVaultV2Config {
    address coordinator;
    address token;
    address starterSetLoader;
    address creator;
    address collection;
    uint32 count;
    bytes32 setHash;
    uint16 pickFeeBps;
}

/// @notice Packed clone arguments. E-06 must encode role 3 separately from BoxFactoryV2Parts.
library SetVaultV2Args {
    uint256 internal constant COORDINATOR = 0;
    uint256 internal constant TOKEN = 20;
    uint256 internal constant LOADER = 40;
    uint256 internal constant CREATOR = 60;
    uint256 internal constant COLLECTION = 80;
    uint256 internal constant COUNT = 100;
    uint256 internal constant HASH = 104;
    uint256 internal constant PICK_FEE = 136;
    uint256 internal constant LENGTH = 138;

    /// @notice Encode data only; initialize authenticates all links and validates the fixed terms.
    function encode(SetVaultV2Config memory c) internal pure returns (bytes memory) {
        return abi.encodePacked(
            c.coordinator, c.token, c.starterSetLoader, c.creator, c.collection, c.count, c.setHash, c.pickFeeBps
        );
    }
}
