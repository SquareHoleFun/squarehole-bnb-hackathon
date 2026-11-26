/**
 * The public test network of this build (SH-258). The code has two chain slots, the local anvil chain and "the test
 * network"; the second slot's data (chain id, names, coin, RPCs, explorer, pacing, finality, switches) comes from ONE
 * profile, chosen by ONE build setting:
 *
 *     SH_TESTNET=sepolia   (or unset or empty: the default) Ethereum Sepolia, 11155111, everything as before
 *     SH_TESTNET=bnb       BNB Chain testnet, 97
 *
 * Any other value fails at load time, as a misspelt `SH_TARGET` fails the web build. Where the setting is read:
 * - a web build or dev server: `__SH_TESTNET__`, which apps/web's vite.config.ts defines from the shell's `SH_TESTNET`
 *   (the bundler folds it to a literal);
 * - Node (the indexer, the keeper, scripts, vitest): `process.env.SH_TESTNET`.
 *
 * Internal names with "sepolia" in them (`SEPOLIA_CHAIN_ID`, `SEPOLIA_PUBLIC_RPC_URLS`, the `sepolia` data source)
 * keep their names and mean "the test-network slot": they take their values from `TESTNET` below. Identities that
 * exist on Sepolia only (its canonical Uniswap v4 contracts, WETH9, USDC) stay Sepolia's and are named so.
 *
 * No runtime import (only types): the browser-wallet entry loads this with the page, without viem.
 */
import type { Address } from 'viem';

/** The build setting's name (environment variable and, uppercased, the web build's define). */
export const TESTNET_SETTING = 'SH_TESTNET';

export type TestnetName = 'sepolia' | 'bnb';
export const SEPOLIA_TESTNET_CHAIN_ID = 11_155_111;
export const BNB_TESTNET_CHAIN_ID = 97;
export type TestnetChainId = typeof SEPOLIA_TESTNET_CHAIN_ID | typeof BNB_TESTNET_CHAIN_ID;

export interface TestnetExplorer {
  readonly id: string;
  readonly name: string;
  readonly origin: string;
}

/** `wallet_addEthereumChain` parameters (EIP-3085), offered after a wallet answers 4902 to a switch. */
export interface TestnetAddChain {
  readonly chainId: `0x${string}`;
  readonly chainName: string;
  readonly nativeCurrency: { readonly name: string; readonly symbol: string; readonly decimals: 18 };
  readonly rpcUrls: readonly string[];
  readonly blockExplorerUrls?: readonly string[];
}

/** Parts of the site that exist on one test network and not on another. */
export interface TestnetSwitches {
  /** The alpha's sign-in, invite and Privy pages. */
  readonly alphaGate: boolean;
  /**
   * SH-275: the alpha on an OPEN site (BNB Chain testnet, the hackathon's deployment): no page lock in front of the
   * pages, no desk (the sign-in service approves a first sign-in at once), and the site offers the way to the join page.
   * Off where the alpha is closed (Sepolia: the server's page lock and the founder's desk). Read only with `alphaGate`.
   */
  readonly alphaOpen: boolean;
  /** The royalty inbox's sale list ("offered on CoW in whole lots"). */
  readonly cowSales: boolean;
  /** Box 0, FIT and Misfits (none of them exists on BNB Chain testnet). */
  readonly box0: boolean;
  /** Templates and pages with hidden draws. */
  readonly draws: boolean;
  /** Item pictures on Arweave. */
  readonly arweavePictures: boolean;
}

