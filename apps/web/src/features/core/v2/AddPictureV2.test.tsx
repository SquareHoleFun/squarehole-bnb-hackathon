/**
 * SH-ARWEAVE-PICTURES-WEB: "Add picture" on a v2 box page. It shows only once a committed logo or cover was looked for
 * and not found, on a source that keeps pictures on Arweave; a dropped file is published only when it is the committed
 * picture (no wallet), and then shows at once; any other file gets one short refusal and nothing is sent.
 */
import { pngFixture } from '../../../../../../packages/artwork/src/picture-fixtures';
import { rawCidV1, sha256Hex } from '@squarehole/artwork';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoxRecord } from '../../boxes/box-model';
import { BoxCover } from '../../boxes/BoxParts';
import { picturesOf, resetPicturesForTests } from '../../boxes/box-pictures';
import { publishToArweave, type PublishOptions, type PublishResult, type PictureToPublish } from '../../pictures/arweave-publish';
import { verifyEthDataItem } from '../../pictures/ans104-eth';
import { REFRESH_MS, REFUSED_PICTURE_TEXT, resetWithheldForTests } from '../../pictures/withheld';
import { AddPictureV2, ADD_PICTURE_LINES } from './AddPictureV2';

const png = pngFixture;
const LOGO = png(1); const COVER = png(2);
const LOGO_SHA = sha256Hex(LOGO) as `0x${string}`; const COVER_SHA = sha256Hex(COVER) as `0x${string}`;
const record = (pictures: BoxRecord['pictures']) => ({ market: null, rehearsal: false, art: null, spec: null, ticker: 'T', pictures,
  v2Chain: { source: { manifest: { chainId: 11155111 } }, snapshot: null } }) as unknown as BoxRecord;
/** Arweave and our node, holding nothing: every lookup ends without a picture. */
const empty = vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/graphql') ? Response.json({ data: { transactions: { edges: [] } } }) : new Response(null, { status: 404 }))) as unknown as typeof fetch;

function turbo(answer: (picture: PictureToPublish) => PublishResult = (p) => ({ sha256: p.sha256, ok: true, id: `${p.sha256.slice(2, 45)}`, itemBytes: 400, ms: 3 })) {
  return vi.fn(async (pictures: readonly PictureToPublish[], options: PublishOptions) => pictures.map((picture) => { const result = answer(picture); options.onResult?.(result); return result; }));
}
const drop = (bytes: Uint8Array, name = 'cover.png') => {
  const input = document.querySelector('.sh-v2-add-picture input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([bytes.slice()], name, { type: 'image/png' })] } });
};

beforeEach(() => { resetPicturesForTests(empty); });
afterEach(() => { cleanup(); resetPicturesForTests(); });

describe('Add picture', () => {
  it('appears once the lookup ends without the picture; the committed file is published (no wallet) and shows at once', async () => {
    const publish = turbo();
    const box = record(picturesOf(LOGO_SHA, COVER_SHA, [], { copies: null }));
    const { container } = render(<><BoxCover record={box} /><AddPictureV2 record={box} seams={{ publish, reshrink: null }} /></>);
    expect(screen.queryByText('Add picture')).toBeNull();
    await waitFor(() => expect(screen.getByText('Add picture')).toBeTruthy());
    drop(COVER);
    await waitFor(() => expect(container.querySelector('.sh-box-cover')?.getAttribute('data-art')).toBe('image'));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toEqual([{ sha256: COVER_SHA, bytes: COVER }]);
    expect(publish.mock.calls[0]?.[1]).toMatchObject({ chainId: 11155111 });
    // The logo is still missing: the button stays for it, and its file clears it too.
    expect(screen.getByText('Add picture')).toBeTruthy();
    drop(LOGO, 'logo.png');
    await waitFor(() => expect(screen.queryByText('Add picture')).toBeNull());
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('another file: one short refusal, nothing sent; a failed or too large upload says so', async () => {
    const publish = turbo();
    const box = record(picturesOf(LOGO_SHA, null, [], { copies: null }));
    render(<AddPictureV2 record={box} seams={{ publish, reshrink: async () => png(9) }} />);
    await waitFor(() => expect(screen.getByText('Add picture')).toBeTruthy());
    drop(png(8));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('This file is not this box’s picture.'));
    expect(publish).not.toHaveBeenCalled();
    cleanup(); resetPicturesForTests(empty);
    const failing = turbo((p) => ({ sha256: p.sha256, ok: false, reason: 'network', itemBytes: 400 }));
    render(<AddPictureV2 record={box} seams={{ publish: failing, reshrink: null }} />);
    await waitFor(() => expect(screen.getByText('Add picture')).toBeTruthy());
    drop(LOGO);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(ADD_PICTURE_LINES.failed));
    cleanup(); resetPicturesForTests(empty);
    const big = turbo((p) => ({ sha256: p.sha256, ok: false, reason: 'too-large', itemBytes: 200_000 }));
    render(<AddPictureV2 record={box} seams={{ publish: big, reshrink: null }} />);
    await waitFor(() => expect(screen.getByText('Add picture')).toBeTruthy());
    drop(LOGO);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Too large to store for free.'));
  });

  it('the original picture counts when it shrinks (as Create shrank it) to the committed bytes', async () => {
    const publish = turbo();
    const reshrink = vi.fn(async () => LOGO);
    const box = record(picturesOf(LOGO_SHA, null, [], { copies: null }));
    render(<AddPictureV2 record={box} seams={{ publish, reshrink }} />);
    await waitFor(() => expect(screen.getByText('Add picture')).toBeTruthy());
    drop(png(3, 5_000), 'original.png');
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0]?.[0]).toEqual([{ sha256: LOGO_SHA, bytes: LOGO }]);
  });

  it('never where the source keeps no pictures on Arweave, nor while the picture is found', async () => {
    const box = record(picturesOf(LOGO_SHA, null, ['http://127.0.0.1:5421']));
    render(<AddPictureV2 record={box} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(screen.queryByText('Add picture')).toBeNull();
    cleanup();
    const found = vi.fn(async (input: RequestInfo | URL) => (String(input).includes('/raw/H') ? new Response(LOGO.slice()) : new Response(null, { status: 404 }))) as unknown as typeof fetch;
    resetPicturesForTests(found);
    const shown = record(picturesOf(LOGO_SHA, null, [], { copies: { logo: `H${'d'.repeat(42)}` } }));
    const { container } = render(<><BoxCover record={shown} /><AddPictureV2 record={shown} /></>);
    await waitFor(() => expect(container.querySelector('.sh-box-cover')?.getAttribute('data-art')).toBe('image'));
    expect(screen.queryByText('Add picture')).toBeNull();
  });
});

