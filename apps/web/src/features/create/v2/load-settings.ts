/**
 * TA-27 "Load settings" (founder 2026-10-23): an example's whole setup loads from the Create page's own "Download
 * BoxSpec" file (`squarehole.boxspec/2`, model.ts `boxSpecFile`), and the creator may then change only the price coin,
 * the name, the ticker, the opening and the fees ("so people can make their own versions of setups similar to the
 * examples"). Everything else (contents, item count, pictures, add-ons, texts, the pile and its leave-behind, a shop's
 * settings, the deadline) stays as loaded. The links are the new box's own, like the name and the ticker (integrator,
 * 2026-10-24): Website, X and Telegram (not in the file) and the collection page's link (in the spec, so a copy never
 * points at the example's site) load empty and stay editable. Item pictures come as the numbered files 1..N with
 * optional traits, read as the Contents step reads them (art-files.ts `readArt`).
 *
 * SH-SHOP-CREATE: a shop's starter set loads too. The file commits it only as add-on 8's hash and count, so the creator
 * types its ids once, per collection (`withStarters`); they must rebuild that hash and count, and then stay as loaded
 * with the collections. A file's "no curator" (the zero curator) is kept; any other curator becomes the creator.
 *
 * The file is untrusted. Its spec is read from `encoded` (hash-checked against `specHash`), every picture is checked
 * against the hash the spec commits and must be a plain picture, and the setup is accepted only when the page itself
 * builds the same spec from it (`rebuildProblem`): what the page cannot build, it does not load. Pure: no React.
 *
 * SH-EX-O1 (L1's integrator request 1): a hidden kit's public template (scripts/kits) carries no item picture and holds
 * a public marker where a root goes; it loads only with its plan file (`squarehole.hidden-kit-plan/1`), which binds the
 * settings file's exact bytes, its plan's count, and its kit and plan's hash, from which the marker is made again
 * (`templateMarker`, `bindPlanTemplate`): a plan file names the template's own plan and no other. Its items are then the
 * creator's own deal of exactly that plan (`templatePlanProblem`) with the plan's pictures, the whole spec but the
 * marker is rebuilt from them, and the new box gets fresh salts and its own root, as every loaded hidden setup does
 * (the reveal file is saved before Create). An ordinary saved hidden file keeps its item-picture set check.
 *
 * R74-ART: a file whose art commits 3D models carries them in `models` (typed GLBs, each checked as the site's viewer
 * checks a model and by its exact sha256, read only within one raw block's size), and open art's reveal list keeps all six
 * leaf fields. Its numbered models (`<id>.glb`) are then added with the pictures, and each id's picture, model and traits
 * must be the list's, and the set of models the file's, before the spec is rebuilt. A file without `models` (every 2D
 * file, every file saved before) loads exactly as before.
 */
import { MAX_RAW_BLOCK_BYTES, inspectImage, sha256Hex, type ImageLimits } from '@squarehole/artwork';
import { AddOnId, ArtMode, MAX_N, decodeCollectionMetadataParams, decodeEditionSpecialsParams, decodePlaceholdersParams, decodeRoyaltiesParams } from '@squarehole/box-spec';
import { formatUnits, type Address } from '@squarehole/domain';
import { decodeAbiParameters, keccak256, type Hex } from 'viem';
import { shopConfigV2Parameters, starterCommitmentV2 } from '../../../../../../packages/chain/src/core/v2';
import { MODEL_TYPE, fromBase64, inspectModel } from '../art-files';
import { DEFAULT_FORM, EMPTY_PAGE, ZERO32, artHasModels, commitArt, metadataTableHex, modelOf, parseEthText, sortedTraitTypes, type ArtState, type CoverState, type CreateForm, type OpenChoice, type PageState } from '../create-model';
import { decodeMetadataTable } from '../../boxes/spec-record';
import type { Draft } from '../draft';
import { CONTROL } from '../reason-copy';
import { ListingClass, ListingKind, BOX_SPEC_V2_ABI_COMPONENTS, BoxTypeV2, Dest, FORMAT_V2, Leg, Split, VERSION_V2, encodeBoxSpecV2, type AddOnV2, type BoxSpecV2, type SideV2 } from './spec-types';
import { DEFAULT_V2, V2_CONTROL, buildSpecV2, v2Issues, type BuildV2Input, type LeaveBehindBps, type PileChoice, type V2Choices } from './model';
import { offeredListings, type SiteListing } from './listings';
import { CHOICES, alchemistPick, pickFor, choiceOf, isCeiling, type InsidePolicy, type SidePick } from './recipes';
import { SHOP_ADD_ONS, SHOP_TIERS, addressOf, starterItemsOf, type CollectionCheck, type ShopChoice, type ShopRow } from './shop';
import type { PictureRole } from './pictures';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export const SETTINGS_FORMAT = 'squarehole.boxspec/2';
/** A file larger than this is not read (a 10,000-item collection's pictures stay well below it). */
export const MAX_SETTINGS_BYTES = 256 * 1024 * 1024;
/** What a processed picture's bytes are read with: one raw block, any side up to 8,192 px (art-files `PROCESSED_LIMITS`). */
const PICTURE_LIMITS: ImageLimits = Object.freeze({ maxBytes: MAX_RAW_BLOCK_BYTES, minSide: 1, maxSide: 8192 });
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ROLES: readonly PictureRole[] = ['logo', 'collection cover', 'banner', 'teaser', 'item'];
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DAY = 86_400;

// Plain lines (minimal text): each names what is wrong with the file, never how the page works inside.
export const LOAD_WORDS = Object.freeze({
  notJson: 'Not a settings file: use a BoxSpec file downloaded from this page.',
  tooLarge: 'This file is too large to read here.',
  damaged: 'This settings file is damaged: its spec does not match its hash.',
  demo: 'This file was built from sample listings. Use one downloaded from a real build.',
  existing: 'This page cannot build this kind of box.',
  picture: (role: string) => `This settings file is missing ${role} or carries the wrong bytes.`,
  notBuilt: 'This page cannot build this setup as it is in the file.',
  pileCoin: 'The pile’s coin is not listed here.',
  itemCount: (n: number, read: number) => `This setup has ${n} ${n === 1 ? 'item' : 'items'}; ${read} ${read === 1 ? 'was' : 'were'} added.`,
  itemsNotSetup: 'These item pictures or traits are not the setup’s.',
  // R74-ART: the same where 3D models are in play (the setup's or the files'): a model may be what differs.
  itemsNotSetupModels: 'These item pictures, models or traits are not the setup’s.',
  revealList: 'This settings file is missing its reveal list.',
  shopUnchecked: 'This shop’s collections could not be checked. Try again.',
  startersNotSetup: 'These starter ids are not the setup’s.',
  cannotKeep: (message: string) => `The loaded setup cannot keep this: ${message}`,
  // SH-EX-O1: a hidden kit's public template and its plan file.
  templateNeedsPlan: 'This hidden setup is a template: load its -plan.json file with it.',
  planFileNotSetup: 'This plan file belongs to another settings file.',
  planNotTemplate: 'This plan.csv is not the template’s.',
  // SH-APP7-HIDE-LOAD: a pick of the wrong files (two settings files, two plan files, a plan file alone). SH-APP8: plain
  // "-plan.json" here and in templateNeedsPlan (find-in-page, copy/paste); LoadSettings keeps it whole with markup.
  pickOne: 'Pick one settings file, or one template with its -plan.json.',
  // R74-ART: a setup with 3D models takes its numbered models with the pictures.
  modelsNeeded: 'This setup has 3D models: add 1.glb … N.glb with the pictures.',
});

