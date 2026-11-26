/**
 * The form → BoxSpecV1 builder (box creation flow § 2): every field and add-on parameter as the field map says, for
 * both box types (a new collection and "Token"), every menu value through the factory's own
 * `validateBoxSpecV1(spec, CONTEXT_V2, network)` (every offered fee pair, cap preset and excess on each network: holder
 * payouts in the Demo only, F74 U1; the collection page with 0-4 teasers), the one raise (F74 U5), the collection's own
 * cover (F74 U3), the contractURI JSON and the BoxSpec file; amounts bigint only.
 */
import { boxLeaf, buildBoxTree, canonicalJson, rawCidV1, sha256Hex } from '@squarehole/artwork';
import {
  AddOnId,
  ArtMode,
  BOOTSTRAP_ETH,
  BOX_0_MISFITS,
  BoxType,
  CONTEXT_V2,
  CapExcess,
  Field,
  GradLayout,
  LaunchFormat,
  Layout,
  MAX_OPEN_AHEAD_SECONDS,
  MIN_OPEN_AT,
  NETWORKS,
  QStream,
  Reason,
  RoyaltyDestination,
  TStream,
  decodeBoxSpecV1,
  decodeCollectionMetadataParams,
  decodeCreatorFeeCapParams,
  decodeEditionSpecialsParams,
  decodePlaceholdersParams,
  decodeRoyaltiesParams,
  encodeBoxSpecV1,
  specHash,
  validateBoxSpecV1,
} from '@squarehole/box-spec';
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { creatorOnEitherSide, sideChoices } from '../boxes/fee-kinds';
import {
  CAP_PRESETS,
  CAP_EXCESS,
  capOffered,
  CREATE_GAS_BASE,
  CREATE_GAS_PER_BYTE,
  DEADLINE_DAYS,
  DEFAULT_FORM,
  DEFAULT_OPEN_PRESET,
  EMPTY_PAGE,
  LEGACY_STEPS,
  MAX_SPECIALS,
  OPEN_PRESETS,
  Q_ASSETS,
  RIGHTS_STATEMENT_VERSION,
  ROYALTY_BPS,
  STEPS,
  ZERO32,
  artHasModels,
  boxSpecFile,
  buildSpec,
  chooseOwner,
  commitArt,
  contractUri,
  costEstimate,
  effectivePageLink,
  encodedBytes,
  openAheadSeconds,
  openAtOf,
  pickedUtcMs,
  utcFieldValue,
  parseCount,
  parseEthText,
  probeForm,
  raiseOf,
  readPastedOwner,
  revealFile,
  revealList,
  rightsRecord,
  ticketNames,
  traitTable,
  modelOf,
  type ArtState,
} from './create-model';
import { fromBase64 } from './art-files';
import { COLLECTION_COVER, COVER, NOW, OWNER, PAGE, THUMB, artOf, formOf, inputOf, pictureOf, tokenFormOf } from './test-support/fixtures';
import { encodeAbiParameters, keccak256 } from 'viem';
import { glbOf } from './test-support/models';

const ETH = 10n ** 18n;
/** F74 U5: the one raise every box has (box 0's R). */
const RAISE = 4_206_980_085n * 10n ** 9n;
const ok = { reason: Reason.OK, field: 0 };
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

describe('the steps (F70 order)', () => {
  it('six steps in F70’s order; v1’s slugs map to the steps that now hold their choices', () => {
    expect(STEPS.map((step) => step.id)).toEqual(['basics', 'contents', 'kind', 'raise', 'launch', 'overview']);
    expect(STEPS.map((step) => step.label)).toEqual(['Basics', 'Contents', 'Box kind', 'Raise', 'Opening', 'Overview']);
    expect(LEGACY_STEPS).toEqual({ collection: 'contents', price: 'raise', fees: 'kind', review: 'overview' });
  });
});

