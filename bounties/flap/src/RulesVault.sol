// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {RuleSplitter} from "fee-rules/RuleSplitter.sol";
import {DirectLaunchVaultBase} from "src/flap/DirectLaunchVaultBase.sol";
import {VaultUISchema, VaultMethodSchema, FieldDescriptor} from "src/flap/IVaultSchemas.sol";
import {LibString} from "solady/utils/LibString.sol";

/// @title RulesVault: the Flap Pool Launch vault that is a rule splitter
/// @notice Sits in a launch's VAULT fee slot. The token's tax processor pushes the slot's share of the tax here (the
/// native coin by value, an ERC-20 quote by transfer plus an empty wake call); anyone calls `distribute()` and it is
/// shared among the rules the creator chose before the sale existed: creator, pile (a PileVault of the same token and
/// quote, which holders redeem) and buy and burn. All rules come from `RuleSplitter`: fixed at construction, no owner,
/// no setter, no upgrade (a plain contract, not a proxy).
/// Flap's Portal requires of a vault only `description()` and `vaultUISchema()` (`IDirectLaunchVault`) and that it
/// accepts the slot's payments (a light `receive()`); this contract gives both. The launchers also read `token()` and
/// `asset()` to check the vault is this token's and holds the launch's quote.
contract RulesVault is RuleSplitter, DirectLaunchVaultBase {
    /// @notice The RulesVaultFactory this vault was made for (one per token); it records the token's pile.
    address public immutable factory;

    constructor(address factory_, address token_, address asset_, Rule[] memory rules_)
        RuleSplitter(token_, asset_, rules_)
    {
        factory = factory_;
    }

    /// @notice The launched token; the name Flap's vault UI resolves an approval of type "taxToken" with.
    function taxToken() external view returns (address) {
        return token;
    }

    function version() external pure returns (string memory) {
        return "rules-v1";
    }

    /// @inheritdoc DirectLaunchVaultBase
    function description() public view override returns (string memory d) {
        d = "RulesVault: this vault's revenue is shared, by distribute() which anyone may call, among fixed rules: ";
        uint256 n = this.ruleCount();
        for (uint256 i; i < n; ++i) {
            (Kind k, uint16 bps, address target) = this.rule(i);
            string memory name = k == Kind.CREATOR ? "creator " : k == Kind.PILE ? "pile " : "buy and burn via ";
            d = string.concat(
                d, i == 0 ? "" : "; ", LibString.toString(bps), " bps to ", name, LibString.toHexString(target)
            );
        }
        d = string.concat(d, ". No fee, no owner, no upgrade.");
    }

    /// @inheritdoc DirectLaunchVaultBase
    function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
        schema.vaultType = "RulesVault";
        schema.description = "Every trade's vault share is shared among the creator's fixed rules: creator, pile, buy and burn.";
        schema.methods = new VaultMethodSchema[](4);

        schema.methods[0].name = "pending";
        schema.methods[0].description = "Revenue arrived and not yet shared.";
        schema.methods[0].outputs = new FieldDescriptor[](1);
        schema.methods[0].outputs[0] = FieldDescriptor("amount", "uint256", "Pending", 18);

        schema.methods[1].name = "owed";
        schema.methods[1].description = "What a rule is owed and could not yet be served.";
        schema.methods[1].inputs = new FieldDescriptor[](1);
        schema.methods[1].inputs[0] = FieldDescriptor("rule", "uint256", "Rule index", 0);
        schema.methods[1].outputs = new FieldDescriptor[](1);
        schema.methods[1].outputs[0] = FieldDescriptor("amount", "uint256", "Owed", 18);

        schema.methods[2].name = "delivered";
        schema.methods[2].description = "Lifetime amount a rule has received.";
        schema.methods[2].inputs = new FieldDescriptor[](1);
        schema.methods[2].inputs[0] = FieldDescriptor("rule", "uint256", "Rule index", 0);
        schema.methods[2].outputs = new FieldDescriptor[](1);
        schema.methods[2].outputs[0] = FieldDescriptor("amount", "uint256", "Delivered", 18);

        schema.methods[3].name = "distribute";
        schema.methods[3].description = "Share what arrived among the rules (anyone may call).";
        schema.methods[3].isWriteMethod = true;
    }
}
