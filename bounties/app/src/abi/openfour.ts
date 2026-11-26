// The OpenFour entry's own exported ABIs (bounties/openfour/abi), used as they are, plus the few extra calls the page
// makes: wrapping BNB, the tax token's founder vault, and the PancakeSwap V2 token-to-token swaps.
import type { Abi } from 'viem';
import coreJson from '../../../openfour/abi/OpenFourCore.json';
import toolsJson from '../../../openfour/abi/OpenFourTools.json';
import vaultJson from '../../../openfour/abi/OpenFourVault.json';
import taxVaultJson from '../../../openfour/abi/PileTaxVault.json';
import rulesTaxVaultJson from '../../../openfour/abi/RulesTaxVault.json';
import tradeModuleJson from '../../../openfour/abi/PileTradeModule.json';

export const fourCoreAbi = coreJson as Abi;
export const fourToolsAbi = toolsJson as Abi;
export const fourVaultAbi = vaultJson as Abi;
export const pileTaxVaultAbi = taxVaultJson as Abi;
/** SH-287: our RulesTaxVault template's clone (createRules once; creator, the three parts, splitter, pile). */
export const rulesTaxVaultAbi = rulesTaxVaultJson as Abi;
export const pileTradeModuleAbi = tradeModuleJson as Abi;

/** OpenFour's vault phases (bounties/openfour/lib/openfour.js). */
export const FOUR_PHASE = ['Created', 'Trading', 'MigratePending', 'Migrated', 'Terminal', 'SoldOut'] as const;
export const FOUR_MIGRATED = 3;

export const wbnbAbi = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
] as const;

/** A tax token names its founder (the ForwardVault), which names its cloned tax vault. */
export const taxTokenFounderAbi = [
  { type: 'function', name: 'founder', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;
/** The tax token's DEX tax rates, in basis points (OpenFour's TaxToken: fee = amount * rate / 10000). */
export const taxRatesAbi = [
  { type: 'function', name: 'buyFeeRate', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'sellFeeRate', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  // the tax the token has booked and not paid out yet: in the quote coin, and in its own tokens (the entry's pile.js)
  { type: 'function', name: 'feeAccumulated', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'tokenAccumulated', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
] as const;
export const forwardVaultAbi = [
  { type: 'function', name: 'clonedVault', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;

export const transferAbi = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

/** PancakeSwap V2 on BSC Testnet, as the OpenFour entry's scripts trade after migration. */
export const FOUR_ROUTER_97 = '0xD99D1c33F9fC3444f8101754aBC46c52416550D1' as const;

/** A tax token's estimates come out short (it swaps inside try/catch): its writes carry this fixed limit. */
export const TAX_TOKEN_GAS = 8_000_000n;

/** A tax token's creation runs code an estimate can undercount: its fixed limit (the signer's README). */
export const CREATE_TAX_GAS = 12_000_000n;

export interface FourTokenInfo {
  version: number;
  creator: string;
  presetId: bigint;
  token: string;
  name: string;
  symbol: string;
  maxSupply: bigint;
  saleAmount: bigint;
  raiseAmount: bigint;
  quoteAsset: `0x${string}`;
  vault: `0x${string}`;
  curveModule: string;
  tradeModule: `0x${string}`;
  migrateModule: string;
  tokenModule: string;
  customData: string;
  createBlock: bigint;
  exists: boolean;
  paused: boolean;
}

export interface FourEstimate {
  curveQuote: bigint;
  totalFee: bigint;
  userPays: bigint;
  userReceives: bigint;
  tokenAmount: bigint;
  executionPrice: bigint;
}
