/**
 * Reading a BoxSpec JSON into the wire form the generated validator checks (F73 launch skill). Three shapes are read:
 *   - a draft (`squarehole.boxspec-draft/1`, written by an assistant or by hand): enum members by name, amounts as
 *     { "decimal": "0.05" } in whole units of Q, add-ons by key with named settings, and "FROM_LAUNCH_FLOW" where the
 *     launch flow fills a value in (art fingerprints, the connected wallet) or sets a text itself (the placeholders'
 *     ticket texts and neutral picture, read from plain-words `launchFlow`: those become the exact values);
 *   - the launch flow's "Download BoxSpec" file (`squarehole.boxspec/1`: the wire spec, its encoding and hash);
 *   - a bare spec, and the package fixtures ({ "spec": ... } with keccakOfText, sha256OfText, addressOfText, formatV1).
 * Every problem in the JSON is collected (not only the first), each with a plain fix. Amounts stay bigint throughout.
 */
import { createHash } from 'node:crypto';
import { decodeAbiParameters, encodeAbiParameters, getAddress, keccak256, stringToBytes, toHex } from 'viem';
import {
  MARKER,
  ZERO32,
  ZERO_ADDRESS,
  contextByName,
  decimalText,
  isSmallUint,
  launchFlowValue,
  memberByName,
  memberLabel,
  offeredMembers,
  parseDecimal,
  plainField,
  plainMember,
  plainAddOn,
  plainParam,
  plannedAssetsText,
  qEntry,
  qUnit,
  uintBits,
} from './spec-model.mjs';

export const DRAFT_FORMAT = 'squarehole.boxspec-draft/1';
export const FILE_FORMAT = 'squarehole.boxspec/1';

class InputProblem extends Error {
  constructor(path, message, fix) {
    super(message);
    this.path = path;
    this.fix = fix;
  }
}
const problem = (path, message, fix) => {
  throw new InputProblem(path, message, fix);
};
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A raw value for a message: short values in JSON, anything longer only by its size (it may be pasted text). */
export const show = (v) => {
  const text = JSON.stringify(v) ?? String(v);
  return text.length <= 44 ? text : `a ${typeof v === 'string' ? `${v.length}-character text` : 'long value'}`;
};
/** A field name as a problem's path: as written when short, by its size when long (it may be pasted text). */
const shownName = (name) => (name.length <= 44 ? name : `(a ${name.length}-character field name)`);

/** Which shape the JSON has, the version context it names and its parts. */
export function readDocument(doc, model) {
  const problems = [];
  if (!isObject(doc)) {
    return { problems: [{ path: '', message: 'The file is not a JSON object.', fix: `Start from { "format": "${DRAFT_FORMAT}", "context": "v2", "spec": { ... } }.` }] };
  }
  let kind;
  if (doc.format === FILE_FORMAT) kind = 'download';
  else if (doc.format === DRAFT_FORMAT) kind = 'draft';
  else if (doc.format !== undefined) {
    problems.push({ path: 'format', message: `Unknown format ${show(doc.format)}.`, fix: `Use "${DRAFT_FORMAT}" for a draft.` });
  } else if (isObject(doc.spec)) kind = 'draft';
  else if ('tokenName' in doc || 'version' in doc) kind = 'bare';
  else problems.push({ path: '', message: 'This is not a BoxSpec: no "spec" object found.', fix: `Wrap the fields as { "format": "${DRAFT_FORMAT}", "context": "v2", "spec": { ... } }.` });
  const spec = kind === 'bare' ? doc : doc.spec;
  if (kind && !isObject(spec)) problems.push({ path: 'spec', message: '"spec" must be an object of BoxSpec fields.', fix: 'See references/spec-json.md.' });
  const version = isObject(spec) ? Number(spec.version) : Number.NaN;
  const contextName = kind === 'bare' ? undefined : doc.context;
  const context = contextName !== undefined ? contextByName(model, contextName) : (model.contexts.find((c) => c.version === version) ?? model.contexts.at(-1));
  if (!context) {
    problems.push({ path: 'context', message: `Unknown context ${show(contextName)}.`, fix: `Use one of: ${model.contexts.map((c) => `"${c.name}"`).join(', ')} ("v2" for every new box).` });
  } else if (Number.isInteger(version) && version !== context.version && model.contexts.some((c) => c.version === version)) {
    problems.push({ path: 'context', message: `Context "${context.name}" is for version ${context.version} boxes, but the spec says version ${version}.`, fix: `Every new box is "context": "v2" with "version": 2.` });
  }
  const declared = kind === 'download' ? { specHash: doc.specHash, encoded: doc.encoded } : undefined;
  return { kind, spec, context, site: isObject(doc.site) ? doc.site : undefined, declared, problems };
}

