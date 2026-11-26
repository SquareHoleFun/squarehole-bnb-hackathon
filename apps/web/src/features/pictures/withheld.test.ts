/**
 * SH-WITHHELD-SITE (F157 (3)): the site's one reader of our withheld-picture list. The hash is the server's own recipe
 * (checked against packages/indexer/src/withheld/list.mjs on a real file), for both id forms; the list is read on first
 * need from the source's API origin, again about every 60 s while the page is visible, keeps its last good answer when
 * a read fails, and is empty before any good one. No network: every answer here is a double.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rawCidV1 } from '@squarehole/artwork';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWithheldPictures } from '../../../../../packages/indexer/src/withheld/list.mjs';
import {
  MAX_LIST_BYTES, READ_TIMEOUT_MS, REFRESH_MS, UNHASHABLE, WITHHELD_PATH, arweavePictureId, checkWithheld, committedPictureId, ipfsPictureId, isWithheld,
  listedKeys, parseWithheldList, pictureIds, resetWithheldForTests, setWithheldOrigin, subscribeWithheld, useWithheld, withheldHash, withheldKeys,
  withheldOriginFor, withheldReady, withheldState, withheldVerdict,
} from './withheld';

const API = 'https://api.example.test';
const SHA = `0x${'12'.repeat(32)}` as const;
const CID = rawCidV1(SHA);
const AR = 'Ab-_0123456789abcdefghijklmnopqrstuvwxyzABC';
const AR_LOWER = AR.toLowerCase();
/** The server's recipe, by hand: SHA-256 hex of the UTF-8 "sh-withheld-v1:" + id. */
const h = (id: string) => createHash('sha256').update(`sh-withheld-v1:${id}`, 'utf8').digest('hex');
const IPFS_ID = `ipfs:${CID}`;
const AR_ID = `ar:${AR}`;

type Answer = (() => Response | Promise<Response>) | 'offline' | 'silent';
/** The API double: one answer per read, the last one repeated; every request recorded with its init. */
function api(...answers: Answer[]) {
  const calls: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer === 'offline' || answer === undefined) throw new TypeError('offline');
    if (answer === 'silent') return new Promise<Response>(() => undefined);
    return answer();
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}
const list = (...ids: string[]) => () => Response.json({ version: 1, hashes: ids.map(h).sort() }, { headers: { 'cache-control': 'max-age=60' } });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetWithheldForTests();
});

