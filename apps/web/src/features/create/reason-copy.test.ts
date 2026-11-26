/**
 * Every verdict of § 5 (box creation flow) and every page check: a spec this page could build, changed in one place,
 * goes through the factory's own `validateBoxSpecV1(spec, CONTEXT_V2)`; the verdict must land on its step and control
 * with its message. Anything the page should never build is a "builder bug" with its reason name in Details, each in
 * the table below (v2's new ones included: zeroed collection fields, collection add-ons on a token, a raise other than
 * the version's, F74 U5). Holder payouts (F74 U1) are offered in the Demo and named "Demo only" elsewhere.
 */
import {
  AddOnId,
  BoxType,
  CONTEXT_V2,
  CapExcess,
  QStream,
  RoyaltyDestination,
  TStream,
  encodeCollectionMetadataParams,
  encodeCreatorFeeCapParams,
  encodeEditionSpecialsParams,
  encodePlaceholdersParams,
  encodeRoyaltiesParams,
  validateBoxSpecV1,
  type AddOnV1,
  type BoxSpecV1,
} from '@squarehole/box-spec';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HIDDEN_SVG, ZERO32, buildSpec, chooseOwner, type CreateForm, type StepId } from './create-model';
import { reachableSteps, reviewIssues, stepIssues, stepsToFix } from './create-checks';
import { CONTROL, MESSAGES, dedupe, fieldIssues, finalGate, issueForVerdict, summaryLine } from './reason-copy';
import { NOW, OWNER, PAGE, artOf, formOf, inputOf, pictureOf, tokenFormOf } from './test-support/fixtures';

// F130: the words for a holder payout off on this network say no Demo.
const DEMO_ONLY = 'Not offered here yet, pending legal review';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const base = buildSpec(inputOf());
const hidden = buildSpec(inputOf({ form: formOf({ artMode: 'hidden' }) }));
const token = buildSpec(inputOf({ form: tokenFormOf() }));
const placeholders = (patch: Partial<Parameters<typeof encodePlaceholdersParams>[0]>): AddOnV1 => ({
  id: AddOnId.Placeholders,
  params: encodePlaceholdersParams({ placeholderName: 'Paper Moons ticket', placeholderSymbol: 'MOON-T', placeholderDescription: 'x', hiddenDescription: 'y', hiddenSvg: DEFAULT_HIDDEN_SVG, ...patch }),
});
const special = (count: number, label = 'Gold'): AddOnV1 => ({ id: AddOnId.EditionSpecials, params: encodeEditionSpecialsParams({ label, count }) });
// Core v1 (F72 (3)): no recipient; CREATOR pays creatorFeeRecipient. F74 U2: the cap is a fixed amount per 30 days.
const royalty = (bps: number, destination: number): AddOnV1 => ({ id: AddOnId.Royalties, params: encodeRoyaltiesParams({ bps, destination }) });
const ETH = 10n ** 18n;
const cap = (capPerEpoch: bigint, excess: number = CapExcess.BURN): AddOnV1 => ({ id: AddOnId.CreatorFeeCap, params: encodeCreatorFeeCapParams({ capPerEpoch, excess }) });
const pageAddOn = (patch: Partial<Parameters<typeof encodeCollectionMetadataParams>[0]>): AddOnV1 => ({
  id: AddOnId.CollectionMetadata,
  params: encodeCollectionMetadataParams({ bannerSha256: ZERO32, teaserSha256s: [], externalLink: '', ...patch }),
});
const youSellers = { ...base, tStream: TStream.TO_CREATOR, creatorFeeRecipient: OWNER };

interface Row {
  readonly verdict: string;
  readonly spec: BoxSpecV1;
  readonly form?: CreateForm;
  readonly step: StepId;
  readonly control: string;
  readonly message: string;
}

