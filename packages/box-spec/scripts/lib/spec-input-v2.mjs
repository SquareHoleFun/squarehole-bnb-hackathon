/**
 * Reading a format 2 draft (`squarehole.boxspec-draft/2`, M1-11; box-spec-v2-draft.md § 2-6, § 9 item 2) into the
 * wire form of SpecTypes.sol's BoxSpec. Fields and members by their frozen names; the pricing token, each `Convert`
 * target and each plug-in from the menu (a listed token by symbol, a manually listed box coin as { "boxToken": "MUG" },
 * either by address or listing id; a plug-in by its reviewed id); "raise":
 * "LISTING" for the listing's raise (including manually listed box coins); recipe params by member name, unused parts
 * zero. Text, address, fingerprint, amount and time values read as format 1's do (spec-input.mjs). Every problem is
 * collected, each with a plain fix.
 */
import { encodeAbiParameters, getAddress } from 'viem';
import { InputProblem, convertAddress, convertBytes, convertBytes32, convertClockTime, convertText, convertUint, show } from './spec-input.mjs';
import { MARKER, ZERO32, ZERO_ADDRESS, isSmallUint, launchFlowValue } from './spec-model.mjs';
import { DRAFT_FORMAT_V2, FORMAT1_FIELDS, MENU_NETWORKS_V2, symbolKey } from './spec-model-v2.mjs';
import { abiOf, encodeParamsV2, enumOfField, paramsOfMember } from './spec-types-v2.mjs';

export const POINTER = 'docs/design/box-spec-v2-draft.md § 8';
const FORMAT1 = ['squarehole.boxspec-draft/1', 'squarehole.boxspec/1'];
const ZERO_BRANCH = Object.freeze({ leg: 0, dest: 0, legParams: '0x', destParams: '0x' });
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const problem = (path, message, fix) => {
  throw new InputProblem(path, message, fix);
};

/** The draft's shape: a format 2 draft, or a format 1 document (version 2 is refused; box 0's version 1 stays format 1). */
export function readDocumentV2(doc, model) {
  if (!isObject(doc)) return { problems: [{ path: '', message: 'The file is not a JSON object.', fix: `Start from { "format": "${DRAFT_FORMAT_V2}", "spec": { ... } }.` }] };
  if (doc.format !== DRAFT_FORMAT_V2) {
    const spec = isObject(doc.spec) ? doc.spec : doc;
    if (FORMAT1.includes(doc.format) || (doc.format === undefined && (isObject(doc.spec) || 'tokenName' in doc))) return { format1: true, box0: Number(spec.version) === 1 || doc.context === 'v1', problems: [] };
    return { problems: [{ path: 'format', message: `Unknown format ${show(doc.format)}.`, fix: `Write "format": "${DRAFT_FORMAT_V2}".` }] };
  }
  const problems = [];
  if (!isObject(doc.spec)) problems.push({ path: 'spec', message: '"spec" must be an object of BoxSpec fields.', fix: 'See references/v2/spec-json.md.' });
  // Only a network with a menu is named back (the value may be anything a draft holds, a path included).
  if (doc.network !== undefined && !MENU_NETWORKS_V2.includes(doc.network)) problems.push({ path: 'network', message: doc.network === 'mainnet' ? 'There is no format 2 release on mainnet yet.' : 'This is not a network with a format 2 menu.', fix: 'Write "network": "demo" or "sepolia".' });
  else if (doc.network !== undefined && doc.network !== model.network) problems.push({ path: 'network', message: `The draft is for ${show(doc.network)}; this check runs for ${model.label}.`, fix: `Check it with --network ${doc.network}, or change "network".` });
  const preset = doc.preset;
  if (preset !== undefined && !(isObject(preset) && typeof preset.id === 'string' && Number.isInteger(preset.version))) problems.push({ path: 'preset', message: `${show(preset)} is not a preset.`, fix: 'Write { "id": "burn-box", "version": 1 } as the preset file says, or leave it out.' });
  return { kind: 'draft', spec: doc.spec, preset, site: isObject(doc.site) ? doc.site : undefined, problems };
}

