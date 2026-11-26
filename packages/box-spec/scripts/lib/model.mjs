/**
 * The BoxSpecV1 source model (box-spec.v1.json, add-ons.v1.json, cases.v1.json), its consistency checks, naming and
 * the predicate language shared by both emitters. Part of packages/box-spec/scripts/generate.mjs.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';
import { holderOfferProblems } from './holder-guard.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '../..');
const repoDir = resolve(pkgDir, '../..');
const contractsDir = join(repoDir, 'packages/contracts');

const PUBLIC_NAMES = join(contractsDir, 'src/v2/names/launch/PublicNames.sol');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const fail = (message) => {
  throw new Error(`box-spec generator: ${message}`);
};
const assert = (condition, message) => {
  if (!condition) fail(message);
};

// ---------------------------------------------------------------------------------------------------------------
// Source model
// ---------------------------------------------------------------------------------------------------------------

const spec = readJson(join(pkgDir, 'box-spec.v1.json'));
const catalog = readJson(join(pkgDir, 'add-ons.v1.json'));
const casesFile = readJson(join(pkgDir, 'vectors/cases.v1.json'));

const UINT_BITS = { uint8: 8, uint16: 16, uint24: 24, uint32: 32, uint40: 40, uint64: 64, uint128: 128, uint160: 160, uint256: 256 };
/** Solidity uint types that viem (and our TS types) carry as `number`; wider ones are bigint. */
const isSmallUint = (type) => type in UINT_BITS && UINT_BITS[type] <= 48;
const PARAM_KINDS = {
  uint8: 1,
  uint16: 2,
  uint32: 3,
  uint64: 4,
  uint128: 5,
  uint256: 6,
  bool: 7,
  address: 8,
  bytes32: 9,
  string: 10,
  'bytes32[]': 11,
};
/** The Solidity and TS name of a parameter kind (`_K_BYTES32_ARRAY`, `ParamKind.BYTES32_ARRAY`). */
const paramKindName = (type) => (type === 'bytes32[]' ? 'BYTES32_ARRAY' : type.toUpperCase());

/** V: read in code or a decision row; P: a proposal (plan, box-factory) that the named slice fixes. */
const CONSTANT_STATUS = new Set(['V', 'P']);
/**
 * Where a creator may choose a value (F74 U1). `mainnet` is validate()'s own list (the factory's check on every chain,
 * the default). An enum member offered only on some networks names them in `offeredOn` (never mainnet: what mainnet
 * offers is the field's own `offered` list) with a `pending` note the page shows beside it. A member validate() offers
 * that core v1 does not build names the networks that leave it out in `notBuiltOn` (Sepolia: the receiver reverts
 * ActionNotBuilt at initialize) with a `notBuilt` note; mainnet keeps validate()'s list and the Demo shows all of it.
 * Holder payouts are never offered on mainnet (holder-guard.mjs).
 */
const NETWORKS = ['demo', 'sepolia', 'mainnet'];
const STRICTEST_NETWORK = 'mainnet';
const SLICE = /^S(?:\d+|10a|10b)$/;

const constants = new Map();
for (const c of spec.constants) {
  assert(!constants.has(c.name), `constant ${c.name} twice`);
  assert(CONSTANT_STATUS.has(c.status), `constant ${c.name}: status V or P`);
  assert(c.slice === undefined || SLICE.test(c.slice), `constant ${c.name}: slice ${c.slice}`);
  let value;
  if (c.type === 'address') value = getAddress(c.value);
  else if (c.type === 'bytes32') {
    assert(/^0x[0-9a-f]{64}$/.test(c.value), `constant ${c.name}: 32 lower-case hex bytes`);
    value = c.value;
  } else value = BigInt(c.value);
  constants.set(c.name, { ...c, value });
}
/** Fixed per version, but no value exists yet (an address deployed by a later slice). Not emitted. */
for (const later of spec.fixedLater) {
  assert(!constants.has(later.name), `fixedLater ${later.name} is also a constant`);
  assert(later.status === 'P' && SLICE.test(later.slice), `fixedLater ${later.name}: status P and the slice that fixes it`);
}
const constValue = (name) => {
  const c = constants.get(name);
  assert(c, `unknown constant ${name}`);
  return c.value;
};

