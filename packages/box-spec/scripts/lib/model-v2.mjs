/**
 * The BoxSpec format 2 source model (M1-10-b, the generators; core-v2-m1-tickets.md § 2 M1-10). Reads M1-00's frozen
 * shapes from Solidity (SpecTypes.sol, RecipeTypes.sol, IListingRegistry.sol: every struct and enum), so the emitters
 * use those shapes and never redefine them, and checks the JSON source (box-spec.v2.json, add-ons.v2.json) against them.
 *
 * The source's vocabulary (format 1's, box-spec.v1.json, plus):
 * - `fields`: ids 0-31 in the frozen `BoxSpec`'s order, its names (a `type`, when given, must be the frozen one).
 *   Check kinds: format 1's `uint`, `enum` (`enum` names it; `offered`; `inContext` a uint8[] of the context), `string`,
 *   `bytes` (`format` METADATA_TABLE_V1), `nonZero`, `any`, `addOns`, `zeroWhen`; new: `zero` (MUST_BE_ZERO unless
 *   zero or empty), `listing` (the pricing tuple: `unknown`, `mismatch` reasons), `listingRaise` (equal to the pricing
 *   listing's current raise) and `recipe` (a `Side`: members, fixed release offers, canonical params; the side is the field's name).
 * - `recipe`: `subFields` (offsets: leg, dest, legParams, destParams, bOffset, split, splitParams; an id is the field's
 *   id x 1000 + offset), `legs`, `dests`, `splits` (every frozen member, each with its params struct; a leg's `produces`
 *   per side: P, T or X), `malformed` (reasons for non-canonical params, by place or by struct), `bNotZero`, and
 *   `checks` on each member: ordered when/require predicates after canonical params, before the next slot.
 * - `rules`, in order, after the fields and the add-ons: `{ scope: box | side | branch, when, require, reason, field }`
 *   (a side rule runs per side and a branch rule per branch, b only where the split is not `bZero`; `field` is relative
 *   to its scope), or `{ cfgBudget: <bound>, reason }`. Consecutive side (or branch) rules form one run. `ruleOrder`
 *   (required, top level) sets the order inside a run: `rule-major` checks each rule on every side or branch in turn
 *   (buyers.a, buyers.b, sellers.a, sellers.b) before the next rule; `branch-major` checks each branch through all the
 *   run's rules before the next branch. `endRun: true` on a side or branch rule ends its run there (in branch-major
 *   order the rules after it start again at buyers.a; about 245 bytes of validator code per extra branch run,
 *   measured). Predicates: `all`, `any`, `not`, `always`, `never`; anywhere:
 *   `field` (a path, dotted into tuples) with eq | ne | in | lt | zero | nonZero, `hasAddOn`, `addOnParam`, `ctx`,
 *   `anyBranch`, `onSide` + `is`, `sidesSame`, `countAtMost` (`branches` and `sides`: a predicate or a list, each item
 *   counted once per branch or side in use; `addOns`; `max`; `throughBranch` counts only up to the current branch); per side: `split`, `splitParam` + `of`, `a`, `b`,
 *   `branchesSame`; per branch: `side`, `leg`, `dest`, `produces`, `producesEth`, `legParam` | `destParam` + `of`,
 *   `convertListing` (known | tokenMatches | notPricingToken | { pathPoolsAtMost }), `boxTarget` (known |
 *   pricedInOutput | box0). Param comparisons: eq, ne, in, lt, le, gt, ge (a number, 'Enum.Member', { param } or
 *   { const }), zero, nonZero.
 *   A branch rule may have ordered `checks` sharing its index: all checks run on one branch before the next.
 *   Integer list constants emit a typed array accessor in Solidity (constant arrays are unsupported) and a readonly
 *   array in TypeScript; every element is checked against its declared width.
 * - `contexts`: fixed product offers baked into the generated checks. The factory supplies only `ReleaseContext.listing`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress } from 'viem';
import { repoDir, snake, solConstName } from './model.mjs';

const fail = (message) => {
  throw new Error(`box-spec v2 generator: ${message}`);
};
const assert = (condition, message) => {
  if (!condition) fail(message);
};
/** Free text goes into comments of both twins: no control character, no line separator, no comment end (star, slash). */
const badText = (s) => s.includes('*/') || [...s].some((ch) => {
  const c = ch.codePointAt(0);
  return c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029;
});
const assertText = (value, where) => assert(typeof value === 'string' && !badText(value), `${where}: control character or \`*/\` in free text`);
/** Names that become identifiers or quoted keys in both twins. */
const UPPER = /^[A-Z][A-Z0-9_]*$/;
const WORD = /^[A-Za-z][A-Za-z0-9_]*$/;
const KEY = /^[a-z][a-z0-9-]*$/;
const assertName = (name, pattern, where) => assert(typeof name === 'string' && pattern.test(name), `${where}: name ${JSON.stringify(name)} must match ${pattern}`);
/**
 * Reason codes runtime.ts returns from its string checks without reading the source (its REASON_LENGTH_OUT_OF_RANGE
 * and REASON_BAD_CHARACTER); a source that numbers them otherwise would split the twins.
 */