/** A loaded picture as the BoxSpec file carries it, checked: its role, the hash the spec commits and its exact bytes. */
export interface LoadedPicture { readonly role: PictureRole; readonly sha256: Hex; readonly bytes: Uint8Array }
/** R74-ART: a loaded 3D model as the file's `models` list carries it, checked: its sha256 and its exact GLB bytes. */
export interface LoadedModel { readonly sha256: Hex; readonly bytes: Uint8Array }

/** One entry of open art's public reveal list (create-model `revealList`): all six leaf fields, as the file has them. */
export interface RevealEntry {
  readonly id: number;
  readonly traitsPacked: bigint;
  readonly imageSha256: Hex;
  readonly avatarSha256: Hex;
  readonly modelSha256: Hex;
  readonly salt: Hex;
}

/** A settings file as read: its spec (from `encoded`), the pictures and models it carries and open art's reveal list. */
export interface SettingsFile {
  readonly spec: BoxSpecV2;
  readonly pictures: readonly LoadedPicture[];
  /** R74-ART: the 3D models (distinct, as in the file); none for a file without `models`. */
  readonly models: readonly LoadedModel[];
  readonly reveal: readonly RevealEntry[] | null;
  readonly demo: boolean;
  /** A hidden kit's public template, bound to its plan file (`bindPlanTemplate`); absent for every other file. */
  readonly template?: PlanTemplate;
}

export const PLAN_FORMAT = 'squarehole.hidden-kit-plan/1';
/**
 * A hidden kit's plan file (scripts/kits `planManifest`): the sha256 of its template's exact settings file bytes, its
 * kit (from the plan's path), and its plan's sha256, item count and the public marker the template holds where a root goes.
 */
export interface PlanManifest {
  readonly settingsSha256: Hex;
  readonly kit: string;
  readonly planSha256: Hex;
  readonly count: number;
  readonly templateRoot: Hex;
}
/** A kit's plan as the kit tooling names it in its plan file: `examples/boxes/<kit>/plan.csv`, the kit a plain id. */
const PLAN_PATH = /^examples\/boxes\/([a-z0-9]+(?:-[a-z0-9]+)*)\/plan\.csv$/;
const MAX_KIT_CHARS = 64;
/**
 * The public marker a kit's template holds where a root goes, made as the kit tooling makes it (scripts/kits `buildKit`):
 * the sha256 of `squarehole.hidden-kit-template/1:<kit>:<the plan's sha256>`. Never an edition's root; it names the kit
 * and its plan, so no other plan can be named under it.
 */
export const templateMarker = (kit: string, planSha256: Hex): Hex =>
  sha256Hex(new TextEncoder().encode(`squarehole.hidden-kit-template/1:${kit}:${planSha256.toLowerCase()}`));
/** What a bound template needs from the creator: exactly this plan, dealt here, for exactly this many items. */
export interface PlanTemplate {
  readonly planSha256: Hex;
  readonly count: number;
  readonly templateRoot: Hex;
}

export type Loaded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
const fail = <T>(error: string): Loaded<T> => ({ ok: false, error });
const done = <T>(value: T): Loaded<T> => ({ ok: true, value });

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A reveal list's `traitsPacked`: a plain decimal string below 2^128 (the leaf's uint128), or null. */
const packedOf = (value: unknown): bigint | null => (typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value) && BigInt(value) < 1n << 128n ? BigInt(value) : null);
const hashOf = (value: unknown): Hex | null => (typeof value === 'string' && HEX32.test(value) ? (value.toLowerCase() as Hex) : null);

/**
 * Open art's public reveal list, every entry with all six leaf fields (R74-ART: the model hash among them) and its ids in
 * order 1..N, as the page writes it; anything else is no list this page made. Its length is the spec's count
 * (`setupOf`), and its every field the spec's root and list id (`itemsProblem`).
 */
function readReveal(value: unknown): readonly RevealEntry[] | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isObject(value) || value.format !== 'squarehole.box-reveal-list/1' || !Array.isArray(value.items) || value.items.length > MAX_N) return undefined;
  const entries: RevealEntry[] = [];
  for (const [index, raw] of value.items.entries()) {
    if (!isObject(raw) || raw.id !== String(index + 1)) return undefined;
    const traitsPacked = packedOf(raw.traitsPacked); const imageSha256 = hashOf(raw.imageSha256); const avatarSha256 = hashOf(raw.avatarSha256);
    const modelSha256 = hashOf(raw.modelSha256); const salt = hashOf(raw.salt);
    if (traitsPacked === null || imageSha256 === null || avatarSha256 === null || modelSha256 === null || salt === null) return undefined;
    entries.push({ id: index + 1, traitsPacked, imageSha256, avatarSha256, modelSha256, salt });
  }
  return entries;
}

/** One model's base64 within one raw block, decoded only when it can be (bounded: never a larger string). */
const MAX_BLOCK_BASE64 = Math.ceil(MAX_RAW_BLOCK_BYTES / 3) * 4;

/**
 * R74-ART: the file's `models` (absent: none, a file as before). Each is typed `model/gltf-binary`, its base64 at most one
 * raw block's, its bytes a model the site's viewer takes (`inspectModel`) whose sha256 (`digest`, as each picture's) is
 * the one given, and each model once; anything else is refused before the setup is read. One model at a time, each
 * checked before the next is decoded.
 */
async function readModels(value: unknown, digest: (bytes: Uint8Array) => Promise<Hex>): Promise<Loaded<readonly LoadedModel[]>> {
  if (value === undefined) return done([]);
  if (!Array.isArray(value) || value.length > MAX_N) return fail(LOAD_WORDS.notJson);
  const models: LoadedModel[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isObject(raw) || raw.type !== MODEL_TYPE || typeof raw.sha256 !== 'string' || !HEX32.test(raw.sha256) || typeof raw.base64 !== 'string') return fail(LOAD_WORDS.notJson);
    const sha256 = raw.sha256.toLowerCase() as Hex;
    const bytes = raw.base64.length <= MAX_BLOCK_BASE64 ? fromBase64(raw.base64) : null;
    const checked = bytes ? inspectModel(bytes) : null;
    if (!bytes || !checked?.ok || checked.sha256.toLowerCase() !== sha256 || seen.has(sha256) || (await digest(bytes)).toLowerCase() !== sha256) return fail(LOAD_WORDS.picture('the models'));
    seen.add(sha256);
    models.push({ sha256, bytes });
  }
  return done(models);
}

/**
 * The file's text as a settings file: the format, the spec from `encoded` (its keccak256 must be `specHash`, and it must
 * re-encode to the same bytes), each picture's bytes against its hash (`digest`, sha256) and as a plain picture, and
 * each 3D model's (R74-ART, `readModels`).
 */