/** The spec's enums and the catalog's (an add-on parameter may name one, e.g. RoyaltyDestination). */
const enums = new Map();
for (const e of [...spec.enums, ...(catalog.enums ?? [])]) {
  assert(!enums.has(e.name), `enum ${e.name} twice`);
  const values = new Set();
  for (const m of e.members) {
    assert(Number.isInteger(m.value) && m.value >= 1 && m.value <= 255, `${e.name}.${m.name}: members are 1-255`);
    assert(!values.has(m.value), `${e.name}: value ${m.value} twice`);
    values.add(m.value);
    // Fee-kind metadata (F70): what a payout does, for the creation page; data only, validate() does not read it.
    for (const flag of ['buys', 'sells']) assert(m[flag] === undefined || m[flag] === true, `${e.name}.${m.name}: ${flag} is true or absent`);
    assert(!(m.buys && m.sells), `${e.name}.${m.name}: buys or sells, not both`);
    assert(m.kind === undefined || ['CREATOR', 'HOLDERS', 'BURN', 'STREAM'].includes(m.kind), `${e.name}.${m.name}: kind ${m.kind}`);
    assert(m.paidIn === undefined || ['Q', 'T'].includes(m.paidIn), `${e.name}.${m.name}: paidIn Q or T`);
    if (m.offeredOn !== undefined) {
      // F74 U1: offered beside the strictest network only where named; mainnet never (it is validate()'s own list).
      assert(Array.isArray(m.offeredOn) && m.offeredOn.length > 0, `${e.name}.${m.name}: offeredOn lists networks`);
      for (const n of m.offeredOn) assert(NETWORKS.includes(n) && n !== STRICTEST_NETWORK, `${e.name}.${m.name}: offeredOn ${n} (demo or sepolia; ${STRICTEST_NETWORK} is the field's offered list)`);
      assert(typeof m.pending === 'string' && m.pending.length > 0, `${e.name}.${m.name}: offeredOn needs the pending note the page shows`);
    } else {
      assert(m.pending === undefined, `${e.name}.${m.name}: pending without offeredOn`);
    }
    if (m.notBuiltOn !== undefined) {
      // Offered by validate() but not built by core v1 there: the network's list leaves it out (SH-F74-polish item 5).
      assert(Array.isArray(m.notBuiltOn) && m.notBuiltOn.length > 0, `${e.name}.${m.name}: notBuiltOn lists networks`);
      for (const n of m.notBuiltOn) assert(NETWORKS.includes(n) && n !== STRICTEST_NETWORK && n !== 'demo', `${e.name}.${m.name}: notBuiltOn ${n} (sepolia; ${STRICTEST_NETWORK} is validate()'s list, the Demo shows all of it)`);
      assert(typeof m.notBuilt === 'string' && m.notBuilt.length > 0, `${e.name}.${m.name}: notBuiltOn needs the note that says what is missing`);
      assert(m.offeredOn === undefined, `${e.name}.${m.name}: offeredOn and notBuiltOn both`);
    } else {
      assert(m.notBuilt === undefined, `${e.name}.${m.name}: notBuilt without notBuiltOn`);
    }
  }
  enums.set(e.name, e);
}
const enumValue = (enumName, member) => {
  const e = enums.get(enumName);
  assert(e, `unknown enum ${enumName}`);
  const m = e.members.find((x) => x.name === member);
  assert(m, `${enumName} has no member ${member}`);
  return m.value;
};

