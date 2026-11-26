/**
 * Unit-test fixtures. `manifest-31337.json` is a copy of a finalized local manifest (packages/contracts
 * scripts/local-e2e.sh at 097710f; anvil's deterministic default-account addresses, no secrets). The Sepolia variant is
 * SYNTHETIC: the same layout re-labelled for chain 11155111 with the canonical PoolManager, only to exercise config
 * handling. Nothing is deployed on Sepolia.
 */
import { encodeAbiParameters, keccak256, type Address } from 'viem';
import { SEPOLIA_UNISWAP_V4, SEPOLIA_CANONICAL_QUOTES } from '../config/chains';
import local from './manifest-31337.json';

type Json = Record<string, unknown>;

export function localManifestJson(): Json {
  return JSON.parse(JSON.stringify(local)) as Json;
}

export function syntheticSepoliaManifestJson(): Json {
  const manifest = localManifestJson();
  manifest.chainId = 11_155_111;
  manifest.network = 'SYNTHETIC unit-test manifest for chain 11155111 (not a deployment)';
  const contracts = manifest.contracts as Record<string, Json>;
  const localWeth = String((contracts.WETH as Json).address).toLowerCase();
  const localUsdc = String((contracts.USDC as Json).address).toLowerCase();
  const mapQuote = (address: string): string =>
    address.toLowerCase() === localWeth ? SEPOLIA_CANONICAL_QUOTES.WETH9 : address.toLowerCase() === localUsdc ? SEPOLIA_CANONICAL_QUOTES.USDC : address;
  for (const template of Object.values(manifest.templates as Record<string, Json>)) template.quote = mapQuote(String(template.quote));
  (contracts.poolManager as Json).address = SEPOLIA_UNISWAP_V4.poolManager;
  (contracts.poolManager as Json).contract = 'canonical Uniswap v4 PoolManager';
  (contracts.WETH as Json).address = SEPOLIA_CANONICAL_QUOTES.WETH9;
  (contracts.WETH as Json).contract = 'WETH9 (canonical)';
  (contracts.USDC as Json).address = SEPOLIA_CANONICAL_QUOTES.USDC;
  (contracts.USDC as Json).contract = 'USDC (Circle, canonical)';
  for (const launch of Object.values(manifest.launches as Record<string, Json>)) {
    const token = ((launch.contracts as Record<string, Json>).token as Json).address as string;
    launch.appPairId = `11155111:${token.toLowerCase()}`;
    launch.pairId = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [11_155_111n, token as Address]));
    launch.quote = mapQuote(String(launch.quote));
  }
  return manifest;
}