export async function readSettingsFile(text: string, digest: (bytes: Uint8Array) => Promise<Hex>): Promise<Loaded<SettingsFile>> {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return fail(LOAD_WORDS.notJson); }
  if (!isObject(body) || body.format !== SETTINGS_FORMAT || typeof body.encoded !== 'string' || typeof body.specHash !== 'string') return fail(LOAD_WORDS.notJson);
  const encoded = body.encoded as Hex;
  let spec: BoxSpecV2;
  try {
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(encoded) || keccak256(encoded).toLowerCase() !== body.specHash.toLowerCase()) return fail(LOAD_WORDS.damaged);
    [spec] = decodeAbiParameters([{ type: 'tuple', components: BOX_SPEC_V2_ABI_COMPONENTS }], encoded) as unknown as [BoxSpecV2];
    if (encodeBoxSpecV2(spec).toLowerCase() !== encoded.toLowerCase()) return fail(LOAD_WORDS.damaged);
  } catch {
    return fail(LOAD_WORDS.damaged);
  }
  if (spec.format !== FORMAT_V2 || spec.version !== VERSION_V2) return fail(LOAD_WORDS.notJson);
  const reveal = readReveal(body.revealList);
  if (reveal === undefined) return fail(LOAD_WORDS.notJson);
  const list = body.pictures ?? [];
  if (!Array.isArray(list)) return fail(LOAD_WORDS.notJson);
  const pictures: LoadedPicture[] = [];
  for (const raw of list) {
    if (!isObject(raw) || !ROLES.includes(raw.role as PictureRole) || typeof raw.sha256 !== 'string' || !HEX32.test(raw.sha256) || typeof raw.base64 !== 'string') return fail(LOAD_WORDS.notJson);
    const role = raw.role as PictureRole;
    const bytes = raw.base64.length <= Math.ceil(MAX_RAW_BLOCK_BYTES / 3) * 4 ? fromBase64(raw.base64) : null;
    if (bytes === null || bytes.byteLength > MAX_RAW_BLOCK_BYTES || !inspectImage(bytes, PICTURE_LIMITS).ok) return fail(LOAD_WORDS.picture(`the ${role}`));
    const sha256 = raw.sha256.toLowerCase() as Hex;
    if ((await digest(bytes)).toLowerCase() !== sha256) return fail(LOAD_WORDS.picture(`the ${role}`));
    pictures.push({ role, sha256, bytes });
  }
  const models = await readModels(body.models, digest);
  if (!models.ok) return models;
  return done({ spec, pictures, models: models.value, reveal, demo: body.demo === true });
}

/** A file's `format`, when its text is a JSON object; anything else has none. */
function formatOf(text: string): unknown {
  try { const body: unknown = JSON.parse(text); return isObject(body) ? body.format : undefined; } catch { return undefined; }
}

/** Whether a text is a plan file (its format), so the page can tell it from the settings file beside it. */
export function isPlanManifest(text: string): boolean {
  return formatOf(text) === PLAN_FORMAT;
}

/**
 * The files picked at once for Load settings, told apart by their format (each file's JSON read once): one settings
 * file (`SETTINGS_FORMAT`) and, beside it, at most one plan file (`PLAN_FORMAT`, a hidden kit's template, SH-EX-O1).
 * Two settings files, two plan files, or a plan file alone (or nothing) are the wrong files, said as such (`pickOne`),
 * whatever else is picked with them. Any other pick holds a file in neither format, which is no settings file: two or
 * more files that are not plan files get `notJson` here (as before `pickOne`), and one such file, alone or beside one
 * plan file, is read as the settings file and refused there (`readSettingsFile`: `notJson`).
 */
export function sortPicked<T extends { readonly text: string }>(picked: readonly T[]): Loaded<{ readonly settings: T; readonly plan: T | null }> {
  const settings: T[] = []; const plans: T[] = []; const others: T[] = [];
  for (const entry of picked) {
    const format = formatOf(entry.text);
    (format === PLAN_FORMAT ? plans : format === SETTINGS_FORMAT ? settings : others).push(entry);
  }
  const [main, ...rest] = [...settings, ...others];
  if (!main || settings.length > 1 || plans.length > 1) return fail(LOAD_WORDS.pickOne);
  if (rest.length > 0) return fail(LOAD_WORDS.notJson);
  return done({ settings: main, plan: plans[0] ?? null });
}

/**
 * A plan file as read: its format, the two hashes, the kit (a plain id, from the plan's path), the count (1 to 10,000)
 * and the marker; anything else is no plan file.
 */
export function readPlanManifest(text: string): Loaded<PlanManifest> {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return fail(LOAD_WORDS.notJson); }
  if (!isObject(body) || body.format !== PLAN_FORMAT || typeof body.settingsSha256 !== 'string' || !HEX32.test(body.settingsSha256) || !isObject(body.plan)) return fail(LOAD_WORDS.notJson);
  const { path, sha256, count, templateRoot } = body.plan;
  const kit = typeof path === 'string' ? PLAN_PATH.exec(path)?.[1] : undefined;
  if (kit === undefined || kit.length > MAX_KIT_CHARS) return fail(LOAD_WORDS.notJson);
  if (typeof sha256 !== 'string' || !HEX32.test(sha256) || typeof templateRoot !== 'string' || !HEX32.test(templateRoot) || typeof count !== 'string' || !/^[1-9][0-9]{0,4}$/.test(count) || Number(count) > 10_000) return fail(LOAD_WORDS.notJson);
  return done({ settingsSha256: body.settingsSha256.toLowerCase() as Hex, kit, planSha256: sha256.toLowerCase() as Hex, count: Number(count), templateRoot: templateRoot.toLowerCase() as Hex });
}

/** A hidden new collection that carries no item picture, no model and no reveal list: a kit's public template, not a saved setup. */
export const isTemplateShaped = (file: SettingsFile): boolean =>
  file.spec.boxType === BoxTypeV2.NEW_COLLECTION && file.spec.artMode === ArtMode.HIDDEN && file.reveal === null && !file.pictures.some((entry) => entry.role === 'item') && file.models.length === 0;

/**
 * A template bound to its plan file: the plan file names this settings file's exact bytes (`settingsSha256`, the sha256
 * of the file as loaded) and the template's own count, and the marker made from its kit and plan's hash
 * (`templateMarker`) is both the plan file's and the template's. A plan file that names another plan under the
 * template's marker binds nothing: that plan may keep the count and the sorted table, so only the marker tells them
 * apart (XR-SH-EX-O1 F1). Then the template's items may come from that plan alone.
 */
export function bindPlanTemplate(file: SettingsFile, settingsSha256: Hex, manifest: PlanManifest): Loaded<SettingsFile> {
  const { spec } = file;
  const marker = templateMarker(manifest.kit, manifest.planSha256);
  const bound = manifest.settingsSha256 === settingsSha256.toLowerCase() && isTemplateShaped(file) && spec.n === manifest.count
    && manifest.templateRoot === marker && spec.revealRoot.toLowerCase() === marker;
  if (!bound) return fail(LOAD_WORDS.planFileNotSetup);
  return done({ ...file, template: { planSha256: manifest.planSha256, count: manifest.count, templateRoot: marker } });
}