describe('buildSpec: a new collection (§ 2.1)', () => {
  it('builds a valid version-2 spec from the defaults plus name, logo, art and owner', () => {
    const input = inputOf();
    const spec = buildSpec(input);
    expect(validateBoxSpecV1(spec, CONTEXT_V2)).toEqual(ok);
    expect(spec).toMatchObject({
      version: 2,
      boxType: BoxType.NEW_COLLECTION,
      tokenName: 'Paper Moons',
      tokenSymbol: 'MOON',
      collectionName: 'Paper Moons',
      collectionSymbol: 'MOON',
      description: '',
      n: 12,
      firstId: 1n,
      q: ZERO_ADDRESS,
      raise: RAISE,
      layout: Layout.CURVE_V1,
      gradLayout: GradLayout.ASK_FULL_BID_SENTINEL,
      launchFormat: LaunchFormat.CURVE,
      // Now, the default (founder 2026-10-04): openAt 0, the block after the creation block.
      openAt: 0,
      deadlineDays: 30,
      qStream: QStream.BUYBACK_BURN_T,
      tStream: TStream.BURN_T,
      artMode: ArtMode.OPEN,
      revealRoot: input.commitment?.revealRoot,
      generatorHash: ZERO32,
      coverSha256: input.cover?.sha256,
      revealListId: input.commitment?.revealListId,
      marketplaceOwner: OWNER,
      creatorFeeRecipient: ZERO_ADDRESS,
      creatorBuy: 0n,
      // F74 U3: the collection's own cover, its own upload, not the logo.
      collectionCoverSha256: COLLECTION_COVER.sha256,
      addOns: [],
    });
    expect(spec.revealListId).not.toBe(ZERO32);
    expect(spec.collectionCoverSha256).not.toBe(spec.coverSha256);
  });

  it('F74 U5: the raise is the version’s, one for every box (4.206980085 ETH, box 0’s); the form has no raise to choose', () => {
    expect(Q_ASSETS[0]?.raisePresets).toEqual([RAISE]);
    expect(raiseOf(0)).toBe(RAISE);
    expect(raiseOf(99)).toBe(RAISE);
    expect(Object.keys(DEFAULT_FORM)).not.toContain('raise');
    expect(buildSpec(inputOf()).raise).toBe(RAISE);
    expect(buildSpec(inputOf({ form: tokenFormOf() })).raise).toBe(RAISE);
  });

  it('uses the defaults the spec proposes: ETH, 30 days, Burn the token on both sides, no cap, royalty off, opens Now, open art, no tile picked', () => {
    expect(Q_ASSETS).toHaveLength(1);
    expect(DEFAULT_FORM).toMatchObject({
      qIndex: 0,
      deadlineDays: 30,
      contents: null,
      qStream: QStream.BUYBACK_BURN_T,
      tStream: TStream.BURN_T,
      capPerEpoch: 0n,
      capExcess: CapExcess.BURN,
      royaltyBps: 0,
      open: { kind: 'preset', id: 'now' },
      firstIn: '',
      storeAll: false,
      artMode: 'open',
      rights: false,
      links: { website: '', x: '', telegram: '' },
    });
  });

  it('Name and Ticker are the token’s; the collection takes them unless More gives it its own', () => {
    const spec = buildSpec(inputOf({ form: formOf({ separateCollection: true, collectionName: 'Moon Prints', collectionSymbol: 'MPRT' }) }));
    expect([spec.tokenName, spec.tokenSymbol, spec.collectionName, spec.collectionSymbol]).toEqual(['Paper Moons', 'MOON', 'Moon Prints', 'MPRT']);
    expect(validateBoxSpecV1(spec, CONTEXT_V2)).toEqual(ok);
    // Hidden art's ticket follows the collection's own names.
    const hidden = buildSpec(inputOf({ form: formOf({ artMode: 'hidden', separateCollection: true, collectionName: 'Moon Prints', collectionSymbol: 'MPRT' }) }));
    expect(decodePlaceholdersParams(hidden.addOns[0]?.params ?? '0x')).toMatchObject({ placeholderName: 'Moon Prints ticket', placeholderSymbol: 'MPRT-T' });
  });

  it('Opens: Now first and the default (openAt 0: the block after creation, never in it); then 5 min, 1 h, 24 h as UTC times', () => {
    expect(OPEN_PRESETS.map((preset) => [preset.id, preset.label, preset.seconds])).toEqual([
      ['now', 'Now', 0],
      ['5m', '5 min', 300],
      ['1h', '1 h', 3_600],
      ['24h', '24 h', 86_400],
    ]);
    expect(DEFAULT_OPEN_PRESET).toEqual({ id: 'now', label: 'Now', seconds: 0 });
    expect(DEFAULT_FORM.open).toEqual({ kind: 'preset', id: 'now' });
    expect(buildSpec(inputOf({ form: tokenFormOf() })).openAt).toBe(0);
    // Field 15 takes 0 (Now) or a time from MIN_OPEN_AT (2026-09-01) on: a block count or a delay is refused, never 1970.
    expect(MIN_OPEN_AT).toBe(Date.UTC(2026, 8, 1) / 1000);
    expect(validateBoxSpecV1({ ...buildSpec(inputOf()), openAt: 300 }, CONTEXT_V2)).toEqual({ reason: Reason.OUT_OF_RANGE, field: Field.openAt });
    expect(validateBoxSpecV1({ ...buildSpec(inputOf()), openAt: MIN_OPEN_AT - 1 }, CONTEXT_V2)).toEqual({ reason: Reason.OUT_OF_RANGE, field: Field.openAt });
    expect(validateBoxSpecV1({ ...buildSpec(inputOf()), openAt: MIN_OPEN_AT }, CONTEXT_V2)).toEqual(ok);
  });

  it('accepts every menu value the page offers: deadlines, open presets, royalties', () => {
    for (const deadlineDays of DEADLINE_DAYS) expect(validateBoxSpecV1(buildSpec(inputOf({ form: formOf({ deadlineDays }) })), CONTEXT_V2)).toEqual(ok);
    for (const preset of OPEN_PRESETS) {
      const spec = buildSpec(inputOf({ form: formOf({ open: { kind: 'preset', id: preset.id } }) }));
      expect(spec.openAt).toBe(openAtOf({ kind: 'preset', id: preset.id }, NOW));
      expect(validateBoxSpecV1(spec, CONTEXT_V2)).toEqual(ok);
    }
    expect(ROYALTY_BPS).toEqual([0, 100, 250, 500]);
    for (const bps of ROYALTY_BPS) {
      for (const royaltyTo of ['fees', 'creator', 'pool'] as const) {
        expect(validateBoxSpecV1(buildSpec(inputOf({ form: formOf({ royaltyBps: bps, royaltyTo }) })), CONTEXT_V2), `${bps} ${royaltyTo}`).toEqual(ok);
      }
    }
  });

  it('builds the royalties add-on (4) only when on; "You" pays the fee payout address (F72 (3), one payout wallet)', () => {
    const build = (royaltyTo: 'fees' | 'creator' | 'pool') => buildSpec(inputOf({ form: formOf({ royaltyBps: 250, royaltyTo }) }));
    expect(build('fees').addOns.map((addOn) => addOn.id)).toEqual([AddOnId.Royalties]);
    expect(decodeRoyaltiesParams(build('fees').addOns[0]?.params ?? '0x')).toEqual({ bps: 250, destination: RoyaltyDestination.FEE_HANDLING });
    expect(decodeRoyaltiesParams(build('creator').addOns[0]?.params ?? '0x')).toEqual({ bps: 250, destination: RoyaltyDestination.CREATOR });
    expect(decodeRoyaltiesParams(build('pool').addOns[0]?.params ?? '0x')).toEqual({ bps: 250, destination: RoyaltyDestination.POOL_DEPTH });
    expect(build('creator').creatorFeeRecipient).toBe(OWNER);
    expect(build('fees').creatorFeeRecipient).toBe(ZERO_ADDRESS);
  });

  it('hidden art: the placeholders add-on (1) with the ticket names and texts and the neutral SVG; no reveal list id', () => {
    const spec = buildSpec(inputOf({ form: formOf({ artMode: 'hidden' }) }));
    expect(validateBoxSpecV1(spec, CONTEXT_V2)).toEqual(ok);
    expect(spec.artMode).toBe(ArtMode.HIDDEN);
    expect(spec.revealListId).toBe(ZERO32);
    expect(spec.addOns.map((addOn) => addOn.id)).toEqual([AddOnId.Placeholders]);
    const params = decodePlaceholdersParams(spec.addOns[0]?.params ?? '0x');
    expect(params).toMatchObject({ placeholderName: 'Paper Moons ticket', placeholderSymbol: 'MOON-T', placeholderDescription: DEFAULT_FORM.ticketLine, hiddenDescription: DEFAULT_FORM.hiddenLine });
    expect(params.hiddenSvg.startsWith('<svg')).toBe(true);
    expect(params.hiddenSvg.length).toBeLessThanOrEqual(4_096);
    expect(params.hiddenSvg).toBe(DEFAULT_FORM.hiddenSvg);
  });

  it('SH-EX-O1: the hidden picture is the form’s (a loaded setup’s own); the add-on’s rule checks it', () => {
    const own = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#F4E9D8"/></svg>';
    const spec = buildSpec(inputOf({ form: formOf({ artMode: 'hidden', hiddenSvg: own }) }));
    expect(validateBoxSpecV1(spec, CONTEXT_V2)).toEqual(ok);
    expect(decodePlaceholdersParams(spec.addOns[0]?.params ?? '0x').hiddenSvg).toBe(own);
    // One line of printable ASCII, 1 to 4,096 characters (field 105): a line break or a longer text is refused.
    expect(validateBoxSpecV1(buildSpec(inputOf({ form: formOf({ artMode: 'hidden', hiddenSvg: own.replace('><', '>\n<') }) })), CONTEXT_V2)).toEqual({ reason: Reason.BAD_CHARACTER, field: Field['addOns.placeholders.hiddenSvg'] });
    expect(validateBoxSpecV1(buildSpec(inputOf({ form: formOf({ artMode: 'hidden', hiddenSvg: `${own}${' '.repeat(4_097 - own.length)}` }) })), CONTEXT_V2)).toEqual({ reason: Reason.LENGTH_OUT_OF_RANGE, field: Field['addOns.placeholders.hiddenSvg'] });
    // Open art carries no placeholders: the field changes nothing there.
    expect(buildSpec(inputOf({ form: formOf({ hiddenSvg: own }) }))).toEqual(buildSpec(inputOf()));
  });

  it('add-ons ascending: placeholders, specials, royalties, the cap, the collection page; specials fill what is left of 8', () => {
    const spec = buildSpec(
      inputOf({
        form: formOf({ artMode: 'hidden', royaltyBps: 100, specials: [{ label: 'Gold', count: '3' }, { label: 'Silver', count: '5' }], qStream: QStream.TO_CREATOR, capPerEpoch: 4n * ETH }),
        page: PAGE,
      }),
    );
    expect(spec.addOns.map((addOn) => addOn.id)).toEqual([1, 3, 3, 4, 5, 6]);
    expect(decodeEditionSpecialsParams(spec.addOns[2]?.params ?? '0x')).toEqual({ label: 'Silver', count: 5 });
    expect(validateBoxSpecV1(spec, CONTEXT_V2)).toEqual(ok);
    expect(MAX_SPECIALS).toBe(4);
    const full = buildSpec(inputOf({ form: formOf({ artMode: 'hidden', royaltyBps: 100, specials: Array.from({ length: MAX_SPECIALS }, () => ({ label: 'S', count: '1' })), qStream: QStream.TO_CREATOR, capPerEpoch: 4n * ETH }), page: PAGE }));
    expect(full.addOns).toHaveLength(8);
    expect(validateBoxSpecV1(full, CONTEXT_V2)).toEqual(ok);
  });

  it('the creator ETH in is a raw bigint below the raise (F61 O2)', () => {
    expect(buildSpec(inputOf({ form: formOf({ firstIn: '0.05' }) })).creatorBuy).toBe(50_000_000_000_000_000n);
    expect(validateBoxSpecV1(buildSpec(inputOf({ form: formOf({ firstIn: '0.999999999999999999' }) })), CONTEXT_V2)).toEqual(ok);
    // Not a number: left at 0 in the spec; the page's own check names it (reason-copy.test.ts).
    expect(buildSpec(inputOf({ form: formOf({ firstIn: 'lots' }) })).creatorBuy).toBe(0n);
  });

  it('leaves missing pieces at zero so validate() names them', () => {
    expect(buildSpec(inputOf({ cover: null })).coverSha256).toBe(ZERO32);
    // F74 U3: a new collection without its own cover; the logo never stands in for it.
    const noCover = buildSpec(inputOf({ collectionCover: null }));
    expect([noCover.collectionCoverSha256, noCover.coverSha256]).toEqual([ZERO32, COVER.sha256]);
    expect(validateBoxSpecV1(noCover, CONTEXT_V2)).toEqual({ reason: Reason.ZERO_VALUE, field: Field.collectionCoverSha256 });
    expect(buildSpec(inputOf({ owner: null })).marketplaceOwner).toBe(ZERO_ADDRESS);
    const none = buildSpec(inputOf({ art: null, commitment: null }));
    expect([none.n, none.revealRoot, none.revealListId]).toEqual([0, ZERO32, ZERO32]);
  });
});

