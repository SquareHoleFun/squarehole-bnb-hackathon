/**
 * Format 2's model for the checker and the launch skill (M1-11; box-spec-v2-draft.md § 4, § 9 item 1): the frozen
 * shapes (spec-types-v2.mjs), M1-10's JSON sources when the checkout has them, and the network's menu read at run
 * time: its listings from the indexer (M1-52) over the offline copy `listings.<network>.json`, what the release offers,
 * its build profile, and the reviewed plug-ins (`plug-ins.v2.json`). A listing is never closed (F91 R17H), so every one
 * stays readable by id. A bare symbol names a token Square Hole listed (kind LISTED), at its newest listing; a box token
 * listed by rule (kind BOX_TOKEN) is named `{ "boxToken": "MUG" }`, so a creator's ticker never takes or blocks a
 * listed token's symbol (review round 2).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress } from 'viem';
import { pkgDir, repoDir } from './spec-model.mjs';
import { enumOfField, readShapes } from './spec-types-v2.mjs';

export const DRAFT_FORMAT_V2 = 'squarehole.boxspec-draft/2';
export const NETWORK_LABELS_V2 = Object.freeze({ demo: 'Demo', sepolia: 'Sepolia', mainnet: 'mainnet' });
/** The networks with a format 2 menu (an offline copy `listings.<network>.json`); only these names reach a path. */
export const MENU_NETWORKS_V2 = Object.freeze(['demo', 'sepolia']);
/** Format 1's fields that format 2 replaces (box-spec-v2-draft.md § 1). */
export const FORMAT1_FIELDS = Object.freeze({ q: 'pricing', qStream: 'buyers', tStream: 'sellers' });
/** The indexer's answer format (change request 5). */
export const LISTINGS_FORMAT = 'squarehole.listings/1';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const readIf = (path) => (existsSync(path) ? readJson(path) : null);
const checksum = (a) => (a ? getAddress(String(a).toLowerCase()) : null);

/** One listing as the menu keeps it: amounts as bigint, addresses checksummed, where it was read from. */
function listingRecord(raw, from) {
  return { ...raw, address: checksum(raw.address), raise: BigInt(raw.raise), from };
}

/**
 * Refresh records from the indexer, including newly listed coins. Retirement in the release copy is policy, not
 * on-chain state: an answer may hide a coin, but clearing the copy's retirement requires an explicit policy edit.
 */
