#!/usr/bin/env node
// TEST ONLY (M1-10-a). Encodes the hand-declared format 2 vectors (packages/box-spec/vectors/cases.v2.json) into the
// shared vector file packages/contracts/test/vectors/box-spec/box-spec-v2.json: each spec's ABI bytes (viem), its spec
// hash, its context, its declared verdict as codes, the canonical recipe params and the chunk roots. It never runs a
// validator, so the verdicts stay an independent oracle for both twins (as format 1's generator, authoring.mjs).
// Run: node packages/contracts/test/box-v2/m1-10a/encode-vectors.mjs [--check] (--check: exit 1 when stale).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const at = (p) => resolve(repo, p);
const OUT = 'packages/contracts/test/vectors/box-spec/box-spec-v2.json';
// viem is the box-spec package's dependency; the contracts package has none of its own.
const { encodeAbiParameters, getAddress, keccak256, stringToBytes, stringToHex, toHex } = createRequire(at('packages/box-spec/package.json'))('viem');
const readJson = (p) => JSON.parse(readFileSync(at(p), 'utf8'));
const fail = (m) => {
  throw new Error(`encode-vectors: ${m}`);
};
const ZERO32 = `0x${'00'.repeat(32)}`;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const spec = readJson('packages/box-spec/box-spec.v2.json');
const catalog = readJson('packages/box-spec/add-ons.v2.json');
const source = readJson('packages/box-spec/vectors/cases.v2.json');
const r = spec.recipe;

const constants = new Map(spec.constants.filter((c) => typeof c.value === 'string').map((c) => [c.name, BigInt(c.value)]));
const enums = new Map([...spec.enums, ...catalog.enums].map((e) => [e.name, new Map(e.members.map((m) => [m.name, m.value]))]));
const enumValue = (name, v) => (typeof v === 'number' ? v : (enums.get(name)?.get(v) ?? fail(`${name} has no ${v}`)));
const reasons = new Map(spec.reasons.map((x) => [x.name, x.code]));
const fieldIds = new Map(spec.fields.map((f) => [f.name, f.id]));
for (const side of r.sides) {
  const base = 1000 * fieldIds.get(side.field);
  for (const branch of ['a', 'b']) for (const key of ['leg', 'dest', 'legParams', 'destParams']) {
    fieldIds.set(`${side.name}.${branch}.${key}`, base + (branch === 'b' ? r.subFields.bOffset : 0) + r.subFields[key]);
  }
  for (const key of ['split', 'splitParams']) fieldIds.set(`${side.name}.${key}`, base + r.subFields[key]);
}
for (const a of catalog.addOns) {
  fieldIds.set(`addOns.${a.key}`, 100 * a.id);
  a.params.forEach((p, i) => fieldIds.set(`addOns.${a.key}.${p.name}`, 100 * a.id + i + 1));
}
const listings = new Map(source.listings.map((l) => [l.id, l]));