// ------------------------------------------------------------------------------------------------ values

const standIn32 = (path) => keccak256(stringToBytes(`${MARKER} ${path}`));
const standInAddress = (path) => getAddress(`0x${standIn32(path).slice(-40)}`);
const isZeroWord = (raw) => raw === 0 || raw === '0' || raw === '0x0' || raw === '0x';

function convertAddress(path, raw, env, constants) {
  if (raw === MARKER) {
    env.placeholders.push(path);
    return standInAddress(path);
  }
  if (isZeroWord(raw)) return ZERO_ADDRESS;
  if (typeof raw === 'string' && /^0x[0-9a-fA-F]{40}$/.test(raw)) {
    const checksummed = getAddress(raw.toLowerCase());
    const mixed = /[a-f]/.test(raw.slice(2)) && /[A-F]/.test(raw.slice(2));
    if (mixed && raw !== checksummed) problem(path, `${raw} has mixed case but is not its checksum: one character may be wrong.`, 'Copy the address again, or write it all in lower case.');
    return checksummed;
  }
  if (isObject(raw) && typeof raw.addressOfText === 'string') return getAddress(`0x${keccak256(stringToBytes(raw.addressOfText)).slice(-40)}`);
  if (isObject(raw) && typeof raw.const === 'string' && constants.get(raw.const)?.type === 'address') return getAddress(constants.get(raw.const).value);
  if (typeof raw === 'string' && /^0x[0-9a-fA-F]*$/.test(raw)) problem(path, `This is not a full address: it has ${raw.length - 2} hex characters after 0x, an address has 40.`, 'Paste the whole public address, or write "FROM_LAUNCH_FLOW" for the wallet connected at launch.');
  return problem(path, `${show(raw)} is not an address.`, 'Write a public 0x address (never a private key or seed phrase), or "FROM_LAUNCH_FLOW" for the wallet connected at launch.');
}

function convertBytes32(path, raw, env) {
  if (raw === MARKER) {
    env.placeholders.push(path);
    return standIn32(path);
  }
  if (isZeroWord(raw)) return ZERO32;
  if (typeof raw === 'string' && /^0x[0-9a-fA-F]{64}$/.test(raw)) return raw.toLowerCase();
  if (isObject(raw) && typeof raw.keccakOfText === 'string') return keccak256(stringToBytes(raw.keccakOfText));
  if (isObject(raw) && typeof raw.sha256OfText === 'string') return `0x${createHash('sha256').update(raw.sha256OfText, 'utf8').digest('hex')}`;
  return problem(path, `${show(raw)} is not a 32-byte value.`, `Write "${MARKER}" (the launch flow computes it) or 0x and 64 hex characters.`);
}