const rules = new Map(spec.stringRules.map((r) => [r.name, r]));
for (const r of rules.values()) {
  if (r.prefix === undefined) continue;
  // A required prefix (a non-empty string must start with it): its bytes must pass the rule's own ranges.
  assert(/^[\x20-\x7e]+$/.test(r.prefix), `rule ${r.name}: prefix is printable ASCII`);
  assert(!/["\\]/.test(r.prefix), `rule ${r.name}: prefix without " or \\ (it is emitted as a Solidity string literal)`);
  for (const c of Buffer.from(r.prefix, 'ascii')) {
    assert(r.allowed.some(([lo, hi]) => c >= lo && c <= hi), `rule ${r.name}: prefix byte 0x${c.toString(16)} is not allowed by the rule`);
  }
}
const reasons = new Map(spec.reasons.map((r) => [r.name, r.code]));
const reasonCode = (name) => {
  assert(reasons.has(name), `unknown reason ${name}`);
  return reasons.get(name);
};

const fields = spec.fields;
fields.forEach((f, i) => assert(f.id === i + 1, `field ${f.name} must have id ${i + 1}`));
for (const f of fields) {
  if (!f.enum) continue;
  for (const m of enums.get(f.enum).members) {
    if (m.offeredOn) assert(f.check.offered && !f.check.offered.includes(m.name), `field ${f.name}: ${m.name} has offeredOn, so the strictest list (offered) must leave it out`);
    if (m.notBuiltOn) assert(f.check.offered && f.check.offered.includes(m.name), `field ${f.name}: ${m.name} has notBuiltOn, so validate()'s list (offered) must name it`);
  }
}
// F74 U1, structurally: no field, add-on parameter or offeredOn offers a holder payout on mainnet.
{
  const problems = holderOfferProblems(spec, catalog, STRICTEST_NETWORK);
  assert(problems.length === 0, `holder payouts are never offered on ${STRICTEST_NETWORK} (F74 U1): ${problems.join('; ')}`);
}
assert(fields.at(-1).name === 'addOns', 'the add-on list is the last field');
const fieldByName = new Map(fields.map((f) => [f.name, f]));

/** The core fields a predicate reads (`param`, `hasAddOn` and `qClassIn` read none; `qClassIn` reads q). */
function predicateFields(p) {
  if (p.all) return p.all.flatMap(predicateFields);
  if (p.any) return p.any.flatMap(predicateFields);
  if (p.not) return predicateFields(p.not);
  if (p.param !== undefined || p.hasAddOn || p.addOnParam) return [];
  if (p.qClassIn) return ['q'];
  return [p.field, ...(p.lt ? [p.lt.field] : [])];
}

/**
 * `zeroWhen` (F70, the token-only box): when the predicate holds, the field must be zero (or empty) instead of passing
 * its own check (MUST_BE_ZERO). It may read only earlier fields, so the verdict still follows the field order.
 */
/** Whether a predicate reads an add-on's parameter (`addOnParam`): only `rules` may, as they run after every add-on. */
function readsAddOnParam(p) {
  if (p.all) return p.all.some(readsAddOnParam);
  if (p.any) return p.any.some(readsAddOnParam);
  if (p.not) return readsAddOnParam(p.not);
  return p.addOnParam !== undefined;
}

/** Byte formats a `bytes` field's check may name (`format`): METADATA_TABLE_V1 is BoxMetadataTable's (core item 9). */
const BYTES_FORMATS = new Set(['METADATA_TABLE_V1']);
for (const f of fields) {
  if (f.check.format === undefined) continue;
  assert(f.check.kind === 'bytes' && BYTES_FORMATS.has(f.check.format), `field ${f.name}: format ${f.check.format} (bytes fields only: ${[...BYTES_FORMATS].join(', ')})`);
  assert(constants.has('MAX_TRAIT_TYPES') && reasons.has('METADATA_TABLE_MALFORMED') && spec.stringRules.some((r) => r.name === 'JSON_TEXT'), `field ${f.name}: METADATA_TABLE_V1 needs MAX_TRAIT_TYPES, METADATA_TABLE_MALFORMED and JSON_TEXT`);
}

for (const f of fields) {
  const when = f.check.zeroWhen;
  if (when === undefined) continue;
  assert(f.type !== 'AddOn[]', `field ${f.name}: zeroWhen on the add-on list`);
  assert(!readsAddOnParam(when), `field ${f.name}: zeroWhen cannot read an add-on parameter (fields are checked before the add-ons)`);
  for (const name of predicateFields(when)) {
    const other = fieldByName.get(name);
    assert(other && other.id < f.id, `field ${f.name}: zeroWhen reads ${name}, which is not an earlier field`);
  }
}

for (const a of catalog.addOns) {
  for (const req of a.requires) assert(!readsAddOnParam(req.predicate), `add-on ${a.key}: requires cannot read another add-on's parameter (use param)`);
}

const addOns = catalog.addOns;
const addOnByKey = new Map(addOns.map((a) => [a.key, a]));
const addOnById = new Map(addOns.map((a) => [a.id, a]));
for (const a of addOns) {
  assert(Number.isInteger(a.id) && a.id >= 1 && a.id <= 655, `add-on ${a.key}: id 1-655`);
  assert(a.params.length <= 99, `add-on ${a.key}: at most 99 params`);
  a.params.forEach((p, i) => {
    assert(p.type in PARAM_KINDS, `add-on ${a.key}: param type ${p.type}`);
    const at = `add-on ${a.key}.${p.name}`;
    if (p.allowed !== undefined) {
      // A preset list (v2 C16: presets, not sliders): any other value is NOT_A_MEMBER.
      assert(p.type in UINT_BITS && Array.isArray(p.allowed) && p.allowed.length > 0, `${at}: allowed needs a uint param`);
      const top = 1n << BigInt(UINT_BITS[p.type]);
      // A small uint lists numbers; a wide one (an amount, F74 U2) lists decimal strings, never JS numbers.
      const isValue = (v) => (isSmallUint(p.type) ? Number.isInteger(v) && v >= 0 : typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v));
      for (const v of p.allowed) assert(isValue(v) && BigInt(v) < top, `${at}: ${v} does not fit ${p.type} (${isSmallUint(p.type) ? 'a number' : 'a decimal string'})`);
    }
    if (p.enum !== undefined) assert(p.type === 'uint8' && enums.has(p.enum), `${at}: enum ${p.enum} needs a uint8 param and a listed enum`);
    if (p.offered !== undefined) {
      // The members this format offers (else NOT_OFFERED), as a core enum field's `offered`.
      assert(p.enum !== undefined && Array.isArray(p.offered) && p.offered.length > 0, `${at}: offered needs an enum param`);
      for (const m of p.offered) enumValue(p.enum, m);
    }
    if (p.enum !== undefined) {
      for (const m of enums.get(p.enum).members) {
        if (m.offeredOn) assert(p.offered !== undefined && !p.offered.includes(m.name), `${at}: ${m.name} has offeredOn, so the strictest list (offered) must leave it out`);
        if (m.notBuiltOn) assert(p.offered === undefined || p.offered.includes(m.name), `${at}: ${m.name} has notBuiltOn, so validate()'s list (offered) must name it`);
      }
    }
    if (p.type === 'bytes32[]') {
      // A short list of hashes: at most maxItems entries, each non-zero (ZERO_VALUE) when nonZeroItems.
      assert(Number.isInteger(p.maxItems) && p.maxItems >= 1 && p.maxItems <= 32, `${at}: maxItems 1-32`);
      assert(p.nonZeroItems === undefined || p.nonZeroItems === true, `${at}: nonZeroItems is true or absent`);
    }
    if (p.type === 'string') assert(rules.has(p.rule), `${at}: unknown string rule ${p.rule}`);
    if (p.nonZeroIff !== undefined) {
      // Non-zero exactly when an earlier parameter has the named value (else it must be zero).
      const j = a.params.findIndex((x) => x.name === p.nonZeroIff.param);
      assert(j >= 0 && j < i, `${at}: nonZeroIff names an earlier param`);
      const other = a.params[j];
      assert(other.type in UINT_BITS, `${at}: nonZeroIff compares a uint param`);
      if (typeof p.nonZeroIff.eq === 'string') enumValue(other.enum, p.nonZeroIff.eq);
    }
  });
  // The box types the add-on serves (F70): checked right after its versions, before its params (ADD_ON_CONFLICT).
  const boxTypeField = fields.find((f) => f.name === 'boxType');
  assert(Array.isArray(a.boxTypes) && a.boxTypes.length > 0, `add-on ${a.key}: boxTypes`);
  for (const t of a.boxTypes) {
    enumValue('BoxType', t);
    assert(boxTypeField.check.offered.includes(t), `add-on ${a.key}: box type ${t} is not offered`);
  }
  for (const h of a.hookPoints) {
    const point = catalog.hookPoints.find((x) => x.key === h);
    assert(point, `add-on ${a.key}: unknown hook point ${h}`);
    assert(point.usedBy.includes(a.key), `hook point ${h} must list ${a.key} in usedBy`);
  }
}
for (const point of catalog.hookPoints) {
  for (const key of point.usedBy) {
    assert(addOnByKey.get(key)?.hookPoints.includes(point.key), `${key} must list hook point ${point.key}`);
  }
}

