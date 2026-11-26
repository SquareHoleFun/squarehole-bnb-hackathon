/**
 * Approved contract/event versions for the log indexer (03-FEED "Event ingestion": decode only approved contract and
 * event versions; no generic ABI guessing). A log is decoded only when its emitter has a known role in the deployment
 * AND its topic0 is approved for that role; anything else is counted and ignored.
 */
import { decodeEventLog, encodeEventTopics, type Abi, type Hex } from 'viem';
import {
  feeCollectorAbi,
  poolManagerAbi,
  rewardLedgerAbi,
  squareHoleClaimConverterAbi,
  squareHoleFungibleTokenAbi,
  squareHoleRegistryAbi,
} from '../abi';

export type LogRole = 'registry' | 'token' | 'collector' | 'ledger' | 'converter' | 'pool_manager';

export type ApprovedEvent =
  | 'PairCreated'
  | 'TemplateAdded'
  | 'TemplateRetired'
  | 'Transfer'
  | 'FeesReceived'
  | 'FeeTBurned'
  | 'ProtocolQPaid'
  | 'Claimed'
  | 'HolderQAllocated'
  | 'HolderQDeferred'
  | 'ClaimConverted'
  | 'ClaimPaidInQSoldOut'
  | 'Swap';

interface RoleEvents {
  readonly abi: Abi;
  readonly events: readonly ApprovedEvent[];
}

export const APPROVED_EVENTS: Readonly<Record<LogRole, RoleEvents>> = Object.freeze({
  registry: { abi: squareHoleRegistryAbi as Abi, events: ['PairCreated', 'TemplateAdded', 'TemplateRetired'] },
  // Both launch templates emit the same ERC-20 Transfer(address indexed, address indexed, uint256).
  token: { abi: squareHoleFungibleTokenAbi as Abi, events: ['Transfer'] },
  collector: { abi: feeCollectorAbi as Abi, events: ['FeesReceived', 'FeeTBurned', 'ProtocolQPaid'] },
  ledger: { abi: rewardLedgerAbi as Abi, events: ['Claimed', 'HolderQAllocated', 'HolderQDeferred'] },
  converter: { abi: squareHoleClaimConverterAbi as Abi, events: ['ClaimConverted', 'ClaimPaidInQSoldOut'] },
  pool_manager: { abi: poolManagerAbi as Abi, events: ['Swap'] },
});

function topic0(abi: Abi, eventName: string): Hex {
  const [first] = encodeEventTopics({ abi, eventName } as Parameters<typeof encodeEventTopics>[0]);
  if (!first) throw new Error(`no topic for ${eventName}`);
  return first;
}

/** topic0 per (role, event). */
export const EVENT_TOPICS: Readonly<Record<LogRole, Readonly<Record<string, Hex>>>> = Object.freeze(
  Object.fromEntries(
    Object.entries(APPROVED_EVENTS).map(([role, spec]) => [role, Object.freeze(Object.fromEntries(spec.events.map((name) => [name, topic0(spec.abi, name)])))]),
  ) as Record<LogRole, Record<string, Hex>>,
);

/** topic0 filter of the "contracts" stream (every approved event of every role except the PoolManager's Swap). */
export const CONTRACT_STREAM_TOPICS: readonly Hex[] = Object.freeze(
  [...new Set((['registry', 'token', 'collector', 'ledger', 'converter'] as const).flatMap((role) => Object.values(EVENT_TOPICS[role])))],
);

export const SWAP_TOPIC: Hex = EVENT_TOPICS.pool_manager.Swap as Hex;

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

/** bigint → decimal string, addresses/hex kept as returned (checksummed), nested structs recursively. */
export function toJsonValue(value: unknown): JsonValue {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' || value === null) return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, toJsonValue(inner)]));
  return null;
}

export interface DecodedLog {
  readonly event: ApprovedEvent;
  readonly args: Readonly<Record<string, JsonValue>>;
}

/** Decodes an approved event of `role`; null for anything else (never a guess). */
export function decodeApprovedLog(role: LogRole, log: { readonly data: Hex; readonly topics: readonly Hex[] }): DecodedLog | null {
  const spec = APPROVED_EVENTS[role];
  const [first] = log.topics;
  if (!first) return null;
  const name = spec.events.find((event) => EVENT_TOPICS[role][event]?.toLowerCase() === first.toLowerCase());
  if (!name) return null;
  try {
    const decoded = decodeEventLog({ abi: spec.abi, data: log.data, topics: [...log.topics] as [Hex, ...Hex[]], eventName: name, strict: true });
    const args = toJsonValue(decoded.args ?? {});
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
    return { event: name, args };
  } catch {
    return null;
  }
}
