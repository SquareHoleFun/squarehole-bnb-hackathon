#!/usr/bin/env node
/**
 * AuditU9ClaudeGen.mjs (SH-AUDIT-B0-U9, Claude auditor): random BoxSpec, layout and encoding vectors computed by the
 * TypeScript twin (packages/box-spec), offline and deterministic (fixed seed, no network, no FFI). It writes
 * packages/contracts/test/box/audit/U9/AuditU9ClaudeTwinVectors.sol, which AuditU9ClaudeTwin.t.sol replays in forge.
 *
 *   node packages/contracts/test/box/audit/U9/AuditU9ClaudeGen.mjs [worktree root]
 *
 * (Node 24.22.1; the root defaults to the checkout this file is in.) Rerun it whenever the twin changes and commit the
 * vectors it writes (SH-AUDIT-B0-FINAL). First published as appendix A of docs/evidence/SH-AUDIT-B0-U9-C.md; this copy
 * differs only in how it finds the root, its usage line, the vectors file's header comment, its report output and
 * two lint renames (usePool is pooled; edgeValue takes no unused second argument).
 *
 * Spec vectors are a base fixture plus mutations (so the file stays small); the verdict, field and spec hash are the
 * twin's: validateBoxSpecV1Bytes(spec, ctx) (network mainnet, validate()'s own lists) and keccak256(encodeBoxSpecV1Bytes).
 * Encoded vectors patch bytes of box 0's canonical encoding (high bits of static words) and record
 * validateEncodedBoxSpecV1 and specHashOfEncoded, or that they throw. Layout vectors record boxCurve and boxGraduated.
 * Encoding vectors record Buffer's base64 and an independent bit-accumulator base32 (RFC 4648, lower case, unpadded).
 */
import { writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.argv[2] ?? fileURLToPath(new URL('../../../../../../', import.meta.url));
const OUT = join(ROOT, 'packages/contracts/test/box/audit/U9/AuditU9ClaudeTwinVectors.sol');
const BOX = join(ROOT, 'packages/box-spec');
const imp = (p) => import(pathToFileURL(join(BOX, p)).href);
const { loadBoxSpecLibrary } = await imp('scripts/lib/load-generated.mjs');
const L = await loadBoxSpecLibrary(); // also registers the resolve hook the .ts imports need
const F = await imp('src/generated/fixtures.v1.ts');
const BP = await imp('src/build-profile.ts');
const PROF = await imp('src/generated/build-profiles.v1.ts');
const LAY = await imp('src/layout.ts');
const V = await imp('node_modules/viem/_esm/index.js');

// ------------------------------------------------------------------------------------------------ PRNG (mulberry32)
let seed = 0x53485539 >>> 0; // "SHU9"
function rnd() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (n) => Math.floor(rnd() * n);
const pick = (a) => a[int(a.length)];
const chance = (p) => rnd() < p;
function big(bits) {
  let v = 0n;
  for (let i = 0; i < bits; i += 32) v = (v << 32n) | BigInt(int(2 ** 32));
  return v & ((1n << BigInt(bits)) - 1n);
}
const randBytes = (n) => Uint8Array.from({ length: n }, () => int(256));
const hex = (u8) => V.bytesToHex(u8);
const toU8 = (h) => V.hexToBytes(h);
const randWord = () => hex(randBytes(32));
const ZERO32 = `0x${'00'.repeat(32)}`;
const ZERO = '0x0000000000000000000000000000000000000000';
const randAddress = () => V.getAddress(hex(randBytes(20)));

// ------------------------------------------------------------------------------------------------ texts
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const ALL = range(0, 255);
const JSON_OK = range(0x20, 0x7e).filter((c) => c !== 0x22 && c !== 0x5c);
const SVG_OK = range(0x20, 0x7e);
const URL_OK = [0x21, ...range(0x23, 0x3b), 0x3d, ...range(0x3f, 0x5b), 0x5d, 0x5f, ...range(0x61, 0x7a), 0x7e];
const badOf = (ok) => ALL.filter((c) => !ok.includes(c));
const JSON_BAD = badOf(JSON_OK);
const SVG_BAD = badOf(SVG_OK);
const URL_BAD = badOf(URL_OK);
/** `len` bytes from `ok`; with chance `bad`, one byte at a random place from `badSet`. */
function text(len, ok, bad = 0, badSet = badOf(ok)) {
  const b = Uint8Array.from({ length: len }, () => pick(ok));
  if (len > 0 && chance(bad)) b[int(len)] = pick(badSet);
  return b;
}
/** A length near a [min, max] check: the edges, one past them, and random lengths inside. */
function lenNear(min, max) {
  const c = [min, min + 1, max - 1, max, max + 1, min + int(max - min + 1), min + int(Math.min(max - min, 24) + 1)];
  if (min > 0) c.push(min - 1, 0);
  return Math.max(0, pick(c));
}
const enc = (s) => new TextEncoder().encode(s);

// ------------------------------------------------------------------------------------------------ the pool
/** Reused blobs (tables, the placeholders sets, long texts) and any blob over INLINE_MAX bytes are written once and
 * referenced by index (u8); every other value is inline. */
const INLINE_MAX = 1024;
const POOLABLE = new Set();
const pooled = (h) => POOLABLE.has(h) || toU8(h).length > INLINE_MAX;
const pool = [];
const poolIndex = new Map();
function poolRef(h) {
  if (!poolIndex.has(h)) {
    if (pool.length >= 255) throw new Error('pool full');
    poolIndex.set(h, pool.length);
    pool.push(h);
  }
  return poolIndex.get(h);
}

// ------------------------------------------------------------------------------------------------ bases and contexts
const BASES = [F.BOX_0_MISFITS, F.DEMO_PLACEHOLDERS, F.DEMO_OPEN_ART, F.DEMO_TOKEN_ONLY].map((s) => L.toBoxSpecV1Bytes(s));
const BASE_NAMES = ['box 0 fixture (v1)', 'demo placeholders (v2)', 'demo open art (v2)', 'demo token-only (v2)'];
const R = 4206980085000000000n;
const ERC20_18 = V.getAddress('0x1800000000000000000000000000000000000018');
const ERC20_6 = V.getAddress('0x0600000000000000000000000000000000000006');
const FIT = V.getAddress('0xf170000000000000000000000000000000000f17');
const BOXT = V.getAddress('0xb0c5000000000000000000000000000000000b0c');
const SAFE = V.getAddress('0xdCE82e76456434d0f550b492Ff212A862221e6c5');
const Q = L.QClass;
const TEST_CTX = {
  qList: [
    { token: ZERO, decimals: 18, qClass: Q.NATIVE_ETH, raisePresets: [10n ** 18n, 42n * 10n ** 17n, R, 10n ** 19n] },
    { token: ERC20_18, decimals: 18, qClass: Q.ERC20, raisePresets: [2500n * 10n ** 18n, 10n ** 22n, 25n * 10n ** 21n] },
    { token: ERC20_6, decimals: 6, qClass: Q.ERC20, raisePresets: [2500000000n, 10000000000n, 25000000000n] },
    { token: FIT, decimals: 18, qClass: Q.FIT, raisePresets: [10n ** 24n, 10n ** 25n, 5n * 10n ** 25n] },
    { token: BOXT, decimals: 18, qClass: Q.BOX_T, raisePresets: [10n ** 24n, 10n ** 25n, 5n * 10n ** 25n] },
  ],
  gradLayouts: [L.GradLayout.ASK_FULL_BID_SENTINEL],
};
// Two entries for one token: the first decides the presets and the class (`_isPreset`, `_qClassOf`); B_PRIME listed.
const DUP_CTX = {
  qList: [
    { token: ZERO, decimals: 18, qClass: Q.NATIVE_ETH, raisePresets: [R] },
    { token: ZERO, decimals: 18, qClass: Q.FIT, raisePresets: [10n ** 18n] },
    { token: FIT, decimals: 18, qClass: Q.FIT, raisePresets: [10n ** 24n] },
    { token: FIT, decimals: 18, qClass: Q.BOX_T, raisePresets: [2n * 10n ** 24n] },
  ],
  gradLayouts: [L.GradLayout.B_PRIME, L.GradLayout.ASK_FULL_BID_SENTINEL],
};
const CTXS = [
  L.CONTEXT_V1,
  L.CONTEXT_V2,
  TEST_CTX,
  { qList: L.CONTEXT_V1.qList, gradLayouts: [] },
  DUP_CTX,
  BP.contextForBuild(L.CONTEXT_V1, PROF.BUILD_PROFILE_REHEARSAL),
  BP.contextForBuild(L.CONTEXT_V2, PROF.BUILD_PROFILE_REHEARSAL),
];
const CTX_NAMES = ['v1', 'v2', 'test (5 Q)', 'v1 without graduated layouts', 'duplicate Q entries', 'v1 rehearsal raise', 'v2 rehearsal raise'];

// ------------------------------------------------------------------------------------------------ fields
const FIELDS = ['version', 'boxType', 'tokenName', 'tokenSymbol', 'collectionName', 'collectionSymbol', 'description', 'n', 'firstId', 'q', 'raise', 'layout', 'gradLayout', 'launchFormat', 'openAt', 'deadlineDays', 'qStream', 'tStream', 'artMode', 'revealRoot', 'metadataTable', 'generatorHash', 'coverSha256', 'revealListId', 'marketplaceOwner', 'creatorFeeRecipient', 'creatorBuy', 'collectionCoverSha256', 'addOns'];
const KIND = { version: 'u16', boxType: 'u8', tokenName: 's', tokenSymbol: 's', collectionName: 's', collectionSymbol: 's', description: 's', n: 'u32', firstId: 'u256', q: 'a', raise: 'u256', layout: 'u8', gradLayout: 'u8', launchFormat: 'u8', openAt: 'u32', deadlineDays: 'u16', qStream: 'u8', tStream: 'u8', artMode: 'u8', revealRoot: 'w', metadataTable: 's', generatorHash: 'w', coverSha256: 'w', revealListId: 'w', marketplaceOwner: 'a', creatorFeeRecipient: 'a', creatorBuy: 'u256', collectionCoverSha256: 'w' };
const MIN_OPEN_AT = 1788220800;

/** Big-endian minimal bytes of a non-negative bigint. */
function beBytes(v) {
  const out = [];
  let x = BigInt(v);
  while (x > 0n) {
    out.unshift(Number(x & 0xffn));
    x >>= 8n;
  }
  return out;
}
/** One mutation: its bytes for the Solidity side and its effect on the TypeScript spec. */
function mut(spec, field, value) {
  const i = FIELDS.indexOf(field);
  const k = KIND[field];
  let bytes;
  if (k.startsWith('u')) {
    const be = beBytes(value);
    bytes = [1, i, be.length, ...be];
    spec[field] = k === 'u256' ? BigInt(value) : Number(value);
  } else if (k === 'a') {
    bytes = [2, i, ...toU8(value)];
    spec[field] = V.getAddress(value);
  } else if (k === 'w') {
    bytes = [3, i, ...toU8(value)];
    spec[field] = value;
  } else {
    const b = toU8(value);
    if (pooled(value)) bytes = [5, i, poolRef(value)];
    else bytes = [4, i, b.length >> 8, b.length & 0xff, ...b];
    spec[field] = value;
  }
  return bytes;
}
function addOnsMut(spec, list) {
  const bytes = [6, list.length];
  for (const a of list) {
    const p = toU8(a.params);
    bytes.push(a.id >> 8, a.id & 0xff);
    if (pooled(a.params)) bytes.push(1, poolRef(a.params));
    else bytes.push(0, p.length >> 8, p.length & 0xff, ...p);
  }
  spec.addOns = list.map((a) => ({ id: a.id, params: a.params }));
  return bytes;
}

// ------------------------------------------------------------------------------------------------ metadata tables
function table({ desc = 0, types = 0, values = () => 1 + int(4), valueLen = () => 1 + int(8), nameLen = () => 1 + int(10), bad = 0 } = {}) {
  const parts = [1, desc >> 8, desc & 0xff, ...text(desc, JSON_OK, bad, JSON_BAD), types];
  for (let t = 0; t < types; t++) {
    const nl = nameLen();
    parts.push(nl, ...text(nl, JSON_OK, bad, JSON_BAD));
    const vc = values(t);
    parts.push(vc);
    for (let v = 0; v < vc; v++) {
      const vl = valueLen(t, v);
      parts.push(vl, ...text(vl, JSON_OK, bad, JSON_BAD));
    }
  }
  return Uint8Array.from(parts);
}
/** The largest table: 24,575 bytes, 16 types of 255 one-byte values and the rest in the description. */
function maxTable(fill = () => pick(JSON_OK)) {
  const body = [];
  for (let t = 0; t < 16; t++) {
    body.push(1, 0x41 + t, 255);
    for (let v = 0; v < 255; v++) body.push(1, fill());
  }
  const desc = 24575 - 3 - 1 - body.length;
  return Uint8Array.from([1, desc >> 8, desc & 0xff, ...Array.from({ length: desc }, fill), 16, ...body]);
}
function mutateTable(t) {
  const b = Array.from(t);
  const op = int(5);
  if (op === 0 && b.length) b[int(b.length)] = int(256);
  else if (op === 1) b.push(int(256));
  else if (op === 2 && b.length) b.pop();
  else if (op === 3 && b.length > 3) b[3 + int(b.length - 3)] = pick([0, 0x22, 0x5c, 0x7f, 0x80, 0x1f]);
  else b.splice(int(b.length + 1), 0, ...randBytes(1 + int(3)));
  return Uint8Array.from(b);
}
const TABLES = [];
{
  const add = (u8) => TABLES.push(hex(u8));
  add(maxTable());
  add(Uint8Array.from([1, 0x5f, 0xfb, ...text(24571, JSON_OK), 0])); // 24,575 bytes, no types
  add(Uint8Array.from([1, 0x5f, 0xfc, ...text(24572, JSON_OK), 0])); // 24,576 bytes: one over the limit
  add(table({ desc: 1000, types: 16, values: () => 20, valueLen: () => 30 }));
  add(table({ desc: 0, types: 16, values: () => 255, valueLen: () => 1, nameLen: () => 1 }));
  add(table({ desc: 50, types: 17 })); // 17 types
  for (let i = 0; i < 16; i++) add(table({ desc: int(200), types: int(17), values: () => 1 + int(30), valueLen: () => 1 + int(40) }));
  add(mutateTable(toU8(TABLES[0])));
  for (let i = 0; i < 10; i++) add(mutateTable(toU8(TABLES[6 + int(16)])));
  for (let i = 0; i < 6; i++) add(table({ desc: int(120), types: 1 + int(16), bad: 0.5 }));
}
for (const t of TABLES) POOLABLE.add(t);
function anyTable() {
  if (chance(0.45)) return pick(TABLES);
  const small = table({ desc: int(30), types: int(5), values: () => 1 + int(3), valueLen: () => 1 + int(5), nameLen: () => 1 + int(5), bad: 0.15 });
  if (chance(0.2)) return hex(randBytes(int(40)));
  if (chance(0.25)) return hex(mutateTable(small));
  return hex(small);
}

// ------------------------------------------------------------------------------------------------ add-on params
const A = L.AddOnId;
const abi = (types, values) => V.encodeAbiParameters(types.map((type) => ({ type })), values);
/** Strings for the placeholders add-on: valid ones and the edges, from a fixed set (they go to the pool). */
const LONG = {
  desc1024: text(1024, JSON_OK),
  desc1025: text(1025, JSON_OK),
  descBad: text(700, JSON_OK, 1, JSON_BAD),
  svg4096: text(4096, SVG_OK),
  svg4097: text(4097, SVG_OK),
  svgBad: text(300, SVG_OK, 1, SVG_BAD),
  svgQuote: Uint8Array.from([...enc('<svg xmlns="http://www.w3.org/2000/svg">\\'), ...text(40, SVG_OK), ...enc('</svg>')]),
};
const PLACEHOLDER_SETS = [];
{
  const P = (name, sym, d1, d2, svg) => PLACEHOLDER_SETS.push(abi(['bytes', 'bytes', 'bytes', 'bytes', 'bytes'], [name, sym, d1, d2, svg].map(hex)));
  const small = () => [text(1 + int(32), JSON_OK), text(1 + int(11), JSON_OK), text(int(80), JSON_OK), text(int(80), JSON_OK), text(1 + int(120), SVG_OK)];
  // 0-9: valid, short texts; 10-13: valid with one text at its limit.
  for (let i = 0; i < 10; i++) P(...small());
  P(text(32, JSON_OK), text(11, JSON_OK), LONG.desc1024, text(10, JSON_OK), text(40, SVG_OK));
  P(text(1, JSON_OK), text(1, JSON_OK), text(0, JSON_OK), LONG.desc1024, text(40, SVG_OK));
  P(text(5, JSON_OK), text(3, JSON_OK), text(20, JSON_OK), text(20, JSON_OK), LONG.svg4096);
  P(text(5, JSON_OK), text(3, JSON_OK), text(20, JSON_OK), text(20, JSON_OK), LONG.svgQuote);
  // 14-27: one text out of its rule (length or a byte).
  const bad = [
    (x) => { x[0] = text(33, JSON_OK); }, (x) => { x[0] = new Uint8Array(0); }, (x) => { x[0] = text(9, JSON_OK, 1, JSON_BAD); },
    (x) => { x[1] = text(12, JSON_OK); }, (x) => { x[1] = new Uint8Array(0); }, (x) => { x[1] = text(4, JSON_OK, 1, JSON_BAD); },
    (x) => { x[2] = LONG.desc1025; }, (x) => { x[2] = text(30, JSON_OK, 1, JSON_BAD); }, (x) => { x[3] = text(30, JSON_OK, 1, JSON_BAD); },
    (x) => { x[3] = LONG.descBad; }, (x) => { x[4] = new Uint8Array(0); }, (x) => { x[4] = LONG.svg4097; },
    (x) => { x[4] = text(60, SVG_OK, 1, SVG_BAD); }, (x) => { x[4] = LONG.svgBad; },
  ];
  for (const f of bad) {
    const x = small();
    f(x);
    P(...x);
  }
}
for (const p of PLACEHOLDER_SETS) POOLABLE.add(p);
for (const u8 of Object.values(LONG)) POOLABLE.add(hex(u8));
function link() {
  const k = int(8);
  if (k === 0) return new Uint8Array(0);
  if (k === 1) return Uint8Array.from([...enc('https://'), ...text(120, URL_OK)]); // 128 bytes
  if (k === 2) return Uint8Array.from([...enc('https://'), ...text(121, URL_OK)]); // 129 bytes
  if (k === 3) return Uint8Array.from([...enc('http://'), ...text(10, URL_OK)]);
  if (k === 4) return enc('https:/');
  if (k === 5) return Uint8Array.from([...enc('https://'), ...text(20, URL_OK, 1, URL_BAD)]);
  return Uint8Array.from([...enc('https://'), ...text(int(40), URL_OK)]);
}
/** Canonical params, then sometimes made non-canonical (a byte appended or dropped, padding or a high byte set, an offset moved). */
function noncanonical(h) {
  if (!chance(0.18)) return h;
  const b = Array.from(toU8(h));
  const op = int(5);
  if (op === 0) b.push(0);
  else if (op === 1 && b.length) b.pop();
  else if (op === 2 && b.length) b[b.length - 1] ^= 1; // last byte: string padding or a static word's low byte
  else if (op === 3 && b.length >= 32) b[0] ^= 0x80; // a head word's high byte
  else if (b.length >= 32) b[31] = (b[31] + 32) & 0xff; // the first head word moved by 32
  return hex(Uint8Array.from(b));
}
function params(id, spec) {
  switch (id) {
    case A.Placeholders: {
      const set = pick(PLACEHOLDER_SETS);
      return toU8(set).length <= INLINE_MAX ? noncanonical(set) : set;
    }
    case A.PerItemStream:
      return chance(0.9) ? '0x' : hex(randBytes(1 + int(40)));
    case A.EditionSpecials: {
      const label = text(lenNear(1, 32), JSON_OK, 0.15, JSON_BAD);
      const count = pick([0, 1, 12, Math.max(1, spec.n), spec.n + 1, int(10001), 4294967295]);
      return noncanonical(abi(['bytes', 'uint32'], [hex(label), count]));
    }
    case A.Royalties:
      return noncanonical(abi(['uint16', 'uint8'], [pick([0, 100, 250, 500, 1, 499, 10000, 65535]), pick([0, 1, 2, 3, 4, 255])]));
    case A.CreatorFeeCap: {
      const caps = [10n ** 18n, 4n * 10n ** 18n, 8n * 10n ** 18n, 16n * 10n ** 18n, 32n * 10n ** 18n, 10n ** 17n, 3n * 10n ** 18n, 0n, big(80)];
      return noncanonical(abi(['uint256', 'uint8'], [pick(caps), pick([0, 1, 2, 3, 4])]));
    }
    case A.CollectionMetadata: {
      const n = pick([0, 0, 1, 2, 4, 5]);
      const teasers = Array.from({ length: n }, () => (chance(0.1) ? ZERO32 : randWord()));
      return noncanonical(abi(['bytes32', 'bytes32[]', 'bytes'], [chance(0.2) ? ZERO32 : randWord(), teasers, hex(link())]));
    }
    default:
      return hex(randBytes(int(80)));
  }
}
function addOnList(spec) {
  const count = pick([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  let ids = Array.from({ length: count }, () => (chance(0.9) ? 1 + int(6) : pick([0, 7, 8, 100, 65535])));
  if (chance(0.75)) ids.sort((x, y) => x - y);
  return ids.map((id) => ({ id, params: params(id, spec) }));
}
/** A list that satisfies the per-add-on checks of `spec` where it can: the ids in order, each with valid params. */
function validAddOns(spec) {
  const out = [];
  const hidden = spec.artMode === L.ArtMode.HIDDEN;
  if (hidden) out.push({ id: A.Placeholders, params: pick(PLACEHOLDER_SETS.slice(0, 14)) });
  if (spec.tStream === L.TStream.PER_ITEM_STREAM) out.push({ id: A.PerItemStream, params: '0x' });
  const specials = spec.boxType === L.BoxType.NEW_COLLECTION ? int(3) : 0;
  for (let i = 0; i < specials; i++) {
    out.push({ id: A.EditionSpecials, params: abi(['bytes', 'uint32'], [hex(text(1 + int(32), JSON_OK)), 1 + int(Math.max(1, spec.n))]) });
  }
  if (spec.boxType === L.BoxType.NEW_COLLECTION && chance(0.6)) {
    const dest = spec.version === 1 ? pick([1, 3]) : pick([1, 2, 3]);
    out.push({ id: A.Royalties, params: abi(['uint16', 'uint8'], [pick([0, 100, 250, 500]), dest]) });
  }
  if (spec.version === 2 && chance(0.4)) {
    out.push({ id: A.CreatorFeeCap, params: abi(['uint256', 'uint8'], [pick([10n ** 18n, 4n * 10n ** 18n, 32n * 10n ** 18n]), pick([2, 3])]) });
  }
  if (spec.boxType === L.BoxType.NEW_COLLECTION && chance(0.5)) {
    const teasers = Array.from({ length: int(5) }, () => randWord());
    const lk = chance(0.5) ? new Uint8Array(0) : Uint8Array.from([...enc('https://'), ...text(int(60), URL_OK)]);
    out.push({ id: A.CollectionMetadata, params: abi(['bytes32', 'bytes32[]', 'bytes'], [randWord(), teasers, hex(lk)]) });
  }
  return out.slice(0, 8);
}

// ------------------------------------------------------------------------------------------------ field values
function edgeValue(field) {
  switch (field) {
    case 'version': return pick([0, 1, 2, 3, 255, 256, 65535]);
    case 'boxType': return pick([0, 1, 2, 3, 4, 255]);
    case 'tokenName': case 'collectionName': return hex(text(lenNear(1, 32), JSON_OK, 0.3));
    case 'tokenSymbol': case 'collectionSymbol': return hex(text(lenNear(1, 11), JSON_OK, 0.3));
    case 'description': return chance(0.3) ? hex(pick([LONG.desc1024, LONG.desc1025, LONG.descBad])) : hex(text(lenNear(0, 60), JSON_OK, 0.3));
    case 'n': return pick([0, 1, 9, 10, 11, 69, 1969, 4269, 9999, 10000, 10001, 4294967295, int(20001)]);
    case 'firstId': return pick([0n, 1n, 2n, (1n << 256n) - 1n]);
    case 'q': return pick([ZERO, ERC20_18, ERC20_6, FIT, BOXT, randAddress()]);
    case 'raise': return pick([R, R - 1n, R + 1n, 0n, 10n ** 18n, 42n * 10n ** 17n, 10n ** 19n, R / 10n, 2500n * 10n ** 18n, 2500000000n, 10n ** 24n, big(70)]);
    case 'layout': return pick([0, 1, 2, 255]);
    case 'gradLayout': return pick([0, 1, 2, 3, 255]);
    case 'launchFormat': return pick([0, 1, 2, 255]);
    case 'openAt': return pick([0, 1, MIN_OPEN_AT - 1, MIN_OPEN_AT, MIN_OPEN_AT + 1, 4294967295, MIN_OPEN_AT + int(1e8)]);
    case 'deadlineDays': return pick([0, 1, 29, 30, 31, 45, 60, 90, 180, 181, 365, 65535]);
    case 'qStream': case 'tStream': return chance(0.9) ? int(9) : 255;
    case 'artMode': return pick([0, 1, 2, 3, 255]);
    case 'revealRoot': case 'generatorHash': case 'coverSha256': case 'revealListId': case 'collectionCoverSha256':
      return chance(0.4) ? ZERO32 : randWord();
    case 'metadataTable': return chance(0.1) ? '0x' : anyTable();
    case 'marketplaceOwner': return pick([ZERO, SAFE, randAddress()]);
    case 'creatorFeeRecipient': return pick([ZERO, ZERO, randAddress()]);
    case 'creatorBuy': return pick([0n, 0n, 1n, R - 1n, R, R + 1n, big(64)]);
    default: throw new Error(field);
  }
}
function validValue(field, spec) {
  switch (field) {
    case 'tokenName': case 'collectionName': return hex(text(1 + int(32), JSON_OK));
    case 'tokenSymbol': case 'collectionSymbol': return hex(text(1 + int(11), JSON_OK));
    case 'description': return chance(0.1) ? hex(LONG.desc1024) : hex(text(int(80), JSON_OK));
    case 'n': return pick([10, 69, 1969, 4269, 10000, 10 + int(9991)]);
    case 'openAt': return pick([0, MIN_OPEN_AT, MIN_OPEN_AT + int(2 ** 31 - MIN_OPEN_AT)]);
    case 'revealRoot': case 'generatorHash': case 'coverSha256': case 'collectionCoverSha256': return randWord();
    case 'metadataTable': return pick(TABLES.slice(0, 2).concat(TABLES.slice(3, 5), TABLES.slice(6, 22)));
    case 'marketplaceOwner': return chance(0.5) ? SAFE : randAddress();
    default: return edgeValue(field, spec);
  }
}
const SCALARS = FIELDS.filter((f) => f !== 'addOns');
const VALID_FIELDS = ['tokenName', 'tokenSymbol', 'collectionName', 'collectionSymbol', 'description', 'n', 'openAt', 'revealRoot', 'generatorHash', 'coverSha256', 'collectionCoverSha256', 'metadataTable', 'marketplaceOwner'];

// ------------------------------------------------------------------------------------------------ spec vectors
const clone = (s) => ({ ...s, addOns: s.addOns.map((a) => ({ ...a })) });
const vectors = [];
const stats = { ok: 0, refused: 0, byReason: {}, byFamily: {} };
function record(family, base, ctx, spec, muts) {
  const v = L.validateBoxSpecV1Bytes(spec, CTXS[ctx]);
  const h = V.keccak256(L.encodeBoxSpecV1Bytes(spec));
  if (muts.length > 255) throw new Error('too many mutations');
  const bytes = [base, ctx, v.reason >> 8, v.reason & 0xff, v.field >> 8, v.field & 0xff, ...toU8(h), muts.length];
  for (const m of muts) bytes.push(...m);
  vectors.push(Uint8Array.from(bytes));
  if (v.reason === 0) stats.ok++;
  else stats.refused++;
  stats.byReason[v.reason] = (stats.byReason[v.reason] ?? 0) + 1;
  stats.byFamily[family] = (stats.byFamily[family] ?? 0) + 1;
  stats.bytesByFamily = stats.bytesByFamily ?? {};
  stats.bytesByFamily[family] = (stats.bytesByFamily[family] ?? 0) + bytes.length;
}
const ctxOf = (spec) => (spec.version === 1 ? pick([0, 0, 0, 3, 4, 5]) : pick([1, 1, 2, 2, 4, 6]));
/** A rehearsal context (5, 6) lists the 1/10 raise: most of its vectors carry it (the rest test R refused there). */
function rehearsalRaise(spec, muts, ctx) {
  if ((ctx === 5 || ctx === 6) && chance(0.8)) muts.push(mut(spec, 'raise', R / 10n));
  return ctx;
}

// Family A: valid bases with valid changes (and its add-ons rebuilt to fit).
for (let i = 0; i < 700; i++) {
  const base = int(4);
  const spec = clone(BASES[base]);
  const muts = [];
  const changes = 1 + int(4);
  for (let c = 0; c < changes; c++) {
    const f = pick(VALID_FIELDS);
    if (spec.boxType === L.BoxType.TOKEN_ONLY && ['collectionName', 'collectionSymbol', 'n', 'revealRoot', 'metadataTable', 'generatorHash', 'marketplaceOwner', 'collectionCoverSha256'].includes(f)) continue;
    muts.push(mut(spec, f, validValue(f, spec)));
  }
  if (chance(0.5)) muts.push(addOnsMut(spec, validAddOns(spec)));
  record('A valid changes', base, rehearsalRaise(spec, muts, ctxOf(spec)), spec, muts);
}
// Family B: edge values, one to three fields.
for (let i = 0; i < 1300; i++) {
  const base = int(4);
  const spec = clone(BASES[base]);
  const muts = [];
  const changes = 1 + int(3);
  for (let c = 0; c < changes; c++) {
    const f = pick(SCALARS);
    muts.push(mut(spec, f, edgeValue(f, spec)));
  }
  record('B edge values', base, rehearsalRaise(spec, muts, chance(0.5) ? ctxOf(spec) : int(CTXS.length)), spec, muts);
}
// Family C: add-on lists (order, repeats, unknown ids, params canonical or not).
for (let i = 0; i < 450; i++) {
  const base = int(4);
  const spec = clone(BASES[base]);
  const muts = [];
  if (chance(0.3)) {
    const f = pick(['version', 'boxType', 'artMode', 'tStream', 'qStream', 'n']);
    muts.push(mut(spec, f, edgeValue(f, spec)));
  }
  muts.push(addOnsMut(spec, chance(0.25) ? validAddOns(spec) : addOnList(spec)));
  record('C add-ons', base, rehearsalRaise(spec, muts, ctxOf(spec)), spec, muts);
}
// Family D: metadata tables on the collection bases.
for (let i = 0; i < 250; i++) {
  const base = int(3);
  const spec = clone(BASES[base]);
  const muts = [mut(spec, 'metadataTable', anyTable())];
  record('D tables', base, rehearsalRaise(spec, muts, ctxOf(spec)), spec, muts);
}
// Family E: Q, raise, streams and rules under the 5-Q test context and the duplicate context.
for (let i = 0; i < 200; i++) {
  const base = 1 + int(3);
  const spec = clone(BASES[base]);
  const muts = [];
  const qPick = pick([[ZERO, R], [ZERO, 10n ** 18n], [ERC20_6, 2500000000n], [ERC20_18, 10n ** 22n], [FIT, 10n ** 24n], [BOXT, 10n ** 25n], [FIT, 2n * 10n ** 24n], [randAddress(), R]]);
  muts.push(mut(spec, 'q', qPick[0]));
  muts.push(mut(spec, 'raise', qPick[1]));
  muts.push(mut(spec, 'qStream', 1 + int(7)));
  muts.push(mut(spec, 'tStream', 1 + int(7)));
  if (chance(0.5)) muts.push(mut(spec, 'creatorFeeRecipient', chance(0.6) ? randAddress() : ZERO));
  if (chance(0.3)) muts.push(mut(spec, 'creatorBuy', pick([0n, 1n, qPick[1] - 1n, qPick[1]])));
  if (chance(0.3)) muts.push(mut(spec, 'deadlineDays', pick([0, 30, 60, 90, 180])));
  record('E Q and rules', base, pick([2, 2, 4, 1]), spec, muts);
}
// Family F: the rules on every base, both versions: deadlines, creator options, payees, creator buys, art modes.
for (let i = 0; i < 300; i++) {
  const base = int(4);
  const spec = clone(BASES[base]);
  const muts = [];
  if (chance(0.4)) muts.push(mut(spec, 'version', pick([1, 2])));
  if (chance(0.5)) muts.push(mut(spec, 'deadlineDays', pick([0, 30, 60, 90, 180])));
  if (chance(0.5)) muts.push(mut(spec, 'qStream', pick([1, 2, 3, 5, 6])));
  if (chance(0.5)) muts.push(mut(spec, 'tStream', pick([1, 3, 4, 5, 6])));
  if (chance(0.4)) muts.push(mut(spec, 'creatorFeeRecipient', chance(0.5) ? randAddress() : ZERO));
  if (chance(0.3)) muts.push(mut(spec, 'creatorBuy', pick([0n, 1n, R - 1n, R])));
  if (chance(0.3)) muts.push(mut(spec, 'artMode', pick([1, 2])));
  if (chance(0.3)) muts.push(mut(spec, 'revealListId', chance(0.5) ? ZERO32 : randWord()));
  if (chance(0.3)) muts.push(addOnsMut(spec, validAddOns(spec)));
  record('F rules', base, rehearsalRaise(spec, muts, ctxOf(spec)), spec, muts);
}

// ------------------------------------------------------------------------------------------------ encoded (dirty) vectors
const encodedVectors = [];
{
  const base0 = L.encodeBoxSpecV1Bytes(BASES[0]);
  const head = (field) => 32 + 32 * FIELDS.indexOf(field);
  const cases = [
    ['q', 0, 0x01], ['q', 11, 0x01], ['marketplaceOwner', 0, 0xff], ['marketplaceOwner', 11, 0x80],
    ['creatorFeeRecipient', 0, 0x01], ['creatorFeeRecipient', 11, 0x01],
    ['openAt', 27, 0x01], ['openAt', 0, 0x01], ['n', 27, 0x01], ['n', 0, 0x80],
    ['version', 29, 0x01], ['boxType', 30, 0x01], ['layout', 30, 0x01], ['gradLayout', 0, 0x01], ['launchFormat', 30, 0x02],
    ['deadlineDays', 29, 0x01], ['qStream', 30, 0x01], ['tStream', 30, 0x01], ['artMode', 30, 0x01],
  ];
  for (const [field, at, value] of cases) {
    const b = toU8(base0).slice();
    const offset = head(field) + at;
    b[offset] = value;
    const h = hex(b);
    let tsKind = 0, reason = 0, fieldId = 0, hashKind = 0, hash = ZERO32;
    try {
      const v = L.validateEncodedBoxSpecV1(h, CTXS[0]);
      reason = v.reason;
      fieldId = v.field;
    } catch {
      tsKind = 1;
    }
    try {
      hash = L.specHashOfEncoded(h);
    } catch {
      hashKind = 1;
    }
    encodedVectors.push(Uint8Array.from([0, tsKind, reason >> 8, reason & 0xff, fieldId >> 8, fieldId & 0xff, hashKind, ...toU8(hash), 1, offset >> 8, offset & 0xff, value]));
  }
}

// ------------------------------------------------------------------------------------------------ build vectors
// The creator-fee cap's presets are build values in Solidity (BoxBuildV1.CREATOR_FEE_CAP_PRESET_*, scaled 1/10 in the
// rehearsal build) and constants in the twin (checkCreatorFeeCap): the token-only demo (add-on 5, excess BURN) at the
// rehearsal raise under the rehearsal v2 context (contextForBuild), with each of the ten presets of both builds.
const buildVectors = [];
{
  const caps = [...['CREATOR_FEE_CAP_PRESET_0', 'CREATOR_FEE_CAP_PRESET_1', 'CREATOR_FEE_CAP_PRESET_2', 'CREATOR_FEE_CAP_PRESET_3', 'CREATOR_FEE_CAP_PRESET_4'].map((k) => PROF.BUILD_PROFILE_MAINNET.values[k]),
    ...['CREATOR_FEE_CAP_PRESET_0', 'CREATOR_FEE_CAP_PRESET_1', 'CREATOR_FEE_CAP_PRESET_2', 'CREATOR_FEE_CAP_PRESET_3', 'CREATOR_FEE_CAP_PRESET_4'].map((k) => PROF.BUILD_PROFILE_REHEARSAL.values[k])];
  for (const cap of caps) {
    const spec = clone(BASES[3]);
    spec.raise = R / 10n;
    spec.creatorBuy = 0n;
    spec.addOns = [{ id: A.CreatorFeeCap, params: abi(['uint256', 'uint8'], [cap, 2]) }];
    const v = L.validateBoxSpecV1Bytes(spec, CTXS[6]);
    buildVectors.push(Uint8Array.from([...toU8(V.numberToHex(cap, { size: 32 })), v.reason >> 8, v.reason & 0xff, v.field >> 8, v.field & 0xff]));
  }
}

// ------------------------------------------------------------------------------------------------ network vectors
// The twin's per-network lists (F74 U1; OFFERED_ON, NOT_BUILT): box 0's fixture under version 1's context on each
// network, in the order mainnet, sepolia, demo: reason u16, field u16.
const networkVectors = [];
for (const network of ['mainnet', 'sepolia', 'demo']) {
  const v = L.validateBoxSpecV1Bytes(BASES[0], CTXS[0], network);
  networkVectors.push(Uint8Array.from([v.reason >> 8, v.reason & 0xff, v.field >> 8, v.field & 0xff]));
}

// ------------------------------------------------------------------------------------------------ layout vectors
const layoutVectors = [];
const lstats = { ok: 0, err: {} };
{
  const ERR = { RaiseIsZero: 1, CentreOutOfRange: 2, CurveOutOfRange: 3, NoExactLiquidity: 4, CurveTooLarge: 5 };
  const errCode = (e) => {
    const m = /^(\w+)/.exec(e.message)?.[1];
    return ERR[m] ?? 6;
  };
  const gradHash = (g) => {
    if (g.qDust < 0n || g.tDust < 0n) return [2, ZERO32];
    return [0, V.keccak256(abi(['int24', 'int24', 'uint128', 'uint256', 'int24', 'int24', 'uint128', 'uint256', 'int24', 'int24', 'uint128', 'uint256', 'uint256', 'uint256'],
      [g.bid.tickLower, g.bid.tickUpper, g.bid.liquidity, g.bid.amount, g.sentinel.tickLower, g.sentinel.tickUpper, g.sentinel.liquidity, g.sentinel.amount, g.ask.tickLower, g.ask.tickUpper, g.ask.liquidity, g.ask.amount, g.qDust, g.tDust]))];
  };
  const word32 = (v) => toU8(V.numberToHex(v, { size: 32 }));
  const raises = [R, R / 10n, 1n, 2n, 10n ** 6n, 2500000000n, 10n ** 15n, 10n ** 18n, 10n ** 24n, 10n ** 26n, 8n * 10n ** 26n, 10n ** 27n, 10n ** 30n, 10n ** 40n, (1n << 256n) - 1n, 0n];
  for (let i = 0; i < 420; i++) {
    let raise;
    if (i < raises.length * 2) raise = raises[i >> 1];
    else {
      // Log-uniform over the digit count (1 to 30 digits), every digit random.
      raise = 0n;
      for (let d = 1 + int(30); d > 0; d--) raise = raise * 10n + BigInt(int(10));
      if (raise === 0n) raise = 1n;
    }
    const tIsC0 = i < raises.length * 2 ? (i & 1) === 1 : chance(0.5);
    let c;
    let status = 0;
    try {
      c = LAY.boxCurve(raise, tIsC0);
    } catch (e) {
      status = errCode(e);
    }
    const bytes = [...word32(raise), tIsC0 ? 1 : 0, status];
    if (status === 0) {
      lstats.ok++;
      const qHeld = pick([raise, raise, raise - 1n, raise + 1n, raise + big(50) % (raise + 1n), raise / 2n, 0n, 1n]);
      const tAvail = pick([c.poolShare, c.poolShare, c.poolShare + big(60) % (c.curveT + 1n), 0n, 1n, c.poolShare / 3n]);
      const out = [];
      for (const layout of [1, 2]) {
        let gs;
        try {
          gs = gradHash(LAY.boxGraduated(c, layout, qHeld, tAvail));
        } catch {
          gs = [1, ZERO32];
        }
        out.push(gs);
      }
      const tl = c.tickLower < 0 ? c.tickLower + (1 << 24) : c.tickLower;
      bytes.push((tl >> 16) & 0xff, (tl >> 8) & 0xff, tl & 0xff, ...toU8(V.numberToHex(c.liquidity, { size: 16 })), ...word32(c.curveT), ...word32(qHeld), ...word32(tAvail));
      for (const [s, h] of out) bytes.push(s, ...toU8(h));
    } else {
      lstats.err[status] = (lstats.err[status] ?? 0) + 1;
    }
    layoutVectors.push(Uint8Array.from(bytes));
  }
}

// ------------------------------------------------------------------------------------------------ encoding vectors
function base32Lower(u8) {
  const ALPHA = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of u8) {
    acc = ((acc << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHA[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHA[(acc << (5 - bits)) & 31];
  return out;
}
const encodingVectors = [];
for (let len = 0; len <= 96; len++) {
  const data = randBytes(len);
  const b64 = enc(Buffer.from(data).toString('base64'));
  const b32 = enc(base32Lower(data));
  encodingVectors.push(Uint8Array.from([len, ...data, b64.length >> 8, b64.length & 0xff, ...b64, b32.length >> 8, b32.length & 0xff, ...b32]));
}
const cidDigests = [
  '0x2aa8e531b2837be0a979b85b772ae4a5f286bbbd19b3d1be36804c146da69c93',
  '0x41cf86fd8bf4bf185534477e35ca01b8183316adc947a92f9c3d8933a90f11fb',
  '0xa8202b6917194146c6d2c9ddb53529dd9f064089d9019d9989dfb722dd921afe',
  ZERO32,
  `0x${'ff'.repeat(32)}`,
  randWord(),
];
const cids = cidDigests.map((d) => `b${base32Lower(Uint8Array.from([0x01, 0x55, 0x12, 0x20, ...toU8(d)]))}`);

// ------------------------------------------------------------------------------------------------ the Solidity file
const concat = (arrs) => {
  const n = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};
const CHUNK = 200;
const specChunks = [];
for (let i = 0; i < vectors.length; i += CHUNK) specChunks.push(concat(vectors.slice(i, i + CHUNK)));
const LCHUNK = 60;
const layoutChunks = [];
for (let i = 0; i < layoutVectors.length; i += LCHUNK) layoutChunks.push(concat(layoutVectors.slice(i, i + LCHUNK)));
const lit = (u8) => `hex"${Buffer.from(u8).toString('hex')}"`;
const sel = (name, items) => {
  const lines = [`    function ${name}(uint256 i) internal pure returns (bytes memory) {`];
  items.forEach((it, i) => lines.push(`        if (i == ${i}) return ${it};`));
  lines.push(`        revert("${name}: index");`, '    }');
  return lines.join('\n');
};
const strLit = (s) => `"${s}"`;
const sol = [
  '// SPDX-License-Identifier: MIT',
  'pragma solidity 0.8.26;',
  '',
  '// GENERATED FILE (SH-AUDIT-B0-U9, Claude), do not edit: AuditU9ClaudeGen.mjs (in this folder; first published as',
  '// appendix A of docs/evidence/SH-AUDIT-B0-U9-C.md) writes it from the TypeScript twin packages/box-spec, offline, with',
  `// the fixed seed 0x53485539. ${vectors.length} spec vectors (${stats.ok} accepted, ${stats.refused} refused), ${encodedVectors.length} encoded`,
  `// vectors, ${layoutVectors.length} layout vectors, ${encodingVectors.length} encoding vectors, ${pool.length} pool blobs.`,
  '',
  '/// @notice TEST ONLY: vectors of the TypeScript twin for AuditU9ClaudeTwin.t.sol (formats in that file).',
  'library AuditU9ClaudeTwinVectors {',
  `    uint256 internal constant SPEC_VECTORS = ${vectors.length};`,
  `    uint256 internal constant SPEC_ACCEPTED = ${stats.ok};`,
  `    uint256 internal constant SPEC_CHUNKS = ${specChunks.length};`,
  `    uint256 internal constant ENCODED_VECTORS = ${encodedVectors.length};`,
  `    uint256 internal constant LAYOUT_VECTORS = ${layoutVectors.length};`,
  `    uint256 internal constant LAYOUT_OK = ${lstats.ok};`,
  `    uint256 internal constant LAYOUT_CHUNKS = ${layoutChunks.length};`,
  `    uint256 internal constant ENCODING_VECTORS = ${encodingVectors.length};`,
  `    uint256 internal constant BASES = ${BASES.length};`,
  `    uint256 internal constant CONTEXTS = ${CTXS.length};`,
  `    uint256 internal constant POOL = ${pool.length};`,
  `    uint256 internal constant CIDS = ${cids.length};`,
  `    uint256 internal constant BUILD_VECTORS = ${buildVectors.length};`,
  '',
  '    /// @notice ABI-encoded BoxSpec fixtures: ' + BASE_NAMES.join('; ') + '.',
  sel('base', BASES.map((b) => lit(toU8(L.encodeBoxSpecV1Bytes(b))))),
  '',
  '    /// @notice ABI-encoded VersionContexts: ' + CTX_NAMES.join('; ') + '.',
  sel('context', CTXS.map((c) => lit(toU8(L.encodeVersionContext(c))))),
  '',
  '    /// @notice Blobs the vectors reference by index (long strings, tables, add-on params).',
  sel('pool', pool.map((h) => lit(toU8(h)))),
  '',
  sel('specChunk', specChunks.map(lit)),
  '',
  '    function encodedVectors() internal pure returns (bytes memory) {',
  `        return ${lit(concat(encodedVectors))};`,
  '    }',
  '',
  sel('layoutChunk', layoutChunks.map(lit)),
  '',
  '    function encodingVectors() internal pure returns (bytes memory) {',
  `        return ${lit(concat(encodingVectors))};`,
  '    }',
  '',
  '    /// @notice Box 0\'s fixture under version 1\'s context on the twin\'s networks mainnet, sepolia, demo: reason u16, field u16.',
  '    function networkVectors() internal pure returns (bytes memory) {',
  `        return ${lit(concat(networkVectors))};`,
  '    }',
  '',
  '    /// @notice Per vector: capPerEpoch (32 bytes), the twin\'s reason (u16) and field (u16).',
  '    function buildVectors() internal pure returns (bytes memory) {',
  `        return ${lit(concat(buildVectors))};`,
  '    }',
  '',
  sel('cidDigest', cidDigests.map((d) => `abi.encodePacked(bytes32(${d}))`)),
  '',
  sel('cid', cids.map((c) => `bytes(${strLit(c)})`)),
  '}',
  '',
];
writeFileSync(OUT, sol.join('\n'));
process.stdout.write(`${JSON.stringify({ out: relative(ROOT, OUT), specVectors: vectors.length, stats, chunks: specChunks.length, encodedVectors: encodedVectors.length, layoutVectors: layoutVectors.length, lstats, encodingVectors: encodingVectors.length, pool: pool.length, bytes: { spec: vectors.reduce((s, v) => s + v.length, 0), pool: pool.reduce((s, h) => s + (h.length - 2) / 2, 0), layout: layoutVectors.reduce((s, v) => s + v.length, 0) } }, null, 1)}\n`);
