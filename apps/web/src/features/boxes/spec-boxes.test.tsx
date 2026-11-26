/**
 * Boxes built from a BoxSpec (launch pipeline v1 § 3.9; box creation flow § 6): one function, `recordFromSpec`, turns a
 * spec into the record the feed, the box page and the wallet box read, so the creation page's Demo boxes and, later,
 * the factory's need no per-box code. The two demo third-party fixtures of packages/box-spec prove it; the Demo store
 * keeps created boxes as encoded specs and trusts nothing it reads back.
 */
import {
  AddOnId,
  CONTEXT_V2,
  CapExcess,
  DEMO_OPEN_ART,
  DEMO_OPEN_ART_SPEC_HASH,
  DEMO_PLACEHOLDERS,
  DEMO_PLACEHOLDERS_SPEC_HASH,
  DEMO_TOKEN_ONLY,
  DEMO_TOKEN_ONLY_SPEC_HASH,
  QStream,
  Reason,
  TStream,
  encodeBoxSpecV1,
  encodeCollectionMetadataParams,
  encodeCreatorFeeCapParams,
  specHash,
  validateBoxSpecV1,
} from '@squarehole/box-spec';
import { DEMO_CHAIN_ID } from '@squarehole/domain';
import { act, cleanup, fireEvent, screen, within, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush, renderM3 } from '../../test-support/m3';
import { RevealedItems } from './ChainItems';
import { DEMO_BOX0_ROW } from '../core/demo-row';
import { recordFromRow } from '../core/row-record';
import { rawCid } from '@squarehole/indexer/client';
import { boxPath } from './box-id';
import { demoSummary } from './box-figure';
import { addCreatedBox, createdBoxEntries, createdBoxRecords, demoBoxIdFor, resetCreatedBoxesForTests, type RightsRecord } from './created-boxes';
import { collectionContract } from './collection-contract';
import { bpsText, decodeMetadataTable, demoTokenFor, recordFromSpec, setupLine } from './spec-record';
import { demoWalletBox } from './wallet-box';

await Promise.all([import('../../pages/BoxFeedPage'), import('../../pages/BoxPage'), import('../../pages/WalletBoxPage')]);

const KEY = 'sh.boxes.sample-created.v1';
const OWNER_B = '0xDe00000000000000000000000000000000000B22' as const;
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const COVER = 'data:image/png;base64,iVBORw0KGgo=';
const BANNER_URL = 'data:image/png;base64,QkFOTkVS';
const TEASER_URL = 'data:image/png;base64,VEVBU0VS';
/** About's Set-up row: only the fixed shares (each side, the cap and the royalty have their own rows). */
const FIXED_SETUP = 'Of each 1% fee: 3/15 burns FIT · 2/15 into this box’s pool';
const meta = (overrides: Partial<Parameters<typeof recordFromSpec>[2]> = {}) => ({
  chainId: DEMO_CHAIN_ID,
  networkLabel: 'Local chain 31337',
  token: demoTokenFor(DEMO_PLACEHOLDERS_SPEC_HASH),
  demo: true,
  order: 100,
  coverUrl: COVER,
  thumbs: [],
  createdAtMs: NOW,
  nowMs: NOW,
  ...overrides,
});

beforeEach(() => {
  window.sessionStorage.clear();
  resetCreatedBoxesForTests();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetCreatedBoxesForTests();
});