/**
 * A bound template's items, before they are read: exactly one plan among the files, and it is the plan the plan file
 * names (by sha256); null when they may be read (every other setup: nothing to check here).
 */
export async function templatePlanProblem(setup: LoadedSetup, files: readonly File[], digest: (bytes: Uint8Array) => Promise<Hex>): Promise<string | null> {
  const template = setup.file.template;
  if (!template) return null;
  const plans = files.filter((file) => /\.csv$/i.test(file.name));
  const [plan] = plans;
  if (plans.length !== 1 || !plan) return LOAD_WORDS.planNotTemplate;
  return (await digest(new Uint8Array(await plan.arrayBuffer()))).toLowerCase() === template.planSha256 ? null : LOAD_WORDS.planNotTemplate;
}

/** A side's wire as the Fees step's pick (the inverse of recipes `sideOf`); null when it is no choice of this page. */
export function pickOfSide(side: SideV2): SidePick | null {
  const { a, b } = side;
  if (side.split !== Split.NoSplit || side.splitParams !== '0x' || b.leg !== 0 || b.dest !== 0 || b.legParams !== '0x' || b.destParams !== '0x' || a.legParams !== '0x') return null;
  const uint = (type: 'uint8' | 'uint32'): number | null => {
    try { return Number(decodeAbiParameters([{ type }], a.destParams)[0]); } catch { return null; }
  };
  if (a.dest === Dest.Module) {
    const id = a.leg === Leg.AsPaid ? uint('uint32') : null;
    return id === null ? null : alchemistPick(id);
  }
  if (a.dest === Dest.Items) {
    const inside = uint('uint8');
    if (inside !== 1 && inside !== 2 && inside !== 3) return null;
    const choice = a.leg === Leg.BuyT ? 'items-t' : 'items';
    return pickFor(choice, inside as InsidePolicy);
  }
  if (a.leg === Leg.BuyT && a.dest === Dest.BudgetOrPile) {
    const ceiling = uint('uint8');
    return isCeiling(ceiling) ? pickFor('shop', undefined, ceiling) : null;
  }
  const choice = CHOICES.find((entry) => { const pick = pickFor(entry); return pick.a.leg === a.leg && pick.a.dest === a.dest; });
  return choice ? pickFor(choice) : null;
}

/** What the loaded setup is, beside the draft it fills: what the five editable choices must keep. */
export interface LoadedInfo {
  /** The pile's coin is the price coin (it follows the price coin when that changes). */
  readonly pileFollowsPrice: boolean;
  readonly items: number;
  readonly hidden: boolean;
  /** Said once after loading (the file's price coin is not listed here, say). */
  readonly note: string | null;
  /** R74-ART: the setup's art commits a 3D model for each item (its numbered models come with the pictures); absent: none. */
  readonly models?: true;
}

/** The loaded setup: the draft and choices it fills, the item pictures it still needs, and what it must keep. */
export interface LoadedSetup {
  readonly file: SettingsFile;
  readonly form: CreateForm;
  readonly v2: V2Choices;
  readonly cover: CoverState | null;
  readonly collectionCover: CoverState | null;
  readonly page: PageState;
  readonly info: LoadedInfo;
  /** A shop's starter items as the file commits them (add-on 8's count; 0 for none): typed once (`withStarters`). */
  readonly starters: number;
}

/** A thumbnail for a loaded picture (the page's own `thumbnail`), by its role. */
export type Thumbnail = (bytes: Uint8Array, role: PictureRole) => Promise<string | null>;

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Whether `list` (lower-case hashes) holds exactly the hashes of `set`, each once. */
const sameSet = (set: ReadonlySet<string>, list: readonly string[]): boolean => list.length === set.size && list.every((entry) => set.has(entry));
const base64Of = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
/** An amount as the page's fields hold it: decimal text, empty for none. */
const amountField = (raw: bigint, decimals: number): string => (raw === 0n ? '' : formatUnits(raw, decimals));
/** openAt as the Opening step's choice: 0 is Now; any other time is the exact UTC time (seconds kept only when set). */
export function openOf(openAt: number): OpenChoice {
  if (openAt === 0) return { kind: 'preset', id: 'now' };
  const iso = new Date(openAt * 1000).toISOString();
  return { kind: 'time', utc: openAt % 60 === 0 ? iso.slice(0, 16) : iso.slice(0, 19) };
}
/** Who the spec names as its creator (owner and payee): one address, or null when it names none. */
const ownerOf = (spec: BoxSpecV2): Address | null =>
  !sameAddress(spec.marketplaceOwner, ZERO_ADDRESS) ? spec.marketplaceOwner : !sameAddress(spec.creatorFeeRecipient, ZERO_ADDRESS) ? spec.creatorFeeRecipient : null;

/** The decoded pile (box type PILE, field 30): its coin, raw seed and leave-behind; null when field 30 is not one. */
function pileOf(params: Hex): { readonly asset: Address; readonly seed: bigint; readonly leave: LeaveBehindBps } | null {
  try {
    if (params.length === 2 + 128) {
      const [asset, seed] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params);
      return { asset, seed, leave: 0 };
    }
    if (params.length === 2 + 192) {
      const [asset, seed, leave] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint16' }], params);
      return leave === 500 ? { asset, seed, leave: 500 } : null;
    }
  } catch { /* not a pile */ }
  return null;
}

/**
 * The decoded shop (box type SHOP, field 30) as the Contents step's choice, its curator as the spec names it (the zero
 * curator as 'none'); its starter ids are not in the spec (`withStarters`).
 */
function shopOf(params: Hex, owner: Address | null): ShopChoice | null {
  try {
    const [config] = decodeAbiParameters(shopConfigV2Parameters, params);
    const tiers = config.tiers.map(Number);
    if (config.collections.length !== tiers.length || !tiers.every((tier) => (SHOP_TIERS as readonly number[]).includes(tier)) || config.listDelay % DAY !== 0) return null;
    const t = (raw: bigint) => formatUnits(raw, 18);
    const collections: ShopRow[] = config.collections.map((address, i) => ({ address, tier: tiers[i] as ShopRow['tier'], ids: '' }));
    const prices = config.givePricesT.map(t) as unknown as ShopChoice['prices'];
    const curatorIsOwner = owner !== null && sameAddress(config.curator, owner);
    const none = sameAddress(config.curator, ZERO_ADDRESS);
    return {
      seed: t(config.seedT), prices,
      pickBps: config.pickBps as ShopChoice['pickBps'], weeklyBps: config.weeklyBps as ShopChoice['weeklyBps'], collectionBps: config.collectionBps as ShopChoice['collectionBps'],
      listDelayDays: (config.listDelay / DAY) as ShopChoice['listDelayDays'],
      curator: none ? 'none' : curatorIsOwner ? 'creator' : 'address', curatorAddress: none || curatorIsOwner ? '' : config.curator,
      collections,
    };
  } catch {
    return null;
  }
}

