import { PICTURE_BUDGET } from '@squarehole/artwork/box-picture';
// @vitest-environment node
/**
 * SH-ARWEAVE-PICTURES-WEB: the reader against fake gateways (no network): the indexer's copy first, the three searches
 * at once, candidates oldest first page by page, decoys skipped (an 11+ decoy flood included), a gateway that fails or
 * stays silent, the per-picture budget, the size cap, the request options, and the per-page cache.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shLimit } from '../../../../../vitest.timeouts.mjs';
import { ARWEAVE_RAW_GATEWAYS, ARWEAVE_SEARCH_GATEWAYS, BUDGET_MS, COPY_TIMEOUT_MS, MIN_COPY_MS, PAGE_SIZE, RESERVE_MS, arweavePicture, candidatesOf, findArweavePicture, knownArweavePicture, pageOf, rememberArweavePicture, resetArweaveForTests, type ArweavePicture, type ReadOptions } from './arweave-read';
import { PICTURE_ORIGINS } from './arweave-hosts';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (seed: number, size = 64) => Uint8Array.from({ length: size }, (_, i) => (i < 8 ? PNG[i] ?? 0 : (seed * 13 + i) & 255));
const shaOf = (bytes: Uint8Array) => `0x${createHash('sha256').update(bytes).digest('hex')}` as const;
const id = (n: number) => `${String(n).padStart(4, '0')}${'x'.repeat(39)}`;
const T = 'https://t.test';
const A = 'https://a.test';
const G = 'https://g.test';

interface Node { readonly id: string; readonly height?: number | null; readonly size?: number }
type Search = readonly Node[] | 'dead' | 'error' | 'silent';
type Raw = Readonly<Record<string, Uint8Array>> | 'dead' | 'silent';
const answer = (nodes: readonly Node[]) => Response.json({ data: { transactions: { edges: nodes.map((n) => ({ node: { id: n.id, data: { size: String(n.size ?? 64) }, block: n.height === undefined || n.height === null ? null : { height: n.height } } })) } } });
/** A request that never answers, until its signal aborts it (as fetch does). */
const silence = (init?: RequestInit) => new Promise<Response>((_, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });

/** Fake gateways: `search[origin]` answers GraphQL, `raw[origin]` serves `/raw/<id>`. */
function gateways(search: Readonly<Record<string, Search>>, raw: Readonly<Record<string, Raw>>) {
  const calls: { url: string; init: RequestInit | undefined; at: number }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, init, at: Date.now() });
    if (url.pathname === '/graphql') {
      const nodes = search[url.origin];
      if (nodes === 'dead' || nodes === undefined) throw new TypeError('connection refused');
      if (nodes === 'silent') return silence(init);
      if (nodes === 'error') return new Response('<html>500 - Oops.</html>', { status: 570 });
      return answer(nodes);
    }
    const files = raw[url.origin];
    if (files === 'dead' || files === undefined) throw new TypeError('connection refused');
    if (files === 'silent') return silence(init);
    const match = /^\/raw\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
    const bytes = match ? files[match[1] ?? ''] : undefined;
    return bytes ? new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes.length) } }) : new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  const raws = () => calls.filter((c) => c.url.includes('/raw/')).map((c) => c.url);
  const searches = () => calls.filter((c) => c.url.endsWith('/graphql')).map((c) => c.url);
  return { fetcher, calls, raws, searches };
}
const opts = (fetcher: typeof fetch, more: ReadOptions = {}): ReadOptions => ({ fetcher, searchGateways: [T, A, G], rawGateways: [T, A], ...more });

beforeEach(() => {
  resetArweaveForTests();
  vi.stubGlobal('fetch', () => { throw new Error('no network in unit tests'); });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the hosts', () => {
  it('searches turbo-gateway.com, arweave.net and goldsky.arweave.net; reads bytes from the first two; the CSP adds those and Turbo', () => {
    expect(ARWEAVE_SEARCH_GATEWAYS).toEqual(['https://turbo-gateway.com', 'https://arweave.net', 'https://goldsky.arweave.net']);
    expect(ARWEAVE_RAW_GATEWAYS).toEqual(['https://turbo-gateway.com', 'https://arweave.net']);
    expect(PICTURE_ORIGINS).toEqual(['https://upload.ardrive.io', 'https://turbo-gateway.com', 'https://arweave.net', 'https://goldsky.arweave.net']);
    expect(PAGE_SIZE).toBe(100);
    expect(BUDGET_MS).toBe(15_000);
    expect(COPY_TIMEOUT_MS).toBe(3_000);
    // Fix round 3: a floor below the first 100 copies' share even after a 10 s search, and the last half second kept.
    expect(MIN_COPY_MS).toBe(50);
    expect(RESERVE_MS).toBe(500);
  });
});

