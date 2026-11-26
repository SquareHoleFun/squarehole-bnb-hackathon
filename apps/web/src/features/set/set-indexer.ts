/**
 * SH-EXISTING-NFTS-E08C: the add-on's boxes as the indexer publishes them: E-08B's gateway routes under `/v2/sets/*`
 * (packages/indexer/src/core/core-gateway.ts), in E-08A's strict wire shapes `sh.core-set-feed.v1`, `sh.core-set-box.v1`
 * and `sh.core-set-members.v1`. The routes sit in one place (`SET_ROUTES`), behind a small interface (`SetIndexer`) the
 * pages use and the tests replace. Each answer is parsed with E-08A's schemas (decimal strings stay strings) and must
 * name this source's chain, the add-on's registry and the box asked for. Wire data is shape, not truth: any action
 * re-reads the box on chain (set-identity.ts) before it names a vault or collection. The gateway's money and activity
 * routes are not read: the page takes a box's money from the chain at the block it acts on.
 */
import type { Address } from 'viem';
import { setBoxSchema, setFeedSchema, setMembersSchema, type SetBoxWire, type SetFeedWire, type SetMembersWire } from '@squarehole/chain/core/set-v2';
import { withDeadline } from '../core/deadline';
import { FEED_DEADLINE_MS } from '../core/v2/indexer-v2';
import type { SetSource } from './set-build';

/** The most members one page asks for (the gateway takes 1..10,000; a set holds at most 10,000). */
export const SET_MEMBERS_PAGE = 1_000;

/** E-08B's gateway routes: the feed by chain; a box, and its members, by the box's token. */
export const SET_ROUTES = /* @__PURE__ */ Object.freeze({
  feed: (chainId: number) => `/v2/sets/feed?chain=${chainId}`,
  box: (chainId: number, token: string) => `/v2/sets/${chainId}/${token.toLowerCase()}`,
  members: (chainId: number, token: string, offset: string, limit: number = SET_MEMBERS_PAGE) => `/v2/sets/${chainId}/${token.toLowerCase()}/members?offset=${offset}&limit=${limit}`,
});

/** A box as the routes name it: its token; its registry box id authenticates a members page. */
export interface SetBoxKey {
  readonly token: string;
  readonly boxId: string;
}

export interface SetIndexer {
  feed(): Promise<SetFeedWire>;
  box(key: SetBoxKey): Promise<SetBoxWire>;
  members(key: SetBoxKey, offset: string): Promise<SetMembersWire>;
}

/** How the indexer is asked: the browser's fetch, or a test's (the core feed's Fetcher fits). */
export type SetFetcher = (url: string, init?: RequestInit) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

export class SetIndexerError extends Error {
  override readonly name = 'SetIndexerError';
}

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The source's indexer, or null when the build names none (the add-on's boxes are then not listed). */
export function httpSetIndexer(source: SetSource, fetcher: SetFetcher = (url, init) => fetch(url, init)): SetIndexer | null {
  const origin = source.origin;
  if (!origin) return null;
  const registry = source.release.registry.address;
  const get = async (path: string, signal?: AbortSignal): Promise<unknown> => {
    const reply = await fetcher(`${origin}${path}`, { credentials: 'omit', referrerPolicy: 'no-referrer', ...(signal ? { signal } : {}) });
    if (!reply.ok) throw new SetIndexerError(`The indexer answered ${reply.status}.`);
    return reply.json() as Promise<unknown>;
  };
  const ours = (wire: { readonly chainId: number }, registries: readonly string[]) => {
    if (wire.chainId !== source.chainId) throw new SetIndexerError('The indexer answered for another chain.');
    if (registries.some((r) => !same(r, registry))) throw new SetIndexerError('The indexer answered for another registry.');
  };
  const key = (box: SetBoxKey): Address => {
    if (!ADDRESS.test(box.token) || !DECIMAL.test(box.boxId)) throw new SetIndexerError('Not a box id.');
    return box.token as Address;
  };
  return {
    // XR-ITEM-3D-V2 F1: the feed's answer, headers and body, within the feeds' deadline (FEED_DEADLINE_MS, as the core
    // feeds'): its request is aborted then and the read fails, so the query's retry asks again (useSetFeed.ts).
    feed: async () => {
      const wire = setFeedSchema.parse(await withDeadline(FEED_DEADLINE_MS, undefined, (deadline) => get(SET_ROUTES.feed(source.chainId), deadline)));
      ours(wire, wire.boxes.map((box) => box.registry));
      return wire;
    },
    box: async (box) => {
      const wire = setBoxSchema.parse(await get(SET_ROUTES.box(source.chainId, key(box))));
      ours(wire, [wire.box.registry]);
      if (!same(wire.box.token, box.token) || wire.box.boxId !== box.boxId) throw new SetIndexerError('The indexer answered for another box.');
      return wire;
    },
    members: async (box, offset) => {
      const token = key(box);
      if (!DECIMAL.test(offset)) throw new SetIndexerError('Not a members page.');
      const wire = setMembersSchema.parse(await get(SET_ROUTES.members(source.chainId, token, offset)));
      ours(wire, [wire.registry]);
      if (wire.boxId !== box.boxId || wire.offset !== offset) throw new SetIndexerError('The indexer answered for another page.');
      return wire;
    },
  };
}

/** Every page of a box's members, in accepted order (at most 10,000 members; a page that does not advance stops). */
export async function allMembers(indexer: SetIndexer, box: SetBoxKey): Promise<{ readonly members: SetMembersWire['members']; readonly asOf: SetMembersWire['asOf'] | null }> {
  const members: SetMembersWire['members'][number][] = [];
  let offset: string | null = '0';
  let asOf: SetMembersWire['asOf'] | null = null;
  for (let pages = 0; offset !== null && pages < 10_001; pages += 1) {
    const page: SetMembersWire = await indexer.members(box, offset);
    asOf = page.asOf;
    members.push(...page.members);
    if (page.nextOffset !== null && (page.members.length === 0 || BigInt(page.nextOffset) <= BigInt(offset))) throw new SetIndexerError('The members list does not advance.');
    offset = page.nextOffset;
  }
  return { members, asOf };
}
