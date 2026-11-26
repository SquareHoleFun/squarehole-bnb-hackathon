// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {RoyaltyDestination} from "../../box/interfaces/BoxTypes.sol";

/// @notice Income inbox arguments: 45 bytes after the 51-byte receiving clone runtime.
/// The coordinator already fixes receiver, P, T and listing registry; never copy those addresses again.
library BoxRoyaltyRouterV2Args {
    uint256 internal constant COORDINATOR = 0;
    uint256 internal constant WETH = 20;
    uint256 internal constant DESTINATION = 40;
    uint256 internal constant VERSION = 41;
    uint256 internal constant LENGTH = 45;
    error ListVersionOverflow();

    function encode(address coordinator, address weth, RoyaltyDestination destination)
        internal pure returns (bytes memory)
    {
        return abi.encodePacked(coordinator, weth, uint8(destination));
    }
    function withSnapshot(bytes memory args, uint256 version) internal pure returns (bytes memory) {
        if (version > type(uint32).max) revert ListVersionOverflow();
        return abi.encodePacked(args, uint32(version));
    }
}
