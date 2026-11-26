/**
 * The chains the write side can send to (ADR-0012): the local anvil chain (31337) and the build's test network
 * (Sepolia 11155111, or BNB Chain testnet 97 under `SH_TESTNET=bnb`; SH-258, config/testnet-profile.ts). No other
 * chain has a write configuration here, mainnet included (GOAL non-goals, G08): a request for any other chain id is
 * refused before anything reaches a wallet.
 *
 * Finality (06-ARCHITECTURE "Reorganization can return confirmed-but-unfinalized status to pending"):
 * - Sepolia: the execution client's `finalized` block tag (the beacon chain's finalized checkpoint).
 * - BNB Chain testnet: the `finalized` block tag as well (fast finality: 5 to 6 blocks, under 3 seconds, measured on
 *   25 November 2026).
 * - Local anvil: anvil has no consensus layer, so a receipt counts as final once `confirmations` blocks were built on
 *   top of its block and the block is still canonical (documented testnet policy; default 2).
 *
 * Chain ids, names, the default local RPC URL and the Sepolia explorer come from the single chain table
 * `../config/networks` (shared with the read side; type-only viem import, so the wallet entry stays viem-free).
 */
import { DEFAULT_LOCAL_RPC_URL, LOCAL_CHAIN_ID, NETWORKS, SEPOLIA_CHAIN_ID, SUPPORTED_CHAIN_IDS, TESTNET, TESTNET_CHAIN_ID, isSupportedChainId } from '../config/networks';

export { DEFAULT_LOCAL_RPC_URL, LOCAL_CHAIN_ID, SEPOLIA_CHAIN_ID, TESTNET_CHAIN_ID };

export type FinalityPolicy =
  | { readonly kind: 'finalized_tag' }
  | { readonly kind: 'confirmations'; readonly confirmations: number };

export interface WriteChain {
  readonly chainId: number;
  readonly name: string;
  /** Native currency symbol, shown with network fee estimates (never priced in USD: no disclosed source). */
  readonly nativeSymbol: string;
  readonly finality: FinalityPolicy;
  /** How long to wait for a receipt before `timed_out` (the transaction may still land; "Re-check by hash"). */
  readonly receiptTimeoutMs: number;
  readonly pollIntervalMs: number;
  /** Explorer origin for tx/address links (must also pass @squarehole/links' allowlist), or null (local chain). */
  readonly explorerOrigin: string | null;
  /** Parameters for `wallet_addEthereumChain`, or null when the app never asks a wallet to add this chain. */
  readonly addChain: AddEthereumChainParameter | null;
  /** EIP-7825 per-transaction gas cap: a gas limit above it is never requested. */
  readonly maxTxGas: bigint;
}

export interface AddEthereumChainParameter {
  readonly chainId: `0x${string}`;
  readonly chainName: string;
  readonly nativeCurrency: { readonly name: string; readonly symbol: string; readonly decimals: 18 };
  readonly rpcUrls: readonly string[];
  readonly blockExplorerUrls?: readonly string[];
}

/** EIP-7825 (Fusaka): 2^24 gas per transaction; anvil enforces it with --enable-tx-gas-limit. */
export const EIP7825_TX_GAS_CAP = 16_777_216n;
/** Receipt confirmations that count as final on the local anvil chain (no consensus layer). */
export const LOCAL_FINALITY_CONFIRMATIONS = 2;

export function localChain(options: { rpcUrl?: string; confirmations?: number } = {}): WriteChain {
  const confirmations = options.confirmations ?? LOCAL_FINALITY_CONFIRMATIONS;
  if (!Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 64) throw new RangeError('confirmations must be 1…64');
  return Object.freeze({
    chainId: LOCAL_CHAIN_ID,
    name: NETWORKS[LOCAL_CHAIN_ID].name,
    nativeSymbol: `${NETWORKS[LOCAL_CHAIN_ID].nativeSymbol} (local test)`,
    finality: Object.freeze({ kind: 'confirmations', confirmations }),
    receiptTimeoutMs: 120_000,
    pollIntervalMs: 1_000,
    explorerOrigin: null,
    addChain: Object.freeze({
      chainId: '0x7a69',
      chainName: 'Anvil (local 31337)',
      nativeCurrency: Object.freeze({ name: NETWORKS[LOCAL_CHAIN_ID].nativeName, symbol: NETWORKS[LOCAL_CHAIN_ID].nativeSymbol, decimals: 18 }),
      rpcUrls: Object.freeze([options.rpcUrl ?? DEFAULT_LOCAL_RPC_URL]),
    }),
    maxTxGas: EIP7825_TX_GAS_CAP,
  } as const);
}

/**
 * The test network's write chain (the old name kept: the slot, SH-258). Sepolia: wallets ship it, so the app does not
 * add it (a 4902 answer is shown as "add Sepolia in your wallet"). BNB Chain testnet: a wallet that does not know it is
 * offered it (`wallet_addEthereumChain` after 4902). Both cap a transaction's gas at 16,777,216 (EIP-7825 on Sepolia;
 * the chain's own per-transaction limit on BNB Chain testnet).
 */
export const SEPOLIA_WRITE_CHAIN: WriteChain = Object.freeze({
  chainId: TESTNET_CHAIN_ID,
  name: NETWORKS[TESTNET_CHAIN_ID].name,
  nativeSymbol: NETWORKS[TESTNET_CHAIN_ID].nativeSymbol,
  finality: Object.freeze({ kind: 'finalized_tag' }),
  receiptTimeoutMs: TESTNET.receiptTimeoutMs,
  pollIntervalMs: TESTNET.pollIntervalMs,
  explorerOrigin: TESTNET.explorers[0]?.origin ?? null,
  addChain: TESTNET.addChain,
  maxTxGas: EIP7825_TX_GAS_CAP,
} as const);
export const TESTNET_WRITE_CHAIN: WriteChain = SEPOLIA_WRITE_CHAIN;

export const WRITE_CHAIN_IDS: readonly number[] = SUPPORTED_CHAIN_IDS;

export function isWriteChainId(chainId: unknown): chainId is number {
  return isSupportedChainId(chainId);
}

/** The write configuration of a supported chain; throws for every other chain id (mainnet included). */
export function writeChain(chainId: number, options: { localRpcUrl?: string; localConfirmations?: number } = {}): WriteChain {
  if (chainId === LOCAL_CHAIN_ID) return localChain({ rpcUrl: options.localRpcUrl, confirmations: options.localConfirmations });
  if (chainId === TESTNET_CHAIN_ID) return SEPOLIA_WRITE_CHAIN;
  throw new UnsupportedWriteChainError(chainId);
}

export class UnsupportedWriteChainError extends Error {
  readonly chainId: number;
  constructor(chainId: number) {
    super(`Chain ${chainId} has no write configuration; Square Hole sends only on the local chain (31337) and ${TESTNET.networkName} (${TESTNET_CHAIN_ID})`);
    this.name = 'UnsupportedWriteChainError';
    this.chainId = chainId;
  }
}

/** `0x…` chain id for wallet requests. */
export const chainIdHex = (chainId: number): `0x${string}` => `0x${chainId.toString(16)}`;