describe('candidatesOf and pageOf', () => {
  it('oldest first: mined by height, then not mined; no repeats, no bad ids, nothing over the size cap; a page is read as answered', async () => {
    const body = await answer([{ id: id(1), height: null }, { id: id(2), height: 900 }, { id: id(3), height: 100 }, { id: id(3), height: 100 }, { id: 'short', height: 1 },
      { id: id(4), height: 50, size: PICTURE_BUDGET.bytes + 1 }, { id: id(5), height: null }]).json();
    expect(candidatesOf(body)?.map((c) => c.id)).toEqual([id(3), id(2), id(1), id(5)]);
    expect(candidatesOf(await answer(Array.from({ length: 140 }, (_, n) => ({ id: id(n), height: 140 - n }))).json())).toHaveLength(140);
    expect(candidatesOf({ errors: [{}], data: null })).toBeNull();
    expect(candidatesOf(null)).toBeNull();
  });

  it('a next page only with hasNextPage and a cursor on the last edge (an answer without them is the last page)', async () => {
    const edges = [{ cursor: 'c1', node: { id: id(1), data: { size: '64' }, block: { height: 1 } } }, { cursor: 'c2', node: { id: 'bad', data: { size: '64' }, block: null } }];
    const page = (pageInfo: unknown, list: unknown[] = edges) => pageOf({ data: { transactions: { pageInfo, edges: list } } });
    // The cursor is the last edge's, even when its node is not a candidate.
    expect(page({ hasNextPage: true })).toEqual({ candidates: [{ id: id(1), height: 1 }], next: 'c2' });
    expect(page({ hasNextPage: false })?.next).toBeNull();
    expect(page(undefined)?.next).toBeNull();
    expect(page({ hasNextPage: true }, [])).toEqual({ candidates: [], next: null });
    expect(page({ hasNextPage: true }, [{ ...edges[0], cursor: 'x'.repeat(513) }])?.next).toBeNull();
    expect(page({ hasNextPage: true }, [{ ...edges[0], cursor: 'with space' }])?.next).toBeNull();
    expect(pageOf(await answer([{ id: id(1), height: 1 }]).json())).toEqual({ candidates: [{ id: id(1), height: 1 }], next: null });
    expect(pageOf({ data: null })).toBeNull();
  });
});

