/**
 * Direct chain reads for the FIT pair page (the ladder's third step, C19): `readFitCurve` / `readFitVault` of the
 * chain package over the market's own RPC (never a wallet's), mapped to the page's model. A build loads the reads and
 * the JSON-RPC client with `import()` only when a chain target needs them; the production site imports them by name
 * (an `import()` would keep the whole package namespace, Demo quotes included; SH-V2-FE6). The dev server and vitest
 * load both modules with this one (as the static imports below; other modules import them statically already). (The
 * page still imports the chain package's shared chunk for its pure helpers, which today carries viem too; see
 * SH-V2-T19 "Limitations".)
 */
import type { FitCurveRead, FitMarketContracts, FitMarketRpc, FitVaultRead, WalletBoxRead } from '@squarehole/chain';
import type { Address } from '@squarehole/domain';
import { DEFAULT_CONFIRMATIONS, FIT_ISSUANCE_RAW, LATCH_BLOCKS, type FitMarketTarget } from './fit-target';
import { figuresAt, liveWindowAt, type LiveData, type LiveState } from './live-model';
import { readFitCurve, readFitVault, readWalletBox } from '@squarehole/chain';
import { createChainReader, createHttpRequest } from '@squarehole/chain/write';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export { liveWindowAt };

export interface VaultCounters {
  readonly source: 'demo' | 'chain';
  readonly block: bigint | null;
  readonly inside: bigint | null;
  readonly collectionSize: bigint | null;
  readonly gateOpen: boolean | null;
  readonly placeholdersTaken: bigint | null;
  /**
   * The box page's price inputs, from the same block as the counters (chain reads only; the Demo computes them from its
   * stream, boxes/demo-vault.ts): E, S, and the vault's own quote for one item. Null = not read.
   */
  readonly escrow?: bigint | null;
  readonly supply?: bigint | null;
  readonly quoteOne?: bigint | null;
}

export function contractsOf(target: FitMarketTarget): FitMarketContracts {
  return { poolManager: target.poolManager, poolId: target.poolId, hook: target.hook, token: target.token, vault: target.vault, placeholders: target.placeholders, collection: target.collection };
}

/** One direct read as the page's model: the curve recomputed from √price, no trades (the chain read has none). */
export function liveDataFromDirect(read: FitCurveRead, target: FitMarketTarget): LiveData {
  const head = Object.freeze({ number: read.block.number, hash: read.block.hash.toLowerCase(), timestamp: read.block.timestamp });
  const state: LiveState = Object.freeze({
    block: read.block.number,
    sqrtPriceX96: read.sqrtPriceX96,
    tick: read.tick,
    figures: figuresAt(read.sqrtPriceX96, target.curve),
    phase: read.phase,
    burnedRaw: read.totalSupplyRaw <= FIT_ISSUANCE_RAW ? FIT_ISSUANCE_RAW - read.totalSupplyRaw : null,
    taxWei: null,
    feesWei: null,
    feesTokenRaw: null,
    swapCount: null,
    completedBlock: read.completedBlock,
    graduatesFromBlock: read.phase === 'completed' && read.completedBlock !== null ? read.completedBlock + LATCH_BLOCKS : null,
    migratedBlock: read.migratedBlock,
    liquidityOpensAtBlock: read.liquidityOpensAtBlock,
  });
  const openMismatch = read.openBlock !== target.openBlock ? `The hook’s open block (${read.openBlock}) is not this market record’s (${target.openBlock}).` : null;
  const supplyMismatch = read.totalSupplyRaw > FIT_ISSUANCE_RAW ? 'The token’s supply is above its one-time issuance.' : null;
  return Object.freeze({
    origin: 'direct',
    head,
    confirmations: DEFAULT_CONFIRMATIONS,
    finality: Object.freeze({ confirmedBlock: read.block.number - BigInt(DEFAULT_CONFIRMATIONS) + 1n, safeBlock: read.safeBlock, finalizedBlock: read.finalizedBlock }),
    state,
    confirmed: state,
    window: liveWindowAt(head, target),
    trades: Object.freeze([]),
    curveMismatch: null,
    stateMismatch: openMismatch ?? supplyMismatch,
  });
}

export function vaultCountersFromRead(read: FitVaultRead): VaultCounters {
  return Object.freeze({
    source: 'chain',
    block: read.block.number,
    inside: read.inside,
    collectionSize: read.collectionSize,
    gateOpen: read.gateOpen,
    placeholdersTaken: read.placeholdersTaken,
    escrow: read.escrowPrincipal,
    supply: read.totalSupply,
    quoteOne: read.quoteWithdrawOne,
  });
}

export interface DirectReader {
  readCurve(): Promise<LiveData>;
  readVault(): Promise<VaultCounters>;
  /** What one address holds of this market (a wallet box), over the market's RPC, never a wallet's provider. */
  readWallet(account: Address): Promise<WalletBoxRead>;
}

/**
 * The chain package's RPC client and market reads. The development build loads them with the first read, as it always
 * has (its chunks depend on it); the production site imports them by name, so its bundle keeps only these (a dynamic
 * import keeps every export of a package entry: the first handoff's writers and schemas with their Demo words).
 */
const writeEntry = DEMO_BUILD ? () => import('@squarehole/chain/write') : () => Promise.resolve({ createChainReader, createHttpRequest });
const chainEntry = DEMO_BUILD ? () => import('@squarehole/chain') : () => Promise.resolve({ readFitCurve, readFitVault, readWalletBox });

/** The market's RPC as the reads need it (the chain package's shape-checked JSON-RPC client). */
async function rpcFor(url: string): Promise<FitMarketRpc> {
  const { createChainReader, createHttpRequest } = await writeEntry();
  const reader = createChainReader(createHttpRequest(url, { timeoutMs: 8_000 }));
  return {
    async header(tag) {
      const block = await reader.getBlock(tag);
      return block === null ? null : { number: block.number, hash: block.hash, timestamp: block.timestamp };
    },
    async call(to, data, blockNumber) {
      return reader.call({ to, data }, blockNumber);
    },
  };
}

/** A reader for a chain target with an RPC; null for the demo or a target without one. */
export function directReaderFor(target: FitMarketTarget): DirectReader | null {
  const url = target.rpcUrl;
  if ((DEMO_BUILD && target.kind === 'demo') || url === null) return null;
  let rpc: Promise<FitMarketRpc> | null = null;
  const connection = () => (rpc ??= rpcFor(url));
  return {
    async readCurve() {
      const [{ readFitCurve }, client] = await Promise.all([chainEntry(), connection()]);
      return liveDataFromDirect(await readFitCurve(client, contractsOf(target)), target);
    },
    async readVault() {
      const [{ readFitVault }, client] = await Promise.all([chainEntry(), connection()]);
      return vaultCountersFromRead(await readFitVault(client, contractsOf(target)));
    },
    async readWallet(account) {
      const [{ readWalletBox }, client] = await Promise.all([chainEntry(), connection()]);
      return readWalletBox(client, contractsOf(target), account);
    },
  };
}