/** A stand-in listing for the file's own price coin (its id, token and raise), to rebuild the file's spec exactly. */
const fileListing = (spec: BoxSpecV2, decimals: number): SiteListing => ({
  id: spec.pricing.listingId, token: spec.pricing.token, decimals, class: ListingClass.OTHER, kind: ListingKind.LISTED, raise: spec.raise,
  symbol: 'P', name: 'P', powers: [],
});

/**
 * The file's setup as the page's draft and choices, as faithful to the file as the page builds it (`finishLoad` then
 * settles the price coin, the curator and the collection page's link). `listings` are this page's. Pictures become the
 * draft's processed pictures (with `thumbnail`); the identity fields (owner, payee, a shop's curator) are never loaded:
 * they are the creator's own. The collection page's link is read for the rebuild only (`finishLoad` empties it).
 */
export async function setupOf(file: SettingsFile, listings: readonly SiteListing[], thumbnail: Thumbnail): Promise<Loaded<LoadedSetup>> {
  const { spec } = file;
  if (spec.boxType !== BoxTypeV2.NEW_COLLECTION && spec.boxType !== BoxTypeV2.TOKEN_ONLY && spec.boxType !== BoxTypeV2.PILE && spec.boxType !== BoxTypeV2.SHOP) return fail(LOAD_WORDS.existing);
  const collection = spec.boxType === BoxTypeV2.NEW_COLLECTION;
  // What the item pictures are checked against (`itemsProblem`), required: open art's whole public reveal list (its root
  // and list id are then rebuilt with its salts), hidden art's item pictures (its salts are secret: the set is compared).
  if (collection && spec.artMode !== ArtMode.HIDDEN && file.reveal?.length !== spec.n) return fail(LOAD_WORDS.revealList);
  // A kit's public template carries none: bound to its plan file (`bindPlanTemplate`), its items are the creator's plan deal.
  if (collection && spec.artMode === ArtMode.HIDDEN && !file.template && !file.pictures.some((entry) => entry.role === 'item')) return fail(LOAD_WORDS.picture('the item pictures'));
  // R74-ART: the page commits no avatar, so a list naming one is no setup it builds; open art's file carries exactly the
  // models its list commits (a model for every item, or none), so every model the list names can be published.
  const reveal = collection && spec.artMode !== ArtMode.HIDDEN ? file.reveal ?? [] : [];
  if (reveal.some((entry) => !/^0x0{64}$/.test(entry.avatarSha256))) return fail(LOAD_WORDS.notBuilt);
  const listed3d = reveal.filter((entry) => !/^0x0{64}$/.test(entry.modelSha256));
  if (listed3d.length > 0 && listed3d.length !== reveal.length) return fail(LOAD_WORDS.notBuilt);
  const listedModels = new Set(listed3d.map((entry) => entry.modelSha256));
  if (collection && spec.artMode !== ArtMode.HIDDEN && !sameSet(listedModels, file.models.map((model) => model.sha256))) return fail(LOAD_WORDS.picture('the models'));
  if (!collection && file.models.length > 0) return fail(LOAD_WORDS.notBuilt);
  const models = collection && file.models.length > 0;
  const offered = offeredListings(listings);
  const listed = offered.find((l) => sameAddress(l.token, spec.pricing.token)) ?? null;
  const picture = async (role: PictureRole, sha256: Hex): Promise<CoverState | null | undefined> => {
    if (sha256 === ZERO32 || /^0x0{64}$/i.test(sha256)) return null;
    const found = file.pictures.find((entry) => entry.role === role && entry.sha256 === sha256.toLowerCase());
    if (!found) return undefined;
    return { sha256: found.sha256, url: await thumbnail(found.bytes, role), bytes: found.bytes.byteLength, data: base64Of(found.bytes) };
  };
  const cover = await picture('logo', spec.coverSha256);
  if (!cover) return fail(LOAD_WORDS.picture('the logo'));
  const collectionCover = collection ? await picture('collection cover', spec.collectionCoverSha256) : null;
  if (collection && !collectionCover) return fail(LOAD_WORDS.picture('the collection cover'));

  // Add-ons (the page's own: placeholders, edition specials, royalties, the collection page; a shop's two are its own).
  // SH-EX-O1: hidden art keeps the file's own hidden picture (a kit's designed placeholder), as it keeps its two lines.
  let ticketLine = DEFAULT_FORM.ticketLine; let hiddenLine = DEFAULT_FORM.hiddenLine; let hiddenSvg = DEFAULT_FORM.hiddenSvg;
  const specials: { label: string; count: string }[] = [];
  let royaltyBps = 0; let page: PageState = EMPTY_PAGE; let pageLink = '';
  try {
    for (const addOn of spec.addOns) {
      if (addOn.id === AddOnId.Placeholders) {
        const params = decodePlaceholdersParams(addOn.params);
        ticketLine = params.placeholderDescription; hiddenLine = params.hiddenDescription; hiddenSvg = params.hiddenSvg;
      } else if (addOn.id === AddOnId.EditionSpecials) {
        const params = decodeEditionSpecialsParams(addOn.params);
        specials.push({ label: params.label, count: String(params.count) });
      } else if (addOn.id === AddOnId.Royalties) {
        royaltyBps = Number(decodeRoyaltiesParams(addOn.params).bps);
      } else if (addOn.id === AddOnId.CollectionMetadata) {
        const params = decodeCollectionMetadataParams(addOn.params);
        const banner = await picture('banner', params.bannerSha256 as Hex);
        if (banner === undefined) return fail(LOAD_WORDS.picture('the banner'));
        const teasers: CoverState[] = [];
        for (const sha256 of params.teaserSha256s) {
          const teaser = await picture('teaser', sha256 as Hex);
          if (!teaser) return fail(LOAD_WORDS.picture('a teaser'));
          teasers.push(teaser);
        }
        page = { banner, teasers }; pageLink = params.externalLink;
      }
    }
  } catch {
    return fail(LOAD_WORDS.notBuilt);
  }

  const buyers = pickOfSide(spec.buyers); const sellers = pickOfSide(spec.sellers);
  if (!buyers || !sellers) return fail(LOAD_WORDS.notBuilt);
  const owner = ownerOf(spec);
  let pile: PileChoice | null = null; let pileFollowsPrice = false; let shop: ShopChoice | null = null; let starters = 0;
  if (spec.boxType === BoxTypeV2.PILE) {
    const decoded = pileOf(spec.contentsParams);
    if (!decoded) return fail(LOAD_WORDS.notBuilt);
    pileFollowsPrice = sameAddress(decoded.asset, spec.pricing.token);
    // The seed is text in its coin's decimals: the coin must be listed here (the price coin's stand-in cannot say them).
    const coin = offered.find((l) => sameAddress(l.token, decoded.asset));
    if (!coin) return fail(LOAD_WORDS.pileCoin);
    pile = { asset: coin.token, seed: formatUnits(decoded.seed, coin.decimals), leaveBehindBps: decoded.leave };
  } else if (spec.boxType === BoxTypeV2.SHOP) {
    shop = shopOf(spec.contentsParams, owner);
    if (!shop) return fail(LOAD_WORDS.notBuilt);
    // The starter set: none, or 10 to 10,000 items committed by hash and count (the page always builds add-on 8).
    try { starters = starterCommitmentV2(spec)?.count ?? 0; } catch { return fail(LOAD_WORDS.notBuilt); }
  }
  const separate = collection && (spec.collectionName !== spec.tokenName || spec.collectionSymbol !== spec.tokenSymbol);
  const decimals = listed?.decimals ?? 18;
  const form: CreateForm = {
    ...DEFAULT_FORM,
    name: spec.tokenName,
    ticker: spec.tokenSymbol,
    description: spec.description,
    contents: collection ? 'collection' : 'token',
    separateCollection: separate,
    collectionName: separate ? spec.collectionName : '',
    collectionSymbol: separate ? spec.collectionSymbol : '',
    artMode: spec.artMode === ArtMode.HIDDEN ? 'hidden' : 'open',
    specials,
    ticketLine,
    hiddenLine,
    hiddenSvg,
    royaltyBps,
    royaltyTo: 'fees',
    pageLink,
    pageLinkEdited: true,
    deadlineDays: spec.deadlineDays,
    open: openOf(spec.openAt),
    firstIn: amountField(spec.creatorBuy, decimals),
  };
  const v2: V2Choices = { ...DEFAULT_V2, pricing: spec.pricing.token, buyers, sellers, pickFeeBps: collection ? spec.pickFeeBps : DEFAULT_V2.pickFeeBps, deadlineDays: spec.deadlineDays, pile, shop };
  const setup: LoadedSetup = {
    file, form, v2, cover, collectionCover: collectionCover ?? null, page,
    info: { pileFollowsPrice, items: collection ? spec.n : 0, hidden: collection && spec.artMode === ArtMode.HIDDEN, note: null, ...(models ? { models: true as const } : {}) },
    starters,
  };
  // Without items the setup is complete now: it must rebuild exactly, before any price-coin change. A shop's starter
  // ids are typed next (`withStarters`): until then everything but add-on 8's commitment must rebuild.
  if (!collection) {
    const target = starters === 0 ? setup : { ...setup, file: { ...file, spec: { ...spec, addOns: spec.addOns.map((addOn) => (addOn.id === STARTER_SET ? NO_STARTERS : addOn)) } } };
    const problem = rebuildProblem(target, null, listings);
    if (problem) return fail(LOAD_WORDS.notBuilt);
  }
  return done(setup);
}