// ------------------------------------------------------------------------------------------------ the menu

const symbols = (model) => [...model.menu.offered.values()].map((l) => `"${l.symbol}"`).join(', ');
const NEWER = 'a listing newer than the offline copy shows with --listings or --indexer';
export const byRuleMessage = (b) => `${b.symbol} is a graduated box's token with no listing yet: the lister must admit it and set its raise before a new box can price in it.`;
export const LIST_FIRST = 'Ask the lister to admit this graduated coin with a raise, then refresh the listings.';
const found = (listing) => {
  if (listing.retired) problem('pricing', 'This coin is retired from the offered menu.', 'Choose another listed price coin.');
  return { listing, id: listing.id, address: listing.address };
};

/** A token named by address: its newest listing, of either kind (an address is never a creator's ticker). */
function byAddress(model, path, raw) {
  const { menu } = model;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) problem(path, `${show(raw)} is not a full address.`, 'Paste the whole token address, or write its symbol.');
  const address = getAddress(raw.toLowerCase());
  const listing = menu.newest.get(address);
  if (listing) return found(listing);
  const rule = menu.byRule.find((b) => b.address === address);
  if (rule) problem(path, byRuleMessage(rule), LIST_FIRST);
  return problem(path, `${address} is not a listing of this release on ${menu.label}.`, `Pick a listed token (${symbols(model)}); ${NEWER}.`);
}

/** A bare symbol names a token Square Hole listed, never a manually listed box coin (whose ticker is a creator's). */
function bySymbol(model, path, raw) {
  const { menu } = model;
  const want = symbolKey(raw);
  const listing = menu.offered.get(want);
  if (listing) return found(listing);
  if (menu.ambiguous.has(want)) problem(path, `Two listed tokens are called ${show(raw)}.`, 'Name it by its address or { "listingId": n }.');
  if (menu.boxTokens.has(want) || menu.ambiguousBoxTokens.has(want)) problem(path, `${show(raw.trim())} is a manually listed box coin, not a token Square Hole listed.`, `To price in it on purpose, write { "boxToken": ${show(raw.trim())} }, or its address.`);
  const rule = menu.byRule.find((b) => symbolKey(b.symbol) === want);
  if (rule) problem(path, byRuleMessage(rule), LIST_FIRST);
  return problem(path, `${show(raw)} is not listed on ${menu.label}.`, `Pick one of: ${symbols(model)}; ${NEWER}.`);
}

/** `{ "boxToken": "MUG" }`: a manually listed box coin, by its symbol among box tokens only. */
function byBoxToken(model, path, raw) {
  const { menu } = model;
  const keys = Object.keys(raw).filter((k) => k !== 'boxToken');
  if (typeof raw.boxToken !== 'string' || keys.length > 0) problem(path, `${show(raw)} is not a box token.`, 'Write { "boxToken": "MUG" } with the symbol the menu shows.');
  const want = symbolKey(raw.boxToken);
  const listing = menu.boxTokens.get(want);
  if (listing) return found(listing);
  if (menu.ambiguousBoxTokens.has(want)) problem(path, `Two box tokens listed by rule are called ${show(raw.boxToken)}.`, 'Name it by its address or { "listingId": n } (--menu shows both).');
  const rule = menu.byRule.find((b) => symbolKey(b.symbol) === want);
  if (rule) problem(path, byRuleMessage(rule), LIST_FIRST);
  const listed = menu.offered.get(want);
  if (listed) problem(path, `"${listed.symbol}" is a token Square Hole listed, not a box token.`, `Write "${listed.symbol}".`);
  const boxes = [...menu.boxTokens.values()].map((l) => `{ "boxToken": "${l.symbol}" }`).join(', ');
  return problem(path, `${show(raw.boxToken)} is not a box token listed on ${menu.label}.`, `${boxes ? `Manually listed box coins: ${boxes}` : 'No box token is listed yet'}; ${NEWER}.`);
}

