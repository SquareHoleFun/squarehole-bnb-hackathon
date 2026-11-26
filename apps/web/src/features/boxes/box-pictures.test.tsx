/**
 * SH-V2-FE11 (SH-V2-LOCAL-ART request 1): a chain box's committed pictures. The spec's hashes pick the raw CID; the bytes
 * show only when they are one raw block at most and hash to the commitment, as a raster picture; a mismatch, an
 * oversized or unknown answer shows the placeholder, never the gateway's bytes. Logo and box picture stay two roles.
 */
import { blankPng } from '../../../../../packages/cards/src/test-support';
import { PICTURE_CASES } from '../../../../../packages/artwork/src/picture-fixtures';
import { MAX_RAW_BLOCK_BYTES, rawCidV1, sha256Hex } from '@squarehole/artwork';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoxRecord } from './box-model';
import { BoxCover, TokenMark } from './BoxParts';
import { SEPOLIA_ART_GATEWAY } from '../../../deployments-plugin';
import { endsWhole, fetchVerifiedPicture, GATEWAY_TIMEOUT_MS, lookupOf, pictureType, picturesOf, resetPicturesForTests, showPublishedPicture, usePictureState, type PictureState } from './box-pictures';
import { MISFITS_COLLECTION_COVER_SHA256 } from './bundled-pictures';

afterEach(() => { cleanup(); resetPicturesForTests(); });

const GATEWAY = 'http://127.0.0.1:5421';
const png = (seed: number, size?: number) => {
  const picture = blankPng(seed + 2, seed + 2);
  if (size === undefined) return picture;
  const bytes = new Uint8Array(size); bytes.set(picture); return bytes;
};
const LOGO = png(1); const COVER = png(2);
const LOGO_SHA = sha256Hex(LOGO); const COVER_SHA = sha256Hex(COVER);

/** A gateway double: the files it serves by path, and every URL it was asked. */
function gateway(files: Record<string, Uint8Array | Response>) {
  const asked: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); asked.push(url);
    const file = files[new URL(url).pathname];
    if (file instanceof Response) return file;
    return file ? new Response(file.slice(), { status: 200, headers: { 'content-type': 'image/png' } }) : new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  return { fetcher, asked };
}
const path = (sha: `0x${string}`) => `/ipfs/${rawCidV1(sha)}`;