/**
 * A hidden setup's table as this page now commits hidden art (create-model `sortedTraitTypes`): a file saved before
 * SH-AI-PLAN fix round 1 lists its traits in first-appearance order, and loads all the same, re-sorted. Bytes that are
 * not a table stay as they are (the comparison then names them).
 */
function sortedTable(table: `0x${string}`): `0x${string}` {
  const view = decodeMetadataTable(table);
  return view ? (metadataTableHex(view.description, sortedTraitTypes(view.traitTypes)) ?? table) : table;
}

/** Add-on 8, the starter set, as the page builds it before a shop's starter ids are typed: no items. */
const STARTER_SET = 8;
const NO_STARTERS = SHOP_ADD_ONS.find((addOn) => addOn.id === STARTER_SET) as AddOnV2;

/** Whether a loaded shop's starter ids are the file's: exactly its count, and the whole spec rebuilt (add-on 8's hash). */
function startersProblem(setup: LoadedSetup, listings: readonly SiteListing[]): string | null {
  const items = setup.v2.shop ? starterItemsOf(setup.v2.shop) : null;
  return items && items.length === setup.starters && rebuildProblem(setup, null, listings) === null ? null : LOAD_WORDS.startersNotSetup;
}

/**
 * A loaded shop's starter items, typed as ids per collection in the file's order ("1, 2, 5-9", as on the Contents
 * step): the setup with them when they are exactly the file's (its count, and add-on 8's hash rebuilt with the spec).
 */
export function withStarters(setup: LoadedSetup, ids: readonly string[], listings: readonly SiteListing[]): Loaded<LoadedSetup> {
  const shop = setup.v2.shop;
  if (!shop || setup.starters === 0 || ids.length !== shop.collections.length) return fail(LOAD_WORDS.startersNotSetup);
  const next: LoadedSetup = { ...setup, v2: { ...setup.v2, shop: { ...shop, collections: shop.collections.map((row, i) => ({ ...row, ids: (ids[i] ?? '').trim() })) } } };
  const problem = startersProblem(next, listings);
  return problem ? fail(problem) : done(next);
}

const specJson = (spec: BoxSpecV2): string => JSON.stringify(spec, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : typeof value === 'string' ? value.toLowerCase() : value));

/**
 * Whether the page rebuilds the file's spec from the loaded setup (with `art`, the item pictures read): null when it
 * does, else the first field that differs. Built with the file's own price coin, owner and opening; open art with the
 * file's public salts, so its root and reveal list id check every item's picture and traits by id (without the whole
 * reveal list nothing is accepted); hidden art's root is the only field not compared (its salts are secret: its item
 * pictures are compared as a set, `itemsProblem`), and its table is compared sorted, as hidden art is committed now
 * (`sortedTable`: a file saved before keeps loading). New salts for the new box come only after this (`finishLoad`).
 */
export function rebuildProblem(setup: LoadedSetup, art: ArtState | null, listings: readonly SiteListing[]): string | null {
  const { spec, reveal } = setup.file;
  const hidden = spec.artMode === ArtMode.HIDDEN;
  const listed = offeredListings(listings).find((l) => sameAddress(l.token, spec.pricing.token));
  const decimals = listed?.decimals ?? 18;
  const own = fileListing(spec, decimals);
  const pileCoin = setup.v2.pile && !setup.info.pileFollowsPrice ? offeredListings(listings).find((l) => sameAddress(l.token, setup.v2.pile?.asset ?? '')) : undefined;
  const rebuildListings = pileCoin ? [own, { ...pileCoin, id: pileCoin.id === own.id ? own.id + 1 : pileCoin.id }] : [own];
  if (art && !hidden && reveal?.length !== art.items.length) return 'revealRoot';
  const salted = art && !hidden && reveal ? { ...art, salts: reveal.map((entry) => entry.salt) } : art;
  const owner = ownerOf(spec);
  const input: BuildV2Input = {
    form: { ...setup.form, open: openOf(spec.openAt), firstIn: amountField(spec.creatorBuy, decimals) },
    art: salted, commitment: commitArt(salted, hidden ? 'hidden' : 'open'), cover: setup.cover, collectionCover: setup.collectionCover, page: setup.page,
    owner, nowMs: 0, listings: rebuildListings,
    v2: { ...setup.v2, pricing: spec.pricing.token, pile: setup.v2.pile && setup.info.pileFollowsPrice ? { ...setup.v2.pile, asset: spec.pricing.token } : setup.v2.pile },
  };
  const built = buildSpecV2(input);
  // Hidden art: the root is the new box's own (new salts), and an older file's table is compared re-sorted.
  const same = (s: BoxSpecV2) => (hidden ? { ...s, revealRoot: ZERO32, metadataTable: sortedTable(s.metadataTable) } : s);
  const a = same(built); const b = same(spec);
  if (encodeBoxSpecV2(a) === encodeBoxSpecV2(b)) return null;
  const left = JSON.parse(specJson(a)) as Record<string, unknown>; const right = JSON.parse(specJson(b)) as Record<string, unknown>;
  return Object.keys(right).find((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key])) ?? 'spec';
}