/** A token named by symbol, address, { boxToken } or listing id: { listing (undefined for an id the menu lacks), id, address }. */
function resolveListing(model, path, raw) {
  if (typeof raw === 'string') return /^0x/i.test(raw) ? byAddress(model, path, raw) : bySymbol(model, path, raw);
  if (isObject(raw) && 'boxToken' in raw) return byBoxToken(model, path, raw);
  if (isObject(raw) && Number.isInteger(raw.listingId) && raw.listingId >= 0 && raw.listingId <= 0xffffffff) {
    const listing = model.menu.listings.find((l) => l.id === raw.listingId);
    if (listing?.retired) found(listing);
    const address = raw.token !== undefined ? convertAddress(`${path}.token`, raw.token, { placeholders: [] }, new Map()) : (listing?.address ?? ZERO_ADDRESS);
    return { listing, id: raw.listingId, address };
  }
  return problem(path, `${show(raw)} is not a token.`, 'Write its symbol ("LINK"), { "boxToken": "MUG" } for a manually listed box coin, its address, or { "listingId": 9 }.');
}

// ------------------------------------------------------------------------------------------------ values

const zeroOf = (type) => (type === 'address' ? ZERO_ADDRESS : type === 'bytes32' ? ZERO32 : type === 'bytes' ? '0x' : type === 'bool' ? false : isSmallUint(type) ? 0 : 0n);
const realMembers = (e) => e.members.filter((m) => m.value !== 0);

function readEnum(path, e, raw) {
  if (Number.isInteger(raw) && raw >= 0 && raw <= 255) return raw;
  const choices = realMembers(e).map((m) => `"${m.name}"`).join(', ');
  const member = typeof raw === 'string' ? realMembers(e).find((m) => m.name === raw || m.name.toLowerCase() === raw.toLowerCase()) : undefined;
  return member ? member.value : problem(path, `${show(raw)} is not a choice for ${path}.`, `Pick one of: ${choices}.`);
}

function readHex(path, raw) {
  return typeof raw === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(raw) ? raw.toLowerCase() : problem(path, `${show(raw)} is not hex bytes.`, 'Write 0x and pairs of hex digits ("0x" for none).');
}

/** One value of a frozen params struct, by its Solidity type and NatSpec enum. */
function readValue(model, path, f, raw, env) {
  const array = /^(\w+)\[(\d*)\]$/.exec(f.type);
  if (array) {
    if (!Array.isArray(raw) || (array[2] && raw.length !== parseInt(array[2], 10))) problem(path, 'Use the array required by the shop settings.', `Write ${array[2] || 'a list of'} values.`);
    return raw.map((v, i) => readValue(model, `${path}[${i}]`, { ...f, type: array[1] }, v, env));
  }
  const e = f.enum ?? enumOfField(model.shapes, f);
  if (e === 'HoldersCurrency' && typeof raw === 'string' && raw !== 'P') problem(path, 'Holders receive only the price coin.', 'Write "P"; a stock-priced box pays that stock with no conversion.');
  if (e) return readEnum(path, model.shapes.enums.get(e), raw);
  if (f.type === 'address') return convertAddress(path, raw, env, new Map());
  if (f.type === 'bytes32') return convertBytes32(path, raw, env);
  if (f.type === 'bytes') return readHex(path, raw);
  if (f.type === 'bool') return typeof raw === 'boolean' ? raw : problem(path, `${show(raw)} is not true or false.`, 'Write true or false.');
  return convertUint(path, f.type, raw, env, false);
}

