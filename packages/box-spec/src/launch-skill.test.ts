/**
 * F73 launch skill, review rounds: "how the creator is paid" per fee side, what the launch flow cannot enter,
 * secret-shaped input, raw add-on entries with a bad id, --field sizes, the skill's own scripts/check.mjs, and the
 * check that "coming soon" prose does not outlive the spec. All on the real spec, as box creation flow v2 shaped it:
 * a fee kind per side, token-only boxes, the creator-fee cap and the collection page.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import {
  EXIT,
  MARKER,
  SECRET_MESSAGE,
  checkField,
  approxText,
  checkSpec,
  modelFor,
  numbersOf,
  percentText,
  plainWordUnits,
  renderField,
  renderMenu,
  renderText,
  secretKind,
  soonFindings,
  utcText,
} from '../scripts/lib/check-spec.mjs';
import * as lib from './index';
import * as twinV2 from './generated/box-spec.v2';

const model = modelFor(lib);
const pkgDir = join(__dirname, '..');
const repoDir = join(pkgDir, '../..');
const skillDir = join(repoDir, 'skills/square-hole-launch');
const examplesDir = join(skillDir, 'references/examples');
const cli = join(pkgDir, 'scripts/check-spec.mjs');
const wrapper = join(skillDir, 'scripts/check.mjs');
const fixture = (name: string) => JSON.parse(readFileSync(join(pkgDir, 'fixtures', `${name}.json`), 'utf8'));

describe('M211 launch drafts', () => {
  const runM2 = (...args: string[]) => spawnSync(process.execPath, [wrapper, ...args, '--format', '2', '--network', 'demo'], { encoding: 'utf8', cwd: repoDir });
  it('offers holders and shops in the skill menu, with no deferred-feature promises', () => {
    const r = runM2('--menu');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('to holders');
    expect(r.stdout).toContain('shop');
    expect(r.stdout).not.toMatch(/holders arrives|holders come|holders.*not built/i);
  });
  it.each(['holder-payout', 'stock-payout', 'junkyard-shop'])('checks the labelled %s example through the skill', (name) => {
    const file = join(skillDir, 'references/v2/examples', `${name}.json`);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    expect(doc.spec.description).toMatch(/^Demo:/);
    expect(doc.brief).toMatch(/example/i);
    const r = runM2(file);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    if (name === 'stock-payout') {
      expect(r.stdout).toMatch(/holders in NVDAon/);
      expect(r.stdout).toMatch(/no conversion/i);
    }
    if (name === 'junkyard-shop') {
      expect(r.stdout).toContain('10%'); expect(r.stdout).toContain('2.5%'); expect(r.stdout).toContain('7 days');
      expect(r.stdout).toMatch(/seed and pick receipts/);
      expect(r.stdout).toMatch(/quarantined/);
      expect(r.stdout).not.toContain('just the token');
    }
  });
});

describe('M311 launch drafts', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [wrapper, ...args, '--format', '2', '--network', 'demo'], { encoding: 'utf8', cwd: repoDir });
  it('offers every-item policies and same-P fee piles without obsolete promises', () => {
    const r = run('--menu');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('to items'); expect(r.stdout).toMatch(/coin pile.*To the pile/s);
    expect(r.stdout).toMatch(/Keep.*BuyBackBurn/);
    expect(r.stdout).toMatch(/payouts are claim-only/i);
    expect(r.stdout).toMatch(/owner claims have no minimum or tip/i);
    expect(r.stdout).not.toMatch(/wait for M3|items.*not built/i);
  });
  it.each(['bag-holders', 'dragons-hoard', 'exit-liquidity'])('checks the Demo %s example, without a new preset', (name) => {
    const file = join(skillDir, 'references/v2/examples', `${name}.json`);
    const d = JSON.parse(readFileSync(file, 'utf8'));
    expect(d.spec.description).toMatch(/^Demo:/); expect(d.brief).toMatch(/example/i);
    expect(d.preset).toBeUndefined();
    expect(JSON.stringify(d)).not.toMatch(/\bAPY\b|guaranteed|passive income|yield/i);
    const r = run(file);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    if (name === 'bag-holders') {
      expect(d.spec.buyers.a.destParams).toEqual({ insidePolicy: 'Keep' });
      expect(r.stdout).toMatch(/every item in LINK/); expect(r.stdout).toMatch(/timing gap/i);
      expect(r.stdout).not.toMatch(/claimFor|permissionless push|creation-time minimum/i);
    }
    if (name === 'dragons-hoard') {
      expect(r.stdout).toMatch(/500 basis points/); expect(r.stdout).toMatch(/stranded/);
    }
  });
});

describe('M311 F127 claim-only launch guidance', () => {
  const obsolete = /\bclaimFor\b|\bpush(?:ed)?[\s-]+(?:claims?|payouts?)\b|\bpermissionless[\s-]+push\b|\bwallet[\s-]+owner[\s-]+only\b|\bcreation[\s-]+time[\s-]+minimum\b/i;
  const draftFiles = ['examples', 'configurations', 'presets'].flatMap((dir) =>
    readdirSync(join(skillDir, 'references/v2', dir)).filter((file) => file.endsWith('.json')).map((file) => `${dir}/${file}`),
  );
  it.each(draftFiles)('%s renders owner claims without pushed-claim wording', async (file) => {
    const launch = await import('../scripts/lib/' + 'spec-launch-v2.mjs');
    const doc = JSON.parse(readFileSync(join(skillDir, 'references/v2', file), 'utf8'));
    const draft = file.startsWith('presets/') ? launch.fromPreset(doc) : doc;
    const result = launch.checkSpecV2(launch.modelForV2({ network: doc.network ?? 'demo', twin: twinV2 }), draft);
    expect(result.ok, JSON.stringify(result.problems ?? result.explanation)).toBe(true);
    const text = launch.renderTextV2(result);
    expect(text).not.toMatch(obsolete);
    expect(text).toMatch(/payouts are claim-only/i);
    expect(text).toMatch(/owner claims have no minimum or tip/i);
    expect(text).toMatch(/FIT and platform Safes claim their own/i);
    // Presentation changes must preserve the generated wire and its hash.
    expect(result.specHash).toBe(twinV2.specHashV2(result.wire));
  });
  it('keeps all skill prose and saved drafts free of pushed-claim wording', () => {
    const files = readdirSync(skillDir, { recursive: true, encoding: 'utf8' }).filter((file) => /\.(?:md|json)$/.test(file));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(readFileSync(join(skillDir, file), 'utf8'), file).not.toMatch(obsolete);
  });
  it.each(['SKILL.md', 'references/v2/spec-json.md', 'references/v2/README.md'])('%s explains owner-only payouts', (file) => {
    const text = readFileSync(join(skillDir, file), 'utf8');
    expect(text).toMatch(/payouts are claim-only/i);
    expect(text).toMatch(/owner claims have no minimum or tip/i);
    expect(text).toMatch(/wallets, contracts and EIP-7702 owners.*same.*claim/i);
  });
});

type Draft = { format: string; context: string; brief?: string; site?: unknown; spec: Record<string, unknown> };
const example = (name: string): Draft => JSON.parse(readFileSync(join(examplesDir, `${name}.json`), 'utf8'));
/** Example 3 (a burn box: a new collection, open art, royalties into the pool) with a patch. */
const box = (patch: (spec: Record<string, unknown>) => void = () => undefined): Draft => {
  const doc = example('staking-snails');
  patch(doc.spec);
  return doc;
};