/** § 5's table, row by row (the verdict column is what validate() says for the changed spec). */
const ROWS: readonly Row[] = [
  { verdict: 'LENGTH_OUT_OF_RANGE@3', spec: { ...base, tokenName: '' }, step: 'basics', control: CONTROL.name, message: 'Required' },
  { verdict: 'LENGTH_OUT_OF_RANGE@3', spec: { ...base, tokenName: 'x'.repeat(33) }, step: 'basics', control: CONTROL.name, message: 'Up to 32 characters' },
  { verdict: 'LENGTH_OUT_OF_RANGE@4', spec: { ...base, tokenSymbol: 'ABCDEFGHIJKL' }, step: 'basics', control: CONTROL.ticker, message: 'Up to 11 characters' },
  { verdict: 'LENGTH_OUT_OF_RANGE@5', spec: { ...base, collectionName: '' }, step: 'basics', control: CONTROL.name, message: 'Required' },
  { verdict: 'LENGTH_OUT_OF_RANGE@5', spec: { ...base, collectionName: '' }, form: formOf({ separateCollection: true }), step: 'contents', control: CONTROL.collectionName, message: 'Required' },
  { verdict: 'LENGTH_OUT_OF_RANGE@6', spec: { ...base, collectionSymbol: 'ABCDEFGHIJKL' }, step: 'basics', control: CONTROL.ticker, message: 'Up to 11 characters' },
  { verdict: 'LENGTH_OUT_OF_RANGE@6', spec: { ...base, collectionSymbol: 'ABCDEFGHIJKL' }, form: formOf({ separateCollection: true }), step: 'contents', control: CONTROL.collectionSymbol, message: 'Up to 11 characters' },
  { verdict: 'LENGTH_OUT_OF_RANGE@7', spec: { ...base, description: 'x'.repeat(1_025) }, step: 'basics', control: CONTROL.about, message: 'Up to 1,024 characters' },
  { verdict: 'BAD_CHARACTER@3', spec: { ...base, tokenName: 'Bad "name"' }, step: 'basics', control: CONTROL.name, message: MESSAGES.badCharacter },
  { verdict: 'BAD_CHARACTER@4', spec: { ...base, tokenSymbol: 'MO\\ON' }, step: 'basics', control: CONTROL.ticker, message: MESSAGES.badCharacter },
  { verdict: 'BAD_CHARACTER@5', spec: { ...base, collectionName: 'Moons 🌙' }, step: 'basics', control: CONTROL.name, message: MESSAGES.badCharacter },
  { verdict: 'BAD_CHARACTER@6', spec: { ...base, collectionSymbol: 'MÖÖN' }, step: 'basics', control: CONTROL.ticker, message: MESSAGES.badCharacter },
  { verdict: 'BAD_CHARACTER@7', spec: { ...base, description: 'Line one\nline two' }, step: 'basics', control: CONTROL.about, message: MESSAGES.badCharacter },
  { verdict: 'BAD_CHARACTER@101', spec: { ...hidden, addOns: [placeholders({ placeholderName: 'Tick"et' })] }, step: 'basics', control: CONTROL.name, message: MESSAGES.badCharacter },
  { verdict: 'BAD_CHARACTER@103', spec: { ...hidden, addOns: [placeholders({ placeholderDescription: 'Opens ✨' })] }, step: 'contents', control: CONTROL.ticketLine, message: MESSAGES.badCharacter },
  { verdict: 'BAD_CHARACTER@104', spec: { ...hidden, addOns: [placeholders({ hiddenDescription: 'Tab\there' })] }, step: 'contents', control: CONTROL.hiddenLine, message: MESSAGES.badCharacter },
  { verdict: 'BAD_CHARACTER@105', spec: { ...hidden, addOns: [placeholders({ hiddenSvg: '<svg>\n</svg>' })] }, step: 'contents', control: CONTROL.shown, message: 'Plain SVG text only' },
  { verdict: 'OUT_OF_RANGE@8', spec: { ...base, n: 9 }, step: 'contents', control: CONTROL.art, message: '10 to 10,000 items' },
  { verdict: 'OUT_OF_RANGE@8', spec: { ...base, n: 10_001 }, step: 'contents', control: CONTROL.art, message: '10 to 10,000 items' },
  // Field 15 openAt: below 2026-09-01 (a block count, a time passed long ago) is refused; 0 is Now and valid.
  { verdict: 'OUT_OF_RANGE@15', spec: { ...base, openAt: 300 }, step: 'launch', control: CONTROL.opens, message: 'Pick a time at least 2 minutes ahead' },
  { verdict: 'OUT_OF_RANGE@15', spec: { ...base, openAt: Date.UTC(2020, 0, 1) / 1000 }, form: formOf({ open: { kind: 'time', utc: '2020-01-01T00:00' } }), step: 'launch', control: CONTROL.openTime, message: 'Pick a time at least 2 minutes ahead' },
  // F74 U5: one target for every box, 4.206980085 ETH, stated with every digit.
  { verdict: 'OUT_OF_RANGE@27', spec: { ...base, creatorBuy: base.raise }, step: 'launch', control: CONTROL.firstIn, message: 'Below the target: less than 4.206980085 ETH' },
  { verdict: 'OUT_OF_RANGE@27', spec: { ...base, creatorBuy: 5n * 10n ** 18n }, step: 'launch', control: CONTROL.firstIn, message: 'Below the target: less than 4.206980085 ETH' },
  { verdict: 'ZERO_VALUE@23', spec: { ...base, coverSha256: ZERO32 }, step: 'basics', control: CONTROL.logo, message: 'Add a logo' },
  { verdict: 'ZERO_VALUE@23', spec: { ...token, coverSha256: ZERO32 }, form: tokenFormOf(), step: 'basics', control: CONTROL.logo, message: 'Add a logo' },
  { verdict: 'ZERO_VALUE@20', spec: { ...base, revealRoot: ZERO32 }, step: 'contents', control: CONTROL.art, message: 'Add your art' },
  { verdict: 'ZERO_VALUE@24', spec: { ...base, revealListId: ZERO32 }, step: 'contents', control: CONTROL.art, message: 'Add your art' },
  { verdict: 'ZERO_VALUE@25', spec: { ...base, marketplaceOwner: ZERO_ADDRESS }, step: 'overview', control: CONTROL.owner, message: 'Add your address' },
  // § 5 (v2): You on either side needs the address; here You on the sellers' side only.
  { verdict: 'ZERO_VALUE@26', spec: { ...youSellers, creatorFeeRecipient: ZERO_ADDRESS }, step: 'overview', control: CONTROL.owner, message: 'Add your address' },
  { verdict: 'ZERO_VALUE@26', spec: { ...token, qStream: QStream.CREATOR_IN_T }, form: tokenFormOf(), step: 'overview', control: CONTROL.owner, message: 'Add your address' },
  // Royalties to "You" are paid to the fee payout address (F72 (3)), so it is the address the check names.
  { verdict: 'ZERO_VALUE@26', spec: { ...base, addOns: [royalty(250, RoyaltyDestination.CREATOR)] }, step: 'overview', control: CONTROL.owner, message: 'Add your address' },
  // F74 U3 (field 28): a new collection's own cover, its own upload on Contents.
  { verdict: 'ZERO_VALUE@28', spec: { ...base, collectionCoverSha256: ZERO32 }, step: 'contents', control: CONTROL.collectionCover, message: 'Add a collection cover' },
  // F74 U1: holder payouts outside the Demo (a Demo draft on a chain source): named on their control.
  { verdict: 'NOT_OFFERED@17', spec: { ...base, qStream: QStream.HOLDERS_IN_T }, step: 'kind', control: CONTROL.buyers, message: DEMO_ONLY },
  { verdict: 'NOT_OFFERED@17', spec: { ...base, qStream: QStream.PAY_HOLDERS_Q }, step: 'kind', control: CONTROL.buyers, message: DEMO_ONLY },
  { verdict: 'NOT_OFFERED@18', spec: { ...base, tStream: TStream.HOLDERS_IN_Q }, step: 'kind', control: CONTROL.sellers, message: DEMO_ONLY },
  { verdict: 'NOT_OFFERED@502', spec: { ...youSellers, addOns: [cap(4n * ETH, CapExcess.HOLDERS)] }, step: 'kind', control: CONTROL.capExcess, message: DEMO_ONLY },
  { verdict: 'NOT_A_MEMBER@16', spec: { ...base, deadlineDays: 45 }, step: 'raise', control: CONTROL.deadline, message: 'Pick one of the options' },
  { verdict: 'NOT_A_MEMBER@401', spec: { ...base, addOns: [royalty(300, RoyaltyDestination.POOL_DEPTH)] }, step: 'contents', control: CONTROL.royalty, message: 'Pick one of the options' },
  // § 5 (v2) new rows.
  { verdict: 'NOT_A_MEMBER@501', spec: { ...youSellers, addOns: [cap(5n * ETH)] }, step: 'kind', control: CONTROL.cap, message: 'Pick one of the options' },
  { verdict: 'LENGTH_OUT_OF_RANGE@602', spec: { ...base, addOns: [pageAddOn({ teaserSha256s: [1, 2, 3, 4, 5].map((i) => pictureOf(`t${i}`).sha256) })] }, step: 'contents', control: CONTROL.teasers, message: 'Up to 4 teasers' },
  { verdict: 'BAD_CHARACTER@603', spec: { ...base, addOns: [pageAddOn({ externalLink: 'http://moons.example' })] }, step: 'contents', control: CONTROL.pageLink, message: 'Use a full https:// link' },
  { verdict: 'BAD_CHARACTER@603', spec: { ...base, addOns: [pageAddOn({ externalLink: 'https://moons.example/a b' })] }, step: 'contents', control: CONTROL.pageLink, message: 'Use a full https:// link' },
  { verdict: 'LENGTH_OUT_OF_RANGE@603', spec: { ...base, addOns: [pageAddOn({ externalLink: `https://${'a'.repeat(121)}` })] }, step: 'contents', control: CONTROL.pageLink, message: 'Up to 128 characters' },
  { verdict: 'MENU_RULE@18', spec: { ...base, qStream: QStream.BUYBACK_BURN_T, tStream: TStream.SELL_FOR_Q }, step: 'kind', control: CONTROL.sellers, message: 'Not beside Burn MOON on buyers’ fees' },
  { verdict: 'OUT_OF_RANGE@302', spec: { ...base, addOns: [special(13)] }, step: 'contents', control: CONTROL.specials, message: 'A series can’t be larger than the box' },
  { verdict: 'TOO_MANY_ADD_ONS@29', spec: { ...base, addOns: Array.from({ length: 9 }, () => special(1)) }, step: 'contents', control: CONTROL.specials, message: 'Up to 4 special series' },
  { verdict: 'LENGTH_OUT_OF_RANGE@21', spec: { ...base, metadataTable: `0x${'01'.repeat(24_576)}` }, step: 'contents', control: CONTROL.art, message: 'Too many traits for one box' },
];