describe('buildSpec: "Token" (§ 3.1, BoxType TOKEN_ONLY)', () => {
  it('zeroes every collection field (5, 6, 8, 19-22, 24, 25, 28), keeps the logo, and validates', () => {
    const spec = buildSpec(inputOf({ form: tokenFormOf({ description: 'A plain token.' }) }));
    expect(validateBoxSpecV1(spec, CONTEXT_V2)).toEqual(ok);
    expect(spec).toMatchObject({
      boxType: BoxType.TOKEN_ONLY,
      tokenName: 'Paper Moons',
      tokenSymbol: 'MOON',
      collectionName: '',
      collectionSymbol: '',
      description: 'A plain token.',
      n: 0,
      artMode: 0,
      revealRoot: ZERO32,
      metadataTable: '0x',
      generatorHash: ZERO32,
      coverSha256: COVER.sha256,
      revealListId: ZERO32,
      marketplaceOwner: ZERO_ADDRESS,
      creatorFeeRecipient: ZERO_ADDRESS,
      collectionCoverSha256: ZERO32,
      addOns: [],
    });
  });

  it('carries no collection add-on, whatever the Contents fields still hold; only the cap (5) when a side is You', () => {
    const leftovers = { artMode: 'hidden' as const, royaltyBps: 500, specials: [{ label: 'Gold', count: '3' }], pageLink: 'https://moons.example', pageLinkEdited: true };
    const spec = buildSpec(inputOf({ form: tokenFormOf(leftovers), page: PAGE }));
    expect(spec.addOns).toEqual([]);
    expect(validateBoxSpecV1(spec, CONTEXT_V2)).toEqual(ok);
    const capped = buildSpec(inputOf({ form: tokenFormOf({ ...leftovers, tStream: TStream.TO_CREATOR, capPerEpoch: 32n * ETH, capExcess: CapExcess.POOL_DEPTH }), page: PAGE }));
    expect(capped.addOns.map((addOn) => addOn.id)).toEqual([AddOnId.CreatorFeeCap]);
    expect(decodeCreatorFeeCapParams(capped.addOns[0]?.params ?? '0x')).toEqual({ capPerEpoch: 32n * ETH, excess: CapExcess.POOL_DEPTH });
    expect(capped.creatorFeeRecipient).toBe(OWNER);
    expect(capped.marketplaceOwner).toBe(ZERO_ADDRESS);
    expect(validateBoxSpecV1(capped, CONTEXT_V2)).toEqual(ok);
  });

  it('needs no art and no collection cover: a cover kept from a collection draft stays out (field 28 zero)', () => {
    expect(validateBoxSpecV1(buildSpec(inputOf({ form: tokenFormOf(), art: null, commitment: null })), CONTEXT_V2)).toEqual(ok);
    expect(buildSpec(inputOf({ form: tokenFormOf(), collectionCover: COLLECTION_COVER })).collectionCoverSha256).toBe(ZERO32);
  });
});

