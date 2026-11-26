/**
 * SH-EXISTING-NFTS-E08C: the indexer adapter against E-08B's own gateway routing (packages/indexer/src/core/
 * core-gateway.ts, called without a listener as its own tests do): the feed by chain, a box and its members by the box's
 * token, in E-08A's strict wire shapes; only answers for this source's chain, the add-on's registry and the box asked for.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreGateway, type CoreGatewaySource } from '../../../../../packages/indexer/src/core/core-gateway';
import { DeadlineError } from '../core/deadline';
import { FEED_DEADLINE_MS } from '../core/v2/indexer-v2';
import { SET_MEMBERS_PAGE, SET_ROUTES, allMembers, httpSetIndexer, type SetIndexer } from './set-indexer';
import { FakeSetChain, asOfOf, membersOf, sparseIds, specFor, wireOf } from './test-support/set-chain';

const ids = sparseIds(12);

/** The gateway over a stub source holding one set box's wire answers; `page` caps what one members page holds. */
function rig({ page = 1_000, chainId }: { readonly page?: number; readonly chainId?: number } = {}) {
  const chain = new FakeSetChain({ ids });
  chain.seed(specFor(chain, ids), ids, { graduated: true, picked: 2 });
  const box = wireOf(chain);
  const all = membersOf(chain);
  const state = {
    following: true,
    feed: { schema: 'sh.core-set-feed.v1', chainId: chain.chainIdValue, asOf: asOfOf(chain), boxes: [box] } as Record<string, unknown>,
    box: { schema: 'sh.core-set-box.v1', chainId: chain.chainIdValue, asOf: asOfOf(chain), box } as Record<string, unknown>,
  };
  const source = {
    chainId: chainId ?? chain.chainIdValue,
    health: () => ({ following: state.following, reason: null, history: null }),
    setFeed: () => state.feed,
    setBox: (token: string) => (token === box.token.toLowerCase() ? state.box : null),
    // As the indexer's setMembersView: members from `offset`, at most `limit` (and at most `page` here), and the next.
    setMembers: (token: string, offset: bigint, limit: number) => {
      if (token !== box.token.toLowerCase()) return null;
      const members = all.members.filter((m) => BigInt(m.index) >= offset).slice(0, Math.min(limit, page));
      const next = offset + BigInt(members.length);
      return { ...all, offset: offset.toString(), nextOffset: next < BigInt(all.members.length) ? next.toString() : null, members };
    },
  } as unknown as CoreGatewaySource;
  const gateway = new CoreGateway({ source, host: 'localhost', port: 0 });
  const origin = chain.source.origin ?? '';
  const urls: string[] = [];
  const fetcher = async (url: string) => {
    urls.push(url);
    let status = 0;
    let body = '';
    const res = { headersSent: false, writeHead: (s: number) => { status = s; }, end: (text: string) => { body = text; }, destroy: () => undefined } as unknown as ServerResponse;
    await gateway.route({ method: 'GET', url: url.slice(origin.length) } as IncomingMessage, res);
    return { ok: status === 200, status, json: async () => JSON.parse(body) as unknown };
  };
  return { chain, box, state, urls, origin, indexer: httpSetIndexer(chain.source, fetcher) as SetIndexer };
}

