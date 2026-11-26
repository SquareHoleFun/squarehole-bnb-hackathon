import { blankPng } from '../../../../../packages/cards/src/test-support';
// SH-BOX-PICTURE-FIT: which of a box's two pictures each slot shows (picture-slot.ts), and that the slots draw it whole
// (BoxCover, TokenMark, the Launch flow's PictureSlots). The Rent Free box (founder 2026-11-02): a square logo (a house)
// and a 1200 x 630 cover with its name and line; the feed card showed the cover cut to a square, the header icon too.
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rawCidV1, sha256Hex } from '@squarehole/artwork';
import { PictureSlots } from '../create/PictureSlots';
import { REFRESH_MS, resetWithheldForTests } from '../pictures/withheld';
import { picturesOf, resetPicturesForTests } from './box-pictures';
import type { BoxRecord } from './box-model';
import { MemoryRouter } from 'react-router';
import { BoxCard, BoxTable } from './BoxCard';
import { BoxHeader } from './BoxHeader';
import { BoxCover, TokenMark } from './BoxParts';
import { chooseSlotPicture, fallsThrough, groundUrl, headerSlot, NO_SOURCE, SLOT_ORDER, SLOT_WAIT_MS, slotSource, type SlotSource } from './picture-slot';

const shown = (url: string): SlotSource => ({ state: 'shown', url });
const PENDING: SlotSource = { state: 'pending', url: null };
const MISSING: SlotSource = { state: 'missing', url: null };
const WITHHELD: SlotSource = { state: 'withheld', url: null };

describe('chooseSlotPicture: the order of each slot', () => {
  it('a square slot asks for the logo first, a card for the cover first', () => {
    expect(SLOT_ORDER.square).toEqual(['logo', 'cover']);
    expect(SLOT_ORDER.card).toEqual(['cover', 'logo']);
  });

  it('a square slot shows the logo when it has one, whatever the cover', () => {
    expect(chooseSlotPicture('square', shown('logo.png'), shown('cover.png'))).toEqual({ kind: 'picture', which: 'logo', url: 'logo.png' });
    expect(chooseSlotPicture('square', shown('logo.png'), NO_SOURCE)).toEqual({ kind: 'picture', which: 'logo', url: 'logo.png' });
  });

  it('a card shows the cover when it has one', () => {
    expect(chooseSlotPicture('card', shown('cover.png'), shown('logo.png'))).toEqual({ kind: 'picture', which: 'cover', url: 'cover.png' });
  });

  it('falls back to the other picture only when its own is none or missing', () => {
    expect(chooseSlotPicture('square', NO_SOURCE, shown('cover.png'))).toEqual({ kind: 'picture', which: 'cover', url: 'cover.png' });
    expect(chooseSlotPicture('square', MISSING, shown('cover.png'))).toEqual({ kind: 'picture', which: 'cover', url: 'cover.png' });
    expect(chooseSlotPicture('card', MISSING, shown('logo.png'))).toEqual({ kind: 'picture', which: 'logo', url: 'logo.png' });
    expect(chooseSlotPicture('card', NO_SOURCE, shown('logo.png'))).toEqual({ kind: 'picture', which: 'logo', url: 'logo.png' });
  });

  it('waits while its own picture loads: the other one never flashes in first', () => {
    expect(chooseSlotPicture('square', PENDING, shown('cover.png'))).toEqual({ kind: 'pending', which: 'logo' });
    expect(chooseSlotPicture('card', PENDING, shown('logo.png'))).toEqual({ kind: 'pending', which: 'cover' });
    expect(chooseSlotPicture('square', MISSING, PENDING)).toEqual({ kind: 'pending', which: 'cover' });
  });

  it('a withheld picture is the tile, never replaced by the other picture (SH-WITHHELD-SITE)', () => {
    expect(chooseSlotPicture('square', WITHHELD, shown('cover.png'))).toEqual({ kind: 'withheld', which: 'logo' });
    expect(chooseSlotPicture('card', WITHHELD, shown('logo.png'))).toEqual({ kind: 'withheld', which: 'cover' });
    // The fallback picture withheld: the tile too.
    expect(chooseSlotPicture('square', MISSING, WITHHELD)).toEqual({ kind: 'withheld', which: 'cover' });
  });

  it('fix round af1: a first picture still loading after the wait gives way to a verified second only', () => {
    expect(chooseSlotPicture('square', PENDING, shown('cover.png'), true)).toEqual({ kind: 'picture', which: 'cover', url: 'cover.png' });
    expect(chooseSlotPicture('card', PENDING, shown('logo.png'), true)).toEqual({ kind: 'picture', which: 'logo', url: 'logo.png' });
    // Nothing verified to give way to: the slot keeps waiting for its own picture.
    expect(chooseSlotPicture('square', PENDING, PENDING, true)).toEqual({ kind: 'pending', which: 'logo' });
    expect(chooseSlotPicture('square', PENDING, MISSING, true)).toEqual({ kind: 'pending', which: 'logo' });
    expect(chooseSlotPicture('square', PENDING, WITHHELD, true)).toEqual({ kind: 'pending', which: 'logo' });
    // The first wins whenever it is there: shown, or withheld (the tile, never the other picture), late or not.
    expect(chooseSlotPicture('square', shown('logo.png'), shown('cover.png'), true)).toEqual({ kind: 'picture', which: 'logo', url: 'logo.png' });
    expect(chooseSlotPicture('square', WITHHELD, shown('cover.png'), true)).toEqual({ kind: 'withheld', which: 'logo' });
    expect(chooseSlotPicture('card', WITHHELD, shown('logo.png'), true)).toEqual({ kind: 'withheld', which: 'cover' });
  });

  it('nothing to show: none (the slot draws its art or the plain tile)', () => {
    expect(chooseSlotPicture('square', NO_SOURCE, NO_SOURCE)).toEqual({ kind: 'none' });
    expect(chooseSlotPicture('card', MISSING, MISSING)).toEqual({ kind: 'none' });
    expect(chooseSlotPicture('card', MISSING, NO_SOURCE)).toEqual({ kind: 'none' });
  });

  it('fallsThrough: only none and missing', () => {
    expect([NO_SOURCE, MISSING, PENDING, WITHHELD, shown('x')].map(fallsThrough)).toEqual([true, true, false, false, false]);
  });
});

