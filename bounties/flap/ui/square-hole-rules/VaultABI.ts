import { parseAbi } from "viem";

// ── The contract block ─────────────────────────────────────────────────────────────────────────────────────────────
// Square Hole's RulesVault (bounties/flap/src/RulesVault.sol: a beacon proxy per token, RuleSplitterBase
// from bounties/core/src/RuleSplitter.sol) and the pile its PILE rule pays (FeeRulesBase, bounties/core/src/
// FeeRules.sol). Every name, argument and return type this UI uses is here, and the pile's resolver id and its
// signatures equal manifest.json's resolvedContracts entry; if the contracts move one, change it here and
// in the manifest only.
export const vaultAbi = parseAbi([
  "function taxToken() view returns (address)",
  "function asset() view returns (address)",
  "function pending() view returns (uint256)",
  "function totalOwed() view returns (uint256)",
  "function ruleCount() view returns (uint256)",
  "function rule(uint256 i) view returns (uint8 kind, uint16 bps, address target)",
  "function owed(uint256 i) view returns (uint256)",
  "function delivered(uint256 i) view returns (uint256)",
  "function burned(uint256 i) view returns (uint256)",
  "function distribute()",
  "function payOwedCreator(uint256 i) returns (uint256 paid)",
]);

// IRuleSplitter.Kind: NONE 0, CREATOR 1, PILE 2, BUY_BURN 3.
export const kindCreator = 1;
export const kindPile = 2;
export const kindBuyBurn = 3;

// The pile: resolved through the vault's pileOf(token) (RulesVault.sol) under the id "pile", declared in
// manifest.json (resolvedContracts); the component calls sdk.resolveContract("pile", [token]).
export const pileAbi = parseAbi([
  "function pile() view returns (uint256)",
  "function circulatingSupply() view returns (uint256)",
  "function quoteRedeem(uint256 amount) view returns (uint256 assetOut)",
  "function redeem(uint256 amount, uint256 minOut) returns (uint256 assetOut)",
]);

// ── End of the contract block ──────────────────────────────────────────────────────────────────────────────────────