describe('findArweavePicture', () => {
  it('the indexer’s copy first: its bytes match, so nothing is searched', async () => {
    const real = png(1);
    const g = gateways({ [T]: [], [A]: [], [G]: [] }, { [T]: { [id(7)]: real }, [A]: {} });
    const found = await findArweavePicture(shaOf(real), opts(g.fetcher, { hint: id(7) }));
    expect(found).toMatchObject({ id: id(7), gateway: T, type: 'image/png' });
    expect(g.calls.map((c) => c.url)).toEqual([`${T}/raw/${id(7)}`]);
  });

  it('an indexer copy whose bytes do not match (or that no gateway serves) is skipped, and the search finds the picture', async () => {
    const real = png(2);
    const g = gateways({ [T]: [{ id: id(1), height: 5 }], [A]: [], [G]: [] }, { [T]: { [id(9)]: png(99), [id(1)]: real }, [A]: { [id(9)]: png(99), [id(8)]: png(98) } });
    expect(await findArweavePicture(shaOf(real), opts(g.fetcher, { hint: id(9) }))).toMatchObject({ id: id(1) });
    // Other bytes served by the first gateway settle that id there (an id's bytes are the same on every gateway).
    expect(g.raws()).toEqual([`${T}/raw/${id(9)}`, `${T}/raw/${id(1)}`]);
    // A copy the first gateway does not serve (404) is asked of the next one.
    g.calls.length = 0;
    expect(await findArweavePicture(shaOf(real), opts(g.fetcher, { hint: id(8) }))).toMatchObject({ id: id(1) });
    expect(g.raws()).toEqual([`${T}/raw/${id(8)}`, `${A}/raw/${id(8)}`, `${T}/raw/${id(1)}`]);
    // A hint that is not an Arweave id is ignored.
    expect(await findArweavePicture(shaOf(real), opts(g.fetcher, { hint: '../../etc' }))).toMatchObject({ id: id(1) });
  });

  it('asks all three searches at once by App-Name and SHA-256, with no credentials, no referrer and no redirect followed', async () => {
    const real = png(3);
    const g = gateways({ [T]: [], [A]: [], [G]: [{ id: id(1), height: 3 }] }, { [T]: { [id(1)]: real }, [A]: {} });
    expect(await findArweavePicture(shaOf(real), opts(g.fetcher))).toMatchObject({ id: id(1), gateway: T });
    expect(g.calls.slice(0, 3).map((c) => c.url)).toEqual([`${T}/graphql`, `${A}/graphql`, `${G}/graphql`]);
    // Searches refuse a redirect; raw reads take it back unfollowed (fix round 2, F2).
    for (const call of g.calls) expect(call.init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: call.url.endsWith('/graphql') ? 'error' : 'manual' });
    const body = JSON.parse(String(g.calls[0]?.init?.body)) as { query: string; variables: { app: string[]; sha: string[] } };
    expect(body.variables).toEqual({ app: ['Square Hole'], sha: [shaOf(real).slice(2)] });
    expect(body.query).toContain('sort:HEIGHT_ASC,first:100');
    expect(body.query).toContain('{name:"App-Name",values:$app},{name:"SHA-256",values:$sha}');
  });

  it('an 11+ decoy flood (right tags, other bytes, all older) costs reads, never a wrong picture: the real copy is found', async () => {
    const real = png(4);
    const decoys = Object.fromEntries(Array.from({ length: 15 }, (_, n) => [id(n), png(100 + n)]));
    const nodes = [...Array.from({ length: 15 }, (_, n) => ({ id: id(n), height: n + 1 })), { id: id(500), height: 99 }];
    const g = gateways({ [T]: nodes, [A]: nodes.slice(0, 10), [G]: 'error' }, { [T]: { ...decoys, [id(500)]: real }, [A]: decoys });
    // SH-WITHHELD-SITE: the answer may be Withheld too; no list here, so a picture or null.
    const found = (await findArweavePicture(shaOf(real), opts(g.fetcher))) as ArweavePicture | null;
    expect(found?.id).toBe(id(500));
    expect(Buffer.from(found?.bytes ?? [])).toEqual(Buffer.from(real));
    // Each candidate read once from the first gateway that answers it: never more than the 16 named.
    expect(new Set(g.raws().map((url) => url.split('/raw/')[1])).size).toBeLessThanOrEqual(16);
  });

  it('no cap of 100 (fix round 1): a real copy behind 100 older decoys in one answer is read too; the indexer’s copy skips them', async () => {
    const real = png(5);
    const decoy = png(6);
    const nodes = [...Array.from({ length: 100 }, (_, n) => ({ id: id(n), height: n + 1 })), { id: id(900), height: 1000 }];
    const files = { ...Object.fromEntries(nodes.map((n) => [n.id, decoy])), [id(900)]: real };
    const g = gateways({ [T]: nodes, [A]: [], [G]: [] }, { [T]: files, [A]: {} });
    expect(await findArweavePicture(shaOf(real), opts(g.fetcher))).toMatchObject({ id: id(900) });
    expect(g.raws()).toHaveLength(101);
    expect(g.raws().at(-1)).toBe(`${T}/raw/${id(900)}`);
    // The indexer's copy needs no search at all.
    g.calls.length = 0;
    expect(await findArweavePicture(shaOf(real), opts(g.fetcher, { hint: id(900) }))).toMatchObject({ id: id(900) });
    expect(g.calls.map((c) => c.url)).toEqual([`${T}/raw/${id(900)}`]);
  });

  it('only decoys, or matching bytes that are not a raster picture: nothing (the placeholder)', async () => {
    const real = png(7);
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const g = gateways({ [T]: [{ id: id(1), height: 1 }, { id: id(2), height: 2 }], [A]: [], [G]: [] }, { [T]: { [id(1)]: png(8), [id(2)]: svg }, [A]: {} });
    expect(await findArweavePicture(shaOf(real), opts(g.fetcher))).toBeNull();
    expect(await findArweavePicture(shaOf(svg), opts(g.fetcher))).toBeNull();
  });

  it('a failing search (dead, or HTTP 570) does not stop the others', async () => {
    const real = png(9);
    const g = gateways({ [T]: 'dead', [A]: 'error', [G]: [{ id: id(1), height: 1 }] }, { [T]: { [id(1)]: real }, [A]: {} });
    expect(await findArweavePicture(shaOf(real), opts(g.fetcher))).toMatchObject({ id: id(1) });
  });

  it('a silent search does not hold the others up; a silent raw gateway costs each copy its own short wait, a dead one is left out', async () => {
    const real = png(10);
    const g = gateways({ [T]: 'silent', [A]: [{ id: id(1), height: 1 }, { id: id(2), height: 2 }], [G]: 'silent' }, { [T]: 'silent', [A]: { [id(1)]: png(11), [id(2)]: real } });
    const started = Date.now();
    const found = await findArweavePicture(shaOf(real), opts(g.fetcher, { rawTimeoutMs: 50, searchTimeoutMs: 5_000, concurrency: 1 }));
    expect(found).toMatchObject({ id: id(2), gateway: A });
    expect(Date.now() - started).toBeLessThan(1_000);
    // Fix round 1 (F2): a timeout is the copy's own, so the silent gateway is asked for each copy.
    expect(g.raws().filter((url) => url.startsWith(T))).toEqual([`${T}/raw/${id(1)}`, `${T}/raw/${id(2)}`]);
    // A gateway that cannot be reached at all is asked once, then left out of the lookup.
    const d = gateways({ [T]: [], [A]: [{ id: id(1), height: 1 }, { id: id(2), height: 2 }], [G]: [] }, { [T]: 'dead', [A]: { [id(1)]: png(11), [id(2)]: real } });
    expect(await findArweavePicture(shaOf(real), opts(d.fetcher, { concurrency: 1 }))).toMatchObject({ id: id(2), gateway: A });
    expect(d.raws().filter((url) => url.startsWith(T))).toEqual([`${T}/raw/${id(1)}`]);
  });

  it('stops each picture at its budget when every gateway is silent', async () => {
    const g = gateways({ [T]: 'silent', [A]: 'silent', [G]: 'silent' }, { [T]: 'silent', [A]: 'silent' });
    const started = Date.now();
    expect(await findArweavePicture(shaOf(png(12)), opts(g.fetcher, { budgetMs: 120, hint: id(3) }))).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    // Every request was dropped when the budget ran out.
    for (const call of g.calls) expect(call.init?.signal?.aborted).toBe(true);
  });

  it('size cap: a candidate the search says is too large is not read; bytes over the cap are dropped unread', async () => {
    const real = png(13, 300);
    // id 1's search entry understates its size; id 2's says it is too large.
    const g = gateways({ [T]: [{ id: id(1), height: 1, size: 100 }], [A]: [{ id: id(2), height: 2, size: 10_000 }], [G]: [] }, { [T]: { [id(1)]: real, [id(2)]: real }, [A]: { [id(1)]: real } });
    expect(await findArweavePicture(shaOf(real), opts(g.fetcher, { maxBytes: 200 }))).toBeNull();
    expect(g.raws()).not.toContain(`${T}/raw/${id(2)}`);
    // Served over the cap: dropped, and not asked of the next gateway either (an id's bytes are the same everywhere).
    expect(g.raws()).toEqual([`${T}/raw/${id(1)}`]);
    expect(await findArweavePicture(shaOf(real), opts(g.fetcher, { maxBytes: 300 }))).toMatchObject({ id: id(1) });
  });

  it('a search answer over 256 KiB counts as no answer', async () => {
    const real = png(14);
    const huge = JSON.stringify({ data: { transactions: { edges: [{ node: { id: id(1), data: { size: '64' }, block: { height: 1 } } }] } }, pad: 'x'.repeat(300_000) });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/graphql') ? new Response(huge) : new Response(real.slice()))) as unknown as typeof fetch;
    expect(await findArweavePicture(shaOf(real), opts(fetcher))).toBeNull();
    expect(vi.mocked(fetcher).mock.calls.every(([url]) => String(url).endsWith('/graphql'))).toBe(true);
  });

  it('a zero or malformed hash is never looked up', async () => {
    const g = gateways({}, {});
    expect(await findArweavePicture(`0x${'0'.repeat(64)}`, opts(g.fetcher))).toBeNull();
    expect(await findArweavePicture('0x1234', opts(g.fetcher))).toBeNull();
    expect(await findArweavePicture(shaOf(png(1)), opts(g.fetcher, { search: false }))).toBeNull();
    expect(g.calls).toEqual([]);
  });
});