export function mergeListings(copy, answer = []) {
  const byId = new Map(copy.map((l) => [l.id, l]));
  for (const l of answer) byId.set(l.id, { ...l, retired: byId.get(l.id)?.retired === true || l.retired === true });
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** The build profiles this checkout builds (build-profiles.v1.json), the only names that reach a path. */
const buildProfileNames = () => readJson(join(pkgDir, 'build-profiles.v1.json')).profiles.map((p) => p.name);

/** A build profile's raise, bootstrap and cap presets, read from the BoxBuildV1.sol that ReleaseConstantsV2 imports. */
export function buildProfile(name) {
  const known = buildProfileNames();
  if (!known.includes(name)) throw new Error(`The menu names a build profile this checkout does not build: ${known.join(' or ')}.`);
  const text = readFileSync(join(repoDir, 'packages/contracts/src/box/build', name, 'BoxBuildV1.sol'), 'utf8');
  const constant = (c) => BigInt(new RegExp(`constant ${c} = ([\\d_]+);`).exec(text)[1].replace(/_/g, ''));
  return { name, raise: constant('RAISE'), bootstrap: constant('BOOTSTRAP_ETH') };
}

const isWord = (v) => typeof v === 'string' && /^\d{1,78}$/.test(v) && BigInt(v) < 1n << 256n;
const isAddress = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
/** The indexer's own text is printed by --menu and the overview, which an assistant reads: printable ASCII, capped. */
const isPrintable = (max) => (v) => typeof v === 'string' && v.length > 0 && v.length <= max && /^[\x20-\x7e]+$/.test(v);
/**
 * A token's symbol as the factory takes a box token's ticker (box-spec-v2-draft.md § 2 fields 3-7 "as format 1"):
 * box-spec.v1.json's JSON_TEXT (bytes 0x20-0x21, 0x23-0x5B, 0x5D-0x7E: a space reads, '"', '\' and control characters
 * do not), 1-11 bytes (IBoxTokenV2 MAX_SYMBOL_BYTES). A creator's ticker is permissionless, so a stricter rule here
 * would let any graduated box stop every check that reads the answer (review round 3, medium).
 */
const isSymbol = (v) => typeof v === 'string' && /^[\x20\x21\x23-\x5b\x5d-\x7e]{1,11}$/.test(v);
/** How a symbol is looked up: without the spaces around it, in lower case, the menu's maps and every input alike. */
export const symbolKey = (symbol) => String(symbol).trim().toLowerCase();
const isLabel = isPrintable(64);
const memberNames = (shapes, name) => shapes.enums.get(name).members.filter((m) => m.value !== 0).map((m) => m.name);

/**
 * What a record of the indexer's answer must carry for the checker and validate() to read it (change request 5's
 * shape): every field of the frozen `Listing` (SpecTypes.sol), class and kind as members of the listing registry's
 * enums, NONE excluded; a box token's raise reading.
 */
function listingNeeds(shapes) {
  const [classes, kinds] = [memberNames(shapes, 'ListingClass'), memberNames(shapes, 'ListingKind')];
  return {
    id: (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff,
    symbol: isSymbol,
    label: isLabel,
    address: isAddress,
    decimals: (v) => Number.isInteger(v) && v >= 6 && v <= 18,
    class: (v) => classes.includes(v),
    kind: (v) => kinds.includes(v),
    raise: (v) => isWord(v) && BigInt(v) >= 1_000_000n && BigInt(v) <= (1n << 128n) - 1n,
    retired: (v) => v === undefined || typeof v === 'boolean',
    powers: (v) => v === undefined || (Array.isArray(v) && v.length <= 8 && v.every(isPrintable(160))),
  };
}
const BY_RULE_NEEDS = { symbol: isSymbol, label: isLabel, address: isAddress };
/** The permanent listing identity; raise alone can change for future boxes. */
const FIXED = ['address', 'decimals', 'class', 'kind'];
const lower = (v) => (v === null || v === undefined ? null : String(v).toLowerCase());
const sameAddress = (a, b) => lower(a) === lower(b);
const sameFixed = (field, a, b) => (field === 'address' ? sameAddress(a, b) : a === b);
const ZERO = '0x0000000000000000000000000000000000000000';

/** Every record of the answer's `listings` and `byRule` with the fields the checker reads. */
function checkRecords(indexer, shapes) {
  for (const [key, needs, what] of [['listings', listingNeeds(shapes), 'a listing'], ['byRule', BY_RULE_NEEDS, 'a by-rule box token']]) {
    const list = indexer[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error(`The indexer's answer has "${key}" that is not a list.`);
    list.forEach((record, i) => {
      const bad = Object.entries(needs).find(([field, ok]) => !ok(record?.[field], record ?? {}))?.[0];
      if (bad) throw new Error(`The indexer's answer has ${what} it cannot read (record ${i + 1}): "${bad}" is missing or malformed.`);
    });
  }
}

/**
 * What the frozen `ListingRecord` rules out in any listing (IListingRegistry.sol: NATIVE is listing 0, STANDARD every
 * box token and only they, burnable only a box token, a box token's raise 0), and a reading's band at most 5% wide
 * (change request 5). Each words its rule; class and kind are member names by then (listingNeeds).
 */
const RECORD_RULES = [
  [(l) => l.class === 'NATIVE' && l.id !== 0, () => 'class NATIVE (only listing 0, ETH, is NATIVE)'],
  [(l) => (l.class === 'STANDARD') !== (l.kind === 'BOX_TOKEN'), (l) => `class ${l.class} and kind ${l.kind} (STANDARD is every box token's class, and only theirs)`],

];
/** What every listing of one token shares: a relisting may change its class, route and raise, never these. */


/**
 * A listing the copy has keeps what the registry never changes; only listing 0 is ETH (no token without code is
 * listed); each id once; every listing of a token with the same decimals and kind; no record the registry could not
 * have written (review round 3, low 2).
 */
function checkFixed(indexer, copy) {
  const copied = new Map(copy.listings.map((l) => [l.id, l]));
  const tokens = new Map(copy.listings.map((l) => [lower(l.address), l]));
  const seen = new Set();
  for (const l of indexer.listings ?? []) {
    if (seen.has(l.id)) throw new Error(`The indexer's answer has listing ${l.id} twice: check the indexer.`);
    seen.add(l.id);
    if (l.id !== 0 && sameAddress(l.address, ZERO)) throw new Error(`The indexer's answer has listing ${l.id} at ETH's address; only listing 0 is ETH.`);
    const was = copied.get(l.id);
    const changed = was && FIXED.find((field) => !sameFixed(field, l[field], was[field]));
    if (changed) throw new Error(`The indexer's answer changes listing ${l.id}'s "${changed}", which the registry never changes: check the indexer, or write the offline copy again.`);
    const token = tokens.get(lower(l.address)) ?? l;
    if (token.id !== l.id) throw new Error(`One permanent listing per coin: listing ${l.id} duplicates listing ${token.id}.`);
    tokens.set(lower(l.address), token);
    const broken = RECORD_RULES.find(([breaks]) => breaks(l));
    if (broken) throw new Error(`The indexer's answer has listing ${l.id} with ${broken[1](l)}, which the registry never writes: check the indexer.`);
  }
}

/**
 * The indexer's answer, checked before anything in it is used: its format, its network and release named and the copy's
 * (the release's build profile and registry too where it names them), every record with the fields the checker reads,
 * and no listing the copy has changed where the registry never changes one. A value of the answer is never repeated
 * (a saved answer is a file the user names).
 */
function checkAnswer(indexer, copy, network, shapes) {
  const label = NETWORK_LABELS_V2[network] ?? network;
  if (typeof indexer !== 'object' || indexer === null || Array.isArray(indexer)) throw new Error("The indexer's answer is not a JSON object of listings.");
  if (indexer.format !== LISTINGS_FORMAT) throw new Error(`The indexer's answer is not a ${LISTINGS_FORMAT} answer.`);
  if (indexer.network === undefined) throw new Error(`The indexer's answer names no network (this check runs for ${label}).`);
  if (indexer.network !== network) throw new Error(`The indexer's answer is for another network than ${label}.`);
  const r = indexer.release;
  if (r === undefined) throw new Error(`The indexer's answer names no release (the offline copy's is ${copy.release.name} on ${label}).`);
  const other = typeof r !== 'object' || r === null || r.name !== copy.release.name || (r.buildProfile !== undefined && r.buildProfile !== copy.release.buildProfile) || ('registry' in r && !sameAddress(r.registry, copy.release.registry));
  if (other) throw new Error(`The indexer's answer is for another release than the offline copy's (${copy.release.name} on ${label}).`);
  // The menu's first line prints when the answer was written.
  if (indexer.writtenAt !== undefined && !(typeof indexer.writtenAt === 'string' && /^[0-9TZ:.+-]{1,40}$/.test(indexer.writtenAt))) throw new Error('The indexer\'s answer has a "writtenAt" that is not a time.');
  checkRecords(indexer, shapes);
  checkFixed(indexer, copy);
}

/** Symbol (lower case) -> the newest listings of `kind` called that, one per token. */
function bySymbolOf(newest, kind) {
  const map = new Map();
  for (const l of newest.values()) if (!l.retired && l.kind === kind) map.set(symbolKey(l.symbol), [...(map.get(symbolKey(l.symbol)) ?? []), l]);
  return map;
}
const unique = (map) => new Map([...map].filter(([, list]) => list.length === 1).map(([s, list]) => [s, list[0]]));
const shared = (map) => new Set([...map].filter(([, list]) => list.length > 1).map(([s]) => s));

/**
 * The network's menu. `indexer`: the indexer's answer (`{ format, network, release, listings: [...], byRule?: [...] }`,
 * the copy's own shape), merged over the copy when given: its listings over the copy's, its by-rule list instead of the
 * copy's. A box token with a listing is not offered by rule any more. `offered` maps a lower-case symbol to the newest
 * listing of the one token Square Hole listed under it; `boxTokens` does the same for box tokens listed by rule, apart,
 * so neither kind takes or blocks the other's symbol. Only a known network and build profile name reach a path.
 */
export function readMenu(network, { dir = pkgDir, indexer, shapes } = {}) {
  if (network === 'mainnet') throw new Error('There is no format 2 release on mainnet yet: check against demo or sepolia.');
  if (!MENU_NETWORKS_V2.includes(network)) throw new Error('This network has no format 2 menu: use demo or sepolia.');
  const path = join(dir, `listings.${network}.json`);
  if (!existsSync(path)) throw new Error(`No format 2 listings for ${network}: use demo or sepolia.`);
  const copy = readJson(path);
  checkRecords(copy, shapes ?? readShapes());
  checkFixed(copy, { listings: [] });
  if (indexer) checkAnswer(indexer, copy, network, shapes ?? readShapes());
  const listings = mergeListings(copy.listings.map((l) => listingRecord(l, 'copy')), (indexer?.listings ?? []).map((l) => listingRecord(l, 'indexer')));
  const newest = new Map();
  for (const l of listings) if ((newest.get(l.address)?.id ?? -1) < l.id) newest.set(l.address, l);
  const byRule = (Array.isArray(indexer?.byRule) ? indexer.byRule : (copy.byRule ?? [])).map((b) => ({ ...b, address: checksum(b.address) })).filter((b) => !newest.has(b.address));
  const [listed, boxes] = [bySymbolOf(newest, 'LISTED'), bySymbolOf(newest, 'BOX_TOKEN')];
  return {
    network,
    label: NETWORK_LABELS_V2[network] ?? network,
    source: indexer ? 'indexer' : 'copy',
    writtenAt: indexer?.writtenAt ?? copy.writtenAt,
    copyWrittenAt: copy.writtenAt,
    release: copy.release,
    profile: buildProfile(copy.release.buildProfile),
    listings,
    newest,
    offered: unique(listed),
    ambiguous: shared(listed),
    boxTokens: unique(boxes),
    ambiguousBoxTokens: shared(boxes),
    byRule,
  };
}

/** https, or http on this computer only (an indexer run locally): a menu read in the clear could be changed on the way. */
export function indexerUrlOk(url) {
  const u = URL.canParse(url) ? new URL(url) : null;
  return Boolean(u && (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))));
}

export const INDEXER_MAX_BYTES = 1_000_000;

/**
 * The indexer's answer by one read-only GET (review round 2, low 4): no redirect is followed, since one could lead to
 * plain http, and at most 1 MB is read, whether the answer declares its length or not. Throws on any failure, in
 * fixed words that never repeat the answer; the command line then uses the offline copy and says so.
 */
export async function fetchIndexerAnswer(url, { fetch: get = globalThis.fetch, maxBytes = INDEXER_MAX_BYTES, timeoutMs = 10_000 } = {}) {
  const answer = await get(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (answer.redirected) throw new Error('the indexer redirected the request');
  if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
  const tooLarge = () => new Error(`the answer is larger than ${maxBytes / 1_000_000} MB`);
  const declared = answer.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && BigInt(declared) > BigInt(maxBytes)) throw tooLarge();
  if (!answer.body) throw new Error('the answer is empty');
  const reader = answer.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // The parser's message repeats bytes of the body, control characters included (review round 3, low 1).
    throw new Error('the answer is not JSON');
  }
}

