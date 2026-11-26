/**
 * Core v1 event decoding (S10a, docs/design/s10a-core-v1-site.md § 3.3): every log of a box is routed by the emitting
 * address to the box role that owns it (`rowAddresses`), or by pool id (topic 1) for the PoolManager, and decoded with
 * that contract's GENERATED ABI (`@squarehole/chain/abi`, under `abi:check`), never a hand-typed signature. An event
 * of the right name from the wrong contract is not decoded (a token `Transfer` counts only from the token). Logs of the
 * chain's drand source count for a box only when they name one of its consumers (its tickets) or its rounds.
 *
 * The result is generic (`source`, `name`, `args`): the reducer (derive-core.ts) switches on `source.name`.
 */
import {
  backedSourceAbi,
  boxCollectionAbi,
  boxCoordinatorAbi,
  boxHookAbi,
  boxItemStreamAbi,
  boxLaunchRouterAbi,
  boxReceiverAbi,
  boxRegistryAbi,
  boxRoyaltyRouterAbi,
  boxTicketsAbi,
  boxTokenAbi,
  boxVaultAbi,
  drandSourceAbi,
  fitBuybackExecutorAbi,
  poolManagerAbi,
} from '@squarehole/chain/abi';
import { CORE_EVENTS, type EventSource, type RoleName } from '@squarehole/chain';
import { decodeEventLog, toEventSelector, type Abi, type Address, type Hex } from 'viem';
import type { LogRef, RawLog } from '../events';

const ABI_BY_SOURCE: Readonly<Record<EventSource, Abi | null>> = {
  registry: boxRegistryAbi as Abi,
  poolManager: poolManagerAbi as Abi,
  hook: boxHookAbi as Abi,
  launchRouter: boxLaunchRouterAbi as Abi,
  coordinator: boxCoordinatorAbi as Abi,
  receiver: boxReceiverAbi as Abi,
  vault: boxVaultAbi as Abi,
  collection: boxCollectionAbi as Abi,
  tickets: boxTicketsAbi as Abi,
  itemStream: boxItemStreamAbi as Abi,
  executor: fitBuybackExecutorAbi as Abi,
  randomness: drandSourceAbi as Abi,
  backedSource: backedSourceAbi as Abi,
  royaltyRouter: boxRoyaltyRouterAbi as Abi,
  token: boxTokenAbi as Abi,
  swapModule: null,
  metadataTable: null,
};

/** Only the events plan § 3.3 names, per source: each source's ABI narrowed to them. */
const NARROWED: ReadonlyMap<EventSource, Abi> = new Map(
  (Object.entries(ABI_BY_SOURCE) as [EventSource, Abi | null][])
    .filter((entry): entry is [EventSource, Abi] => entry[1] !== null)
    .map(([source, abi]) => [source, abi.filter((item) => item.type === 'event' && CORE_EVENTS[source].includes(item.name)) as Abi]),
);

/** topic0 of every event the indexer reads, per source (the per-block getLogs topic filter is their union). */
export const CORE_TOPIC0: Readonly<Record<EventSource, readonly Hex[]>> = Object.fromEntries(
  [...NARROWED.entries()].map(([source, abi]) => [source, abi.filter((item) => item.type === 'event').map((item) => toEventSelector(item))]),
) as unknown as Record<EventSource, readonly Hex[]>;

export const POOL_TOPIC0: readonly Hex[] = CORE_TOPIC0.poolManager;

export interface CoreEvent {
  readonly source: EventSource;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly address: Address;
  readonly ref: LogRef;
}

function refOf(log: RawLog): LogRef {
  return { blockNumber: log.blockNumber, blockHash: log.blockHash, txHash: log.transactionHash, txIndex: log.transactionIndex, logIndex: log.logIndex };
}

/** What routes a log to one box: its addresses by role, its pool, its drand consumers. */
export interface BoxRoute {
  readonly addresses: ReadonlyMap<string, RoleName>;
  readonly poolManager: Address;
  readonly poolId: Hex;
  /** The box's own source: BoxBackedSource since F143, DrandSource on older manifests. */
  readonly randomness: Address;
  /** The DrandSource where rounds and bounties are posted (the same address on older manifests). */
  readonly drand: Address;
  /** Lowercase addresses whose drand requests belong to this box (its tickets). */
  readonly drandConsumers: ReadonlySet<string>;
}

const lower = (a: string): string => a.toLowerCase();

/** Decodes one log for one box (null: not this box's, or not an event S10a reads). */
export function decodeCoreLog(log: RawLog, route: BoxRoute): CoreEvent | null {
  if (log.removed) return null;
  const address = lower(log.address);
  let source: EventSource | undefined;
  if (address === lower(route.poolManager)) {
    if (!log.topics[1] || lower(log.topics[1]) !== lower(route.poolId)) return null;
    source = 'poolManager';
  } else if (address === lower(route.drand)) {
    source = 'randomness';
  } else if (address === lower(route.randomness)) {
    source = 'backedSource';
  } else {
    source = route.addresses.get(address);
  }
  if (!source) return null;
  const abi = NARROWED.get(source);
  if (!abi || abi.length === 0) return null;
  let decoded: { eventName: string; args: unknown };
  try {
    decoded = decodeEventLog({ abi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true }) as { eventName: string; args: unknown };
  } catch {
    return null;
  }
  const args = (decoded.args ?? {}) as Record<string, unknown>;
  if (source === 'randomness' || source === 'backedSource') {
    // Each source's Requested names its consumer; only the box's tickets belong here.
    // Round posts and backups are matched to the box's requested rounds by the reducer.
    if (decoded.eventName === 'Requested' && !route.drandConsumers.has(lower(String(args.consumer)))) return null;
  }
  // The hook's events carry its pool id: one of another pool is not this box's.
  if (source === 'hook' && typeof args.poolId === 'string' && lower(args.poolId) !== lower(route.poolId)) return null;
  return { source, name: decoded.eventName, args, address: log.address, ref: refOf(log) };
}

/** Decodes and orders a block's logs for one box (by log index; duplicates by block hash and index dropped). */
export function decodeBoxLogs(logs: readonly RawLog[], route: BoxRoute): CoreEvent[] {
  const seen = new Set<string>();
  const out: CoreEvent[] = [];
  for (const log of [...logs].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))) {
    const key = `${lower(log.blockHash)}:${log.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const event = decodeCoreLog(log, route);
    if (event) out.push(event);
  }
  return out;
}

export const REGISTRY_ABI = boxRegistryAbi;
