/**
 * The BoxSpecV1 model the checker reads at run time (F73 launch skill): box-spec.v1.json, add-ons.v1.json and
 * plain-words.v1.json, joined with the generated library. Nothing about the structure is written down here: fields,
 * enums, offered values, ranges, rules, add-ons and version contexts come from the JSON sources, so new values appear
 * in the checker, `--menu` and the skill's field guide as soon as the spec has them. Part of scripts/check-spec.mjs.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const repoDir = resolve(pkgDir, '../..');

/** The marker a draft writes for a value the launch flow fills in (art fingerprints, the connected wallet). */
export const MARKER = 'FROM_LAUNCH_FLOW';
/** One Ethereum slot: "Now" opens in the block after Create, about this many seconds later. */
export const BLOCK_SECONDS = 12;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const ZERO32 = `0x${'0'.repeat(64)}`;

const UINT_BITS = { uint8: 8, uint16: 16, uint24: 24, uint32: 32, uint64: 64, uint128: 128, uint160: 160, uint256: 256 };
/** Solidity uints the generated TypeScript carries as `number` (the rest are bigint). */
export const isSmallUint = (type) => type in UINT_BITS && UINT_BITS[type] <= 48;
export const uintBits = (type) => UINT_BITS[type];

export function loadSources(dir = pkgDir) {
  const read = (file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
  return { spec: read('box-spec.v1.json'), catalog: read('add-ons.v1.json'), plain: read('plain-words.v1.json') };
}

const byKey = (list, key) => new Map(list.map((x) => [x[key], x]));

/** The joined model. `lib` is the generated library (contexts, validator, encoders, field ids). */
export function createModel(sources, lib) {
  const { spec, catalog, plain } = sources;
  const enums = byKey([...spec.enums, ...(catalog.enums ?? [])], 'name');
  const constants = byKey(spec.constants, 'name');
  const contexts = spec.contexts.map((c) => {
    const ctx = lib[`CONTEXT_${c.name.toUpperCase()}`];
    if (!ctx) throw new Error(`the generated library has no CONTEXT_${c.name.toUpperCase()}`);
    return { name: c.name, version: c.version, json: c, ctx };
  });
  return {
    sources,
    lib,
    spec,
    catalog,
    plain,
    enums,
    constants,
    contexts,
    fields: spec.fields,
    fieldByName: byKey(spec.fields, 'name'),
    fieldById: byKey(spec.fields, 'id'),
    addOnByKey: byKey(catalog.addOns, 'key'),
    addOnById: byKey(catalog.addOns, 'id'),
    stringRules: byKey(spec.stringRules, 'name'),
    reasonByCode: byKey(spec.reasons, 'code'),
    rules: spec.rules,
  };
}

// ------------------------------------------------------------------------------------------------ lookups

export const constValue = (model, name) => {
  const c = model.constants.get(name);
  if (!c) throw new Error(`unknown constant ${name}`);
  return BigInt(c.value);
};

/** A bound of a check: a number, a constant reference or (add-on params) a core uint field of `wire`. */
export function boundValue(model, b, wire) {
  if (typeof b === 'number' || typeof b === 'string') return BigInt(b);
  if (b?.const) return constValue(model, b.const);
  if (b?.field && wire) return BigInt(wire[b.field]);
  return undefined;
}

export const memberByName = (model, enumName, name) => model.enums.get(enumName)?.members.find((m) => m.name === name);
export const memberByValue = (model, enumName, value) => model.enums.get(enumName)?.members.find((m) => m.value === Number(value));

/** Members of an enum field that the format offers (all members when the check names no `offered` list). */
export function offeredMembers(model, enumName, offered) {
  const all = model.enums.get(enumName)?.members ?? [];
  return offered ? all.filter((m) => offered.includes(m.name)) : all;
}

export function contextByName(model, name) {
  return model.contexts.find((c) => c.name === name);
}

/** The listed Q entry (JSON form: label, decimals, presets) for an address, or undefined. */
export function qEntry(contextJson, address) {
  return contextJson.qList.find((q) => q.token.toLowerCase() === String(address).toLowerCase());
}

/** A short unit for amounts: the last word of the Q label ("native ETH" -> "ETH"). */
export const qUnit = (entry) => (entry ? entry.label.split(/\s+/).at(-1) : 'Q');

// ------------------------------------------------------------------------------------------------ plain words

const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));