/** What the page should never build: shown as a builder bug, with the reason name (§ 5's last row, and v1's). */
const BUGS: readonly { readonly verdict: string; readonly spec: BoxSpecV1 }[] = [
  { verdict: 'UNSUPPORTED_VERSION at version', spec: { ...base, version: 3 } },
  { verdict: 'NOT_OFFERED at boxType', spec: { ...base, boxType: BoxType.EXISTING } },
  { verdict: 'Q_NOT_LISTED at q', spec: { ...base, q: '0x00000000000000000000000000000000000000aa' } },
  // F74 U5: the raise is the version's, never chosen; another one is a builder bug (1 / 4.2 / 10 ETH were v2's presets).
  { verdict: 'RAISE_NOT_A_PRESET at raise', spec: { ...base, raise: 42n * 10n ** 17n } },
  { verdict: 'RAISE_NOT_A_PRESET at raise', spec: { ...base, raise: 10n ** 18n } },
  { verdict: 'MENU_RULE at qStream', spec: { ...base, qStream: QStream.BURN_Q } },
  { verdict: 'MUST_BE_ZERO at collectionName', spec: { ...token, collectionName: 'Paper Moons' } },
  { verdict: 'MUST_BE_ZERO at collectionSymbol', spec: { ...token, collectionSymbol: 'MOON' } },
  { verdict: 'MUST_BE_ZERO at n', spec: { ...token, n: 12 } },
  { verdict: 'MUST_BE_ZERO at artMode', spec: { ...token, artMode: 1 } },
  { verdict: 'MUST_BE_ZERO at revealRoot', spec: { ...token, revealRoot: base.revealRoot } },
  { verdict: 'MUST_BE_ZERO at metadataTable', spec: { ...token, metadataTable: base.metadataTable } },
  { verdict: 'MUST_BE_ZERO at generatorHash', spec: { ...token, generatorHash: base.revealRoot } },
  { verdict: 'MUST_BE_ZERO at revealListId', spec: { ...token, revealListId: base.revealListId } },
  { verdict: 'MUST_BE_ZERO at marketplaceOwner', spec: { ...token, marketplaceOwner: OWNER } },
  { verdict: 'MUST_BE_ZERO at collectionCoverSha256', spec: { ...token, collectionCoverSha256: base.coverSha256 } },
  { verdict: 'MUST_BE_ZERO at revealListId', spec: { ...hidden, revealListId: base.revealListId } },
  { verdict: 'MUST_BE_ZERO at creatorFeeRecipient', spec: { ...base, creatorFeeRecipient: OWNER } },
  { verdict: 'ADD_ON_CONFLICT at addOns.royalties', spec: { ...token, addOns: [royalty(100, RoyaltyDestination.POOL_DEPTH)] } },
  { verdict: 'ADD_ON_CONFLICT at addOns.collection-metadata', spec: { ...token, addOns: [pageAddOn({ externalLink: 'https://moons.example' })] } },
  { verdict: 'ADD_ON_CONFLICT at addOns.creator-fee-cap', spec: { ...base, addOns: [cap(4n * ETH)] } },
  { verdict: 'ZERO_VALUE at addOns.collection-metadata.teaserSha256s', spec: { ...base, addOns: [pageAddOn({ teaserSha256s: [ZERO32] })] } },
  { verdict: 'ADD_ON_REQUIRED at artMode', spec: { ...hidden, addOns: [] } },
  { verdict: 'ADD_ON_ORDER at addOns', spec: { ...base, addOns: [royalty(100, RoyaltyDestination.POOL_DEPTH), special(1)] } },
  { verdict: 'ADD_ON_NOT_AVAILABLE at addOns.per-item-stream', spec: { ...base, addOns: [{ id: AddOnId.PerItemStream, params: '0x' }] } },
  { verdict: 'ADD_ON_UNKNOWN at addOns', spec: { ...base, addOns: [{ id: 9, params: '0x' }] } },
];