describe('the add-on’s indexer routes, as E-08B’s gateway serves them', () => {
  it('the feed by chain, a box and its members by the box’s token; decimal strings stay strings; members page until done', async () => {
    const { indexer, chain, box, urls, origin } = rig({ page: 5 });
    const feed = await indexer.feed();
    expect(feed.boxes.map((b) => b.state.loaded)).toEqual(['12']);
    const key = { token: box.token, boxId: box.boxId };
    expect((await indexer.box(key)).box.token).toBe(box.token);
    const { members } = await allMembers(indexer, key);
    expect(members.map((m) => m.state)).toEqual(['Outside', 'Outside', ...Array(10).fill('Inside')]);
    expect(members[1]?.id).toBe(((1n << 256n) - 1n).toString());
    const token = box.token.toLowerCase();
    expect(urls.map((url) => url.slice(origin.length))).toEqual([
      `/v2/sets/feed?chain=${chain.chainIdValue}`,
      `/v2/sets/${chain.chainIdValue}/${token}`,
      ...['0', '5', '10'].map((offset) => `/v2/sets/${chain.chainIdValue}/${token}/members?offset=${offset}&limit=${SET_MEMBERS_PAGE}`),
    ]);
    expect(SET_ROUTES.members(chain.chainIdValue, box.token, '0')).toBe(`/v2/sets/${chain.chainIdValue}/${token}/members?offset=0&limit=1000`);
  });

  it('refuses an indexer of another chain, an answer for another chain, registry or box, a malformed row, and one that is catching up', async () => {
    const other = rig({ chainId: 1 });
    await expect(other.indexer.feed()).rejects.toThrow('The indexer answered 404.');
    const { indexer, chain, box, state, urls } = rig();
    const key = { token: box.token, boxId: box.boxId };
    state.feed = { ...state.feed, chainId: 1 };
    await expect(indexer.feed()).rejects.toThrow('The indexer answered for another chain.');
    state.feed = { ...state.feed, chainId: chain.chainIdValue, boxes: [{ ...box, registry: chain.release.factory.address }] };
    await expect(indexer.feed()).rejects.toThrow('The indexer answered for another registry.');
    state.feed = { ...state.feed, boxes: [{ ...box, state: { ...box.state, inside: 12 } }] };
    await expect(indexer.feed()).rejects.toThrow();
    state.box = { ...state.box, box: { ...box, boxId: '7' } };
    await expect(indexer.box(key)).rejects.toThrow('The indexer answered for another box.');
    await expect(indexer.box({ token: chain.release.factory.address, boxId: '0' })).rejects.toThrow('The indexer answered 404.');
    const asked = urls.length;
    await expect(indexer.box({ token: 'not-an-address', boxId: '0' })).rejects.toThrow('Not a box id.');
    await expect(indexer.members(key, '01')).rejects.toThrow('Not a members page.');
    expect(urls).toHaveLength(asked);
    state.following = false;
    await expect(indexer.members(key, '0')).rejects.toThrow('The indexer answered 503.');
  });

  it('a build without an indexer origin lists no add-on box', () => {
    const chain = new FakeSetChain();
    expect(httpSetIndexer({ ...chain.source, origin: null })).toBeNull();
  });
});

describe('XR-ITEM-3D-V2 F1: the add-on’s feed read has the feeds’ deadline', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('the feed request carries a signal (still no cookies, no referrer); with no answer it is aborted at FEED_DEADLINE_MS and the read fails', async () => {
    const chain = new FakeSetChain();
    vi.useFakeTimers();
    const asked: { url: string; init: RequestInit | undefined }[] = [];
    // A request that is never answered, and a fetcher that ignores its signal, as a stuck connection would.
    const indexer = httpSetIndexer(chain.source, (url, init) => { asked.push({ url, init }); return new Promise(() => undefined); }) as SetIndexer;
    const failed = expect(indexer.feed()).rejects.toBeInstanceOf(DeadlineError);
    await vi.advanceTimersByTimeAsync(FEED_DEADLINE_MS - 1);
    expect(asked.map((a) => a.url)).toEqual([`${chain.source.origin}${SET_ROUTES.feed(chain.chainIdValue)}`]);
    expect(asked[0]?.init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(asked[0]?.init?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(asked[0]?.init?.signal?.aborted).toBe(true);
    expect(FEED_DEADLINE_MS).toBe(8_000);
  });

  it('a stalled body counts too (the headers came, the JSON never does)', async () => {
    const chain = new FakeSetChain();
    vi.useFakeTimers();
    const indexer = httpSetIndexer(chain.source, async () => ({ ok: true, status: 200, json: () => new Promise(() => undefined) })) as SetIndexer;
    const failed = expect(indexer.feed()).rejects.toBeInstanceOf(DeadlineError);
    await vi.advanceTimersByTimeAsync(FEED_DEADLINE_MS);
    await failed;
  });
});
