/**
 * Authoring form -> wire form for the fixtures and the vector cases, their ABI encoding (viem) and the two outputs that
 * carry them: the shared vectors and the typed fixtures. Part of generate.mjs.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { encodeAbiParameters, getAddress, keccak256, stringToBytes, stringToHex, toHex } from 'viem';
import {
  pkgDir,
  repoDir,
  PUBLIC_NAMES,
  readJson,
  fail,
  assert,
  casesFile,
  UINT_BITS,
  isSmallUint,
  constValue,
  enumValue,
  reasonCode,
  fields,
  fieldByName,
  addOnByKey,
  addOnById,
  fieldId,
  contexts,
  contextIndex,
  snake,
  tsBig,
} from './model.mjs';

// ---------------------------------------------------------------------------------------------------------------
// Authoring form -> wire form (fixtures and vector cases)
// ---------------------------------------------------------------------------------------------------------------

let publicNamesCache;
function publicName(name) {
  publicNamesCache ??= readFileSync(PUBLIC_NAMES, 'utf8');
  const m = publicNamesCache.match(new RegExp(`string constant ${name} =\\s*((?:"(?:[^"\\\\]|\\\\.)*"\\s*)+);`));
  assert(m, `PublicNames.sol has no string constant ${name}`);
  const parts = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
  return parts.join('').replace(/\\(["\\'nrt])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c);
}

const sha256Hex = (bytes) => `0x${createHash('sha256').update(bytes).digest('hex')}`;

function encodeTableV1(table) {
  const text = (s, min, max) => {
    assert(/^[\x20-\x7e]*$/.test(s) && !/["\\]/.test(s), `table string ${JSON.stringify(s)}: JSON_TEXT only`);
    const b = Buffer.from(s, 'ascii');
    assert(b.length >= min && b.length <= max, `table string ${JSON.stringify(s)}: ${min}-${max} bytes`);
    return b;
  };
  // A long description may be written as { "repeat": "a", "times": n } (the 24,575-byte vector).
  const description = text(typeof table.description === 'string' ? table.description : resolveString(table.description), 0, 0xffff);
  const parts = [Buffer.from([1, description.length >> 8, description.length & 0xff]), description, Buffer.from([table.traitTypes.length])];
  assert(table.traitTypes.length <= 16, 'at most 16 trait types');
  for (const t of table.traitTypes) {
    const name = text(t.name, 1, 255);
    assert(t.values.length >= 1 && t.values.length <= 255, `trait ${t.name}: 1-255 values`);
    parts.push(Buffer.from([name.length]), name, Buffer.from([t.values.length]));
    for (const v of t.values) {
      const value = text(v, 1, 255);
      parts.push(Buffer.from([value.length]), value);
    }
  }
  return toHex(Buffer.concat(parts));
}

/**
 * A string value: a JS string (UTF-8 on the wire), or `{ "rawHex": "0x..." }` for bytes that are not the UTF-8 of any JS
 * string (invalid UTF-8, a leading BOM): the ABI encoding of a string is its bytes, so a vector can carry any bytes.
 */
function resolveString(v) {
  if (typeof v === 'string') return v;
  if (v.rawHex !== undefined) {
    assert(/^0x(?:[0-9a-f]{2})*$/.test(v.rawHex), `bad rawHex ${v.rawHex}`);
    return { rawHex: v.rawHex };
  }
  if (v.publicName) {
    let s = publicName(v.publicName);
    if (v.replace) {
      assert(s.includes(v.replace[0]), `${v.publicName} does not contain ${v.replace[0]}`);
      s = s.replace(v.replace[0], v.replace[1]);
    }
    return s;
  }
  if (v.repeat !== undefined) return v.repeat.repeat(v.times);
  return fail(`bad string value ${JSON.stringify(v)}`);
}

function resolveHex(v, bytes) {
  if (typeof v === 'string') {
    assert(/^0x(?:[0-9a-fA-F]{2})*$/.test(v), `bad hex ${v}`);
    if (bytes) assert(v.length === 2 + 2 * bytes, `${v} is not ${bytes} bytes`);
    return v.toLowerCase();
  }
  if (v.keccakOfText !== undefined) return keccak256(stringToBytes(v.keccakOfText));
  if (v.sha256OfText !== undefined) return sha256Hex(Buffer.from(v.sha256OfText, 'utf8'));
  if (v.sha256OfFile) return sha256Hex(readFileSync(join(repoDir, v.sha256OfFile)));
  if (v.formatV1) return encodeTableV1(v.formatV1);
  if (v.repeatByte) return `0x${v.repeatByte.repeat(v.times)}`;
  return fail(`bad hex value ${JSON.stringify(v)}`);
}

