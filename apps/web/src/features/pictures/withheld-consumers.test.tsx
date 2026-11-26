import { blankPng } from '../../../../../packages/cards/src/test-support';
/**
 * SH-WITHHELD-SITE (F157 (3)): every picture consumer checks our withheld list before it fetches or shows a picture.
 * A listed picture is never asked of any gateway (our node, the browser's cache, Arweave) and never drawn: the neutral
 * "Picture withheld" tile stands in its place; a picture kept for the page, one just published and one a lookup in flight
 * brings back are checked too; a list refresh turns a shown picture into the tile without a reload. No network: the list,
 * our node, the Arweave gateways, the indexer and the chain are doubles. (The vault items panel and the hidden draws
 * have their own cases in their panels' tests.)
 */
import { rawCidV1, sha256Hex } from '@squarehole/artwork';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { BoxRecord } from '../boxes/box-model';
import { BoxCover, TokenMark } from '../boxes/BoxParts';
import { fetchVerifiedPicture, picturesOf, resetPicturesForTests, showPublishedPicture, usePictureState, type PictureState } from '../boxes/box-pictures';
import { RevealedItems } from '../boxes/ChainItems';
import { ContentsPanel } from '../boxes/ContentsPanel';
import { PeekStrip } from '../boxes/HeaderSide';
import { SealedPicture } from '../boxes/SealedPicture';
import { recordFromSpec } from '../boxes/spec-record';
import { buildSpec } from '../create/create-model';
import { formOf, inputOf } from '../create/test-support/fixtures';
import { specHash } from '@squarehole/box-spec';
import { DEMO_BOX0_ROW } from '../core/demo-row';
import { recordFromRow } from '../core/row-record';
import { AddPictureV2 } from '../core/v2/AddPictureV2';
import { alreadyOnArweave } from '../create/v2/usePicturePublish';
import { findItemPicture, resetItemPicturesForTests, type PictureContext } from '../set/set-pictures';
import { SetItemPicture } from '../set/SetItemPicture';
import { COLLECTION, FakeSetChain } from '../set/test-support/set-chain';
import { arweavePicture, findArweavePicture, knownArweavePicture, rememberArweavePicture, type ReadOptions } from './arweave-read';
import { REFRESH_MS, WITHHELD_TEXT, isWithheldResult, resetWithheldForTests, type Withheld } from './withheld';

const API = 'https://api.example.test';
const GATEWAY = 'http://127.0.0.1:5421';
const T = 'https://turbo-gateway.com';
const A = 'https://arweave.net';
const G = 'https://goldsky.arweave.net';
const png = (seed: number) => blankPng(seed + 2, seed + 2);
const LOGO = png(1); const COVER = png(2); const ITEM = png(3); const AVATAR = png(4);
const shaOf = (bytes: Uint8Array) => sha256Hex(bytes).toLowerCase() as `0x${string}`;
const LOGO_SHA = shaOf(LOGO); const COVER_SHA = shaOf(COVER); const ITEM_SHA = shaOf(ITEM); const AVATAR_SHA = shaOf(AVATAR);
/** A picture's id on the list: `ipfs:` + the raw CID of its bytes' SHA-256 (our gateway's id). */
const bytesId = (sha: `0x${string}`) => `ipfs:${rawCidV1(sha)}`;
const arId = (id: string) => `ar:${id}`;
const tx = (letter: string) => `${letter}${'x'.repeat(42)}`;
const h = (id: string) => createHash('sha256').update(`sh-withheld-v1:${id}`).digest('hex');
const record = (pictures: BoxRecord['pictures'], extra: Record<string, unknown> = {}) =>
  ({ market: null, rehearsal: false, art: null, spec: null, ticker: 'T', pictures, v2Chain: { source: { manifest: { chainId: 11155111 } }, snapshot: null }, ...extra }) as unknown as BoxRecord;

/**
 * Our API's list, a double: each read answers the next of `lists` (the last one repeated). `refresh` is the page looked
 * at again a minute later (its visibility change): the list is read again, with no reload and no remount.
 */
function withheldList(...lists: string[][]) {
  let clock = 1_000_000;
  const asked: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    asked.push(String(input));
    const ids = lists[Math.min(asked.length - 1, lists.length - 1)] ?? [];
    return Response.json({ version: 1, hashes: ids.map(h).sort() });
  }) as unknown as typeof fetch;
  resetWithheldForTests({ origin: API, fetcher, now: () => clock });
  const refresh = async () => {
    const before = asked.length;
    clock += REFRESH_MS;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(asked.length).toBe(before + 1));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  };
  return { asked, refresh };
}

/** Our node (`/ipfs/<cid>`) and the Arweave gateways: `search` answers by hash (oldest first), `raw` serves by id. */
function hosts(ipfs: Record<string, Uint8Array> = {}, raw: Record<string, Uint8Array> = {}, search: Record<string, readonly string[]> = {}) {
  const asked: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    asked.push(url.href);
    if (url.origin === GATEWAY) {
      const file = ipfs[url.pathname.replace('/ipfs/', '')];
      return file ? new Response(file.slice()) : new Response(null, { status: 404 });
    }
    if (url.pathname === '/graphql') {
      const sha = (JSON.parse(String(init?.body)) as { variables: { sha: string[] } }).variables.sha[0] ?? '';
      return Response.json({ data: { transactions: { edges: (search[sha] ?? []).map((id, height) => ({ node: { id, data: { size: '64' }, block: { height } } })) } } });
    }
    const file = raw[url.pathname.replace('/raw/', '')];
    return file ? new Response(file.slice()) : new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  return { fetcher, asked };
}
const opts = (fetcher: typeof fetch, more: ReadOptions = {}): ReadOptions => ({ fetcher, searchGateways: [T, A, G], rawGateways: [T, A], ...more });
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

