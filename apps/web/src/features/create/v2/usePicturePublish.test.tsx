/**
 * SH-ARWEAVE-PICTURES-WEB, fix round 1 (F1, integrator decision): Create publishes the logo and cover when its press
 * asks (useCreateSend `beforeWallet`, after the checks and before the wallet), never by itself and never once the box
 * is created; the wallet goes on only after Turbo's answers. One status line; a failed publish stops the press once with
 * Retry, and the next press goes on; Retry sends only what is still unpublished; a picture published here shows at once
 * wherever its hash is on this page. No network.
 */
import { rawCidV1, sha256Hex } from '@squarehole/artwork';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COLLECTION_COVER, COVER, PAGE, artOf } from '../test-support/fixtures';
import { publishToArweave, type PictureToPublish, type PublishOptions, type PublishResult } from '../../pictures/arweave-publish';
import { verifyEthDataItem } from '../../pictures/ans104-eth';
import { knownArweavePicture } from '../../pictures/arweave-read';
import { resetPicturesForTests } from '../../boxes/box-pictures';
import { REFRESH_MS, REFUSED_PICTURE_TEXT, inlinePictureIds, refusedPicture, resetWithheldForTests } from '../../pictures/withheld';
import { buildSpecV2 } from './model';
import { committedPictureHashes, logoAndCover } from './pictures';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { inputV2Of } from './test-support/v2-fixtures';
import { FOUND_CHECK_MS, ORIGINAL_ART_TEXT, PicturesStatus, alreadyOnArweave, picturesText, usePicturePublish, type PicturePublishInput } from './usePicturePublish';

const digest = async (bytes: Uint8Array) => sha256Hex(bytes);
const config = (id: string) => CONFIGURATIONS.find((entry) => entry.id === id);
const collection = buildSpecV2(inputV2Of(config('bag-holders')));
const token = buildSpecV2(inputV2Of(config('rug-rugs')));
/** The draft as Create leaves it: the logo, the collection cover, and the art the collection's spec commits (af4). */
const draft = { cover: COVER, collectionCover: COLLECTION_COVER, art: artOf() };
type Publish = NonNullable<PicturePublishInput['publish']>;

/** A fake Turbo: each call is recorded; `fail` names the hashes refused once. */
function fakePublish(fail: Set<string> = new Set()) {
  const calls: (readonly PictureToPublish[])[] = [];
  const publish = vi.fn(async (pictures: readonly PictureToPublish[], options: PublishOptions) => {
    calls.push(pictures);
    const results: PublishResult[] = [];
    for (const picture of pictures) {
      const result: PublishResult = fail.delete(picture.sha256)
        ? { sha256: picture.sha256, ok: false, reason: 'network', itemBytes: 100 }
        : { sha256: picture.sha256, ok: true, id: `${picture.sha256.slice(2, 45)}`, itemBytes: 100, ms: 5 };
      results.push(result);
      options.onResult?.(result);
    }
    return results;
  }) as unknown as Publish & { mock: { calls: unknown[][] } };
  return { publish, calls };
}

/** SH-WITHHELD-SITE (fix rounds af2 and af3): our API's withheld list, a double, and the ids it names. */
const API = 'https://api.example.test';
/** A picture's id on the list: `ipfs:` + the raw CID of its committed hash (its bytes' SHA-256). */
const bytesId = (sha: string) => `ipfs:${rawCidV1(sha.toLowerCase() as `0x${string}`)}`;
const h = (id: string) => createHash('sha256').update(`sh-withheld-v1:${id}`).digest('hex');
/** Elsewhere on the list: makes it not empty. */
const OTHER = bytesId(`0x${'ab'.repeat(32)}`);
const pause = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
/** Each read answers the next of `lists` (the last repeated); `refresh` is the page shown again a minute later. */
function withheldList(...lists: string[][]) {
  let clock = 1_000_000;
  const reads = vi.fn(async () => Response.json({ version: 1, hashes: (lists[Math.min(reads.mock.calls.length - 1, lists.length - 1)] ?? []).map(h).sort() }));
  resetWithheldForTests({ origin: API, fetcher: reads as unknown as typeof fetch, now: () => clock });
  const refresh = async () => {
    const before = reads.mock.calls.length;
    clock += REFRESH_MS;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(reads.mock.calls.length).toBe(before + 1));
    await pause();
  };
  return { reads, refresh };
}
/** A promise and its release: an answer held while the test moves the list on. */
function hold() {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  return { held, release: () => release() };
}

beforeEach(() => { window.sessionStorage.clear(); resetPicturesForTests(); });
afterEach(() => { cleanup(); window.sessionStorage.clear(); });

describe('logoAndCover', () => {
  it('the logo, and a new collection’s cover; never items, banner or teasers; a changed picture is missing', async () => {
    const all = await logoAndCover(collection, draft, digest);
    expect(all.pictures.map((p) => [p.role, p.sha256])).toEqual([['logo', COVER.sha256], ['collection cover', COLLECTION_COVER.sha256]]);
    for (const picture of all.pictures) expect(sha256Hex(picture.bytes)).toBe(picture.sha256);
    expect((await logoAndCover(token, draft, digest)).pictures.map((p) => p.role)).toEqual(['logo']);
    expect((await logoAndCover(collection, { ...draft, cover: COLLECTION_COVER }, digest)).missing).toEqual([{ role: 'logo', sha256: COVER.sha256 }]);
  });
});

