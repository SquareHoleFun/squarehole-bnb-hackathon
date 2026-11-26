// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IRuleSplitter} from "fee-rules/IRuleSplitter.sol";
import {PileVault} from "./PileVault.sol";
import {RulesVault} from "./RulesVault.sol";

/// @title PileDeployer and RulesVaultDeployer: the code that creates a rules launch's pile and splitter
/// @notice Split out of `RulesVaultFactory` so that factory stays under the contract size limit. Anyone may call them,
/// but every address they create is salted with the caller (`keccak256(abi.encode(msg.sender, token))`), so nobody can
/// take the address the factory will use for a token: a call by anyone else lands elsewhere. No owner, no state.
contract PileDeployer {
    function deploy(address token, address quote) external returns (address) {
        return address(new PileVault{salt: keccak256(abi.encode(msg.sender, token))}(token, quote));
    }
}

contract RulesVaultDeployer {
    /// @dev `factory` recorded in the vault is the caller (the RulesVaultFactory that asked for it).
    function deploy(address token, address quote, IRuleSplitter.Rule[] calldata rules) external returns (address) {
        return address(new RulesVault{salt: keccak256(abi.encode(msg.sender, token))}(msg.sender, token, quote, rules));
    }
}
