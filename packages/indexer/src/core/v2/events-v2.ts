/** CQ11 event routing: permanent listing registry, surviving box parts and chain contracts only. */
import { drandSourceOf, ROLE_V2_NAMES, type RoleNameV2 } from '@squarehole/chain';
import { decodeEventLog, type Abi, type Address, type Hex } from 'viem';
import type { LogRef, RawLog } from '../../events';
import { EVENT_ABI_V2, type InboxWiringV21, type BoxRecordV2, type DeployedCoreManifestV2, type EventSourceV2, type ReleaseV2 } from './chain-v2';

export interface RouteV2 {
  readonly inboxes?: readonly (InboxWiringV21 & { readonly boxId: bigint })[];
  /** Codehash-authenticated shared actions; their receiver topic selects the box. */
  readonly modules: ReadonlySet<string>;
  readonly registry: Address;
  readonly listingRegistry: Address;
  readonly poolManager: Address;
  readonly randomness: Address;
  /** Lowercase part address → its box and role. */
  readonly parts: ReadonlyMap<string, { readonly boxId: bigint; readonly role: RoleNameV2 }>;
  /** Lowercase pool id → its box. */
  readonly pools: ReadonlyMap<string, bigint>;
}

export interface CoreEventV2 {
  readonly source: EventSourceV2;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly address: Address;
  readonly ref: LogRef;
  /** The box the event belongs to (a part's box or a pool's box), else null. */
  readonly boxId: bigint | null;
  /** Listing registry events are global; their row identifier remains in args.id. */
  readonly listingId: number | null;
}

const lower = (a: string): string => a.toLowerCase();

/** The route of a release: surviving singletons and parts; listings never discover other contracts. */
export function routeV2(release: ReleaseV2, manifest: DeployedCoreManifestV2, _listings: readonly { readonly id: number }[], boxes: readonly BoxRecordV2[], modules: readonly { readonly module: Address; readonly codeHash: Hex }[] = [], inboxes: readonly (InboxWiringV21 & { readonly boxId: bigint })[] = []): RouteV2 {
  const parts = new Map<string, { boxId: bigint; role: RoleNameV2 }>();
  const pools = new Map<string, bigint>();
  for (const box of boxes) {
    pools.set(lower(box.poolId), box.boxId);
    ROLE_V2_NAMES.forEach((role, index) => {
      const address = box.contracts[index];
      if (index === 19 && address?.toLowerCase() === box.contracts[3]?.toLowerCase()) return; // Seeded PILE: keep its vault event identity.
      // Role 9 is unused in CQ11; box 0's executor events belong to v1 alone.
      if (address && !/^0x0{40}$/i.test(address) && role !== 'executor' && role !== 'swapModule' && role !== 'sampler') parts.set(lower(address), { boxId: box.boxId, role });
    });
  }
  return {
    inboxes,
    modules: new Set(modules.map(m => lower(m.module))),
    registry: release.registry.address,
    listingRegistry: release.listingRegistry.address,
    poolManager: manifest.chain.poolManager.address,
    randomness: drandSourceOf(manifest).address,
    parts,
    pools,
  };
}

function refOf(log: RawLog): LogRef {
  return { blockNumber: log.blockNumber, blockHash: log.blockHash, txHash: log.transactionHash, txIndex: log.transactionIndex, logIndex: log.logIndex };
}

/** Decodes one log (null: not the release's, or not an event M1 reads). */
export function decodeV2Log(log: RawLog, route: RouteV2): CoreEventV2 | null {
  if (log.removed) return null;
  const address = lower(log.address);
  let source: EventSourceV2 | undefined;
  let boxId: bigint | null = null;
  const listingId: number | null = null;
  if (address === lower(route.registry)) source = 'registry';
  else if (route.inboxes?.some(inbox => lower(inbox.settlement) === address)) source = 'cowSettlement';
  else if (address === lower(route.listingRegistry)) source = 'listingRegistry';
  else if (address === lower(route.randomness)) source = 'randomness';
  else if (address === lower(route.poolManager)) {
    boxId = route.pools.get(lower(log.topics[1] ?? '')) ?? null;
    if (boxId === null) return null;
    source = 'poolManager';
  } else if (route.modules.has(address)) source = 'feeModule';
  else {
    const part = route.parts.get(address);
    if (!part) return null;
    source = part.role;
    boxId = part.boxId;
  }
  const abi = EVENT_ABI_V2[source] as Abi | undefined;
  if (!abi || abi.length === 0) return null;
  let decoded: { eventName: string; args: unknown };
  try {
    decoded = decodeEventLog({ abi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true }) as { eventName: string; args: unknown };
  } catch {
    return null;
  }
  const args = (decoded.args ?? {}) as Record<string, unknown>;
  if (source === 'cowSettlement') {
    const inbox = route.inboxes?.find(inbox => lower(inbox.settlement) === address && lower(inbox.router) === lower(String(args.owner)));
    if (!inbox) return null;
    boxId = inbox.boxId;
  }
  if (source === 'feeModule') {
    const receiver = typeof args.receiver === 'string' ? route.parts.get(lower(args.receiver)) : undefined;
    if (receiver?.role !== 'receiver') return null;
    boxId = receiver.boxId;
  }
  if (source === 'hook' && typeof args.poolId === 'string' && route.pools.get(lower(args.poolId)) !== boxId) return null;
  return { source, name: decoded.eventName, args, address: log.address, ref: refOf(log), boxId, listingId };
}

/** Decodes and orders logs (block, then log index; a log seen twice by block hash and index counts once). */
export function decodeV2Logs(logs: readonly RawLog[], route: RouteV2): CoreEventV2[] {
  const seen = new Set<string>();
  const out: CoreEventV2[] = [];
  const ordered = [...logs].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  for (const log of ordered) {
    const key = `${lower(log.blockHash)}:${log.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const event = decodeV2Log(log, route);
    if (event) out.push(event);
  }
  return out;
}