describe('the committed pictures of a spec', () => {
  it('logo from field 23, box picture from field 28, the logo standing in when the collection has no cover; zero is none', () => {
    expect(picturesOf(LOGO_SHA, COVER_SHA, [GATEWAY])).toEqual({ logo: LOGO_SHA, cover: COVER_SHA, gateways: [GATEWAY] });
    expect(picturesOf(LOGO_SHA, `0x${'0'.repeat(64)}`)).toEqual({ logo: LOGO_SHA, cover: LOGO_SHA, gateways: [] });
    expect(picturesOf(`0x${'0'.repeat(64)}`, `0x${'0'.repeat(64)}`)).toBeNull();
    expect(picturesOf('0x1234', undefined)).toBeNull();
    expect(picturesOf(LOGO_SHA.toUpperCase().replace('0X', '0x'), null)?.logo).toBe(LOGO_SHA);
  });

  it('tells a raster picture by its first bytes, never by a header', () => {
    expect(pictureType(LOGO)).toBe('image/png');
    expect(pictureType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(pictureType(new TextEncoder().encode('GIF89a'))).toBe('image/gif');
    expect(pictureType(new TextEncoder().encode('RIFF0000WEBPVP8 '))).toBe('image/webp');
    expect(pictureType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(pictureType(new TextEncoder().encode('<html>'))).toBeNull();
  });
});

describe('fetching a committed picture', () => {
  it('asks the raw CID path and returns the bytes only when their SHA-256 matches', async () => {
    const g = gateway({ [path(LOGO_SHA)]: LOGO });
    const picture = await fetchVerifiedPicture(LOGO_SHA, [GATEWAY], g.fetcher);
    expect(picture).toEqual({ bytes: LOGO, type: 'image/png' });
    expect(g.asked).toEqual([`${GATEWAY}/ipfs/${rawCidV1(LOGO_SHA)}`]);
    const init = vi.mocked(g.fetcher).mock.calls[0]?.[1];
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
  });

  it('a gateway answering other bytes, too many bytes or no picture is never shown; the next gateway may answer', async () => {
    const big = png(3, MAX_RAW_BLOCK_BYTES + 1);
    const unknown = new TextEncoder().encode('<svg/>');
    for (const answer of [COVER, big, unknown, new Response(LOGO.slice(), { status: 500 })]) {
      expect(await fetchVerifiedPicture(LOGO_SHA, [GATEWAY], gateway({ [path(LOGO_SHA)]: answer }).fetcher)).toBeNull();
    }
    // A declared size above one raw block is refused before the body is read.
    const declared = new Response(LOGO.slice(), { headers: { 'content-length': String(MAX_RAW_BLOCK_BYTES + 1) } });
    expect(await fetchVerifiedPicture(LOGO_SHA, [GATEWAY], gateway({ [path(LOGO_SHA)]: declared }).fetcher)).toBeNull();
    // The bytes hash to something else at the first gateway: the second, which verifies, is used.
    const first = gateway({ [path(LOGO_SHA)]: COVER }); const second = gateway({ [path(LOGO_SHA)]: LOGO });
    const both = (async (input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith(GATEWAY) ? first.fetcher(input, init) : second.fetcher(input, init))) as typeof fetch;
    expect(await fetchVerifiedPicture(LOGO_SHA, [GATEWAY, 'http://127.0.0.1:5422'], both)).toEqual({ bytes: LOGO, type: 'image/png' });
    // A gateway that throws (offline, refused redirect) counts as no answer.
    expect(await fetchVerifiedPicture(LOGO_SHA, [GATEWAY], (async () => { throw new TypeError('redirect'); }) as unknown as typeof fetch)).toBeNull();
    expect(await fetchVerifiedPicture(`0x${'0'.repeat(64)}`, [GATEWAY], first.fetcher)).toBeNull();
  });

  it('SH-BOX-PICTURE-FIT af1: a gateway that stalls, before its answer or in its body, is given up after its time; the next one answers', async () => {
    // Each request carries its own time (GATEWAY_TIMEOUT_MS by default), a signal that ends it.
    const g = gateway({ [path(LOGO_SHA)]: LOGO });
    await fetchVerifiedPicture(LOGO_SHA, [GATEWAY], g.fetcher);
    const signal = vi.mocked(g.fetcher).mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    expect(GATEWAY_TIMEOUT_MS).toBe(8_000);
    const SECOND = 'http://127.0.0.1:5422';
    const asked: string[] = [];
    const stalls = (where: 'head' | 'body') => (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push(url);
      if (url.startsWith(SECOND)) return new Response(LOGO.slice(), { status: 200 });
      const stop = init?.signal;
      if (where === 'head') {
        // No answer at all until the request's own signal ends it.
        return new Promise<Response>((_, reject) => stop?.addEventListener('abort', () => reject(stop.reason), { once: true }));
      }
      // The head arrives, then the body stops after its first bytes until the signal ends it.
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(LOGO.slice(0, 8));
          stop?.addEventListener('abort', () => controller.error(stop.reason), { once: true });
        },
      }), { status: 200 });
    }) as typeof fetch;
    for (const where of ['head', 'body'] as const) {
      asked.length = 0;
      const started = Date.now();
      expect(await fetchVerifiedPicture(LOGO_SHA, [GATEWAY, SECOND], stalls(where), [], 40)).toEqual({ bytes: LOGO, type: 'image/png' });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(asked).toEqual([`${GATEWAY}/ipfs/${rawCidV1(LOGO_SHA)}`, `${SECOND}/ipfs/${rawCidV1(LOGO_SHA)}`]);
    }
    // Only a stalled gateway: the lookup ends with nothing (the slot's other picture or its placeholder), never hangs.
    expect(await fetchVerifiedPicture(LOGO_SHA, [GATEWAY], stalls('head'), [], 40)).toBeNull();
  });
});