/**
 * Fix round 1. F1: the search pages through Arweave GraphQL with the `after` cursor for as long as the budget lasts
 * (it stopped at the first 100). F2: a copy that does not load in time costs only that copy (about 3 s on the search
 * path); only a connection error takes a gateway out of the lookup.
 */
describe('fix round 1', () => {
  /** A gateway answering in pages: each edge's cursor is `<origin>#<page>.<edge>`; `after` picks the next page. */
  function paged(pages: Readonly<Record<string, readonly (readonly Node[])[]>>, raw: Readonly<Record<string, Readonly<Record<string, Uint8Array | 'silent'>> | 'dead'>>) {
    const calls: { url: string; after: string | null; init: RequestInit | undefined }[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/graphql') {
        const body = JSON.parse(String(init?.body)) as { variables: { after?: string } };
        const after = body.variables.after ?? null;
        calls.push({ url: url.href, after, init });
        const book = pages[url.origin];
        if (book === undefined) throw new TypeError('connection refused');
        const at = after === null ? 0 : Number(/#(\d+)\.\d+$/.exec(after)?.[1] ?? Number.NaN) + 1;
        const nodes = book[at] ?? [];
        const more = at < book.length - 1;
        return Response.json({ data: { transactions: { pageInfo: { hasNextPage: more }, edges: nodes.map((n, e) => ({ cursor: `${url.origin}#${at}.${e}`, node: { id: n.id, data: { size: '64' }, block: { height: n.height ?? null } } })) } } });
      }
      calls.push({ url: url.href, after: null, init });
      const files = raw[url.origin];
      if (files === 'dead' || files === undefined) throw new TypeError('connection refused');
      const file = files[/^\/raw\/([A-Za-z0-9_-]{43})$/.exec(url.pathname)?.[1] ?? ''];
      if (file === 'silent') return silence(init);
      return file ? new Response(file.slice(), { headers: { 'content-length': String(file.length) } }) : new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const searches = (origin: string) => calls.filter((c) => c.url === `${origin}/graphql`);
    const raws = () => calls.filter((c) => c.url.includes('/raw/')).map((c) => c.url);
    return { fetcher, calls, searches, raws };
  }

  it('F1: a real copy behind 100 older decoys is found on the next page (the `after` cursor), within the budget', async () => {
    const real = png(30);
    const decoy = png(31);
    const first = Array.from({ length: 100 }, (_, n) => ({ id: id(n), height: n + 1 }));
    const files = { ...Object.fromEntries(first.map((n) => [n.id, decoy])), [id(900)]: real };
    const g = paged({ [T]: [first, [{ id: id(900), height: 1000 }]], [A]: [[]], [G]: [[]] }, { [T]: files, [A]: {} });
    const found = await findArweavePicture(shaOf(real), opts(g.fetcher));
    expect(found).toMatchObject({ id: id(900), gateway: T });
    // T's first page has no cursor; its second starts after the first page's last edge. A and G had no next page.
    expect(g.searches(T).map((c) => c.after)).toEqual([null, `${T}#0.99`]);
    expect(g.searches(A)).toHaveLength(1);
    expect(g.searches(G)).toHaveLength(1);
    const second = JSON.parse(String(g.searches(T)[1]?.init?.body)) as { query: string; variables: Record<string, unknown> };
    expect(second.variables).toEqual({ app: ['Square Hole'], sha: [shaOf(real).slice(2)], after: `${T}#0.99` });
    expect(second.query).toContain('sort:HEIGHT_ASC,first:100,after:$after');
    expect(second.query).toContain('pageInfo{hasNextPage}');
    // The first page's request is the one the read-only live check used, plus the page fields.
    const firstBody = JSON.parse(String(g.searches(T)[0]?.init?.body)) as { query: string; variables: Record<string, unknown> };
    expect(firstBody.variables).toEqual({ app: ['Square Hole'], sha: [shaOf(real).slice(2)] });
    expect(firstBody.query).not.toContain('after');
    expect(firstBody.query).toContain('edges{cursor node{id data{size} block{height}}}');
  });

  it('F1: a next page is asked only as the unread candidates run low; a repeated cursor ends that gateway’s pages', async () => {
    const real = png(32);
    // The real copy is the oldest on the first page: the second page is never asked (one reader, so no other read can
    // run the unread candidates low while the real copy is checked).
    const firstPage = [{ id: id(1), height: 1 }, ...Array.from({ length: 99 }, (_, n) => ({ id: id(10 + n), height: 10 + n }))];
    const g = paged({ [T]: [firstPage, [{ id: id(500), height: 500 }]], [A]: [[]], [G]: [[]] }, { [T]: { [id(1)]: real }, [A]: {} });
    expect(await findArweavePicture(shaOf(real), opts(g.fetcher, { concurrency: 1 }))).toMatchObject({ id: id(1) });
    expect(g.searches(T)).toHaveLength(1);
    // Read down to fewer than half a page, the next page is asked while the rest is read (not only once all are gone).
    const decoy = png(40);
    const many = Array.from({ length: 100 }, (_, n) => ({ id: id(n), height: n + 1 }));
    const h = paged({ [T]: [many, [{ id: id(800), height: 800 }]], [A]: [[]], [G]: [[]] }, { [T]: { ...Object.fromEntries(many.map((n) => [n.id, decoy])), [id(800)]: real }, [A]: {} });
    const order: string[] = [];
    expect(await findArweavePicture(shaOf(real), opts(h.fetcher, { concurrency: 1, trace: (event) => { order.push(event.kind === 'search' ? event.gateway : event.id); } }))).toMatchObject({ id: id(800) });
    const second = order.lastIndexOf(T);
    expect(order.filter((entry) => entry === T)).toHaveLength(2);
    expect(second).toBeGreaterThan(order.indexOf(id(50)));
    expect(second).toBeLessThan(order.indexOf(id(99)));
    // A gateway that names the same cursor again is not asked a third time.
    const other = png(33);
    const same = { data: { transactions: { pageInfo: { hasNextPage: true }, edges: [{ cursor: 'same', node: { id: id(2), data: { size: '64' }, block: { height: 2 } } }] } } };
    const asked: string[] = [];
    const looping = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      // Answers come in a later task, like a network's (a loop would end at the budget, not run away).
      await new Promise((resolve) => setTimeout(resolve, 1));
      const url = String(input);
      if (url.endsWith('/graphql')) { asked.push(String((JSON.parse(String(init?.body)) as { variables: { after?: string } }).variables.after ?? null)); return Response.json(same); }
      return new Response(other.slice());
    }) as unknown as typeof fetch;
    expect(await findArweavePicture(shaOf(real), { fetcher: looping, searchGateways: [T], rawGateways: [T], budgetMs: 1_000 })).toBeNull();
    expect(asked).toEqual(['null', 'same']);
  });

  it('F1: pages go on until the budget ends the lookup', async () => {
    const decoy = png(34);
    // Endless pages of decoys; like a network, every answer comes in a later task (so the budget's timer can run).
    const later = () => new Promise((resolve) => setTimeout(resolve, 1));
    const pages: (string | null)[] = [];
    let reads = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      await later();
      if (String(input).endsWith('/graphql')) {
        const after = (JSON.parse(String(init?.body)) as { variables: { after?: string } }).variables.after ?? null;
        const at = pages.push(after);
        return Response.json({ data: { transactions: { pageInfo: { hasNextPage: true }, edges: Array.from({ length: 5 }, (_, n) => ({ cursor: `p${at}.${n}`, node: { id: id(at * 5 + n), data: { size: '64' }, block: { height: at } } })) } } });
      }
      reads += 1;
      return new Response(decoy.slice());
    }) as unknown as typeof fetch;
    const started = Date.now();
    expect(await findArweavePicture(shaOf(png(35)), { fetcher, searchGateways: [T], rawGateways: [T], budgetMs: 300, pageSize: 5 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    // Page after page was asked, each after the last one's cursor, and their candidates were read.
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.slice(0, 3)).toEqual([null, 'p1.4', 'p2.4']);
    expect(reads).toBeGreaterThan(5);
    // Nothing is asked after the budget.
    const asked = vi.mocked(fetcher).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(vi.mocked(fetcher).mock.calls.length).toBe(asked);
  });

  it('F2: four decoys that never load, then the real copy: the real copy is found (a timeout costs that copy, not the gateway)', async () => {
    const real = png(36);
    const nodes = [...Array.from({ length: 4 }, (_, n) => ({ id: id(n), height: n + 1 })), { id: id(700), height: 9 }];
    const never = Object.fromEntries(nodes.slice(0, 4).map((n) => [n.id, 'silent' as const]));
    const g = paged({ [T]: [nodes], [A]: [[]], [G]: [[]] }, { [T]: { ...never, [id(700)]: real }, [A]: never });
    const found = await findArweavePicture(shaOf(real), opts(g.fetcher, { rawTimeoutMs: 50 }));
    expect(found).toMatchObject({ id: id(700), gateway: T });
    // Each decoy was given its time on both gateways; neither gateway was dropped for it.
    for (const n of nodes.slice(0, 4)) expect(g.raws()).toEqual(expect.arrayContaining([`${T}/raw/${n.id}`, `${A}/raw/${n.id}`]));
  });

  it('F2: only a connection error takes a raw gateway out of the lookup; one that is slow for a copy is asked again', async () => {
    const real = png(37);
    const nodes = [{ id: id(1), height: 1 }, { id: id(2), height: 2 }, { id: id(3), height: 3 }];
    // T cannot be reached at all: asked once, then left out. A is slow for the decoy only: asked for every copy.
    const dead = paged({ [T]: [nodes], [A]: [[]], [G]: [[]] }, { [T]: 'dead', [A]: { [id(1)]: png(38), [id(2)]: 'silent', [id(3)]: real } });
    expect(await findArweavePicture(shaOf(real), opts(dead.fetcher, { rawTimeoutMs: 50, concurrency: 1 }))).toMatchObject({ id: id(3), gateway: A });
    expect(dead.raws().filter((url) => url.startsWith(T))).toEqual([`${T}/raw/${id(1)}`]);
    expect(dead.raws().filter((url) => url.startsWith(A))).toEqual([`${A}/raw/${id(1)}`, `${A}/raw/${id(2)}`, `${A}/raw/${id(3)}`]);
  });

  it('F2: about 3 s per copy on the search path; the indexer’s copy keeps 8 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const real = png(39);
      const waited: { url: string; ms: number }[] = [];
      const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/graphql')) return Response.json({ data: { transactions: { edges: [{ node: { id: id(2), data: { size: '64' }, block: { height: 1 } } }] } } });
        const asked = Date.now();
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => { waited.push({ url, ms: Date.now() - asked }); reject(new DOMException('aborted', 'AbortError')); }));
      }) as unknown as typeof fetch;
      const lookup = findArweavePicture(shaOf(real), { fetcher, searchGateways: [T], rawGateways: [T, A], hint: id(1), budgetMs: 60_000 });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await lookup).toBeNull();
      // The searched copy, which no gateway answered, gets its one more try (fix round 2) with the time left.
      expect(waited).toEqual([
        { url: `${T}/raw/${id(1)}`, ms: 8_000 }, { url: `${A}/raw/${id(1)}`, ms: 8_000 },
        { url: `${T}/raw/${id(2)}`, ms: 3_000 }, { url: `${A}/raw/${id(2)}`, ms: 3_000 },
        { url: `${T}/raw/${id(2)}`, ms: 3_000 }, { url: `${A}/raw/${id(2)}`, ms: 3_000 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Fix round 2 (XR-SH-ARWEAVE-PICTURES-WEB). F1: copies that never load cannot use the whole budget before a later copy
 * is asked: each copy gets its share of what is left, and one no gateway answered gets one more try once every copy had
 * its first. F2: a raw read never follows a redirect ('manual'); a redirect refuses that copy on that gateway only.
 */
describe('fix round 2', () => {
  type File = Uint8Array | 'silent' | 'redirect' | 'redirect-302' | { readonly after: number; readonly bytes: Uint8Array };
  /**
   * One page per search gateway; raw files by id. 'redirect' answers as a browser does: with `redirect: 'error'` fetch
   * rejects (TypeError), with `'manual'` it gives an opaque redirect (status 0). 'redirect-302' is the 3xx a server-side
   * fetch shows. `{ after, bytes }` serves after `after` ms (an abort ends it).
   */
  function hosts(pages: Readonly<Record<string, readonly Node[]>>, raw: Readonly<Record<string, Readonly<Record<string, File>>>>) {
    const calls: { url: string; init: RequestInit | undefined; at: number }[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url: url.href, init, at: Date.now() });
      if (url.pathname === '/graphql') {
        const nodes = pages[url.origin] ?? [];
        return Response.json({ data: { transactions: { pageInfo: { hasNextPage: false }, edges: nodes.map((n) => ({ cursor: n.id, node: { id: n.id, data: { size: '64' }, block: { height: n.height ?? null } } })) } } });
      }
      const file = raw[url.origin]?.[/^\/raw\/([A-Za-z0-9_-]{43})$/.exec(url.pathname)?.[1] ?? ''];
      if (file === undefined) return new Response(null, { status: 404 });
      if (file === 'silent') return silence(init);
      if (file === 'redirect') {
        if (init?.redirect !== 'manual') throw new TypeError('Failed to fetch');
        return { type: 'opaqueredirect', status: 0, ok: false, headers: new Headers(), body: null } as unknown as Response;
      }
      if (file === 'redirect-302') return new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } });
      if (file instanceof Uint8Array) return new Response(file.slice(), { headers: { 'content-length': String(file.length) } });
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(file.bytes.slice())), file.after);
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); });
      });
    }) as unknown as typeof fetch;
    const raws = () => calls.filter((c) => c.url.includes('/raw/'));
    return { fetcher, calls, raws };
  }
  /** Runs a lookup on the fake clock (50 ms steps, with real turns between them for WebCrypto): its answer and when. */
  async function onFakeClock<T>(start: () => Promise<T>, limitMs: number): Promise<{ readonly value: T | undefined; readonly at: number }> {
    const began = Date.now();
    let settled = false;
    let value: T | undefined;
    void start().then((answer) => { settled = true; value = answer; });
    while (!settled && Date.now() - began <= limitMs) {
      await vi.advanceTimersByTimeAsync(50);
      for (let turn = 0; turn < 5 && !settled; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    }
    return { value, at: Date.now() - began };
  }
  const never = (from: number, count: number) => Object.fromEntries(Array.from({ length: count }, (_, n) => [id(from + n), 'silent' as const]));
  afterEach(() => { vi.useRealTimers(); });

  it('F1: twelve older copies that never load, then the real one (default timeouts): the real one is asked and found within the budget', async () => {
    const real = png(70);
    const nodes = [...Array.from({ length: 12 }, (_, n) => ({ id: id(n), height: n + 1 })), { id: id(700), height: 20 }];
    const g = hosts({ [T]: nodes, [A]: [], [G]: [] }, { [T]: { ...never(0, 12), [id(700)]: real }, [A]: never(0, 12) });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { value, at } = await onFakeClock(() => findArweavePicture(shaOf(real), opts(g.fetcher)), 16_000);
    expect(value).toMatchObject({ id: id(700), gateway: T });
    expect(at).toBeLessThan(BUDGET_MS);
  }, shLimit(30_000));

  it('F1: the real copy at position 100, behind 99 that never load (default timeouts): every copy is asked, the real one found before the deadline', async () => {
    const real = png(71);
    const nodes = [...Array.from({ length: 99 }, (_, n) => ({ id: id(n), height: n + 1 })), { id: id(700), height: 500 }];
    const g = hosts({ [T]: nodes, [A]: [], [G]: [] }, { [T]: { ...never(0, 99), [id(700)]: real }, [A]: never(0, 99) });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { value, at } = await onFakeClock(() => findArweavePicture(shaOf(real), opts(g.fetcher)), 16_000);
    expect(value).toMatchObject({ id: id(700), gateway: T });
    expect(at).toBeLessThan(BUDGET_MS);
    expect(new Set(g.raws().map((c) => c.url.split('/raw/')[1])).size).toBe(100);
  }, shLimit(30_000));

  it('guard: the oldest copy, slow to load (1 s) while 99 quickly refused decoys wait, is still found (one more try once every copy had its first)', async () => {
    const real = png(72);
    const decoy = png(73);
    const nodes = [{ id: id(700), height: 1 }, ...Array.from({ length: 99 }, (_, n) => ({ id: id(n), height: n + 2 }))];
    const decoys = Object.fromEntries(nodes.slice(1).map((n) => [n.id, decoy]));
    const g = hosts({ [T]: nodes, [A]: [], [G]: [] }, { [T]: { ...decoys, [id(700)]: { after: 1_000, bytes: real } }, [A]: {} });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { value, at } = await onFakeClock(() => findArweavePicture(shaOf(real), opts(g.fetcher)), 16_000);
    expect(value).toMatchObject({ id: id(700), gateway: T });
    expect(at).toBeLessThan(BUDGET_MS);
  }, shLimit(30_000));

  it('F2: a copy that redirects is refused on that gateway only; the gateway stays in the lookup and serves the real copy', async () => {
    const real = png(74);
    const decoy = png(75);
    const nodes = [...Array.from({ length: 4 }, (_, n) => ({ id: id(n), height: n + 1 })), { id: id(700), height: 20 }];
    const redirects = Object.fromEntries(nodes.slice(0, 4).map((n) => [n.id, 'redirect' as const]));
    const g = hosts({ [T]: nodes, [A]: [], [G]: [] }, { [T]: { ...redirects, [id(700)]: real }, [A]: Object.fromEntries(nodes.slice(0, 4).map((n) => [n.id, decoy])) });
    expect(await findArweavePicture(shaOf(real), opts(g.fetcher))).toMatchObject({ id: id(700), gateway: T });
    // A raw read never follows a redirect (its answer is opaque); a search keeps refusing one.
    for (const call of g.raws()) expect(call.init?.redirect).toBe('manual');
    for (const call of g.calls.filter((c) => c.url.endsWith('/graphql'))) expect(call.init?.redirect).toBe('error');
    // Each redirecting copy was asked of the next gateway instead (where it settled as a decoy).
    for (const n of nodes.slice(0, 4)) expect(g.raws().map((c) => c.url)).toContain(`${A}/raw/${n.id}`);
  });

  it('F2 guard: a 3xx answer (a manual redirect as a server-side fetch shows it) is refused the same way', async () => {
    const real = png(76);
    const nodes = [{ id: id(1), height: 1 }, { id: id(700), height: 2 }];
    const g = hosts({ [T]: nodes, [A]: [], [G]: [] }, { [T]: { [id(1)]: 'redirect-302', [id(700)]: real }, [A]: {} });
    expect(await findArweavePicture(shaOf(real), opts(g.fetcher, { concurrency: 1 }))).toMatchObject({ id: id(700), gateway: T });
  });
});