export const plainField = (model, name) => model.plain.fields[name];
export const plainMember = (model, enumName, member) => model.plain.enums[enumName]?.[member];
export const plainAddOn = (model, key) => model.plain.addOns[key];
export const plainParam = (model, key, param) => model.plain.addOns[key]?.params?.[param];
export const plainRule = (model, name) => model.plain.rules[name];
export const plainNote = (model, id, vars = {}) => fill(model.plain.notes[id] ?? id, vars);

export function fieldLabel(model, name) {
  return plainField(model, name)?.label ?? name;
}

/** A member's label with {T} and {Q} filled in, e.g. "Buy back and burn GUZZ"; falls back to the member name. */
export function memberLabel(model, enumName, member, vars = {}) {
  const p = plainMember(model, enumName, member);
  return p ? fill(p.label, { T: vars.T ?? 'the token', Q: vars.Q ?? 'the pricing asset' }) : member;
}

/** A member's plain explanation with {T} and {Q} filled in (falls back to the spec's note). */
export function memberText(model, enumName, member, vars = {}) {
  const p = plainMember(model, enumName, member);
  const note = model.enums.get(enumName)?.members.find((m) => m.name === member)?.note ?? '';
  return fill(p?.plain ?? note, { T: vars.T ?? 'the token', Q: vars.Q ?? 'the pricing asset' });
}

/** What to call the pricing asset in a context's texts: its unit when only one is listed ("ETH"). */
export const contextUnit = (context) => (context.json.qList.length === 1 ? qUnit(context.json.qList[0]) : 'the pricing asset');

/** A string rule in plain words ("printable ASCII, no " or \"), falling back to its name. */
export const ruleWords = (model, rule) => model.plain.stringRules?.[rule] ?? rule;

/** Pricing assets planned for later versions (plain words: label, status, source). */
export const plannedAssets = (model) => model.plain.fields.q?.plannedAssets ?? [];

/** "Planned: USDC (a proposal for later ...), FIT (once FIT trades ...)": for refusals and the menu. */
export function plannedAssetsText(model) {
  const list = plannedAssets(model);
  return list.length === 0 ? 'Others are planned for later.' : `Planned: ${list.map((a) => `${a.label}: ${a.status}`).join('; ')}.`;
}

/** The label of the core field an enum belongs to ("Buyers' fees" for QStream), else the enum's name. */
export function enumFieldLabel(model, enumName) {
  const f = model.fields.find((x) => x.enum === enumName);
  return f ? fieldLabel(model, f.name) : enumName;
}

/**
 * A path the launch flow fills in ("coverSha256", "addOns[2].params.recipient") in the creator's words, from
 * plain-words `markerWords` (add-on settings by "<key>.<param>").
 */
export function markerWord(model, path, wire) {
  const words = model.plain.markerWords ?? {};
  const m = /^addOns\[(\d+)\]\.params\.(\w+)/.exec(path);
  if (m) {
    const key = model.addOnById.get(wire?.addOns?.[Number(m[1])]?.id)?.key;
    return words[`${key}.${m[2]}`] ?? `${key ?? 'an add-on'}'s ${m[2]}`;
  }
  return words[path.replace(/\[\d+\]$/, '')] ?? path;
}

/**
 * The launch flow's own value for an add-on setting (plain-words `addOns.<key>.launchFlow`), or undefined when the
 * launch flow has none. The ticket's name and symbol follow the collection's, as apps/web `ticketNames` does.
 */