describe('the box picture and the logo on a page', () => {
  const record = (pictures: BoxRecord['pictures']) => ({ market: null, rehearsal: false, art: null, spec: null, ticker: 'T', pictures }) as unknown as BoxRecord;

  it('show the placeholder until the bytes verify, then each its own role: the cover as the box picture, the logo as the mark', async () => {
    const g = gateway({ [path(LOGO_SHA)]: LOGO, [path(COVER_SHA)]: COVER });
    resetPicturesForTests(g.fetcher);
    const box = record(picturesOf(LOGO_SHA, COVER_SHA, [GATEWAY]));
    const { container } = render(<><BoxCover record={box} /><TokenMark record={box} /></>);
    expect(container.querySelector('.sh-box-cover')?.getAttribute('data-art')).toBe('plain');
    await waitFor(() => expect(container.querySelector('.sh-box-cover')?.getAttribute('data-art')).toBe('image'));
    await waitFor(() => expect(container.querySelector('img.sh-box-coin--logo')).not.toBeNull());
    const cover = container.querySelector<HTMLImageElement>('.sh-box-cover img')?.src;
    const logo = container.querySelector<HTMLImageElement>('img.sh-box-coin--logo')?.src;
    expect(cover).toBeTruthy(); expect(logo).toBeTruthy();
    expect(cover).not.toBe(logo);
    expect(g.asked.sort()).toEqual([`${GATEWAY}${path(COVER_SHA)}`, `${GATEWAY}${path(LOGO_SHA)}`].sort());
  });

  it('a gateway that answers the wrong bytes leaves the placeholder for good (and the lettered coin)', async () => {
    const g = gateway({ [path(LOGO_SHA)]: COVER, [path(COVER_SHA)]: LOGO });
    resetPicturesForTests(g.fetcher);
    const box = record(picturesOf(LOGO_SHA, COVER_SHA, [GATEWAY]));
    const { container } = render(<><BoxCover record={box} /><TokenMark record={box} /></>);
    await waitFor(() => expect(g.asked).toHaveLength(2));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.querySelector('.sh-box-cover')?.getAttribute('data-art')).toBe('plain');
    expect(container.querySelector('.sh-box-cover img')).toBeNull();
    expect(container.querySelector('img.sh-box-coin--logo')).toBeNull();
    expect(container.querySelector('.sh-box-coin')?.getAttribute('data-letter')).toBe('T');
  });

  it('without gateways nothing is fetched and the placeholder shows; one picture is fetched once for every place it shows', async () => {
    const g = gateway({ [path(LOGO_SHA)]: LOGO });
    resetPicturesForTests(g.fetcher);
    render(<BoxCover record={record(picturesOf(LOGO_SHA, null, []))} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(g.asked).toEqual([]);
    cleanup();
    const box = record(picturesOf(LOGO_SHA, null, [GATEWAY]));
    const { container } = render(<><BoxCover record={box} /><BoxCover record={box} small /><TokenMark record={box} /></>);
    await waitFor(() => expect(container.querySelectorAll('.sh-box-cover[data-art="image"]')).toHaveLength(2));
    expect(g.asked).toEqual([`${GATEWAY}${path(LOGO_SHA)}`]);
  });
});

/**
 * SH-ARWEAVE-PICTURES-WEB: a v2 box whose source keeps its pictures on Arweave: this page's own copy or the indexer's
 * first, then the source's gateways, then the tag search on the three Arweave gateways; shown only once the bytes hash to
 * the commitment. Box 0's bundled hashes never ask Arweave. A lookup that ended without a picture says so (Add picture).
 */
