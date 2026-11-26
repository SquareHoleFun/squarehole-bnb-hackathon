// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FeeRules} from "fee-rules/FeeRules.sol";
import {DirectLaunchVaultBase} from "src/flap/DirectLaunchVaultBase.sol";
import {VaultUISchema, VaultMethodSchema, FieldDescriptor, ApproveAction} from "src/flap/IVaultSchemas.sol";
import {LibString} from "solady/utils/LibString.sol";

/// @title PileVault: the Flap Pool Launch vault that IS a fee-rules pile
/// @notice Sits in a launch's VAULT fee slot. The token's tax processor pushes the slot's share of every buy and sell
/// tax here (native BNB by value, an ERC-20 quote by transfer plus an empty wake call), and the pile grows by
/// exactly that. Any holder hands tokens in with `redeem(amount, minOut)` and receives
/// `pile * amount / circulatingSupply` in the quote; the tokens go to the dead address. All rules come from
/// `FeeRules`: no owner, no setter, no upgrade (this vault is a plain contract, not a proxy).
/// No excluded holders on this rail: the pool's tokens can be bought, and the Launcher's tokens are its
/// contributors' to claim, so every token outside DEAD, address(0) and this vault is in someone's hands.
contract PileVault is FeeRules, DirectLaunchVaultBase {
    /// @notice The factory that deployed this vault (one vault per token).
    address public immutable factory;

    constructor(address token_, address quote_) FeeRules(token_, quote_, new address[](0)) {
        factory = msg.sender;
    }

    /// @notice The launched token; the name Flap's vault UI resolves an approval of type "taxToken" with.
    function taxToken() external view returns (address) {
        return token;
    }

    /// @notice Release marker of this vault's code. Vaults are not upgradeable, so it never changes.
    function version() external pure returns (string memory) {
        return "pile-v1";
    }

    /// @inheritdoc DirectLaunchVaultBase
    function description() public view override returns (string memory) {
        string memory live;
        if (token.code.length != 0) {
            live = string.concat(
                " Pile now: ",
                LibString.toString(pile()),
                " wei; circulating supply: ",
                LibString.toString(circulatingSupply()),
                "; paid out so far: ",
                LibString.toString(totalPaidOut),
                " wei for ",
                LibString.toString(totalTokensRedeemed),
                " tokens handed in."
            );
        }
        return string.concat(
            "PileVault: 100% of this vault's revenue stays in a pile that every holder can redeem; no fee, no owner,",
            " no upgrade. redeem(amount, minOut) hands tokens to 0x000000000000000000000000000000000000dEaD and pays",
            " pile x amount / circulating supply, rounded down; the holder of the whole circulating supply empties it.",
            live
        );
    }

    /// @inheritdoc DirectLaunchVaultBase
    function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
        schema.vaultType = "PileVault";
        schema.description = "Every trade's vault share fills a pile; any holder hands tokens in for their share of it.";
        schema.methods = new VaultMethodSchema[](5);

        schema.methods[0].name = "pile";
        schema.methods[0].description = "The pile: quote held for the holders right now.";
        schema.methods[0].outputs = new FieldDescriptor[](1);
        schema.methods[0].outputs[0] = FieldDescriptor("amount", "uint256", "Pile", 18);

        schema.methods[1].name = "circulatingSupply";
        schema.methods[1].description = "Tokens not yet burned or handed in.";
        schema.methods[1].outputs = new FieldDescriptor[](1);
        schema.methods[1].outputs[0] = FieldDescriptor("amount", "uint256", "Circulating supply", 18);

        schema.methods[2].name = "quoteRedeem";
        schema.methods[2].description = "What handing in this many tokens pays now.";
        schema.methods[2].inputs = new FieldDescriptor[](1);
        schema.methods[2].inputs[0] = FieldDescriptor("amount", "uint256", "Tokens to hand in", 18);
        schema.methods[2].outputs = new FieldDescriptor[](1);
        schema.methods[2].outputs[0] = FieldDescriptor("assetOut", "uint256", "Paid from the pile", 18);

        schema.methods[3].name = "totalPaidOut";
        schema.methods[3].description = "Lifetime quote paid to holders who handed tokens in.";
        schema.methods[3].outputs = new FieldDescriptor[](1);
        schema.methods[3].outputs[0] = FieldDescriptor("amount", "uint256", "Paid out", 18);

        schema.methods[4].name = "redeem";
        schema.methods[4].description = "Hand in tokens (they are burned to the dead address) for your share of the pile.";
        schema.methods[4].inputs = new FieldDescriptor[](2);
        schema.methods[4].inputs[0] = FieldDescriptor("amount", "uint256", "Tokens to hand in", 18);
        schema.methods[4].inputs[1] = FieldDescriptor("minOut", "uint256", "Least quote accepted", 18);
        schema.methods[4].approvals = new ApproveAction[](1);
        schema.methods[4].approvals[0] = ApproveAction({tokenType: "taxToken", amountFieldName: "amount"});
        schema.methods[4].isWriteMethod = true;
    }
}