/**
 * R74-ART: whether each id of the art read is the reveal list's, field by field: its picture, its model (bytes32(0)
 * without one), its packed traits (as this page packs open art's table, `commitArt`) and no avatar. The rebuilt root and
 * list id check the same; this names an item that differs before the spec is compared.
 */
function revealMismatch(reveal: readonly RevealEntry[], art: ArtState): boolean {
  const packed = commitArt({ ...art, salts: reveal.map((entry) => entry.salt) }, 'open')?.packed;
  if (!packed || packed.length !== reveal.length || art.items.length !== reveal.length) return true;
  return art.items.some((item, i) => {
    const entry = reveal[i] as RevealEntry;
    return entry.id !== item.id || entry.imageSha256 !== item.imageSha256.toLowerCase() || entry.modelSha256 !== modelOf(item).toLowerCase()
      || entry.traitsPacked !== packed[i] || !/^0x0{64}$/.test(entry.avatarSha256);
  });
}

/**
 * The item pictures read for the loaded setup (`art`, from `readArt`): exactly the setup's count, no problems, the same
 * pictures (open art: each item's own picture and traits, by its root; hidden art: exactly the set of pictures the file
 * carries, never skipped; a kit's bound template, which carries none: this page's deal of its plan), and the whole spec
 * rebuilt (a hidden root, or a template's marker, is the new box's own). R74-ART: and the same models: a setup with 3D
 * models needs its numbered models (`modelsNeeded`), the set read must be the file's, and open art's every id its
 * list's picture, model and traits (`revealMismatch`); a 2D setup takes no model. Null when they fit, else the line to show
 * (where models are in play, the setup's or the files', the not-the-setup's line names them too: `itemsNotSetupModels`).
 */
export function itemsProblem(setup: LoadedSetup, art: ArtState, listings: readonly SiteListing[]): string | null {
  const notSetup = setup.info.models === true || artHasModels(art) ? LOAD_WORDS.itemsNotSetupModels : LOAD_WORDS.itemsNotSetup;
  if (art.problems.length > 0) return art.problems[0] ?? notSetup;
  if (art.items.length !== setup.file.spec.n) return LOAD_WORDS.itemCount(setup.file.spec.n, art.items.length);
  if (setup.info.models === true && !artHasModels(art)) return LOAD_WORDS.modelsNeeded;
  if (setup.file.template) {
    // A template's items are this page's deal of its plan (whose hash `templatePlanProblem` checked), never numbered files.
    if (art.planned !== true) return notSetup;
  } else {
    const filed = new Set(setup.file.pictures.filter((entry) => entry.role === 'item').map((entry) => entry.sha256));
    if (filed.size > 0 || setup.file.spec.artMode === ArtMode.HIDDEN) {
      const read = new Set(art.items.map((item) => item.imageSha256.toLowerCase()));
      if (read.size !== filed.size || [...read].some((sha256) => !filed.has(sha256 as Hex))) return notSetup;
    }
  }
  // The models read are exactly the file's (none for a 2D setup): hidden art's only check of them, its root being new.
  const models = new Set(art.items.flatMap((item) => (item.modelSha256 ? [item.modelSha256.toLowerCase()] : [])));
  if (!sameSet(models, setup.file.models.map((model) => model.sha256))) return notSetup;
  const reveal = setup.file.spec.artMode === ArtMode.HIDDEN ? null : setup.file.reveal;
  if (reveal && revealMismatch(reveal, art)) return notSetup;
  const problem = rebuildProblem(setup, art, listings);
  if (problem === 'revealRoot' || problem === 'revealListId' || problem === 'metadataTable' || problem === 'n') return notSetup;
  return problem ? LOAD_WORDS.notBuilt : null;
}

/**
 * The controls a loaded setup keeps: every field outside the five (price coin, name, ticker, opening, fees) but the
 * links, which are the creator's own (they load empty). An issue on one of them cannot be fixed by the creator, so the
 * setup is refused with it. On Contents, the pick fee (a fee) and the collection page's link (a link) stay editable.
 */
const LOCKED_CONTROLS: ReadonlySet<string> = new Set([CONTROL.logo, CONTROL.about, CONTROL.deadline]);
export const lockedIssue = (issue: { readonly step: string; readonly control: string }): boolean =>
  LOCKED_CONTROLS.has(issue.control) || (issue.step === 'v2-contents' && issue.control !== V2_CONTROL.pickFee && issue.control !== CONTROL.pageLink);

/** The page's own checks on the loaded draft: the first one on a field the creator can no longer change, or null. */
export function lockedCheck(input: Parameters<typeof v2Issues>[0]): string | null {
  return v2Issues(input).find(lockedIssue)?.message ?? null;
}

/**
 * The form fields a loaded setup leaves editable: the name and ticker, the links (Website, X, Telegram: site metadata,
 * never in the spec; the collection page's link, in the spec), the opening, and the creator's own buy, rights and address.
 */
export const EDITABLE_FORM: readonly (keyof CreateForm)[] = Object.freeze(['name', 'ticker', 'links', 'pageLink', 'pageLinkEdited', 'open', 'firstIn', 'rights', 'ownerText']);
/** The choices a loaded setup leaves editable directly (the price coin changes only through `repriceLoaded`). */
export const EDITABLE_V2: readonly (keyof V2Choices)[] = Object.freeze(['buyers', 'sellers', 'pickFeeBps']);

function only<T extends object>(patch: Partial<T>, keys: readonly (keyof T)[]): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([key]) => keys.includes(key as keyof T))) as Partial<T>;
}
/** A form change as a loaded setup allows it: the editable fields only (everything, without a loaded setup). */
export const lockedFormPatch = (patch: Partial<CreateForm>, loaded: LoadedInfo | null): Partial<CreateForm> => (loaded ? only(patch, EDITABLE_FORM) : patch);
/**
 * Any draft change while a setup is loaded, at the store's mutation boundary (draft.ts `updateDraft`, guarded while
 * the draft's v2 part holds a loaded marker): the art, the logo, the collection cover and the page's pictures stay as
 * loaded, and only the editable form fields change, whoever writes (a picture read that finishes late included).
 * Nothing allowed changed: the draft as it was.
 */
export function lockedDraft(before: Draft, next: Draft): Draft {
  const changed = EDITABLE_FORM.filter((key) => next.form[key] !== before.form[key]);
  const form = changed.length === 0 ? before.form : { ...before.form, ...only(next.form, changed) };
  const kept: Draft = { ...next, form, art: before.art, cover: before.cover, collectionCover: before.collectionCover, page: before.page };
  return form === before.form && kept.revealSavedFor === before.revealSavedFor && kept.restored === before.restored && kept.capReset === before.capReset ? before : kept;
}
/** A choices change as a loaded setup allows it: the fees only (everything, without a loaded setup). */
export const lockedV2Patch = (patch: Partial<V2Choices>, loaded: LoadedInfo | null): Partial<V2Choices> => (loaded ? only(patch, EDITABLE_V2) : patch);