/** Field ids: core fields 1-26; an add-on 100 x id; its i-th param 100 x id + i + 1. */
const fieldIds = new Map(fields.map((f) => [f.name, f.id]));
for (const a of addOns) {
  fieldIds.set(`addOns.${a.key}`, 100 * a.id);
  a.params.forEach((p, i) => fieldIds.set(`addOns.${a.key}.${p.name}`, 100 * a.id + i + 1));
}
const fieldId = (path) => {
  assert(fieldIds.has(path), `unknown field ${path}`);
  return fieldIds.get(path);
};

/**
 * A version context: what a version (not the creator) chooses, passed to validate() beside the spec: the curated Q
 * list and the graduated layout(s) the version allows. L7 is answered (F61): a product context lists exactly one
 * graduated layout. A test context may list none, so the version-context check itself stays exercised.
 */
const gradLayoutField = fields.find((f) => f.name === 'gradLayout');
const contexts = [...spec.contexts, ...casesFile.contexts].map((c) => {
  const product = spec.contexts.includes(c);
  assert(Array.isArray(c.gradLayouts), `context ${c.name}: gradLayouts`);
  assert(new Set(c.gradLayouts).size === c.gradLayouts.length, `context ${c.name}: a graduated layout twice`);
  for (const g of c.gradLayouts) assert(gradLayoutField.check.offered.includes(g), `context ${c.name}: ${g} is not offered`);
  if (product) {
    assert(c.gradLayouts.length === 1, `context ${c.name}: exactly one graduated layout (L7, F61)`);
    assert(c.gradLayoutsOpen === undefined, `context ${c.name}: L7 is answered; drop gradLayoutsOpen`);
  }
  return {
    ...c,
    gradLayoutValues: c.gradLayouts.map((g) => enumValue('GradLayout', g)),
    qList: c.qList.map((q) => ({
      ...q,
      token: getAddress(q.token),
      qClassValue: enumValue('QClass', q.qClass),
      presets: q.raisePresets.map((x) => BigInt(x)),
    })),
  };
});
const contextIndex = (name) => {
  const i = contexts.findIndex((c) => c.name === name);
  assert(i >= 0, `unknown context ${name}`);
  return i;
};

