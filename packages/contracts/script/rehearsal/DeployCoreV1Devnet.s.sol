// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DeployCoreV1} from "../DeployCoreV1.s.sol";

/// @title DeployCoreV1Devnet (local devnet rehearsals only; never Sepolia, never mainnet)
/// @notice script/DeployCoreV1.s.sol as it is, but for Sepolia's Glamsterdam time, which is 0 here: on a local devnet
/// with Sepolia's chain id whose genesis already runs Amsterdam (amsterdamTime 0; docs/evidence/SH-glamsterdam-after.md,
/// geth v1.17.7 `--dev`) the script's post-fork rules (the runbook's Z1 = after: the acknowledgement, forge's EVM
/// charging EIP-8037, each step's execution gas and planned limit) apply at today's clock, so box 0's life after the
/// deploy can post drand rounds that exist today. Every other guard is the script's own. It refuses any chain past
/// block DEVNET_MAX_BLOCK, so it never runs on Sepolia (past block 11.8 million) or mainnet.
contract DeployCoreV1Devnet is DeployCoreV1 {
    uint256 public constant DEVNET_MAX_BLOCK = 1_000_000;

    error NotADevnet(uint256 blockNumber);

    function _glamsterdamSepolia() internal view override returns (uint256) {
        if (block.number >= DEVNET_MAX_BLOCK) revert NotADevnet(block.number);
        return 0;
    }
}