export const RUNTIME_REASON_CODES = Object.freeze({ OK: 0, LENGTH_OUT_OF_RANGE: 5, BAD_CHARACTER: 6 });
/** Reasons the emitters name directly (the add-on list, the string checks). */
const EMITTER_REASONS = ['TOO_MANY_ADD_ONS', 'ADD_ON_ORDER', 'ADD_ON_UNKNOWN', 'ADD_ON_NOT_AVAILABLE', 'ADD_ON_CONFLICT', 'ADD_ON_PARAMS_MALFORMED', 'NOT_A_MEMBER', 'NOT_OFFERED', 'MUST_BE_ZERO'];

export const FROZEN_FILES = ['SpecTypes.sol', 'RecipeTypes.sol', 'IListingRegistry.sol', 'IShopVaultV2.sol'].map((f) => `packages/contracts/src/box-v2/interfaces/${f}`);
export const UINT_BITS = { uint8: 8, uint16: 16, uint32: 32, uint64: 64, uint128: 128, uint256: 256 };
export const isSmallUint = (type) => type in UINT_BITS && UINT_BITS[type] <= 48;
export const SIDES = ['Buyers', 'Sellers'];
const SCALARS = new Set([...Object.keys(UINT_BITS), 'address', 'bool', 'bytes32', 'bytes', 'string']);

/** Every `struct` and `enum` of the frozen files, comments stripped: members in order, enum values by position. */
export function parseShapes(sources) {
  const structs = new Map();
  const enums = new Map();
  for (const [file, text] of Object.entries(sources)) {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const [, kind, name, body] of code.matchAll(/\b(struct|enum)\s+(\w+)\s*\{([^}]*)\}/g)) {
      assert(!structs.has(name) && !enums.has(name), `${name} declared twice in the frozen files`);
      if (kind === 'enum') {
        const names = body.split(',').map((s) => s.trim()).filter(Boolean);
        assert(/^none$/i.test(names[0] ?? ''), `${file} ${name}: its first member is None (0 is never a member)`);
        enums.set(name, { name, file, members: names.slice(1).map((m, i) => ({ name: m, value: i + 1 })) });
      } else {
        const members = body.split(';').map((s) => s.trim()).filter(Boolean).map((decl) => {
          const [type, member, extra] = decl.split(/\s+/);
          assert(member && !extra, `${file} ${name}: cannot read member "${decl}"`);
          return { type, name: member };
        });
        structs.set(name, { name, file, members });
      }
    }
  }
  return { structs, enums };
}

/** The type behind a path into the frozen BoxSpec (`pricing.token`, `buyers.a.leg`). */
function typeAt(structs, path) {
  let type = 'BoxSpec';
  for (const part of path.split('.')) {
    const s = structs.get(type);
    const m = s?.members.find((x) => x.name === part);
    assert(m, `no field ${path} in the frozen BoxSpec`);
    type = m.type;
  }
  return type;
}