describe('slotSource: one picture as the page knows it', () => {
  const EMPTY = { url: null, missing: false, withheld: false };
  it('a verified URL, else the creator’s own copy, is shown', () => {
    expect(slotSource('0xab', { ...EMPTY, url: 'blob:x/1' }, true, 'data:image/png;base64,AA==')).toEqual({ state: 'shown', url: 'blob:x/1' });
    expect(slotSource('0xab', EMPTY, true, 'data:image/png;base64,AA==')).toEqual(PENDING);
    const bytes = blankPng(3, 2), hash = sha256Hex(bytes), url = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
    expect(slotSource(hash, EMPTY, true, url)).toEqual(PENDING);
    expect(slotSource(null, EMPTY, false, 'data:image/png;base64,AA==')).toEqual({ state: 'shown', url: 'data:image/png;base64,AA==' });
  });
  it('nothing committed and no copy: none; a hash no source can serve, or a lookup that ended empty: missing', () => {
    expect(slotSource(null, EMPTY, false, null)).toEqual(NO_SOURCE);
    expect(slotSource('0xab', EMPTY, false, null)).toEqual(MISSING);
    expect(slotSource('0xab', { ...EMPTY, missing: true }, true, null)).toEqual(MISSING);
  });
  it('a lookup under way: pending; withheld wins over any copy', () => {
    expect(slotSource('0xab', EMPTY, true, null)).toEqual(PENDING);
    expect(slotSource('0xab', { ...EMPTY, withheld: true }, true, 'data:image/png;base64,AA==')).toEqual(WITHHELD);
  });
});