/**
 * A new price coin for a loaded setup: what depends on it follows (the raise is the listing's; a pile in the price coin
 * moves to the new coin with its seed as typed; fees are offered for that coin by the Fees step's own rules), and what
 * the setup cannot keep is refused, said plainly: a pile seed the new coin cannot hold, or a pile in another coin that
 * would become the price coin. `notes` names each fee choice the new coin does not offer.
 */
export function repriceLoaded(v2: V2Choices, token: string, info: LoadedInfo, listings: readonly SiteListing[]): Loaded<{ readonly v2: V2Choices; readonly notes: readonly string[] }> {
  const coin = offeredListings(listings).find((l) => sameAddress(l.token, token));
  if (!coin) return fail('Choose a current price coin.');
  let pile = v2.pile;
  if (pile && info.pileFollowsPrice) {
    if (parseEthText(pile.seed, coin.decimals) === null) return fail(LOAD_WORDS.cannotKeep(`its pile seed ${pile.seed} needs more decimals than ${coin.symbol} has (${coin.decimals}).`));
    pile = { ...pile, asset: coin.token };
  } else if (pile && sameAddress(pile.asset, coin.token)) {
    return fail(LOAD_WORDS.cannotKeep(`its pile is in ${coin.symbol}, so the price coin must be another coin.`));
  }
  const notes: string[] = [];
  for (const side of ['buyers', 'sellers'] as const) {
    const choice = choiceOf(v2[side]);
    const who = side === 'buyers' ? 'Buyers’' : 'Sellers’';
    if (choice === 'eat' && coin.eat === 'refused') notes.push(`${who} fee: ${coin.symbol} cannot be eaten. Choose again.`);
    if (choice === 'alchemist') notes.push(`${who} fee: choose The Alchemist again for ${coin.symbol}.`);
  }
  return done({ v2: { ...v2, pricing: coin.token, pile }, notes });
}

/** What a finished load puts on the page: the draft's parts, the choices and what the setup must keep. */
export interface LoadedDraft {
  readonly form: CreateForm;
  readonly v2: V2Choices;
  readonly art: ArtState | null;
  readonly cover: CoverState | null;
  readonly collectionCover: CoverState | null;
  readonly page: PageState;
  readonly info: LoadedInfo;
}

/**
 * `FinishOptions.shopChecks` from the Demo only (LoadSettings in the Demo build), which has no chain to ask: a shop
 * then loads unchecked, as on the Demo's own page. The production site never honours it (`DEMO_BUILD`).
 */
export const UNASKED = 'unasked';

/** What the last part of a load needs from the page: its salt maker, and a shop's collections as its chain answered. */
export interface FinishOptions {
  /** A fresh leaf salt (`ArtEnvironment.salt`): the new box's, made only once everything is verified. */
  readonly salt: () => Hex;
  /**
   * A shop's starting collections as this page's chain answered them (lower-case addresses): a shop is refused without
   * them or with any one unanswered. `UNASKED` only from the Demo, which has no chain to ask.
   */
  readonly shopChecks?: ReadonlyMap<string, CollectionCheck | 'unknown'> | typeof UNASKED;
}

/**
 * The last part of a load: the item pictures (when the setup has items) checked against the setup, a shop's starter ids
 * (when it has some) checked against the file's, the price coin (the file's when it is listed here, else `pricing`, the
 * page's current one, with what follows from it), a shop's curator as the creator (never the file's address; a file's
 * "no curator" stays none) and its collections as this chain answered (each one answered, `shopChecks`), the collection
 * page's link emptied (the creator's own: as on a new box, it follows their Website until edited), the page's own
 * checks on every field the creator can no longer change, and only then fresh salts for the new box.
 */
export function finishLoad(setup: LoadedSetup, art: ArtState | null, listings: readonly SiteListing[], pricing: string, nowMs: number, options: FinishOptions): Loaded<LoadedDraft> {
  if (setup.info.items > 0) {
    if (!art) return fail(LOAD_WORDS.itemCount(setup.info.items, 0));
    const problem = itemsProblem(setup, art, listings);
    if (problem) return fail(problem);
  }
  // A shop's starter ids, typed for this load (`withStarters`), must be the file's.
  if (setup.starters > 0) {
    const problem = startersProblem(setup, listings);
    if (problem) return fail(problem);
  }
  const items = setup.info.items > 0 ? art : null;
  // TA-27: a file's curator becomes the creator, unless the file names none (the zero curator: a fixed list), which stays.
  const shop = setup.v2.shop;
  let v2: V2Choices = { ...setup.v2, shop: shop ? { ...shop, curator: shop.curator === 'none' ? 'none' : 'creator', curatorAddress: '' } : null };
  let note: string | null = null;
  const listed = offeredListings(listings).find((l) => sameAddress(l.token, setup.file.spec.pricing.token));
  if (listed) v2 = { ...v2, pricing: listed.token };
  else {
    const repriced = repriceLoaded(v2, pricing, setup.info, listings);
    if (!repriced.ok) return repriced;
    v2 = repriced.value.v2;
    const coin = offeredListings(listings).find((l) => sameAddress(l.token, v2.pricing));
    note = `The file’s price coin is not listed here: priced in ${coin?.symbol ?? 'another coin'}.`;
  }
  const form: CreateForm = { ...setup.form, ...(listed ? {} : { firstIn: '' }), pageLink: '', pageLinkEdited: false };
  // A shop's starting collections are locked: each must have been answered by this chain (an ERC-721 to keep it), so
  // without the chain's answers a shop is refused; only the Demo, with no chain to ask, loads one unchecked.
  const { shopChecks } = options;
  const answers = shopChecks === UNASKED ? undefined : shopChecks;
  const unasked = DEMO_BUILD && shopChecks === UNASKED;
  const unanswered = (row: ShopRow): boolean => {
    const address = addressOf(row.address);
    if (address === null) return false; // not an address at all: the page's own checks below refuse it
    const check = answers?.get(address.toLowerCase());
    return check === undefined || check === 'unknown';
  };
  if (v2.shop && !unasked && (!answers || v2.shop.collections.some(unanswered))) return fail(LOAD_WORDS.shopUnchecked);
  const problem = lockedCheck({ form, art: items, commitment: commitArt(items, setup.file.spec.artMode === ArtMode.HIDDEN ? 'hidden' : 'open'), cover: setup.cover, collectionCover: setup.collectionCover, page: setup.page, owner: null, nowMs, v2, listings, shopChecks: answers });
  if (problem) return fail(LOAD_WORDS.cannotKeep(problem));
  const fresh = items ? { ...items, salts: items.items.map(() => options.salt()) } : null;
  return done({ form, v2, art: fresh, cover: setup.cover, collectionCover: setup.collectionCover, page: setup.page, info: { ...setup.info, note } });
}