function checkType(structs, type, where) {
  const base = type.endsWith('[]') ? type.slice(0, -2) : type;
  assert(SCALARS.has(base) || structs.has(base), `${where}: type ${type} is neither a scalar nor a frozen struct`);
  if (structs.has(base)) for (const m of structs.get(base).members) checkType(structs, m.type, `${base}.${m.name}`);
}

export function loadModelV2({ spec, addOns: catalog, cases, frozen, labels, mode, root, paths }) {
  assert(mode === 'real', 'sources: real source required');
  assert(spec.format === 2, 'format must be 2');
  // M1-10-a owns its cases and writes box-spec-v2.json with its own encoder (file map § 7).
  assert(cases === null, 'sources: real mode reads no cases (M1-10-a writes box-spec-v2.json)');
  const shapes = parseShapes(frozen);
  const { structs } = shapes;
  // S1 consumes the supplied opaque tuples; a different layout needs a new shape handoff.
  for (const [name, expected] of [
    ['ItemsDestParams', [['insidePolicy', 'uint8']]],
    ['PileParams', [['asset', 'address'], ['seedAmount', 'uint256']]],
    ['PileParamsV21', [['asset', 'address'], ['seedAmount', 'uint256'], ['leaveBehindBps', 'uint16']]],
  ]) {
    assert(JSON.stringify(structs.get(name)?.members.map((m) => [m.name, m.type])) === JSON.stringify(expected),
      `S1: unsupported frozen ${name} shape`);
  }
  const boxSpec = structs.get('BoxSpec');
  assert(boxSpec, 'SpecTypes.sol has no BoxSpec');
  for (const name of ['BoxSpec', 'ReleaseContext']) checkType(structs, name, name);

  const constants = new Map();
  for (const c of spec.constants) {
    assertName(c.name, UPPER, 'constant');
    assert(!constants.has(c.name), `constant ${c.name} twice`);
    assert(c.status === 'V' || c.status === 'P', `constant ${c.name}: status V or P`);
    assertText(c.source, `constant ${c.name} source`);
    const elementType = c.type.endsWith('[]') ? c.type.slice(0, -2) : c.type;
    assert(elementType in UINT_BITS || c.type === 'address' || c.type === 'bytes32', `constant ${c.name}: type ${c.type}`);
    if (c.type === 'bytes32') assert(/^0x[0-9a-f]{64}$/.test(c.value), `constant ${c.name}: 32 lower-case hex bytes`);
    const list = c.type.endsWith('[]');
    assert(!list || (Array.isArray(c.value) && c.value.length > 0), `constant ${c.name}: non-empty list`);
    const value = list ? c.value.map((v) => BigInt(v)) : c.type === 'address' ? getAddress(c.value) : c.type === 'bytes32' ? c.value : BigInt(c.value);
    if (elementType in UINT_BITS) for (const v of list ? value : [value]) assert(v >= 0n && v < 1n << BigInt(UINT_BITS[elementType]), `constant ${c.name}: ${c.value} does not fit ${c.type}`);
    constants.set(c.name, { ...c, value });
  }

  // Enums: the frozen ones from Solidity; the source's own (Layout, ArtMode, ...) and the catalog's. A source enum that
  // shares a frozen name must equal it exactly, since the frozen files are the one definition.
  const enums = new Map();
  for (const e of shapes.enums.values()) enums.set(e.name, { ...e, frozen: true });
  for (const e of [...spec.enums, ...(catalog.enums ?? [])]) {
    const frozenEnum = shapes.enums.get(e.name);
    if (frozenEnum) {
      const same = JSON.stringify(e.members.map((m) => [m.name, m.value])) === JSON.stringify(frozenEnum.members.map((m) => [m.name, m.value]));
      assert(same, `enum ${e.name}: frozen in ${frozenEnum.file} (${frozenEnum.members.map((m) => `${m.name} = ${m.value}`).join(', ')}); the source redefines it`);
      continue;
    }
    assertName(e.name, WORD, 'enum');
    assert(!enums.has(e.name), `enum ${e.name} twice`);
    const values = new Set();
    for (const m of e.members) {
      assertName(m.name, WORD, `enum ${e.name} member`);
      assert(Number.isInteger(m.value) && m.value >= 1 && m.value <= 255 && !values.has(m.value), `${e.name}.${m.name}: members are 1-255, once`);
      values.add(m.value);
    }
    enums.set(e.name, { name: e.name, members: e.members.map((m) => ({ name: m.name, value: m.value })), frozen: false });
  }
  const member = (enumName, name) => {
    const m = enums.get(enumName)?.members.find((x) => x.name === name);
    assert(m, `${enumName} has no member ${name}`);
    return m;
  };
  /** 'Enum.Member' (or a bare member of `defaultEnum`) to { enum, member, value }. */
  const enumRef = (text, defaultEnum) => {
    const [e, m] = text.includes('.') ? text.split('.') : [defaultEnum, text];
    assert(e, `enum value ${text} names no enum`);
    return { enum: e, member: m, value: member(e, m).value };
  };

  const stringRules = new Map(spec.stringRules.map((r) => [r.name, r]));
  assert(stringRules.size === spec.stringRules.length, 'string rule names are used once');
  const ruleIds = new Set();
  const byte = (x) => Number.isInteger(x) && x >= 0 && x <= 255;
  for (const r of stringRules.values()) {
    assertName(r.name, UPPER, 'string rule');
    // Solidity picks a rule's mask by id and TypeScript its ranges by name, so two rules on one id would split the twins.
    assert(byte(r.id) && r.id !== 0 && !ruleIds.has(r.id), `string rule ${r.name}: id ${r.id}: an integer 1-255, used once`);
    ruleIds.add(r.id);
    assert(Array.isArray(r.allowed) && r.allowed.length > 0 && r.allowed.every((p) => Array.isArray(p) && p.length === 2 && byte(p[0]) && byte(p[1]) && p[0] <= p[1]), `string rule ${r.name}: allowed ranges are integer pairs 0 <= lo <= hi <= 255`);
    if (r.prefix === undefined) continue;
    // A required prefix is emitted as a Solidity string literal and as TS bytes: its bytes must be the same in both and
    // pass the rule's own ranges (format 1's check, model.mjs).
    assert(/^[\x20-\x7e]+$/.test(r.prefix), `rule ${r.name}: prefix is printable ASCII`);
    assert(!/["\\]/.test(r.prefix), `rule ${r.name}: prefix without " or \\ (it is emitted as a Solidity string literal)`);
    for (const ch of Buffer.from(r.prefix, 'ascii')) {
      assert(r.allowed.some(([lo, hi]) => ch >= lo && ch <= hi), `rule ${r.name}: prefix byte 0x${ch.toString(16)} is not allowed by the rule`);
    }
  }
  for (const r of spec.reasons) assertName(r.name, UPPER, 'reason');
  const reasons = new Map(spec.reasons.map((r) => [r.name, r.code]));
  const reason = (name) => {
    assert(reasons.has(name), `unknown reason ${name}`);
    return name;
  };
  for (const [name, code] of Object.entries(RUNTIME_REASON_CODES)) {
    assert(reasons.get(name) === code, `reason ${name} is ${code} in runtime.ts (its string checks return it); the source has ${reasons.get(name)}`);
  }
  for (const name of EMITTER_REASONS) reason(name);

  // Fields: exactly the frozen BoxSpec, member for member.
  assert(spec.fields.length === boxSpec.members.length, `the frozen BoxSpec has ${boxSpec.members.length} fields; the source lists ${spec.fields.length}`);
  const fields = spec.fields.map((f, i) => {
    const frozenField = boxSpec.members[i];
    assert(f.id === i, `field ${f.name}: id ${f.id}, expected ${i} (ids follow the frozen order)`);
    assert(f.name === frozenField.name, `field ${i} ${f.name}: the frozen BoxSpec (SpecTypes.sol) has ${frozenField.name} here`);
    assert(f.type === undefined || f.type === frozenField.type, `field ${i} ${f.name}: type ${f.type}, but the frozen BoxSpec has ${frozenField.type}`);
    return { ...f, type: frozenField.type };
  });
  const fieldByName = new Map(fields.map((f) => [f.name, f]));
  const recipeFields = fields.filter((f) => f.check.kind === 'recipe');
  for (const f of recipeFields) {
    assert(f.type === 'Side' && SIDES.includes(sideOf(f)), `field ${f.name}: a recipe is a Side named for a FeeSide member`);
  }
  assert(recipeFields.length === 2, 'one recipe field per fee side');
  for (const f of fields) {
    const k = f.check.kind;
    if (k === 'byBoxType') {
      assert(f.type === 'bytes' && Object.keys(f.check.checks ?? {}).length > 0, `field ${f.name}: byte checks by box type required`);
      for (const [name, check] of Object.entries(f.check.checks)) {
        member('BoxType', name);
        assert(check.kind === 'bytes' || check.kind === 'params' || check.kind === 'pile', `field ${f.name}: unsupported box check`);
        if (check.kind === 'params') {
          const shape = structs.get(check.struct);
          assert(shape && shape.members.every((m) => SCALARS.has(m.type) && !['bytes', 'string'].includes(m.type)),
            `field ${f.name}: static frozen params required`);
          reason(check.reason);
        }
      }
    }
    if (k === 'enum') assert(enums.has(f.check.enum), `field ${f.name}: enum ${f.check.enum}`);
    if (k === 'listing') assert(f.type === 'Pricing', `field ${f.name}: listing checks the Pricing tuple`);
    if (k === 'listingRaise') assert(fields.some((g) => g.check.kind === 'listing' && g.id < f.id), `field ${f.name}: listingRaise after the listing field`);
    if (f.check.zeroWhen) assert(SCALARS.has(f.type), `field ${f.name}: zeroWhen on a scalar field only`);
    if (f.check.format === 'METADATA_TABLE_V1') assert(constants.has('MAX_TRAIT_TYPES'), `field ${f.name}: METADATA_TABLE_V1 reads constant MAX_TRAIT_TYPES`);
  }

  // Recipes.
  const recipe = spec.recipe;
  const sub = recipe.subFields;
  for (const key of ['leg', 'dest', 'legParams', 'destParams', 'bOffset', 'split', 'splitParams']) assert(Number.isInteger(sub[key]), `recipe.subFields.${key}`);
  const table = (key, enumName) => {
    const entries = recipe[key];
    const frozenMembers = enums.get(enumName).members.map((m) => m.name);
    assert(JSON.stringify(Object.keys(entries)) === JSON.stringify(frozenMembers), `recipe.${key} lists ${enumName}'s members in order: ${frozenMembers.join(', ')}`);
    return frozenMembers.map((name) => {
      const e = entries[name];
      if (e.params !== undefined) assert(structs.has(e.params), `recipe.${key}.${name}: params ${e.params} is not a frozen struct`);
      return { name, value: member(enumName, name).value, params: e.params ?? null, paramsWhenLeg: e.paramsWhenLeg, produces: e.produces, bZero: e.bZero === true, checks: e.checks ?? [] };
    });
  };
  const legs = table('legs', 'Leg');
  for (const l of legs) for (const s of SIDES) assert(['P', 'T', 'X'].includes(l.produces?.[s]), `recipe.legs.${l.name}.produces.${s}: P, T or X`);
  for (const l of legs.filter((x) => Object.values(x.produces).includes('X'))) {
    for (const m of ['how', 'listingId', 'token']) assert(structs.get(l.params)?.members.some((x) => x.name === m), `leg ${l.name} produces X, so its params name ${m}`);
  }
  const dests = table('dests', 'Dest');
  const splits = table('splits', 'Split');
  const malformed = recipe.malformed;
  for (const k of ['legParams', 'destParams', 'splitParams']) reason(malformed[k]);
  for (const r of Object.values(malformed.byStruct ?? {})) reason(r);
  reason(recipe.bNotZero);

  // Field ids: core fields by id; recipe sub-fields (id x 1000 + offset); add-ons 100 x id, their params + i + 1.
  const fieldIds = new Map(fields.map((f) => [f.name, f.id]));
  for (const f of recipeFields) {
    const base = f.id * 1000;
    for (const [br, off] of [['a', 0], ['b', sub.bOffset]]) {
      for (const k of ['leg', 'dest', 'legParams', 'destParams']) fieldIds.set(`${f.name}.${br}.${k}`, base + off + sub[k]);
    }
    fieldIds.set(`${f.name}.split`, base + sub.split);
    fieldIds.set(`${f.name}.splitParams`, base + sub.splitParams);
  }
  const addOns = catalog.addOns.map((a) => {
    assertName(a.key, KEY, 'add-on key');
    assertText(a.title, `add-on ${a.key} title`);
    assert(Number.isInteger(a.id) && a.id >= 1 && a.id <= 655, `add-on ${a.key}: id 1-655`);
    for (const t of a.boxTypes) member(fieldByName.get('boxType').check.enum, t);
    for (const p of a.params) {
      assertName(p.name, WORD, `add-on ${a.key} param`);
      assert(p.type in UINT_BITS || ['bool', 'address', 'bytes32', 'string', 'bytes32[]'].includes(p.type), `add-on ${a.key}.${p.name}: type ${p.type}`);
      if (p.enum) assert(enums.has(p.enum), `add-on ${a.key}.${p.name}: enum ${p.enum}`);
      if (p.reason) reason(p.reason);
    }
    return { ...a, requires: a.requires ?? [] };
  });
  for (const a of addOns) {
    fieldIds.set(`addOns.${a.key}`, 100 * a.id);
    a.params.forEach((p, i) => fieldIds.set(`addOns.${a.key}.${p.name}`, 100 * a.id + i + 1));
  }
  const ids = [...fieldIds.values()];
  assert(new Set(ids).size === ids.length && ids.every((id) => id <= 0xffff), 'field ids are unique uint16s');

  assert(spec.ruleOrder === 'branch-major' || spec.ruleOrder === 'rule-major', `ruleOrder: branch-major or rule-major, not ${JSON.stringify(spec.ruleOrder)}`);
  for (const r of spec.rules) {
    assertText(r.name, `rule ${JSON.stringify(r.name)}`);
    reason(r.reason);
    if (r.cfgBudget === undefined) assert(['box', 'side', 'branch'].includes(r.scope), `rule ${r.name}: scope box, side or branch`);
    assert(r.endRun === undefined || (r.endRun === true && ['side', 'branch'].includes(r.scope)), `rule ${r.name}: endRun: a side or branch rule only (true)`);
  }
  for (const c of spec.contexts) {
    assertName(c.name, KEY, 'context');
    if (c.status !== undefined) assertText(c.status, `context ${c.name} status`);
  }
  assert(spec.contexts.length === 1 && spec.contexts[0].name === 'm1', 'the frozen context carries one listing; M1 offers are fixed at generation');
  const contexts = spec.contexts.map((c) => contextValues(c, { member, gradEnum: fieldByName.get('gradLayout').check.enum, addOns }));

  return {
    mode,
    root,
    paths,
    labels,
    shapes,
    structs,
    constants,
    enums,
    member,
    enumRef,
    stringRules,
    reasons,
    reason,
    fields,
    fieldByName,
    recipeFields,
    recipe: { sub, legs, dests, splits, malformed, bNotZero: recipe.bNotZero },
    addOns,
    addOnByKey: new Map(addOns.map((a) => [a.key, a])),
    fieldIds,
    fieldId: (path) => {
      assert(fieldIds.has(path), `unknown field ${path}`);
      return fieldIds.get(path);
    },
    rules: spec.rules,
    ruleOrder: spec.ruleOrder,
    contexts,
    cases,
    shop: shopModel(spec.shop, structs, fieldByName, addOns),
    typeAt: (path) => typeAt(structs, path),
    fail,
    assert,
  };
}

/** Decode only the supported frozen shop tuple. Opaque bytes never define a second Solidity shape.
 * Presets and list bounds come from the shop description; layout/widths come from IShopVaultV2.
 * Refuse unsupported shape/description edits instead of silently emitting a different money contract.
 */
function shopModel(shop, structs, fields, addOns) {
  assert(shop?.encoding === 'abi.encode(ShopConfigV2)', 'shop: expected abi.encode(ShopConfigV2)');
  const shape = structs.get('ShopConfigV2');
  const expected = [
    ['seedT', 'uint256'], ['givePricesT', 'uint256[4]'], ['pickBps', 'uint16'], ['weeklyBps', 'uint16'],
    ['collectionBps', 'uint16'], ['listDelay', 'uint32'], ['curator', 'address'],
    ['collections', 'address[]'], ['tiers', 'uint8[]'],
  ];
  assert(JSON.stringify(shape?.members.map((m) => [m.name, m.type])) === JSON.stringify(expected),
    'shop: unsupported frozen ShopConfigV2 shape');
  assert(shop.givePricesT === 'four strictly increasing nonzero raw-T amounts', 'shop: unsupported givePricesT rule');
  const list = /^1\.\.(\d+) unique nonzero addresses; one tier 0\.\.(\d+) each; list and curator in contentsParams only$/.exec(shop.collections);
  assert(list && BigInt(list[1]) <= 64n && list[2] === '3', 'shop: unsupported collection/tier bounds');
  // F132's active-give allowance floor requires two cheapest initial gives, independent of the cap preset.
  assert(shop.minimumSeed === '2 * minInitialGiveT',
    'shop: unsupported minimum seed rule');
  const loader = /nonzero seed requires add-on (\d+) even with count\/hash zero$/.exec(shop.seed);
  assert(loader && addOns.some((a) => a.id === Number(loader[1]) && a.key === 'starter-set'), 'shop: unsupported seed loader');
  let cursor = 1; // abi.encode(dynamic tuple) starts with its offset word.
  const words = {};
  for (const m of shape.members) {
    const fixed = /\[(\d+)\]$/.exec(m.type);
    const width = fixed ? Number(fixed[1]) : 1;
    words[m.name] = { index: cursor, width, type: m.type };
    cursor += width;
  }
  const headWords = cursor - 1;
  const maxCollections = Number(list[1]);
  const minBytes = (headWords + 3) * 32;
  const contents = fields.get('contentsParams');
  const bounds = contents?.check.kind === 'byBoxType' ? contents.check.checks.SHOP : contents?.check;
  assert(contents?.type === 'bytes' && bounds?.minBytes === minBytes
    && bounds.maxBytes === minBytes + maxCollections * 64, 'shop: contents length bounds disagree with tuple');
  const presets = {};
  for (const [name, key] of [['pickBps', 'pickBps'], ['weeklyBps', 'weeklyBps'],
    ['collectionBps', 'collectionBps'], ['listDelay', 'listDelaySeconds']]) {
    const values = shop[key];
    assert(Array.isArray(values) && values.length > 0, `shop: missing ${key} presets`);
    const bits = UINT_BITS[words[name].type];
    assert(values.every((v) => /^(0|[1-9][0-9]*)$/.test(String(v))), `shop: integer ${key} presets`);
    presets[name] = values.map((v) => BigInt(v));
    assert(presets[name].every((v) => v > 0n && v < (1n << BigInt(bits)))
      && new Set(presets[name]).size === values.length, `shop: invalid ${key} presets`);
  }
  return { words, headWords, minBytes, maxCollections, presets, loaderId: Number(loader[1]), minimumSeedGives: 2n };
}

/** The side a recipe field pays (`buyers` → Buyers). */
export function sideOf(field) {
  return field.name[0].toUpperCase() + field.name.slice(1);
}

/** A release context's values: members by name to their numbers, add-ons by id (or key). */
export function contextValues(c, { member, gradEnum, addOns }) {
  const ids = (list) => list.map((x) => (typeof x === 'number' ? x : addOns.find((a) => a.key === x)?.id ?? fail(`context ${c.name}: add-on ${x}`)));
  return {
    name: c.name,
    status: c.status ?? '',
    offeredLegs: c.offeredLegs.map((m) => member('Leg', m).value),
    offeredDests: c.offeredDests.map((m) => member('Dest', m).value),
    targetSlotOffered: c.targetSlotOffered === true,
    offeredAddOns: ids(c.offeredAddOns),
    gradLayouts: c.gradLayouts.map((m) => member(gradEnum, m).value),
  };
}

export { fail, assert, snake, solConstName, repoDir, join, readFileSync };