export interface TestnetProfile {
  readonly name: TestnetName;
  readonly chainId: TestnetChainId;
  /** The `network` its core release manifest names (core-manifest.ts): `sepolia` or `bnb-testnet`. */
  readonly manifestNetwork: 'sepolia' | 'bnb-testnet';
  /** The network's own name ("Sepolia", "BNB Chain Testnet"): wallets, the add-chain call, "on <name>". */
  readonly networkName: string;
  /** The short name in the site's badge and labels: "Testnet · <badgeName>", "<badgeName> testnet". */
  readonly badgeName: string;
  /** The data source's short label ("Sepolia testnet", "BNB Chain testnet"). */
  readonly dataLabel: string;
  readonly coin: {
    /** The native coin's name in wallets ("Sepolia Ether", "BNB"). */
    readonly name: string;
    /** The symbol a wallet shows and the add-chain call names ("SepoliaETH", "tBNB"). */
    readonly walletSymbol: string;
    /** What the site prints for the native coin ("ETH" on Sepolia, so "BNB" on BNB Chain testnet). */
    readonly symbol: string;
  };
  /**
   * Keyless public RPCs the app reads through, in fallback order. Each one answers `eth_getLogs` (a page that reads
   * logs uses this list).
   */
  readonly publicRpcUrls: readonly string[];
  /** The providers behind `publicRpcUrls`, in words for the privacy notice ("PublicNode and Tenderly"). */
  readonly rpcProviders: string;
  readonly explorers: readonly TestnetExplorer[];
  readonly multicall3: Address;
  /** Canonical Uniswap v4 contracts, or null where none is canonical (the PoolManager then comes from the manifest). */
  readonly uniswap: { readonly poolManager: Address; readonly stateView: Address; readonly v4Quoter: Address } | null;
  /** Average block time in milliseconds (for pacing words and steps; never a contract rule). */
  readonly blockTimeMs: number;
  /** Block tag of the read snapshot (state reads and derived metrics). */
  readonly snapshotTag: 'safe' | 'finalized';
  /** A snapshot older than this (wall clock) is stale. */
  readonly staleAfterMs: number;
  /** getLogs span: first span and largest span, in blocks. */
  readonly logs: { readonly initialRange: number; readonly maxRange: number };
  readonly requestTimeoutMs: number;
  /** Write side: how long to wait for a receipt before `timed_out`, and how often to poll. */
  readonly receiptTimeoutMs: number;
  readonly pollIntervalMs: number;
  /** Null where wallets ship the network (Sepolia): a 4902 answer then asks the person to add it. */
  readonly addChain: TestnetAddChain | null;
  readonly switches: TestnetSwitches;
}

const freezeDeep = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) freezeDeep(inner);
    Object.freeze(value);
  }
  return value;
};

const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** Today's Sepolia values, unchanged (networks.ts, config.ts and write/chains.ts held them before SH-258). */
const SEPOLIA: TestnetProfile = {
  name: 'sepolia',
  chainId: SEPOLIA_TESTNET_CHAIN_ID,
  manifestNetwork: 'sepolia',
  networkName: 'Sepolia',
  badgeName: 'Sepolia',
  dataLabel: 'Sepolia testnet',
  coin: { name: 'Sepolia Ether', walletSymbol: 'SepoliaETH', symbol: 'ETH' },
  // research § 2.2, B-RPC-01: chain id 11155111, live head, CORS `*`.
  publicRpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.gateway.tenderly.co'],
  rpcProviders: 'PublicNode and Tenderly',
  explorers: [
    { id: 'etherscan-sepolia', name: 'Etherscan (Sepolia)', origin: 'https://sepolia.etherscan.io' },
    { id: 'blockscout-sepolia', name: 'Blockscout (Sepolia)', origin: 'https://eth-sepolia.blockscout.com' },
  ],
  multicall3: MULTICALL3,
  // research § 2.1: A01, A04, A05.
  uniswap: {
    poolManager: '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543',
    stateView: '0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C',
    v4Quoter: '0x61B3f2011A92d183C7dbaDBdA940a7555Ccf9227',
  },
  blockTimeMs: 12_000,
  snapshotTag: 'safe',
  staleAfterMs: 15 * 60_000,
  logs: { initialRange: 5_000, maxRange: 10_000 },
  requestTimeoutMs: 12_000,
  // Sepolia finality is about two epochs (~13 minutes); inclusion normally takes seconds.
  receiptTimeoutMs: 10 * 60_000,
  pollIntervalMs: 4_000,
  addChain: null,
  switches: { alphaGate: true, alphaOpen: false, cowSales: true, box0: true, draws: true, arweavePictures: true },
};

const BNB_EXPLORER = 'https://testnet.bscscan.com';