describe('usePicturePublish', () => {
  const nowhere = async () => false;
  const base = (publish: Publish): PicturePublishInput => ({ on: true, draft, chainId: 11155111, digest, publish, onArweave: nowhere });
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

  it('nothing by itself: both pictures once Create’s press asks, with the chain id; it answers only after Turbo’s ids', async () => {
    const turbo = fakePublish();
    const { result } = renderHook((input: PicturePublishInput) => usePicturePublish(input), { initialProps: base(turbo.publish) });
    await settle();
    expect(turbo.calls).toHaveLength(0);
    expect(result.current.view).toEqual({ phase: 'off' });
    let answered: boolean | null = null;
    await act(async () => { answered = await result.current.beforeWallet(collection); });
    expect(answered).toBe(true);
    expect(turbo.calls).toHaveLength(1);
    expect(turbo.calls[0]?.map((p) => p.sha256)).toEqual([COVER.sha256, COLLECTION_COVER.sha256]);
    expect((turbo.publish as unknown as { mock: { calls: [unknown, PublishOptions][] } }).mock.calls[0]?.[1].chainId).toBe(11155111);
    expect(result.current.view).toEqual({ phase: 'published', total: 2 });
    // Another press (Continue, a reload, a second box with the same pictures) sends nothing twice: the tab remembers.
    await act(async () => { answered = await result.current.beforeWallet(collection); });
    expect(answered).toBe(true);
    const again = renderHook(() => usePicturePublish(base(turbo.publish)));
    await act(async () => { answered = await again.result.current.beforeWallet(collection); });
    expect(answered).toBe(true);
    expect(again.result.current.view).toEqual({ phase: 'published', total: 2 });
    expect(turbo.calls).toHaveLength(1);
  });

  it('the press waits for Turbo: the wallet is not reached while an upload is still out', async () => {
    let answer!: (results: readonly PublishResult[]) => void;
    const publish = vi.fn(() => new Promise<readonly PublishResult[]>((resolve) => { answer = resolve; })) as unknown as Publish;
    const { result } = renderHook(() => usePicturePublish({ ...base(publish), draft: { ...draft, collectionCover: null } }));
    let answered: boolean | null = null;
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.beforeWallet(token); });
    void pending.then((value) => { answered = value; });
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    await settle();
    expect(answered).toBeNull();
    expect(result.current.view).toEqual({ phase: 'publishing', done: 0, total: 1 });
    await act(async () => { answer([{ sha256: COVER.sha256, ok: true, id: 'x'.repeat(43), itemBytes: 100, ms: 5 }]); await pending; });
    expect(answered).toBe(true);
  });

  it('a picture published here is kept for the page: its hash shows the picture at once, with no lookup', async () => {
    const turbo = fakePublish();
    const picture = (seed: number) => {
      const bytes = Uint8Array.from({ length: 80 }, (_, i) => (i < 8 ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][i] ?? 0 : (seed + i * 5) & 255));
      return { sha256: sha256Hex(bytes) as `0x${string}`, url: null, bytes: bytes.length, data: Buffer.from(bytes).toString('base64') };
    };
    const [logo, cover] = [picture(1), picture(2)];
    const spec = { ...collection, coverSha256: logo.sha256, collectionCoverSha256: cover.sha256 };
    const { result } = renderHook(() => usePicturePublish({ ...base(turbo.publish), draft: { cover: logo, collectionCover: cover, art: artOf() } }));
    await act(async () => { await result.current.beforeWallet(spec); });
    expect(result.current.view).toEqual({ phase: 'published', total: 2 });
    await waitFor(() => expect(knownArweavePicture(logo.sha256)).not.toBeNull());
    await waitFor(() => expect(knownArweavePicture(cover.sha256)?.id).toBe(cover.sha256.slice(2, 45)));
  });

  it('off where the source does not keep pictures on Arweave (local stacks, tests, other builds): the press goes on, nothing is published', async () => {
    const turbo = fakePublish();
    const onArweave = vi.fn(nowhere);
    const { result } = renderHook(() => usePicturePublish({ ...base(turbo.publish), on: false, onArweave }));
    let answered: boolean | null = null;
    await act(async () => { answered = await result.current.beforeWallet(collection); });
    expect(answered).toBe(true);
    expect(turbo.calls).toHaveLength(0);
    expect(onArweave).not.toHaveBeenCalled();
    expect(result.current.view).toEqual({ phase: 'off' });
  });

  it('a picture Arweave already has (anyone’s copy with the same bytes, found by its fingerprint) is not sent again', async () => {
    const turbo = fakePublish();
    const onArweave = vi.fn(async (sha256: string) => sha256 === COVER.sha256);
    const { result } = renderHook(() => usePicturePublish({ ...base(turbo.publish), onArweave }));
    await act(async () => { await result.current.beforeWallet(collection); });
    expect(result.current.view).toEqual({ phase: 'published', total: 2 });
    expect(onArweave).toHaveBeenCalledTimes(2);
    expect(turbo.calls.map((call) => call.map((p) => p.sha256))).toEqual([[COLLECTION_COVER.sha256]]);
  });

  it('a failed upload stops the press once (the line, with Retry); the next press goes on without it; Retry sends only the rest', async () => {
    const turbo = fakePublish(new Set([COLLECTION_COVER.sha256]));
    const { result } = renderHook(() => usePicturePublish(base(turbo.publish)));
    let answered: boolean | null = null;
    await act(async () => { answered = await result.current.beforeWallet(collection); });
    expect(answered).toBe(false);
    expect(result.current.view).toEqual({ phase: 'failed', done: 1, total: 2, reason: 'network' });
    expect(result.current.retry).not.toBeNull();
    // Create may continue: the next press is not held by the same pictures again (Add picture is the fallback).
    await act(async () => { answered = await result.current.beforeWallet(collection); });
    expect(answered).toBe(true);
    expect(turbo.calls).toHaveLength(1);
    await act(async () => { result.current.retry?.(); });
    await waitFor(() => expect(result.current.view).toEqual({ phase: 'published', total: 2 }));
    expect(turbo.calls.map((call) => call.map((p) => p.sha256))).toEqual([[COVER.sha256, COLLECTION_COVER.sha256], [COLLECTION_COVER.sha256]]);
  });

  it('a picture the draft no longer has is named missing (no Retry: it would not help); the next press goes on', async () => {
    const turbo = fakePublish();
    const { result } = renderHook(() => usePicturePublish({ ...base(turbo.publish), draft: { ...draft, collectionCover: null } }));
    let answered: boolean | null = null;
    await act(async () => { answered = await result.current.beforeWallet(collection); });
    expect(answered).toBe(false);
    expect(result.current.view).toEqual({ phase: 'failed', done: 1, total: 2, reason: 'missing' });
    expect(result.current.retry).toBeNull();
    await act(async () => { answered = await result.current.beforeWallet(collection); });
    expect(answered).toBe(true);
  });
});

