/**
 * The launch skill's checker (`pnpm box-spec:check`, F73) fills a draft's "FROM_LAUNCH_FLOW" placeholders settings with
 * this page's own ticket texts and neutral picture, read from packages/box-spec/plain-words.v1.json
 * (`addOns.placeholders.launchFlow`), and says "The launch flow cannot enter this yet" for what this page cannot build
 * (`launchFlowCanEnter`). This keeps both equal to the page, so a draft that uses them hashes like the page's spec.
 * The skill calls the features in `launchFlowCanEnter.comingSoon` coming soon: each has a probe here that fails once
 * the page has it, so the entry and that prose are removed together (the skill's link fields went that way).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AddOnId, QStream, TStream, decodeCollectionMetadataParams, decodePlaceholdersParams } from '@squarehole/box-spec';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FORM,
  DEFAULT_HIDDEN_LINE,
  DEFAULT_HIDDEN_SVG,
  DEFAULT_TICKET_LINE,
  EMPTY_PAGE,
  MAX_SPECIALS,
  STEPS,
  STEP_FIELDS,
  ZERO32,
  buildSpec,
  ticketNames,
  type CreateForm,
} from './create-model';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../../..');
const words = JSON.parse(readFileSync(resolve(ROOT, 'packages/box-spec/plain-words.v1.json'), 'utf8')) as {
  steps: { id: string; title: string; fields: string[] }[];
  addOns: { placeholders: { launchFlow: Record<string, unknown> } };
  launchFlowCanEnter: {
    zeroFields: string[];
    royaltiesOffLeftOut: boolean;
    collectionPageEmptyLeftOut: boolean;
    maxRepeats: Record<string, number>;
    comingSoon: { id: string; label: string; soonWords: string[] }[];
  };
};
const canEnter = words.launchFlowCanEnter;
const lf = words.addOns.placeholders.launchFlow as {
  nameMax: number;
  nameSuffix: string;
  symbolMax: number;
  symbolSuffix: string;
  placeholderDescription: string;
  hiddenDescription: string;
  hiddenSvg: string;
  editable: string[];
};

/** The rule the checker applies (spec-model.mjs `launchFlowValue`), written out from the JSON. */
const fromWords = (name: string, ticker: string) => ({
  name: `${name.slice(0, lf.nameMax).trim()}${lf.nameSuffix}`.trim(),
  symbol: `${ticker.slice(0, lf.symbolMax)}${lf.symbolSuffix}`,
});

/** The spec this page builds for a form patch (no art, logo or owner: buildSpec leaves those at zero). */
const spec = (patch: Partial<CreateForm>, page = EMPTY_PAGE) =>
  buildSpec({ form: { ...DEFAULT_FORM, name: 'Gas Guzzlers', ticker: 'GUZZ', ...patch }, art: null, commitment: null, cover: null, page, owner: null, nowMs: 0 });

/** This page's own source files (not its tests), for the probes that look for a feature by its code. */
const sources = readdirSync(HERE)
  .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
  .map((file) => ({ file, text: readFileSync(join(HERE, file), 'utf8') }));
/** Every component of the Create pages (v1, v2 and the set flow, not their tests): where a control would be. */
const components = (readdirSync(HERE, { recursive: true }) as string[])
  .filter((file) => /\.tsx$/.test(file) && !/\.test\.tsx$/.test(file))
  .map((file) => ({ file, text: readFileSync(join(HERE, file), 'utf8') }));

describe('the launch skill knows the page\'s placeholders defaults', () => {
  it('has the same texts and neutral picture', () => {
    expect(lf.placeholderDescription).toBe(DEFAULT_TICKET_LINE);
    expect(lf.hiddenDescription).toBe(DEFAULT_HIDDEN_LINE);
    expect(lf.hiddenSvg).toBe(DEFAULT_HIDDEN_SVG);
    expect(lf.editable).toEqual(['placeholderDescription', 'hiddenDescription']);
  });

  it('derives the ticket name and symbol as the page does, also for long names', () => {
    for (const [name, ticker] of [
      ['Gas Guzzlers', 'GUZZ'],
      ['Parliament of Owls and Friends', 'PARLIAMENTS'],
      ['A name of exactly 25 char', 'ABCDEFGHI'],
      ['Twenty-five characters, then  more', 'X'],
    ] as const) {
      expect(fromWords(name, ticker)).toEqual(ticketNames(name, ticker));
      const built = spec({ name, ticker, contents: 'collection', artMode: 'hidden' });
      const params = decodePlaceholdersParams(built.addOns[0]?.params ?? '0x');
      expect(params).toMatchObject({ placeholderName: fromWords(name, ticker).name, placeholderSymbol: fromWords(name, ticker).symbol, placeholderDescription: lf.placeholderDescription, hiddenDescription: lf.hiddenDescription, hiddenSvg: lf.hiddenSvg });
    }
  });
});