/**
 * BNB Chain testnet (measured on 25 November 2026): blocks every 0.45 s (2,000 blocks in 901 s); `safe` is 1 to 2
 * blocks behind the head and `finalized` 5 to 6 blocks (under 3 seconds) on the two official endpoints.
 * - Reads and writes use `finalized`: it costs under 3 seconds of freshness here (on Sepolia it costs 13 minutes, so
 *   Sepolia reads use `safe`), and a finalized block is never reorganised away.
 * - The read list holds only endpoints that answer `eth_getLogs`: PublicNode (spans of 50,000 blocks answered) first,
 *   the official pre-BSC dataseed (at most 5,000 blocks) second. The two official dataseed endpoints refuse
 *   `eth_getLogs` for any span, so they serve the wallet's add-chain call only.
 * - No Uniswap v4 deployment is canonical on 97: the PoolManager is our own, from the release manifest.
 */
const BNB: TestnetProfile = {
  name: 'bnb',
  chainId: BNB_TESTNET_CHAIN_ID,
  manifestNetwork: 'bnb-testnet',
  networkName: 'BNB Chain Testnet',
  badgeName: 'BNB Chain',
  dataLabel: 'BNB Chain testnet',
  coin: { name: 'BNB', walletSymbol: 'tBNB', symbol: 'BNB' },
  publicRpcUrls: ['https://bsc-testnet-rpc.publicnode.com', 'https://bsc-prebsc-dataseed.bnbchain.org'],
  rpcProviders: 'PublicNode and BNB Chain',
  explorers: [{ id: 'bscscan-testnet', name: 'BscScan (Testnet)', origin: BNB_EXPLORER }],
  multicall3: MULTICALL3,
  uniswap: null,
  blockTimeMs: 450,
  snapshotTag: 'finalized',
  // Five minutes hold about 660 blocks: a snapshot that old means the RPC has stopped following the chain.
  staleAfterMs: 5 * 60_000,
  // The second endpoint answers at most 5,000 blocks; the range halves on a refusal and grows back after successes.
  logs: { initialRange: 5_000, maxRange: 50_000 },
  requestTimeoutMs: 12_000,
  receiptTimeoutMs: 2 * 60_000,
  pollIntervalMs: 1_000,
  addChain: {
    chainId: '0x61',
    chainName: 'BNB Chain Testnet',
    nativeCurrency: { name: 'BNB', symbol: 'tBNB', decimals: 18 },
    rpcUrls: ['https://bsc-testnet-dataseed.bnbchain.org', 'https://bsc-testnet.bnbchain.org'],
    blockExplorerUrls: [BNB_EXPLORER],
  },
  // SH-275 (the founder, 25 November: "if we make anyone automatically approved that signs on [...] for the hackathon
  // version"): the alpha's sign-in and "Set me up" on the open site, with this deployment's own Privy app
  // (apps/web/src/features/alpha-sepolia/privy-config.ts, alpha-on.ts).
  // SH-285 (the founder, 26 November, desk R142-LOGO: "arweave"): a box's logo and cover go on Arweave as on Sepolia
  // (Create publishes them through Turbo's free tier; every page reads them there, checked by hash).
  switches: { alphaGate: true, alphaOpen: true, cowSales: false, box0: false, draws: false, arweavePictures: true },
};

export const TESTNET_PROFILES: Readonly<Record<TestnetName, TestnetProfile>> = freezeDeep({ sepolia: SEPOLIA, bnb: BNB });

/** The profile name a setting value selects: unset or empty is Sepolia; any value but the two names throws. */
export function testnetNameOf(value: string | undefined): TestnetName {
  if (value === undefined || value === '' || value === 'sepolia') return 'sepolia';
  if (value === 'bnb') return 'bnb';
  throw new Error(`${TESTNET_SETTING} must be unset, "sepolia" or "bnb" (got "${value}")`);
}

/** The profile of a test-network chain id, or null for any other chain. */
export function testnetProfileOfChain(chainId: unknown): TestnetProfile | null {
  return chainId === SEPOLIA_TESTNET_CHAIN_ID ? TESTNET_PROFILES.sepolia : chainId === BNB_TESTNET_CHAIN_ID ? TESTNET_PROFILES.bnb : null;
}

declare const __SH_TESTNET__: string | undefined;

/** The setting's raw value: the web build's define first, then the process environment (Node). */
export function readTestnetSetting(): string | undefined {
  if (typeof __SH_TESTNET__ === 'string') return __SH_TESTNET__;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[TESTNET_SETTING];
}

/** This build's test network. */
export const TESTNET: TestnetProfile = TESTNET_PROFILES[testnetNameOf(readTestnetSetting())];