/** Frozen member params only. Retired conversion and plug-in shortcuts have no parser. */
function readParams(model, path, member, which, raw, env, legName) {
  const group = { legParams: 'legs', destParams: 'dests', splitParams: 'splits' }[which];
  const recipe = model.sources.spec?.recipe;
  const entry = member ? recipe?.[group]?.[member.name] : undefined;
  const struct = entry?.paramsWhenLeg && entry.paramsWhenLeg !== legName ? undefined : member ? entry?.params ?? paramsOfMember(member, which) : undefined;
  if (!struct) return raw === undefined || raw === '0x' ? '0x' : problem(path, `${member?.name ?? 'This choice'} takes no settings.`, `Leave "${which}" out.`);
  const fields = model.shapes.structs.get(struct).map((f) => ({ ...f, enum: recipe?.paramTuples?.[struct]?.members.find((p) => p.name === f.name)?.enum }));
  if (!isObject(raw)) problem(path, `${member.name} needs its settings.`, `Write "${which}" as an object.`);
  unknownKeys(raw, fields.map((f) => f.name), path, env, 'Use only the frozen fields.');
  const values = Object.fromEntries(fields.map((f) => [f.name, env.attempt(() => readValue(model, `${path}.${f.name}`, f, raw[f.name], env))]));
  if (Object.values(values).some((v) => v === undefined)) return undefined;
  return encodeParamsV2(model.shapes, struct, values);
}

const unknownKeys = (raw, keys, path, env, fix) => Object.keys(raw).filter((k) => !keys.includes(k)).forEach((k) => env.problems.push({ path: `${path}.${k}`, message: `${show(k)} is not part of ${path}.`, fix }));

function readBranch(model, path, raw, env) {
  if (!isObject(raw)) problem(path, `${show(raw)} is not a branch.`, 'Write { "leg": "BuyT", "dest": "Eat" } (references/v2/spec-json.md).');
  unknownKeys(raw, ['leg', 'dest', 'legParams', 'destParams'], path, env, 'A branch has "leg", "dest" and, where they take settings, "legParams" and "destParams".');
  const [legs, dests] = [model.shapes.enums.get('Leg'), model.shapes.enums.get('Dest')];
  const leg = env.attempt(() => readEnum(`${path}.leg`, legs, raw.leg));
  const dest = env.attempt(() => readEnum(`${path}.dest`, dests, raw.dest));
  const legParams = env.attempt(() => readParams(model, `${path}.legParams`, legs.members[leg], 'legParams', raw.legParams, env));
  const destParams = env.attempt(() => readParams(model, `${path}.destParams`, dests.members[dest], 'destParams', raw.destParams, env, legs.members[leg]?.name));
  return { leg, dest, legParams, destParams };
}

/** Fields 17 and 18: { split, splitParams?, a, b? } (box-spec-v2-draft.md § 3); `b` all zero when left out. */
function readSide(model, path, raw, env) {
  if (!isObject(raw)) problem(path, `${show(raw)} is not a side's recipe.`, 'Write { "split": "NoSplit", "a": { "leg": "BuyT", "dest": "Eat" } } (references/v2/spec-json.md).');
  unknownKeys(raw, ['split', 'splitParams', 'a', 'b'], path, env, 'A side has "split", "splitParams" (where the split takes settings), "a" and "b".');
  const splits = model.shapes.enums.get('Split');
  const split = env.attempt(() => readEnum(`${path}.split`, splits, raw.split));
  const a = env.attempt(() => readBranch(model, `${path}.a`, raw.a, env));
  const b = raw.b === undefined ? ZERO_BRANCH : env.attempt(() => readBranch(model, `${path}.b`, raw.b, env));
  const splitParams = env.attempt(() => readParams(model, `${path}.splitParams`, splits.members[split], 'splitParams', raw.splitParams, env));
  return { a, b, split, splitParams };
}