beforeEach(() => {
  vi.stubGlobal('fetch', () => { throw new Error('no network in unit tests'); });
});
afterEach(() => {
  cleanup();
  resetPicturesForTests();
  resetItemPicturesForTests();
  resetWithheldForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('box pictures (box-pictures.ts) and their tiles (BoxParts.tsx BoxCover, TokenMark)', () => {
  it('a listed cover is the tile: nothing asked of our node, the browser’s cache or Arweave; the unlisted logo shows', async () => {
    const list = withheldList([bytesId(COVER_SHA)]);
    const g = hosts({ [rawCidV1(LOGO_SHA)]: LOGO, [rawCidV1(COVER_SHA)]: COVER }, { [tx('C')]: COVER }, { [COVER_SHA.slice(2)]: [tx('C')] });
    resetPicturesForTests(g.fetcher);
    const box = record(picturesOf(LOGO_SHA, COVER_SHA, [GATEWAY], { copies: { cover: tx('C') } }));
    const { container } = render(<><BoxCover record={box} /><TokenMark record={box} /></>);
    const tile = await screen.findByRole('img', { name: WITHHELD_TEXT });
    expect(tile.closest('.sh-box-cover')?.getAttribute('data-art')).toBe('withheld');
    expect(tile.textContent).toBe(WITHHELD_TEXT);
    expect(tile.getAttribute('title')).toBe(WITHHELD_TEXT);
    await waitFor(() => expect(container.querySelector('img.sh-box-coin--logo')).not.toBeNull());
    expect(container.querySelector('.sh-box-cover img')).toBeNull();
    // The logo was asked of our node; nothing of the cover, anywhere, and no Arweave request at all for it.
    expect(g.asked).toEqual([`${GATEWAY}/ipfs/${rawCidV1(LOGO_SHA)}`]);
    expect(list.asked).toEqual([`${API}/v2/withheld`]);
  });

  it('a listed logo: the mark is a plain round tile (decoration, like the logo), never the creator’s own cover in its place', async () => {
    withheldList([bytesId(LOGO_SHA)]);
    const g = hosts({ [rawCidV1(LOGO_SHA)]: LOGO });
    resetPicturesForTests(g.fetcher);
    const box = record(picturesOf(LOGO_SHA, null, [GATEWAY]), { spec: { coverUrl: `data:image/png;base64,${btoa(String.fromCharCode(...LOGO))}` } });
    const { container } = render(<TokenMark record={box} size={40} />);
    await waitFor(() => expect(container.querySelector('[data-withheld]')).not.toBeNull());
    const mark = container.querySelector<HTMLElement>('[data-withheld]');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    expect(mark?.className).toContain('sh-withheld--mark');
    expect(mark?.style.width).toBe('40px');
    expect(container.querySelector('img')).toBeNull();
    expect(g.asked).toEqual([]);
  });

  it('a list refresh turns a shown picture into the tile without a reload and lets its blob go; taken off the list, it is asked for again', async () => {
    const list = withheldList([], [bytesId(COVER_SHA)], []);
    const g = hosts({ [rawCidV1(COVER_SHA)]: COVER });
    resetPicturesForTests(g.fetcher);
    const create = vi.fn(() => 'blob:sh-test/cover');
    const revoke = vi.fn();
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    onTestFinished(() => { URL.createObjectURL = original.create; URL.revokeObjectURL = original.revoke; });
    const states: PictureState[] = [];
    function Probe() { states.push(usePictureState(COVER_SHA, [GATEWAY])); return null; }
    const { container } = render(<><BoxCover record={record(picturesOf(COVER_SHA, null, [GATEWAY]))} /><Probe /></>);
    await waitFor(() => expect(container.querySelector('.sh-box-cover img')?.getAttribute('src')).toBe('blob:sh-test/cover'));
    await list.refresh();
    await waitFor(() => expect(container.querySelector('.sh-box-cover')?.getAttribute('data-art')).toBe('withheld'));
    expect(container.querySelector('.sh-box-cover img')).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:sh-test/cover');
    expect(states.at(-1)).toEqual({ url: null, missing: false, withheld: true });
    expect(g.asked).toHaveLength(1);
    await list.refresh();
    await waitFor(() => expect(container.querySelector('.sh-box-cover img')).not.toBeNull());
    expect(g.asked).toHaveLength(2);
    expect(states.at(-1)).toMatchObject({ withheld: false, missing: false });
  });

  it('fetchVerifiedPicture (IPFS reads, cached answers included): a listed picture is never asked, not even of the browser’s cache', async () => {
    withheldList([bytesId(LOGO_SHA)]);
    const g = hosts({ [rawCidV1(LOGO_SHA)]: LOGO, [rawCidV1(COVER_SHA)]: COVER });
    expect(await fetchVerifiedPicture(LOGO_SHA, [GATEWAY], g.fetcher)).toEqual({ withheld: true, keys: [h(bytesId(LOGO_SHA))] });
    expect(g.asked).toEqual([]);
    expect(await fetchVerifiedPicture(COVER_SHA, [GATEWAY], g.fetcher)).toEqual({ bytes: COVER, type: 'image/png' });
  });

  it('box 0’s bundled pictures pass the same check', async () => {
    const { MISFITS_COLLECTION_COVER_SHA256 } = await import('../boxes/bundled-pictures');
    withheldList([bytesId(MISFITS_COLLECTION_COVER_SHA256 as `0x${string}`)]);
    resetPicturesForTests(hosts().fetcher);
    render(<BoxCover record={record(picturesOf(MISFITS_COLLECTION_COVER_SHA256, null, []))} />);
    expect(await screen.findByRole('img', { name: WITHHELD_TEXT })).toBeTruthy();
  });
});

describe('Arweave pictures (arweave-read.ts): the picture, the indexer’s copy, the search, cached, just published, in flight', () => {
  it('the picture’s own id listed: Withheld, and not one request (no copy read, no search)', async () => {
    withheldList([bytesId(LOGO_SHA)]);
    const g = hosts({}, { [tx('L')]: LOGO }, { [LOGO_SHA.slice(2)]: [tx('L')] });
    const answer = await findArweavePicture(LOGO_SHA, opts(g.fetcher, { hint: tx('L') }));
    expect(isWithheldResult(answer)).toBe(true);
    expect(g.asked).toEqual([]);
  });

  it('the indexer’s copy listed: Withheld; it is not read and nothing is searched', async () => {
    withheldList([arId(tx('H'))]);
    const g = hosts({}, { [tx('H')]: LOGO, [tx('O')]: LOGO }, { [LOGO_SHA.slice(2)]: [tx('O')] });
    const answer = await findArweavePicture(LOGO_SHA, opts(g.fetcher, { hint: tx('H') }));
    // The keys checked: the picture's own id and the indexer's copy (fix round af1: both are the picture's ids).
    expect(answer).toEqual({ withheld: true, keys: [h(bytesId(LOGO_SHA)), h(arId(tx('H')))] });
    expect(g.asked).toEqual([]);
  });

  it('a listed copy is never read; older than the copy that matches (as the share cards read, oldest first): Withheld', async () => {
    withheldList([arId(tx('L'))]);
    const g = hosts({}, { [tx('L')]: LOGO, [tx('R')]: LOGO }, { [LOGO_SHA.slice(2)]: [tx('L'), tx('R')] });
    const answer = await findArweavePicture(LOGO_SHA, opts(g.fetcher));
    expect(isWithheldResult(answer)).toBe(true);
    expect(g.asked.filter((url) => url.includes(`/raw/${tx('L')}`))).toEqual([]);
  });

  it('a listed decoy newer than the real copy changes nothing (the real copy shows; the decoy is never read)', async () => {
    withheldList([arId(tx('D'))]);
    const g = hosts({}, { [tx('R')]: LOGO, [tx('D')]: png(9) }, { [LOGO_SHA.slice(2)]: [tx('R'), tx('D')] });
    const answer = await findArweavePicture(LOGO_SHA, opts(g.fetcher));
    expect(answer).toMatchObject({ id: tx('R'), type: 'image/png' });
    expect(g.asked.filter((url) => url.includes(`/raw/${tx('D')}`))).toEqual([]);
  });

  it('only a listed copy: Withheld, never missing, so the box page offers no Add picture for it', async () => {
    withheldList([arId(tx('L'))]);
    const g = hosts({}, { [tx('L')]: COVER }, { [COVER_SHA.slice(2)]: [tx('L')] });
    resetPicturesForTests(g.fetcher);
    const box = record(picturesOf(COVER_SHA, null, [], { copies: null }));
    const publish = vi.fn();
    render(<><BoxCover record={box} /><AddPictureV2 record={box} seams={{ publish, reshrink: null }} /></>);
    expect(await screen.findByRole('img', { name: WITHHELD_TEXT })).toBeTruthy();
    await settle();
    expect(screen.queryByText('Add picture')).toBeNull();
    expect(g.asked.filter((url) => url.includes('/raw/'))).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it('a picture kept for the page is checked as it is handed out: once listed, Withheld, dropped, nothing asked', async () => {
    const list = withheldList([], [arId(tx('K'))]);
    const g = hosts({}, { [tx('K')]: LOGO });
    const kept = await arweavePicture(LOGO_SHA, opts(g.fetcher, { hint: tx('K'), search: false }));
    expect(kept).toMatchObject({ id: tx('K') });
    expect(knownArweavePicture(LOGO_SHA)).toBe(kept);
    const asked = g.asked.length;
    await list.refresh();
    expect(knownArweavePicture(LOGO_SHA)).toBeNull();
    expect(isWithheldResult(await arweavePicture(LOGO_SHA, opts(g.fetcher, { hint: tx('K'), search: false })))).toBe(true);
    expect(g.asked.length).toBe(asked);
  });

  it('a picture this page just published: Withheld when its bytes or its new copy are listed, never kept; the tile shows', async () => {
    withheldList([bytesId(COVER_SHA)]);
    expect(isWithheldResult(await rememberArweavePicture(COVER_SHA, COVER, tx('P')))).toBe(true);
    expect(knownArweavePicture(COVER_SHA)).toBeNull();
    resetPicturesForTests(hosts().fetcher);
    expect(await act(async () => showPublishedPicture(COVER_SHA, COVER, tx('P')))).toBe(false);
    render(<BoxCover record={record(picturesOf(COVER_SHA, null, [], { copies: null }))} />);
    expect(await screen.findByRole('img', { name: WITHHELD_TEXT })).toBeTruthy();
    // The same picture under another copy that the list names: withheld as well.
    withheldList([arId(tx('Q'))]);
    expect(isWithheldResult(await rememberArweavePicture(LOGO_SHA, LOGO, tx('Q')))).toBe(true);
  });

  it('a lookup in flight when the list names its copy: the copy read is checked again and the answer is Withheld', async () => {
    const list = withheldList([], [arId(tx('F'))]);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const reads: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      reads.push(String(input));
      await held;
      return new Response(LOGO.slice());
    }) as unknown as typeof fetch;
    const pending = arweavePicture(LOGO_SHA, opts(fetcher, { hint: tx('F'), search: false }));
    await waitFor(() => expect(reads).toEqual([`${T}/raw/${tx('F')}`]));
    await list.refresh();
    release();
    expect(isWithheldResult(await pending)).toBe(true);
    expect(knownArweavePicture(LOGO_SHA)).toBeNull();
  });

  it('Create’s fingerprint check never looks for a listed picture (and does not claim Arweave has it)', async () => {
    withheldList([bytesId(LOGO_SHA)]);
    const network = vi.fn(() => { throw new Error('no network in unit tests'); });
    vi.stubGlobal('fetch', network);
    expect(await alreadyOnArweave(LOGO_SHA)).toBe(false);
    expect(network).not.toHaveBeenCalled();
  });
});

describe('the v1 item list (ChainItems.tsx): pictures drawn by URL from the indexer’s art route', () => {
  const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
  const v1 = recordFromRow({ row: DEMO_BOX0_ROW, network: 'local' }, { nowMs: NOW });
  const ref = (sha: `0x${string}`) => ({ sha256: sha, cid: rawCidV1(sha) });
  const item = { schema: 'sh.core-item.v1', chainId: v1.chainId, token: v1.token, id: '1',
    asOf: { block: '100', hash: `0x${'ab'.repeat(32)}`, timestamp: '1800000000', tier: 'head' }, revealed: true, traitsPacked: '1', traits: [],
    art: { image: ref(ITEM_SHA), avatar: ref(AVATAR_SHA), model: null } };
  const pages = vi.fn(async () => new Response(JSON.stringify({ items: [item], next: null })));
  const art = (role: string) => `img[src$="/items/1/art/${role}"]`;

  it('a listed picture is never put in an <img> (so never asked): the tile; the unlisted avatar shows; a refresh turns it into the tile', async () => {
    const list = withheldList([bytesId(ITEM_SHA)], [bytesId(ITEM_SHA), bytesId(AVATAR_SHA)]);
    const { container } = render(<RevealedItems record={v1} origin="https://indexer.invalid" fetcher={pages} />);
    expect(await screen.findByRole('img', { name: 'Item #1, picture withheld' })).toBeTruthy();
    await waitFor(() => expect(container.querySelector(art('avatar'))).not.toBeNull());
    expect(container.querySelector(art('image'))).toBeNull();
    await list.refresh();
    expect(await screen.findByRole('img', { name: 'Avatar for #1, picture withheld' })).toBeTruthy();
    expect(container.querySelector(art('avatar'))).toBeNull();
    expect(container.querySelectorAll('[data-withheld]')).toHaveLength(2);
  });

  it('while the list’s first read is out, no <img> is made at all', async () => {
    let answer: (response: Response) => void = () => undefined;
    resetWithheldForTests({ origin: API, fetcher: vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })) as unknown as typeof fetch });
    const { container } = render(<RevealedItems record={v1} origin="https://indexer.invalid" fetcher={pages} />);
    await screen.findByRole('heading', { name: '#1' });
    await settle();
    expect(container.querySelector('img')).toBeNull();
    answer(Response.json({ version: 1, hashes: [] }));
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(2));
  });
});

