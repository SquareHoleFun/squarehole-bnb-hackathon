/**
 * SH-EXISTING-NFTS-E08C: outside metadata is hostile by default. A picture is read only from ipfs:// (our gateways),
 * ar:// (the Arweave gateways) or an inline data: URI within its cap, and only raster bytes are drawn. Missing,
 * reverting, huge, changing, javascript: and SVG-with-script metadata give the id alone: never an exception, never a
 * fetch of another host, never unsafe markup.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringToHex, type Address } from 'viem';
import { ARWEAVE_RAW_GATEWAYS } from '../pictures/arweave-hosts';
import { MAX_DATA_PICTURE_BYTES, MAX_METADATA_BYTES, MAX_TOKEN_URI_CHARS, loadItemPicture, locate, pictureOfUri, type PictureContext } from './set-pictures';
import { COLLECTION, FakeSetChain } from './test-support/set-chain';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const TX = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const GATEWAY = 'http://127.0.0.1:8596';
const b64 = (bytes: Uint8Array | string) => {
  if (typeof bytes === 'string') return btoa(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function context(answers: Record<string, Uint8Array | { readonly body: Uint8Array; readonly length?: string } | 'redirect'>) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    const answer = answers[url];
    if (answer === undefined) return new Response('not here', { status: 404 });
    if (answer === 'redirect') throw new TypeError('redirect refused');
    // TextEncoder's bytes come from another realm than this file's Uint8Array: a view either way.
    const plain = ArrayBuffer.isView(answer);
    const body = plain ? answer as Uint8Array : (answer as { body: Uint8Array }).body;
    const length = plain ? undefined : (answer as { length?: string }).length;
    const headers: Record<string, string> = length ? { 'content-length': length } : {};
    return new Response(body as unknown as BodyInit, { status: 200, headers });
  });
  const ctx: PictureContext = { ipfs: [GATEWAY], arweave: ARWEAVE_RAW_GATEWAYS, fetcher: fetcher as unknown as typeof fetch };
  const hosts = () => fetcher.mock.calls.map(([url]) => new URL(url).origin);
  return { ctx, fetcher, hosts };
}

describe('outside pictures, defensively', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads ipfs:// metadata and its picture through our gateway only, and draws only raster bytes', async () => {
    const { ctx, hosts } = context({ [`${GATEWAY}/ipfs/${CID}/1.json`]: json({ image: `ipfs://${CID}/1.png`, name: 'x' }), [`${GATEWAY}/ipfs/${CID}/1.png`]: PNG });
    expect(await pictureOfUri(`ipfs://${CID}/1.json`, ctx)).toEqual({ bytes: PNG, type: 'image/png' });
    expect(new Set(hosts())).toEqual(new Set([GATEWAY]));
  });

  it('reads ar:// through the Arweave gateways, and an inline raster data:image within its cap', async () => {
    // A bare id is read as /raw/<id> (no sandbox redirect); a path inside a manifest as /<id>/<path>.
    const { ctx, hosts } = context({ [`https://turbo-gateway.com/raw/${TX}`]: json({ image: `ar://${TX}/a.gif` }), [`https://turbo-gateway.com/${TX}/a.gif`]: GIF });
    expect((await pictureOfUri(`ar://${TX}`, ctx))?.type).toBe('image/gif');
    expect(new Set(hosts())).toEqual(new Set(['https://turbo-gateway.com']));
    const inline = `data:application/json;base64,${b64(JSON.stringify({ image: `data:image/png;base64,${b64(PNG)}` }))}`;
    expect((await pictureOfUri(inline, ctx))?.type).toBe('image/png');
    // A data:image whose bytes are over the cap is not decoded at all.
    const big = new Uint8Array(MAX_DATA_PICTURE_BYTES + 1);
    big.set(PNG);
    expect(await pictureOfUri(`data:application/json,${encodeURIComponent(JSON.stringify({ image: `data:image/png;base64,${b64(big)}` }))}`, ctx)).toBeNull();
  });

  it('never fetches another host: an https or http location shows the id alone', async () => {
    const { ctx, fetcher } = context({});
    for (const uri of ['https://evil.example/1.json', 'http://127.0.0.1:9/1.json', '//evil.example/x', 'HTTPS://EVIL.EXAMPLE/1.json']) {
      expect(await pictureOfUri(uri, ctx), uri).toBeNull();
    }
    const metadata = `data:application/json,${encodeURIComponent(JSON.stringify({ image: 'https://evil.example/1.png' }))}`;
    expect(await pictureOfUri(metadata, ctx)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('javascript:, blob:, file:, markup and SVG with a script render nothing, whatever the label says', async () => {
    const svgOnGateway = { [`${GATEWAY}/ipfs/${CID}/svg.json`]: json({ image: `ipfs://${CID}/svg` }), [`${GATEWAY}/ipfs/${CID}/svg`]: new TextEncoder().encode(SVG) };
    const { ctx } = context({ ...svgOnGateway, [`${GATEWAY}/ipfs/${CID}/html`]: new TextEncoder().encode('<html><script>alert(1)</script></html>') });
    const hostile = [
      'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'blob:http://127.0.0.1/x', 'file:///etc/passwd', 'vbscript:x',
      `data:image/svg+xml;base64,${b64(SVG)}`, `data:image/svg+xml,${encodeURIComponent(SVG)}`, `data:text/html,${encodeURIComponent('<script>alert(1)</script>')}`,
      `data:application/json,${encodeURIComponent(JSON.stringify({ image: `data:image/svg+xml;base64,${b64(SVG)}` }))}`,
      `data:application/json,${encodeURIComponent(JSON.stringify({ image_data: SVG }))}`,
      `data:application/json,${encodeURIComponent(JSON.stringify({ image: 'javascript:alert(1)' }))}`,
      // A raster label on SVG bytes is still SVG: drawn only by its first bytes.
      `data:image/png;base64,${b64(SVG)}`,
      `ipfs://${CID}/svg.json`, `ipfs://${CID}/html`,
    ];
    for (const uri of hostile) expect(await pictureOfUri(uri, ctx), uri).toBeNull();
  });

  it('missing, reverting, malformed or huge metadata gives the id alone and never throws', async () => {
    const chain = new FakeSetChain();
    const { ctx, fetcher } = context({ [`${GATEWAY}/ipfs/${CID}/big.json`]: new Uint8Array(MAX_METADATA_BYTES + 10).fill(32), [`${GATEWAY}/ipfs/${CID}/lies.json`]: { body: json({ image: 'x' }), length: '999999999999' } });
    // tokenURI reverts (none set), and a node that does not answer.
    expect(await loadItemPicture(chain, COLLECTION, 1n, ctx)).toBeNull();
    const down = { read: async () => { throw new Error('The request took too long to respond.'); } };
    expect(await loadItemPicture(down, COLLECTION, 1n, ctx)).toBeNull();
    for (const uri of [42, null, {}, '', 'ipfs://', `ipfs://${CID}/../../x`, `ipfs://${CID}?x=1`, 'ar://short', `data:application/json,${'{'.repeat(10)}`,
      `data:application/json;base64,${'@'.repeat(40)}`, 'x'.repeat(MAX_TOKEN_URI_CHARS + 1), `ipfs://${CID}/big.json`, `ipfs://${CID}/lies.json`,
      `data:application/json,${encodeURIComponent(JSON.stringify({ image: 7 }))}`, `data:application/json,${encodeURIComponent('[1,2]')}`]) {
      expect(await pictureOfUri(uri, ctx), String(uri).slice(0, 40)).toBeNull();
    }
    // The declared length past the cap is not read at all.
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('lies.json'))).toBe(true);
  });

  it('metadata that changes between reads: each answer is checked on its own; none breaks the next', async () => {
    const chain = new FakeSetChain();
    const answers = [`ipfs://${CID}/1.json`, 'javascript:alert(1)', `data:image/svg+xml,${encodeURIComponent(SVG)}`, `data:image/png;base64,${b64(PNG)}`];
    let at = 0;
    chain.tokenUris.set('5', () => answers[at++ % answers.length]);
    const { ctx } = context({ [`${GATEWAY}/ipfs/${CID}/1.json`]: json({ image: `data:image/gif;base64,${b64(GIF)}` }) });
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await loadItemPicture(chain, COLLECTION as Address, 5n, ctx));
    expect(results.map((picture) => picture?.type ?? null)).toEqual(['image/gif', null, null, 'image/png']);
  });

  it('a redirect, a failed gateway or no gateway at all: the next one, else the id alone', async () => {
    const { ctx } = context({ [`${GATEWAY}/ipfs/${CID}/r.json`]: 'redirect' });
    expect(await pictureOfUri(`ipfs://${CID}/r.json`, ctx)).toBeNull();
    const none = context({});
    expect(await pictureOfUri(`ipfs://${CID}/1.json`, { ...none.ctx, ipfs: [] })).toBeNull();
    expect(none.fetcher).not.toHaveBeenCalled();
    // A tokenURI that names a raster picture directly is that picture.
    const direct = context({ [`${GATEWAY}/ipfs/${CID}`]: PNG });
    expect((await pictureOfUri(`ipfs://${CID}`, direct.ctx))?.type).toBe('image/png');
  });

  it('locates only the three schemes, strictly', () => {
    expect(locate(`ipfs://${CID}/a/b.json`, 10)).toEqual({ kind: 'ipfs', path: `${CID}/a/b.json` });
    expect(locate(`ipfs://ipfs/${CID}`, 10)).toEqual({ kind: 'ipfs', path: CID });
    expect(locate(`ar://${TX}/x`, 10)).toEqual({ kind: 'ar', path: `${TX}/x` });
    expect(locate(`data:application/json,${encodeURIComponent('{}')}`, 10)).toMatchObject({ kind: 'data', mime: 'application/json' });
    expect(locate(`data:application/json,${encodeURIComponent('{"a":"0123456789"}')}`, 10)).toBeNull();
    expect(locate(stringToHex('x'), 10)).toBeNull();
  });
});