describe('the ids and their hash', () => {
  it('both id forms: our gateway’s canonical raw CIDv1 and an Arweave transaction id, nothing else', () => {
    expect(committedPictureId(SHA)).toBe(IPFS_ID);
    expect(committedPictureId(SHA.toUpperCase().replace('0X', '0x'))).toBe(IPFS_ID);
    expect(committedPictureId(`0x${'0'.repeat(64)}`)).toBeNull();
    expect(committedPictureId('0x1234')).toBeNull();
    expect(ipfsPictureId(CID)).toBe(IPFS_ID);
    // No other encoding, no path: the list holds only what our gateway serves.
    for (const other of [CID.toUpperCase(), `${CID}/1.png`, 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi']) {
      expect(ipfsPictureId(other), other).toBeNull();
    }
    // An Arweave id is case-sensitive and kept exactly.
    expect(arweavePictureId(AR)).toBe(AR_ID);
    expect(arweavePictureId(AR_LOWER)).toBe(`ar:${AR_LOWER}`);
    expect(arweavePictureId(AR.slice(1))).toBeNull();
    expect(arweavePictureId(`${AR}/x.png`)).toBeNull();
    expect(pictureIds(IPFS_ID, null, undefined, AR_ID, IPFS_ID)).toEqual([IPFS_ID, AR_ID]);
  });

  it('SubtleCrypto’s SHA-256 of "sh-withheld-v1:" + the full id, exactly as the server lists it (its own module, on a real file)', async () => {
    const ids = [IPFS_ID, AR_ID, `ar:${AR_LOWER}`];
    const dir = mkdtempSync(join(tmpdir(), 'sh-withheld-site-'));
    const file = join(dir, 'pictures.json');
    writeFileSync(file, JSON.stringify(ids.map((id) => ({ id, reason: 'legal-notice', since: '2026-10-29' }))));
    const server = createWithheldPictures({ file, warn: () => undefined }).snapshot();
    const mine = await withheldKeys(ids);
    expect(server.version).toBe(1);
    expect([...mine].sort()).toEqual([...server.hashes]);
    expect(mine).toEqual(ids.map(h));
    // Case matters for Arweave ids: two ids, two hashes. The prefix is part of what is hashed.
    expect(mine[1]).not.toBe(mine[2]);
    expect(await withheldHash(CID)).not.toBe(h(IPFS_ID));
    expect(await withheldHash(IPFS_ID)).toBe(h(IPFS_ID));
  });

  it('without SubtleCrypto an id cannot be checked: it counts as listed while the list is not empty, never otherwise', async () => {
    vi.stubGlobal('crypto', {});
    const { fetcher } = api(list(AR_ID));
    resetWithheldForTests({ origin: API, fetcher });
    expect(await withheldHash(IPFS_ID)).toBe(UNHASHABLE);
    expect((await checkWithheld([IPFS_ID])).withheld).toBe(true);
    resetWithheldForTests({ origin: API, fetcher: api(list()).fetcher });
    expect((await checkWithheld([IPFS_ID])).withheld).toBe(false);
  });
});

describe('the list’s answer', () => {
  it('version 1 with lowercase SHA-256 hex only; anything else is no answer', () => {
    expect(parseWithheldList({ version: 1, hashes: [h(IPFS_ID), h(AR_ID)] })).toEqual(new Set([h(IPFS_ID), h(AR_ID)]));
    expect(parseWithheldList({ version: 1, hashes: [] })).toEqual(new Set());
    for (const bad of [null, [], 'x', { hashes: [] }, { version: 2, hashes: [] }, { version: 1 }, { version: 1, hashes: [h(AR_ID).toUpperCase()] },
      { version: 1, hashes: [h(AR_ID).slice(1)] }, { version: 1, hashes: [IPFS_ID] }, { version: 1, hashes: [1] }]) {
      expect(parseWithheldList(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('the reader', () => {
  it('no API origin (the Demo, a build without one): ready at once, empty, nothing asked', async () => {
    const { fetcher, calls } = api(list(IPFS_ID));
    resetWithheldForTests({ origin: null, fetcher });
    await withheldReady();
    expect(withheldState()).toMatchObject({ ready: true, empty: true });
    expect(await isWithheld([IPFS_ID])).toBe(false);
    expect(calls).toEqual([]);
    expect(withheldOriginFor('demo', { local: 'http://127.0.0.1:5393', sepolia: API })).toBeNull();
    expect(withheldOriginFor('local', { local: 'http://127.0.0.1:5393', sepolia: API })).toBe('http://127.0.0.1:5393');
    expect(withheldOriginFor('sepolia', { local: null, sepolia: API })).toBe(API);
  });

  it('reads on first need only: GET <origin>/v2/withheld, no credentials, no referrer, no redirect, past the browser’s cache', async () => {
    const { fetcher, calls } = api(list(IPFS_ID));
    resetWithheldForTests({ origin: API, fetcher });
    expect(withheldState().ready).toBe(false);
    expect(calls).toEqual([]);
    await withheldReady();
    expect(calls.map((call) => call.url)).toEqual([`${API}${WITHHELD_PATH}`]);
    expect(calls[0]?.init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-cache' });
    expect(calls[0]?.init?.method ?? 'GET').toBe('GET');
    expect(await isWithheld([IPFS_ID])).toBe(true);
    expect(await isWithheld([AR_ID])).toBe(false);
    expect(await isWithheld([AR_ID, IPFS_ID])).toBe(true);
    // Concurrent checks share the one read.
    await Promise.all([withheldReady(), isWithheld([AR_ID]), checkWithheld([IPFS_ID])]);
    expect(calls).toHaveLength(1);
  });

  it('every check waits for the first read: a listed picture is never let through on a cold page', async () => {
    let answer: (response: Response) => void = () => undefined;
    const { fetcher } = api(() => new Promise<Response>((resolve) => { answer = resolve; }));
    resetWithheldForTests({ origin: API, fetcher });
    let settled: boolean | null = null;
    void isWithheld([IPFS_ID]).then((value) => { settled = value; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBeNull();
    answer(list(IPFS_ID)());
    await waitFor(() => expect(settled).toBe(true));
  });

  it('a missing list is empty: a first read that fails, times out or says something else leaves pictures free', async () => {
    for (const answer of ['offline', () => new Response('nope', { status: 404 }), () => new Response('{"version":2,"hashes":[]}'), () => new Response('<html>')] as Answer[]) {
      resetWithheldForTests({ origin: API, fetcher: api(answer).fetcher });
      expect(await isWithheld([IPFS_ID])).toBe(false);
      expect(withheldState()).toMatchObject({ ready: true, empty: true });
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    resetWithheldForTests({ origin: API, fetcher: api('silent').fetcher });
    let done = false;
    void withheldReady().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(withheldState()).toMatchObject({ ready: true, empty: true });
  });

  it('about every 60 s while visible; a failed or bad read keeps the last good list; an oversized answer is no answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const huge = () => new Response(JSON.stringify({ version: 1, hashes: [] }), { headers: { 'content-length': String(MAX_LIST_BYTES + 1) } });
    const { fetcher, calls } = api(list(IPFS_ID), 'offline', () => new Response('x', { status: 500 }), () => Response.json({ version: 7 }), huge, list(AR_ID), list(AR_ID));
    resetWithheldForTests({ origin: API, fetcher });
    const heard: number[] = [];
    const stop = subscribeWithheld(() => heard.push(withheldState().version));
    await withheldReady();
    expect(await isWithheld([IPFS_ID])).toBe(true);
    const first = withheldState().version;
    for (let read = 2; read <= 5; read += 1) {
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(calls).toHaveLength(read);
      // Offline, a 500, a wrong version and an oversized answer: the last good list stands.
      expect(await isWithheld([IPFS_ID])).toBe(true);
      expect(withheldState().version).toBe(first);
    }
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(calls).toHaveLength(6);
    expect(await isWithheld([IPFS_ID])).toBe(false);
    expect(await isWithheld([AR_ID])).toBe(true);
    expect(withheldState().version).toBe(first + 1);
    // The same list again changes nothing and tells no one.
    const told = heard.length;
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(calls).toHaveLength(7);
    expect(heard.length).toBe(told);
    stop();
  });

  it('a hidden page does not read; it reads at once as it becomes visible when its list is that old', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let visibility: DocumentVisibilityState = 'visible';
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const { fetcher, calls } = api(list(), list(IPFS_ID));
    resetWithheldForTests({ origin: API, fetcher });
    await withheldReady();
    expect(calls).toHaveLength(1);
    visibility = 'hidden';
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
    expect(calls).toHaveLength(1);
    visibility = 'visible';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0); });
    expect(calls).toHaveLength(2);
    expect(await isWithheld([IPFS_ID])).toBe(true);
    // Visible again soon after a read: nothing more until the next minute.
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0); });
    expect(calls).toHaveLength(2);
    spy.mockRestore();
  });

  it('a new origin starts a new list: checks wait for its first read, never the old origin’s list', async () => {
    const a = api(list(IPFS_ID));
    resetWithheldForTests({ origin: API, fetcher: a.fetcher });
    expect(await isWithheld([IPFS_ID])).toBe(true);
    resetWithheldForTests({ fetcher: a.fetcher });
    setWithheldOrigin('https://other.example.test');
    expect(withheldState()).toMatchObject({ ready: false, empty: true });
    expect(await isWithheld([IPFS_ID])).toBe(true);
    expect(a.calls.map((call) => call.url)).toEqual([`${API}${WITHHELD_PATH}`, `https://other.example.test${WITHHELD_PATH}`]);
    setWithheldOrigin(null);
    expect(withheldState()).toMatchObject({ ready: true, empty: true });
    expect(await isWithheld([IPFS_ID])).toBe(false);
  });

  it('inside a lookup an empty list costs no hashing; a listed id gives the keys that withhold it', async () => {
    resetWithheldForTests({ origin: API, fetcher: api(list(AR_ID)).fetcher });
    expect(await withheldVerdict([IPFS_ID])).toBeNull();
    expect(await withheldVerdict([IPFS_ID, AR_ID])).toEqual({ withheld: true, keys: [h(IPFS_ID), h(AR_ID)] });
    const check = await checkWithheld([IPFS_ID]);
    expect(check).toEqual({ withheld: false, keys: [h(IPFS_ID)] });
    expect(listedKeys(check.keys)).toBe(false);
    expect(listedKeys([h(AR_ID)])).toBe(true);
    expect(listedKeys([])).toBe(false);
  });
});

describe('useWithheld (a picture shown by URL)', () => {
  it('checking until the first read and the hashes; then clear or withheld, following each change without a remount', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { fetcher } = api(list(AR_ID), list(AR_ID, IPFS_ID));
    resetWithheldForTests({ origin: API, fetcher });
    const listed = renderHook(() => useWithheld([AR_ID]));
    const free = renderHook(() => useWithheld([IPFS_ID]));
    const none = renderHook(() => useWithheld(null));
    expect(listed.result.current).toBe('checking');
    expect(free.result.current).toBe('checking');
    expect(none.result.current).toBe('clear');
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await vi.waitFor(() => expect(listed.result.current).toBe('withheld'));
    expect(free.result.current).toBe('clear');
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_MS); });
    await vi.waitFor(() => expect(free.result.current).toBe('withheld'));
    listed.unmount(); free.unmount(); none.unmount();
  });
});