describe('a v2 box’s pictures on Arweave', () => {
  const record = (pictures: BoxRecord['pictures']) => ({ market: null, rehearsal: false, art: null, spec: null, ticker: 'T', pictures }) as unknown as BoxRecord;
  const ID_LOGO = `L${'a'.repeat(42)}`; const ID_COVER = `C${'b'.repeat(42)}`; const ID_DECOY = `D${'c'.repeat(42)}`; const ID_HINT = `H${'d'.repeat(42)}`;
  const SEARCH = ['https://turbo-gateway.com', 'https://arweave.net', 'https://goldsky.arweave.net'];
  /** The three Arweave gateways and our node: `files` by Arweave id, `ids` (search answers) by hash, `ipfs` by path. */
  function hosts(files: Record<string, Uint8Array>, ids: Record<string, readonly string[]>, ipfs: Record<string, Uint8Array> = {}) {
    const asked: string[] = [];
    /** The hash each search asked about (its `sha` variable). */
    const searched: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)); asked.push(url.href);
      if (url.origin === GATEWAY) { const file = ipfs[url.pathname]; return file ? new Response(file.slice()) : new Response(null, { status: 404 }); }
      if (!SEARCH.includes(url.origin)) throw new TypeError('unexpected host');
      if (url.pathname === '/graphql') {
        const sha = (JSON.parse(String(init?.body)) as { variables: { sha: string[] } }).variables.sha[0] ?? '';
        searched.push(sha);
        return Response.json({ data: { transactions: { edges: (ids[sha] ?? []).map((id, height) => ({ node: { id, data: { size: '64' }, block: { height } } })) } } });
      }
      const file = files[url.pathname.replace('/raw/', '')];
      return file ? new Response(file.slice()) : new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    return { fetcher, asked, searched };
  }

  it('the indexer’s copies: hints by hash; where the cover is the logo, either copy; bad ids dropped', () => {
    expect(picturesOf(LOGO_SHA, COVER_SHA, [], { copies: { logo: ID_LOGO, cover: ID_COVER } })?.arweave).toEqual({ copies: { [LOGO_SHA]: ID_LOGO, [COVER_SHA]: ID_COVER } });
    expect(picturesOf(LOGO_SHA, null, [], { copies: { cover: ID_COVER } })?.arweave).toEqual({ copies: { [LOGO_SHA]: ID_COVER } });
    expect(picturesOf(LOGO_SHA, COVER_SHA, [], { copies: { logo: 'nope', cover: ID_COVER } })?.arweave).toEqual({ copies: { [COVER_SHA]: ID_COVER } });
    expect(picturesOf(LOGO_SHA, COVER_SHA, [], { copies: null })?.arweave).toEqual({ copies: {} });
    expect(lookupOf(picturesOf(LOGO_SHA, COVER_SHA, [GATEWAY], { copies: { cover: ID_COVER } }), 'cover')).toEqual({ sha256: COVER_SHA, gateways: [GATEWAY], arweave: { hint: ID_COVER } });
    expect(lookupOf(picturesOf(LOGO_SHA, COVER_SHA, [GATEWAY]), 'logo')).toEqual({ sha256: LOGO_SHA, gateways: [GATEWAY], arweave: null });
  });

  it('the indexer’s copy first: shown without asking our node or searching', async () => {
    const g = hosts({ [ID_HINT]: COVER }, {});
    resetPicturesForTests(g.fetcher);
    const { container } = render(<BoxCover record={record(picturesOf(LOGO_SHA, COVER_SHA, [GATEWAY], { copies: { cover: ID_HINT } }))} />);
    await waitFor(() => expect(container.querySelector('.sh-box-cover')?.getAttribute('data-art')).toBe('image'));
    // SH-BOX-PICTURE-FIT af1: the card asks for its other picture (the logo) at the same time; nothing for the cover
    // but its indexer copy: our node was not asked for it, and no search named it.
    const forLogo = (url: string) => url.endsWith(path(LOGO_SHA)) || url.endsWith('/graphql');
    expect(g.asked.filter((url) => !forLogo(url))).toEqual([`https://turbo-gateway.com/raw/${ID_HINT}`]);
    expect(g.searched.every((sha) => LOGO_SHA.toLowerCase().endsWith(sha.toLowerCase().replace(/^0x/, '')))).toBe(true);
  });

  it('no copy named: our node first, then the search on all three gateways; a decoy with the right tag is skipped', async () => {
    const g = hosts({ [ID_LOGO]: LOGO, [ID_COVER]: COVER, [ID_DECOY]: png(9) }, { [LOGO_SHA.slice(2)]: [ID_DECOY, ID_LOGO], [COVER_SHA.slice(2)]: [ID_COVER] });
    resetPicturesForTests(g.fetcher);
    const box = record(picturesOf(LOGO_SHA, COVER_SHA, [GATEWAY], { copies: null }));
    const { container } = render(<><BoxCover record={box} /><TokenMark record={box} /></>);
    await waitFor(() => expect(container.querySelector('.sh-box-cover')?.getAttribute('data-art')).toBe('image'));
    await waitFor(() => expect(container.querySelector('img.sh-box-coin--logo')).not.toBeNull());
    expect(g.asked.indexOf(`${GATEWAY}${path(LOGO_SHA)}`)).toBeLessThan(g.asked.indexOf('https://turbo-gateway.com/graphql'));
    for (const origin of SEARCH) expect(g.asked).toContain(`${origin}/graphql`);
    expect(g.asked).toContain(`https://turbo-gateway.com/raw/${ID_DECOY}`);
    expect(g.asked).toContain(`https://turbo-gateway.com/raw/${ID_LOGO}`);
  });

  it('only decoys: the placeholder, and the lookup says the picture is missing (Add picture shows)', async () => {
    const g = hosts({ [ID_DECOY]: png(9) }, { [LOGO_SHA.slice(2)]: [ID_DECOY] });
    resetPicturesForTests(g.fetcher);
    const states: PictureState[] = [];
    function Probe() { states.push(usePictureState(LOGO_SHA, [], { hint: null })); return null; }
    const { container } = render(<><BoxCover record={record(picturesOf(LOGO_SHA, null, [], { copies: null }))} /><Probe /></>);
    await waitFor(() => expect(states.at(-1)).toEqual({ url: null, missing: true, withheld: false }));
    expect(states[0]).toEqual({ url: null, missing: false, withheld: false });
    expect(container.querySelector('.sh-box-cover')?.getAttribute('data-art')).toBe('plain');
    // Published from this page (Create, or Add picture): shown at once, with no new lookup.
    const asked = g.asked.length;
    expect(await act(async () => showPublishedPicture(LOGO_SHA, png(9), ID_DECOY))).toBe(false);
    expect(await act(async () => showPublishedPicture(LOGO_SHA, LOGO, ID_LOGO))).toBe(true);
    await waitFor(() => expect(container.querySelector('.sh-box-cover')?.getAttribute('data-art')).toBe('image'));
    expect(states.at(-1)).toMatchObject({ missing: false, url: expect.any(String) });
    expect(g.asked.length).toBe(asked);
  });

  it('Arweave off (every v1 box, every build without it): never asked; box 0’s bundled hashes never ask it either', async () => {
    const g = hosts({}, {});
    resetPicturesForTests(g.fetcher);
    render(<BoxCover record={record(picturesOf(LOGO_SHA, null, [GATEWAY]))} />);
    await waitFor(() => expect(g.asked).toHaveLength(1));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(g.asked).toEqual([`${GATEWAY}${path(LOGO_SHA)}`]);
    cleanup(); resetPicturesForTests(g.fetcher); g.asked.length = 0;
    render(<BoxCover record={record(picturesOf(MISFITS_COLLECTION_COVER_SHA256, null, [GATEWAY], { copies: { logo: ID_HINT } }))} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(g.asked.filter((url) => !url.startsWith(GATEWAY))).toEqual([]);
  });
});