function resolveAddress(v) {
  if (typeof v === 'string') return getAddress(v);
  if (v.const) return constValue(v.const);
  if (v.addressOfText !== undefined) return getAddress(`0x${keccak256(stringToBytes(v.addressOfText)).slice(-40)}`);
  return fail(`bad address value ${JSON.stringify(v)}`);
}

function resolveField(f, v) {
  if (f.enum) return typeof v === 'string' ? enumValue(f.enum, v) : v;
  if (f.type === 'string') return resolveString(v);
  if (f.type === 'address') return resolveAddress(v);
  if (f.type === 'bytes32') return resolveHex(v, 32);
  if (f.type === 'bytes') return resolveHex(v);
  if (f.type in UINT_BITS) return isSmallUint(f.type) ? v : BigInt(v);
  return fail(`cannot resolve ${f.name}`);
}

/** Authoring add-on -> { id, key, values, params (hex) }. */
function resolveAddOn(entry, baseAddOns) {
  if (entry.copyAddOn !== undefined) {
    const copy = baseAddOns[entry.copyAddOn];
    assert(copy, `copyAddOn ${entry.copyAddOn}: no such add-on`);
    return copy;
  }
  if (entry.id !== undefined) return { id: entry.id, key: null, values: null, params: resolveHex(entry.paramsHex) };
  const a = addOnByKey.get(entry.addOn);
  assert(a, `unknown add-on ${entry.addOn}`);
  const values = {};
  for (const p of a.params) {
    const raw = entry.params?.[p.name];
    assert(raw !== undefined, `add-on ${a.key}: param ${p.name} missing`);
    values[p.name] = resolveParam(p, raw);
  }
  for (const name of Object.keys(entry.params ?? {})) assert(a.params.some((p) => p.name === name), `${a.key} has no param ${name}`);
  return { id: a.id, key: a.key, values, params: encodeParams(a, values) };
}

function resolveParam(p, raw) {
  if (p.type === 'bytes32[]') {
    assert(Array.isArray(raw), `param ${p.name}: a list of bytes32 values`);
    return raw.map((v) => resolveHex(v, 32));
  }
  if (p.type === 'string') return resolveString(raw);
  if (p.type === 'address') return resolveAddress(raw);
  if (p.type === 'bytes32') return resolveHex(raw, 32);
  if (p.type === 'bool') return raw;
  if (p.enum && typeof raw === 'string') return enumValue(p.enum, raw);
  return isSmallUint(p.type) ? raw : BigInt(raw);
}

/** A resolved string's wire bytes: viem's own UTF-8 for a JS string (what encodeAbiParameters writes), else the raw bytes. */
const stringHex = (v) => (typeof v === 'string' ? stringToHex(v) : v.rawHex);

/** Strings are encoded as `bytes` (the same ABI encoding), so raw bytes and JS strings go through one path. */
function encodeParams(a, values) {
  if (a.params.length === 0) return '0x';
  return encodeAbiParameters(
    a.params.map((p) => ({ name: p.name, type: p.type === 'string' ? 'bytes' : p.type })),
    a.params.map((p) => (p.type === 'string' ? stringHex(values[p.name]) : values[p.name])),
  );
}

function transformParams(hex, t, addOn) {
  const bytes = Buffer.from(hex.slice(2), 'hex');
  switch (t.op) {
    case 'truncate':
      return toHex(bytes.subarray(0, bytes.length - t.bytes));
    case 'append':
      return toHex(Buffer.concat([bytes, Buffer.from(t.hex.replace(/^0x/, ''), 'hex')]));
    case 'replace':
      return resolveHex(t.hex);
    case 'setWord': {
      const out = Buffer.from(bytes);
      Buffer.from(BigInt(t.value).toString(16).padStart(64, '0'), 'hex').copy(out, 32 * t.word);
      return toHex(out);
    }
    case 'dirtyPadding': {
      const a = addOnById.get(addOn.id);
      assert(a?.params[t.param]?.type === 'string', 'dirtyPadding needs a string param');
      const offset = Number(BigInt(`0x${bytes.subarray(32 * t.param, 32 * t.param + 32).toString('hex')}`));
      const len = Number(BigInt(`0x${bytes.subarray(offset, offset + 32).toString('hex')}`));
      assert(len % 32 !== 0, 'dirtyPadding needs a string whose length is not a multiple of 32');
      const out = Buffer.from(bytes);
      out[offset + 32 + Math.ceil(len / 32) * 32 - 1] = 1;
      return toHex(out);
    }
    default:
      return fail(`unknown transform ${t.op}`);
  }
}

const fixtureFiles = readdirSync(join(pkgDir, 'fixtures'))
  .filter((f) => f.endsWith('.json'))
  .sort();
const fixtures = new Map();
for (const file of fixtureFiles) {
  const fx = readJson(join(pkgDir, 'fixtures', file));
  assert(`${fx.name}.json` === file, `fixture ${file} must be named ${fx.name}`);
  fixtures.set(fx.name, fx);
}