// ------------------------------------------------------------------------------------------------ creator pay

const payNote = (notes: string[]) => notes.find((n) => n.startsWith('How the creator is paid')) ?? '';
const notesFor = (doc: Draft) => {
  const result = checkSpec(model, doc);
  expect(result.ok, JSON.stringify(result.explanation ?? result.problems)).toBe(true);
  return result.notes ?? [];
};
const creatorDraft = (q: string, t: string) => {
  const doc = example('gas-guzzlers');
  Object.assign(doc.spec, { qStream: q, tStream: t });
  return doc;
};

describe('how the creator is paid follows each fee side', () => {
  it('both sides to the creator, as collected', () => {
    expect(payNote(notesFor(example('gas-guzzlers')))).toBe(
      "How the creator is paid: never the raise (it becomes the box's pool), only 10/15 of the 1% fee on the fee sides chosen. Buyers' fees: to the creator in ETH, about 0.0067 ETH per 1 ETH bought. Sellers' fees: to the creator in GUZZ, 10/15 of 1% of the GUZZ sold (selling it later is visible on chain). Fees from the curve are held until graduation and go into the refund range if the box fails.",
    );
    expect(payNote(notesFor(box()))).toBe('');
  });

  it('one side to the creator, the other burned: nothing is paid from the burned side', () => {
    const note = payNote(notesFor(creatorDraft('TO_CREATOR', 'BURN_T')));
    expect(note).toContain("Buyers' fees: to the creator in ETH, about 0.0067 ETH per 1 ETH bought. Sellers' fees: nothing to the creator (Burn GUZZ).");
    expect(note).not.toContain('to the creator in GUZZ');
    const other = payNote(notesFor(creatorDraft('BUYBACK_BURN_T', 'TO_CREATOR')));
    expect(other).toContain("Buyers' fees: nothing to the creator (Buy back and burn GUZZ). Sellers' fees: to the creator in GUZZ");
  });

  it('converted kinds pay in the other currency, with the buy or sell note', () => {
    const inQ = notesFor(creatorDraft('BUYBACK_BURN_T', 'CREATOR_IN_Q'));
    expect(payNote(inQ)).toContain("Sellers' fees: to the creator in ETH, from selling 10/15 of 1% of the GUZZ sold after graduation.");
    expect(inQ).toContain('To the creator, in ETH: the box sells GUZZ for ETH after graduation in small limited steps. That is steady sell pressure; buyers see a warning on the box page.');
    const inT = notesFor(creatorDraft('CREATOR_IN_T', 'TO_CREATOR'));
    expect(payNote(inT)).toContain("Buyers' fees: to the creator in GUZZ, bought after graduation with about 0.0067 ETH per 1 ETH bought. Sellers' fees: to the creator in GUZZ, 10/15 of 1% of the GUZZ sold");
    expect(inT.some((n) => n.startsWith('To the creator, in GUZZ: the box buys GUZZ with ETH'))).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ launch flow

describe('what the launch flow cannot enter', () => {
  const gapsOf = (doc: Draft) => (checkSpec(model, doc).warnings ?? []).filter((w) => w.startsWith('The launch flow cannot enter this yet'));

  it('takes any fee pair the check accepts, each side on its own', () => {
    expect(checkSpec(model, box((s) => Object.assign(s, { qStream: 'ALL_TO_FIT', tStream: 'SELL_FOR_Q' })))).toMatchObject({ ok: true, enterable: true });
    expect(checkSpec(model, creatorDraft('TO_CREATOR', 'BURN_T'))).toMatchObject({ ok: true, enterable: true });
    expect(renderMenu(model)).toContain('The launch flow offers each side on its own: any pair the check accepts.');
  });

  it('flags a generator hash, royalties at 0%, an empty collection page and more series than it takes, also in the headline', () => {
    const hash = checkSpec(model, box((s) => (s.generatorHash = `0x${'11'.repeat(32)}`)));
    expect(hash).toMatchObject({ ok: true, enterable: false });
    expect(hash.warnings).toEqual(['The launch flow cannot enter this yet: a generator hash (it always writes zero). Write "generatorHash": "0x0".']);
    expect(renderText(hash)).toMatch(/^Valid draft: .* accepts this spec, but the launch flow cannot enter all of it yet \(see Check first\)\.\n/);
    expect(gapsOf(box((s) => (s.addOns = [{ addOn: 'royalties', params: { bps: 0, destination: 'FEE_HANDLING' } }])))[0]).toMatch(/royalties at 0%/);
    const page = (params: Record<string, unknown>) => box((s) => (s.addOns = [{ addOn: 'collection-metadata', params }]));
    expect(gapsOf(page({ bannerSha256: '0x0', teaserSha256s: [], externalLink: '' }))).toEqual([
      'The launch flow cannot enter this yet: a collection page with no banner, teasers or link (it leaves the add-on out then). Remove the collection-metadata add-on.',
    ]);
    expect(gapsOf(page({ bannerSha256: '0x0', teaserSha256s: [], externalLink: 'https://snails.example' }))).toEqual([]);
    expect(gapsOf(page({ bannerSha256: MARKER, teaserSha256s: [], externalLink: '' }))).toEqual([]);
    const series = Array.from({ length: 5 }, (_, i) => ({ addOn: 'edition-specials', params: { label: `S${i}`, count: 1 } }));
    expect(gapsOf(box((s) => (s.addOns = series)))).toEqual(['The launch flow cannot enter this yet: 5 of "Special series" (it takes at most 4). Merge or drop some.']);
    expect(gapsOf(box((s) => (s.addOns = series.slice(0, 4))))).toEqual([]);
  });

  it('reads "FROM_LAUNCH_FLOW" for the generator hash as the launch flow\'s zero', () => {
    const marker = checkSpec(model, box((s) => (s.generatorHash = MARKER)));
    expect(marker).toMatchObject({ ok: true, enterable: true });
    expect(marker.launchFlow).toContain('generatorHash');
    expect(marker.specHash).toBe(checkSpec(model, box()).specHash);
  });

  it('counts the collection owner only when set: a token-only box paying the creator can be entered', () => {
    for (const [q, t] of [['TO_CREATOR', 'BURN_T'], ['BUYBACK_BURN_T', 'TO_CREATOR'], ['TO_CREATOR', 'TO_CREATOR']]) {
      const plain = example('gm-coin');
      Object.assign(plain.spec, { qStream: q, tStream: t, creatorFeeRecipient: MARKER });
      const result = checkSpec(model, plain);
      expect(result, `${q} / ${t}`).toMatchObject({ ok: true, enterable: true, warnings: [] });
      expect(Object.fromEntries(result.overview ?? []).Contents).toBe('Just the token');
    }
    expect(checkSpec(model, fixture('demo-token-only'))).toMatchObject({ ok: true, enterable: true, warnings: [] });
    // A collection still takes one address for its owner and the payout.
    const two = box((s) => Object.assign(s, { qStream: 'TO_CREATOR', creatorFeeRecipient: '0xdce82e76456434d0f550b492ff212a862221e6c5' }));
    expect(gapsOf(two)).toEqual(['The launch flow cannot enter this yet: different addresses for collection owner, fee payout and royalties (it uses one address for all three). Use one address (a team Safe works).']);
  });

  it('every worked example can be entered', () => {
    for (const file of readdirSync(examplesDir).filter((f) => f.endsWith('.json') && f !== 'waiting.json')) {
      expect(checkSpec(model, JSON.parse(readFileSync(join(examplesDir, file), 'utf8'))), file).toMatchObject({ ok: true, enterable: true });
    }
  });

  it('shows the collection page without fingerprints, and warns about teasers with hidden art', () => {
    const owls = checkSpec(model, example('ultrasound-owls'));
    const addOns = Object.fromEntries(owls.overview ?? [])['Add-ons'] ?? '';
    expect(addOns).toContain('Collection page (banner, teasers, link): a banner (uploaded in the launch flow), 3 teasers, no link');
    expect(JSON.stringify(owls.overview)).not.toMatch(/0x[0-9a-f]{64}/i);
    expect(owls.notes?.some((n) => n.includes("never use an item's own picture as a teaser"))).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ secrets

const KEY = `0x${'4c0883a69102937d6231471b5dbb6204fe512961708279f2b3a3e8f7c4a5d6e1'}`;
const PHRASE = 'test test test test test test test test test test test junk';
const PHRASE_24 = 'abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual';
/** A phrase as a phone keyboard writes it (first word capitalised), and one joined by commas without spaces. */
const SENTENCE = 'Abandon ability able about above absent absorb abstract absurd abuse access accident';
const COMMAS = 'abandon,ability,able,about,above,absent,absorb,abstract,absurd,abuse,access,accident';
/** Not echoed in any case: the phrase's second and third words. */
const echoes = (text: string) => /ability able|ability,able/i.test(text);

describe('secret-shaped input is never repeated', () => {
  it('knows a private key and a recovery phrase, not a fingerprint of zeros or ordinary text', () => {
    for (const text of [KEY, KEY.slice(2), `my key: ${KEY}`, PHRASE, PHRASE_24, `words: 1. ${PHRASE.split(' ').join(' 2. ')}`]) expect(secretKind(text), text.slice(0, 20)).not.toBeNull();
    for (const text of [SENTENCE, SENTENCE.toUpperCase(), COMMAS, COMMAS.replace(/,/g, '; '), `My words: ${SENTENCE}.`]) expect(secretKind(text), text.slice(0, 20)).toBe('phrase');
    for (const text of [`0x${'0'.repeat(64)}`, `0x${'ab'.repeat(31)}`, `0x${'ab'.repeat(33)}`, 'Demo: 100 toy fuel cans from the 2021 gas wars.', 'owls that only hoot about the burn every night under the moon and stars above us']) {
      expect(secretKind(text), text.slice(0, 20)).toBeNull();
    }
    for (const file of readdirSync(examplesDir).filter((f) => f.endsWith('.json'))) {
      const doc = JSON.parse(readFileSync(join(examplesDir, file), 'utf8'));
      for (const text of [doc.brief, doc.spec?.description, ...(doc.differences ?? []), ...(doc.deviations ?? [])]) expect(secretKind(text), `${file}: ${text}`).toBeNull();
    }
  });

  it('stops the check with the paths only, in text and JSON', () => {
    const cases: [Draft, string[]][] = [
      [box((s) => (s.marketplaceOwner = KEY)), ['spec.marketplaceOwner']],
      [{ ...box(), brief: `my phrase is ${PHRASE}` }, ['brief']],
      [box((s) => (s[KEY.slice(2)] = 1)), ['spec.<hidden> (a field name)']],
      [box((s) => (s.addOns = [{ addOn: 'royalties', params: { bps: 100, destination: 'CREATOR', recipient: PHRASE } }])), ['spec.addOns[0].params.recipient']],
    ];
    for (const [doc, paths] of cases) {
      const result = checkSpec(model, doc);
      expect(result).toMatchObject({ ok: false, stage: 'secret', paths });
      const shown = `${renderText(result)}${JSON.stringify(result)}`;
      expect(shown).toContain(SECRET_MESSAGE);
      expect(shown).not.toContain(KEY.slice(2, 20));
      expect(shown).not.toContain('test test test');
    }
  });

  it('accepts fingerprints where the format puts them: a download with its hashes, pictures, salts and rights record', () => {
    const spec = Object.fromEntries(Object.entries(lib.DEMO_OPEN_ART).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
    const salt = `0x${'5a'.repeat(32)}`;
    const hash = lib.specHash(lib.DEMO_OPEN_ART);
    const picture = { sha256: KEY, base64: 'AAAA' };
    // As apps/web create-model `boxSpecFile` writes it (launch-skill-download.test.ts builds the page's own file).
    const file = {
      format: 'squarehole.boxspec/1',
      context: 'v2',
      specHash: hash,
      encoded: lib.encodeBoxSpecV1(lib.DEMO_OPEN_ART),
      spec,
      cover: { sha256: salt, base64: 'AAAA' },
      // F74 U3: the collection's own cover, beside the logo.
      collectionCover: picture,
      banner: picture,
      teasers: [picture, picture],
      revealList: { items: [{ id: '1', imageSha256: salt, avatarSha256: `0x${'0'.repeat(64)}`, modelSha256: `0x${'0'.repeat(64)}`, salt }] },
      site: { links: ['https://example.org'], rights: { specHash: hash, creator: '0xdce82e76456434d0f550b492ff212a862221e6c5', statement: 'rights-statement-draft-1', confirmedAt: '2026-10-03T12:00:00.000Z' }, storage: 'pictures' },
    };
    expect(checkSpec(model, file)).toMatchObject({ ok: true, kind: 'download' });
    expect(checkSpec(model, { ...file, note: salt })).toMatchObject({ stage: 'secret', paths: ['note'] });
    // Only there: the same value one level off is not a fingerprint the format has.
    expect(checkSpec(model, { ...file, banner: { ...picture, extra: KEY } })).toMatchObject({ stage: 'secret', paths: ['banner.extra'] });
    expect(checkSpec(model, { ...file, collectionCover: { ...picture, extra: KEY } })).toMatchObject({ stage: 'secret', paths: ['collectionCover.extra'] });
    expect(checkSpec(model, { ...file, site: { ...file.site, rights: { ...file.site.rights, creator: KEY } } })).toMatchObject({ stage: 'secret', paths: ['site.rights.creator'] });
    // A draft has no such fields: a "banner" beside its spec is not a fingerprint.
    expect(checkSpec(model, { ...box(), banner: picture })).toMatchObject({ stage: 'secret', paths: ['banner.sha256'] });
  });

  it('never repeats a long value it cannot read', () => {
    const almost = `0x${'ab'.repeat(31)}c`;
    const result = checkSpec(model, box((s) => (s.marketplaceOwner = almost)));
    expect(result.stage).toBe('input');
    expect(JSON.stringify(result)).not.toContain(almost.slice(2));
    expect(result.problems[0]?.message).toBe('This is not a full address: it has 63 hex characters after 0x, an address has 40.');
  });

  it('--field does not echo it either', () => {
    for (const text of [PHRASE, SENTENCE, COMMAS]) {
      const result = checkField(model, 'description', text);
      expect(result).toMatchObject({ ok: false, secret: true });
      expect(renderField(result)).not.toContain('test test');
      expect(echoes(`${renderField(result)}${JSON.stringify(result)}`)).toBe(false);
      expect(renderField(result)).toContain(SECRET_MESSAGE);
    }
  });

  it('stops on a phrase in sentence case or joined by commas, never showing it in the overview', () => {
    for (const doc of [box((s) => (s.description = SENTENCE)), box((s) => (s.description = COMMAS)), { ...box(), brief: COMMAS }]) {
      const result = checkSpec(model, doc);
      expect(result).toMatchObject({ ok: false, stage: 'secret' });
      expect(result.overview).toBeUndefined();
      expect(echoes(`${renderText(result)}${JSON.stringify(result)}`)).toBe(false);
    }
    // Ordinary sentence-case text stays readable.
    const plain = checkSpec(model, box((s) => (s.description = 'Demo: Slow snails that stake and never hurry. Every fee burns SLOW.')));
    expect(plain.ok).toBe(true);
  });
});

/** The BIP-39 test vector (checksum valid), as words, and a phrase one word short. */
const VECTOR = 'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' ');
const ELEVEN = VECTOR.slice(0, 11).join(' ');
/** A complete phrase of 12 different words with a valid checksum (generated for this test). */
const UNIQUE = 'boring lend hip grain solve slam parade ripple infant letter hope upper'.split(' ');
const HEX = KEY.slice(2);
/** Not echoed: two neighbouring words of a phrase, or a run of the key, in any case and joined any way. */
const leaks = (text: string) => /winner\W*thank|lend\W*hip/i.test(text) || text.toLowerCase().includes(HEX.slice(8, 24)) || text.includes('83a6 9102');

/** Each form a key or phrase was pasted in during the review (122 of 280 probes went through). */
const FORMS: [string, string][] = [
  ['numbering fused to the word', VECTOR.map((w, i) => `${i + 1}.${w}`).join(' ')],
  ['numbering with ")"', VECTOR.map((w, i) => `${i + 1})${w}`).join(' ')],
  ['numbering with "-"', VECTOR.map((w, i) => `${i + 1}-${w}`).join(' ')],
  ['joined by "-"', VECTOR.join('-')],
  ['joined by "/"', VECTOR.join('/')],
  ['joined by "."', VECTOR.join('.')],
  ['joined by "_"', VECTOR.join('_')],
  ['joined by " | "', VECTOR.join(' | ')],
  ['one word per line', VECTOR.join('\n')],
  ['11 of the 12 words', ELEVEN],
  ['a key in groups of 4', HEX.match(/.{4}/g)?.join(' ') ?? ''],
  ['a key with colons', HEX.match(/.{2}/g)?.join(':') ?? ''],
  ['a key in 4 lines', HEX.match(/.{16}/g)?.join('\n') ?? ''],
  ['a key one character short', `0x${HEX.slice(1)}`],
];

describe('secret-shaped input in every form stops with exit 4 and is never repeated', () => {
  it.each(FORMS)('%s: in a text, in --field and in a file', (_name, text) => {
    expect(secretKind(text)).not.toBeNull();
    const field = checkField(model, 'description', text);
    expect(field).toMatchObject({ ok: false, secret: true });
    expect(leaks(`${renderField(field)}${JSON.stringify(field)}`)).toBe(false);
    for (const doc of [box((s) => (s.description = text)), { ...box(), brief: text }, { ...box(), site: { links: [text] } }]) {
      const result = checkSpec(model, doc);
      expect(result.stage).toBe('secret');
      expect(leaks(`${renderText(result)}${JSON.stringify(result)}`)).toBe(false);
    }
  });

  it('a phrase stored one word per item, split over fields, or as field names', () => {
    const cases: [Draft | Record<string, unknown>, string][] = [
      [{ ...box(), brief: VECTOR }, 'brief'],
      [{ ...box(), site: { links: VECTOR.map((w) => w.toUpperCase()) } }, 'site.links'],
      [{ format: 'squarehole.boxspec-draft/1', context: 'v2', brief: VECTOR.slice(0, 6).join(' '), note: VECTOR.slice(6).join(', '), spec: box().spec }, 'brief, note (read together)'],
      [{ ...box(), notes: Object.fromEntries(UNIQUE.map((w, i) => [w, i])) }, 'field names in notes'],
      [{ ...box(), brief: HEX.match(/.{8}/g) ?? [] }, 'brief'],
    ];
    for (const [doc, where] of cases) {
      const result = checkSpec(model, doc);
      expect(result, where).toMatchObject({ stage: 'secret', paths: [where] });
      expect(leaks(`${renderText(result)}${JSON.stringify(result)}`)).toBe(false);
    }
  });

  it('trait values count as a phrase only when they are one, checksum and all', () => {
    const table = (values: string[]) => box((s) => (s.metadataTable = { formatV1: { traitTypes: [{ name: 'Word', values }] } }));
    expect(checkSpec(model, table(UNIQUE))).toMatchObject({ stage: 'secret', paths: ['spec.metadataTable.formatV1.traitTypes[0].values'] });
    // Twelve colours that are all BIP-39 words, but no phrase: an ordinary trait.
    const colours = ['Blue', 'Green', 'Yellow', 'Orange', 'Black', 'Pink', 'Brown', 'Gold', 'Silver', 'Bronze', 'Cream', 'Olive'];
    expect(checkSpec(model, table(colours))).toMatchObject({ ok: true });
  });

  it('ordinary text, numbers and ids stay readable', () => {
    for (const text of [
      'Demo: Slow snails that stake and never hurry. Every fee burns SLOW.',
      'Well-known, hand-made, one-of-a-kind: owls/hoots/stars for the late-night crowd.',
      '430382728641945839370457556529299350181648059658711354099407104',
      '550e8400-e29b-41d4-a716-446655440000 6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      '1,000 snails in no hurry. Withdrawals take a while; the shell is worth it.',
      `0x${'ab'.repeat(31)}c`,
    ]) {
      expect(secretKind(text), text).toBeNull();
    }
    for (const file of readdirSync(examplesDir).filter((f) => f.endsWith('.json'))) {
      expect(checkSpec(model, JSON.parse(readFileSync(join(examplesDir, file), 'utf8'))).stage, file).not.toBe('secret');
    }
  });

  it('never repeats the brief, a long unknown field name or a long bad link', () => {
    const brief = 'My brief: owls for the whole family, launched on a Sunday.';
    expect(JSON.stringify(checkSpec(model, { ...box(), brief }))).not.toContain('owls for the whole');
    const name = 'a-field-name-that-is-really-a-pasted-note-of-sixty-characters';
    const unknown = checkSpec(model, box((s) => (s[name] = 1)));
    expect(unknown.problems[0]).toMatchObject({ path: `(a ${name.length}-character field name)` });
    expect(JSON.stringify(unknown)).not.toContain(name);
    const link = 'this-is-not-a-link-but-a-pasted-sentence-of-text.example';
    const result = checkSpec(model, { ...box(), site: { links: [link] } });
    expect(result.warnings?.find((w) => w.startsWith('This link is not used'))).toBe(`This link is not used: a ${link.length}-character text (links must start with https:// and contain no spaces; X also takes an @handle).`);
    expect(JSON.stringify(result)).not.toContain(link);
    expect(checkSpec(model, { ...box(), site: { links: ['guzz.example'] } }).warnings).toContain('This link is not used: "guzz.example" (links must start with https:// and contain no spaces; X also takes an @handle). Did you mean "https://guzz.example"?');
  });
});

// ------------------------------------------------------------------------------------------------ add-on ids

describe('raw add-on entries with a bad id', () => {
  it.each([70003, -1, 3.5, '1', null])('id %s is reported as a problem in the JSON, not a crash', (id) => {
    const result = checkSpec(model, box((s) => (s.addOns = [{ id, params: '0x' }])));
    expect(result.stage).toBe('input');
    expect(result.problems[0]?.path).toBe('addOns[0].id');
    expect(result.problems[0]?.message).toMatch(/is not an add-on id: ids are whole numbers from 0 to 65,535/);
  });

  it('reports bad params hex the same way', () => {
    expect(checkSpec(model, box((s) => (s.addOns = [{ id: 3, params: 'zz' }]))).problems[0]?.path).toBe('addOns[0].params');
  });
});

// ------------------------------------------------------------------------------------------------ --field sizes

describe('--field counts characters and suggests plain ASCII', () => {
  it('shows characters and bytes when they differ, and a plain-ASCII text for every bad character', () => {
    const result = checkField(model, 'name', 'Café — Señor 🔥');
    expect(result).toMatchObject({ ok: false, chars: 14, bytes: 21, suggestion: 'Cafe - Senor' });
    const text = renderField(result);
    expect(text).toContain('Token name: not allowed yet (14 characters, 21 bytes; at most 32).');
    expect(text).toContain('Suggested: "Cafe - Senor" (plain ASCII, 12 characters; ask the creator to confirm it)');
    expect(checkField(model, 'name', 'Straße').suggestion).toBe('Strasse');
  });

  it('drops a leading $ from a ticker\'s suggestion and note', () => {
    const result = checkField(model, 'ticker', '$GM🔥');
    expect(result).toMatchObject({ ok: false, suggestion: 'GM' });
    expect(renderField(result)).toContain('Suggested: "GM" (plain ASCII, 2 characters; ask the creator to confirm it)');
    expect(result.warnings[0]).toBe('The ticker $GM🔥 starts with "$": sites add the $ themselves, so it would show as $$GM🔥. Write "GM".');
    expect(checkField(model, 'ticker', '$🔥').suggestion).toBeUndefined();
    expect(checkField(model, 'collectionSymbol', '$GUZZ').warnings[0]).toContain('Write "GUZZ".');
  });

  it('folds fullwidth letters, and suggests nothing when nothing plain would be left', () => {
    expect(checkField(model, 'name', 'Ｆｕｌｌ').suggestion).toBe('Full');
    for (const [name, text] of [['name', '🦉🦉'], ['ticker', '$🔥']] as const) {
      const result = checkField(model, name, text);
      expect(result.suggestion, text).toBeUndefined();
      expect(result.fix).toContain('it needs at least one plain character');
      expect(renderField(result)).not.toContain('Suggested: ""');
    }
    expect(checkField(model, 'ticker', '$🔥').warnings[0]).toContain('Write it without the "$".');
    // A description may be empty, so dropping its only character is still a suggestion.
    expect(checkField(model, 'description', '🦉').suggestion).toBe('');
  });

  it('explains a limit passed only in bytes', () => {
    const result = checkField(model, 'name', 'é'.repeat(20));
    expect(result.problems).toContain('Token name is too long: 20 characters, 40 bytes; at most 32 bytes, and characters outside plain ASCII take 2 to 4 bytes each.');
    expect(checkField(model, 'name', 'x'.repeat(33)).problems[0]).toBe('Token name is too long: 33 characters; at most 32.');
  });
});

// ------------------------------------------------------------------------------------------------ what a draft cannot know

describe('what a draft cannot know is flagged before the creator confirms', () => {
  const warningsOf = (doc: Draft) => checkSpec(model, doc).warnings ?? [];

  it('a raw trait table: malformed, with another description, or well formed', () => {
    const raw = (hex: string) => warningsOf(box((s) => (s.metadataTable = hex))).filter((w) => w.startsWith('metadataTable is written as raw bytes'));
    // Core item 9: validate() refuses a malformed table itself (METADATA_TABLE_MALFORMED), with a plain sentence.
    const malformed = checkSpec(model, box((s) => (s.metadataTable = '0x01000141')));
    expect(malformed).toMatchObject({ ok: false, stage: 'check', verdict: { reasonName: 'METADATA_TABLE_MALFORMED', fieldName: 'metadataTable' } });
    expect(malformed.explanation?.sentence).toMatch(/does not read as a trait table: version 1, the description, at most 16 trait types/);
    expect(malformed.explanation?.fix).toBe('Write "FROM_LAUNCH_FLOW" or the traits as { "formatV1": { "traitTypes": [...] } }.');
    expect(raw('0x01000361626300')[0]).toContain("raw bytes, with a description that is not the spec's description:");
    const description = String(box().spec.description);
    const own = `0x0100${description.length.toString(16).padStart(2, '0')}${Buffer.from(description).toString('hex')}00`;
    expect(raw(own)).toEqual([expect.stringMatching(/^metadataTable is written as raw bytes: the launch flow builds/)]);
    // A token-only box writes "0x": nothing to say.
    expect(checkSpec(model, example('gm-coin'))).toMatchObject({ ok: true, warnings: [] });
  });

  it('a fingerprint written out, where a pasted key would look the same', () => {
    const fingerprint = `0x${'4c08'.repeat(16)}`;
    const cover = warningsOf(box((s) => (s.coverSha256 = fingerprint)));
    expect(cover).toContain('coverSha256 holds a 64-hex value: a draft cannot know a fingerprint (the launch flow computes it from the upload). Write "FROM_LAUNCH_FLOW"; never paste a key here.');
    const page = warningsOf(box((s) => (s.addOns = [{ addOn: 'collection-metadata', params: { bannerSha256: fingerprint, teaserSha256s: [MARKER, fingerprint], externalLink: '' } }])));
    expect(page.filter((w) => w.includes('holds a 64-hex value')).map((w) => w.split(' ')[0])).toEqual(['addOns[0].params.bannerSha256', 'addOns[0].params.teaserSha256s[1]']);
    // Zero means none, and the package fixtures compute theirs from text.
    expect(warningsOf(box((s) => (s.revealListId = `0x${'0'.repeat(64)}`))).some((w) => w.includes('64-hex'))).toBe(false);
    expect(checkSpec(model, fixture('demo-open-art')).warnings).toEqual([]);
  });
});

describe('the overview uses the launch flow\'s labels', () => {
  it('names the sellers\' FIT burn as the page does, with the sell it takes', () => {
    const result = checkSpec(model, box((s) => Object.assign(s, { qStream: 'ALL_TO_FIT', tStream: 'SELL_FOR_Q' })));
    const rows = Object.fromEntries(result.overview ?? []);
    expect(rows["Sellers' fees"]).toBe('Burn FIT (sells SLOW for ETH)');
    expect(rows['Paired with']).toBe('native ETH');
    expect(rows.About).toBe(box().spec.description);
    expect(result.notes).toContain('Burn FIT (sells SLOW for ETH): the box sells SLOW for ETH after graduation in small limited steps. That is steady sell pressure; buyers see a warning on the box page.');
  });
});

// ------------------------------------------------------------------------------------------------ command lines

describe('the command lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'launch-skill-'));
  const write = (name: string, value: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  };
  const env = (extra: Record<string, string | undefined> = {}) => {
    const base: Record<string, string | undefined> = { ...process.env, SQUAREHOLE_REPO: undefined, INIT_CWD: undefined, npm_lifecycle_event: undefined, ...extra };
    return Object.fromEntries(Object.entries(base).filter((e): e is [string, string] => e[1] !== undefined));
  };
  const node = (script: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) =>
    spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: options.cwd ?? repoDir, env: options.env ?? env() });

  it('exit codes: 3 for a bad add-on id (no crash), 4 for a secret in a file, an argument or text that is not JSON', () => {
    const bad = node(cli, [write('id.json', box((s) => (s.addOns = [{ id: 70003, params: '0x' }])))]);
    expect(bad.status).toBe(EXIT.NOT_READABLE);
    expect(bad.stdout).toContain('is not an add-on id');
    expect(bad.stderr).toBe('');
    for (const r of [node(cli, [write('key.json', box((s) => (s.marketplaceOwner = KEY)))]), node(cli, ['--field', 'name', KEY]), node(cli, [write('phrase.txt', PHRASE)]), node(cli, [write('phrase.json', { ...box(), brief: PHRASE }), '--json'])]) {
      expect(r.status).toBe(EXIT.SECRET);
      expect(r.stdout).toContain(SECRET_MESSAGE);
      expect(`${r.stdout}${r.stderr}`).not.toContain(KEY.slice(2, 20));
      expect(`${r.stdout}${r.stderr}`).not.toContain('test test');
    }
    const shapes = [
      node(cli, [write('sentence.json', box((s) => (s.description = SENTENCE)))]),
      node(cli, ['--field', 'description', SENTENCE]),
      node(cli, [write('commas.json', { ...box(), brief: COMMAS }), '--json']),
    ];
    for (const r of shapes) {
      expect(r.status).toBe(EXIT.SECRET);
      expect(r.stdout).toContain(SECRET_MESSAGE);
      expect(echoes(`${r.stdout}${r.stderr}`)).toBe(false);
    }
  });

  it('exit 4 for the forms from a file, --field and --json, a phrase typed without quotes included', { timeout: shLimit(30_000) }, () => {
    // Every form goes through checkSpec and checkField above; here one of each kind through the command line.
    const kinds = ['numbering fused to the word', 'joined by "/"', '11 of the 12 words', 'a key in groups of 4', 'a key one character short'];
    for (const [name, text] of FORMS.filter(([n]) => kinds.includes(n))) {
      for (const r of [node(cli, [write('form.json', box((s) => (s.description = text)))]), node(cli, ['--field', 'description', text]), node(cli, [write('form-brief.json', { ...box(), brief: text }), '--json'])]) {
        expect(r.status, name).toBe(EXIT.SECRET);
        expect(leaks(`${r.stdout}${r.stderr}`), name).toBe(false);
      }
    }
    const unquoted = node(cli, ['--field', 'description', ...VECTOR]);
    expect(unquoted.status).toBe(EXIT.SECRET);
    expect(leaks(`${unquoted.stdout}${unquoted.stderr}`)).toBe(false);
    const json = node(cli, [write('brief.json', { ...box(), brief: 'Owls for the whole family.' }), '--json']);
    expect(json.status).toBe(EXIT.VALID);
    expect(JSON.parse(json.stdout)).not.toHaveProperty('brief');
  });

  it('reads a draft saved with a byte-order mark, and places a JSON error that has no position', () => {
    expect(node(cli, [write('bom.json', `\ufeff${JSON.stringify(box())}`)]).status).toBe(EXIT.VALID);
    const tru = node(cli, [write('tru.json', '{ "spec": tru\n}')]);
    expect(tru.status).toBe(EXIT.NOT_READABLE);
    expect(tru.stderr).toContain('not valid JSON (near line 1, column 14, at a line break)');
    const mark = node(cli, [write('mark.json', `{ "spec": {}\ufeff }`)]);
    expect(mark.stderr).toContain('at a byte-order mark (U+FEFF, invisible)');
    expect(node(cli, [write('end.json', '{ "spec": {')]).stderr).toContain('not valid JSON (it ends before the JSON is complete)');
  });

  it('--numbers: too many decimals said as such, the share as typed, and an option with no value is a usage error', () => {
    const decimals = node(cli, ['--numbers', '--share', '0.001']);
    expect(decimals.status).toBe(EXIT.USAGE);
    expect(decimals.stderr).toContain('--share "0.001" has more than 2 decimals: write at most 2 (e.g. 0.01).');
    expect(node(cli, ['--numbers', '--items', '2.5']).stderr).toContain('--items "2.5" must be a whole number.');
    expect(node(cli, ['--numbers', '--raise', '4.206980085', '--share', '99.99']).stdout).toContain('  99.99% of all tokens:');
    for (const args of [['--numbers', '--buy'], ['--numbers', '--buy', '--share', '5'], ['--menu', '--context']]) {
      const r = node(cli, args);
      expect(r.status, args.join(' ')).toBe(EXIT.USAGE);
      expect(r.stderr).toMatch(/^--(buy|context) needs a value, e\.g\. /);
    }
  });

  it('the skill\'s check.mjs reads a relative draft from the current folder, whatever INIT_CWD an outer pnpm left', () => {
    write('draft.json', box());
    const stale = env({ INIT_CWD: join(dir, 'elsewhere'), npm_lifecycle_event: 'box-spec:check' });
    const r = node(wrapper, ['draft.json'], { cwd: dir, env: stale });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(EXIT.VALID);
    // Under `pnpm box-spec:check` the checker itself runs from the repository root and INIT_CWD is where it was typed.
    expect(node(cli, ['draft.json'], { cwd: repoDir, env: env({ INIT_CWD: dir, npm_lifecycle_event: 'box-spec:check' }) }).status).toBe(EXIT.VALID);
    expect(node(cli, ['draft.json'], { cwd: dir, env: env({ INIT_CWD: join(dir, 'elsewhere') }) }).status).toBe(EXIT.VALID);
  });

  it('the skill\'s check.mjs passes the exit codes through and finds the repository when installed elsewhere', () => {
    expect(node(wrapper, [write('refused.json', box((s) => (s.deadlineDays = 45)))]).status).toBe(EXIT.REFUSED);
    expect(node(wrapper, [write('unreadable.json', '{')]).status).toBe(EXIT.NOT_READABLE);
    expect(node(wrapper, ['--field', 'ticker', KEY]).status).toBe(EXIT.SECRET);
    const installed = join(dir, 'check.mjs');
    copyFileSync(wrapper, installed);
    const lost = node(installed, ['--menu'], { cwd: dir });
    // Managed lanes may place tmpdir inside the checkout: upward discovery then correctly finds it.
    if (dir.startsWith(`${repoDir}/`)) {
      expect(lost.status).toBe(EXIT.VALID);
      expect(lost.stdout).toContain('What a box can be today');
    } else {
      expect(lost.status).toBe(EXIT.USAGE);
      expect(lost.stderr).toContain('Cannot find the Square Hole BoxSpec checker');
    }
    const found = node(installed, ['--menu'], { cwd: dir, env: env({ SQUAREHOLE_REPO: repoDir }) });
    expect(found.status).toBe(EXIT.VALID);
    expect(found.stdout).toContain('What a box can be today');
  });
});

// ------------------------------------------------------------------------------------------------ coming soon

describe('"coming soon" prose does not outlive the spec', () => {
  const prose = () => [
    ...['SKILL.md', 'references/decisions.md', 'references/spec-json.md', 'references/examples/README.md'].map((path) => ({ path, text: readFileSync(join(skillDir, path), 'utf8') })),
    { path: 'plain-words.v1.json', units: plainWordUnits(model) },
  ];

  it('finds nothing in the skill or the plain words', () => {
    expect(soonFindings(model, prose())).toEqual([]);
  });

  it('flags prose that still calls what the spec has coming soon (the lines rewritten when box creation flow v2 merged)', () => {
    const text = ['A plain token is coming soon.', 'Choosing per side is coming soon.', 'Banner and teasers: coming soon.', 'A fee cap comes later.', 'Payouts in one currency are planned.'].join('\n\n');
    const stale = soonFindings(model, [{ path: 'x.md', text }]);
    expect(stale.every((f) => f.kind === 'stale')).toBe(true);
    expect(stale.map((f) => f.entry).sort()).toEqual(['BoxType.TOKEN_ONLY', 'QStream.CREATOR_IN_T', 'TStream.CREATOR_IN_Q', 'add-on collection-metadata', 'add-on creator-fee-cap', 'rule "the creator takes the whole reward side or none of it"']);
    const words = soonFindings(model, [{ path: 'plain-words.v1.json', units: [{ line: 'fields.qStream.tell', text: 'Today the creator option is chosen for both sides together.' }] }]);
    expect(words).toMatchObject([{ kind: 'stale', entry: 'rule "the creator takes the whole reward side or none of it"' }]);
  });

  it('keeps what the spec or the launch flow lacks coming soon', () => {
    expect(soonFindings(model, [{ path: 'x.md', text: 'Holder payouts are coming soon.\n\nImport BoxSpec is coming soon.\n\nAn SVG upload is coming soon.' }])).toEqual([]);
  });

  it('flags "coming soon" that names nothing it knows, such as the link fields the launch flow has now', () => {
    const text = 'Teleporting boxes are coming soon.\n\nHolder payouts are coming soon.\n\nThe launch flow has no link fields yet (coming soon).';
    expect(soonFindings(model, [{ path: 'x.md', text }])).toEqual([
      { kind: 'unregistered', at: 'x.md:1', text: 'Teleporting boxes are coming soon.' },
      { kind: 'unregistered', at: 'x.md:5', text: 'The launch flow has no link fields yet (coming soon).' },
    ]);
  });
});

// ------------------------------------------------------------------------------------------------ plain words vs spec

describe('the plain words say what the spec says', () => {
  const fields = model.plain.fields as Record<string, { what: string; tell: string }>;

  it('the creator buy advice quotes the one raise (F74 U5), each figure as --numbers works it out', () => {
    const tell = fields.creatorBuy?.tell ?? '';
    // No raise but the one exists, so the advice names no other.
    expect(tell).not.toMatch(/on an? [\d.]+ ETH raise/);
    const shares = [...tell.matchAll(/(\d+(?:\.\d+)?) ETH (?:is )?about (\d+(?:\.\d+)?)%/g)];
    const buys = [...tell.matchAll(/about (\d+(?:\.\d+)?) ETH is (\d+(?:\.\d+)?)%/g)];
    expect(shares.length, 'a share for a buy').toBeGreaterThan(0);
    expect(buys.length, 'the buy for the advice').toBeGreaterThan(0);
    for (const [, buy, share] of shares) expect(percentText(numbersOf(model, { buy }).rows?.[0]?.buy?.bps ?? 0n), `${buy} ETH`).toBe(`${share}%`);
    for (const [, eth, share] of buys) expect(approxText(numbersOf(model, { share }).rows?.[0]?.forShare?.amount ?? 0n), `${share}%`).toBe(eth);
  });

  it('says where holder payouts are offered, in the words of the holder members (F74 U1)', () => {
    const enums = model.plain.enums as Record<string, Record<string, { notOffered?: string }>>;
    const where = enums.QStream?.PAY_HOLDERS_Q?.notOffered ?? '';
    expect(where).toMatch(/^Demo only for now, marked pending legal review/);
    const said = Object.entries(fields).flatMap(([name, p]) => [p.what, p.tell].filter((t) => /holder payouts/i.test(t ?? '')).map((text) => ({ name, text })));
    expect(said.length).toBeGreaterThan(0);
    for (const { name, text } of said) {
      expect(text, name).not.toMatch(/come later|coming soon/i);
      expect(text, name).toMatch(/Demo only for now, marked pending legal review/);
    }
  });
});

// ------------------------------------------------------------------------------------------------ the opening time

/**
 * Review of open-at, finding 4: the contracts' branch taught { "utc": "..." } and the TypeScript branch text, and each
 * branch's checker refused the other's. Every form the skill's references write for field 15 must read, to the time
 * it says, through the library and through the command line a creator runs.
 */
describe('the opening time as every skill reference writes it (field 15 openAt)', () => {
  const references = ['SKILL.md', 'references/fields.md', 'references/spec-json.md', 'references/decisions.md'];
  const formsIn = (text: string): unknown[] => {
    const found = new Map<string, unknown>();
    const add = (json: string) => found.set(JSON.stringify(JSON.parse(json)), JSON.parse(json));
    for (const m of text.matchAll(/"openAt":\s*("[^"]*"|\{[^}]*\}|\d+)/g)) add(m[1] as string);
    for (const m of text.matchAll(/\{ "utc": "[^"]*" \}/g)) add(m[0]);
    for (const m of text.matchAll(/"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z"/g)) add(m[0]);
    return [...found.values()];
  };
  const expectedOpens = (form: unknown): string => {
    if (form === 0) return 'Now: the block after Create (about 12 seconds)';
    const text = typeof form === 'string' ? form : (form as { utc: string }).utc;
    return `${utcText(Date.parse(text) / 1000)}, in the first block from then on (if Create lands later: the block after Create)`;
  };
  const withOpenAt = (form: unknown): Draft => {
    const doc = example('ultrasound-owls');
    doc.spec.openAt = form;
    return doc;
  };

  it.each(references)('%s: each documented form reads to the time it names', (file) => {
    const forms = formsIn(readFileSync(join(skillDir, file), 'utf8'));
    expect(forms.length, `${file} documents no opening time`).toBeGreaterThan(0);
    for (const form of forms) {
      const result = checkSpec(model, withOpenAt(form));
      expect(result.ok, `${file}: ${JSON.stringify(form)} ${JSON.stringify(result.problems)}`).toBe(true);
      expect(Object.fromEntries(result.overview ?? []).Opens, `${file}: ${JSON.stringify(form)}`).toBe(expectedOpens(form));
    }
  });

  it('the plain words name both draft forms, and the command line reads both to the same spec hash', () => {
    const words = JSON.parse(readFileSync(join(pkgDir, 'plain-words.v1.json'), 'utf8')) as { fields: Record<string, { choices: string; tell: string }> };
    const choices = formsIn(`${words.fields.openAt?.choices} ${words.fields.openAt?.tell}`);
    expect(choices).toContainEqual('2026-10-06T18:00:00Z');
    expect(choices).toContainEqual({ utc: '2026-10-06T18:00:00Z' });
    const dir = mkdtempSync(join(tmpdir(), 'launch-skill-open-at-'));
    const hashes = ['2026-10-20T18:00:00Z', { utc: '2026-10-20T18:00:00Z' }].map((form, i) => {
      const path = join(dir, `owls-${i}.json`);
      writeFileSync(path, JSON.stringify(withOpenAt(form)));
      const r = spawnSync(process.execPath, [cli, path, '--json'], { encoding: 'utf8', cwd: repoDir });
      expect(r.status, `${JSON.stringify(form)}: ${r.stdout}${r.stderr}`).toBe(EXIT.VALID);
      return (JSON.parse(r.stdout) as { specHash?: string }).specHash;
    });
    expect(hashes[0]).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hashes[1]).toBe(hashes[0]);
  });
});
