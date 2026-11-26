// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LocalV2Custody} from "../local/DeployCoreV2Local.s.sol";

/// @title BnbTestnet
/// @notice The guard and the public addresses of the BNB Chain test network (chain id 97) for the scripts in this
/// folder. A separate opt-in: the local guards (`LocalTwin.check`, `LocalTwin.checkAlpha`) stay as they are.
/// A local rehearsal runs on an anvil node started with `--chain-id 97` or forking the test network, so the same
/// guard holds there.
library BnbTestnet {
    uint256 internal constant CHAIN_ID = 97;
    /// @notice The test network's wrapped BNB (WETH9 interface: deposit, withdraw, ERC-20).
    address internal constant WBNB = 0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd;
    /// @notice The official Uniswap v4 PoolManager of chain 56. Measured on 25 November 2026: no code at this address on
    /// chain 97 (none of chain 56's v4 addresses has code there). Used only if one ever answers on 97.
    address internal constant V4_POOL_MANAGER_56 = 0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF;

    error NotBnbTestnet(uint256 chainId);
    error NotAnvil(string client);

    /// @param chainId `block.chainid`
    function check(uint256 chainId) internal pure {
        if (chainId != CHAIN_ID) revert NotBnbTestnet(chainId);
    }

    /// @notice For the rehearsal-only entry points: the node must be anvil (its `web3_clientVersion` starts "anvil/").
    function checkAnvil(string memory client) internal pure {
        bytes memory c = bytes(client);
        bytes memory prefix = bytes("anvil/");
        if (c.length < prefix.length) revert NotAnvil(client);
        for (uint256 i; i < prefix.length; ++i) {
            if (c[i] != prefix[i]) revert NotAnvil(client);
        }
    }
}

/// @notice A test-network holding contract owned by the deployer: one of the release's two fee addresses, and the
/// lister of the listing registry and the fee-module directory. Not a Safe: the Safe-shaped reads of `LocalV2Custody`
/// describe one owner and threshold 1. The owner alone sends its calls; no signature scheme is simulated.
contract BnbTestnetCustody is LocalV2Custody {
    error CallFailed(bytes reason);

    constructor(address[] memory owners) LocalV2Custody(owners, 1) {
        BnbTestnet.check(block.chainid);
        require(owners.length == 1 && owners[0] != address(0), "one owner");
    }

    /// @notice Owner only: one call with this contract as the sender (register a fee module, change a raise, move
    /// fees). A refused call reverts with its reason.
    function execute(address to, uint256 value, bytes calldata data) external returns (bytes memory result) {
        require(msg.sender == this.getOwners()[0], "local owner only");
        bool ok;
        (ok, result) = to.call{value: value}(data);
        if (!ok) revert CallFailed(result);
    }
}