describe('outside items’ pictures (set-pictures.ts, SetItemPicture.tsx)', () => {
  const CID = rawCidV1(ITEM_SHA);
  const TX = tx('S');
  const ctxOf = (fetcher: typeof fetch): PictureContext => ({ ipfs: [GATEWAY], arweave: [T, A], fetcher });
  const reader = (answers: Record<string, Uint8Array>) => {
    const asked: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      asked.push(String(input));
      const file = answers[String(input)];
      return file ? new Response(file.slice()) : new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    return { fetcher, asked };
  };

  it('a listed location is never asked: a raw CID on our gateway, an Arweave id, a path inside a listed Arweave manifest', async () => {
    withheldList([`ipfs:${CID}`, arId(TX)]);
    const r = reader({ [`${GATEWAY}/ipfs/${CID}`]: ITEM, [`${T}/raw/${TX}`]: ITEM, [`${T}/${TX}/a.png`]: ITEM });
    for (const uri of [`ipfs://${CID}`, `ar://${TX}`, `ar://${TX}/a.png`]) expect(isWithheldResult(await findItemPicture(uri, ctxOf(r.fetcher))), uri).toBe(true);
    expect(r.asked).toEqual([]);
  });

  it('metadata read, its listed image never: Withheld', async () => {
    const META = rawCidV1(shaOf(new TextEncoder().encode('meta')));
    withheldList([`ipfs:${CID}`]);
    const r = reader({ [`${GATEWAY}/ipfs/${META}`]: new TextEncoder().encode(JSON.stringify({ image: `ipfs://${CID}` })), [`${GATEWAY}/ipfs/${CID}`]: ITEM });
    expect(isWithheldResult(await findItemPicture(`ipfs://${META}`, ctxOf(r.fetcher)))).toBe(true);
    expect(r.asked).toEqual([`${GATEWAY}/ipfs/${META}`]);
  });

  it('bytes read from anywhere are checked by their own id before they show (an inline picture too); a refresh turns a shown one into the tile', async () => {
    const list = withheldList([bytesId(ITEM_SHA)], [bytesId(ITEM_SHA), bytesId(AVATAR_SHA)]);
    const chain = new FakeSetChain();
    const inline = (bytes: Uint8Array) => `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
    chain.tokenUris.set('1', inline(ITEM));
    chain.tokenUris.set('2', inline(AVATAR));
    resetItemPicturesForTests(reader({}).fetcher);
    const { container } = render(<>
      <div data-row="1"><SetItemPicture reads={chain} chainId={31337} collection={COLLECTION as Address} id={1n} ipfs={[GATEWAY]} /></div>
      <div data-row="2"><SetItemPicture reads={chain} chainId={31337} collection={COLLECTION as Address} id={2n} ipfs={[GATEWAY]} /></div>
    </>);
    await waitFor(() => expect(container.querySelector('[data-row="2"] img')).not.toBeNull());
    expect(container.querySelector('[data-row="1"] [data-withheld]')?.getAttribute('aria-label')).toBe(WITHHELD_TEXT);
    expect(container.querySelector('[data-row="1"] img')).toBeNull();
    await list.refresh();
    await waitFor(() => expect(container.querySelector('[data-row="2"] [data-withheld]')).not.toBeNull());
    expect(container.querySelector('img')).toBeNull();
  });
});

/** A request that never answers until its signal aborts it, as fetch does. */
const silence = (init?: RequestInit) => new Promise<Response>((_, reject) => {
  init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
});
/** A promise and its release: a gateway's answer held while the test moves the list on. */
function hold() {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  return { held, release: () => release() };
}
/** A search answer naming `ids`, oldest first. */
const searchAnswer = (ids: readonly string[]) => Response.json({ data: { transactions: { edges: ids.map((id, height) => ({ node: { id, data: { size: '64' }, block: { height } } })) } } });
/** A search answer naming each id at its own block height. */
const searchAt = (edges: readonly (readonly [string, number])[]) => Response.json({ data: { transactions: { edges: edges.map(([id, height]) => ({ node: { id, data: { size: '64' }, block: { height } } })) } } });
/** The HTML of a subtree as React first commits it: a parent's layout effect runs once its children's DOM is in place. */
function FirstCommit({ seen, children }: { readonly seen: string[]; readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { seen.push(ref.current?.innerHTML ?? ''); }, [seen]);
  return <div ref={ref}>{children}</div>;
}
/** Every <img> element made from now on (React makes each with document.createElement before it commits it). */
function imgsMade(): string[] {
  const made: string[] = [];
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => {
    if (tag.toLowerCase() === 'img') made.push(tag);
    return create(tag, options);
  }) as typeof document.createElement);
  return made;
}
/** Holds SubtleCrypto's hash of one withheld id (its key) until `release`: the order in which the keys become known. */
function holdDigest(id: string) {
  const gate = hold();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const wanted = `sh-withheld-v1:${id}`;
  let waited = false;
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
    if (new TextDecoder().decode(data) === wanted) { waited = true; await gate.held; }
    return digest(algorithm, data);
  });
  return { release: gate.release, waited: () => waited };
}

describe('fix round af1, High 1: the list as it is now, right before every request', () => {
  it('a copy queued behind a pending read, listed by a refresh meanwhile, is never read: Withheld', async () => {
    const list = withheldList([], [arId(tx('B'))]);
    const a = hold();
    const reads: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/graphql') return searchAnswer([tx('A'), tx('B')]);
      reads.push(url.href);
      // A is a decoy (other bytes), held until the list has moved on; B would match.
      if (url.pathname === `/raw/${tx('A')}`) { await a.held; return new Response(png(9).slice()); }
      return new Response(LOGO.slice());
    }) as unknown as typeof fetch;
    const pending = findArweavePicture(LOGO_SHA, opts(fetcher, { concurrency: 1, searchGateways: [T] }));
    await waitFor(() => expect(reads).toEqual([`${T}/raw/${tx('A')}`]));
    await list.refresh();
    a.release();
    const answer = await pending;
    expect(answer).toEqual({ withheld: true, keys: [h(arId(tx('B')))] });
    expect(reads.filter((url) => url.includes(tx('B')))).toEqual([]);
  });

  it('the picture itself listed while a copy waits: the search stops at once, Withheld, nothing more read', async () => {
    const list = withheldList([], [bytesId(LOGO_SHA)]);
    const a = hold();
    const reads: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/graphql') return searchAnswer([tx('A'), tx('B'), tx('C')]);
      reads.push(url.href);
      if (url.pathname === `/raw/${tx('A')}`) { await a.held; return new Response(png(9).slice()); }
      return new Response(LOGO.slice());
    }) as unknown as typeof fetch;
    const pending = findArweavePicture(LOGO_SHA, opts(fetcher, { concurrency: 1, searchGateways: [T] }));
    await waitFor(() => expect(reads).toHaveLength(1));
    await list.refresh();
    a.release();
    expect(await pending).toEqual({ withheld: true, keys: [h(bytesId(LOGO_SHA))] });
    expect(reads).toEqual([`${T}/raw/${tx('A')}`]);
  });

  it('a copy waiting for its retry, listed by a refresh meanwhile, is not asked again', async () => {
    const list = withheldList([], [arId(tx('A'))]);
    const b = hold();
    const reads: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/graphql') return searchAnswer([tx('A'), tx('B')]);
      reads.push(url.href);
      // A never answers its first try (its time runs out on both gateways, so it waits for a retry); B is held.
      if (url.pathname === `/raw/${tx('A')}`) return silence(init);
      await b.held;
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const pending = findArweavePicture(LOGO_SHA, opts(fetcher, { concurrency: 1, searchGateways: [T], rawTimeoutMs: 30 }));
    await waitFor(() => expect(reads.some((url) => url.includes(tx('B')))).toBe(true));
    const firstTry = reads.filter((url) => url.includes(tx('A'))).length;
    expect(firstTry).toBe(2);
    await list.refresh();
    b.release();
    expect(isWithheldResult(await pending)).toBe(true);
    expect(reads.filter((url) => url.includes(tx('A')))).toHaveLength(firstTry);
  });

  it('Arweave: the next raw gateway is not asked for the indexer’s copy once a refresh lists it during the first', async () => {
    const list = withheldList([], [arId(tx('H'))]);
    const first = hold();
    const asked: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      asked.push(String(input));
      if (String(input).startsWith(T)) { await first.held; return new Response(null, { status: 404 }); }
      return new Response(LOGO.slice());
    }) as unknown as typeof fetch;
    const pending = findArweavePicture(LOGO_SHA, opts(fetcher, { hint: tx('H'), search: false }));
    await waitFor(() => expect(asked).toHaveLength(1));
    await list.refresh();
    first.release();
    expect(isWithheldResult(await pending)).toBe(true);
    expect(asked).toEqual([`${T}/raw/${tx('H')}`]);
  });

  it('our node: the next gateway is not asked once a refresh lists the picture during the first (nor its cache)', async () => {
    const list = withheldList([], [bytesId(LOGO_SHA)]);
    const first = hold();
    const asked: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      asked.push(String(input));
      if (String(input).startsWith(GATEWAY)) { await first.held; return new Response(null, { status: 404 }); }
      return new Response(LOGO.slice());
    }) as unknown as typeof fetch;
    const pending = fetchVerifiedPicture(LOGO_SHA, [GATEWAY, 'http://127.0.0.1:5422'], fetcher);
    await waitFor(() => expect(asked).toHaveLength(1));
    await list.refresh();
    first.release();
    expect(await pending).toEqual({ withheld: true, keys: [h(bytesId(LOGO_SHA))] });
    expect(asked).toEqual([`${GATEWAY}/ipfs/${rawCidV1(LOGO_SHA)}`]);
  });

  it('outside items: the next gateway is not asked for a location a refresh listed during the first', async () => {
    const cid = rawCidV1(ITEM_SHA);
    const list = withheldList([], [`ipfs:${cid}`]);
    const first = hold();
    const asked: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      asked.push(String(input));
      if (String(input).startsWith(GATEWAY)) { await first.held; return new Response(null, { status: 404 }); }
      return new Response(ITEM.slice());
    }) as unknown as typeof fetch;
    const pending = findItemPicture(`ipfs://${cid}`, { ipfs: [GATEWAY, 'http://127.0.0.1:5422'], arweave: [T, A], fetcher });
    await waitFor(() => expect(asked).toHaveLength(1));
    await list.refresh();
    first.release();
    expect(isWithheldResult(await pending)).toBe(true);
    expect(asked).toEqual([`${GATEWAY}/ipfs/${cid}`]);
  });
});