describe('recordFromSpec: the record a spec makes', () => {
  it('open art (ALL_TO_FIT + BURN_T, royalty 1% into the pool)', () => {
    const record = recordFromSpec(DEMO_OPEN_ART, DEMO_OPEN_ART_SPEC_HASH, meta({ token: demoTokenFor(DEMO_OPEN_ART_SPEC_HASH), thumbs: [COVER] }));
    expect(record).toMatchObject({ name: 'Demo Open Box', ticker: 'DEMOO', kind: 'new', pairAsset: 'ETH', itemCount: 10_000n, demo: true, demoState: 'upcoming', claims: 'none', art: null, market: null });
    expect(record.id).toBe(demoBoxIdFor(DEMO_OPEN_ART_SPEC_HASH));
    expect(record.spec).toMatchObject({
      buyers: { kind: 'burn', token: 'FIT', converts: null },
      sellers: { kind: 'burn', token: 'T', converts: null },
      capRaw: 0n,
      royaltyBps: 100,
      royaltyTo: 'pool',
      artMode: 'open',
      firstInRaw: 0n,
      firstTokensBps: 0n,
      sealedUrl: null,
      deadlineDays: 90,
      // F74 U5: the one raise every box has.
      raiseRaw: 4_206_980_085n * 10n ** 9n,
      bannerUrl: null,
      teaserCount: 0,
      externalLink: null,
    });
    expect(record.spec?.traitTypes).toEqual([{ name: 'Colour', values: 3 }]);
    // F74 U5: the target with every digit, as box 0's is stated.
    // The fixtures open Now (openAt 0): the block after the creation, about 12 s.
    expect(record.demoFigures).toMatchObject({ opensIn: '<1 min', target: '4.206980085', deadlineDays: 90 });
    expect(record.spec).toMatchObject({ royaltyBps: 100, royaltyTo: 'pool' });
    expect(record.setup).toBe(FIXED_SETUP);
    expect(demoSummary(record).figure.text).toBe('Opens in <1 min');
  });

  it('opens at its clock time (openAt, UTC seconds): counted from the clock, a time the creation reached opens next block', () => {
    const at = (openAt: number, nowMs = NOW) => {
      const spec = { ...DEMO_OPEN_ART, openAt };
      return recordFromSpec(spec, specHash(spec), meta({ nowMs })).demoFigures?.opensIn;
    };
    expect(at(NOW / 1000 + 3_600)).toBe('~1 h');
    expect(at(NOW / 1000 + 3_600, NOW + 1_800_000)).toBe('~30 min');
    expect(at(NOW / 1000 + 86_400)).toBe('~24 h');
    expect(at(NOW / 1000 - 60)).toBe('<1 min');
    expect(at(NOW / 1000 + 3_600, NOW + 3_600_000)).toBe('<1 min');
  });

  it('hidden art with the creator option, a creator buy and a special series', () => {
    const record = recordFromSpec(DEMO_PLACEHOLDERS, DEMO_PLACEHOLDERS_SPEC_HASH, meta());
    expect(record.spec).toMatchObject({ buyers: { kind: 'creator', token: 'Q' }, sellers: { kind: 'creator', token: 'T' }, artMode: 'hidden', firstInRaw: 10n ** 17n, specials: [{ label: 'Demo rares', count: 3n }], owner: DEMO_PLACEHOLDERS.marketplaceOwner, creator: DEMO_PLACEHOLDERS.marketplaceOwner });
    expect(record.spec?.sealedUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    // 0.1 ETH on the one 4.206980085 ETH target: about 6.7% of the token (an estimate from the curve).
    expect(record.spec?.firstTokensBps).toBeGreaterThan(600n);
    expect(record.spec?.firstTokensBps).toBeLessThan(750n);
    expect(record.setup).toBe(FIXED_SETUP);
    expect(setupLine()).toBe(FIXED_SETUP);
    expect(record.line).toBe('Demo only, not a real collection: a third-party box with placeholders.');
  });

  it('a sample box past its open time says it is not trading, never a countdown below zero', () => {
    const later = recordFromSpec(DEMO_PLACEHOLDERS, DEMO_PLACEHOLDERS_SPEC_HASH, meta({ nowMs: NOW + 2 * 3_600_000 }));
    expect(demoSummary(later).figure.text).toBe('Not trading');
  });

  it('a token-only box (F70 "Nothing"): the same record with no items, its sides, the cap and no collection', () => {
    const record = recordFromSpec(DEMO_TOKEN_ONLY, DEMO_TOKEN_ONLY_SPEC_HASH, meta({ token: demoTokenFor(DEMO_TOKEN_ONLY_SPEC_HASH), thumbs: [COVER], bannerUrl: COVER, teaserUrls: [COVER] }));
    expect(record).toMatchObject({ kind: 'token', name: 'Demo Plain Token', ticker: 'DEMOT', itemCount: 0n, demoState: 'upcoming', claims: 'none' });
    expect(record.spec).toMatchObject({
      artMode: 'none',
      buyers: { kind: 'creator', token: 'Q', converts: null },
      sellers: { kind: 'burn', token: 'T', converts: null },
      // F74 U2: a fixed 1 ETH per 30 days.
      capRaw: 10n ** 18n,
      capExcess: 'burn',
      owner: '0x0000000000000000000000000000000000000000',
      creator: DEMO_TOKEN_ONLY.creatorFeeRecipient,
      // No collection: no item pictures, no banner, no teasers, whatever the meta holds.
      thumbs: [],
      bannerUrl: null,
      teaserUrls: [],
    });
    expect(record.setup).toBe(FIXED_SETUP);
    // A plain token launch, said positively where there is no description.
    expect(recordFromSpec({ ...DEMO_TOKEN_ONLY, description: '' }, DEMO_TOKEN_ONLY_SPEC_HASH, meta()).line).toBe('A plain token launch.');
    expect(collectionContract(record)).toMatchObject({ label: 'Collection', address: null, note: 'None: a token box' });
  });

  it('a sell is said in words; the collection page’s banner, teasers and link come from add-on 6 and the site record', () => {
    const banner = `0x${'ab'.repeat(32)}` as const;
    const page = { id: AddOnId.CollectionMetadata, params: encodeCollectionMetadataParams({ bannerSha256: banner, teaserSha256s: [banner, banner], externalLink: 'https://hidden.example' }) };
    const spec = { ...DEMO_PLACEHOLDERS, tStream: TStream.CREATOR_IN_Q, addOns: [...DEMO_PLACEHOLDERS.addOns, page] };
    expect(validateBoxSpecV1(spec, CONTEXT_V2).reason).toBe(0);
    const record = recordFromSpec(spec, specHash(spec), meta({ bannerUrl: COVER, teaserUrls: [COVER, COVER, COVER], links: { website: 'https://hidden.example', x: '', telegram: '' } }));
    expect(record.spec).toMatchObject({ sellers: { kind: 'creator', token: 'Q', converts: 'sells' }, bannerUrl: COVER, teaserCount: 2, externalLink: 'https://hidden.example', links: { website: 'https://hidden.example' } });
    // Only as many teaser pictures as the spec names.
    expect(record.spec?.teaserUrls).toHaveLength(2);
    // The sell is flagged where the side is shown (About's Sellers’ fees row); Set-up never repeats a side.
    expect(record.setup).toBe(FIXED_SETUP);
    expect(collectionContract(record)).toMatchObject({ address: null, note: 'Address at creation', explorer: { href: null, reason: 'No address yet' }, marketplace: { href: null, reason: 'No marketplace on a local chain' } });
  });

  it('helpers: table decoding, short percentages, deterministic fake token addresses', () => {
    expect(decodeMetadataTable(DEMO_OPEN_ART.metadataTable)?.traitTypes).toEqual([{ name: 'Colour', values: ['Red', 'Green', 'Blue'] }]);
    expect(decodeMetadataTable('0x02')).toBeNull();
    expect(decodeMetadataTable('0x010005')).toBeNull();
    expect([bpsText(1_322n), bpsText(349n), bpsText(250n), bpsText(100n)]).toEqual(['13%', '3.4%', '2.5%', '1%']);
    expect(demoTokenFor(DEMO_OPEN_ART_SPEC_HASH)).toMatch(/^0xde00c[0-9a-f]{35}$/);
    expect(demoTokenFor(DEMO_OPEN_ART_SPEC_HASH)).toBe(demoTokenFor(DEMO_OPEN_ART_SPEC_HASH));
    expect(demoTokenFor(DEMO_OPEN_ART_SPEC_HASH)).not.toBe(demoTokenFor(DEMO_PLACEHOLDERS_SPEC_HASH));
  });
});

describe('F74 in the box record', () => {
  it('U3: a collection keeps its own cover beside the logo; a token-only box has none, whatever the meta holds', () => {
    const collection = recordFromSpec(DEMO_OPEN_ART, DEMO_OPEN_ART_SPEC_HASH, meta({ collectionCoverUrl: BANNER_URL }));
    expect(collection.spec).toMatchObject({ coverUrl: COVER, collectionCoverUrl: BANNER_URL });
    const token = recordFromSpec(DEMO_TOKEN_ONLY, DEMO_TOKEN_ONLY_SPEC_HASH, meta({ collectionCoverUrl: BANNER_URL }));
    expect(token.spec?.collectionCoverUrl).toBeNull();
    addCreatedBox(DEMO_OPEN_ART, { createdAtMs: NOW, coverUrl: COVER, collectionCoverUrl: BANNER_URL, thumbs: [] });
    addCreatedBox(DEMO_TOKEN_ONLY, { createdAtMs: NOW, coverUrl: COVER, collectionCoverUrl: BANNER_URL, thumbs: [] });
    resetCreatedBoxesForTests();
    expect(createdBoxEntries().map((entry) => entry.collectionCoverUrl)).toEqual([BANNER_URL, null]);
    expect(createdBoxRecords(createdBoxEntries(), NOW)[0]?.spec?.collectionCoverUrl).toBe(BANNER_URL);
  });

  it('U1: the Demo store takes holder payouts (Demo rules); the record says holders claim, each side and the cap excess carry the note', () => {
    const cap = { id: AddOnId.CreatorFeeCap, params: encodeCreatorFeeCapParams({ capPerEpoch: 4n * 10n ** 18n, excess: CapExcess.HOLDERS }) };
    const spec = { ...DEMO_TOKEN_ONLY, qStream: QStream.HOLDERS_IN_T, tStream: TStream.TO_CREATOR, addOns: [cap] };
    expect(validateBoxSpecV1(spec, CONTEXT_V2).reason).toBe(Reason.NOT_OFFERED);
    expect(validateBoxSpecV1(spec, CONTEXT_V2, 'demo').reason).toBe(Reason.OK);
    expect(addCreatedBox(spec, { createdAtMs: NOW, coverUrl: null, thumbs: [] }).status).toBe('created');
    resetCreatedBoxesForTests();
    const [record] = createdBoxRecords(createdBoxEntries(), NOW);
    expect(record?.claims).toBe('holders');
    expect(record?.spec).toMatchObject({ buyers: { kind: 'holders', token: 'T', converts: 'buys', pending: 'Pending legal review' }, sellers: { kind: 'creator', pending: null }, capRaw: 4n * 10n ** 18n, capExcess: 'holders' });
  });
});

describe('the Demo store of created boxes', () => {
  it('adds a validated spec once; the same spec again is a duplicate of the same box', () => {
    expect(addCreatedBox(DEMO_OPEN_ART, { createdAtMs: NOW, coverUrl: COVER, thumbs: [] })).toMatchObject({ status: 'created', id: demoBoxIdFor(DEMO_OPEN_ART_SPEC_HASH) });
    expect(addCreatedBox(DEMO_OPEN_ART, { createdAtMs: NOW + 1, coverUrl: null, thumbs: [] }).status).toBe('duplicate');
    expect(createdBoxEntries()).toHaveLength(1);
    expect(() => addCreatedBox({ ...DEMO_OPEN_ART, n: 3 }, { createdAtMs: NOW, coverUrl: null, thumbs: [] })).toThrow(/does not validate/);
    // Only small image data URLs are kept as pictures.
    addCreatedBox(DEMO_PLACEHOLDERS, { createdAtMs: NOW, coverUrl: 'javascript:alert(1)', thumbs: ['data:image/svg+xml;base64,PHN2Zz4=', COVER] });
    expect(createdBoxEntries()[1]).toMatchObject({ coverUrl: null, thumbs: [COVER] });
  });

  it('a reload keeps them (sessionStorage), decoded and validated again', () => {
    addCreatedBox(DEMO_OPEN_ART, { createdAtMs: NOW, coverUrl: COVER, thumbs: [] });
    addCreatedBox(DEMO_PLACEHOLDERS, { createdAtMs: NOW + 1, coverUrl: null, thumbs: [] });
    resetCreatedBoxesForTests();
    const entries = createdBoxEntries();
    expect(entries.map((entry) => entry.specHash)).toEqual([DEMO_OPEN_ART_SPEC_HASH, DEMO_PLACEHOLDERS_SPEC_HASH]);
    expect(validateBoxSpecV1(entries[0]?.spec ?? DEMO_OPEN_ART, CONTEXT_V2).reason).toBe(0);
    // Newest first in the feed's "New" order.
    expect(createdBoxRecords(entries, NOW).map((record) => record.order)).toEqual([100, 101]);
  });

  it('drops whatever in storage is not a valid created box', () => {
    const good = { encoded: encodeBoxSpecV1(DEMO_OPEN_ART), createdAtMs: NOW, coverUrl: null, thumbs: [] };
    const invalidSpec = { ...good, encoded: encodeBoxSpecV1({ ...DEMO_PLACEHOLDERS, deadlineDays: 45 }) };
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify([
        good,
        invalidSpec,
        { ...good, encoded: '0xzz' },
        { ...good, coverUrl: 'data:image/svg+xml;base64,PHN2Zz4=' },
        { ...good, createdAtMs: -1 },
        { ...good, thumbs: 'nope' },
        good,
        '__proto__',
        null,
      ]),
    );
    resetCreatedBoxesForTests();
    expect(createdBoxEntries().map((entry) => entry.specHash)).toEqual([specHash(DEMO_OPEN_ART)]);
    window.sessionStorage.setItem(KEY, '{not json');
    resetCreatedBoxesForTests();
    expect(createdBoxEntries()).toEqual([]);
  });

  it('keeps the site record (§ 4): links, the rights confirmation for this spec, the banner and up to 4 teasers', () => {
    const rights: RightsRecord = { specHash: DEMO_TOKEN_ONLY_SPEC_HASH, creator: OWNER_B, statement: 'rights-statement-draft-1', confirmedAt: '2026-10-03T12:00:00.000Z' };
    addCreatedBox(DEMO_TOKEN_ONLY, { createdAtMs: NOW, coverUrl: COVER, thumbs: [], links: { website: 'https://plain.example', x: '@plain', telegram: 'https://evil.example' }, rights });
    addCreatedBox(DEMO_OPEN_ART, { createdAtMs: NOW, coverUrl: COVER, thumbs: [], bannerUrl: COVER, teaserUrls: [COVER, COVER, COVER, COVER, COVER], rights: { ...rights, specHash: DEMO_PLACEHOLDERS_SPEC_HASH } });
    resetCreatedBoxesForTests();
    const [plain, open] = createdBoxEntries();
    expect(plain).toMatchObject({ links: { website: 'https://plain.example', x: '@plain', telegram: '' }, rights });
    // A rights record for another spec is not this box's; at most 4 teasers.
    expect(open).toMatchObject({ bannerUrl: COVER, rights: null });
    expect(open?.teaserUrls).toHaveLength(4);
    const records = createdBoxRecords(createdBoxEntries(), NOW);
    // The token box names no owner in its spec: its creator comes from the rights record.
    expect(records[0]?.spec?.creator).toBe(OWNER_B);
    expect(demoWalletBox(OWNER_B, records).created.map((record) => record.name)).toEqual(['Demo Plain Token']);
  });

  it('keeps working in memory when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    resetCreatedBoxesForTests();
    expect(addCreatedBox(DEMO_OPEN_ART, { createdAtMs: NOW, coverUrl: null, thumbs: [] }).status).toBe('created');
    expect(createdBoxEntries()).toHaveLength(1);
  });
});

