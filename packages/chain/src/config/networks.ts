/**
 * The single table of chains Square Hole reads from and writes to (ADR-0012, SH-C integration): the local anvil chain
 * 31337 and the build's public test network (SH-258: Ethereum Sepolia 11155111 by default, BNB Chain testnet 97 under
 * `SH_TESTNET=bnb`; testnet-profile.ts). There is no mainnet definition anywhere in this package (G08): nothing here
 * can build a client, a wallet request or an explorer link for chain 1.
 *
 * No runtime import (only types): the browser-wallet entry (`@squarehole/chain/write/wallet`) loads this with the page,
 * without viem. The read side's viem chain objects (`config/chains.ts`) and the write side's chain policies
 * (`write/chains.ts`) are both built from these values.
 *
 * Canonical Uniswap v4 and helper addresses on Sepolia come from docs/research/sepolia-infrastructure.md § 2.1
 * (V-labelled, checked on chain 2026-09-25). They are identities, never looked up by symbol.
 */
import type { Address } from 'viem';
import {
  BNB_TESTNET_CHAIN_ID,
  SEPOLIA_TESTNET_CHAIN_ID,
  TESTNET,
  TESTNET_PROFILES,
  type TestnetChainId,
  type TestnetProfile,
} from './testnet-profile.ts';

export {
  BNB_TESTNET_CHAIN_ID,
  SEPOLIA_TESTNET_CHAIN_ID,
  TESTNET,
  TESTNET_PROFILES,
  TESTNET_SETTING,
  readTestnetSetting,
  testnetNameOf,
  testnetProfileOfChain,
  type TestnetAddChain,
  type TestnetChainId,
  type TestnetExplorer,
  type TestnetName,
  type TestnetProfile,
  type TestnetSwitches,
} from './testnet-profile.ts';

export const LOCAL_CHAIN_ID = 31_337;
/** The chain id of this build's test network (11155111, or 97 under `SH_TESTNET=bnb`). */
export const TESTNET_CHAIN_ID: TestnetChainId = TESTNET.chainId;
/** The test-network slot's chain id: the old name, kept (SH-258); equal to `TESTNET_CHAIN_ID`. */
export const SEPOLIA_CHAIN_ID: TestnetChainId = TESTNET_CHAIN_ID;
export const SUPPORTED_CHAIN_IDS = Object.freeze([LOCAL_CHAIN_ID, TESTNET_CHAIN_ID] as const);
/** Every chain id a build of this code may support; one build supports the local chain and its own test network. */
export type SupportedChainId = typeof LOCAL_CHAIN_ID | TestnetChainId;

export function isSupportedChainId(value: unknown): value is SupportedChainId {
  return value === LOCAL_CHAIN_ID || value === TESTNET_CHAIN_ID;
}

const networkOf = (profile: TestnetProfile) => Object.freeze({ name: profile.networkName, nativeName: profile.coin.name, nativeSymbol: profile.coin.walletSymbol });

/** Display names and native currency of the chains (one source for the read and the write side). */
export const NETWORKS: Readonly<Record<SupportedChainId, { readonly name: string; readonly nativeName: string; readonly nativeSymbol: string }>> =
  Object.freeze({
    [LOCAL_CHAIN_ID]: Object.freeze({ name: 'Local anvil chain', nativeName: 'Ether (local test)', nativeSymbol: 'ETH' }),
    [SEPOLIA_TESTNET_CHAIN_ID]: networkOf(TESTNET_PROFILES.sepolia),
    [BNB_TESTNET_CHAIN_ID]: networkOf(TESTNET_PROFILES.bnb),
  });

/** Canonical Uniswap v4 deployment on Sepolia (research § 2.1: A01, A04, A05). Sepolia's identities, whatever the build. */
export const SEPOLIA_UNISWAP_V4 = TESTNET_PROFILES.sepolia.uniswap as NonNullable<TestnetProfile['uniswap']>;

/** The test network's canonical Uniswap v4 contracts, or null (BNB Chain testnet: the manifest names the PoolManager). */
export const TESTNET_UNISWAP_V4: TestnetProfile['uniswap'] = TESTNET.uniswap;

/** Multicall3 on the test network (the same address on 11155111 and 97; research A19, read on 97 on 25 November). */
export const SEPOLIA_MULTICALL3: Address = TESTNET.multicall3;

/** Canonical quote assets on Sepolia (research § 2.1: A11 WETH9, A12 Circle USDC). Sepolia's identities only. */
export const SEPOLIA_CANONICAL_QUOTES = Object.freeze({
  WETH9: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14' as Address,
  USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Address,
});

/**
 * Keyless public RPCs of the test network (Sepolia: research § 2.2, B-RPC-01: chain id 11155111, live head, CORS `*`;
 * BNB Chain testnet: the two endpoints that answer `eth_getLogs`). Order is the fallback order. No key, no paid
 * endpoint; the app may prepend its own URL through configuration.
 */
export const SEPOLIA_PUBLIC_RPC_URLS: readonly string[] = TESTNET.publicRpcUrls;

/** Default local anvil URL (anvil's default port). The app and tests pass their own (8550-8599 in this repo). */
export const DEFAULT_LOCAL_RPC_URL = 'http://127.0.0.1:8545';

/** Block explorers with exact-address pages (research § 5.1). The test network only; a local chain has no explorer. */
export const SEPOLIA_EXPLORERS: TestnetProfile['explorers'] = TESTNET.explorers;