function readAddOn(model, entry, i, env) {
  const at = `addOns[${i}]`;
  if (isObject(entry) && 'id' in entry && !('addOn' in entry)) return { id: convertUint(`${at}.id`, 'uint16', entry.id, env, false), params: readHex(`${at}.params`, entry.params) };
  const a = isObject(entry) && typeof entry.addOn === 'string' ? model.addOnByKey.get(entry.addOn) : undefined;
  if (!a) problem(at, `${show(entry?.addOn ?? entry)} is not a format 2 add-on.`, `Add-ons: ${[...model.addOnByKey.keys()].map((k) => `"${k}"`).join(', ')}.`);
  const own = (p) => (model.plain.addOns ? launchFlowValue(model, a.key, p.name, env.input) : undefined);
  const given = entry.params === MARKER ? Object.fromEntries(a.params.filter((p) => own(p) !== undefined).map((p) => [p.name, MARKER])) : (entry.params ?? {});
  if (!isObject(given)) problem(`${at}.params`, `${show(entry.params)} is not a list of settings.`, `Write { "addOn": "${a.key}", "params": { ... } }.`);
  unknownKeys(given, a.params.map((p) => p.name), `${at}.params`, env, `Its settings: ${a.params.map((p) => `"${p.name}"`).join(', ') || 'none'}.`);
  const values = a.params.map((p) => {
    const path = `${at}.params.${p.name}`;
    const raw = given[p.name];
    if (raw === undefined) return problem(path, `The ${a.key} setting "${p.name}" is missing.`, 'Add it (references/v2/fields.md).');
    if (p.type === 'string' && raw === MARKER && own(p) !== undefined) return (env.launchFlow.push(path), own(p));
    if (p.type === 'string') return convertText(path, raw);
    if (p.type === 'bytes32[]') return Array.isArray(raw) ? raw.map((x, j) => convertBytes32(`${path}[${j}]`, x, env)) : problem(path, `${show(raw)} is not a list.`, 'Write a list such as [] or ["FROM_LAUNCH_FLOW"].');
    if (p.enum && typeof raw === 'string') return readEnum(path, model.catalogEnums.get(p.enum), raw);
    return readValue(model, path, p, raw, env);
  });
  return { id: a.id, params: a.params.length === 0 ? '0x' : encodeAbiParameters(model.lib.ADD_ON_PARAMS_ABI[a.id], values) };
}

function readAddOns(model, raw, env) {
  if (!Array.isArray(raw)) problem('addOns', '"addOns" must be a list.', 'Write [] for none.');
  // Wave 1: add-on params live in M1-10-a's add-ons.v2.json; without it the add-ons cannot be encoded yet.
  if (raw.length > 0 && !model.catalog) return (env.pending.push('catalog'), []);
  return raw.map((entry, i) => env.attempt(() => readAddOn(model, entry, i, env)));
}

function readRaise(raw, priced, env) {
  if (raw !== 'LISTING') return (env.raiseFrom = 'draft', convertUint('raise', 'uint256', raw, env, true));
  if (!priced) return undefined;
  const l = priced.listing;
  if (!l) problem('raise', `Listing ${priced.id} is not in the menu, so its raise is unknown here.`, 'Write the raise as { "decimal": "..." }, or check with --listings or --indexer.');
  return (env.raiseFrom = 'listing', l.raise);
}