/** The metadata table v1 (the collection's format, as packages/artwork encodes it): version, description, traits. */
function encodeTableV1(path, table, description) {
  const text = (s, what, min, max) => {
    if (typeof s !== 'string' || !/^[\x20-\x7e]*$/.test(s) || /["\\]/.test(s)) problem(path, `${what} ${show(s)} is not plain text.`, 'Use printable ASCII without " or \\ (no emoji or accents).');
    const b = Buffer.from(s, 'ascii');
    if (b.length < min || b.length > max) problem(path, `${what} ${show(s)} must be ${min} to ${max} characters.`, 'Shorten it.');
    return b;
  };
  const traitTypes = table.traitTypes ?? [];
  if (!Array.isArray(traitTypes) || traitTypes.length > 16) problem(path, 'traitTypes must be a list of at most 16 trait types.', 'Merge or drop trait types.');
  const d = text(table.description ?? description ?? '', 'The description', 0, 0xffff);
  const parts = [Buffer.from([1, d.length >> 8, d.length & 0xff]), d, Buffer.from([traitTypes.length])];
  for (const t of traitTypes) {
    const name = text(t?.name, 'The trait name', 1, 255);
    if (!Array.isArray(t.values) || t.values.length < 1 || t.values.length > 255) problem(path, `Trait ${show(t.name)} needs 1 to 255 values.`, 'List its values, e.g. ["Red", "Blue"].');
    parts.push(Buffer.from([name.length]), name, Buffer.from([t.values.length]));
    for (const v of t.values) {
      const value = text(v, `The value of ${t.name}`, 1, 255);
      parts.push(Buffer.from([value.length]), value);
    }
  }
  return toHex(Buffer.concat(parts));
}

function convertBytes(path, raw, env) {
  if (raw === MARKER) {
    env.placeholders.push(path);
    return encodeTableV1(path, { traitTypes: [] }, '');
  }
  if (typeof raw === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(raw)) return raw.toLowerCase();
  if (isObject(raw) && isObject(raw.formatV1)) {
    // The table repeats the description; one that is not plain text is reported on "description" by the validator.
    const plainDescription = typeof env.description === 'string' && /^[\x20-\x7e]*$/.test(env.description) && !/["\\]/.test(env.description);
    return encodeTableV1(path, raw.formatV1, plainDescription ? env.description : '');
  }
  return problem(path, `${show(raw)} is not a byte string.`, `Write "${MARKER}" or { "formatV1": { "traitTypes": [ { "name": "Colour", "values": ["Red"] } ] } }.`);
}

/**
 * The fix for an amount written as a JSON number: a small number is read as whole units of Q ({ "decimal": "4" } for
 * 4 ETH); a whole number from a millionth of a unit up (10^(decimals - 6) or more) is raw units, so the fix names the
 * decimal it comes to and the exact integer the JSON number reads as, never { "decimal": "4000000000000000000" }.
 */
function jsonNumberFix(raw, env) {
  const rawUnits = Number.isInteger(raw) && raw >= 0 && env.decimals > 0 && raw >= 10 ** Math.max(env.decimals - 6, 0);
  if (rawUnits) {
    const value = BigInt(raw);
    const text = decimalText(value, env.decimals, { grouped: false });
    return `Write { "decimal": "${text}" } for ${text} ${env.unit} (this JSON number reads as ${value} raw units), or the raw integer as a string: "${value}".`;
  }
  const text = /e/i.test(String(raw)) ? raw.toFixed(env.decimals).replace(/\.?0+$/, '') : String(raw);
  return `Write { "decimal": "${text}" } for ${text} ${env.unit}, or the raw integer as a string.`;
}

function convertUint(path, type, raw, env, amount) {
  let value;
  if (amount && isObject(raw) && 'decimal' in raw) {
    value = parseDecimal(raw.decimal, env.decimals);
    if (value === null) problem(path, `${show(raw.decimal)} is not a plain decimal with at most ${env.decimals} decimal places.`, `Write it like { "decimal": "0.05" } (in ${env.unit}).`);
  } else if (typeof raw === 'number') {
    if (amount) problem(path, `Amounts are written as text, not as JSON numbers (a JSON number loses precision).`, jsonNumberFix(raw, env));
    if (!Number.isSafeInteger(raw) || raw < 0) problem(path, `${raw} is not a whole number.`, 'Use a whole number such as 300.');
    value = BigInt(raw);
  } else if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    value = BigInt(raw);
  } else {
    const hint = amount ? `Write { "decimal": "1" } for 1 ${env.unit}, or the raw integer as a string.` : 'Use a whole number such as 300.';
    problem(path, `${show(raw)} is not a whole number.`, hint);
  }
  if (value >= 1n << BigInt(uintBits(type))) problem(path, `${value} is too large for a ${type}.`, 'Use a smaller number.');
  if (amount && value > 0n && value < 10n ** BigInt(Math.max(env.decimals - 6, 0))) env.dust.push({ path, value });
  return isSmallUint(type) ? Number(value) : value;
}

/**
 * A clock time (field 15 openAt, open-at-clock-time.md): 0 or "NOW" (Now: the block after Create), Unix seconds as a
 * whole number, or a UTC time as text ("2026-10-06T18:00:00Z"; the zone must be UTC, Z or +00:00 or " UTC", so a local
 * time is never guessed), also inside { "utc": "..." } (the form the contracts' branch taught; review of open-at,
 * finding 4: both forms read, to the same value). Its range is the validator's (0, or 2026-09-01 or later; the factory's
 * 14-day horizon at Create).
 */
const UTC_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:Z|\+00:00| ?UTC)$/i;
const UTC_FIX = 'Write it like "2026-10-06T18:00:00Z" (UTC, ending in Z), or 0 for Now.';
const TIME_FIX = 'Write 0 for Now, or a UTC time like "2026-10-06T18:00:00Z".';

/** UTC text to Unix seconds (a number), or an input problem naming `raw`. */
function utcSeconds(path, type, text, raw) {
  const m = UTC_TIME.exec(text.trim());
  if (!m) problem(path, `${show(raw)} is not a UTC time.`, UTC_FIX);
  const [y, mo, d, h, mi, se] = m.slice(1).map((x) => Number(x ?? 0));
  const ms = Date.UTC(y, mo - 1, d, h, mi, se);
  const back = new Date(ms);
  // Date.UTC rolls 2026-02-30 into March and reads a two-digit year as 19xx: a time that does not read back the same
  // is not a time that exists.
  if (!Number.isFinite(ms) || back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || se > 59) {
    problem(path, `${show(raw)} is not a date and time that exists.`, UTC_FIX);
  }
  const seconds = BigInt(Math.floor(ms / 1000));
  if (seconds < 0n || seconds >= 1n << BigInt(uintBits(type))) problem(path, `${show(raw)} is outside what a ${type} holds.`, 'Pick a time within 14 days, or 0 for Now.');
  return Number(seconds);
}

function convertClockTime(path, type, raw) {
  if (isObject(raw) && typeof raw.utc === 'string') return utcSeconds(path, type, raw.utc, raw);
  if (typeof raw === 'string' && raw.trim().toUpperCase() === 'NOW') return 0;
  if (typeof raw === 'string' && /[-:]/.test(raw)) return utcSeconds(path, type, raw, raw);
  if (typeof raw !== 'number' && !(typeof raw === 'string' && /^\d+$/.test(raw))) problem(path, `${show(raw)} is not a time.`, TIME_FIX);
  return convertUint(path, type, raw, {}, false);
}

function convertEnum(model, path, enumName, raw, offered) {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 255) return raw;
  // Members with `limits` (BURN_Q without a burnable pricing asset, box 0's stream) would only be refused next.
  const choices = offeredMembers(model, enumName, offered)
    .filter((m) => !plainMember(model, enumName, m.name)?.limits)
    .map((m) => `"${m.name}"`)
    .join(', ');
  if (typeof raw !== 'string') return problem(path, `${show(raw)} is not a choice.`, `Pick one of: ${choices}.`);
  const member = memberByName(model, enumName, raw) ?? model.enums.get(enumName)?.members.find((m) => m.name.toLowerCase() === raw.toLowerCase());
  if (member) return member.value;
  const planned = plainMember(model, enumName, raw.toUpperCase());
  if (planned?.planned) return problem(path, `"${raw}" (${memberLabel(model, enumName, raw.toUpperCase())}) is coming soon: not in this version of the spec yet (${planned.planned}).`, `Pick one of today's choices: ${choices}.`);
  return problem(path, `${show(raw)} is not a choice for ${path}.`, `Pick one of: ${choices}.`);
}

