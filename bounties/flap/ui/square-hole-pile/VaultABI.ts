import { parseAbi } from "viem";

// ── The contract block ─────────────────────────────────────────────────────────────────────────────────────────────
// Square Hole's PileVault (bounties/flap/src/PileVault.sol, a beacon proxy per token; its rules come from
// bounties/core/src/FeeRules.sol FeeRulesBase). Every name, argument and return type this UI uses is here; if the
// contract moves one, change it here only.
export const vaultAbi = parseAbi([
  "function taxToken() view returns (address)",
  "function asset() view returns (address)",
  "function pile() view returns (uint256)",
  "function circulatingSupply() view returns (uint256)",
  "function totalPaidOut() view returns (uint256)",
  "function quoteRedeem(uint256 amount) view returns (uint256)",
  "function redeem(uint256 amount, uint256 minOut) returns (uint256)",
]);

// ── End of the contract block ──────────────────────────────────────────────────────────────────────────────────────
