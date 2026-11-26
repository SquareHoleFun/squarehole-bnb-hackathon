/**
 * SH-294: a launch's picture: shrunk the logo's way, published with a throwaway key, and its link in the launch's own
 * field (Flap `meta`, OpenFour `tokenUri`); a refused file and a failed publish leave the field empty.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hexOf, sha256Of, verifyEthDataItem } from '../src/lib/pictures/ans104-eth';
import { parsePictureLink, pictureLink, publishPicture, rasterType } from '../src/lib/pictures/publish';
import { TOO_DETAILED, UNREADABLE, type PictureEncoder } from '../src/lib/pictures/shrink';
import { PICTURE_WORDS, publishLine } from '../src/components/PictureField';

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137]);
const ID = 'A'.repeat(43);
const HEX = 'ab'.repeat(32);
const SIGNER_URI = /^(https|ipfs):\/\/[\x21-\x7e]+$/;

/** An encoder that draws anything and writes `out` (null: unreadable) for every step. */
const encoder = (out: Uint8Array | null, drawable = true): PictureEncoder<unknown> => ({
  webp: async () => false,
  draw: async () => (drawable ? {} : null),
  encode: async () => (out ? new Blob([new Uint8Array(out)], { type: 'image/jpeg' }) : null),
});
const JPEG = Uint8Array.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 255, 217]);

/** A Turbo stand-in: its free size, and an upload that answers the item's own id (or refuses). */
function turbo(answer: 'ok' | 'refuse' | 'down' = 'ok') {
  const sent: Uint8Array[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/info')) return new Response(JSON.stringify({ freeUploadLimitBytes: 107_520 }));
    if (answer === 'down') throw new TypeError('Failed to fetch');
    const bytes = new Uint8Array(init?.body as ArrayBuffer);
    sent.push(bytes);
    if (answer === 'refuse') return new Response('no', { status: 402 });
    const item = await verifyEthDataItem(bytes);
    return new Response(JSON.stringify({ id: item?.id }));
  }) as typeof fetch;
  return { fetcher, sent };
}

describe('the link (both rails)', () => {
  it('https://arweave.net/<id>#sha256=<hex>: under the signer\'s 200 characters and its form, read back exactly', () => {
    const link = pictureLink(ID, HEX);
    expect(link).toBe(`https://arweave.net/${ID}#sha256=${HEX}`);
    expect(link.length).toBe(135);
    expect(SIGNER_URI.test(link)).toBe(true);
    expect(parsePictureLink(link)).toEqual({ id: ID, sha256: HEX });
    expect(parsePictureLink(`https://turbo-gateway.com/raw/${ID}#sha256=${HEX}`)).toEqual({ id: ID, sha256: HEX });
  });
  it('anything else reads as no picture: another host, ipfs://, no hash, a JSON document', () => {
    for (const other of [`https://evil.example/${ID}#sha256=${HEX}`, `ipfs://bafy${ID}`, `https://arweave.net/${ID}`, '{"image":"x"}', '']) expect(parsePictureLink(other)).toBeNull();
  });
  it('the OpenFour signer still refuses anything but https:// or ipfs:// printable ASCII up to 200 (its own rule, read as text)', () => {
    const sign = readFileSync(new URL('../../openfour/sign/sign-create.js', import.meta.url), 'utf8');
    expect(sign).toContain('uri.length > 200 || (uri !== "" && !/^(https|ipfs):\\/\\/[\\x21-\\x7e]+$/.test(uri))');
  });
  it('raster only: PNG, JPEG, GIF, WebP; an SVG is no picture', () => {
    expect(rasterType(PNG)).toBe('image/png');
    expect(rasterType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });
});

describe('the publish', () => {
  it('a picture: shrunk, signed by a throwaway key, sent once, its link names the item and the bytes\' hash', async () => {
    const t = turbo();
    const result = await publishPicture(new Blob([PNG]), { chainId: 97, fetcher: t.fetcher, encoder: encoder(JPEG) });
    if (!result.ok) throw new Error(`not published: ${JSON.stringify(result)}`);
    expect(t.sent).toHaveLength(1);
    const item = await verifyEthDataItem(t.sent[0]!);
    expect(item?.valid).toBe(true);
    expect(parsePictureLink(result.link)).toEqual({ id: item?.id, sha256: hexOf(await sha256Of(JPEG)) });
    expect(result.type).toBe('image/jpeg');
  });
  it('a file the browser cannot read, or one too detailed for the free size: the platform\'s own line, nothing sent', async () => {
    const t = turbo();
    const unreadable = await publishPicture(new Blob([PNG]), { chainId: 97, fetcher: t.fetcher, encoder: encoder(null, false) });
    const tooBig = await publishPicture(new Blob([PNG]), { chainId: 97, fetcher: t.fetcher, encoder: encoder(new Uint8Array(200_000).fill(1)) });
    expect([unreadable.ok ? '' : publishLine(unreadable), tooBig.ok ? '' : publishLine(tooBig)]).toEqual([UNREADABLE, TOO_DETAILED]);
    expect(t.sent).toHaveLength(0);
  });
  it('a refused or failed upload: "Not published. Try again." and no link (the launch goes on without a picture)', async () => {
    for (const answer of ['refuse', 'down'] as const) {
      const result = await publishPicture(new Blob([PNG]), { chainId: 97, fetcher: turbo(answer).fetcher, encoder: encoder(JPEG) });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(publishLine(result)).toBe(PICTURE_WORDS.failed);
    }
  });
});