describe('validate() verdicts → step, control, message (§ 5)', () => {
  it.each(ROWS.map((row) => [row.verdict, row.message, row] as const))('%s → "%s"', (verdict, _message, row) => {
    const v = validateBoxSpecV1(row.spec, CONTEXT_V2);
    expect(v.reason, `${verdict} is still what validate() says`).not.toBe(0);
    const issue = issueForVerdict(v, row.spec, row.form ?? formOf());
    expect(issue).toEqual({ step: row.step, control: row.control, message: row.message });
    // The final gate (zod schema of the version context) gives the same message.
    expect(finalGate(row.spec, row.form ?? formOf())).toEqual(issue);
  });

  it.each(BUGS.map((row) => [row.verdict, row] as const))('builder bug: %s', (verdict, row) => {
    const issue = issueForVerdict(validateBoxSpecV1(row.spec, CONTEXT_V2), row.spec, formOf());
    expect(issue?.message).toBe(MESSAGES.bug);
    expect(issue?.detail).toBe(verdict);
  });

  it('an accepted spec has no issue: a collection, hidden art, a token, the page add-on', () => {
    expect(issueForVerdict(validateBoxSpecV1(base, CONTEXT_V2), base, formOf())).toBeNull();
    expect(finalGate(base, formOf())).toBeNull();
    expect(finalGate(hidden, formOf({ artMode: 'hidden' }))).toBeNull();
    expect(finalGate(token, tokenFormOf())).toBeNull();
    expect(finalGate(buildSpec(inputOf({ page: PAGE })), formOf())).toBeNull();
  });

  it('F74 U1: the sample data accepts holder payouts (both sides, the cap excess); Sepolia’s rules and mainnet’s name them', () => {
    const holders = [
      { ...base, qStream: QStream.HOLDERS_IN_T },
      { ...base, qStream: QStream.PAY_HOLDERS_Q },
      { ...base, tStream: TStream.PAY_HOLDERS_T },
      { ...youSellers, addOns: [cap(4n * ETH, CapExcess.HOLDERS)] },
    ];
    for (const spec of holders) {
      expect(validateBoxSpecV1(spec, CONTEXT_V2, 'demo').reason).toBe(0);
      expect(finalGate(spec, formOf(), 'demo')).toBeNull();
      expect(finalGate(spec, formOf(), 'sepolia')?.message).toBe(DEMO_ONLY);
      expect(finalGate(spec, formOf(), 'mainnet')?.message).toBe(DEMO_ONLY);
    }
  });

  it('Sepolia leaves out what core v1 does not build: a Demo draft with a conversion is named "Not on testnet yet" there', () => {
    const conversions = [
      { spec: { ...base, qStream: QStream.CREATOR_IN_T, creatorFeeRecipient: OWNER }, control: CONTROL.buyers },
      { spec: { ...base, tStream: TStream.CREATOR_IN_Q, creatorFeeRecipient: OWNER }, control: CONTROL.sellers },
      { spec: { ...base, qStream: QStream.ALL_TO_FIT, tStream: TStream.SELL_FOR_Q }, control: CONTROL.sellers },
    ];
    for (const { spec, control } of conversions) {
      for (const network of ['demo', 'mainnet'] as const) expect(finalGate(spec, formOf(), network), network).toBeNull();
      expect(finalGate(spec, formOf(), 'sepolia')).toEqual({ step: 'kind', control, message: 'Not on testnet yet' });
    }
  });
});