describe('buildSpec: each fee side (§ 2.2) and the cap (add-on 5)', () => {
  const offered = (side: 'buyers' | 'sellers', other: number) => sideChoices(side, other).flatMap((choice) => choice.members.filter((member) => !member.disabled).map((member) => member.value));

  it('every offered pair builds a valid spec, both box types; the recipient is set exactly when a side is You', () => {
    let pairs = 0;
    for (const qStream of offered('buyers', TStream.BURN_T)) {
      for (const tStream of offered('sellers', qStream)) {
        for (const form of [formOf({ qStream, tStream }), tokenFormOf({ qStream, tStream })]) {
          const spec = buildSpec(inputOf({ form }));
          expect(validateBoxSpecV1(spec, CONTEXT_V2), `${form.contents} ${qStream}/${tStream}`).toEqual(ok);
          const creator = [QStream.TO_CREATOR, QStream.CREATOR_IN_T].includes(qStream as 5) || [TStream.TO_CREATOR, TStream.CREATOR_IN_Q].includes(tStream as 5);
          expect(spec.creatorFeeRecipient, `${qStream}/${tStream}`).toBe(creator ? OWNER : ZERO_ADDRESS);
          pairs += 1;
        }
      }
    }
    // Buyers: Burn KITE, Burn FIT, You (ETH), You (KITE); sellers: Burn KITE, Burn FIT (not beside Burn KITE), You (KITE), You (ETH).
    expect(pairs).toBe(2 * (4 * 4 - 1));
  });

  it('every cap preset and excess builds while a side is You; holders as the excess in the Demo only; the cap leaves the spec when no side is You', () => {
    // F74 U2: fixed amounts per 30 days, 1, 4, 8, 16 and 32 ETH (bigint), 0n = off.
    expect(CAP_PRESETS).toEqual([0n, ETH, 4n * ETH, 8n * ETH, 16n * ETH, 32n * ETH]);
    expect(CAP_EXCESS).toEqual([CapExcess.HOLDERS, CapExcess.BURN, CapExcess.POOL_DEPTH]);
    expect(capOffered(0)).toBe(true);
    for (const capPerEpoch of CAP_PRESETS.filter((cap) => cap > 0n)) {
      for (const capExcess of CAP_EXCESS) {
        // TO_CREATOR: built everywhere (CREATOR_IN_T is not on Sepolia yet: it needs the swap module).
        const spec = buildSpec(inputOf({ form: formOf({ qStream: QStream.TO_CREATOR, capPerEpoch, capExcess }) }));
        expect(decodeCreatorFeeCapParams(spec.addOns.find((addOn) => addOn.id === AddOnId.CreatorFeeCap)?.params ?? '0x')).toEqual({ capPerEpoch, excess: capExcess });
        for (const network of NETWORKS) {
          const expected = capExcess === CapExcess.HOLDERS && network !== 'demo' ? { reason: Reason.NOT_OFFERED, field: Field['addOns.creator-fee-cap.excess'] } : ok;
          expect(validateBoxSpecV1(spec, CONTEXT_V2, network), `${capPerEpoch} ${capExcess} ${network}`).toEqual(expected);
        }
      }
    }
    const dropped = buildSpec(inputOf({ form: formOf({ capPerEpoch: 4n * ETH }) }));
    expect(dropped.addOns.some((addOn) => addOn.id === AddOnId.CreatorFeeCap)).toBe(false);
    expect(validateBoxSpecV1(dropped, CONTEXT_V2)).toEqual(ok);
  });

  it('holder payouts (F74 U1): every Demo pair with Holders builds and validates there, and is refused on Sepolia and mainnet', () => {
    const offeredOn = (network: 'demo' | 'sepolia' | 'mainnet', side: 'buyers' | 'sellers', other: number) =>
      sideChoices(side, other, undefined, undefined, network).flatMap((choice) => choice.members.filter((member) => !member.disabled).map((member) => member.value));
    const holders = [QStream.PAY_HOLDERS_Q, QStream.HOLDERS_IN_T] as number[];
    const holdersT = [TStream.PAY_HOLDERS_T, TStream.HOLDERS_IN_Q] as number[];
    let pairs = 0;
    for (const qStream of offeredOn('demo', 'buyers', TStream.BURN_T)) {
      for (const tStream of offeredOn('demo', 'sellers', qStream)) {
        if (!holders.includes(qStream) && !holdersT.includes(tStream)) continue;
        const spec = buildSpec(inputOf({ form: formOf({ qStream, tStream }) }));
        expect(validateBoxSpecV1(spec, CONTEXT_V2, 'demo'), `${qStream}/${tStream}`).toEqual(ok);
        expect(validateBoxSpecV1(spec, CONTEXT_V2, 'sepolia').reason, `${qStream}/${tStream} sepolia`).toBe(Reason.NOT_OFFERED);
        expect(validateBoxSpecV1(spec, CONTEXT_V2).reason, `${qStream}/${tStream} mainnet`).toBe(Reason.NOT_OFFERED);
        expect(spec.creatorFeeRecipient).toBe(creatorOnEitherSide(qStream, tStream) ? OWNER : ZERO_ADDRESS);
        pairs += 1;
      }
    }
    expect(pairs).toBeGreaterThan(0);
    // Chain sources: no holder member on either side.
    for (const network of ['sepolia', 'mainnet'] as const) {
      expect(offeredOn(network, 'buyers', TStream.BURN_T).some((value) => holders.includes(value))).toBe(false);
      expect(offeredOn(network, 'sellers', QStream.BUYBACK_BURN_T).some((value) => holdersT.includes(value))).toBe(false);
    }
  });

  it('the cap is a fixed amount per 30 days, not a share of the target (F74 U2)', () => {
    const spec = buildSpec(inputOf({ form: formOf({ qStream: QStream.TO_CREATOR, capPerEpoch: 8n * ETH }) }));
    expect(decodeCreatorFeeCapParams(spec.addOns.find((addOn) => addOn.id === AddOnId.CreatorFeeCap)?.params ?? '0x').capPerEpoch).toBe(8n * ETH);
    expect(CAP_PRESETS.every((cap) => typeof cap === 'bigint')).toBe(true);
  });
});

