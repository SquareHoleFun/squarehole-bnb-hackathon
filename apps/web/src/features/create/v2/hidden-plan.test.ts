/**
 * SH-EX-O1 (L1's integrator request 1): a hidden kit's public template, as the kit tooling commits it
 * (examples/boxes/<kit>/settings/<kit>-boxspec-v2.json and its plan file <kit>-plan.json), loads only with that plan
 * file, which binds the settings file's exact bytes, the plan's sha256 and count, and the public marker the template
 * holds where a root goes. The creator then adds the plan's twelve pictures and plan.csv: this page deals the numbers,
 * rebuilds the whole spec but the marker, and the new box gets fresh salts and its own root. Mismatched plans, tables
 * and settings are refused, and nothing public carries an item picture, an item's number or a salt.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '@squarehole/artwork';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../../../../vitest.timeouts.mjs';
import { BROWSER_ART, readArt, type ArtEnvironment } from '../art-files';
import { commitArt, type ArtState } from '../create-model';
import { NOW, OWNER } from '../test-support/fixtures';
import { testRandomWords } from '../test-support/test-words';
import {
  LOAD_WORDS, bindPlanTemplate, finishLoad, isPlanManifest, isTemplateShaped, itemsProblem, readPlanManifest, readSettingsFile, setupOf, sortPicked, templatePlanProblem,
  type LoadedDraft, type LoadedSetup, type PlanManifest, type SettingsFile,
} from './load-settings';
import { NATIVE_TOKEN, type SiteListing } from './listings';
import { buildSpecV2 } from './model';
import { ListingClass, ListingKind, encodeBoxSpecV2 } from './spec-types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../');
const digest = async (bytes: Uint8Array) => sha256Hex(bytes);
/** The test site's ETH listing (the templates are priced in it, listing 0, at the release raise). */
const ETH: SiteListing = { id: 0, token: NATIVE_TOKEN, decimals: 18, class: ListingClass.NATIVE, kind: ListingKind.LISTED, raise: 4_206_980_085_000_000_000n, symbol: 'ETH', name: 'Ether', powers: [], eat: 'allowed' };
const LISTINGS: readonly SiteListing[] = [ETH];
const two = (i: number) => String(i + 1).padStart(2, '0');
const utf8 = (text: string) => new TextEncoder().encode(text);

interface Kit { readonly id: 'frog-kiln' | 'paper-certificates'; readonly n: number }
const FROG: Kit = { id: 'frog-kiln', n: 420 };
const PAPER: Kit = { id: 'paper-certificates', n: 1_929 };
const bytesOf = (path: string) => new Uint8Array(readFileSync(join(ROOT, path)));
const settingsBytes = (kit: Kit) => bytesOf(`examples/boxes/${kit.id}/settings/${kit.id}-boxspec-v2.json`);
const manifestText = (kit: Kit) => readFileSync(join(ROOT, `examples/boxes/${kit.id}/settings/${kit.id}-plan.json`), 'utf8');
const planBytes = (kit: Kit) => bytesOf(`examples/boxes/${kit.id}/plan.csv`);
const pictureBytes = (kit: Kit, i: number) => bytesOf(`examples/boxes/${kit.id}/art/items/variant-${two(i)}.png`);
const fileOf = (name: string, bytes: Uint8Array, type = 'image/png') => new File([bytes.slice().buffer], name, { type });
/** What the creator adds: the kit's twelve pictures as its plan names them, and its plan.csv (or another `plan`). */
const planFiles = (kit: Kit, plan = planBytes(kit)) => [...Array.from({ length: 12 }, (_, i) => fileOf(`variant-${two(i)}.png`, pictureBytes(kit, i))), fileOf('plan.csv', plan, 'text/csv')];
/**
 * The kit's plan with one item moved from its first picture to its second (XR-SH-EX-O1 F1): the same count, pictures
 * and traits, so the same sorted table; only how many items each picture gets differs.
 */