function convertQ(model, raw, context, env) {
  if (typeof raw === 'string' && !raw.startsWith('0x')) {
    const want = raw.trim().toLowerCase();
    const entry = context.json.qList.find((q) => q.label.toLowerCase() === want || qUnit(q).toLowerCase() === want);
    if (entry) return getAddress(entry.token);
    const listed = context.json.qList.map((q) => `"${qUnit(q)}"`).join(', ');
    return problem('q', `${show(raw)} is not on this version's list of pricing assets.`, `Today: ${listed}. ${plannedAssetsText(model)}`);
  }
  return convertAddress('q', raw, env, model.constants);
}

// ------------------------------------------------------------------------------------------------ add-ons

/** Text is never filled in by the launch flow: the marker would become the text itself. */
function convertText(path, raw) {
  if (typeof raw !== 'string') problem(path, `${show(raw)} is not text.`, 'Write it in quotes.');
  if (raw === MARKER) problem(path, `"${MARKER}" is only for fingerprints, addresses and the launch flow's ticket texts; here it would become the text itself.`, 'Write the text.');
  return raw;
}

function convertParam(model, path, p, raw, env, key) {
  if (p.type === 'string' && raw === MARKER) {
    // An add-on whose texts the launch flow sets itself (the placeholders' ticket texts and neutral picture).
    const value = launchFlowValue(model, key, p.name, env.input);
    if (value !== undefined) {
      env.launchFlow.push(path);
      return value;
    }
  }
  if (p.type === 'string') return convertText(path, raw);
  if (p.type === 'address') return convertAddress(path, raw, env, model.constants);
  if (p.type === 'bytes32') return convertBytes32(path, raw, env);
  if (p.type === 'bytes32[]') {
    if (!Array.isArray(raw)) problem(path, `${show(raw)} is not a list.`, 'Write a list such as [] or ["FROM_LAUNCH_FLOW"].');
    return raw.map((x, i) => convertBytes32(`${path}[${i}]`, x, env));
  }
  if (p.type === 'bool') {
    if (typeof raw !== 'boolean') problem(path, `${show(raw)} is not true or false.`, 'Write true or false.');
    return raw;
  }
  if (p.enum && typeof raw === 'string') return convertEnum(model, path, p.enum, raw, p.offered);
  // An amount setting (the creator-fee cap, F74 U2) reads { "decimal": "4" } in whole units of Q, like the raise.
  return convertUint(path, p.type, raw, env, plainParam(model, key, p.name)?.amountInQ === true);
}