describe('the two box-spec fixtures on the card, the box page and the wallet box (no per-box code)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    addCreatedBox(DEMO_OPEN_ART, { createdAtMs: Date.now(), coverUrl: COVER, thumbs: [COVER] });
    addCreatedBox(DEMO_PLACEHOLDERS, { createdAtMs: Date.now(), coverUrl: COVER, thumbs: [] });
  });

  it('the feed lists both next to the sample boxes, newest first, with no Demo label (F130)', async () => {
    renderM3('/');
    await flush(8);
    expect(screen.getByText('8 boxes')).toBeTruthy();
    const names = screen.getAllByRole('link').map((link) => link.getAttribute('aria-label') ?? '').filter((label) => label.startsWith('Demo '));
    expect(names[0]).toMatch(/^Demo Hidden Box, DEMOH, New collection, Upcoming, Opens in <1 min, 69 items, Local chain 31337$/);
    expect(names[1]).toMatch(/^Demo Open Box, DEMOO, New collection, Upcoming, Opens in <1 min, 10,000 items, Local chain 31337$/);
    // The creator's cover through <img>, never inlined.
    expect(document.querySelectorAll(`img[src="${COVER}"]`).length).toBeGreaterThan(0);
  });

  it('the box page: the one template with the spec’s numbers, the creator buy shown (BC-117)', async () => {
    renderM3(boxPath(demoBoxIdFor(DEMO_PLACEHOLDERS_SPEC_HASH)));
    await flush(8);
    expect(screen.getByRole('heading', { level: 1, name: 'Demo Hidden Box' })).toBeTruthy();
    const head = document.querySelector('header.sh-box-head') as HTMLElement;
    expect([...head.querySelectorAll('.sh-box-stat dt')].map((dt) => dt.textContent)).toEqual(['Items', 'Target', 'Deadline', 'Creator']);
    // F74 U5: the one raise, exactly.
    expect(within(head).getByText('4.206980085')).toBeTruthy();
    expect(within(head).getByText('0.1')).toBeTruthy();
    expect(within(head).getByText(/^ETH at start · ≈ \d+(\.\d)?% of DEMOH$/)).toBeTruthy();
    expect(head.querySelector('.sh-box-peekstrip img')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(head.querySelector('svg script, foreignObject')).toBeNull();
  });

  it('the wallet box of the creator: Created lists the box, the creator buy is a token holding', async () => {
    const owner = DEMO_PLACEHOLDERS.marketplaceOwner;
    const wallet = demoWalletBox(owner, createdBoxRecords(createdBoxEntries(), Date.now()));
    expect(wallet.created.map((record) => record.name)).toEqual(['Demo Hidden Box']);
    expect(wallet.holdings.map((holding) => [holding.record.name, holding.tokenRaw !== null && holding.tokenRaw > 0n])).toEqual([['Demo Hidden Box', true]]);
    renderM3(`/wallet/${owner.toLowerCase()}`);
    await flush(8);
    const created = screen.getByRole('region', { name: 'Created' });
    expect(within(created).getByRole('link', { name: /^Demo Hidden Box, DEMOH, 69 items$/ }).getAttribute('href')).toBe(boxPath(demoBoxIdFor(DEMO_PLACEHOLDERS_SPEC_HASH)));
    expect(screen.getByRole('region', { name: 'Demo Hidden Box' }).textContent).toContain('DEMOH');
  });
});