/** The reviewed plug-ins of a network (plug-ins.v2.json), by id. */
export function readPlugIns(network, dir = pkgDir) {
  const list = readJson(join(dir, 'plug-ins.v2.json')).networks[network] ?? [];
  return new Map(list.map((p) => [p.id, { ...p, address: checksum(p.address) }]));
}

/** M1-10's JSON sources where this checkout has them (wave 2), each null until then. */
export function loadSourcesV2(dir = pkgDir) {
  return { spec: readIf(join(dir, 'box-spec.v2.json')), catalog: readIf(join(dir, 'add-ons.v2.json')), plain: readIf(join(dir, 'plain-words.v2.json')) };
}

/**
 * The enums of format 2's fields that keep format 1's meaning (layout, gradLayout, launchFormat, artMode: box-spec-v2-
 * draft.md § 2 "as format 1"): from box-spec.v2.json once it exists, else from format 1's own source.
 */
function formatOneEnums(spec) {
  const source = Array.isArray(spec?.fields) && Array.isArray(spec?.enums) ? spec : readJson(join(pkgDir, 'box-spec.v1.json'));
  const enums = new Map(source.enums.map((e) => [e.name, e]));
  return new Map(source.fields.filter((f) => f.enum && enums.has(f.enum)).map((f) => [f.name, enums.get(f.enum)]));
}