/** The largest add-on id the wire format holds (`addOns` carries (uint16 id, bytes params), add-ons.v1.json). */
const MAX_ADD_ON_ID = 0xffff;
const byKeyFix = (model) => `Write the add-on by key instead, { "addOn": "<key>", "params": { ... } }, with one of: ${model.catalog.addOns.map((a) => `"${a.key}"`).join(', ')}.`;

/** A wire-form entry ({ id, params }), as in a download or a bare spec. */
function convertRawAddOn(model, entry, at) {
  if (!Number.isInteger(entry.id) || entry.id < 0 || entry.id > MAX_ADD_ON_ID) {
    problem(`${at}.id`, `${show(entry.id)} is not an add-on id: ids are whole numbers from 0 to ${MAX_ADD_ON_ID.toLocaleString('en-US')}, and the catalog has ${model.catalog.addOns.map((a) => `${a.id} (${a.key})`).join(', ')}.`, byKeyFix(model));
  }
  if (typeof entry.params !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(entry.params)) problem(`${at}.params`, 'params must be hex bytes (0x and pairs of hex digits).', byKeyFix(model));
  return { id: entry.id, params: entry.params.toLowerCase() };
}

function convertAddOn(model, entry, i, env) {
  const at = `addOns[${i}]`;
  if (isObject(entry) && 'id' in entry && !('addOn' in entry)) return convertRawAddOn(model, entry, at);
  if (!isObject(entry) || typeof entry.addOn !== 'string') {
    return problem(at, `${show(entry)} is not an add-on.`, 'Write { "addOn": "<key>", "params": { ... } }.');
  }
  const a = model.addOnByKey.get(entry.addOn);
  if (!a) {
    const planned = plainAddOn(model, entry.addOn);
    if (planned?.planned) return problem(at, `The add-on "${entry.addOn}" (${planned.label}) is coming soon: not in this version of the spec yet (${planned.planned}).`, 'Leave it out for now and note it for later.');
    return problem(at, `${show(entry.addOn)} is not an add-on.`, `Add-ons: ${model.catalog.addOns.map((x) => `"${x.key}"`).join(', ')}.`);
  }
  // "params": "FROM_LAUNCH_FLOW" (or no params, or a setting left out): the value the launch flow sets itself, for an
  // add-on that has one (the placeholders' ticket texts and neutral picture).
  const hasLaunchFlow = Boolean(plainAddOn(model, a.key)?.launchFlow);
  if (entry.params === MARKER && !hasLaunchFlow) problem(`${at}.params`, `The launch flow does not fill in the "${a.key}" settings.`, 'Write its settings (see references/fields.md).');
  if (entry.params !== undefined && entry.params !== MARKER && !isObject(entry.params)) problem(`${at}.params`, `${show(entry.params)} is not a list of settings.`, `Write { "addOn": "${a.key}", "params": { ... } }${hasLaunchFlow ? ` or "params": "${MARKER}"` : ''}.`);
  const given = isObject(entry.params) ? entry.params : {};
  const params = hasLaunchFlow ? { ...Object.fromEntries(a.params.filter((p) => launchFlowValue(model, a.key, p.name, env.input) !== undefined).map((p) => [p.name, MARKER])), ...given } : given;
  for (const name of Object.keys(params)) {
    if (!a.params.some((p) => p.name === name)) problem(`${at}.params.${name}`, `"${a.key}" has no setting ${show(name)}.`, `Its settings: ${a.params.map((p) => `"${p.name}"`).join(', ') || 'none'}.`);
  }
  const values = a.params.map((p) => {
    const path = `${at}.params.${p.name}`;
    if (!(p.name in params)) problem(path, `The ${a.key} setting "${p.name}" is missing.`, 'Add it (see references/fields.md).');
    return convertParam(model, path, p, params[p.name], env, a.key);
  });
  const abi = model.lib.ADD_ON_PARAMS_ABI[a.id];
  return { id: a.id, params: a.params.length === 0 ? '0x' : encodeAbiParameters(abi, values) };
}