export function launchFlowValue(model, key, param, input) {
  const lf = plainAddOn(model, key)?.launchFlow;
  if (!lf) return undefined;
  if (param === 'placeholderName' && lf.nameFrom) {
    const name = typeof input?.[lf.nameFrom] === 'string' ? input[lf.nameFrom] : '';
    return `${name.slice(0, lf.nameMax).trim()}${lf.nameSuffix}`.trim();
  }
  if (param === 'placeholderSymbol' && lf.symbolFrom) {
    const symbol = typeof input?.[lf.symbolFrom] === 'string' ? input[lf.symbolFrom] : '';
    return `${symbol.slice(0, lf.symbolMax)}${lf.symbolSuffix}`;
  }
  return typeof lf[param] === 'string' ? lf[param] : undefined;
}

/** Plain-words entries whose member or add-on the spec does not have yet: shown as coming soon. */
export function plannedItems(model) {
  const out = [];
  for (const [enumName, members] of Object.entries(model.plain.enums)) {
    const e = model.enums.get(enumName);
    for (const [name, p] of Object.entries(members)) {
      if (p.planned && !e?.members.some((m) => m.name === name)) out.push({ kind: 'member', enumName, name, plain: p });
    }
  }
  for (const [key, p] of Object.entries(model.plain.addOns)) {
    if (p.planned && !model.addOnByKey.has(key)) out.push({ kind: 'addOn', key, plain: p });
  }
  return out;
}

/** Every field, member, add-on, parameter, reason and rule of the spec that has no plain-words entry. */
export function missingPlainWords(model) {
  const missing = [];
  for (const f of model.fields) if (!plainField(model, f.name)) missing.push(`fields.${f.name}`);
  for (const [name, e] of model.enums) {
    for (const m of e.members) if (!plainMember(model, name, m.name)) missing.push(`enums.${name}.${m.name}`);
  }
  for (const a of model.catalog.addOns) {
    if (!plainAddOn(model, a.key)) missing.push(`addOns.${a.key}`);
    for (const p of a.params) if (!plainParam(model, a.key, p.name)) missing.push(`addOns.${a.key}.params.${p.name}`);
  }
  for (const r of model.spec.reasons) if (!model.plain.reasons[r.name]) missing.push(`reasons.${r.name}`);
  for (const r of model.rules) if (!plainRule(model, r.name)) missing.push(`rules["${r.name}"]`);
  for (const s of model.spec.stringRules) if (!model.plain.stringRules?.[s.name]) missing.push(`stringRules.${s.name}`);
  const stepFields = new Set(model.plain.steps.flatMap((s) => s.fields));
  for (const f of model.fields) if (!stepFields.has(f.name)) missing.push(`steps (field ${f.name} is in no step)`);
  return missing;
}

// ------------------------------------------------------------------------------------------------ amounts (bigint only)

const group = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** A raw amount as a decimal with `decimals` places, trailing zeros dropped: 4200000000000000000n, 18 -> "4.2". */
export function decimalText(raw, decimals, { grouped = true } = {}) {
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = (value / scale).toString();
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  const w = grouped ? group(whole) : whole;
  return fraction ? `${w}.${fraction}` : w;
}

/** "1.25" with 18 decimals -> 1250000000000000000n; null when it is not a plain decimal or has too many places. */
export function parseDecimal(text, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(text).trim().replace(/,/g, ''));
  if (!m) return null;
  const fraction = m[2] ?? '';
  if (fraction.length > decimals) return null;
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

/** Basis points as a percentage, truncated to one decimal: 1322n -> "13.2%". */
export function percentText(bps) {
  const b = BigInt(bps);
  const tenth = (b % 100n) / 10n;
  return tenth === 0n ? `${b / 100n}%` : `${b / 100n}.${tenth}%`;
}

export const groupedInt = (v) => group(BigInt(v).toString());

/**
 * A spec time (Unix seconds, UTC) as "2026-10-06 18:00 UTC", with ":ss" only when the seconds are not zero
 * (open-at-clock-time.md: field 15 openAt). Out of Date's range: the plain number.
 */