/** The joined model. `twin` is M1-10's generated library (validateBoxSpecV2), or null while the checkout lacks it. */
export function createModelV2({ network = 'sepolia', sources = loadSourcesV2(), twin = null, curve, indexer, dir = pkgDir, shapes = readShapes() } = {}) {
  const menu = readMenu(network, { dir, indexer, shapes });
  const plain = sources.plain ?? {};
  const catalog = sources.catalog;
  const oldEnums = formatOneEnums(sources.spec);
  const fields = shapes.structs.get('BoxSpec').map((f, id) => ({ ...f, id, enumName: enumOfField(shapes, f) }));
  const enumOf = (field) => (field.enumName ? shapes.enums.get(field.enumName) : oldEnums.get(field.name));
  const abi = Object.fromEntries((catalog?.addOns ?? []).map((a) => [a.id, a.params.map((p) => ({ name: p.name, type: p.type }))]));
  return {
    format: 2,
    network,
    label: menu.label,
    shapes,
    menu,
    plugIns: readPlugIns(network, dir),
    sources,
    catalog,
    plain,
    twin,
    curve,
    fields,
    fieldByName: new Map(fields.map((f) => [f.name, f])),
    enumOf,
    catalogEnums: new Map((catalog?.enums ?? []).map((e) => [e.name, e])),
    addOnByKey: new Map((catalog?.addOns ?? []).map((a) => [a.key, a])),
    addOnById: new Map((catalog?.addOns ?? []).map((a) => [a.id, a])),
    lib: { ADD_ON_PARAMS_ABI: abi },
  };
}

const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));

/** A member's plain label (plain-words.v2.json `enums`), filled, or its name while the words are missing. */
export const labelV2 = (model, enumName, member, vars = {}) => {
  const text = model.plain.enums?.[enumName]?.[member]?.label;
  return text ? fill(text, vars) : member;
};
/** A plain note, filled, or null while plain-words.v2.json lacks it (the checker then says nothing rather than an id). */
export const noteV2 = (model, id, vars = {}) => (model.plain.notes?.[id] ? fill(model.plain.notes[id], vars) : null);
export const fillV2 = fill;