// ---------------------------------------------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------------------------------------------

const snake = (s) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase();
const pascal = (s) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
const solConstName = (path) => `FIELD_${snake(path.replace(/^addOns\./, 'addOn.'))}`;
const solEnumConst = (enumName, member) => `${snake(enumName)}_${member}`;
const solAddOnConst = (a) => `ADD_ON_${snake(a.key)}`;
const groupDigits = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, '_');
const solInt = (v) => {
  const s = BigInt(v).toString();
  if (s.startsWith('-')) return `-${s.length > 5 ? groupDigits(s.slice(1)) : s.slice(1)}`;
  return s.length > 4 ? groupDigits(s) : s;
};
const tsBig = (v) => `${BigInt(v).toString()}n`;

// ---------------------------------------------------------------------------------------------------------------
// Bounds and predicates, shared by both emitters
// ---------------------------------------------------------------------------------------------------------------

/** A bound is a number, a constant reference or (in add-on params) a core uint field. */
function bound(b, lang, type) {
  if (typeof b === 'number' || typeof b === 'string') {
    if (lang === 'sol') return solInt(b);
    return isSmallUint(type) ? String(b) : tsBig(b);
  }
  if (b.const) {
    const c = constants.get(b.const);
    assert(c, `unknown constant ${b.const}`);
    if (lang === 'sol') return b.const;
    return isSmallUint(type) ? `Number(${b.const})` : b.const;
  }
  if (b.field) {
    const f = fieldByName.get(b.field);
    assert(f && f.type in UINT_BITS, `bound field ${b.field} must be a uint field`);
    if (lang === 'sol') return `uint256(s.${b.field})`;
    return isSmallUint(type) ? `s.${b.field}` : `BigInt(s.${b.field})`;
  }
  return fail(`bad bound ${JSON.stringify(b)}`);
}