// ---------------------------------------------------------------- values
const length = (v) => {
  if (v.n !== undefined) return v.n;
  const c = constants.get(v.const) ?? fail(`no constant ${v.const}`);
  return Number(c) * (v.times ?? 1) + (v.plus ?? 0);
};
function encodeTable({ description = '', traitTypes = [] }) {
  const d = Buffer.from(typeof description === 'string' ? description : 'd'.repeat(description.length), 'ascii');
  const parts = [Buffer.from([1, d.length >> 8, d.length & 0xff]), d, Buffer.from([traitTypes.length])];
  for (const t of traitTypes) {
    parts.push(Buffer.from([t.name.length]), Buffer.from(t.name, 'ascii'), Buffer.from([t.values.length]));
    for (const v of t.values) parts.push(Buffer.from([v.length]), Buffer.from(v, 'ascii'));
  }
  return toHex(Buffer.concat(parts));
}
function bytes(v) {
  if (typeof v === 'string') return /^0x(?:[0-9a-fA-F]{2})*$/.test(v) ? v.toLowerCase() : fail(`bad hex ${v}`);
  if (v.rawHex !== undefined) return v.rawHex;
  if (v.keccakOfText !== undefined) return keccak256(stringToBytes(v.keccakOfText));
  if (v.sha256OfText !== undefined) return `0x${createHash('sha256').update(v.sha256OfText, 'utf8').digest('hex')}`;
  if (v.formatV1) return encodeTable(v.formatV1);
  // A well-formed table of exactly that many bytes: no traits, a description of length - 4 bytes.
  if (v.tableOfLength) return encodeTable({ description: { length: length(v.tableOfLength) - 4 } });
  if (v.bytesOfLength) return `0x${(v.byte ?? 'ab').repeat(length(v.bytesOfLength))}`;
  return fail(`bad bytes ${JSON.stringify(v)}`);
}
const string = (v) => (typeof v === 'string' ? stringToHex(v) : v.repeat !== undefined ? stringToHex(v.repeat.repeat(v.times)) : bytes(v));
function address(v) {
  if (typeof v === 'string') return getAddress(v);
  if (v.addressOfText !== undefined) return getAddress(`0x${keccak256(stringToBytes(v.addressOfText)).slice(-40)}`);
  if (v.listingToken !== undefined) return address((listings.get(v.listingToken) ?? fail(`no listing ${v.listingToken}`)).token);
  return fail(`bad address ${JSON.stringify(v)}`);
}
function value(type, v, enumName) {
  if (enumName && typeof v === 'string') return enumValue(enumName, v);
  if (type === 'address') return v === undefined ? ZERO_ADDRESS : address(v);
  if (type === 'bytes32') return v === undefined ? ZERO32 : bytes(v);
  if (type === 'bytes') return v === undefined ? '0x' : bytes(v);
  if (type === 'string') return v === undefined ? '0x' : string(v);
  if (type === 'bytes32[]') return (v ?? []).map(bytes);
  if (/^uint(8|16|32)$/.test(type)) return v === undefined ? 0 : Number(v);
  if (/^uint/.test(type)) return v === undefined ? 0n : BigInt(v);
  return fail(`no value for ${type}`);
}

// ---------------------------------------------------------------- non-canonical params (review round 1)
/** Byte edits on a canonical params blob (its members as a list, one head word each): `gap` puts a dynamic member's
 * tail one zero word later and moves the offsets that point at or past it; `dirtyPad` sets its last padding byte;
 * `setLength` rewrites its length word; `setByte` sets one byte of a member's head word. A result decodes to the
 * same values, or to others, or not at all; it never re-encodes to itself (box-spec-v2.check.mjs, SpecV2Wire.t.sol). */
const DYNAMIC = new Set(['bytes', 'string', 'bytes32[]']);
function edited(hex, members, ops) {
  let b = Buffer.from(hex.slice(2), 'hex');
  const word = (at) => Number(BigInt(`0x${b.subarray(at, at + 32).toString('hex')}`));
  const put = (at, n) => Buffer.from(BigInt(n).toString(16).padStart(64, '0'), 'hex').copy(b, at);
  for (const e of ops) {
    const i = members.findIndex((m) => m.name === e.member);
    if (i < 0) fail(`edit: no member ${e.member}`);
    if (e.op === 'setByte') {
      b[32 * i + e.byte] = Number.parseInt(e.value, 16);
      continue;
    }
    if (!DYNAMIC.has(members[i].type)) fail(`edit ${e.op}: ${e.member} is not dynamic`);
    const tail = word(32 * i);
    if (e.op === 'gap') {
      const moved = members.flatMap((m, j) => (DYNAMIC.has(m.type) && word(32 * j) >= tail ? [j] : []));
      b = Buffer.concat([b.subarray(0, tail), Buffer.alloc(32), b.subarray(tail)]);
      for (const j of moved) put(32 * j, word(32 * j) + 32);
    } else if (e.op === 'dirtyPad' && members[i].type !== 'bytes32[]' && word(tail) % 32 !== 0) {
      b[tail + 32 + Math.ceil(word(tail) / 32) * 32 - 1] = 1;
    } else if (e.op === 'setLength') {
      put(tail, e.value);
    } else {
      fail(`edit ${e.op} does not apply to ${e.member}`);
    }
  }
  return toHex(b);
}

