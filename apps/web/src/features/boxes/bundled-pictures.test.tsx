/**
 * SH-BOX0-ART-TEST-SITE: box 0's committed pictures from the app's own bundle. The spec commits the FIT icon (an SVG,
 * field 23) and the Misfits collection picture (a PNG, field 28); our node's picture route never serves SVG, so the
 * app carries both public files and draws one only when the bytes it carries hash to the spec's commitment. No
 * gateway is asked for them; anything else keeps the gateway path and its placeholder.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '@squarehole/artwork';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../e2e/fixtures/sepolia-readonly/indexer-answers.json' with { type: 'json' };
import SEPOLIA_MANIFEST from '../../../../../packages/contracts/deployments/core-v1/11155111.json' with { type: 'json' };
import { coreSourceFor } from '../core/core-build';
import { loadFeed, type DirectReader, type Fetcher } from '../core/core-client';
import { recordFromRow } from '../core/row-record';
import { BoxCover, TokenMark } from './BoxParts';
import { BUNDLED_PICTURE_FILES } from './bundled-picture-files';
import { BUNDLED_PICTURE_HASHES, FIT_ICON_SHA256, MISFITS_COLLECTION_COVER_SHA256, bundledPicture, matchBundled } from './bundled-pictures';
import { resetPicturesForTests } from './box-pictures';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const file = (path: string) => new Uint8Array(readFileSync(resolve(ROOT, path)));
const SPEC = JSON.parse(readFileSync(resolve(ROOT, 'packages/contracts/script/config/box0-spec.11155111.rehearsal.sepolia-safe.json'), 'utf8')) as { summary: { coverSha256: string; collectionCoverSha256: string } };
const API = 'https://api.squarehole.fun';

afterEach(() => { cleanup(); resetPicturesForTests(); });

describe('the bundled files', () => {
  it('are byte for byte the repository’s public design files, and hash to box 0’s committed logo and collection cover', () => {
    const [icon, cover] = BUNDLED_PICTURE_FILES as [(typeof BUNDLED_PICTURE_FILES)[number], (typeof BUNDLED_PICTURE_FILES)[number]];
    // Compared as hex (the test DOM's typed arrays come from another realm).
    const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
    expect(hex(icon.bytes())).toBe(hex(file('packages/design/art/fit/fit-icon.svg')));
    expect(hex(cover.bytes())).toBe(hex(file('docs/design/misfits-v2/banner/final/misfits-collection-sorter-1024.png')));
    expect(sha256Hex(icon.bytes())).toBe(FIT_ICON_SHA256);
    expect(sha256Hex(cover.bytes())).toBe(MISFITS_COLLECTION_COVER_SHA256);
    expect([SPEC.summary.coverSha256, SPEC.summary.collectionCoverSha256]).toEqual([FIT_ICON_SHA256, MISFITS_COLLECTION_COVER_SHA256]);
    expect([...BUNDLED_PICTURE_HASHES].sort()).toEqual([FIT_ICON_SHA256, MISFITS_COLLECTION_COVER_SHA256].sort());
  });

  it('the SVG is inert: no script, no event handler, no link, no external reference', () => {
    const svg = new TextDecoder().decode(file('packages/design/art/fit/fit-icon.svg'));
    expect(svg).not.toMatch(/<script|\son[a-z]+=|href|<foreignObject|url\(|<image|<use|@import|data:/i);
  });

  it('a bundled picture is drawn only for the commitment its bytes hash to', async () => {
    expect((await bundledPicture(FIT_ICON_SHA256))?.type).toBe('image/svg+xml');
    expect((await bundledPicture(MISFITS_COLLECTION_COVER_SHA256.toUpperCase().replace('0X', '0x')))?.type).toBe('image/png');
    expect(await bundledPicture(`0x${'ab'.repeat(32)}`)).toBeNull();
    // Altered bytes under the committed hash never match.
    const altered = file('packages/design/art/fit/fit-icon.svg');
    altered[40] = (altered[40] ?? 0) ^ 0x01;
    expect(matchBundled(FIT_ICON_SHA256, [{ source: 'x', type: 'image/svg+xml', bytes: () => altered }])).toBeNull();
    expect(matchBundled(FIT_ICON_SHA256, [{ source: 'x', type: 'image/svg+xml', bytes: () => new Uint8Array() }])).toBeNull();
  });
});

describe('box 0 on the Sepolia feed', () => {
  const answers = fixture.answers as Record<string, unknown>;
  const BUILD = { manifests: [SEPOLIA_MANIFEST], localRpcUrl: '', indexers: { local: null, sepolia: API }, artGateways: { local: [], sepolia: [API] } };
  const NO_CHAIN: DirectReader = { feed: () => Promise.reject(new Error('read the chain')), box: () => Promise.reject(new Error('read the chain')), wallet: () => Promise.reject(new Error('read the chain')) };

  it('is listed from the indexer’s feed and shows its real logo and collection cover from the bundle; no picture is fetched', async () => {
    const fetcher: Fetcher = async (url) => {
      const { pathname, search } = new URL(url);
      const body = answers[`${pathname}${search}`] ?? answers[pathname];
      return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
    };
    const core = coreSourceFor('sepolia', BUILD, 'https://ethereum-sepolia-rpc.publicnode.com');
    if (core.status !== 'ready') throw new Error(core.status);
    const feed = await loadFeed(core, fetcher, NO_CHAIN);
    expect(feed.cards).toHaveLength(1);
    const [{ row }] = feed.cards as [(typeof feed.cards)[number]];
    const record = recordFromRow({ row, network: 'sepolia' }, { nowMs: 0, artGateways: [API] });
    expect(record.pictures).toEqual({ logo: FIT_ICON_SHA256, cover: MISFITS_COLLECTION_COVER_SHA256, gateways: [API] });
    const gateway = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    resetPicturesForTests(gateway);
    const { container } = render(<><BoxCover record={record} /><TokenMark record={record} /></>);
    await waitFor(() => expect(container.querySelector('.sh-box-cover')?.getAttribute('data-art')).toBe('image'));
    await waitFor(() => expect(container.querySelector('img.sh-box-coin--logo')).not.toBeNull());
    const logo = container.querySelector<HTMLImageElement>('img.sh-box-coin--logo')?.src ?? '';
    const cover = container.querySelector<HTMLImageElement>('.sh-box-cover img')?.src ?? '';
    // jsdom has no blob URLs, so the verified bytes come as data URLs: the SVG only ever as an <img> source.
    expect(logo).toMatch(/^(blob:|data:image\/svg\+xml;base64,)/);
    expect(cover).toMatch(/^(blob:|data:image\/png;base64,)/);
    expect(gateway).not.toHaveBeenCalled();
  });

  it('a hash the bundle does not carry still goes to the gateway, and without one shows the placeholder', async () => {
    const gateway = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    resetPicturesForTests(gateway);
    const other = `0x${'cd'.repeat(32)}` as const;
    const record = { market: null, rehearsal: false, art: null, spec: null, ticker: 'T', pictures: { logo: other, cover: other, gateways: [API] } } as unknown as Parameters<typeof BoxCover>[0]['record'];
    const { container } = render(<BoxCover record={record} />);
    await waitFor(() => expect(gateway).toHaveBeenCalledTimes(1));
    expect(container.querySelector('.sh-box-cover')?.getAttribute('data-art')).toBe('plain');
  });
});