function predicateValue(field, value, lang) {
  if (field.enum && typeof value === 'string') {
    return lang === 'sol' ? solEnumConst(field.enum, value) : `${field.enum}.${value}`;
  }
  assert(typeof value === 'number', `predicate value for ${field.name} must be a number or a member name`);
  if (lang === 'sol') return solInt(value);
  return isSmallUint(field.type) ? String(value) : tsBig(value);
}

/** A uint add-on parameter's value in a predicate: a number, or a member name of the parameter's enum. */
function paramValue(param, value, lang) {
  if (param.enum && typeof value === 'string') {
    enumValue(param.enum, value);
    return lang === 'sol' ? solEnumConst(param.enum, value) : `BigInt(${param.enum}.${value})`;
  }
  assert(Number.isInteger(value), `predicate value for param ${param.name} must be a number or a member name`);
  return lang === 'sol' ? solInt(value) : tsBig(value);
}

/**
 * The predicate language of `rules` and of add-on `requires`. Inside an add-on's `requires` (`addOn` given), a
 * predicate may also name one of that add-on's uint parameters ({ "param": name, "eq" | "ne": value }), read from its
 * decoded words (`w`). `{ "field": a, "lt": { "field": b } }` compares two uint core fields.
 */
function predicate(p, lang, addOn) {
  const eq = lang === 'sol' ? '==' : '===';
  const ne = lang === 'sol' ? '!=' : '!==';
  if (p.all) return `(${p.all.map((x) => predicate(x, lang, addOn)).join(' && ')})`;
  if (p.any) return `(${p.any.map((x) => predicate(x, lang, addOn)).join(' || ')})`;
  if (p.not) return `!(${predicate(p.not, lang, addOn)})`;
  if (p.param !== undefined) {
    assert(addOn, `param predicate ${p.param} outside an add-on's requires`);
    const i = addOn.params.findIndex((x) => x.name === p.param);
    assert(i >= 0 && addOn.params[i].type in UINT_BITS, `add-on ${addOn.key}: no uint param ${p.param}`);
    const ref = lang === 'sol' ? `w[${i}]` : `word(w, ${i})`;
    if ('eq' in p) return `${ref} ${eq} ${paramValue(addOn.params[i], p.eq, lang)}`;
    if ('ne' in p) return `${ref} ${ne} ${paramValue(addOn.params[i], p.ne, lang)}`;
    return fail(`bad param predicate ${JSON.stringify(p)}`);
  }
  if (p.hasAddOn) {
    const a = addOnByKey.get(p.hasAddOn);
    assert(a, `unknown add-on ${p.hasAddOn}`);
    return lang === 'sol' ? `_hasAddOn(s, ${solAddOnConst(a)})` : `hasAddOn(s, AddOnId.${pascal(a.key)})`;
  }
  if (p.addOnParam) {
    // In `rules` only (they run after every add-on passed its checks): the spec carries the add-on and one entry's
    // static parameter (a head word of its canonical params) has the value.
    const { addOn: key, param, eq: value } = p.addOnParam;
    const a = addOnByKey.get(key);
    assert(a, `addOnParam: unknown add-on ${key}`);
    const i = a.params.findIndex((x) => x.name === param);
    assert(i >= 0 && a.params[i].type in UINT_BITS, `addOnParam: ${key} has no uint param ${param}`);
    const v = paramValue(a.params[i], value, lang);
    return lang === 'sol' ? `_addOnWordIs(s, ${solAddOnConst(a)}, ${i}, ${v})` : `addOnWordIs(s, AddOnId.${pascal(a.key)}, ${i}, ${v})`;
  }
  if (p.qClassIn) {
    const call = lang === 'sol' ? '_qClassOf(s.q, ctx.qList)' : 'qClassOf(s.q, ctx.qList)';
    const values = p.qClassIn.map((m) => (lang === 'sol' ? solEnumConst('QClass', m) : `QClass.${m}`));
    return `(${values.map((v) => `${call} ${eq} ${v}`).join(' || ')})`;
  }
  const field = fieldByName.get(p.field);
  assert(field, `unknown predicate field ${p.field}`);
  const ref = `s.${field.name}`;
  if ('eq' in p) return `${ref} ${eq} ${predicateValue(field, p.eq, lang)}`;
  if ('ne' in p) return `${ref} ${ne} ${predicateValue(field, p.ne, lang)}`;
  if (p.in) return `(${p.in.map((v) => `${ref} ${eq} ${predicateValue(field, v, lang)}`).join(' || ')})`;
  if (p.lt) {
    const other = fieldByName.get(p.lt.field);
    assert(field.type in UINT_BITS && other && other.type in UINT_BITS, `lt compares two uint fields: ${field.name}, ${p.lt.field}`);
    assert(isSmallUint(field.type) === isSmallUint(other.type), `lt: ${field.name} and ${other.name} need the same TS type`);
    return `${ref} < s.${other.name}`;
  }
  if (p.zero || p.nonZero) {
    let isZero;
    if (lang === 'sol') {
      const zero = field.type === 'bytes32' ? 'bytes32(0)' : field.type === 'address' ? 'address(0)' : '0';
      isZero = `${ref} == ${zero}`;
    } else {
      isZero = ['bytes32', 'address'].includes(field.type) ? `isZeroHex(${ref})` : `${ref} === ${isSmallUint(field.type) ? '0' : '0n'}`;
    }
    return p.zero ? `(${isZero})` : `!(${isZero})`;
  }
  return fail(`bad predicate ${JSON.stringify(p)}`);
}


export {
  NETWORKS,
  STRICTEST_NETWORK,
  readsAddOnParam,
  here,
  pkgDir,
  repoDir,
  contractsDir,
  PUBLIC_NAMES,
  readJson,
  fail,
  assert,
  spec,
  catalog,
  casesFile,
  UINT_BITS,
  isSmallUint,
  PARAM_KINDS,
  paramKindName,
  constants,
  constValue,
  enums,
  enumValue,
  rules,
  reasons,
  reasonCode,
  fields,
  fieldByName,
  predicateFields,
  addOns,
  addOnByKey,
  addOnById,
  fieldIds,
  fieldId,
  contexts,
  contextIndex,
  snake,
  pascal,
  solConstName,
  solEnumConst,
  solAddOnConst,
  groupDigits,
  solInt,
  tsBig,
  bound,
  predicateValue,
  predicate,
};