function readField(model, f, raw, env, priced) {
  if (f.name === 'contentsParams' && isObject(raw)) {
    const boxType = readEnum('boxType', model.shapes.enums.get('BoxType'), env.input.boxType);
    const kind = model.shapes.enums.get('BoxType').members[boxType]?.name;
    if (!['SHOP', 'PILE'].includes(kind)) problem(f.name, 'Only shops and piles take contents settings.', 'Write "0x" for other box types.');
    const struct = kind === 'PILE' ? (raw.leaveBehindBps === undefined ? 'PileParams' : 'PileParamsV21') : 'ShopConfigV2';
    const fields = model.shapes.structs.get(struct);
    unknownKeys(raw, fields.map((p) => p.name), f.name, env, `Use only the frozen ${kind.toLowerCase()} settings in references/v2/spec-json.md.`);
    const values = Object.fromEntries(fields.map((p) => [p.name, env.attempt(() => {
      if (p.type.startsWith('uint256')) {
        const amounts = Array.isArray(raw[p.name]) ? raw[p.name] : [raw[p.name]];
        if (amounts.some((v) => typeof v !== 'string' || !/^\d+$/.test(v))) problem(`${f.name}.${p.name}`, `${kind === 'PILE' ? 'Pile seed' : 'Shop'} amounts must be decimal strings in raw ${kind === 'PILE' ? 'seed-coin' : 'box-token'} units.`, 'Write unsigned raw units as text; never a JSON number or a decimal conversion.');
      }
      return readValue(model, `${f.name}.${p.name}`, p, raw[p.name], env);
    })]));
    if (Object.values(values).some((v) => v === undefined)) return undefined;
    // Encoding only. The generated twin checks canonical contents and pure economics;
    // the launch entry checks pile listing admission separately from the one-row price context.
    return encodeAbiParameters([abiOf(model.shapes, struct)], [values]);
  }
  if (f.name === 'raise') return readRaise(raw, priced, env);
  if (f.type === 'Side') return readSide(model, f.name, raw, env);
  if (f.type === 'AddOn[]') return readAddOns(model, raw, env);
  if (raw === MARKER && (model.plain.launchFlowCanEnter?.zeroFields ?? []).includes(f.name)) return (env.launchFlow.push(f.name), zeroOf(f.type));
  const e = model.enumOf(f);
  if (e) return readEnum(f.name, e, raw);
  if (f.name === 'openAt') return convertClockTime(f.name, f.type, raw);
  if (f.type === 'string') return convertText(f.name, raw);
  if (f.type === 'address') return convertAddress(f.name, raw, env, new Map());
  if (f.type === 'bytes32') return convertBytes32(f.name, raw, env);
  if (f.type === 'bytes') return convertBytes(f.name, raw, env);
  return convertUint(f.name, f.type, raw, env, f.name === 'creatorBuy');
}

/** The wire spec for a draft's `spec`, with the listings it names, every problem, and what is pending in wave 1. */
export function buildWireV2(model, input) {
  const env = { input, description: input.description, placeholders: [], launchFlow: [], dust: [], problems: [], targets: [], pending: [], decimals: 18, unit: 'ETH' };
  env.attempt = (fn) => {
    try {
      return fn();
    } catch (error) {
      if (!(error instanceof InputProblem)) throw error;
      env.problems.push({ path: error.path, message: error.message, fix: error.fix });
      return undefined;
    }
  };
  for (const name of Object.keys(input)) {
    if (model.fieldByName.has(name)) continue;
    const now = FORMAT1_FIELDS[name];
    env.problems.push(now ? { path: name, message: `"${name}" is format 1's field.`, fix: `Write "${now}" instead (${POINTER} turns each format 1 choice into format 2's).` } : { path: name.length <= 44 ? name : '(a long field name)', message: `${show(name)} is not a format 2 field.`, fix: 'Remove it (references/v2/fields.md lists the fields).' });
  }
  const wire = {};
  const priced = 'pricing' in input ? env.attempt(() => resolveListing(model, 'pricing', input.pricing)) : undefined;
  if (priced) {
    wire.pricing = { listingId: priced.id, token: priced.address };
    env.decimals = priced.listing?.decimals ?? 18;
    env.unit = priced.listing?.symbol ?? 'the pricing token';
  }
  for (const f of model.fields) {
    if (!(f.name in input)) env.problems.push({ path: f.name, message: `"${f.name}" is missing.`, fix: `Add "${f.name}" (references/v2/fields.md).` });
    else if (f.name !== 'pricing') wire[f.name] = env.attempt(() => readField(model, f, input[f.name], env, priced));
  }
  return { wire, priced, raiseFrom: env.raiseFrom, targets: env.targets, placeholders: env.placeholders, launchFlow: env.launchFlow, dust: env.dust, problems: env.problems, pending: env.pending };
}