/**
 * SH-TA-26: the Sepolia test site's gateway is our own node, https://api.squarehole.fun/ipfs/<cid> (SH-TA-25). The
 * same checks hold there: the canonical raw CID of the spec's hash, the exact SHA-256 before anything shows, and the
 * placeholder (never the bytes) on a mismatch.
 */
describe('the Sepolia test site’s pictures (our own node)', () => {
  const record = (pictures: BoxRecord['pictures']) => ({ market: null, rehearsal: false, art: null, spec: null, ticker: 'T', pictures }) as unknown as BoxRecord;
  const url = (sha: `0x${string}`) => `${SEPOLIA_ART_GATEWAY}/ipfs/${rawCidV1(sha)}`;

  it('asks https://api.squarehole.fun/ipfs/<raw CIDv1> and shows the bytes once they hash to the commitment', async () => {
    const g = gateway({ [path(LOGO_SHA)]: LOGO, [path(COVER_SHA)]: COVER });
    expect(rawCidV1(LOGO_SHA)).toMatch(/^bafkrei[a-h][a-z2-7]{50}[aeimquy4]$/);
    expect(await fetchVerifiedPicture(LOGO_SHA, [SEPOLIA_ART_GATEWAY], g.fetcher)).toEqual({ bytes: LOGO, type: 'image/png' });
    expect(g.asked).toEqual([url(LOGO_SHA)]);
    resetPicturesForTests(g.fetcher);
    const box = record(picturesOf(LOGO_SHA, COVER_SHA, [SEPOLIA_ART_GATEWAY]));
    const { container } = render(<><BoxCover record={box} /><TokenMark record={box} /></>);
    await waitFor(() => expect(container.querySelector('.sh-box-cover')?.getAttribute('data-art')).toBe('image'));
    await waitFor(() => expect(container.querySelector('img.sh-box-coin--logo')).not.toBeNull());
    expect(g.asked.slice(1).sort()).toEqual([url(COVER_SHA), url(LOGO_SHA)].sort());
  });

  it('bytes that do not hash to the commitment, a truncated answer or an error leave the placeholder and never draw', async () => {
    const truncated = LOGO.slice(0, 40);
    const flipped = LOGO.slice(); flipped[20] = (flipped[20] ?? 0) ^ 1;
    for (const answer of [COVER, truncated, flipped, new Response(LOGO.slice(), { status: 404 })]) {
      expect(await fetchVerifiedPicture(LOGO_SHA, [SEPOLIA_ART_GATEWAY], gateway({ [path(LOGO_SHA)]: answer }).fetcher)).toBeNull();
    }
    const g = gateway({ [path(LOGO_SHA)]: flipped, [path(COVER_SHA)]: truncated });
    resetPicturesForTests(g.fetcher);
    const box = record(picturesOf(LOGO_SHA, COVER_SHA, [SEPOLIA_ART_GATEWAY]));
    const { container } = render(<><BoxCover record={box} /><TokenMark record={box} /></>);
    await waitFor(() => expect(g.asked).toHaveLength(2));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.querySelector('.sh-box-cover')?.getAttribute('data-art')).toBe('plain');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.sh-box-coin')?.getAttribute('data-letter')).toBe('T');
  });
});