/**
 * Fix round 3 (XR-SH-ARWEAVE-PICTURES-WEB-R2, F1): the first tries fit the time left after the searches, however long
 * they took (up to their 10 s limit): no floor above a copy's share, and the last 500 ms kept for reading the last
 * copies. 99 older copies that never load, then the real one at position 100, with production defaults.
 */
describe('fix round 3', () => {
  const real = png(80);
  const wait = (ms: number, signal?: AbortSignal | null) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
  });
  /** The three searches answer after `delay` ms (T names 100 copies, the others none); only copy 99 (the 100th) loads. */
  function slowSearch(delay: number) {
    const asked: string[] = [];
    const firstAsked = new Map<string, number>();
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/graphql') {
        await wait(delay, init?.signal);
        const count = url.origin === T ? 100 : 0;
        return Response.json({ data: { transactions: { pageInfo: { hasNextPage: false }, edges: Array.from({ length: count }, (_, n) => ({ cursor: id(n), node: { id: id(n), data: { size: '64' }, block: { height: n + 1 } } })) } } });
      }
      const copy = url.pathname.slice('/raw/'.length);
      asked.push(copy);
      if (!firstAsked.has(copy)) firstAsked.set(copy, Date.now());
      if (url.pathname === `/raw/${id(99)}`) return new Response(real.slice());
      return silence(init);
    }) as typeof fetch;
    return { fetcher, asked, firstAsked };
  }
  /** The lookup with the clock it runs on (fake: 50 ms steps with real turns between them; real: plain waits). */
  async function lookup(fetcher: typeof fetch, fake: boolean): Promise<{ readonly found: Awaited<ReturnType<typeof findArweavePicture>> | undefined; readonly at: number; readonly began: number }> {
    const began = Date.now();
    let done = false;
    let found: Awaited<ReturnType<typeof findArweavePicture>> | undefined;
    void findArweavePicture(shaOf(real), { fetcher, searchGateways: [T, A, G], rawGateways: [T, A] }).then((answer) => { found = answer; done = true; });
    while (!done && Date.now() - began <= 16_000) {
      if (fake) await vi.advanceTimersByTimeAsync(50);
      else await new Promise((resolve) => setTimeout(resolve, 50));
      for (let turn = 0; turn < 5 && !done; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    }
    return { found, at: Date.now() - began, began };
  }
  afterEach(() => { vi.useRealTimers(); });

  it.each([0, 3_000, 9_500])('F1: searches that answer after %i ms, 99 older copies that never load: the 100th, the real one, is asked and found (fake clock)', async (delay) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const g = slowSearch(delay);
    const { found, at, began } = await lookup(g.fetcher, true);
    expect(found).toMatchObject({ id: id(99), gateway: T });
    expect(new Set(g.asked).size).toBe(100);
    expect(at).toBeLessThan(BUDGET_MS);
    // Every first try is asked before the last half second, so the last copies are read and checked before the end.
    expect(Math.max(...g.firstAsked.values()) - began).toBeLessThanOrEqual(14_500);
  }, shLimit(30_000));

  it('F1: the same with searches answering after 3 s, on the real clock', async () => {
    const g = slowSearch(3_000);
    const { found, at } = await lookup(g.fetcher, false);
    expect(found).toMatchObject({ id: id(99), gateway: T });
    expect(new Set(g.asked).size).toBe(100);
    expect(at).toBeLessThan(BUDGET_MS);
  }, shLimit(30_000));
});