describe('the page’s own checks (the same rule code, every field at once)', () => {
  const check = (step: StepId, patch: Parameters<typeof inputOf>[0] = {}, revealSaved = false, owner: string | null | undefined = undefined) => fieldIssues(step, { ...inputOf(patch), revealSaved, owner });
  const pairs = (issues: readonly { control: string; message: string }[]) => issues.map((issue) => [issue.control, issue.message]);

  it('an empty first step: name, ticker and a logo; About optional', () => {
    expect(pairs(check('basics', { form: formOf({ name: '', ticker: '' }), cover: null }))).toEqual([
      [CONTROL.name, 'Required'],
      [CONTROL.ticker, 'Required'],
      [CONTROL.logo, 'Add a logo'],
    ]);
    expect(pairs(check('basics', { form: formOf({ description: 'Quote " here' }) }))).toEqual([[CONTROL.about, MESSAGES.badCharacter]]);
  });

  it('Links (§ 4.1): Website https with a host, X an @handle or an x.com link, Telegram a t.me link, up to 200 characters', () => {
    const links = (website: string, x: string, telegram: string) => pairs(check('basics', { form: formOf({ links: { website, x, telegram } }) }));
    expect(links('', '', '')).toEqual([]);
    expect(links('https://moons.example/about', '@moons', 'https://t.me/paper_moons')).toEqual([]);
    expect(links('https://moons.example', 'https://x.com/moons', 'https://t.me/moons_chat/')).toEqual([]);
    expect(links('http://moons.example', 'moons', 'https://telegram.me/moons')).toEqual([
      [CONTROL.website, 'Use a full https:// link'],
      [CONTROL.x, 'An @handle or an x.com link'],
      [CONTROL.telegram, 'A t.me link'],
    ]);
    expect(links('javascript:alert(1)', 'https://twitter.com/moons', 'https://t.me/a')).toEqual([
      [CONTROL.website, 'Use a full https:// link'],
      [CONTROL.x, 'An @handle or an x.com link'],
      [CONTROL.telegram, 'A t.me link'],
    ]);
    expect(links(`https://moons.example/${'a'.repeat(190)}`, '', '')).toEqual([[CONTROL.website, 'Up to 200 characters']]);
  });

  it('Contents: nothing picked, then a token needs nothing more; a collection needs its art and its own cover (F74 U3)', () => {
    expect(pairs(check('contents', { form: formOf({ contents: null }) }))).toEqual([[CONTROL.contents, 'Pick what’s in the box']]);
    expect(check('contents', { form: tokenFormOf(), art: null, commitment: null, collectionCover: null })).toEqual([]);
    expect(pairs(check('contents', { art: null, commitment: null }))).toEqual([[CONTROL.art, 'Add your art']]);
    expect(pairs(check('contents', { collectionCover: null }))).toEqual([[CONTROL.collectionCover, 'Add a collection cover']]);
    expect(summaryLine({ control: CONTROL.collectionCover, message: MESSAGES.addCollectionCover })).toBe('Add a collection cover');
  });

  it('art with problems, too few items, and too many traits for the table', () => {
    expect(check('contents', { art: { ...artOf(), problems: ['3.png: refused'] }, commitment: null }).map((issue) => issue.message)).toEqual([MESSAGES.fixArt]);
    expect(check('contents', { art: artOf(9) }).map((issue) => issue.message)).toEqual(['10 to 10,000 items']);
    const wide = artOf(12);
    const many = { ...wide, items: wide.items.map((item) => ({ ...item, traits: [{ trait: 'Name', value: `${'v'.repeat(250)}${item.id}` }] })) };
    expect(check('contents', { form: formOf({ description: 'd'.repeat(1_024) }), art: many }).map((issue) => issue.message)).toEqual([]);
  });

  it('More: the collection’s own texts, special series and the ticket texts', () => {
    const issues = check('contents', {
      form: formOf({
        separateCollection: true,
        collectionName: '',
        collectionSymbol: 'TOO-LONG-TICKER',
        specials: [{ label: 'Gold', count: 'many' }, { label: '', count: '99' }],
        artMode: 'hidden',
        ticketLine: 'Emoji 🎟',
      }),
    });
    expect(pairs(issues)).toEqual([
      [CONTROL.collectionName, 'Required'],
      [CONTROL.collectionSymbol, 'Up to 11 characters'],
      [CONTROL.ticketLine, MESSAGES.badCharacter],
      [CONTROL.specials, 'Use a whole number like 12'],
      [CONTROL.specials, 'Required'],
      [CONTROL.specials, 'A series can’t be larger than the box'],
    ]);
    const five = Array.from({ length: 5 }, () => ({ label: 'S', count: '1' }));
    expect(check('contents', { form: formOf({ specials: five }) }).map((issue) => issue.message)).toEqual(['Up to 4 special series']);
  });

  it('the collection page: the link’s URL rule and at most 4 teasers', () => {
    expect(pairs(check('contents', { form: formOf({ pageLink: 'http://moons.example', pageLinkEdited: true }) }))).toEqual([[CONTROL.pageLink, 'Use a full https:// link']]);
    expect(pairs(check('contents', { form: formOf({ pageLink: `https://${'a'.repeat(121)}`, pageLinkEdited: true }) }))).toEqual([[CONTROL.pageLink, 'Up to 128 characters']]);
    // A website that fails the URL rule is not carried over (the site check reports it on Basics).
    expect(check('contents', { form: formOf({ links: { website: 'http://moons.example', x: '', telegram: '' } }) })).toEqual([]);
    const five = Array.from({ length: 5 }, (_, i) => pictureOf(`t${i}`));
    expect(pairs(check('contents', { page: { banner: null, teasers: five } }))).toEqual([[CONTROL.teasers, 'Up to 4 teasers']]);
  });

  it('Opening: a picked UTC time (unreadable, past or under 2 minutes ahead, beyond 14 days) and the creator ETH in (not a number, at the target)', () => {
    const at = (utc: string) => check('launch', { form: formOf({ open: { kind: 'time', utc } }) }).map((issue) => issue.message);
    expect(pairs(check('launch', { form: formOf({ open: { kind: 'time', utc: '' } }) }))).toEqual([[CONTROL.openTime, 'Pick a time']]);
    expect(at('2026-02-30T10:00')).toEqual(['Pick a time']);
    // NOW is 2026-10-03 12:00 UTC: the field is read as UTC, whatever this machine's zone.
    expect(at('2020-01-01T00:00')).toEqual(['Pick a time at least 2 minutes ahead']);
    expect(at('2026-10-03T12:01')).toEqual(['Pick a time at least 2 minutes ahead']);
    expect(at('2026-10-03T12:02')).toEqual([]);
    expect(at('2026-10-17T12:00')).toEqual([]);
    expect(at('2026-10-17T12:01')).toEqual(['Pick a time within 14 days']);
    expect(at('2027-01-01T00:00')).toEqual(['Pick a time within 14 days']);
    for (const id of ['now', '5m', '1h', '24h']) expect(check('launch', { form: formOf({ open: { kind: 'preset', id } }) }), id).toEqual([]);
    expect(pairs(check('launch', { form: formOf({ firstIn: '0,05' }) }))).toEqual([[CONTROL.firstIn, 'Use a number like 0.05']]);
    // F74 U5: the target is the one raise every box has (4.206980085 ETH, every digit).
    expect(check('launch', { form: formOf({ firstIn: '4.206980085' }) }).map((issue) => issue.message)).toEqual(['Below the target: less than 4.206980085 ETH']);
    expect(check('launch', { form: formOf({ firstIn: '4.206980084999999999' }) })).toEqual([]);
    expect(check('launch', { form: formOf({ firstIn: '1' }) })).toEqual([]);
    expect(check('launch', { form: formOf({ firstIn: '0.99' }) })).toEqual([]);
    // The rights box is on Opening, but it only blocks Create (the Overview's check).
    expect(check('launch', { form: formOf({ rights: false }) })).toEqual([]);
  });

  it('Overview: your address, the reveal file for hidden art, and the rights confirmation', () => {
    expect(pairs(check('overview', { form: formOf({ rights: false }) }))).toEqual([[CONTROL.rights, 'Confirm your rights']]);
    expect(pairs(check('overview', { form: formOf({ rights: true, artMode: 'hidden' }) }))).toEqual([[CONTROL.reveal, 'Download the reveal file first']]);
    expect(check('overview', { form: formOf({ rights: true, artMode: 'hidden' }) }, true)).toEqual([]);
    // A token has no reveal file, whatever Shown still holds.
    expect(check('overview', { form: tokenFormOf({ rights: true, artMode: 'hidden' }) })).toEqual([]);
    expect(pairs(check('overview', { form: tokenFormOf({ rights: true }) }, false, null))).toEqual([[CONTROL.owner, 'Add your address']]);
  });

  it('Overview, chain sources: a pasted address that is not a full address, or a mixed-case address with a typo', () => {
    expect(pairs(fieldIssues('overview', { ...inputOf({ form: formOf({ rights: true }) }), revealSaved: false, ownerProblem: 'not-an-address' }))).toEqual([[CONTROL.owner, 'Not a full 0x address']]);
    expect(fieldIssues('overview', { ...inputOf({ form: formOf({ rights: true }) }), revealSaved: false, ownerProblem: 'checksum' }).map((issue) => issue.message)).toEqual(['Check the address']);
  });

  it('the error summary names the field unless the message already does', () => {
    expect(summaryLine({ control: CONTROL.name, message: 'Required' })).toBe('Name: Required');
    expect(summaryLine({ control: CONTROL.ticker, message: MESSAGES.badCharacter })).toBe(`Ticker: ${MESSAGES.badCharacter}`);
    expect(summaryLine({ control: CONTROL.logo, message: 'Add a logo' })).toBe('Add a logo');
    expect(summaryLine({ control: CONTROL.art, message: 'Add your art' })).toBe('Add your art');
    expect(summaryLine({ control: CONTROL.website, message: MESSAGES.httpsLink })).toBe('Website: Use a full https:// link');
    expect(summaryLine({ control: CONTROL.teasers, message: MESSAGES.teaserCount })).toBe('Up to 4 teasers');
    expect(summaryLine({ control: CONTROL.rights, message: MESSAGES.rights })).toBe('Confirm your rights');
    expect(summaryLine({ control: CONTROL.owner, message: MESSAGES.addAddress })).toBe('Add your address');
    expect(summaryLine({ control: CONTROL.owner, message: MESSAGES.bug, detail: 'BAD at x' })).toBe(MESSAGES.bug);
  });

  it('dedupe keeps the first message per control', () => {
    expect(dedupe([
      { step: 'contents', control: CONTROL.art, message: 'Add your art' },
      { step: 'contents', control: CONTROL.art, message: '10 to 10,000 items' },
    ])).toEqual([{ step: 'contents', control: CONTROL.art, message: 'Add your art' }]);
  });
});