describe('fix round af1, High 2: the indexer’s copy stays the picture’s key, cached pictures included', () => {
  it('the indexer’s copy unavailable and our node supplying the bytes: listing that copy later turns the shown picture into the tile', async () => {
    const list = withheldList([], [arId(tx('H'))]);
    const g = hosts({ [rawCidV1(COVER_SHA)]: COVER });
    resetPicturesForTests(g.fetcher);
    const { container } = render(<BoxCover record={record(picturesOf(COVER_SHA, null, [GATEWAY], { copies: { cover: tx('H') } }))} />);
    await waitFor(() => expect(container.querySelector('.sh-box-cover img')).not.toBeNull());
    // The copy was asked for (none served it) before our node supplied the bytes.
    expect(g.asked).toContain(`${T}/raw/${tx('H')}`);
    expect(g.asked).toContain(`${GATEWAY}/ipfs/${rawCidV1(COVER_SHA)}`);
    await list.refresh();
    await waitFor(() => expect(container.querySelector('.sh-box-cover')?.getAttribute('data-art')).toBe('withheld'));
  });

  it('a picture kept under one copy is Withheld for a caller whose own copy is listed, and still handed to the others', async () => {
    withheldList([arId(tx('H'))]);
    const kept = await rememberArweavePicture(LOGO_SHA, LOGO, tx('K'));
    expect(kept).toMatchObject({ id: tx('K') });
    const g = hosts();
    expect(await arweavePicture(LOGO_SHA, opts(g.fetcher, { hint: tx('H'), search: false }))).toEqual({ withheld: true, keys: [h(arId(tx('H')))] });
    expect(await arweavePicture(LOGO_SHA, opts(g.fetcher, { hint: tx('K'), search: false }))).toBe(kept);
    expect(g.asked).toEqual([]);
  });

  it('another page naming a listed indexer copy for a picture already shown: the picture turns into the tile everywhere', async () => {
    withheldList([arId(tx('N'))]);
    const g = hosts({ [rawCidV1(COVER_SHA)]: COVER });
    resetPicturesForTests(g.fetcher);
    const first = render(<BoxCover record={record(picturesOf(COVER_SHA, null, [GATEWAY]))} />);
    await waitFor(() => expect(first.container.querySelector('.sh-box-cover img')).not.toBeNull());
    const commits: string[] = [];
    const second = render(<FirstCommit seen={commits}><BoxCover record={record(picturesOf(COVER_SHA, null, [GATEWAY], { copies: { cover: tx('N') } }))} /></FirstCommit>);
    // Fix round af2 (XR2 High B): not even the second box's first committed DOM holds the kept picture.
    expect(commits).toHaveLength(1);
    expect(commits[0]).not.toContain('<img');
    await waitFor(() => expect(second.container.querySelector('.sh-box-cover')?.getAttribute('data-art')).toBe('withheld'));
    await waitFor(() => expect(first.container.querySelector('.sh-box-cover')?.getAttribute('data-art')).toBe('withheld'));
    expect(g.asked.filter((url) => url.includes(tx('N')))).toEqual([]);
  });
});