describe('arweavePicture (per page load)', () => {
  it('keeps a picture found; asks again for one not found; shares a lookup in flight', async () => {
    const real = png(20);
    const g = gateways({ [T]: [{ id: id(1), height: 1 }], [A]: [], [G]: [] }, { [T]: { [id(1)]: real }, [A]: {} });
    const [one, two] = await Promise.all([arweavePicture(shaOf(real), opts(g.fetcher)), arweavePicture(shaOf(real), opts(g.fetcher))]);
    expect(one).toBe(two);
    const asked = g.calls.length;
    expect(await arweavePicture(shaOf(real), opts(g.fetcher))).toBe(one);
    expect(g.calls.length).toBe(asked);
    expect(knownArweavePicture(shaOf(real).toUpperCase().replace('0X', '0x'))).toBe(one);
    const missing = png(21);
    expect(await arweavePicture(shaOf(missing), opts(g.fetcher))).toBeNull();
    const before = g.calls.length;
    expect(await arweavePicture(shaOf(missing), opts(g.fetcher))).toBeNull();
    expect(g.calls.length).toBeGreaterThan(before);
    // Without a hint and without the search, only this page's own copies answer.
    expect(await arweavePicture(shaOf(missing), { ...opts(g.fetcher), search: false })).toBeNull();
  });

  it('remembers a picture this page published only when its bytes hash to the commitment', async () => {
    const real = png(22);
    expect(await rememberArweavePicture(shaOf(png(23)), real, id(1))).toBeNull();
    expect(await rememberArweavePicture(shaOf(real), real, id(1))).toMatchObject({ id: id(1), type: 'image/png' });
    expect(await arweavePicture(shaOf(real), { search: false })).toMatchObject({ id: id(1) });
  });
});