describe('groundUrl: the blurred copy behind a contained picture', () => {
  it('names blob URLs and base64 raster data URLs only, quoted', () => {
    expect(groundUrl('blob:http://127.0.0.1:5392/1b2c-3d')).toBe('url("blob:http://127.0.0.1:5392/1b2c-3d")');
    expect(groundUrl('data:image/png;base64,iVBORw0KGgo=')).toBe('url("data:image/png;base64,iVBORw0KGgo=")');
  });
  it('anything that could leave the string, or another type, gets no ground', () => {
    expect(groundUrl('blob:x") ; background: red; ("')).toBeNull();
    expect(groundUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(groundUrl('https://example.org/a.png')).toBeNull();
    expect(groundUrl('data:image/png;base64,AA==\n')).toBeNull();
  });
});

// The slots in the page: a box built from a BoxSpec on this page carries its own copies (data URLs).
const LOGO = 'data:image/png;base64,TE9HTw==';
const COVER = 'data:image/png;base64,Q09WRVI=';

function specRecord(logo: string | null, cover: string | null): BoxRecord {
  return { id: 'demo:x', name: 'Rent Free', ticker: 'RENT', market: null, rehearsal: false, art: null, pictures: null, spec: { coverUrl: logo, collectionCoverUrl: cover } } as unknown as BoxRecord;
}

describe('the slots on the page', () => {
  afterEach(() => { cleanup(); resetPicturesForTests(); });

  // SH-223 (founder 2026-11-15, the first box's page on the test site): the Genesis box's logo is its token's plain
  // coin; the big picture of its page is the box picture again, as on its feed card. Every other box keeps the logo.
  it('SH-223: the header of the Genesis box shows its box picture, the header of any other box its logo', () => {
    expect(headerSlot({ kind: 'genesis' })).toBe('card');
    for (const kind of ['new', 'existing', 'token'] as const) expect(headerSlot({ kind })).toBe('square');
    const head = (kind: BoxRecord['kind']) => {
      const record = { ...specRecord(LOGO, COVER), kind, chainId: 11_155_111, networkLabel: 'Sepolia', demo: false } as unknown as BoxRecord;
      const { container, unmount } = render(
        <BoxHeader record={record} state={null} band={{ figure: null, barBps: null }} line={null} idLine={null} phase={null} stats={[]} counters={[]} side={null} preview />,
      );
      const frame = container.querySelector<HTMLElement>('.sh-box-head__cover .sh-box-cover');
      const seen = { ...frame?.dataset, src: frame?.querySelector('img')?.getAttribute('src') };
      unmount();
      return seen;
    };
    expect(head('genesis')).toMatchObject({ slot: 'card', picture: 'cover', fit: 'contain', art: 'image', src: COVER });
    for (const kind of ['new', 'existing', 'token'] as const) {
      expect(head(kind)).toMatchObject({ slot: 'square', picture: 'logo', fit: 'contain', art: 'image', src: LOGO });
    }
  });

  it('SH-223: the List row of the Genesis box shows its box picture, the row of any other box its logo; the coins stay logos', () => {
    const row = (kind: BoxRecord['kind'], name: string) => {
      const record = { ...specRecord(LOGO, COVER), id: `demo:${name}`, name, kind, chainId: 11_155_111, networkLabel: 'Sepolia', demo: false, featured: kind === 'genesis', itemCount: 4, itemNoun: 'items' } as unknown as BoxRecord;
      return { summary: { record, state: null, figure: { text: 'FDV 2.05 ETH' }, notice: null, cells: null }, to: `/box/${name}` } as unknown as Parameters<typeof BoxTable>[0]['rows'][number];
    };
    const genesisRow = row('genesis', 'first');
    const rows = [genesisRow, row('new', 'second'), row('token', 'third')];
    const { container } = render(<MemoryRouter><BoxTable rows={rows} /></MemoryRouter>);
    const thumbs = Array.from(container.querySelectorAll<HTMLElement>('.sh-box-table__thumb'));
    expect(thumbs.map((t) => [t.dataset.slot, t.dataset.picture, t.querySelector('img')?.getAttribute('src')])).toEqual([
      ['card', 'cover', COVER],
      ['square', 'logo', LOGO],
      ['square', 'logo', LOGO],
    ]);
    // The grid card of the same Genesis box: the cover in the frame, the logo as its token's coin (unchanged).
    const card = render(<MemoryRouter><ul><BoxCard {...genesisRow} /></ul></MemoryRouter>);
    expect(card.container.querySelector<HTMLElement>('.sh-box-cover')?.dataset).toMatchObject({ slot: 'card', picture: 'cover' });
    expect(card.container.querySelector('img.sh-box-coin--logo')?.getAttribute('src')).toBe(LOGO);
  });

  it('SH-223: a Genesis box without a box picture shows its logo in the header, one without any picture the plain tile', () => {
    const head = (logo: string | null, cover: string | null) => {
      const record = { ...specRecord(logo, cover), kind: 'genesis', chainId: 11_155_111, networkLabel: 'Sepolia', demo: false } as unknown as BoxRecord;
      const { container, unmount } = render(
        <BoxHeader record={record} state={null} band={{ figure: null, barBps: null }} line={null} idLine={null} phase={null} stats={[]} counters={[]} side={null} preview />,
      );
      const frame = container.querySelector<HTMLElement>('.sh-box-head__cover .sh-box-cover');
      const seen = { ...frame?.dataset, src: frame?.querySelector('img')?.getAttribute('src') ?? null };
      unmount();
      return seen;
    };
    // specRecord's "cover" falls back to the logo when the spec commits no collection cover (localUrl, BoxParts.tsx).
    expect(head(LOGO, null)).toMatchObject({ slot: 'card', art: 'image', src: LOGO });
    expect(head(null, null)).toMatchObject({ slot: 'card', art: 'plain', src: null });
  });

  it('Rent Free: the card shows the cover, the header icon and the coin show the logo, each drawn whole', () => {
    const { container } = render(
      <>
        <BoxCover record={specRecord(LOGO, COVER)} small />
        <BoxCover record={specRecord(LOGO, COVER)} slot="square" className="sh-v2-head__cover" />
        <TokenMark record={specRecord(LOGO, COVER)} size={16} />
      </>,
    );
    const [card, icon] = Array.from(container.querySelectorAll<HTMLElement>('.sh-box-cover'));
    expect(card?.dataset).toMatchObject({ slot: 'card', picture: 'cover', fit: 'contain', art: 'image' });
    expect(card?.querySelector('img')?.getAttribute('src')).toBe(COVER);
    expect(icon?.dataset).toMatchObject({ slot: 'square', picture: 'logo', fit: 'contain' });
    expect(icon?.querySelector('img')?.getAttribute('src')).toBe(LOGO);
    // The blurred ground is the picture itself.
    expect(card?.style.getPropertyValue('--sh-box-cover-ground')).toBe(`url("${COVER}")`);
    const coin = container.querySelector('img.sh-box-coin--logo');
    expect(coin?.getAttribute('src')).toBe(LOGO);
    expect(coin?.classList.contains('sh-box-coin--cover')).toBe(false);
  });

  it('a box without a collection cover shows its logo on the card too', () => {
    const { container } = render(<BoxCover record={specRecord(LOGO, null)} small />);
    expect(container.querySelector<HTMLElement>('.sh-box-cover')?.dataset).toMatchObject({ slot: 'card', picture: 'cover' });
    expect(container.querySelector('.sh-box-cover img')?.getAttribute('src')).toBe(LOGO);
  });

  it('a chain box whose logo no gateway has: the square slots show the verified cover, whole; the card the cover', async () => {
    const coverBytes = blankPng(3, 4);
    const coverHash = sha256Hex(coverBytes) as `0x${string}`;
    const logoHash = `0x${'11'.repeat(32)}` as const;
    const asked: string[] = [];
    resetPicturesForTests((async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      return url.endsWith(`/ipfs/${rawCidV1(coverHash)}`) ? new Response(coverBytes.slice(), { status: 200 }) : new Response(null, { status: 404 });
    }) as typeof fetch);
    const record = { ...specRecord(null, null), spec: null, pictures: picturesOf(logoHash, coverHash, ['http://127.0.0.1:5421']) } as BoxRecord;
    const { container } = render(
      <>
        <BoxCover record={record} slot="square" className="square" />
        <TokenMark record={record} size={40} />
        <BoxCover record={record} small className="card" />
      </>,
    );
    await waitFor(() => expect(container.querySelector<HTMLElement>('.sh-box-cover.square')?.dataset.picture).toBe('cover'));
    expect(container.querySelector<HTMLElement>('.sh-box-cover.square')?.dataset.fit).toBe('contain');
    await waitFor(() => expect(container.querySelector('img.sh-box-coin--cover')).not.toBeNull());
    expect(container.querySelector<HTMLElement>('.sh-box-cover.card')?.dataset.picture).toBe('cover');
    // Both were asked (at once, fix round af1), each once.
    expect(asked.filter((url) => url.endsWith(rawCidV1(logoHash)))).toHaveLength(1);
    expect(asked.filter((url) => url.endsWith(rawCidV1(coverHash)))).toHaveLength(1);
  });

  it('while the logo loads, the header icon waits on the plain tile: the cover never shows there first', () => {
    resetPicturesForTests((() => new Promise<Response>(() => undefined)) as unknown as typeof fetch);
    const record = { ...specRecord(null, null), spec: null, pictures: picturesOf(`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`, ['http://127.0.0.1:5421']) } as BoxRecord;
    const { container } = render(<BoxCover record={record} slot="square" />);
    expect(container.querySelector<HTMLElement>('.sh-box-cover')?.dataset.art).toBe('plain');
    expect(container.querySelector('.sh-box-cover img')).toBeNull();
  });

  it('the Launch flow previews both slots: the icon with the logo, the card with the cover', () => {
    const { container, rerender } = render(<PictureSlots logo={LOGO} cover={COVER} />);
    const slots = Array.from(container.querySelectorAll<HTMLElement>('.sh-newbox-slot'));
    expect(slots.map((slot) => [slot.dataset.slot, slot.textContent, slot.querySelector('img')?.getAttribute('src')])).toEqual([
      ['square', 'Icon · logo', LOGO],
      ['card', 'Card · cover', COVER],
    ]);
    // No collection cover (a token box, or none picked yet): the card shows the logo, and says so.
    rerender(<PictureSlots logo={LOGO} cover={null} />);
    expect(Array.from(container.querySelectorAll('.sh-newbox-slot')).map((slot) => slot.textContent)).toEqual(['Icon · logo', 'Card · logo']);
    rerender(<PictureSlots logo={null} cover={null} />);
    expect(container.querySelector('.sh-newbox-slots')).toBeNull();
  });
});