describe('the launch skill knows what this page can enter', () => {
  it('always writes zero where the words say so, whatever the contents, art and fee sides', () => {
    expect(canEnter.zeroFields).toEqual(['generatorHash']);
    const sides = [
      [QStream.BUYBACK_BURN_T, TStream.BURN_T],
      [QStream.ALL_TO_FIT, TStream.SELL_FOR_Q],
      [QStream.TO_CREATOR, TStream.CREATOR_IN_Q],
      [QStream.CREATOR_IN_T, TStream.TO_CREATOR],
    ] as const;
    for (const contents of ['token', 'collection'] as const) {
      for (const artMode of ['open', 'hidden'] as const) {
        for (const [qStream, tStream] of sides) expect(spec({ contents, artMode, qStream, tStream }).generatorHash).toBe(ZERO32);
      }
    }
  });

  it('leaves royalties at 0% out', () => {
    expect(canEnter.royaltiesOffLeftOut).toBe(true);
    expect(spec({ contents: 'collection', royaltyBps: 0 }).addOns.some((a) => a.id === AddOnId.Royalties)).toBe(false);
    expect(spec({ contents: 'collection', royaltyBps: 250 }).addOns.some((a) => a.id === AddOnId.Royalties)).toBe(true);
  });

  it('leaves an empty collection page out, and fills its link from the Website link', () => {
    expect(canEnter.collectionPageEmptyLeftOut).toBe(true);
    const page = (patch: Partial<CreateForm>) => spec({ contents: 'collection', ...patch }).addOns.find((a) => a.id === AddOnId.CollectionMetadata);
    expect(page({})).toBeUndefined();
    expect(page({ links: { ...DEFAULT_FORM.links, website: 'https://guzz.example' }, pageLink: '', pageLinkEdited: true })).toBeUndefined();
    const prefilled = page({ links: { ...DEFAULT_FORM.links, website: 'https://guzz.example' } });
    expect(decodeCollectionMetadataParams(prefilled?.params ?? '0x')).toMatchObject({ bannerSha256: ZERO32, teaserSha256s: [], externalLink: 'https://guzz.example' });
  });

  it('takes as many special series as the words say', () => {
    expect(canEnter.maxRepeats).toEqual({ 'edition-specials': MAX_SPECIALS });
  });

  it('has the link fields the skill points to (Basics: Website, X, Telegram)', () => {
    expect(STEP_FIELDS.basics).toContain('links');
    expect(Object.keys(DEFAULT_FORM.links)).toEqual(['website', 'x', 'telegram']);
  });
});

describe('the launch skill names the steps as this page does', () => {
  const label = (id: string) => STEPS.find((step) => step.id === id)?.label;

  it('has the page\'s steps in its order and with its labels (the --menu and fields.md headings)', () => {
    const onPage = words.steps.filter((step) => STEPS.some((entry) => entry.id === step.id));
    expect(onPage.map((step) => [step.id, step.title])).toEqual(STEPS.filter((step) => step.id !== 'overview').map((step) => [step.id, step.label]));
    expect(words.steps.map((step) => step.id)).toEqual(['basics', 'contents', 'kind', 'addOns', 'raise', 'launch', 'fixed']);
  });

  it('says where the add-ons are set, and they are set there', () => {
    expect(words.steps.find((step) => step.id === 'addOns')?.title).toBe(`Add-ons (set on ${label('contents')} and ${label('kind')})`);
    // Royalties, the collection page, special series and the tickets' texts on Contents; the fee cap on Box kind.
    expect(STEP_FIELDS.contents).toEqual(expect.arrayContaining(['royaltyBps', 'royaltyTo', 'pageLink', 'specials', 'ticketLine', 'hiddenLine']));
    expect(STEP_FIELDS.kind).toEqual(expect.arrayContaining(['capPerEpoch', 'capExcess']));
  });
});

/** One probe per `launchFlowCanEnter.comingSoon` id: it passes while the page lacks the feature. */
const probes: Record<string, () => void> = {
  'import-boxspec': () => {
    expect(STEPS.map((step) => step.id)).not.toContain('import');
    for (const { file, text } of sources) expect(text, file).not.toMatch(/import(?:ing)?\s+(?:a\s+)?boxspec|importBoxSpec|importSpec/i);
  },
  // SH-EX-O1: a loaded setup keeps its own file's hidden picture (the form's `hiddenSvg`, load-settings.ts `setupOf`; the
  // spec takes it from the form), so the form has that one field and every new draft holds the neutral picture in it.
  // The upload is what stays coming soon: no component of the Create pages shows or sets the hidden picture, and none
  // takes an SVG file. Any control for it fails this probe, and the skill's words and this entry then go together.
  'hidden-svg-upload': () => {
    expect(Object.keys(DEFAULT_FORM).filter((key) => /svg|picture/i.test(key))).toEqual(['hiddenSvg']);
    expect(DEFAULT_FORM.hiddenSvg).toBe(DEFAULT_HIDDEN_SVG);
    expect(Object.keys(EMPTY_PAGE).filter((key) => /svg|hidden/i.test(key))).toEqual([]);
    for (const { file, text } of sources) for (const m of text.matchAll(/(?<!readonly )hiddenSvg:\s*([^,\n};]+)/g)) expect(m[1]?.trim(), file).toMatch(/^(?:DEFAULT_HIDDEN_SVG|form\.hiddenSvg)$/);
    for (const { file, text } of components) expect(text, file).not.toMatch(/hiddenSvg|svg\+xml|\.svg\b/i);
    const built = spec({ contents: 'collection', artMode: 'hidden' });
    expect(decodePlaceholdersParams(built.addOns[0]?.params ?? '0x').hiddenSvg).toBe(DEFAULT_HIDDEN_SVG);
  },
};

describe('what the skill calls coming soon is not on the page yet', () => {
  it('has a probe for every coming-soon entry', () => {
    expect(canEnter.comingSoon.map((item) => item.id).sort()).toEqual(Object.keys(probes).sort());
  });

  it.each(canEnter.comingSoon)('$label', ({ id }) => {
    probes[id]?.();
  });
});