/** Authoring spec -> { wire, addOnsResolved }. */
function buildSpec(authoring) {
  const wire = {};
  for (const f of fields) {
    if (f.name === 'addOns') continue;
    assert(f.name in authoring, `spec field ${f.name} missing`);
    wire[f.name] = resolveField(f, authoring[f.name]);
  }
  for (const name of Object.keys(authoring)) assert(fieldByName.has(name), `unknown spec field ${name}`);
  const resolved = (authoring.addOns ?? []).map((entry) => resolveAddOn(entry, []));
  wire.addOns = resolved.map((a) => ({ id: a.id, params: a.params }));
  return { wire, resolved };
}

const baseSpecs = new Map([...fixtures].map(([name, fx]) => [name, buildSpec(fx.spec)]));
for (const [name, base] of baseSpecs) {
  for (const f of fields) assert(f.type !== 'string' || typeof base.wire[f.name] === 'string', `fixture ${name}: ${f.name} must be a JS string`);
  for (const a of base.resolved) {
    for (const [p, v] of Object.entries(a.values ?? {})) {
      assert(typeof v !== 'object' || v === null || Array.isArray(v), `fixture ${name}: ${a.key}.${p} must be a JS string`);
    }
  }
}

function applyCase(c) {
  const base = baseSpecs.get(c.base);
  assert(base, `case ${c.name}: unknown base ${c.base}`);
  const wire = { ...base.wire };
  let resolved = [...base.resolved];
  for (const [name, value] of Object.entries(c.set ?? {})) {
    const f = fieldByName.get(name);
    assert(f && name !== 'addOns', `case ${c.name}: cannot set ${name}`);
    wire[name] = resolveField(f, value);
  }
  if (c.addOns) resolved = c.addOns.map((entry) => resolveAddOn(entry, base.resolved));
  if (c.removeAddOn) {
    assert(resolved.some((a) => a.key === c.removeAddOn), `case ${c.name}: no ${c.removeAddOn} to remove`);
    resolved = resolved.filter((a) => a.key !== c.removeAddOn);
  }
  if (c.patchAddOn) {
    const i = c.patchAddOn.index;
    const target = resolved[i];
    assert(target?.key, `case ${c.name}: patchAddOn ${i} needs a catalog add-on`);
    const a = addOnById.get(target.id);
    let values = target.values;
    let params = target.params;
    if (c.patchAddOn.params) {
      values = { ...values };
      for (const [name, raw] of Object.entries(c.patchAddOn.params)) {
        const p = a.params.find((x) => x.name === name);
        assert(p, `case ${c.name}: ${a.key} has no param ${name}`);
        values[name] = resolveParam(p, raw);
      }
      params = encodeParams(a, values);
    }
    if (c.patchAddOn.transform) params = transformParams(params, c.patchAddOn.transform, target);
    resolved = resolved.map((x, j) => (j === i ? { ...target, values, params } : x));
  }
  wire.addOns = resolved.map((a) => ({ id: a.id, params: a.params }));
  return wire;
}

// ---------------------------------------------------------------------------------------------------------------
// Encoding (viem) for fixtures and vectors
// ---------------------------------------------------------------------------------------------------------------

/** Every `string` as `bytes`: the same ABI encoding, so raw-byte vectors and JS strings share one encoder. */
const BOX_SPEC_BYTES_ABI = {
  type: 'tuple',
  components: fields.map((f) =>
    f.type === 'AddOn[]'
      ? { name: f.name, type: 'tuple[]', components: [{ name: 'id', type: 'uint16' }, { name: 'params', type: 'bytes' }] }
      : { name: f.name, type: f.type === 'string' ? 'bytes' : f.type },
  ),
};
const Q_LIST_ABI = {
  type: 'tuple[]',
  components: [
    { name: 'token', type: 'address' },
    { name: 'decimals', type: 'uint8' },
    { name: 'qClass', type: 'uint8' },
    { name: 'raisePresets', type: 'uint256[]' },
  ],
};
const VERSION_CONTEXT_ABI = {
  type: 'tuple',
  components: [
    { name: 'qList', type: 'tuple[]', components: Q_LIST_ABI.components },
    { name: 'gradLayouts', type: 'uint8[]' },
  ],
};
const encodeSpec = (wire) =>
  encodeAbiParameters(
    [BOX_SPEC_BYTES_ABI],
    [Object.fromEntries(fields.map((f) => [f.name, f.type === 'string' ? stringHex(wire[f.name]) : wire[f.name]]))],
  );
const encodeContext = (ctx) =>
  encodeAbiParameters(
    [VERSION_CONTEXT_ABI],
    [
      {
        qList: ctx.qList.map((q) => ({ token: q.token, decimals: q.decimals, qClass: q.qClassValue, raisePresets: q.presets })),
        gradLayouts: ctx.gradLayoutValues,
      },
    ],
  );