/** A real PNG's bytes, and its SHA-256. */
function pngBytes(seed: number): { readonly bytes: Uint8Array; readonly sha: `0x${string}` } {
  const bytes = blankPng(seed + 2, seed + 2);
  return { bytes, sha: sha256Hex(bytes).toLowerCase() as `0x${string}` };
}

/**
 * Fix round af1 (review): the second picture was asked only once the first ended without one, so a box whose logo's
 * gateway stalled showed a blank square slot for the logo's whole lookup. Now both are asked at once and the choice
 * waits: the first still wins whenever it verifies, and a withheld first is the tile.
 */
/**
 * Waits for `check` to pass, turning the event loop with setImmediate inside act (the fake timers below fake only
 * setTimeout, which Testing Library's waitFor itself waits on).
 */
async function until(check: () => void): Promise<void> {
  let last: unknown = null;
  for (let turn = 0; turn < 500; turn += 1) {
    try {
      check();
      return;
    } catch (error) {
      last = error;
    }
    await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
  }
  throw last;
}

describe('fix round af1: a slot asks for both pictures at once', () => {
  const GATEWAY = 'http://127.0.0.1:5421';
  const logo = pngBytes(1);
  const cover = pngBytes(2);
  const chainBox = () => ({ ...specRecord(null, null), spec: null, pictures: picturesOf(logo.sha, cover.sha, [GATEWAY]) }) as BoxRecord;
  const slotOf = (container: HTMLElement, name: string) => container.querySelector<HTMLElement>(`.sh-box-cover.${name}`);

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    resetPicturesForTests();
    resetWithheldForTests();
  });

  /** Our node, a double: the cover at once, the logo only when `release` is called (a stalled gateway until then). */
  function stalledLogo() {
    const asked: string[] = [];
    let release: () => void = () => undefined;
    const logoAnswer = new Promise<Response>((resolve) => { release = () => resolve(new Response(logo.bytes.slice(), { status: 200 })); });
    resetPicturesForTests((async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      if (url.endsWith(`/ipfs/${rawCidV1(logo.sha)}`)) return logoAnswer;
      if (url.endsWith(`/ipfs/${rawCidV1(cover.sha)}`)) return new Response(cover.bytes.slice(), { status: 200 });
      return new Response(null, { status: 404 });
    }) as typeof fetch);
    const askedFor = (sha: `0x${string}`) => asked.filter((url) => url.endsWith(rawCidV1(sha))).length;
    return { askedFor, release: () => release() };
  }

  it('a stalled logo with a verified cover: the cover is asked in parallel, shows after SLOT_WAIT_MS, and yields to the logo once it verifies', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const gateway = stalledLogo();
    const { container } = render(
      <>
        <BoxCover record={chainBox()} slot="square" className="square" />
        <BoxCover record={chainBox()} small className="card" />
      </>,
    );
    // The card (cover first) shows the cover: it verified while the logo is still being asked.
    await until(() => expect(slotOf(container, 'card')?.dataset.picture).toBe('cover'));
    expect(gateway.askedFor(logo.sha)).toBe(1);
    expect(gateway.askedFor(cover.sha)).toBe(1);
    // Before the wait is over, the square slot waits for its logo: the cover does not flash in first.
    expect(slotOf(container, 'square')?.dataset.art).toBe('plain');
    act(() => { vi.advanceTimersByTime(SLOT_WAIT_MS - 1); });
    expect(slotOf(container, 'square')?.dataset.art).toBe('plain');
    act(() => { vi.advanceTimersByTime(1); });
    await until(() => expect(slotOf(container, 'square')?.dataset.picture).toBe('cover'));
    expect(slotOf(container, 'square')?.dataset.fit).toBe('contain');
    // The logo verifies late: it takes its slot back.
    await act(async () => { gateway.release(); });
    await until(() => expect(slotOf(container, 'square')?.dataset.picture).toBe('logo'));
    expect(gateway.askedFor(logo.sha)).toBe(1);
    expect(gateway.askedFor(cover.sha)).toBe(1);
  });

  it('the coin asks for the cover in parallel too, and shows it once its wait is over', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const gateway = stalledLogo();
    const { container } = render(<TokenMark record={chainBox()} size={40} />);
    await until(() => expect(gateway.askedFor(cover.sha)).toBe(1));
    expect(gateway.askedFor(logo.sha)).toBe(1);
    expect(container.querySelector('img')).toBeNull();
    act(() => { vi.advanceTimersByTime(SLOT_WAIT_MS); });
    await until(() => expect(container.querySelector('img.sh-box-coin--cover')).not.toBeNull());
  });

  it('a withheld logo is the tile, before and after the wait, never the verified cover; the logo is never asked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const listed = createHash('sha256').update(`sh-withheld-v1:ipfs:${rawCidV1(logo.sha)}`).digest('hex');
    resetWithheldForTests({ origin: 'https://api.example.test', fetcher: (async () => Response.json({ version: 1, hashes: [listed] })) as unknown as typeof fetch });
    const gateway = stalledLogo();
    const { container } = render(
      <>
        <BoxCover record={chainBox()} slot="square" className="square" />
        <BoxCover record={chainBox()} small className="card" />
      </>,
    );
    await until(() => expect(slotOf(container, 'card')?.dataset.picture).toBe('cover'));
    await until(() => expect(slotOf(container, 'square')?.dataset.art).toBe('withheld'));
    act(() => { vi.advanceTimersByTime(SLOT_WAIT_MS * 3); });
    expect(slotOf(container, 'square')?.dataset.art).toBe('withheld');
    expect(slotOf(container, 'square')?.querySelector('img')).toBeNull();
    expect(gateway.askedFor(logo.sha)).toBe(0);
  });
});