describe('SH-WITHHELD-SITE fix round af3: Add picture asks the withheld list right before its upload (R77-TAKEDOWN-CREATE)', () => {
  afterEach(() => { resetWithheldForTests(); });
  const h = (id: string) => createHash('sha256').update(`sh-withheld-v1:${id}`).digest('hex');

  it('a picture the list names by the time its file is checked is never sent: the line, and the other picture still offered', async () => {
    let clock = 1_000_000;
    let reads = 0;
    resetWithheldForTests({ origin: 'https://api.example.test', now: () => clock, fetcher: vi.fn(async () => {
      reads += 1;
      return Response.json({ version: 1, hashes: reads === 1 ? [] : [h(`ipfs:${rawCidV1(LOGO_SHA)}`)] });
    }) as unknown as typeof fetch });
    const publish = turbo();
    // While the creator's original is shrunk to the committed bytes, the list is read again and names the logo.
    const reshrink = vi.fn(async () => {
      clock += REFRESH_MS;
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.waitFor(() => expect(reads).toBe(2));
      await new Promise((resolve) => setTimeout(resolve, 10));
      return LOGO;
    });
    const box = record(picturesOf(LOGO_SHA, COVER_SHA, [], { copies: null }));
    render(<AddPictureV2 record={box} seams={{ publish, reshrink }} />);
    await waitFor(() => expect(screen.getByText('Add picture')).toBeTruthy());
    expect(reads).toBe(1);
    drop(png(3, 5_000), 'original.png');
    // The file's check ends (refused here, or sent on to Turbo): then nothing may have been sent.
    await waitFor(() => expect(reshrink).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(ADD_PICTURE_LINES.checking)).toBeNull());
    expect(publish).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe(REFUSED_PICTURE_TEXT);
    expect(ADD_PICTURE_LINES.withheld).toBe(REFUSED_PICTURE_TEXT);
    // The cover is still missing (not listed): Add picture stays for it.
    expect(screen.getByText('Add picture')).toBeTruthy();
  });
});

describe('SH-WITHHELD-SITE fix round af4: Add picture’s upload request asks the list too (the real publisher)', () => {
  afterEach(() => { resetWithheldForTests(); });
  const h = (id: string) => createHash('sha256').update(`sh-withheld-v1:${id}`).digest('hex');
  const UPLOAD = 'https://upload.test';

  it('Turbo’s /info held, the list then names the logo: its upload request is never sent; the line; the cover still offered', async () => {
    let clock = 1_000_000;
    let reads = 0;
    resetWithheldForTests({ origin: 'https://api.example.test', now: () => clock, fetcher: vi.fn(async () => {
      reads += 1;
      return Response.json({ version: 1, hashes: reads === 1 ? [] : [h(`ipfs:${rawCidV1(LOGO_SHA)}`)] });
    }) as unknown as typeof fetch });
    let open: () => void = () => undefined;
    const info = new Promise<void>((resolve) => { open = resolve; });
    const asked: string[] = [];
    const posts: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push(url);
      if (url === `${UPLOAD}/info`) { await info; return Response.json({ freeUploadLimitBytes: 107_520 }); }
      if (url === `${UPLOAD}/v1/tx` && init?.method === 'POST') { const item = await verifyEthDataItem(new Uint8Array(init.body as Uint8Array)); posts.push(url); return Response.json({ id: item?.id }); }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const publish = vi.fn((pictures: readonly PictureToPublish[], options: PublishOptions) => publishToArweave(pictures, { ...options, fetcher, upload: UPLOAD }));
    render(<AddPictureV2 record={record(picturesOf(LOGO_SHA, COVER_SHA, [], { copies: null }))} seams={{ publish, reshrink: null }} />);
    await waitFor(() => expect(screen.getByText('Add picture')).toBeTruthy());
    drop(LOGO, 'logo.png');
    await waitFor(() => expect(asked).toEqual([`${UPLOAD}/info`]));
    clock += REFRESH_MS;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(reads).toBe(2));
    open();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(REFUSED_PICTURE_TEXT));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(posts).toEqual([]);
    expect(screen.getByText('Add picture')).toBeTruthy();
  });
});
