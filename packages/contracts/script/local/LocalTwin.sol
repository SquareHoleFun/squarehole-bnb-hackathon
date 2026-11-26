// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title LocalTwin
/// @notice LOCAL ONLY (S10a § 7.1): the guard of the local core v1 scripts (DeployCoreV1Local, CoreV1LocalLife). They
/// run only on an anvil node using Sepolia's chain id (a "local twin": factory v1 accepts only a drand source pinned for
/// its chain), so they can never send to Sepolia itself, to mainnet or to any other node.
library LocalTwin {
    uint256 internal constant CHAIN_ID = 11_155_111;

    error NotLocalTwin(uint256 chainId);
    error NotAnvil(string client);

    /// @param chainId `block.chainid`
    /// @param client the node's `web3_clientVersion` (anvil answers "anvil/v<version>")
    function check(uint256 chainId, string memory client) internal pure {
        if (chainId != CHAIN_ID) revert NotLocalTwin(chainId);
        _anvil(client);
    }

    /// @notice Separate opt-in for the alpha; never broadens the existing local twin guard.
    function checkAlpha(uint256 chainId, string memory client) internal pure {
        if (chainId != 31337) revert NotLocalTwin(chainId);
        _anvil(client);
    }

    function _anvil(string memory client) private pure {
        bytes memory c = bytes(client);
        bytes memory prefix = bytes("anvil/");
        if (c.length < prefix.length) revert NotAnvil(client);
        for (uint256 i; i < prefix.length; ++i) {
            if (c[i] != prefix[i]) revert NotAnvil(client);
        }
    }
}