describe('the collection page (add-on 6, F71 (2))', () => {
  it('banner, 0-4 teasers and the link build add-on 6 with their hashes; none of them: no add-on', () => {
    expect(buildSpec(inputOf()).addOns).toEqual([]);
    for (const count of [0, 1, 2, 3, 4]) {
      const teasers = Array.from({ length: count }, (_, i) => pictureOf(`teaser ${i}`, THUMB));
      const spec = buildSpec(inputOf({ page: { banner: PAGE.banner, teasers } }));
      expect(validateBoxSpecV1(spec, CONTEXT_V2), `${count} teasers`).toEqual(ok);
      const params = decodeCollectionMetadataParams(spec.addOns.find((addOn) => addOn.id === AddOnId.CollectionMetadata)?.params ?? '0x');
      expect(params.bannerSha256).toBe(PAGE.banner?.sha256);
      expect(params.teaserSha256s).toEqual(teasers.map((teaser) => teaser.sha256));
    }
    const teasersOnly = buildSpec(inputOf({ page: { banner: null, teasers: PAGE.teasers } }));
    expect(decodeCollectionMetadataParams(teasersOnly.addOns[0]?.params ?? '0x').bannerSha256).toBe(ZERO32);
  });

  it('the link follows Website while it passes the URL rule, until edited; an edited empty link is none', () => {
    const site = { website: 'https://moons.example/about', x: '', telegram: '' };
    expect(effectivePageLink(formOf({ links: site }))).toBe('https://moons.example/about');
    expect(effectivePageLink(formOf({ links: { ...site, website: 'http://moons.example' } }))).toBe('');
    expect(effectivePageLink(formOf({ links: site, pageLinkEdited: true, pageLink: ' https://other.example ' }))).toBe('https://other.example');
    expect(effectivePageLink(formOf({ links: site, pageLinkEdited: true, pageLink: '' }))).toBe('');
    const spec = buildSpec(inputOf({ form: formOf({ links: site }) }));
    expect(decodeCollectionMetadataParams(spec.addOns[0]?.params ?? '0x')).toEqual({ bannerSha256: ZERO32, teaserSha256s: [], externalLink: 'https://moons.example/about' });
    expect(validateBoxSpecV1(spec, CONTEXT_V2)).toEqual(ok);
  });

  it('contractURI (ERC-7572): name, symbol, description, the collection cover (field 28) as ipfs:// raw CIDv1, banner_image and external_link when set; none for a token', () => {
    const spec = buildSpec(inputOf({ form: formOf({ description: 'Moons on paper.', pageLink: 'https://moons.example', pageLinkEdited: true }), page: PAGE }));
    expect(contractUri(spec)).toEqual({
      name: 'Paper Moons',
      symbol: 'MOON',
      description: 'Moons on paper.',
      image: `ipfs://${rawCidV1(COLLECTION_COVER.sha256)}`,
      banner_image: `ipfs://${rawCidV1(PAGE.banner?.sha256 ?? ZERO32)}`,
      external_link: 'https://moons.example',
    });
    expect(Object.keys(contractUri(buildSpec(inputOf())) ?? {})).toEqual(['name', 'symbol', 'description', 'image']);
    expect(contractUri(buildSpec(inputOf({ form: tokenFormOf() })))).toBeNull();
  });

  it("box 0's contractURI carries the art lane's CIDs exactly: the Sorter as image, banner A as banner_image (F75 U10, U11)", () => {
    // The raw CIDv1 the art lane computed four ways for its final PNGs (branch art-misfits-banner 796eb2f4,
    // docs/design/misfits-v2/banner/final/README.md): the page shows box 0's JSON with exactly these links. The core
    // conformance suite checks the same strings in the built collection's contractURI.
    const json = contractUri(BOX_0_MISFITS);
    expect(json?.image).toBe('ipfs://bafkreicbz6dp3c7ux4mfknchpy24uanydazrnloji6us7hb5rez2sdyr7m');
    expect(json?.banner_image).toBe('ipfs://bafkreifieavwsfyzifdmnuwj3w2tkko5t4debcozagoztco7w4rn3eq27y');
    // No link chosen for box 0: no external_link key.
    expect(Object.keys(json ?? {})).toEqual(['name', 'symbol', 'description', 'image', 'banner_image']);
  });
});

describe('amounts and times', () => {
  it('parses decimal ETH into wei as bigint, refusing anything that is not a plain decimal', () => {
    expect(parseEthText('')).toBe(0n);
    expect(parseEthText(' 0.05 ')).toBe(5n * 10n ** 16n);
    expect(parseEthText('.5')).toBe(5n * 10n ** 17n);
    expect(parseEthText('4.2')).toBe(42n * 10n ** 17n);
    expect(parseEthText('0.000000000000000001')).toBe(1n);
    for (const bad of ['1e3', '-1', '0x10', '1,5', '0.0000000000000000001', 'NaN', '1.2.3']) expect(parseEthText(bad), bad).toBeNull();
  });

  it('turns the opening into openAt: Now 0, a preset the next whole UTC minute that far ahead, a picked UTC time as given', () => {
    const at = NOW / 1000;
    expect(openAtOf({ kind: 'preset', id: 'now' }, NOW)).toBe(0);
    expect(openAtOf({ kind: 'preset', id: '5m' }, NOW)).toBe(at + 300);
    expect(openAtOf({ kind: 'preset', id: '1h' }, NOW + 1_000)).toBe(at + 3_660);
    expect(openAtOf({ kind: 'preset', id: '24h' }, NOW + 59_999)).toBe(at + 86_460);
    // The field is UTC (never this browser's zone): "2026-10-03T13:00" is 13:00 UTC, an hour after NOW (12:00 UTC).
    expect(openAtOf({ kind: 'time', utc: '2026-10-03T13:00' }, NOW)).toBe(at + 3_600);
    expect(openAtOf({ kind: 'time', utc: '2026-10-03T13:00:30' }, NOW)).toBe(at + 3_630);
    expect(openAheadSeconds({ kind: 'time', utc: '2026-10-03T13:00' }, NOW)).toBe(3_600);
    expect(openAheadSeconds({ kind: 'time', utc: '2026-10-03T11:59' }, NOW)).toBe(-60);
    expect(openAheadSeconds({ kind: 'preset', id: '1h' }, NOW)).toBe(3_600);
    // Unreadable or impossible: never Now (0): 1, which validate() refuses; a time before 1970 too.
    for (const utc of ['not a time', '2026-02-30T10:00', '2026-10-03T24:00', '2026-10-03 13:00Z', '']) {
      expect(Number.isNaN(pickedUtcMs(utc)), utc).toBe(true);
      expect(openAtOf({ kind: 'time', utc }, NOW), utc).toBe(1);
    }
    expect(openAtOf({ kind: 'time', utc: '1960-01-01T00:00' }, NOW)).toBe(1);
    expect(utcFieldValue(NOW + 3_600_000)).toBe('2026-10-03T13:00');
    expect(MAX_OPEN_AHEAD_SECONDS).toBe(1_209_600n);
  });

  it('always builds an encodable spec: a far-future time and a huge ETH in stay in their ABI types', () => {
    // Year 9999 is past uint32 seconds (2106): held at uint32's maximum. validate() has no upper bound for openAt (the
    // factory refuses more than 14 days at creation, OpenAtTooFar; the Opening step says so first, reason-copy.test).
    const far = buildSpec(inputOf({ form: formOf({ open: { kind: 'time', utc: '9999-12-31T23:59' } }) }));
    expect(far.openAt).toBe(0xffff_ffff);
    expect(() => encodeBoxSpecV1(far)).not.toThrow();
    expect(() => costEstimate(far)).not.toThrow();
    expect(validateBoxSpecV1(far, CONTEXT_V2)).toEqual(ok);
    const huge = buildSpec(inputOf({ form: formOf({ firstIn: `1${'0'.repeat(80)}` }) }));
    expect(() => encodeBoxSpecV1(huge)).not.toThrow();
    expect(() => costEstimate(huge)).not.toThrow();
    expect(validateBoxSpecV1(huge, CONTEXT_V2)).toEqual({ reason: Reason.OUT_OF_RANGE, field: Field.creatorBuy });
  });

  it('estimates the cost in wei: gas for the box data at 1 gwei, the bootstrap and the creator ETH in', () => {
    const spec = buildSpec(inputOf({ form: formOf({ firstIn: '0.05' }) }));
    const { gas, totalWei } = costEstimate(spec);
    expect(gas).toBe(CREATE_GAS_BASE + CREATE_GAS_PER_BYTE * encodedBytes(spec));
    expect(totalWei).toBe(gas * 1_000_000_000n + BOOTSTRAP_ETH + 5n * 10n ** 16n);
    expect(typeof totalWei).toBe('bigint');
  });

  it('keeps the ticket names within the add-on’s limits and reads series counts as whole numbers', () => {
    expect(ticketNames('A'.repeat(32), 'ABCDEFGHIJK')).toEqual({ name: `${'A'.repeat(25)} ticket`, symbol: 'ABCDEFGHI-T' });
    expect(new TextEncoder().encode(ticketNames('A'.repeat(32), 'X').name).length).toBeLessThanOrEqual(32);
    expect([parseCount('12'), parseCount('0'), parseCount('1.5'), parseCount('-3'), parseCount('')]).toEqual([12, null, null, null, null]);
  });
});