describe('v2 boxes on the card, the box page and the wallet box: a plain token, and hidden art with a banner and teasers', () => {
  const banner = `0x${'ab'.repeat(32)}` as const;
  const page = { id: AddOnId.CollectionMetadata, params: encodeCollectionMetadataParams({ bannerSha256: banner, teaserSha256s: [banner, banner], externalLink: '' }) };
  const teased = { ...DEMO_PLACEHOLDERS, tStream: TStream.CREATOR_IN_Q, addOns: [...DEMO_PLACEHOLDERS.addOns, page] };
  const rights = (hash: `0x${string}`): RightsRecord => ({ specHash: hash, creator: OWNER_B, statement: 'rights-statement-draft-1', confirmedAt: '2026-10-03T12:00:00.000Z' });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    addCreatedBox(DEMO_TOKEN_ONLY, { createdAtMs: Date.now(), coverUrl: COVER, thumbs: [], rights: rights(DEMO_TOKEN_ONLY_SPEC_HASH), links: { website: 'https://plain.example', x: '', telegram: '' } });
    addCreatedBox(teased, { createdAtMs: Date.now(), coverUrl: COVER, thumbs: [], bannerUrl: BANNER_URL, teaserUrls: [TEASER_URL, TEASER_URL] });
  });

  it('the feed: the token box says "Token" where others count items; the banner stays on the box page', async () => {
    renderM3('/');
    await flush(8);
    const labels = screen.getAllByRole('link').map((link) => link.getAttribute('aria-label') ?? '');
    expect(labels).toContain('Demo Plain Token, DEMOT, Token, Upcoming, Opens in <1 min, Local chain 31337');
    const card = screen.getByRole('link', { name: /^Demo Plain Token/ });
    expect(card.querySelector('.sh-box-card__meta')?.textContent).toBe('Token');
    const hiddenCard = screen.getByRole('link', { name: /^Demo Hidden Box/ });
    // Every card keeps one cover and body shape, so a grid row lines up (the banner is the box page's).
    expect(hiddenCard.querySelector('.sh-box-card__banner')).toBeNull();
    // The token's mark is the creator's logo.
    expect(card.querySelector('.sh-box-card__ticker img')?.getAttribute('src')).toBe(COVER);
  });

  it('the token box page: Supply first, one "Token" tile, no Owning one row, no Conversion, the fee sides and the cap amount first, no collection, its links', async () => {
    renderM3(`${boxPath(demoBoxIdFor(DEMO_TOKEN_ONLY_SPEC_HASH))}?tab=about`);
    await flush(8);
    const head = document.querySelector('header.sh-box-head') as HTMLElement;
    expect(within(head).getByText('Token', { selector: '.sh-box-kind' })).toBeTruthy();
    expect([...head.querySelectorAll('.sh-box-stat dt')].map((dt) => dt.textContent)).toEqual(['Supply', 'Target', 'Deadline', 'Creator']);
    expect(head.querySelector('.sh-box-peekstrip')?.getAttribute('aria-label')).toMatch(/^Token: DEMOT, no NFTs, no vault/);
    expect(head.querySelector('.sh-box-peekstrip img')?.getAttribute('src')).toBe(COVER);
    expect(head.querySelector('.sh-box-own')).toBeNull();
    expect([...head.querySelectorAll('.sh-box-counters .sh-box-counter__title')].map((title) => title.textContent)).toEqual(['Claims', 'Market']);
    const about = document.querySelector('.sh-box-about') as HTMLElement;
    expect(within(about).getByText('Creator · ETH')).toBeTruthy();
    expect(within(about).getByText('Burn · DEMOT')).toBeTruthy();
    // F74 U2: a fixed amount per 30 days, not a share of the target.
    expect(within(about).getByText('1 ETH / 30 days · above it burned')).toBeTruthy();
    // "In the box", never "Kind" (the creation page's Box kind names the fee sides).
    expect([...about.querySelectorAll('dt')].map((dt) => dt.textContent)).toContain('In the box');
    expect([...about.querySelectorAll('dt')].map((dt) => dt.textContent)).not.toContain('Kind');
    expect(within(about).getByText(FIXED_SETUP)).toBeTruthy();
    expect(within(about).getByText('None: a token box')).toBeTruthy();
    expect(within(about).getByRole('link', { name: 'plain.example' }).getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('the token box opens on its Token tab; What’s in the box? says it is a token box, once', async () => {
    renderM3(boxPath(demoBoxIdFor(DEMO_TOKEN_ONLY_SPEC_HASH)));
    await flush(8);
    expect(screen.getByRole('tab', { name: 'Token' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { level: 3, name: 'Bonding curve' })).toBeTruthy();
    cleanup();
    renderM3(`${boxPath(demoBoxIdFor(DEMO_TOKEN_ONLY_SPEC_HASH))}?tab=contents`);
    await flush(8);
    expect(screen.getByRole('heading', { level: 2, name: 'Token' })).toBeTruthy();
    expect(screen.getByText('Nothing in the box but DEMOT: no NFTs, no vault.')).toBeTruthy();
  });

  it('the hidden box page: the banner across the header, teasers labelled and never counted, the sell flagged, the collection row', async () => {
    renderM3(boxPath(demoBoxIdFor(specHash(teased))));
    await flush(8);
    const head = document.querySelector('header.sh-box-head') as HTMLElement;
    expect(head.querySelector('.sh-box-head__banner img')?.getAttribute('src')).toBe(BANNER_URL);
    expect(head.querySelector('.sh-box-peekstrip')?.getAttribute('aria-label')).toMatch(/^2 teasers, not items; 69 items sealed\. Opens/);
    expect(head.querySelector('.sh-box-peekstrip__text small')?.textContent).toBe('Teasers · not items');
    const teasers = screen.getByRole('heading', { level: 3, name: 'Teasers' }).closest('.sh-box-card-block') as HTMLElement;
    expect(within(teasers).getAllByRole('img').map((img) => img.getAttribute('alt'))).toEqual(['Teaser 1 of 2', 'Teaser 2 of 2']);
    // Teasers come last: after the traits and the sealed count (flow doc § 3.2), so they never lead the tab.
    const blocks = [...document.querySelectorAll('.sh-box-contents > .sh-box-card-block')];
    expect(blocks.indexOf(teasers)).toBe(blocks.length - 1);
    expect(blocks.findIndex((block) => block.classList.contains('sh-box-sealed'))).toBeLessThan(blocks.indexOf(teasers));
    expect(screen.getByRole('heading', { level: 2, name: '69 items, sealed until graduation' })).toBeTruthy();
  });

  it('the hidden box’s About: the sell flag, the collection contract "Address at creation" with why there are no links yet', async () => {
    renderM3(`${boxPath(demoBoxIdFor(specHash(teased)))}?tab=about`);
    await flush(8);
    const about = document.querySelector('.sh-box-about') as HTMLElement;
    expect(within(about).getByText('Sells DEMOH for ETH')).toBeTruthy();
    const row = about.querySelector('.sh-box-collection') as HTMLElement;
    expect(row.textContent).toContain('Address at creation');
    expect(row.textContent).toContain('Explorer · No address yet');
    expect(row.textContent).toContain('Marketplace · No marketplace on a local chain');
  });

  it('the creator’s wallet box lists the token box under Created (by the rights record’s address)', async () => {
    renderM3(`/wallet/${OWNER_B.toLowerCase()}`);
    await flush(8);
    const created = screen.getByRole('region', { name: 'Created' });
    expect(within(created).getByRole('link', { name: 'Demo Plain Token, DEMOT, Token' })).toBeTruthy();
  });
});


describe('MF23-5: revealed item views', () => {
  const record = recordFromRow({ row: DEMO_BOX0_ROW, network: 'local' }, { nowMs: NOW });
  const hash = `0x${'12'.repeat(32)}` as const;
  const item = (revealed: boolean) => ({ schema: 'sh.core-item.v1', chainId: record.chainId, token: record.token, id: '1',
    asOf: { block: '100', hash: `0x${'ab'.repeat(32)}`, timestamp: '1800000000', tier: 'head' },
    revealed, traitsPacked: revealed ? '1' : null, traits: [],
    art: revealed ? { image: { sha256: hash, cid: rawCid(hash) }, avatar: { sha256: hash, cid: rawCid(hash) }, model: { sha256: hash, cid: rawCid(hash) } } : null,
  });
  it('unrevealed items have no image, avatar or model request', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [item(false)], next: null })));
    const { container } = render(<RevealedItems record={record} origin="https://indexer.invalid" fetcher={fetcher} />);
    await waitFor(() => expect(screen.getByText('No revealed items yet.')).toBeTruthy());
    expect(container.querySelector('img, canvas')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('shows the picture, avatar, traits and an explicit 3D control only for a revealed record', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [item(true)], next: null })));
    const { container } = render(<RevealedItems record={record} origin="https://indexer.invalid" fetcher={fetcher} />);
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(2));
    expect(container.querySelector('img')?.getAttribute('src')).toContain('/items/1/art/image');
    expect(screen.getByRole('button', { name: 'View 3D model for #1' })).toBeTruthy();
    expect(screen.getByText('#1')).toBeTruthy();
  });
  it('removes unavailable pictures, retries at the next head, and removes a rolled-back reveal', async () => {
    vi.useFakeTimers();
    try {
    let current = item(true);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [current], next: null })));
    const { container } = render(<RevealedItems record={record} origin="https://indexer.invalid" fetcher={fetcher} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(container.querySelectorAll('img')).toHaveLength(2);
    const refresh = () => act(async () => { await vi.advanceTimersByTimeAsync(12000); });
    fireEvent.error(screen.getByRole('img', { name: 'Item #1' }));
    expect(screen.queryByAltText('Item #1')).toBeNull();
    current = { ...current, asOf: { ...current.asOf, hash: `0x${'cd'.repeat(32)}` } };
    await refresh();
    expect(screen.getByRole('img', { name: 'Item #1' })).toBeTruthy();
    current = item(false);
    await refresh();
    expect(container.querySelector('img, canvas')).toBeNull();
    expect(screen.queryByRole('button', { name: 'View 3D model for #1' })).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});


it('MF23-5: wallet items beyond the first reveal page are fetched by their own ids', async () => {
  const record = recordFromRow({ row: DEMO_BOX0_ROW, network: 'local' }, { nowMs: NOW });
  const fetcher = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({ schema: 'sh.core-item.v1', chainId: record.chainId, token: record.token, id: '100',
    asOf: { block: '100', hash: `0x${'ab'.repeat(32)}`, timestamp: '1800000000', tier: 'head' }, revealed: false, traitsPacked: null, traits: [], art: null })));
  render(<RevealedItems record={record} origin="https://indexer.invalid" ids={['100']} fetcher={fetcher} />);
  await waitFor(() => expect(screen.getByText('No revealed items yet.')).toBeTruthy());
  expect(String(fetcher.mock.calls[0]?.[0])).toMatch(/\/items\/100$/);
});