describe('the status line', () => {
  it('numbers first, a few words; Retry only after a failed upload', () => {
    expect(picturesText({ phase: 'off' })).toBeNull();
    expect(picturesText({ phase: 'publishing', done: 0, total: 2 })).toBe('Publishing pictures · 0/2');
    expect(picturesText({ phase: 'published', total: 2 })).toBe('Pictures published · 2/2');
    expect(picturesText({ phase: 'failed', done: 1, total: 2, reason: 'refused' })).toBe('Pictures not published · 1/2');
    expect(picturesText({ phase: 'failed', done: 0, total: 1, reason: 'too-large' })).toBe('Too large to store for free · 0/1');
    expect(picturesText({ phase: 'failed', done: 1, total: 2, reason: 'missing' })).toBe('Pictures missing · 1/2. Add them on the box page.');
    const retry = vi.fn();
    render(<PicturesStatus view={{ phase: 'failed', done: 1, total: 2, reason: 'network' }} onRetry={retry} />);
    expect(screen.getByRole('status').textContent).toBe('Pictures not published · 1/2');
    act(() => { screen.getByRole('button', { name: 'Retry' }).click(); });
    expect(retry).toHaveBeenCalledTimes(1);
    cleanup();
    const { container } = render(<PicturesStatus view={{ phase: 'off' }} onRetry={null} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('fix round 1: the fingerprint check before the wallet', () => {
  it('Arweave’s copy found by its fingerprint answers true; a check that cannot finish holds the press at most FOUND_CHECK_MS (then the picture is published)', async () => {
    const bytes = Uint8Array.from({ length: 80 }, (_, i) => (i < 8 ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][i] ?? 0 : (i * 7) & 255));
    const sha256 = sha256Hex(bytes) as `0x${string}`;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => (String(input).endsWith('/graphql')
      ? Response.json({ data: { transactions: { edges: [{ node: { id: 'A'.repeat(43), data: { size: '80' }, block: { height: 1 } } }] } } })
      : new Response(bytes.slice())));
    expect(await alreadyOnArweave(sha256)).toBe(true);
    vi.unstubAllGlobals();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      // Every gateway silent: the check gives up at its own limit, well before the reader's 15 s.
      vi.stubGlobal('fetch', (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); }));
      let answer: boolean | null = null;
      void alreadyOnArweave(COVER.sha256).then((value) => { answer = value; });
      await vi.advanceTimersByTimeAsync(FOUND_CHECK_MS - 1);
      expect(answer).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(answer).toBe(false);
      expect(FOUND_CHECK_MS).toBe(5_000);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe('SH-WITHHELD-SITE fix round af2: Create refuses a picture on our withheld list (R77-TAKEDOWN-CREATE, "refuse")', () => {
  const nowhere = vi.fn(async () => false);
  const inputOf = (publish: Publish, onArweave: (sha256: `0x${string}`) => Promise<boolean> = nowhere): PicturePublishInput => ({ on: true, draft, chainId: 11155111, digest, publish, onArweave });
  const settle = pause;
  type Hook = { readonly current: ReturnType<typeof usePicturePublish> };
  const press = async (result: Hook, spec: typeof collection): Promise<boolean | null> => {
    let answered: boolean | null = null;
    await act(async () => { answered = await result.current.beforeWallet(spec); });
    return answered;
  };
  afterEach(() => { resetWithheldForTests(); vi.unstubAllGlobals(); nowhere.mockClear(); });

  it('a listed picture: the press stops before anything is searched or sent, one line, no Retry; every press again; another picture goes on', async () => {
    withheldList([bytesId(COLLECTION_COVER.sha256)]);
    const turbo = fakePublish();
    const onArweave = vi.fn(nowhere);
    const { result } = renderHook(() => usePicturePublish(inputOf(turbo.publish, onArweave)));
    expect(await press(result, collection)).toBe(false);
    expect(result.current.view).toEqual({ phase: 'withheld' });
    expect(picturesText(result.current.view)).toBe('This picture can’t be used.');
    expect(result.current.retry).toBeNull();
    // Nothing reaches Arweave, not even the unlisted logo, and nothing is searched for.
    expect(turbo.calls).toHaveLength(0);
    expect(onArweave).not.toHaveBeenCalled();
    // The next press with that picture stops the same way (a refusal is not a failure the next press goes past).
    expect(await press(result, collection)).toBe(false);
    expect(turbo.calls).toHaveLength(0);
    // The rest of Create stays usable: a box without that picture goes on and publishes its own.
    expect(await press(result, token)).toBe(true);
    expect(result.current.view).toEqual({ phase: 'published', total: 1 });
    expect(turbo.calls.map((call) => call.map((p) => p.sha256))).toEqual([[COVER.sha256]]);
    render(<PicturesStatus view={{ phase: 'withheld' }} onRetry={null} />);
    expect(screen.getByRole('status').textContent).toBe(REFUSED_PICTURE_TEXT);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('an unlisted picture goes on as before: checked against the list, then published', async () => {
    const list = withheldList([OTHER]);
    const turbo = fakePublish();
    const { result } = renderHook(() => usePicturePublish(inputOf(turbo.publish)));
    expect(await press(result, collection)).toBe(true);
    expect(result.current.view).toEqual({ phase: 'published', total: 2 });
    expect(turbo.calls.map((call) => call.map((p) => p.sha256))).toEqual([[COVER.sha256, COLLECTION_COVER.sha256]]);
    expect(list.reads).toHaveBeenCalledTimes(1);
  });

  it('the check waits for the list’s first read: nothing is searched or sent before it; listed in it, refused', async () => {
    let answer: (response: Response) => void = () => undefined;
    resetWithheldForTests({ origin: API, fetcher: vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })) as unknown as typeof fetch });
    const turbo = fakePublish();
    const onArweave = vi.fn(nowhere);
    const { result } = renderHook(() => usePicturePublish(inputOf(turbo.publish, onArweave)));
    let answered: boolean | null = null;
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.beforeWallet(collection); });
    void pending.then((value) => { answered = value; });
    await settle();
    expect(answered).toBeNull();
    expect(onArweave).not.toHaveBeenCalled();
    expect(turbo.calls).toHaveLength(0);
    await act(async () => { answer(Response.json({ version: 1, hashes: [h(bytesId(COVER.sha256))] })); await pending; });
    expect(answered).toBe(false);
    expect(result.current.view).toEqual({ phase: 'withheld' });
    expect(turbo.calls).toHaveLength(0);
  });

  it('without SubtleCrypto a picture counts as listed (the list has entries): refused, nothing sent', async () => {
    withheldList([OTHER]);
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    expect(globalThis.crypto.subtle).toBeUndefined();
    const turbo = fakePublish();
    const { result } = renderHook(() => usePicturePublish(inputOf(turbo.publish)));
    expect(await press(result, collection)).toBe(false);
    expect(result.current.view).toEqual({ phase: 'withheld' });
    expect(turbo.calls).toHaveLength(0);
  });

  it('a picture listed after a failed press: the next press, which would go on, and Retry are refused too; nothing more sent', async () => {
    const list = withheldList([], [bytesId(COLLECTION_COVER.sha256)]);
    const turbo = fakePublish(new Set([COLLECTION_COVER.sha256]));
    const { result } = renderHook(() => usePicturePublish(inputOf(turbo.publish)));
    expect(await press(result, collection)).toBe(false);
    expect(result.current.view).toMatchObject({ phase: 'failed', reason: 'network' });
    const retry = result.current.retry;
    expect(retry).not.toBeNull();
    expect(turbo.calls).toHaveLength(1);
    await list.refresh();
    expect(await press(result, collection)).toBe(false);
    expect(result.current.view).toEqual({ phase: 'withheld' });
    await act(async () => { retry?.(); });
    await settle();
    expect(result.current.view).toEqual({ phase: 'withheld' });
    expect(turbo.calls).toHaveLength(1);
  });

  it('a spec with no picture asks nothing (no list read)', async () => {
    const list = withheldList([OTHER]);
    expect(await refusedPicture([`0x${'0'.repeat(64)}`, `0x${'0'.repeat(64)}`])).toBe(false);
    expect(await refusedPicture([])).toBe(false);
    expect(list.reads).not.toHaveBeenCalled();
    expect(await refusedPicture(committedPictureHashes(collection, artOf()) ?? [])).toBe(false);
    expect(list.reads).toHaveBeenCalledTimes(1);
  });
});

describe('SH-WITHHELD-SITE fix round af3, Medium: every picture the spec commits counts (R77-TAKEDOWN-CREATE)', () => {
  const ITEMS = artOf();
  /** A new collection whose page commits a banner and teasers (add-on 6), and whose art commits its item pictures. */
  const full = buildSpecV2({ ...inputV2Of(config('bag-holders')), page: PAGE, art: ITEMS });
  const pageDraft = { cover: COVER, collectionCover: COLLECTION_COVER, page: PAGE, art: ITEMS };
  const nowhere = vi.fn(async () => false);
  afterEach(() => { resetWithheldForTests(); nowhere.mockClear(); });
  const roles: readonly (readonly [string, string])[] = [
    ['logo', COVER.sha256],
    ['collection cover', COLLECTION_COVER.sha256],
    ['banner', PAGE.banner?.sha256 ?? ''],
    ['teaser', PAGE.teasers[0]?.sha256 ?? ''],
    ['item', ITEMS.items[0]?.imageSha256 ?? ''],
  ];

  it('the spec commits all five roles here', () => {
    const hashes = committedPictureHashes(full, ITEMS);
    for (const [role, sha256] of roles) expect(hashes, role).toContain(sha256.toLowerCase());
  });

  it.each(roles)('a listed %s: the press stops before anything is searched or sent; nothing reaches the wallet', async (_role, sha256) => {
    resetWithheldForTests({ origin: API, fetcher: vi.fn(async () => Response.json({ version: 1, hashes: [h(bytesId(sha256))] })) as unknown as typeof fetch });
    const turbo = fakePublish();
    const onArweave = vi.fn(nowhere);
    const { result } = renderHook(() => usePicturePublish({ on: true, draft: pageDraft, chainId: 11155111, digest, publish: turbo.publish, onArweave }));
    let answered: boolean | null = null;
    await act(async () => { answered = await result.current.beforeWallet(full); });
    expect(answered).toBe(false);
    expect(result.current.view).toEqual({ phase: 'withheld' });
    expect(picturesText(result.current.view)).toBe(REFUSED_PICTURE_TEXT);
    expect(turbo.calls).toHaveLength(0);
    expect(onArweave).not.toHaveBeenCalled();
  });

  it('a press after a failed one, and Retry, use the same set: an item listed meanwhile stops both', async () => {
    const list = withheldList([], [bytesId(ITEMS.items[1]?.imageSha256 ?? '')]);
    const turbo = fakePublish(new Set([COLLECTION_COVER.sha256]));
    const { result } = renderHook(() => usePicturePublish({ on: true, draft: pageDraft, chainId: 11155111, digest, publish: turbo.publish, onArweave: nowhere }));
    let answered: boolean | null = null;
    await act(async () => { answered = await result.current.beforeWallet(full); });
    expect(answered).toBe(false);
    expect(result.current.view).toMatchObject({ phase: 'failed', reason: 'network' });
    const retry = result.current.retry;
    await list.refresh();
    await act(async () => { answered = await result.current.beforeWallet(full); });
    expect(answered).toBe(false);
    expect(result.current.view).toEqual({ phase: 'withheld' });
    await act(async () => { retry?.(); await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(result.current.view).toEqual({ phase: 'withheld' });
    expect(turbo.calls).toHaveLength(1);
  });
});

describe('SH-WITHHELD-SITE fix round af3, High: the list as it is then, at each step of a publish', () => {
  afterEach(() => { resetWithheldForTests(); vi.unstubAllGlobals(); });
  type Hook = { readonly current: ReturnType<typeof usePicturePublish> };
  /** Create's press, left running: its answer once it ends. */
  const pressing = (result: Hook, spec: typeof collection) => {
    const out: { answered: boolean | null; pending: Promise<boolean> } = { answered: null, pending: Promise.resolve(false) };
    act(() => { out.pending = result.current.beforeWallet(spec); });
    void out.pending.then((value) => { out.answered = value; });
    return out;
  };

  it('the reviewer’s case: the six search answers held, a refresh lists the collection cover, then nothing found: nothing uploaded, no wallet', async () => {
    const list = withheldList([], [bytesId(COLLECTION_COVER.sha256)]);
    const searches = hold();
    const graphql: string[] = [];
    const raw: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/graphql')) { graphql.push(url); await searches.held; return Response.json({ data: { transactions: { edges: [] } } }); }
      raw.push(url);
      return new Response(null, { status: 404 });
    }));
    const turbo = fakePublish();
    // The default fingerprint check: the reader's own search (alreadyOnArweave), three gateways for each picture.
    const { result } = renderHook(() => usePicturePublish({ on: true, draft, chainId: 11155111, digest, publish: turbo.publish }));
    const press = pressing(result, collection);
    await waitFor(() => expect(graphql).toHaveLength(6));
    await list.refresh();
    searches.release();
    await act(async () => { await press.pending; });
    expect(press.answered).toBe(false);
    expect(result.current.view).toEqual({ phase: 'withheld' });
    expect(result.current.retry).toBeNull();
    expect(turbo.calls).toHaveLength(0);
    expect(raw).toEqual([]);
  });

  it('a refresh while the pictures are read (their hashing held): stopped before any search or upload', async () => {
    const list = withheldList([], [bytesId(COVER.sha256)]);
    const reading = hold();
    const slow = async (bytes: Uint8Array) => { await reading.held; return digest(bytes); };
    const turbo = fakePublish();
    const onArweave = vi.fn(async () => false);
    const { result } = renderHook(() => usePicturePublish({ on: true, draft, chainId: 11155111, digest: slow, publish: turbo.publish, onArweave }));
    const press = pressing(result, collection);
    await waitFor(() => expect(list.reads).toHaveBeenCalledTimes(1));
    await pause();
    await list.refresh();
    reading.release();
    await act(async () => { await press.pending; });
    expect(press.answered).toBe(false);
    expect(result.current.view).toEqual({ phase: 'withheld' });
    expect(onArweave).not.toHaveBeenCalled();
    expect(turbo.calls).toHaveLength(0);
  });

  it('a refresh during the upload: its bytes went, but the press stops before the wallet', async () => {
    const list = withheldList([], [bytesId(COVER.sha256)]);
    const upload = hold();
    const sent: (readonly PictureToPublish[])[] = [];
    const publish = vi.fn(async (pictures: readonly PictureToPublish[], options: PublishOptions) => {
      sent.push(pictures);
      await upload.held;
      return pictures.map((picture) => {
        const result: PublishResult = { sha256: picture.sha256, ok: true, id: `${picture.sha256.slice(2, 45)}`, itemBytes: 100, ms: 5 };
        options.onResult?.(result);
        return result;
      });
    }) as unknown as Publish;
    const { result } = renderHook(() => usePicturePublish({ on: true, draft, chainId: 11155111, digest, publish, onArweave: async () => false }));
    const press = pressing(result, collection);
    await waitFor(() => expect(sent).toHaveLength(1));
    await list.refresh();
    upload.release();
    await act(async () => { await press.pending; });
    expect(press.answered).toBe(false);
    expect(result.current.view).toEqual({ phase: 'withheld' });
  });

  it('Retry takes the same steps: a refresh during its search stops it before the upload', async () => {
    const list = withheldList([], [bytesId(COLLECTION_COVER.sha256)]);
    const turbo = fakePublish(new Set([COLLECTION_COVER.sha256]));
    const gate: { search: ReturnType<typeof hold> | null } = { search: null };
    const onArweave = vi.fn(async () => { if (gate.search) await gate.search.held; return false; });
    const { result } = renderHook(() => usePicturePublish({ on: true, draft, chainId: 11155111, digest, publish: turbo.publish, onArweave }));
    let answered: boolean | null = null;
    await act(async () => { answered = await result.current.beforeWallet(collection); });
    expect(answered).toBe(false);
    expect(result.current.view).toMatchObject({ phase: 'failed', reason: 'network' });
    expect(turbo.calls).toHaveLength(1);
    gate.search = hold();
    act(() => { result.current.retry?.(); });
    // The logo went with the first press; Retry searches only for the collection cover.
    await waitFor(() => expect(onArweave).toHaveBeenCalledTimes(3));
    await list.refresh();
    gate.search.release();
    await waitFor(() => expect(result.current.view).toEqual({ phase: 'withheld' }));
    expect(turbo.calls).toHaveLength(1);
  });
});

describe('SH-WITHHELD-SITE fix round af4, High: the list right before every upload request (the real publisher)', () => {
  afterEach(() => { resetWithheldForTests(); });
  const UPLOAD = 'https://upload.test';
  /** A raster picture as the draft keeps it (a PNG signature first), well inside Turbo's free size. */
  const raster = (seed: number) => {
    const bytes = Uint8Array.from({ length: 80 }, (_, i) => (i < 8 ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][i] ?? 0 : (seed + i * 5) & 255));
    return { sha256: sha256Hex(bytes) as `0x${string}`, url: null, bytes: bytes.length, data: Buffer.from(bytes).toString('base64') };
  };
  const LOGO = raster(41);
  const SECOND = raster(42);
  const spec = { ...collection, coverSha256: LOGO.sha256, collectionCoverSha256: SECOND.sha256 };
  /** Turbo, a double for the real publisher: `/info` and the first POST's answer can be held; it accepts every item. */
  function turboDouble(gates: { readonly info?: Promise<void>; readonly first?: Promise<void> } = {}) {
    const posted: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${UPLOAD}/info`) { await gates.info; return Response.json({ freeUploadLimitBytes: 107_520 }); }
      if (url === `${UPLOAD}/v1/tx` && init?.method === 'POST') {
        const item = await verifyEthDataItem(new Uint8Array(init.body as Uint8Array));
        posted.push(sha256Hex(item?.data ?? new Uint8Array()));
        if (posted.length === 1) await gates.first;
        return Response.json({ id: item?.id });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const publish = ((pictures: readonly PictureToPublish[], options: PublishOptions) => publishToArweave(pictures, { ...options, fetcher, upload: UPLOAD })) as Publish;
    return { publish, posted, fetcher };
  }
  const inputOf = (publish: Publish): PicturePublishInput => ({ on: true, draft: { cover: LOGO, collectionCover: SECOND, art: artOf() }, chainId: 11155111, digest, publish, onArweave: async () => false });
  type Hook = { readonly current: ReturnType<typeof usePicturePublish> };
  const pressing = (result: Hook) => {
    const out: { answered: boolean | null; pending: Promise<boolean> } = { answered: null, pending: Promise.resolve(false) };
    act(() => { out.pending = result.current.beforeWallet(spec); });
    void out.pending.then((value) => { out.answered = value; });
    return out;
  };

  it('unlisted, the real publisher sends both (the double accepts them): published, the wallet may open', async () => {
    withheldList([OTHER]);
    const turbo = turboDouble();
    const { result } = renderHook(() => usePicturePublish(inputOf(turbo.publish)));
    let answered: boolean | null = null;
    await act(async () => { answered = await result.current.beforeWallet(spec); });
    expect(answered).toBe(true);
    expect(turbo.posted).toEqual([LOGO.sha256, SECOND.sha256]);
    expect(result.current.view).toEqual({ phase: 'published', total: 2 });
  });

  it('Turbo’s /info held, the list then names the cover: nothing is sent, the line, no wallet', async () => {
    const list = withheldList([], [bytesId(SECOND.sha256)]);
    const info = hold();
    const turbo = turboDouble({ info: info.held });
    const { result } = renderHook(() => usePicturePublish(inputOf(turbo.publish)));
    const press = pressing(result);
    await waitFor(() => expect(turbo.fetcher).toHaveBeenCalledTimes(1));
    await list.refresh();
    info.release();
    await act(async () => { await press.pending; });
    expect(turbo.posted).toEqual([]);
    expect(press.answered).toBe(false);
    expect(result.current.view).toEqual({ phase: 'withheld' });
    expect(result.current.retry).toBeNull();
  });

  it('the first upload’s answer held, the list then names the unsent cover: only the logo went, the line, no wallet', async () => {
    const list = withheldList([], [bytesId(SECOND.sha256)]);
    const first = hold();
    const turbo = turboDouble({ first: first.held });
    const { result } = renderHook(() => usePicturePublish(inputOf(turbo.publish)));
    const press = pressing(result);
    await waitFor(() => expect(turbo.posted).toHaveLength(1));
    await list.refresh();
    first.release();
    await act(async () => { await press.pending; });
    expect(turbo.posted).toEqual([LOGO.sha256]);
    expect(press.answered).toBe(false);
    expect(result.current.view).toEqual({ phase: 'withheld' });
    expect(result.current.retry).toBeNull();
  });
});

describe('SH-WITHHELD-SITE fix round af4, Low: the list once the upload settles, whatever its outcome', () => {
  afterEach(() => { resetWithheldForTests(); });

  it('the upload held, the list then names the logo, and the upload fails (network): the line without Retry, not a failure with Retry', async () => {
    const list = withheldList([], [bytesId(COVER.sha256)]);
    const upload = hold();
    const publish = vi.fn(async (pictures: readonly PictureToPublish[], options: PublishOptions) => {
      await upload.held;
      return pictures.map((picture) => {
        const result: PublishResult = { sha256: picture.sha256, ok: false, reason: 'network', itemBytes: 100 };
        options.onResult?.(result);
        return result;
      });
    }) as unknown as Publish;
    const { result } = renderHook(() => usePicturePublish({ on: true, draft, chainId: 11155111, digest, publish, onArweave: async () => false }));
    let answered: boolean | null = null;
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.beforeWallet(collection); });
    void pending.then((value) => { answered = value; });
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    await list.refresh();
    upload.release();
    await act(async () => { await pending; });
    expect(answered).toBe(false);
    expect(result.current.view).toEqual({ phase: 'withheld' });
    expect(result.current.retry).toBeNull();
  });

  it('a picture missing from the draft and another listed meanwhile: withheld wins over missing', async () => {
    const list = withheldList([], [bytesId(COVER.sha256)]);
    const upload = hold();
    const turbo = fakePublish();
    const publish = vi.fn(async (pictures: readonly PictureToPublish[], options: PublishOptions) => { await upload.held; return turbo.publish(pictures, options); }) as unknown as Publish;
    // The draft no longer holds the collection cover: it is missing; the logo is uploaded while the list moves on.
    const { result } = renderHook(() => usePicturePublish({ on: true, draft: { ...draft, collectionCover: null }, chainId: 11155111, digest, publish, onArweave: async () => false }));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.beforeWallet(collection); });
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    await list.refresh();
    upload.release();
    let answered: boolean | null = null;
    await act(async () => { answered = await pending; });
    expect(answered).toBe(false);
    expect(result.current.view).toEqual({ phase: 'withheld' });
  });
});

describe('SH-WITHHELD-SITE fix round af4, Medium 1: the hidden placeholder picture counts (add-on 1)', () => {
  afterEach(() => { resetWithheldForTests(); });
  /** A creator's own hidden picture, as a loaded setup or the Create page may carry it (printable ASCII, as the spec allows). */
  const CUSTOM = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3" fill="#123456"/></svg>';
  const hiddenSpec = buildSpecV2(inputV2Of(config('bag-holders'), {}, { artMode: 'hidden', hiddenSvg: CUSTOM }));
  const sha = sha256Hex(new TextEncoder().encode(CUSTOM)).toLowerCase() as `0x${string}`;

  it('the hash of its exact SVG is a committed picture, the same id the site’s sealed picture is checked by', async () => {
    expect(committedPictureHashes(hiddenSpec, artOf())).toContain(sha);
    // The box page draws it from a data URL of the same text (spec-record.ts) and checks that URL's bytes.
    expect(await inlinePictureIds(`data:image/svg+xml;base64,${btoa(CUSTOM)}`)).toEqual([bytesId(sha)]);
  });

  it('listed: the press stops before anything is searched or sent; no wallet', async () => {
    withheldList([bytesId(sha)]);
    const turbo = fakePublish();
    const onArweave = vi.fn(async () => false);
    const { result } = renderHook(() => usePicturePublish({ on: true, draft: { ...draft, art: artOf() }, chainId: 11155111, digest, publish: turbo.publish, onArweave }));
    let answered: boolean | null = null;
    await act(async () => { answered = await result.current.beforeWallet(hiddenSpec); });
    expect(answered).toBe(false);
    expect(result.current.view).toEqual({ phase: 'withheld' });
    expect(turbo.calls).toHaveLength(0);
    expect(onArweave).not.toHaveBeenCalled();
  });
});

describe('SH-WITHHELD-SITE fix round af4, Medium 2: a new collection is checked only with the art its spec commits', () => {
  afterEach(() => { resetWithheldForTests(); });
  const inputWith = (publish: Publish, art: PicturePublishInput['draft']['art']): PicturePublishInput => ({ on: true, draft: { ...draft, art }, chainId: 11155111, digest, publish, onArweave: async () => false });

  it('published with its own art; one of its items listed later and the draft’s art replaced: the saved spec stops and asks for its item pictures; restored: withheld', async () => {
    const original = artOf();
    // Item 12: in the spec's art, not in the replacement below (artOf(5) holds items 1 to 5 only).
    const listed = original.items[11]?.imageSha256 ?? '';
    expect(artOf(5).items.map((item) => item.imageSha256)).not.toContain(listed);
    const list = withheldList([], [bytesId(listed)]);
    const turbo = fakePublish();
    const { result, rerender } = renderHook((input: PicturePublishInput) => usePicturePublish(input), { initialProps: inputWith(turbo.publish, original) });
    const press = async () => { let answered: boolean | null = null; await act(async () => { answered = await result.current.beforeWallet(collection); }); return answered; };
    expect(await press()).toBe(true);
    expect(turbo.calls).toHaveLength(1);
    await list.refresh();
    // Other art in the draft (a resumed run keeps its own spec): its items are not this spec's; nothing is known of them.
    rerender(inputWith(turbo.publish, artOf(5)));
    expect(await press()).toBe(false);
    expect(result.current.view).toEqual({ phase: 'art' });
    expect(picturesText(result.current.view)).toBe(ORIGINAL_ART_TEXT);
    expect(ORIGINAL_ART_TEXT).toBe('Add this box’s own item pictures again to go on.');
    expect(result.current.retry).toBeNull();
    // No art at all: the same.
    rerender(inputWith(turbo.publish, null));
    expect(await press()).toBe(false);
    expect(result.current.view).toEqual({ phase: 'art' });
    // The spec's own art again: its listed item stops the press.
    rerender(inputWith(turbo.publish, artOf()));
    expect(await press()).toBe(false);
    expect(result.current.view).toEqual({ phase: 'withheld' });
    expect(turbo.calls).toHaveLength(1);
  });

  it('a press after a failed one, and Retry, ask for the same art: other art stops both, nothing more sent', async () => {
    const turbo = fakePublish(new Set([COLLECTION_COVER.sha256]));
    const { result, rerender } = renderHook((input: PicturePublishInput) => usePicturePublish(input), { initialProps: inputWith(turbo.publish, artOf()) });
    let answered: boolean | null = null;
    await act(async () => { answered = await result.current.beforeWallet(collection); });
    expect(answered).toBe(false);
    expect(result.current.view).toMatchObject({ phase: 'failed', reason: 'network' });
    const retry = result.current.retry;
    rerender(inputWith(turbo.publish, artOf(5)));
    await act(async () => { answered = await result.current.beforeWallet(collection); });
    expect(answered).toBe(false);
    expect(result.current.view).toEqual({ phase: 'art' });
    await act(async () => { retry?.(); await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(result.current.view).toEqual({ phase: 'art' });
    expect(turbo.calls).toHaveLength(1);
  });
});