describe('the owner', () => {
  const PASTED = '0x27aeE84839B05524B5A6eb3335D9fC21037059D4';

  it('reads a pasted address: 40 hex digits; mixed case only as its own EIP-55 checksum', () => {
    expect(readPastedOwner(` ${PASTED} `)).toEqual({ address: PASTED, problem: null });
    expect(readPastedOwner(PASTED.toLowerCase())).toEqual({ address: PASTED, problem: null });
    expect(readPastedOwner(`0x${PASTED.slice(2).toUpperCase()}`)).toEqual({ address: PASTED, problem: null });
    expect(readPastedOwner(PASTED.slice(0, -1))).toEqual({ address: null, problem: 'not-an-address' });
    expect(readPastedOwner('vitalik.eth')).toEqual({ address: null, problem: 'not-an-address' });
    // One letter's case changed: not its checksum, so not silently "corrected".
    expect(readPastedOwner(PASTED.replace('aeE', 'aee'))).toEqual({ address: null, problem: 'checksum' });
    expect(readPastedOwner('  ')).toEqual({ address: null, problem: null });
  });

  it('chooses the owner: Demo the persona; chain sources the pasted text when there is any, never the wallet instead', () => {
    expect(chooseOwner(true, OWNER, PASTED)).toEqual({ owner: OWNER, problem: null });
    expect(chooseOwner(false, OWNER, '')).toEqual({ owner: OWNER, problem: null });
    expect(chooseOwner(false, OWNER, PASTED)).toEqual({ owner: PASTED, problem: null });
    expect(chooseOwner(false, OWNER, PASTED.slice(0, -1))).toEqual({ owner: null, problem: 'not-an-address' });
    expect(chooseOwner(false, null, '')).toEqual({ owner: null, problem: null });
    // A mixed case that is not a checksum (Box wallet B's own until SH-254 wrote it checksummed): normalised to EIP-55.
    const personaB = '0xDe00000000000000000000000000000000000B22' as typeof OWNER;
    expect(chooseOwner(true, personaB, '').owner).toBe(getAddress(personaB.toLowerCase()));
    expect(chooseOwner(true, personaB, '').owner).not.toBe(personaB);
  });
});