describe('fix round af1, Medium: a missing picture is checked again on every change of the list', () => {
  it('a lookup that ended without a picture, listed later (inside the retry wait): withheld, and Add picture goes', async () => {
    const list = withheldList([], [bytesId(COVER_SHA)]);
    const g = hosts();
    resetPicturesForTests(g.fetcher);
    const box = record(picturesOf(COVER_SHA, null, [], { copies: null }));
    const { container } = render(<><BoxCover record={box} /><AddPictureV2 record={box} seams={{ publish: vi.fn(), reshrink: null }} /></>);
    await waitFor(() => expect(screen.getByText('Add picture')).toBeTruthy());
    const asked = g.asked.length;
    await list.refresh();
    await waitFor(() => expect(container.querySelector('.sh-box-cover')?.getAttribute('data-art')).toBe('withheld'));
    expect(screen.queryByText('Add picture')).toBeNull();
    // Withheld without a new lookup: nothing more was asked.
    expect(g.asked.length).toBe(asked);
  });
});

describe('fix round af1, High 3: a chain box’s sealed picture (SealedPicture.tsx, in HeaderSide and ContentsPanel)', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
  const url = `data:image/svg+xml;base64,${btoa(svg)}`;
  /** The id our gateway would serve these bytes under: `ipfs:` + the raw CID of their SHA-256 (JS SHA-256, not the page's). */
  const sealedId = bytesId(shaOf(new TextEncoder().encode(svg)));
  const chainRow = { network: 'local', row: DEMO_BOX0_ROW } as unknown as BoxRecord['row'];
  const sealed = (row: BoxRecord['row']) => ({ ...record(null), kind: 'new', art: null, itemNoun: 'items', row, spec: { artMode: 'hidden', teaserUrls: [], thumbs: [], sealedUrl: url } }) as unknown as BoxRecord;

  it('nothing is drawn from the bytes until the list is read; listed: the tile; a refresh turns a shown one into it', async () => {
    let answer: (response: Response) => void = () => undefined;
    let reads = 0;
    let clock = 1_000_000;
    resetWithheldForTests({ origin: API, now: () => clock, fetcher: vi.fn(() => {
      reads += 1;
      return reads === 1 ? new Promise<Response>((resolve) => { answer = resolve; }) : Promise.resolve(Response.json({ version: 1, hashes: [h(sealedId)] }));
    }) as unknown as typeof fetch });
    const { container } = render(<SealedPicture record={sealed(chainRow)} size={72} tileClassName="sh-withheld--sealed" fallback={null} />);
    await settle();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-withheld-checking]')).not.toBeNull();
    answer(Response.json({ version: 1, hashes: [] }));
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe(url));
    clock += REFRESH_MS;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(container.querySelector('[data-withheld]')).not.toBeNull());
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-withheld]')?.className).toContain('sh-withheld--sealed');
  });

  it('a local preview (no chain row: the creation page, a tab-only box) shows the creator’s own picture, with no list read', async () => {
    const reads = vi.fn(async () => Response.json({ version: 1, hashes: [h(sealedId)] }));
    resetWithheldForTests({ origin: API, fetcher: reads as unknown as typeof fetch });
    const { container } = render(<SealedPicture record={sealed(null)} size={72} tileClassName="sh-withheld--sealed" fallback={null} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(url);
    await settle();
    expect(reads).not.toHaveBeenCalled();
  });

  it('both places use it on a chain box: the header’s sealed peek and the contents’ sealed counts show the tile', async () => {
    const spec = buildSpec(inputOf({ form: formOf({ artMode: 'hidden' }) }));
    const base = recordFromSpec(spec, specHash(spec), { chainId: 11_155_111, networkLabel: 'Sepolia testnet', token: '0x00000000000000000000000000000000000000aa', demo: false, order: 1, coverUrl: null, thumbs: [], createdAtMs: null, nowMs: 0 });
    expect(base.spec?.sealedUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    // The spec's own hidden picture, listed by its bytes' id.
    const own = bytesId(shaOf(Uint8Array.from(atob((base.spec?.sealedUrl ?? '').split(',')[1] ?? ''), (char) => char.charCodeAt(0))));
    withheldList([own]);
    const chain = { ...base, row: chainRow } as BoxRecord;
    const strip = render(<PeekStrip record={chain} state="upcoming" size={10n} launchContent={false} onOpen={() => undefined} />);
    await waitFor(() => expect(strip.container.querySelector('.sh-box-peekstrip [data-withheld]')).not.toBeNull());
    expect(strip.container.querySelector('.sh-box-peekstrip img')).toBeNull();
    strip.unmount();
    const contents = render(<ContentsPanel record={chain} state="upcoming" counts={{ inside: 10n, reserved: 0n }} launchContent={false} edition={{ size: 10n, check: 'record', recordSize: 10n }} />);
    await waitFor(() => expect(contents.container.querySelector('.sh-box-sealed [data-withheld]')).not.toBeNull());
    expect(contents.container.querySelector('.sh-box-sealed img')).toBeNull();
  });
});