/** An add-on entry's settings by name (decoded from its params), or null when they do not decode. */
export function addOnValues(model, entry) {
  const a = model.addOnById.get(entry.id);
  const abi = model.lib.ADD_ON_PARAMS_ABI[entry.id];
  if (!a || !abi) return null;
  if (a.params.length === 0) return entry.params === '0x' ? {} : null;
  try {
    const decoded = decodeAbiParameters(abi, entry.params);
    return Object.fromEntries(a.params.map((p, i) => [p.name, decoded[i]]));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ the spec

function convertField(model, f, raw, env) {
  if (f.name === 'q') return convertQ(model, raw, env.context, env);
  // A field the launch flow always writes as zero (plain-words launchFlowCanEnter.zeroFields): the marker is that zero.
  if (raw === MARKER && (model.plain.launchFlowCanEnter?.zeroFields ?? []).includes(f.name)) {
    env.launchFlow.push(f.name);
    return f.type === 'bytes32' ? ZERO32 : f.type === 'address' ? ZERO_ADDRESS : 0n;
  }
  if (f.enum) return convertEnum(model, f.name, f.enum, raw, f.check?.offered);
  if (f.type === 'string') return convertText(f.name, raw);
  if (f.type === 'address') return convertAddress(f.name, raw, env, model.constants);
  if (f.type === 'bytes32') return convertBytes32(f.name, raw, env);
  if (f.type === 'bytes') return convertBytes(f.name, raw, env);
  if (uintBits(f.type) && plainField(model, f.name)?.clockTime === true) return convertClockTime(f.name, f.type, raw);
  if (uintBits(f.type)) return convertUint(f.name, f.type, raw, env, plainField(model, f.name)?.amountInQ === true);
  return problem(f.name, `Cannot read field type ${f.type}.`, 'Report this to the Square Hole team.');
}

function missingFix(model, f) {
  const p = plainField(model, f.name);
  if (f.chosenBy === 'Version' || f.chosenBy === 'Factory') return `Add "${f.name}": ${show(p?.default ?? '')} (set by the version).`;
  return `Add "${f.name}" (${p?.label ?? f.name}; default: ${p?.default ?? 'none'}).`;
}

/**
 * The wire spec for `input` (a draft, download or bare spec) in `context`, with every problem found, the paths filled
 * with stand-ins for "FROM_LAUNCH_FLOW" and amounts that look like a unit mistake (raw dust).
 */
export function buildWire(model, input, context) {
  const env = { context, input, placeholders: [], launchFlow: [], dust: [], problems: [], decimals: 18, unit: 'Q', description: input.description };
  const wire = {};
  const attempt = (fn) => {
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
    const lower = name.toLowerCase();
    const near = model.fields.find((f) => f.name.toLowerCase() === lower || (plainField(model, f.name)?.aliases ?? []).some((a) => a.toLowerCase() === lower));
    env.problems.push({ path: shownName(name), message: `${show(name)} is not a BoxSpec field.`, fix: near ? `Did you mean "${near.name}"?` : 'Remove it (see references/fields.md for the fields).' });
  }
  if ('q' in input) wire.q = attempt(() => convertQ(model, input.q, context, env));
  const entry = wire.q ? qEntry(context.json, wire.q) : undefined;
  env.decimals = entry?.decimals ?? 18;
  env.unit = qUnit(entry);
  for (const f of model.fields) {
    if (!(f.name in input)) {
      env.problems.push({ path: f.name, message: `"${f.name}" is missing.`, fix: missingFix(model, f) });
    } else if (f.type === 'AddOn[]') {
      const list = input.addOns;
      if (!Array.isArray(list)) env.problems.push({ path: 'addOns', message: '"addOns" must be a list.', fix: 'Write [] for none.' });
      else wire.addOns = list.map((a, i) => attempt(() => convertAddOn(model, a, i, env)));
    } else if (f.name !== 'q') {
      wire[f.name] = attempt(() => convertField(model, f, input[f.name], env));
    }
  }
  return {
    wire,
    placeholders: env.placeholders,
    launchFlow: env.launchFlow,
    dust: env.dust.map((d) => ({ ...d, text: decimalText(d.value, env.decimals) })),
    problems: env.problems,
  };
}

/** The value readers format 2's drafts share with format 1's (spec-input-v2.mjs, M1-11): same inputs, same fixes. */
export { InputProblem, convertAddress, convertBytes, convertBytes32, convertClockTime, convertText, convertUint };