function movedPlan(kit: Kit) {
  const [head = '', first = '', second = '', ...rest] = new TextDecoder().decode(planBytes(kit)).trimEnd().split('\n');
  const shift = (row: string, by: number) => row.replace(/^([^,]+),([0-9]+),/, (_, file: string, count: string) => `${file},${Number(count) + by},`);
  return utf8(`${[head, shift(first, -1), shift(second, 1), ...rest].join('\n')}\n`);
}
/** The kit's plan file as committed, with `plan` fields replaced. */
const manifestWith = (kit: Kit, plan: Record<string, unknown>) => {
  const body = JSON.parse(manifestText(kit)) as Record<string, unknown> & { plan: Record<string, unknown> };
  return JSON.stringify({ ...body, plan: { ...body.plan, ...plan } });
};
/** Read as LoadSettings reads item files (no salts yet), with a repeatable deal. */
const env = (seed: string): ArtEnvironment => ({ ...BROWSER_ART, digest, thumbnail: async () => null, randomWords: testRandomWords(seed), salt: () => `0x${'0'.repeat(64)}` });
const deal = (kit: Kit, seed: string, files: File[] = planFiles(kit)): Promise<ArtState> => readArt(files, { env: env(seed) });

async function read(kit: Kit): Promise<SettingsFile> {
  const file = await readSettingsFile(new TextDecoder().decode(settingsBytes(kit)), digest);
  if (!file.ok) throw new Error(file.error);
  return file.value;
}
function manifestOf(kit: Kit): PlanManifest {
  const manifest = readPlanManifest(manifestText(kit));
  if (!manifest.ok) throw new Error(manifest.error);
  return manifest.value;
}
/** The template bound to its plan file and set up, as LoadSettings does with both files picked. */
async function bound(kit: Kit): Promise<LoadedSetup> {
  const file = bindPlanTemplate(await read(kit), await digest(settingsBytes(kit)), manifestOf(kit));
  if (!file.ok) throw new Error(file.error);
  const setup = await setupOf(file.value, LISTINGS, async () => null);
  if (!setup.ok) throw new Error(setup.error);
  return setup.value;
}
let made = 0;
const fresh = () => sha256Hex(utf8(`fresh-${(made += 1)}`));
function finished(setup: LoadedSetup, art: ArtState): LoadedDraft {
  const result = finishLoad(setup, art, LISTINGS, NATIVE_TOKEN, NOW, { salt: fresh });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
/** The spec Create builds from a loaded draft, for the connected creator. */
const built = (draft: LoadedDraft) => buildSpecV2({ form: draft.form, art: draft.art, commitment: commitArt(draft.art, draft.form.artMode), cover: draft.cover, collectionCover: draft.collectionCover, page: draft.page, owner: OWNER, nowMs: NOW, v2: draft.v2, listings: LISTINGS });

describe.each([FROG, PAPER])('SH-EX-O1: $id’s public template and its plan file', (kit) => {
  it('carry no item picture, number or salt; the plan file binds the exact bytes, the plan and the marker', async () => {
    const text = new TextDecoder().decode(settingsBytes(kit));
    const body = JSON.parse(text) as { revealList: unknown; pictures: { role: string }[] };
    expect(body.revealList).toBeNull();
    expect(body.pictures.map((picture) => picture.role)).not.toContain('item');
    expect(text).not.toMatch(/"(salt|salts|items|proof)"/);
    const manifest = JSON.parse(manifestText(kit)) as { settingsSha256: string; plan: Record<string, unknown> };
    expect(Object.keys(manifest).sort()).toEqual(['format', 'instructions', 'plan', 'settingsSha256']);
    expect(Object.keys(manifest.plan).sort()).toEqual(['count', 'path', 'sha256', 'specimen', 'templateRoot']);
    expect(manifest.settingsSha256).toBe(sha256Hex(settingsBytes(kit)));
    expect(manifest.plan.sha256).toBe(sha256Hex(planBytes(kit)));
    expect(manifest.plan.count).toBe(String(kit.n));
    // A domain-separated public marker (scripts/kits `buildKit`), never an edition's root.
    expect(manifest.plan.templateRoot).toBe(sha256Hex(utf8(`squarehole.hidden-kit-template/1:${kit.id}:${sha256Hex(planBytes(kit))}`)));
    const file = await read(kit);
    expect(file.spec.revealRoot).toBe(manifest.plan.templateRoot);
    expect(isTemplateShaped(file)).toBe(true);
    expect([isPlanManifest(manifestText(kit)), isPlanManifest(text)]).toEqual([true, false]);
  });

  it('without its plan file it is refused, as before', async () => {
    expect(await setupOf(await read(kit), LISTINGS, async () => null)).toEqual({ ok: false, error: LOAD_WORDS.picture('the item pictures') });
  });

  it('with its plan file and the plan’s pictures it loads: the whole spec but the marker, fresh salts, its own root', async () => {
    const setup = await bound(kit);
    expect(setup.file.template).toEqual({ planSha256: sha256Hex(planBytes(kit)), count: kit.n, templateRoot: setup.file.spec.revealRoot });
    expect(setup.info).toMatchObject({ items: kit.n, hidden: true });
    expect(await templatePlanProblem(setup, planFiles(kit), digest)).toBeNull();
    const art = await deal(kit, `${kit.id}-a`);
    expect([art.planned, art.problems, art.items.length]).toEqual([true, [], kit.n]);
    const draft = finished(setup, art);
    const spec = built(draft);
    const template = setup.file.spec;
    // Only the root is new (and the creator's own address in place of the kit's placeholder owner).
    expect(spec.revealRoot).not.toBe(template.revealRoot);
    expect(encodeBoxSpecV2({ ...spec, revealRoot: template.revealRoot, marketplaceOwner: template.marketplaceOwner, creatorFeeRecipient: template.creatorFeeRecipient })).toBe(encodeBoxSpecV2(template));
    // Fresh salts, made only now; another load deals other numbers under other salts and another root.
    expect(new Set(draft.art?.salts).size).toBe(kit.n);
    const again = finished(await bound(kit), await deal(kit, `${kit.id}-b`));
    expect(built(again).revealRoot).not.toBe(spec.revealRoot);
    expect(again.art?.items.map((item) => item.imageSha256)).not.toEqual(draft.art?.items.map((item) => item.imageSha256));
    expect(new Set([...(draft.art?.salts ?? []), ...(again.art?.salts ?? [])]).size).toBe(2 * kit.n);
  }, shLimit(120_000));

  it('a plan file that names another plan under the template’s marker is refused, though that plan keeps the count and the table', async () => {
    // XR-SH-EX-O1 F1: the plan file as committed (the settings bytes' hash, count, path and marker), but its plan's hash
    // names the plan with one item moved. The marker is made from the kit and its plan's hash, so it names no other plan.
    const moved = movedPlan(kit);
    expect(sha256Hex(moved)).not.toBe(sha256Hex(planBytes(kit)));
    const renamed = readPlanManifest(manifestWith(kit, { sha256: sha256Hex(moved) }));
    if (!renamed.ok) throw new Error(renamed.error);
    const file = await read(kit);
    expect(bindPlanTemplate(file, await digest(settingsBytes(kit)), renamed.value)).toEqual({ ok: false, error: LOAD_WORDS.planFileNotSetup });
    // With the template's own plan file, the moved plan is refused before it is read, as before.
    expect(await templatePlanProblem(await bound(kit), planFiles(kit, moved), digest)).toBe(LOAD_WORDS.planNotTemplate);
    // Why the binding must refuse it: bound by hand, the moved plan's deal rebuilds the template's whole spec but the
    // root (the same count and sorted table); nothing in the spec tells one plan's edition from the other's.
    const byHand = await setupOf({ ...file, template: { planSha256: sha256Hex(moved), count: kit.n, templateRoot: file.spec.revealRoot } }, LISTINGS, async () => null);
    if (!byHand.ok) throw new Error(byHand.error);
    const spec = built(finished(byHand.value, await deal(kit, `${kit.id}-moved`, planFiles(kit, moved))));
    expect(encodeBoxSpecV2({ ...spec, revealRoot: file.spec.revealRoot, marketplaceOwner: file.spec.marketplaceOwner, creatorFeeRecipient: file.spec.creatorFeeRecipient })).toBe(encodeBoxSpecV2(file.spec));
  }, shLimit(120_000));
});

describe('SH-EX-O1: a template loads only with its own plan file, plan, table and pictures', () => {
  it('a plan file for another settings file, count or marker is refused, and so is one beside a saved setup', async () => {
    const frog = await read(FROG);
    const sha = await digest(settingsBytes(FROG));
    const refused = { ok: false, error: LOAD_WORDS.planFileNotSetup };
    expect(bindPlanTemplate(frog, sha, manifestOf(PAPER))).toEqual(refused);
    // The right plan file, but other settings bytes (one more byte at the end).
    expect(bindPlanTemplate(frog, await digest(new Uint8Array([...settingsBytes(FROG), 10])), manifestOf(FROG))).toEqual(refused);
    for (const patch of [{ count: 419 }, { templateRoot: `0x${'1'.repeat(64)}` as const }]) expect(bindPlanTemplate(frog, sha, { ...manifestOf(FROG), ...patch })).toEqual(refused);
    // A saved hidden setup carries its item pictures: it is no template, and keeps its own picture-set check.
    const saved: SettingsFile = { ...frog, pictures: [...frog.pictures, { role: 'item', sha256: sha256Hex(pictureBytes(FROG, 0)), bytes: pictureBytes(FROG, 0) }] };
    expect(isTemplateShaped(saved)).toBe(false);
    expect(bindPlanTemplate(saved, sha, manifestOf(FROG))).toEqual(refused);
    // Not a plan file: another format, a short hash, a count out of range.
    const body = JSON.parse(manifestText(FROG)) as Record<string, unknown> & { plan: Record<string, unknown> };
    for (const broken of [{ ...body, format: 'squarehole.hidden-kit-plan/2' }, { ...body, settingsSha256: '0x12' }, { ...body, plan: { ...body.plan, count: '0' } }, { ...body, plan: { ...body.plan, count: '10001' } }]) {
      expect(readPlanManifest(JSON.stringify(broken))).toEqual({ ok: false, error: LOAD_WORDS.notJson });
    }
  });

  it('the plan file names its kit by the plan’s path; a path that names no plain kit is no plan file, and another kit binds nothing', async () => {
    for (const kit of [FROG, PAPER]) expect(manifestOf(kit).kit).toBe(kit.id);
    // Not a plan file: no path, a path outside the kit tooling's form, a kit that is no plain id.
    const body = JSON.parse(manifestText(FROG)) as Record<string, unknown> & { plan: Record<string, unknown> };
    const pathless = Object.fromEntries(Object.entries(body.plan).filter(([key]) => key !== 'path'));
    expect(readPlanManifest(JSON.stringify({ ...body, plan: pathless }))).toEqual({ ok: false, error: LOAD_WORDS.notJson });
    for (const path of ['plan.csv', 'examples/boxes/frog-kiln/plan.json', 'examples/boxes/../frog-kiln/plan.csv', 'examples/boxes/Frog Kiln/plan.csv', 'examples/boxes/frog-kiln/../paper-certificates/plan.csv', `examples/boxes/${'a'.repeat(65)}/plan.csv`, 7]) {
      expect(readPlanManifest(manifestWith(FROG, { path })), String(path)).toEqual({ ok: false, error: LOAD_WORDS.notJson });
    }
    // A plain kit, but not the one the marker was made for: the same plan's hash under another kit's name binds nothing.
    const elsewhere = readPlanManifest(manifestWith(FROG, { path: 'examples/boxes/paper-certificates/plan.csv' }));
    if (!elsewhere.ok) throw new Error(elsewhere.error);
    expect(elsewhere.value.kit).toBe('paper-certificates');
    expect(bindPlanTemplate(await read(FROG), await digest(settingsBytes(FROG)), elsewhere.value)).toEqual({ ok: false, error: LOAD_WORDS.planFileNotSetup });
  });

  it('a plan.csv that is not the plan file’s is refused before it is read; past that check another table never rebuilds', async () => {
    const setup = await bound(FROG);
    const edited = utf8(new TextDecoder().decode(planBytes(FROG)).replace('Bisque', 'Biscuit'));
    expect(await templatePlanProblem(setup, planFiles(FROG, edited), digest)).toBe(LOAD_WORDS.planNotTemplate);
    expect(await templatePlanProblem(setup, planFiles(FROG).filter((file) => file.name !== 'plan.csv'), digest)).toBe(LOAD_WORDS.planNotTemplate);
    expect(await templatePlanProblem(setup, [...planFiles(FROG), fileOf('traits.csv', utf8('id,Glaze\n1,Ash\n'), 'text/csv')], digest)).toBe(LOAD_WORDS.planNotTemplate);
    // As a page that skipped the hash check would read them: other traits (the sorted table) or another count refuse.
    const other = await deal(FROG, 'frog-other', planFiles(FROG, edited));
    expect(other.problems).toEqual([]);
    expect(itemsProblem(setup, other, LISTINGS)).toBe(LOAD_WORDS.itemsNotSetup);
    const fewer = await deal(FROG, 'frog-fewer', planFiles(FROG, utf8(new TextDecoder().decode(planBytes(FROG)).replace('variant-01.png,44,', 'variant-01.png,43,'))));
    expect(itemsProblem(setup, fewer, LISTINGS)).toBe(LOAD_WORDS.itemCount(420, 419));
  });

  it('the plan’s twelve pictures are required, and numbered files are no deal of the plan', async () => {
    const setup = await bound(FROG);
    const missing = await deal(FROG, 'frog-missing', planFiles(FROG).filter((file) => file.name !== 'variant-12.png'));
    expect(missing.problems.length).toBeGreaterThan(0);
    expect(itemsProblem(setup, missing, LISTINGS)).toBe(missing.problems[0]);
    // The same 420 items as numbered files with a traits file: the right table and count, but not this page's deal.
    const art = await deal(FROG, 'frog-numbered');
    const bySha = new Map(Array.from({ length: 12 }, (_, i) => [sha256Hex(pictureBytes(FROG, i)), pictureBytes(FROG, i)] as const));
    const rows = art.items.map((item) => `${item.id},${item.traits.find((t) => t.trait === 'Glaze')?.value ?? ''},${item.traits.find((t) => t.trait === 'Crack')?.value ?? ''}`);
    const numbered = await readArt([...art.items.map((item) => fileOf(`${item.id}.png`, bySha.get(item.imageSha256) ?? new Uint8Array())), fileOf('traits.csv', utf8(['id,Glaze,Crack', ...rows].join('\n')), 'text/csv')], { env: env('numbered') });
    expect([numbered.problems, numbered.planned]).toEqual([[], undefined]);
    expect(itemsProblem(setup, numbered, LISTINGS)).toBe(LOAD_WORDS.itemsNotSetup);
  });
});

describe('SH-APP7-HIDE-LOAD: the files picked at once for Load settings', () => {
  // As LoadSettings reads each picked file: its name (for the messages here) and its text.
  const settingsOf = (kit: Kit) => ({ name: `${kit.id}-boxspec-v2.json`, text: new TextDecoder().decode(settingsBytes(kit)) });
  const planOf = (kit: Kit) => ({ name: `${kit.id}-plan.json`, text: manifestText(kit) });
  const [frog, paper, frogPlan, paperPlan] = [settingsOf(FROG), settingsOf(PAPER), planOf(FROG), planOf(PAPER)];
  // Files in neither format: not JSON, another format, and a plan file of another version (no plan file of this page).
  const plainText = { name: 'notes.json', text: 'not json' };
  const otherFormat = { name: 'other.json', text: '{"format":"other"}' };
  const otherPlan = { name: 'frog-kiln-plan.json', text: JSON.stringify({ ...JSON.parse(manifestText(FROG)) as object, format: 'squarehole.hidden-kit-plan/2' }) };
  const others = [plainText, otherFormat, otherPlan];
  const pickOf = (files: readonly { readonly name: string; readonly text: string }[]) => {
    const sorted = sortPicked(files);
    if (!sorted.ok) throw new Error(sorted.error);
    return sorted.value;
  };

  it('one settings file is the pick, alone or with one plan file beside it, in either order', () => {
    expect(pickOf([frog]).settings).toBe(frog);
    expect(pickOf([frog]).plan).toBeNull();
    for (const files of [[frog, frogPlan], [frogPlan, frog]]) {
      const pick = pickOf(files);
      expect(pick.settings).toBe(frog);
      expect(pick.plan).toBe(frogPlan);
    }
    // A plan file is told apart by its format alone; whether it binds is the next check (`bindPlanTemplate`).
    expect(pickOf([paper, frogPlan]).plan).toBe(frogPlan);
  });

  it('two settings files, two plan files or a plan file alone: one line says what to pick, never "Not a settings file"', () => {
    const wrong = { ok: false, error: LOAD_WORDS.pickOne };
    const cases = {
      'two settings files': [frog, paper],
      'the same settings file twice': [frog, frog],
      'two settings files and a plan file': [frog, paper, frogPlan],
      'two plan files': [frog, frogPlan, paperPlan],
      'the same plan file twice': [frogPlan, frog, frogPlan],
      'a plan file alone': [frogPlan],
      'two plan files alone': [frogPlan, paperPlan],
      'nothing': [],
      // The count is what is wrong, so it is said first, whatever else is picked with them.
      'two settings files and a file that is no settings file': [frog, otherFormat, paper],
      'two plan files and a file that is no settings file': [plainText, frogPlan, paperPlan],
      // The format alone makes a settings file: a broken one beside a good one is still two.
      'a settings file and a broken one': [frog, { name: 'broken.json', text: '{"format":"squarehole.boxspec/2"}' }],
    };
    for (const [name, files] of Object.entries(cases)) expect(sortPicked(files), name).toEqual(wrong);
    // SH-APP8: plain ASCII with the plain hyphen, so find-in-page and copy/paste see "-plan.json" as typed; the page keeps
    // the name whole on a phone with markup (LoadSettings), never with another character.
    expect(LOAD_WORDS.pickOne).toBe('Pick one settings file, or one template with its -plan.json.');
    expect(LOAD_WORDS.templateNeedsPlan).toBe('This hidden setup is a template: load its -plan.json file with it.');
    for (const line of [LOAD_WORDS.pickOne, LOAD_WORDS.templateNeedsPlan]) expect(line, line).toMatch(/^[\x20-\x7e]+$/);
    expect(LOAD_WORDS.pickOne).not.toBe(LOAD_WORDS.notJson);
  });

  it('a file that is no settings file, alone or beside one plan file, is read as the settings file and keeps its own line', async () => {
    for (const other of others) {
      for (const files of [[other], [other, frogPlan], [frogPlan, other]]) {
        const pick = pickOf(files);
        expect(pick.settings, other.text).toBe(other);
        expect(await readSettingsFile(pick.settings.text, digest), other.text).toEqual({ ok: false, error: LOAD_WORDS.notJson });
      }
    }
  });

  it('any other pick of more than one file holds a file that is no settings file, and keeps "Not a settings file"', () => {
    const old = { ok: false, error: LOAD_WORDS.notJson };
    const cases = {
      'two files that are no settings file': [plainText, otherFormat],
      'the same such file twice': [otherFormat, otherFormat],
      'three such files': [plainText, otherFormat, otherPlan],
      'a settings file, then such a file': [frog, otherFormat],
      'such a file, then a settings file': [otherFormat, frog],
      'a settings file and a plan file of another version': [frog, otherPlan],
      'a settings file, its plan file and such a file': [frog, frogPlan, plainText],
      'two such files and a plan file': [plainText, frogPlan, otherFormat],
    };
    for (const [name, files] of Object.entries(cases)) expect(sortPicked(files), name).toEqual(old);
  });
});