describe('fix round af2, High A: a match goes with every older copy named, whatever became of it (oldest first, as the share cards)', () => {
  it('the older copy waits for its retry, a refresh lists it, then the newer copy matches: Withheld, the older one not asked again', async () => {
    const list = withheldList([], [arId(tx('A'))]);
    const b = hold();
    const reads: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/graphql') return searchAnswer([tx('A'), tx('B')]);
      reads.push(url.href);
      // A never answers its first try (its time runs out on both gateways: it waits for its retry); B, newer, matches.
      if (url.pathname === `/raw/${tx('A')}`) return silence(init);
      await b.held;
      return new Response(LOGO.slice());
    }) as unknown as typeof fetch;
    const pending = findArweavePicture(LOGO_SHA, opts(fetcher, { concurrency: 1, searchGateways: [T], rawTimeoutMs: 30 }));
    await waitFor(() => expect(reads.some((url) => url.includes(tx('B')))).toBe(true));
    const firstTry = reads.filter((url) => url.includes(tx('A'))).length;
    expect(firstTry).toBe(2);
    await list.refresh();
    b.release();
    const answer = await pending;
    expect(answer).toMatchObject({ withheld: true });
    expect((answer as Withheld).keys).toContain(h(arId(tx('A'))));
    expect(reads.filter((url) => url.includes(tx('A')))).toHaveLength(firstTry);
  });

  it('the older copy already read to its end (other bytes) before a refresh lists it, then the newer copy matches: Withheld', async () => {
    const list = withheldList([], [arId(tx('A'))]);
    const b = hold();
    const reads: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/graphql') return searchAnswer([tx('A'), tx('B')]);
      reads.push(url.href);
      if (url.pathname === `/raw/${tx('A')}`) return new Response(png(9).slice());
      await b.held;
      return new Response(LOGO.slice());
    }) as unknown as typeof fetch;
    const pending = findArweavePicture(LOGO_SHA, opts(fetcher, { concurrency: 1, searchGateways: [T] }));
    await waitFor(() => expect(reads.some((url) => url.includes(tx('B')))).toBe(true));
    // A was served (other bytes): settled, never asked again.
    expect(reads.filter((url) => url.includes(tx('A')))).toEqual([`${T}/raw/${tx('A')}`]);
    await list.refresh();
    b.release();
    const answer = await pending;
    expect(answer).toMatchObject({ withheld: true });
    expect((answer as Withheld).keys).toContain(h(arId(tx('A'))));
  });

  it('no refresh: an older listed copy one answer named, its key still being hashed, while another answer’s newer copy matches first: Withheld', async () => {
    withheldList([arId(tx('A'))]);
    const digest = holdDigest(arId(tx('A')));
    const reads: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      // turbo-gateway names A (block 1), arweave.net names B (block 2); both copies hold the picture.
      if (url.pathname === '/graphql') return url.origin === T ? searchAt([[tx('A'), 1]]) : searchAt([[tx('B'), 2]]);
      reads.push(url.href);
      return new Response(LOGO.slice());
    }) as unknown as typeof fetch;
    const pending = findArweavePicture(LOGO_SHA, opts(fetcher, { searchGateways: [T, A] }));
    let answered = false;
    void pending.then(() => { answered = true; });
    await waitFor(() => expect(reads).toContain(`${T}/raw/${tx('B')}`));
    await settle();
    // B was read and matched while A's key was still being hashed: the match waits for the list's verdict on A.
    expect(digest.waited()).toBe(true);
    expect(answered).toBe(false);
    digest.release();
    const answer = await pending;
    expect(answer).toMatchObject({ withheld: true });
    expect((answer as Withheld).keys).toContain(h(arId(tx('A'))));
    expect(reads.filter((url) => url.includes(tx('A')))).toEqual([]);
  });

  it('a picture found through a newer copy keeps the older copies as its keys: listing one later withholds it, kept and shown', async () => {
    const list = withheldList([], [arId(tx('A'))]);
    const g = hosts({}, { [tx('A')]: png(9), [tx('B')]: COVER }, { [COVER_SHA.slice(2)]: [tx('A'), tx('B')] });
    resetPicturesForTests(g.fetcher);
    const { container } = render(<BoxCover record={record(picturesOf(COVER_SHA, null, [], { copies: null }))} />);
    await waitFor(() => expect(container.querySelector('.sh-box-cover img')).not.toBeNull());
    expect(knownArweavePicture(COVER_SHA)).toMatchObject({ id: tx('B'), older: [tx('A')] });
    const asked = g.asked.length;
    await list.refresh();
    await waitFor(() => expect(container.querySelector('.sh-box-cover')?.getAttribute('data-art')).toBe('withheld'));
    expect(knownArweavePicture(COVER_SHA)).toBeNull();
    expect(g.asked.length).toBe(asked);
  });

  it('a newer copy (a decoy) listed later changes nothing: the picture found through the older copy stays, kept and shown', async () => {
    const list = withheldList([], [arId(tx('D'))]);
    const g = hosts({}, { [tx('R')]: COVER, [tx('D')]: png(9) }, { [COVER_SHA.slice(2)]: [tx('R'), tx('D')] });
    resetPicturesForTests(g.fetcher);
    const { container } = render(<BoxCover record={record(picturesOf(COVER_SHA, null, [], { copies: null }))} />);
    await waitFor(() => expect(container.querySelector('.sh-box-cover img')).not.toBeNull());
    expect(knownArweavePicture(COVER_SHA)).toMatchObject({ id: tx('R'), older: [] });
    await list.refresh();
    await settle();
    expect(container.querySelector('.sh-box-cover img')).not.toBeNull();
    expect(knownArweavePicture(COVER_SHA)).toMatchObject({ id: tx('R') });
  });
});