export function utcText(seconds) {
  const value = BigInt(seconds);
  if (value < 0n || value > 8_640_000_000_000n) return `${value} (Unix seconds)`;
  const iso = new Date(Number(value) * 1000).toISOString();
  const time = iso.slice(17, 19) === '00' ? iso.slice(11, 16) : iso.slice(11, 19);
  return `${iso.slice(0, 10)} ${time} UTC`;
}

// ------------------------------------------------------------------------------------------------ predicates

const isZeroValue = (v) => (typeof v === 'string' ? /^0x0*$/.test(v) : BigInt(v) === 0n);

/** An enum name or number in a predicate, as the wire value. */
function wireValueOf(model, field, value) {
  if (field?.enum && typeof value === 'string') return memberByName(model, field.enum, value)?.value ?? Number.NaN;
  return value;
}

const sameValue = (a, b) => (typeof a === 'bigint' || typeof b === 'bigint' ? BigInt(a) === BigInt(b) : a === b);

/**
 * The predicate language of box-spec.v1.json `rules`, field `zeroWhen` and add-on `requires`, evaluated on a wire spec.
 * `own` is { addOn, values } for an add-on's own `requires`, whose predicates may name its uint parameters.
 */
export function holds(model, p, wire, contextJson, own) {
  if (p.all) return p.all.every((x) => holds(model, x, wire, contextJson, own));
  if (p.any) return p.any.some((x) => holds(model, x, wire, contextJson, own));
  if (p.not) return !holds(model, p.not, wire, contextJson, own);
  if (p.hasAddOn) return wire.addOns.some((a) => a.id === model.addOnByKey.get(p.hasAddOn)?.id);
  if (p.addOnParam) {
    // A rule that reads an add-on's setting (core v1: royalties to CREATOR pay creatorFeeRecipient): the i-th head word
    // of an entry's params (rules run after every add-on passed its checks, so the params are canonical).
    const { addOn: key, param, eq } = p.addOnParam;
    const a = model.addOnByKey.get(key);
    const i = a ? a.params.findIndex((x) => x.name === param) : -1;
    if (i < 0) return false;
    const enumName = a.params[i].enum;
    const want = BigInt(typeof eq === 'string' && enumName ? (memberByName(model, enumName, eq)?.value ?? -1) : eq);
    const word = (hex) => (hex.length >= 2 + 64 * (i + 1) ? BigInt(`0x${hex.slice(2 + 64 * i, 2 + 64 * (i + 1))}`) : null);
    return wire.addOns.some((entry) => entry.id === a.id && word(String(entry.params)) === want);
  }
  if (p.qClassIn) {
    const entry = qEntry(contextJson, wire.q);
    return entry !== undefined && p.qClassIn.includes(entry.qClass);
  }
  if (p.param !== undefined) {
    const enumName = own?.addOn.params.find((x) => x.name === p.param)?.enum;
    const v = (x) => Number(typeof x === 'string' && enumName ? memberByName(model, enumName, x)?.value : x);
    const actual = Number(own?.values[p.param]);
    if ('eq' in p) return actual === v(p.eq);
    if ('ne' in p) return actual !== v(p.ne);
    return false;
  }
  const field = model.fieldByName.get(p.field);
  const value = wire[p.field];
  if ('eq' in p) return sameValue(value, wireValueOf(model, field, p.eq));
  if ('ne' in p) return !sameValue(value, wireValueOf(model, field, p.ne));
  if (p.in) return p.in.some((x) => sameValue(value, wireValueOf(model, field, x)));
  if (p.lt) return BigInt(value) < BigInt(wire[p.lt.field]);
  if (p.zero) return isZeroValue(value);
  if (p.nonZero) return !isZeroValue(value);
  return false;
}

/** The rule (box-spec.v1.json `rules`) behind a verdict: same reason and field, its `when` true and `require` false. */
export function ruleFor(model, verdict, wire, contextJson) {
  const reasonName = model.reasonByCode.get(verdict.reason)?.name;
  const fieldName = model.fieldById.get(verdict.field)?.name;
  return model.rules.find(
    (r) => r.reason === reasonName && r.field === fieldName && holds(model, r.when, wire, contextJson) && !holds(model, r.require, wire, contextJson),
  );
}