describe('the gates', () => {
  const gate = (patch: Parameters<typeof inputOf>[0] = {}, revealSaved = false) => ({ ...inputOf(patch), revealSaved });

  it('Next on each step passes with complete Basics and Contents and the defaults after them, both box types', () => {
    for (const form of [formOf(), tokenFormOf()]) {
      for (const step of ['basics', 'contents', 'kind', 'raise', 'launch'] as const) expect(stepIssues(step, gate({ owner: null, form })), `${form.contents} ${step}`).toEqual([]);
    }
  });

  it('Next on Basics never reports a later step’s field (the art is on Contents, the address on the Overview)', () => {
    expect(stepIssues('basics', gate({ owner: null, art: null, commitment: null, form: formOf({ qStream: QStream.TO_CREATOR }) }))).toEqual([]);
  });

  it('the stepper reaches Contents once Basics is complete, every step once Contents is (§ 0)', () => {
    expect(reachableSteps(gate({ form: formOf({ name: '' }) }))).toBe(1);
    expect(reachableSteps(gate({ form: formOf({ contents: null }) }))).toBe(2);
    expect(reachableSteps(gate({ art: null, commitment: null }))).toBe(2);
    expect(reachableSteps(gate({ collectionCover: null }))).toBe(2);
    expect(reachableSteps(gate({ form: tokenFormOf(), art: null, commitment: null }))).toBe(6);
  });

  it('Overview: a connected wallet never stands in for a malformed pasted address (Download BoxSpec stays blocked)', () => {
    const { owner, problem } = chooseOwner(false, OWNER, '0x27aeE84839B05524B5A6eb3335D9fC21037059D');
    expect(owner).toBeNull();
    const issues = reviewIssues({ ...gate({ owner, form: formOf({ rights: true }) }), ownerProblem: problem }).issues;
    expect(issues.map((issue) => [issue.control, issue.message])).toEqual([[CONTROL.owner, 'Not a full 0x address']]);
  });

  it('Overview: everything, then the schema; the address and the rights are needed there; the groups that need something', () => {
    expect(reviewIssues(gate({ owner: null, form: formOf({ rights: true }) })).issues).toEqual([{ step: 'overview', control: CONTROL.owner, message: 'Add your address' }]);
    // A token box with Burn on both sides names no address in its spec, but the site record needs one.
    expect(reviewIssues(gate({ owner: null, form: tokenFormOf({ rights: true }) })).issues).toEqual([{ step: 'overview', control: CONTROL.owner, message: 'Add your address' }]);
    const all = reviewIssues(gate({ form: formOf({ name: '', firstIn: 'x' }), cover: null, nowMs: NOW })).issues;
    expect(all.map((issue) => issue.message)).toEqual(['Required', 'Add a logo', 'Use a number like 0.05', 'Confirm your rights']);
    expect([...stepsToFix(all)]).toEqual(['basics', 'launch', 'overview']);
    expect(reviewIssues(gate({ form: formOf({ rights: true }) })).issues).toEqual([]);
    expect(reviewIssues(gate({ form: tokenFormOf({ rights: true }), art: null, commitment: null })).issues).toEqual([]);
  });
});