describe('fix round af2, High B: the copy a caller names is checked before a picture kept for the page is handed to it', () => {
  it('kept without a hint, then a box naming a listed hint: no <img> in its first committed DOM nor made later; the tiles, cover and mark', async () => {
    withheldList([arId(tx('M')), arId(tx('N'))]);
    const g = hosts({ [rawCidV1(LOGO_SHA)]: LOGO, [rawCidV1(COVER_SHA)]: COVER });
    resetPicturesForTests(g.fetcher);
    const plain = record(picturesOf(LOGO_SHA, COVER_SHA, [GATEWAY]));
    const first = render(<><BoxCover record={plain} /><TokenMark record={plain} /></>);
    await waitFor(() => expect(first.container.querySelectorAll('img')).toHaveLength(2));
    const made = imgsMade();
    const commits: string[] = [];
    const named = record(picturesOf(LOGO_SHA, COVER_SHA, [GATEWAY], { copies: { logo: tx('M'), cover: tx('N') } }));
    const second = render(<FirstCommit seen={commits}><BoxCover record={named} /><TokenMark record={named} /></FirstCommit>);
    expect(commits).toHaveLength(1);
    expect(commits[0]).not.toContain('<img');
    await waitFor(() => expect(second.container.querySelector('.sh-box-cover')?.getAttribute('data-art')).toBe('withheld'));
    await waitFor(() => expect(second.container.querySelector('[data-withheld].sh-withheld--mark')).not.toBeNull());
    // The page's answers adopt the copies (af1): the first box turns into the tiles too, and no <img> was ever made.
    await waitFor(() => expect(first.container.querySelectorAll('img')).toHaveLength(0));
    expect(made).toEqual([]);
    expect(g.asked.filter((url) => url.includes(tx('M')) || url.includes(tx('N')))).toEqual([]);
  });

  it('a box naming an unlisted hint for a kept picture: shown once that copy is checked, nothing asked again; an empty list: in the first commit', async () => {
    const list = withheldList([arId(tx('Z'))], []);
    const g = hosts({ [rawCidV1(COVER_SHA)]: COVER });
    resetPicturesForTests(g.fetcher);
    const first = render(<BoxCover record={record(picturesOf(COVER_SHA, null, [GATEWAY]))} />);
    await waitFor(() => expect(first.container.querySelector('.sh-box-cover img')).not.toBeNull());
    const asked = g.asked.length;
    const commits: string[] = [];
    const second = render(<FirstCommit seen={commits}><BoxCover record={record(picturesOf(COVER_SHA, null, [GATEWAY], { copies: { cover: tx('N') } }))} /></FirstCommit>);
    expect(commits[0]).not.toContain('<img');
    await waitFor(() => expect(second.container.querySelector('.sh-box-cover img')).not.toBeNull());
    expect(g.asked.length).toBe(asked);
    // With an empty list there is nothing to check: the kept picture is in the very first commit.
    await list.refresh();
    const empty: string[] = [];
    render(<FirstCommit seen={empty}><BoxCover record={record(picturesOf(COVER_SHA, null, [GATEWAY], { copies: { cover: tx('P') } }))} /></FirstCommit>);
    expect(empty[0]).toContain('<img');
  });
});