describe('the art commitment', () => {
  it('orders traits by first appearance and packs one byte per type', () => {
    const { traitTypes, packed } = traitTable(artOf(4).items);
    expect(traitTypes).toEqual([
      { name: 'Colour', values: ['Red', 'Teal', 'Gold'] },
      { name: 'Shape', values: ['Square', 'Circle'] },
    ]);
    // Item 2: Teal (2), Circle (2) → 0x0202; item 4: Red (1), Circle (2) → 0x0201.
    expect(packed).toEqual([0x0101n, 0x0202n, 0x0103n, 0x0201n]);
  });

  it('SH-AI-PLAN: hidden art sorts the table, so it is the same whichever id holds which traits', () => {
    const { traitTypes, packed } = traitTable(artOf(4).items, 'sorted');
    expect(traitTypes).toEqual([
      { name: 'Colour', values: ['Gold', 'Red', 'Teal'] },
      { name: 'Shape', values: ['Circle', 'Square'] },
    ]);
    // Item 1: Red (2), Square (2) → 0x0202; item 2: Teal (3), Circle (1) → 0x0103; item 4: Red (2), Circle (1) → 0x0102.
    expect(packed).toEqual([0x0202n, 0x0103n, 0x0201n, 0x0102n]);
    const shuffled = [...artOf(4).items].reverse().map((item, i) => ({ ...item, id: i + 1 }));
    expect(traitTable(shuffled, 'sorted').traitTypes).toEqual(traitTypes);
    expect(traitTable(shuffled).traitTypes).not.toEqual(traitTable(artOf(4).items).traitTypes);
    // Fix round 1: commitArt sorts every hidden art's table, numbered or planned; open art keeps its first-appearance
    // table (and its commitment, byte for byte).
    const hidden = commitArt(artOf(4), 'hidden');
    expect(hidden?.traitTypes).toEqual(traitTypes);
    expect(hidden?.packed).toEqual(packed);
    expect(commitArt({ ...artOf(4), planned: true }, 'hidden')).toEqual(hidden);
    expect(commitArt(artOf(4), 'open')?.traitTypes).toEqual(traitTable(artOf(4).items).traitTypes);
    expect(commitArt({ ...artOf(4), planned: true }, 'open')).toEqual(commitArt(artOf(4), 'open'));
    expect(hidden?.revealRoot).not.toBe(commitArt(artOf(4), 'open')?.revealRoot);
  });

  it('commits the box tree over every leaf (avatar and model zero) and a reveal list id; refuses unusable art', () => {
    const art = artOf(10);
    const commitment = commitArt(art, 'open');
    const leaves = art.items.map((item, i) => boxLeaf({ id: item.id, traitsPacked: commitment?.packed[i] ?? 0n, imageSha256: item.imageSha256, avatarSha256: ZERO32, modelSha256: ZERO32, salt: art.salts[i] ?? ZERO32 }, 10));
    expect(commitment?.revealRoot).toBe(buildBoxTree(leaves, 10).root);
    expect(commitment?.revealListId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(commitArt({ ...art, salts: art.salts.map((salt, i) => (i === 0 ? ZERO32.replace(/0$/, '1') : salt)) as `0x${string}`[] }, 'open')?.revealRoot).not.toBe(commitment?.revealRoot);
    expect(commitArt(null, 'open')).toBeNull();
    expect(commitArt({ ...art, problems: ['1.png: refused'] }, 'open')).toBeNull();
    expect(commitArt({ ...art, items: art.items.filter((item) => item.id !== 4) , salts: art.salts.slice(1) }, 'hidden')).toBeNull();
  });
});

/**
 * R74-ART (SH-CREATE-ITEM-MODELS): an item's model hash goes into its leaf and its reveal list entry; art without models
 * commits zero there, byte for byte as before this change (the values below are the base commit's, c745f1cd6).
 */
describe('the art commitment with 3D models', () => {
  /** `artOf(n)` with a GLB for every item (its sha256 and size, as art-files `readArt` reads them). */
  const withModels = (art: ArtState, variant = ''): ArtState => ({
    ...art,
    items: art.items.map((item) => ({ ...item, modelSha256: sha256Hex(glbOf(item.id, { variant })), modelBytes: glbOf(item.id, { variant }).byteLength })),
  });
  /** The six-word leaf encoded here with viem, independently of artwork's `boxLeaf`. */
  const leafOf = (id: number, packed: bigint, image: `0x${string}`, model: `0x${string}`, salt: `0x${string}`) => keccak256(encodeAbiParameters(
    ['uint256', 'uint128', 'bytes32', 'bytes32', 'bytes32', 'bytes32'].map((type) => ({ type })), [BigInt(id), packed, image, ZERO32, model, salt]));

  it('2D art commits exactly what it did before models: the same roots, list ids, lists and reveal files', () => {
    const golden = {
      open: { root: '0x16cec3df864d2d3260682e332abb8f4a64ac44e0fec28a4525fa8aad546c31c1', listId: '0x81feeae887d64bbc7512e6b3626193c149df9990ddc9f3a7f2033936750ae0eb', revealFile: '0x5e820484fa579cec2f18c424dec349a85066603205d5e2bce822dc36583f5f88' },
      hidden: { root: '0xe05cf9ea415530a26abff7e5db84713e553b7877ddd96ed97a242c9ea0df22aa', listId: '0x3a74dc776e67e894dec75ea0b47a90df7550bc5da2f54471fee0c431f53c1ac7', revealFile: '0xbd858ccc753761927b445c030c92772656eac63eb5aa9f650a2bc8dd8216f845' },
    } as const;
    for (const mode of ['open', 'hidden'] as const) {
      const art = artOf(12);
      const commitment = commitArt(art, mode);
      expect(commitment?.revealRoot, mode).toBe(golden[mode].root);
      expect(commitment?.revealListId, mode).toBe(golden[mode].listId);
      expect(sha256Hex(new TextEncoder().encode(canonicalJson(revealList(art, commitment?.packed ?? []))))).toBe(golden[mode].listId);
      const file = revealFile(buildSpec(inputOf({ art })), art, commitment as NonNullable<typeof commitment>);
      expect(sha256Hex(new TextEncoder().encode(file.text)), mode).toBe(golden[mode].revealFile);
      expect(revealList(art, commitment?.packed ?? []).items.every((entry) => entry.modelSha256 === ZERO32)).toBe(true);
    }
    expect(artHasModels(artOf(12))).toBe(false);
    expect(modelOf(artOf(1).items[0] as ArtState['items'][number])).toBe(ZERO32);
  });

  it('3D art: each leaf commits its item’s model hash (the six words encoded independently), and so does its list entry', () => {
    for (const mode of ['open', 'hidden'] as const) {
      const art = withModels(artOf(12));
      const commitment = commitArt(art, mode);
      if (!commitment) throw new Error('no commitment');
      const leaves = art.items.map((item, i) => leafOf(item.id, commitment.packed[i] ?? 0n, item.imageSha256, sha256Hex(glbOf(item.id)), art.salts[i] ?? ZERO32));
      expect(leaves[0]).toBe(boxLeaf({ id: 1, traitsPacked: commitment.packed[0] ?? 0n, imageSha256: art.items[0]?.imageSha256 ?? ZERO32, avatarSha256: ZERO32, modelSha256: sha256Hex(glbOf(1)), salt: art.salts[0] ?? ZERO32 }, 12));
      expect(commitment.revealRoot, mode).toBe(buildBoxTree(leaves, 12).root);
      const list = revealList(art, commitment.packed);
      expect(list.items.map((entry) => entry.modelSha256)).toEqual(art.items.map((item) => sha256Hex(glbOf(item.id))));
      expect(list.items.every((entry) => entry.avatarSha256 === ZERO32)).toBe(true);
      expect(commitment.revealListId).toBe(sha256Hex(new TextEncoder().encode(canonicalJson(list))));
      // The same pictures, traits and salts without models commit something else: the model is in the commitment.
      const flat = commitArt(artOf(12), mode);
      expect(commitment.revealRoot).not.toBe(flat?.revealRoot);
      expect(commitment.revealListId).not.toBe(flat?.revealListId);
      expect(commitment.traitTypes).toEqual(flat?.traitTypes);
      expect(commitment.packed).toEqual(flat?.packed);
    }
    expect(artHasModels(withModels(artOf(3)))).toBe(true);
  });

  it('another model for one item changes the root and the list id; a hidden reveal file names each model', () => {
    const art = withModels(artOf(12));
    const commitment = commitArt(art, 'open');
    const changed: ArtState = { ...art, items: art.items.map((item) => (item.id === 7 ? { ...item, modelSha256: sha256Hex(glbOf(7, { variant: 'other' })) } : item)) };
    const other = commitArt(changed, 'open');
    expect(other?.revealRoot).not.toBe(commitment?.revealRoot);
    expect(other?.revealListId).not.toBe(commitment?.revealListId);
    const hidden = inputOf({ form: formOf({ artMode: 'hidden' }), art });
    const file = revealFile(buildSpec(hidden), art, hidden.commitment as NonNullable<typeof hidden.commitment>);
    const body = JSON.parse(file.text) as { items: { id: string; modelSha256: string }[]; revealRoot: string };
    expect(body.items.map((entry) => entry.modelSha256)).toEqual(art.items.map((item) => item.modelSha256));
    expect(body.revealRoot).toBe(hidden.commitment?.revealRoot);
    // The spec commits the new root (and, for open art, the list id): its hash follows the models.
    expect(specHash(buildSpec(inputOf({ art })))).not.toBe(specHash(buildSpec(inputOf({ art: artOf(12) }))));
  });
});

describe('probe and files', () => {
  it('the probe keeps this step’s fields and earlier ones, and resets the later ones to their defaults', () => {
    const form = formOf({ deadlineDays: 90, qStream: QStream.TO_CREATOR, capPerEpoch: 4n * ETH, firstIn: '0.5', rights: true });
    expect(probeForm(form, 'basics')).toMatchObject({ name: 'Paper Moons', contents: null, qStream: QStream.BUYBACK_BURN_T, deadlineDays: 30, firstIn: '' });
    expect(probeForm(form, 'contents')).toMatchObject({ contents: 'collection', qStream: QStream.BUYBACK_BURN_T, capPerEpoch: 0n, deadlineDays: 30 });
    expect(probeForm(form, 'kind')).toMatchObject({ qStream: QStream.TO_CREATOR, capPerEpoch: 4n * ETH, deadlineDays: 30, firstIn: '' });
    expect(probeForm(form, 'raise')).toMatchObject({ deadlineDays: 90, firstIn: '', rights: false });
    expect(probeForm(form, 'launch')).toMatchObject({ deadlineDays: 90, firstIn: '0.5', rights: true });
    expect(probeForm(form, 'overview')).toBe(form);
  });

  it('the rights record: this spec, the creator, the statement version and when (never in the spec)', () => {
    const spec = buildSpec(inputOf());
    expect(rightsRecord(specHash(spec), OWNER, NOW)).toEqual({ specHash: specHash(spec), creator: OWNER, statement: RIGHTS_STATEMENT_VERSION, confirmedAt: '2026-10-03T12:00:00.000Z' });
    expect(Object.keys(spec)).not.toContain('rights');
  });

  it('Download BoxSpec: the context, the wire form with decimal strings, the encoding and the hash that encoding gives', () => {
    const input = inputOf({ form: formOf({ firstIn: '0.05' }) });
    const spec = buildSpec(input);
    const art = input.art as NonNullable<typeof input.art>;
    const commitment = input.commitment as NonNullable<typeof input.commitment>;
    const file = boxSpecFile(spec, { builtAtMs: NOW, cover: COVER, revealList: revealList(art, commitment.packed) });
    expect(file.name).toBe('moon-boxspec-v1.json');
    const body = JSON.parse(file.text) as { context: string; network: string; specHash: string; encoded: `0x${string}`; spec: Record<string, unknown>; builtAt: string; cover: { sha256: string; base64: string }; revealList: unknown };
    expect(body.context).toBe('v2');
    // No network given: the strictest (mainnet), what validate() accepts everywhere.
    expect(body.network).toBe('mainnet');
    expect(JSON.parse(boxSpecFile(spec, { builtAtMs: NOW, cover: COVER, revealList: null, network: 'demo' }).text).network).toBe('demo');
    expect(body.encoded).toBe(encodeBoxSpecV1(spec));
    expect(specHash(decodeBoxSpecV1(body.encoded))).toBe(body.specHash);
    expect(body.specHash).toBe(specHash(spec));
    expect(body.spec.raise).toBe('4206980085000000000');
    expect(body.spec.creatorBuy).toBe('50000000000000000');
    expect(body.builtAt).toBe('2026-10-03T12:00:00.000Z');
  });

  it('the BoxSpec file carries what the spec commits to: the logo’s and the collection cover’s bytes and, for open art, the reveal list', () => {
    const input = inputOf();
    const spec = buildSpec(input);
    const art = input.art as NonNullable<typeof input.art>;
    const commitment = input.commitment as NonNullable<typeof input.commitment>;
    const body = JSON.parse(boxSpecFile(spec, { builtAtMs: NOW, cover: COVER, collectionCover: COLLECTION_COVER, revealList: revealList(art, commitment.packed) }).text) as {
      cover: { base64: string };
      collectionCover: { base64: string };
      revealList: Parameters<typeof canonicalJson>[0];
    };
    expect(sha256Hex(fromBase64(body.cover.base64) ?? new Uint8Array())).toBe(spec.coverSha256);
    expect(sha256Hex(fromBase64(body.collectionCover.base64) ?? new Uint8Array())).toBe(spec.collectionCoverSha256);
    expect(sha256Hex(new TextEncoder().encode(canonicalJson(body.revealList)))).toBe(spec.revealListId);
  });

  it('§ 4.3: the file carries the banner’s and teasers’ bytes (their hashes in add-on 6), the contractURI JSON and the site record', () => {
    const links = { website: 'https://moons.example', x: '@moons', telegram: 'not a link' };
    const input = inputOf({ form: formOf({ artMode: 'hidden', links, storeAll: true }), page: PAGE });
    const spec = buildSpec(input);
    const rights = rightsRecord(specHash(spec), OWNER, NOW);
    const body = JSON.parse(boxSpecFile(spec, { builtAtMs: NOW, cover: COVER, page: PAGE, revealList: null, links, rights, storeAll: true }).text) as {
      banner: { sha256: string; base64: string };
      teasers: { sha256: string; base64: string }[];
      contractURI: Record<string, string>;
      site: { links: Record<string, string>; rights: unknown; storage: string };
      revealList: unknown;
    };
    const params = decodeCollectionMetadataParams(spec.addOns.find((addOn) => addOn.id === AddOnId.CollectionMetadata)?.params ?? '0x');
    expect(sha256Hex(fromBase64(body.banner.base64) ?? new Uint8Array())).toBe(params.bannerSha256);
    expect(body.teasers.map((teaser) => sha256Hex(fromBase64(teaser.base64) ?? new Uint8Array()))).toEqual(params.teaserSha256s);
    expect(body.contractURI).toEqual(contractUri(spec));
    // Only usable links are kept; hidden art is never "all art permanently"; no reveal list for hidden art.
    expect(body.site).toEqual({ links: { website: 'https://moons.example', x: '@moons', telegram: '' }, rights, storage: 'pictures' });
    expect(body.revealList).toBeNull();
  });

  it('a token-only file: no collection cover, no banner, no teasers, no contractURI (no collection)', () => {
    const spec = buildSpec(inputOf({ form: tokenFormOf() }));
    const body = JSON.parse(boxSpecFile(spec, { builtAtMs: NOW, cover: COVER, collectionCover: COLLECTION_COVER, page: PAGE, revealList: null }).text) as {
      collectionCover: unknown;
      banner: unknown;
      teasers: unknown[];
      contractURI: unknown;
      site: { storage: string; rights: unknown };
    };
    expect([body.collectionCover, body.banner, body.teasers, body.contractURI, body.site.storage, body.site.rights]).toEqual([null, null, [], null, 'pictures', null]);
    expect(EMPTY_PAGE).toEqual({ banner: null, teasers: [] });
  });

  it('the reveal file lists every item’s number, packed traits, art hash and salt, and the root', () => {
    const input = inputOf({ form: formOf({ artMode: 'hidden' }) });
    const file = revealFile(buildSpec(input), input.art as NonNullable<typeof input.art>, input.commitment as NonNullable<typeof input.commitment>);
    const body = JSON.parse(file.text) as { items: { id: string; salt: string; imageSha256: string }[]; revealRoot: string };
    expect(file.name).toBe('moon-reveal-file.json');
    expect(body.items).toHaveLength(12);
    expect(body.items[0]).toMatchObject({ id: '1', salt: input.art?.salts[0], imageSha256: input.art?.items[0]?.imageSha256 });
    expect(body.revealRoot).toBe(input.commitment?.revealRoot);
  });
});