// ---------------------------------------------------------------- recipes and add-ons
const memberEnum = (tuple) => new Map(r.paramTuples[tuple].members.filter((c) => c.enum).map((c) => [c.name, c.enum]));
/** A params blob: raw hex as written, an object encoded as its tuple (recorded as canonical), or { of, edit }: that
 * encoding edited (recorded as non-canonical at its sub-field `at`). */
function params(tuple, v, sink, at) {
  if (v === undefined) return '0x';
  if (typeof v === 'string' || v.rawHex !== undefined) return bytes(v);
  if (!tuple) fail(`params ${JSON.stringify(v)} for a member without a tuple`);
  if (v.edit) {
    const encoded = edited(params(tuple, v.of, { params: [], cfgBytes: 0 }), r.paramTuples[tuple].members, v.edit);
    sink.nonCanonical.push({ tuple, at, ops: v.edit.map((e) => e.op), encoded });
    return encoded;
  }
  const t = r.paramTuples[tuple];
  const en = memberEnum(tuple);
  const encoded = encodeAbiParameters(t.members.map(({ name, type }) => ({ name, type })), t.members.map((m) => value(m.type, v[m.name], en.get(m.name))));
  sink.params.push({ tuple, encoded });
  if (v.cfg !== undefined) sink.cfgBytes += (bytes(v.cfg).length - 2) / 2;
  return encoded;
}
const rowOf = (rows, name) => rows[name];
function branch(b, sink, at) {
  if (!b) return { leg: 0, dest: 0, legParams: '0x', destParams: '0x' };
  return {
    leg: b.leg === undefined ? 0 : enumValue('Leg', b.leg),
    dest: b.dest === undefined ? 0 : enumValue('Dest', b.dest),
    legParams: params(rowOf(r.legs, b.leg)?.params, b.legParams, sink, `${at}.legParams`),
    destParams: params(rowOf(r.dests, b.dest)?.params, b.destParams, sink, `${at}.destParams`),
  };
}
function side(s, sink, at) {
  return { a: branch(s.a, sink, `${at}.a`), b: branch(s.b, sink, `${at}.b`), split: s.split === undefined ? 0 : enumValue('Split', s.split), splitParams: params(rowOf(r.splits, s.split)?.params, s.splitParams, sink, `${at}.splitParams`) };
}
function addOn(entry, sink) {
  const a = entry.addOn !== undefined ? (catalog.addOns.find((x) => x.key === entry.addOn) ?? fail(`no add-on ${entry.addOn}`)) : undefined;
  const id = entry.id ?? a.id;
  if (typeof entry.params === 'string' || !a) return { id, params: entry.params ?? '0x' };
  const encoded = a.params.length ? encodeAbiParameters(a.params.map((p) => ({ type: p.type === 'string' ? 'bytes' : p.type })), a.params.map((p) => value(p.type, entry.params?.[p.name], p.enum))) : '0x';
  if (!entry.edit) return { id, params: encoded };
  const out = edited(encoded, a.params, entry.edit);
  sink.nonCanonical.push({ tuple: `add-on ${a.key}`, at: `addOns.${a.key}`, ops: entry.edit.map((e) => e.op), encoded: out });
  return { id, params: out };
}