describe('SH-BOX-PICTURE-FIT fix round af2 (review M1): a verified picture that does not decode', () => {
  /** A decoder double that refuses the data URL of `bytes` (a test DOM makes data URLs from verified bytes). */
  const refusing = (bytes: Uint8Array) => {
    const refused = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
    const asked: string[] = [];
    return { asked, decode: async (url: string) => { asked.push(url); return url !== refused; } };
  };

  it('is missing, like no answer: no URL, the lookup ended (hash, type and size gates passed first)', async () => {
    const g = gateway({ [path(LOGO_SHA)]: LOGO });
    const d = refusing(LOGO);
    resetPicturesForTests(g.fetcher, d.decode);
    const states: PictureState[] = [];
    function Probe() { states.push(usePictureState(LOGO_SHA, [GATEWAY])); return null; }
    render(<Probe />);
    await waitFor(() => expect(states.at(-1)).toEqual({ url: null, missing: true, withheld: false }));
    expect(d.asked).toHaveLength(1);
    expect(states.some((state) => state.url !== null)).toBe(false);
  });

  it('a decodable one shows as before, and the decoder is asked once per hash', async () => {
    const g = gateway({ [path(LOGO_SHA)]: LOGO });
    const d = refusing(COVER);
    resetPicturesForTests(g.fetcher, d.decode);
    const states: PictureState[] = [];
    function Probe() { states.push(usePictureState(LOGO_SHA, [GATEWAY])); return null; }
    render(<><Probe /><Probe /></>);
    await waitFor(() => expect(states.at(-1)).toMatchObject({ url: expect.stringMatching(/^data:image\/png;base64,/), missing: false }));
    expect(d.asked).toHaveLength(1);
  });

  it('a picture published from this page that does not decode is not shown (showPublishedPicture false)', async () => {
    const g = gateway({});
    const d = refusing(LOGO);
    resetPicturesForTests(g.fetcher, d.decode);
    expect(await act(async () => showPublishedPicture(LOGO_SHA, LOGO, 'a'.repeat(43)))).toBe(false);
    expect(d.asked).toHaveLength(1);
  });
});

describe('SH-BOX-PICTURE-FIT fix round af2 (review M1): a picture cut short', () => {
  const real = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../e2e/fixtures/picture-edges/square-logo.png'));

  it('a whole PNG ends with its IEND chunk; one cut after its header does not (a browser would draw it in part, without an error)', () => {
    expect(endsWhole(real, 'image/png')).toBe(true);
    expect(endsWhole(real.subarray(0, Math.floor(real.length / 2)), 'image/png')).toBe(false);
    expect(endsWhole(real.subarray(0, 40), 'image/png')).toBe(false);
    // The format end is the file end; no trailing padding.
    expect(endsWhole(new Uint8Array([...real, 0, 0, 0, 0]), 'image/png')).toBe(false);
  });

  it.each(PICTURE_CASES.filter((f) => /ordinary|false-tail/.test(f.name)))('$name is parsed to its real end', ({ bytes, complete }) => {
    const type = pictureType(bytes);
    expect(type).not.toBeNull();
    expect(endsWhole(bytes, type ?? '')).toBe(complete);
  });
});