/**
 * Fix round af2 (review M1, L1, M2). M1: bytes that hash to the commitment and start like a PNG can still fail to
 * decode; such a picture counts as missing, so the verified other picture or the placeholder shows, never a broken
 * image, also when it arrives after the other picture took the slot. L1: each wait gets its own SLOT_WAIT_MS. M2: the
 * Launch flow's icon shows the round mark beside the square frame.
 */
describe('fix round af2: an undecodable picture is missing; each wait is its own', () => {
  const GATEWAY = 'http://127.0.0.1:5421';
  const logo = pngBytes(3);
  const cover = pngBytes(4);
  /** The data URL the page makes from verified bytes in a test DOM (box-pictures.ts urlOf). */
  const urlOf = (bytes: Uint8Array) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
  const chainBox = () => ({ ...specRecord(null, null), spec: null, pictures: picturesOf(logo.sha, cover.sha, [GATEWAY]) }) as BoxRecord;
  const slotOf = (container: HTMLElement, name: string) => container.querySelector<HTMLElement>(`.sh-box-cover.${name}`);
  const sources = (container: HTMLElement) => Array.from(container.querySelectorAll('img'), (img) => img.getAttribute('src'));

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    resetPicturesForTests();
    resetWithheldForTests();
  });

  /** A decoder double: refuses the URLs of `broken` (as a browser refuses a file it cannot draw), records every ask. */
  function decoder(...broken: Uint8Array[]) {
    const refused = new Set(broken.map(urlOf));
    const asked: string[] = [];
    const decode = async (url: string) => {
      asked.push(url);
      return !refused.has(url);
    };
    return { decode, asked };
  }

  /** Our node, a double: each picture's bytes at once, or the logo held until `release`. */
  function node({ holdLogo = false } = {}) {
    let release: () => void = () => undefined;
    const held = new Promise<Response>((resolve) => { release = () => resolve(new Response(logo.bytes.slice(), { status: 200 })); });
    return {
      fetcher: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/ipfs/${rawCidV1(logo.sha)}`)) return holdLogo ? held : new Response(logo.bytes.slice(), { status: 200 });
        if (url.endsWith(`/ipfs/${rawCidV1(cover.sha)}`)) return new Response(cover.bytes.slice(), { status: 200 });
        return new Response(null, { status: 404 });
      }) as typeof fetch,
      release: () => release(),
    };
  }

  it('M1: a committed logo that does not decode counts as missing: the square slot and the coin show the verified cover at once, never the logo', async () => {
    const decode = decoder(logo.bytes);
    resetPicturesForTests(node().fetcher, decode.decode);
    const { container } = render(
      <>
        <BoxCover record={chainBox()} slot="square" className="square" />
        <TokenMark record={chainBox()} size={40} />
        <BoxCover record={chainBox()} small className="card" />
      </>,
    );
    await until(() => expect(slotOf(container, 'square')?.dataset.picture).toBe('cover'));
    await until(() => expect(container.querySelector('img.sh-box-coin--cover')?.getAttribute('src')).toBe(urlOf(cover.bytes)));
    expect(slotOf(container, 'square')?.querySelector('img')?.getAttribute('src')).toBe(urlOf(cover.bytes));
    expect(slotOf(container, 'card')?.dataset.picture).toBe('cover');
    // The logo was fetched, verified and refused by the decoder; no <img> on the page ever names it.
    expect(decode.asked).toContain(urlOf(logo.bytes));
    expect(sources(container)).not.toContain(urlOf(logo.bytes));
  });

  it('M1: an undecodable logo that arrives after the cover took the slot leaves the cover there', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const decode = decoder(logo.bytes);
    const gateway = node({ holdLogo: true });
    resetPicturesForTests(gateway.fetcher, decode.decode);
    const { container } = render(<BoxCover record={chainBox()} slot="square" className="square" />);
    await until(() => expect(decode.asked).toContain(urlOf(cover.bytes)));
    expect(slotOf(container, 'square')?.dataset.art).toBe('plain');
    act(() => { vi.advanceTimersByTime(SLOT_WAIT_MS); });
    await until(() => expect(slotOf(container, 'square')?.dataset.picture).toBe('cover'));
    await act(async () => { gateway.release(); });
    await until(() => expect(decode.asked).toContain(urlOf(logo.bytes)));
    for (let turn = 0; turn < 20; turn += 1) await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
    expect(slotOf(container, 'square')?.dataset.picture).toBe('cover');
    expect(sources(container)).toEqual([urlOf(cover.bytes)]);
  });

  it('M1: neither picture decodes: the placeholder, no <img> of either', async () => {
    const decode = decoder(logo.bytes, cover.bytes);
    resetPicturesForTests(node().fetcher, decode.decode);
    const { container } = render(
      <>
        <BoxCover record={chainBox()} slot="square" className="square" />
        <BoxCover record={chainBox()} small className="card" />
        <TokenMark record={chainBox()} size={16} />
      </>,
    );
    await until(() => expect(decode.asked).toEqual(expect.arrayContaining([urlOf(logo.bytes), urlOf(cover.bytes)])));
    await until(() => expect(slotOf(container, 'square')?.dataset.art).toBe('plain'));
    expect(slotOf(container, 'card')?.dataset.art).toBe('plain');
    expect(container.querySelector('.sh-box-coin')?.getAttribute('data-letter')).toBe('R');
    expect(sources(container)).toEqual([]);
  });

  it('M1: a decoder that throws counts as no', async () => {
    resetPicturesForTests(node().fetcher, async (url) => {
      if (url === urlOf(logo.bytes)) throw new Error('EncodingError');
      return true;
    });
    const { container } = render(<BoxCover record={chainBox()} slot="square" className="square" />);
    await until(() => expect(slotOf(container, 'square')?.dataset.picture).toBe('cover'));
  });

  it('L1: pending, late, shown, withheld, then pending again: the new lookup waits its own SLOT_WAIT_MS before the cover shows', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const listedLogo = createHash('sha256').update(`sh-withheld-v1:ipfs:${rawCidV1(logo.sha)}`).digest('hex');
    let listed: string[] = [];
    resetWithheldForTests({ origin: 'https://api.example.test', fetcher: (async () => Response.json({ version: 1, hashes: listed })) as unknown as typeof fetch });
    let holds = 0;
    let release: () => void = () => undefined;
    resetPicturesForTests((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/ipfs/${rawCidV1(cover.sha)}`)) return new Response(cover.bytes.slice(), { status: 200 });
      if (!url.endsWith(`/ipfs/${rawCidV1(logo.sha)}`)) return new Response(null, { status: 404 });
      holds += 1;
      return new Promise<Response>((resolve) => { release = () => resolve(new Response(logo.bytes.slice(), { status: 200 })); });
    }) as typeof fetch);
    const { container } = render(<BoxCover record={chainBox()} slot="square" className="square" />);
    const square = () => slotOf(container, 'square');
    // 1. Pending; the wait runs out; the cover shows meanwhile.
    await until(() => expect(holds).toBe(1));
    act(() => { vi.advanceTimersByTime(SLOT_WAIT_MS); });
    await until(() => expect(square()?.dataset.picture).toBe('cover'));
    // 2. The logo verifies: shown.
    await act(async () => { release(); });
    await until(() => expect(square()?.dataset.picture).toBe('logo'));
    // 3. Our list names it: the tile.
    listed = [listedLogo];
    act(() => { vi.advanceTimersByTime(REFRESH_MS); });
    await until(() => expect(square()?.dataset.art).toBe('withheld'));
    // 4. Off the list again: asked again, pending; the old expiry does not count, so the slot waits on the plain tile.
    listed = [];
    act(() => { vi.advanceTimersByTime(REFRESH_MS); });
    await until(() => expect(holds).toBe(2));
    await until(() => expect(square()?.dataset.art).toBe('plain'));
    act(() => { vi.advanceTimersByTime(SLOT_WAIT_MS - 1); });
    for (let turn = 0; turn < 10; turn += 1) await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
    expect(square()?.dataset.art).toBe('plain');
    act(() => { vi.advanceTimersByTime(1); });
    await until(() => expect(square()?.dataset.picture).toBe('cover'));
    // And the logo still wins once this lookup verifies.
    await act(async () => { release(); });
    await until(() => expect(square()?.dataset.picture).toBe('logo'));
  });

  it('L1: a slot that moves to another box waits its own SLOT_WAIT_MS for that box’s logo', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const other = { logo: pngBytes(5), cover: pngBytes(6) };
    resetPicturesForTests((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/ipfs/${rawCidV1(cover.sha)}`)) return new Response(cover.bytes.slice(), { status: 200 });
      if (url.endsWith(`/ipfs/${rawCidV1(other.cover.sha)}`)) return new Response(other.cover.bytes.slice(), { status: 200 });
      return new Promise<Response>(() => undefined);
    }) as typeof fetch);
    const otherBox = { ...chainBox(), id: 'demo:y', pictures: picturesOf(other.logo.sha, other.cover.sha, [GATEWAY]) } as BoxRecord;
    const { container, rerender } = render(<BoxCover record={chainBox()} slot="square" className="square" />);
    act(() => { vi.advanceTimersByTime(SLOT_WAIT_MS); });
    await until(() => expect(slotOf(container, 'square')?.querySelector('img')?.getAttribute('src')).toBe(urlOf(cover.bytes)));
    rerender(<BoxCover record={otherBox} slot="square" className="square" />);
    await until(() => expect(slotOf(container, 'square')?.dataset.art).toBe('plain'));
    act(() => { vi.advanceTimersByTime(SLOT_WAIT_MS - 1); });
    for (let turn = 0; turn < 10; turn += 1) await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
    expect(slotOf(container, 'square')?.dataset.art).toBe('plain');
    expect(sources(container)).toEqual([]);
    act(() => { vi.advanceTimersByTime(1); });
    await until(() => expect(slotOf(container, 'square')?.querySelector('img')?.getAttribute('src')).toBe(urlOf(other.cover.bytes)));
  });

  it('M2: the Launch flow’s icon shows the round mark beside the square frame, the same upload; the card shows none', () => {
    const { container, rerender } = render(<PictureSlots logo={LOGO} cover={COVER} />);
    const icon = container.querySelector<HTMLElement>('.sh-newbox-slot[data-slot="square"]');
    const frame = icon?.querySelector<HTMLElement>('.sh-box-cover');
    const coin = icon?.querySelector<HTMLImageElement>('img.sh-box-coin');
    expect(frame?.dataset).toMatchObject({ picture: 'logo', fit: 'contain' });
    expect(coin?.getAttribute('src')).toBe(LOGO);
    expect(coin?.classList.contains('sh-box-coin--logo')).toBe(true);
    expect(coin?.classList.contains('sh-box-coin--cover')).toBe(false);
    expect(coin?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.textContent).toBe('Icon · logo');
    expect(container.querySelector('.sh-newbox-slot[data-slot="card"] img.sh-box-coin')).toBeNull();
    // Only a cover picked: the icon's frame and its round mark show the cover, the mark as a rounded square (whole).
    rerender(<PictureSlots logo={null} cover={COVER} />);
    const standIn = container.querySelector<HTMLImageElement>('.sh-newbox-slot[data-slot="square"] img.sh-box-coin');
    expect(standIn?.getAttribute('src')).toBe(COVER);
    expect(standIn?.classList.contains('sh-box-coin--cover')).toBe(true);
  });
});