// ---------------------------------------------------------------- specs and contexts (SpecTypes.sol on the wire)
const BRANCH = [{ name: 'leg', type: 'uint8' }, { name: 'dest', type: 'uint8' }, { name: 'legParams', type: 'bytes' }, { name: 'destParams', type: 'bytes' }];
const ABI_OF = {
  Pricing: { type: 'tuple', components: [{ name: 'listingId', type: 'uint32' }, { name: 'token', type: 'address' }] },
  Side: { type: 'tuple', components: [{ name: 'a', type: 'tuple', components: BRANCH }, { name: 'b', type: 'tuple', components: BRANCH }, { name: 'split', type: 'uint8' }, { name: 'splitParams', type: 'bytes' }] },
  'AddOn[]': { type: 'tuple[]', components: [{ name: 'id', type: 'uint16' }, { name: 'params', type: 'bytes' }] },
  string: { type: 'bytes' },
};
const SPEC_ABI = { type: 'tuple', components: spec.fields.map((f) => ({ name: f.name, ...(ABI_OF[f.type] ?? { type: f.type }) })) };
const LISTING = ['uint32 id', 'address token', 'uint8 decimals', 'uint8 class', 'uint8 kind', 'uint256 raise'];
const comps = (list) => list.map((x) => ({ type: x.split(' ')[0], name: x.split(' ')[1] }));
const CONTEXT_ABI = { type: 'tuple', components: [{ name: 'listing', type: 'tuple', components: comps(LISTING) }] };
function wireOf(authoring) {
  const sink = { params: [], cfgBytes: 0, nonCanonical: [] };
  const w = {};
  for (const f of spec.fields) {
    const v = authoring[f.name];
    if (f.type === 'Pricing') w[f.name] = { listingId: v.listing ?? v.listingId, token: address(v.token ?? { listingToken: v.listing }) };
    else if (f.type === 'Side') w[f.name] = side(v, sink, f.name);
    else if (f.type === 'AddOn[]') w[f.name] = (v ?? []).map((entry) => addOn(entry, sink));
    else if (f.name === 'raise' && typeof v === 'object') w[f.name] = BigInt(listings.get(v.raiseOf).raise) + BigInt(v.plus ?? 0);
    else w[f.name] = value(f.type, v, f.enum);
  }
  return { w, sink };
}
function setPath(o, path, v) {
  const keys = path.split('.');
  const last = keys.pop();
  let x = o;
  for (const k of keys) x = x[k] ??= {};
  x[last] = v;
}
const contextOf = (c) => {
  if (c.listing === null) return { listing: { id: 0, token: ZERO_ADDRESS, decimals: 0, class: 0, kind: 0, raise: 0n } };
  const l = listings.get(c.listing);
  return { listing: { id: l.id, token: address(l.token), decimals: l.decimals, class: enumValue('ListingClass', l.class), kind: enumValue('ListingKind', l.kind), raise: BigInt(c.raise ?? l.raise) } };
};