function expectation(e) {
  if (e === 'OK') return { reason: 0, reasonName: 'OK', field: 0, fieldName: '' };
  assert(Array.isArray(e) && e.length === 2, `bad expect ${JSON.stringify(e)}`);
  return { reason: reasonCode(e[0]), reasonName: e[0], field: fieldId(e[1]), fieldName: e[1] };
}

function emitVectors() {
  const names = new Set();
  const built = casesFile.cases.map((c) => {
    assert(!names.has(c.name), `case name twice: ${c.name}`);
    names.add(c.name);
    assert(Array.isArray(c.cases) && c.cases.includes('BC-001'), `case ${c.name}: tag BC-001`);
    const encoded = encodeSpec(applyCase(c));
    return {
      name: c.name,
      context: contextIndex(c.context),
      ...expectation(c.expect),
      specHash: keccak256(encoded),
      cases: c.cases,
      ...(c.matrix ? { matrix: c.matrix } : {}),
      encoded,
    };
  });
  const out = {
    about: [
      'GENERATED by packages/box-spec/scripts/generate.mjs from packages/box-spec/vectors/cases.v1.json and the fixtures: do not edit.',
      'BC-001: Foundry (test/box/BoxSpecV1Vectors.t.sol) and vitest (packages/box-spec/src/box-spec.test.ts) decode columns.encoded[i], validate it against contexts[context] (a VersionContext: Q list and graduated layouts) and must return (reason, field) and specHash exactly as vectors[i] lists them. vitest checks the raw bytes (validateEncodedBoxSpecV1) for every vector, and its JS-string API wherever the strings are valid UTF-8.',
      '`columns` repeats the vectors field by field (Foundry reads one array per cheatcode call); `vectors` is the readable index.',
    ],
    contextCount: contexts.length,
    contexts: contexts.map((ctx) => ({
      name: ctx.name,
      version: ctx.version,
      qList: ctx.qList.map((q) => ({ token: q.token, decimals: q.decimals, qClass: q.qClass, raisePresets: q.presets.map(String) })),
      gradLayouts: ctx.gradLayouts,
      encoded: encodeContext(ctx),
    })),
    fixtures: Object.fromEntries([...baseSpecs].map(([name, b]) => [name, keccak256(encodeSpec(b.wire))])),
    count: built.length,
    vectors: built.map((v) => Object.fromEntries(Object.entries(v).filter(([key]) => key !== 'encoded'))),
    columns: {
      name: built.map((v) => v.name),
      context: built.map((v) => v.context),
      reason: built.map((v) => v.reason),
      field: built.map((v) => v.field),
      specHash: built.map((v) => v.specHash),
      encoded: built.map((v) => v.encoded),
    },
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

function tsLiteral(value, indent) {
  const pad = ' '.repeat(indent);
  if (typeof value === 'bigint') return tsBig(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value).replace(/'/g, "\\'").replace(/^"|"$/g, "'").replace(/\\"/g, '"');
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((v) => `${pad}  ${tsLiteral(v, indent + 2)},`).join('\n')}\n${pad}]`;
  }
  return `{\n${Object.entries(value)
    .map(([k, v]) => `${pad}  ${k}: ${tsLiteral(v, indent + 2)},`)
    .join('\n')}\n${pad}}`;
}

function emitFixtures() {
  const L = [];
  L.push('// GENERATED FILE, do not edit: packages/box-spec/scripts/generate.mjs writes it from packages/box-spec/fixtures/*.json.');
  L.push('// Each fixture in wire form with its spec hash (keccak256(abi.encode(spec))).');
  L.push("import type { BoxSpecV1 } from './box-spec.v1';");
  L.push('');
  const caseContext = (name) => casesFile.cases.find((c) => c.base === name && c.expect === 'OK' && !c.set && !c.addOns && !c.patchAddOn)?.context;
  for (const [name, fx] of fixtures) {
    const wire = baseSpecs.get(name).wire;
    L.push(`/**\n * ${fx.title}.\n${fx.about.map((a) => ` * ${a}`).join('\n')}\n */`);
    L.push(`export const ${snake(name)}: BoxSpecV1 = ${tsLiteral(wire, 0)};`);
    L.push(`export const ${snake(name)}_SPEC_HASH = '${keccak256(encodeSpec(wire))}';`);
    L.push(`export const ${snake(name)}_CONTEXT = '${caseContext(name) ?? fail(`fixture ${name} needs an OK vector`)}';`);
    L.push('');
  }
  L.push(`export const FIXTURES = { ${[...fixtures.keys()].map((n) => `'${n}': ${snake(n)}`).join(', ')} } as const;`);
  L.push('');
  return L.join('\n');
}

export { emitFixtures, emitVectors };