function rootOf(hex, chunkMax) {
  const b = Buffer.from(hex.slice(2), 'hex');
  const n = Math.ceil(b.length / chunkMax);
  let h = ZERO32;
  for (let k = n; k > 0; --k) h = keccak256(Buffer.concat([b.subarray((k - 1) * chunkMax, Math.min(k * chunkMax, b.length)), Buffer.from(h.slice(2), 'hex')]));
  return { root: h, chunkCount: n };
}
const json = (x) => JSON.parse(JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

export function buildVectors() {
  const contextIndex = new Map(source.contexts.map((c, i) => [c.name, i]));
  const names = new Set();
  const params = new Map();
  const nonCanonical = [];
  const vectors = source.cases.map((c) => {
    if (names.has(c.name)) fail(`case name twice: ${c.name}`);
    names.add(c.name);
    const authoring = structuredClone(source.fixtures[c.base] ?? fail(`case ${c.name}: no fixture ${c.base}`));
    for (const [path, v] of Object.entries(c.set ?? {})) setPath(authoring, path, v);
    const { w, sink } = wireOf(authoring);
    for (const p of sink.params) params.set(`${p.tuple}:${p.encoded}`, p);
    for (const p of sink.nonCanonical) nonCanonical.push({ vector: c.name, ...p });
    const encoded = encodeAbiParameters([SPEC_ABI], [w]);
    const ok = c.expect === 'OK';
    const field = ok ? 0 : (fieldIds.get(c.expect[1]) ?? fail(`case ${c.name}: no field ${c.expect[1]}`));
    if (!contextIndex.has(c.context)) fail(`case ${c.name}: no context ${c.context}`);
    return {
      name: c.name,
      context: contextIndex.get(c.context),
      reason: ok ? 0 : (reasons.get(c.expect[0]) ?? fail(`case ${c.name}: no reason ${c.expect[0]}`)),
      reasonName: ok ? 'OK' : c.expect[0],
      field,
      fieldName: ok ? '' : c.expect[1],
      specHash: keccak256(encoded),
      cases: c.cases,
      tags: c.tags ?? [],
      tableBytes: (w.metadataTable.length - 2) / 2,
      cfgBytes: sink.cfgBytes,
      encoded,
    };
  });
  const chunkMax = Number(constants.get('CHUNK_MAX'));
  const chunks = source.chunks.map((c) => ({ name: c.name, part: bytes({ bytesOfLength: c.length, byte: c.byte }) }));
  const out = {
    about: [
      'GENERATED by packages/contracts/test/box-v2/m1-10a/encode-vectors.mjs from packages/box-spec/vectors/cases.v2.json (verdicts declared by hand) and box-spec.v2.json: do not edit.',
      'BC-230 (N24): both twins decode columns.encoded[i] (SpecTypes.sol BoxSpec), validate it against contexts[context].encoded (ReleaseContext) and must return (reason, field) and specHash exactly as vectors[i] lists them. `columns` repeats the vectors field by field for Foundry.',
      '`params`: every canonical recipe params blob in the vectors, by its RecipeTypes.sol tuple. `nonCanonical`: every params blob a vector edits away from canonical (recipe or add-on), with its vector and sub-field; none re-encodes to itself. `chunks`: parts cut at CHUNK_MAX by IBoxCoordinatorV2\'s hash rule, with their roots. `constants`: box-spec.v2.json\'s, for the Foundry checks.',
    ],
    format: 2,
    constants: Object.fromEntries(spec.constants.map((c) => [c.name, c.value])),
    contextCount: source.contexts.length,
    contexts: source.contexts.map((c) => ({ name: c.name, ...json(contextOf(c)), encoded: encodeAbiParameters([CONTEXT_ABI], [contextOf(c)]) })),
    fixtures: Object.fromEntries(Object.entries(source.fixtures).map(([name, a]) => [name, keccak256(encodeAbiParameters([SPEC_ABI], [wireOf(a).w]))])),
    count: vectors.length,
    vectors: vectors.map((v) => Object.fromEntries(Object.entries(v).filter(([key]) => key !== 'encoded'))),
    columns: Object.fromEntries(['name', 'context', 'reason', 'field', 'specHash', 'encoded'].map((k) => [k, vectors.map((v) => v[k])])),
    params: { count: params.size, columns: { tuple: [...params.values()].map((p) => p.tuple), encoded: [...params.values()].map((p) => p.encoded) } },
    nonCanonical: { count: nonCanonical.length, columns: Object.fromEntries(['vector', 'tuple', 'at', 'encoded'].map((k) => [k, nonCanonical.map((p) => p[k])])) },
    chunks: {
      chunkMax,
      count: chunks.length,
      columns: {
        name: chunks.map((c) => c.name),
        length: chunks.map((c) => (c.part.length - 2) / 2),
        chunkCount: chunks.map((c) => rootOf(c.part, chunkMax).chunkCount),
        root: chunks.map((c) => rootOf(c.part, chunkMax).root),
        part: chunks.map((c) => c.part),
      },
    },
  };
  return { text: `${JSON.stringify(out, null, 1)}\n`, vectors, nonCanonical };
}

// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  const { text, vectors } = buildVectors();
  if (process.argv.includes('--check')) {
    const current = readFileSync(at(OUT), 'utf8');
    if (current !== text) {
      console.error(`STALE: ${OUT} (run node packages/contracts/test/box-v2/m1-10a/encode-vectors.mjs)`);
      process.exit(1);
    }
    process.stdout.write(`current: ${vectors.length} vectors\n`);
  } else {
    writeFileSync(at(OUT), text);
    process.stdout.write(`wrote ${OUT}: ${vectors.length} vectors\n`);
  }
}
