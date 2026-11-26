// SH-AUDIT-B0-U9 (Fable 5.1), P9.7 / P9.6: the random-spec and random-raise differential between the Solidity unit
// (BoxSpecV1.validate / specHash, BoxLayoutV1 on the pinned v4 maths) and its TypeScript twin (packages/box-spec).
//
// Run from packages/contracts, offline, Node 24.22.1 (no network, no build, no FFI):
//   node --import ./test/box/audit/U9/gen/AuditU9FableGenRegister.mjs test/box/audit/U9/gen/AuditU9FableGen.mjs
// It writes test/box/audit/U9/AuditU9FableTwinVectors.sol, which AuditU9FableTwin.t.sol replays in forge.
//
// Design: every vector is derived from its index alone. Word k of vector `seed` is keccak256(abi.encode(seed, k)); a
// decision consumes one word, and anything that needs more entropy derives sub-words as keccak256(abi.encode(x, i)).
// The Solidity test rebuilds the same spec and context from the same words (a line-for-line mirror of `buildSpec`
// below), so the generated file holds only what the twin answered: (reason, field, specHash) per spec vector and the
// curve / graduated layouts per raise vector. The twin's answers come from `validateBoxSpecV1Bytes` (the raw-bytes
// validator, what Solidity sees) and `keccak256(encodeBoxSpecV1Bytes(spec))`; a self-check also runs
// `validateEncodedBoxSpecV1` / `specHashOfEncoded` on the encoding to pin that the twin's two entry points agree.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, hexToBytes, keccak256, bytesToHex } from 'viem';
import * as bs from '../../../../../../box-spec/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../AuditU9FableTwinVectors.sol');
const SPEC_COUNT = Number(process.env.U9F_SPEC_COUNT ?? 2400);
const LAYOUT_RANDOM = 76;

const U256 = (1n << 256n) - 1n;
const U32 = (1n << 32n) - 1n;
const R = 4206980085000000000n;
const ZERO32 = `0x${'00'.repeat(32)}`;
const ZERO_ADDR = `0x${'00'.repeat(20)}`;
const SAFE = '0xdCE82e76456434d0f550b492Ff212A862221e6c5';
const MIN_OPEN_AT = 1788220800;
const UINT = { type: 'uint256' };
// The run's report lines go to stdout as in the repository's other scripts (the root lint allows no console.log).
const say = (line) => process.stdout.write(`${line}\n`);

// ------------------------------------------------------------------------------------------------ derivation
/** keccak256(abi.encode(a, b)) as a uint256: the one source of randomness, mirrored in Solidity by `_w`. */
function W(a, b) {
  return BigInt(keccak256(encodeAbiParameters([UINT, UINT], [a, b])));
}
const sub = W;
const mod = (x, m) => Number(x % BigInt(m));
const pick = (list, x) => list[mod(x, list.length)];

/** n bytes: byte j is byte (j % 32) of keccak256(abi.encode(r, j / 32)) (`_bytesOf`). */
function bytesOf(r, n) {
  const out = new Uint8Array(n);
  for (let c = 0; c * 32 < n; c++) {
    const w = hexToBytes(keccak256(encodeAbiParameters([UINT, UINT], [r, BigInt(c)])));
    out.set(w.subarray(0, Math.min(32, n - c * 32)), c * 32);
  }
  return out;
}

const DIRTY = [0x00, 0x09, 0x0a, 0x1f, 0x22, 0x5c, 0x7f, 0x80, 0xc3, 0xa9, 0xff, 0x0d];
const DIRTY_SVG = [0x00, 0x1f, 0x7f, 0x80, 0xff, 0x0a, 0xc3, 0x09];
const URL_CHARS = new TextEncoder().encode("!#$%&'()*+,-./0123456789:;=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]_abcdefghijklmnopqrstuvwxyz~");
const URL_PREFIXES = ['https://', 'https://', 'https://', 'https://', 'https://', 'https://', 'http://', '', 'HTTPS://', 'https:/'];

/** n JSON_TEXT-ish bytes with a `dirtyPct` % chance per byte of a refused byte (`_text`). */
function text(r, n, dirtyPct) {
  const b = bytesOf(r, 2 * n);
  const out = new Uint8Array(n);
  for (let j = 0; j < n; j++) {
    const b0 = b[2 * j];
    const b1 = b[2 * j + 1];
    if (b0 % 100 < dirtyPct) out[j] = DIRTY[b1 % 12];
    else {
      let c = 0x20 + (b1 % 95);
      if (c === 0x22 || c === 0x5c) c = 0x41;
      out[j] = c;
    }
  }
  return out;
}

/** n SVG-rule bytes (0x20-0x7e, quotes and backslashes included) with dirty bytes (`_svgText`). */
function svgText(r, n, dirtyPct) {
  const b = bytesOf(r, 2 * n);
  const out = new Uint8Array(n);
  for (let j = 0; j < n; j++) {
    const b0 = b[2 * j];
    const b1 = b[2 * j + 1];
    out[j] = b0 % 100 < dirtyPct ? DIRTY_SVG[b1 % 8] : 0x20 + (b1 % 95);
  }
  return out;
}

/** n URL-rule bytes behind a prefix variant chosen by bits 200.. of r (`_url`). */
function url(r, n, dirtyPct) {
  const prefix = new TextEncoder().encode(URL_PREFIXES[mod(r >> 200n, 10)]);
  const out = new Uint8Array(n);
  let start = 0;
  if (n >= prefix.length) {
    out.set(prefix, 0);
    start = prefix.length;
  }
  const b = bytesOf(r, 2 * n);
  for (let j = start; j < n; j++) {
    const b0 = b[2 * j];
    const b1 = b[2 * j + 1];
    out[j] = b0 % 100 < dirtyPct ? DIRTY[b1 % 12] : URL_CHARS[b1 % 85];
  }
  return out;
}

const hex = (u8) => bytesToHex(u8);
const hex32 = (v) => `0x${(v & U256).toString(16).padStart(64, '0')}`;
const addr = (v) => `0x${(v & ((1n << 160n) - 1n)).toString(16).padStart(40, '0')}`;
const concatU8 = (parts) => {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

// ------------------------------------------------------------------------------------------------ tables
/** A metadata table from word x: edge shapes, structured tables (some malformed), the maximal sizes (`_table`). */
function table(x) {
  const v = mod(x, 16);
  if (v === 0) return new Uint8Array(0);
  if (v === 1) return Uint8Array.of(1);
  if (v === 2) return Uint8Array.of(1, 0, 0, 0);
  if (v === 3) return Uint8Array.of(0, 0, 0, 0);
  if (v === 12 || v === 13) {
    // 24,575 bytes (the maximum) or 24,576 (one over): version, a description of 'A's, no type.
    const len = v === 12 ? 24_575 : 24_576;
    const t = new Uint8Array(len);
    const d = len - 4;
    t[0] = 1;
    t[1] = d >> 8;
    t[2] = d & 0xff;
    t.fill(0x41, 3, 3 + d);
    t[len - 1] = 0;
    return t;
  }
  if (v === 14) {
    const parts = [1, 0, 0, 16];
    for (let i = 0; i < 16; i++) parts.push(1, 0x41 + i, 1, 1, 0x61 + i);
    return Uint8Array.from(parts);
  }
  if (v === 15) return Uint8Array.of(1, 0xff, 0xff, 0x41, 0x41);
  // 4..11: structured, with occasional zero lengths, a 2 % dirty byte rate and a final mutation.
  const descLen = pick([0, 1, 40, 200, 1000, 3000], x >> 8n);
  const types = mod(x >> 16n, 18);
  const parts = [Uint8Array.of(1, descLen >> 8, descLen & 0xff), text(sub(x, 1n), descLen, 2), Uint8Array.of(types)];
  for (let i = 0; i < types; i++) {
    const ri = sub(x, 100n + BigInt(i));
    const nameLen = mod(ri >> 8n, 20) === 0 ? 0 : 1 + mod(ri, 30);
    const values = mod(ri >> 24n, 25) === 0 ? 0 : 1 + mod(ri >> 16n, 8);
    parts.push(Uint8Array.of(nameLen), text(sub(ri, 1n), nameLen, 2), Uint8Array.of(values));
    for (let k = 0; k < values; k++) {
      const rv = sub(ri, 10n + BigInt(k));
      const valueLen = mod(rv >> 8n, 25) === 0 ? 0 : 1 + mod(rv, 40);
      parts.push(Uint8Array.of(valueLen), text(sub(rv, 1n), valueLen, 2));
    }
  }
  let t = concatU8(parts);
  const m = mod(x >> 24n, 8);
  if (m === 5 && t.length > 0) t[mod(x >> 32n, t.length)] = Number((x >> 40n) & 0xffn);
  else if (m === 6 && t.length > 0) t = t.subarray(0, t.length - 1);
  else if (m === 7) t = concatU8([t, Uint8Array.of(Number((x >> 32n) & 0xffn))]);
  return t;
}

// ------------------------------------------------------------------------------------------------ add-ons
const LEN_A = [1, 1, 5, 18, 32, 33, 0, 64];
const LEN_B = [1, 3, 8, 11, 12, 0, 32, 5];
const LEN_C = [0, 0, 10, 100, 1024, 1025, 2000, 1];
const LEN_D = [1, 1, 243, 1000, 4096, 4097, 0, 100];
const LEN_URL = [0, 0, 20, 128, 129, 8, 7, 60];
const IDS = [1, 2, 3, 4, 5, 6, 3, 3, 0, 7, 300, 65535];
const enc = (types, values) => hexToBytes(encodeAbiParameters(types, values));

/** Canonical params of add-on `id` from word x (`_paramsFor`); unknown ids get random bytes. */
function paramsFor(id, x) {
  if (id === 1) {
    return enc(
      [{ type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }],
      [
        hex(text(sub(x, 1n), pick(LEN_A, x), 5)),
        hex(text(sub(x, 2n), pick(LEN_B, x >> 8n), 5)),
        hex(text(sub(x, 3n), pick(LEN_C, x >> 16n), 3)),
        hex(text(sub(x, 4n), pick(LEN_C, x >> 24n), 3)),
        hex(svgText(sub(x, 5n), pick(LEN_D, x >> 32n), 3)),
      ],
    );
  }
  if (id === 2) return mod(x, 8) === 0 ? Uint8Array.of(0) : new Uint8Array(0);
  if (id === 3) {
    return enc(
      [{ type: 'bytes' }, { type: 'uint32' }],
      [hex(text(sub(x, 1n), pick(LEN_A, x), 5)), pick([1, 1, 10, 100, 4269, 0, 10000, 10001, 4294967295], x >> 8n)],
    );
  }
  if (id === 4) {
    return enc(
      [{ type: 'uint16' }, { type: 'uint8' }],
      [pick([0, 100, 250, 500, 1, 99, 101, 1000, 65535], x), pick([1, 1, 2, 3, 0, 4, 255], x >> 8n)],
    );
  }
  if (id === 5) {
    return enc(
      [{ type: 'uint256' }, { type: 'uint8' }],
      [pick([1n * 10n ** 18n, 4n * 10n ** 18n, 8n * 10n ** 18n, 16n * 10n ** 18n, 32n * 10n ** 18n, 0n, 1n, 2n * 10n ** 18n, U256], x), pick([2, 3, 1, 0, 4, 255], x >> 8n)],
    );
  }
  if (id === 6) {
    const count = pick([0, 0, 1, 4, 5, 2], x >> 8n);
    const teasers = [];
    for (let i = 0; i < count; i++) teasers.push(mod(x >> 16n, 8) === 0 && i === 0 ? ZERO32 : hex32(sub(x, 10n + BigInt(i))));
    return enc(
      [{ type: 'bytes32' }, { type: 'bytes32[]' }, { type: 'bytes' }],
      [mod(x, 4) === 0 ? ZERO32 : hex32(sub(x, 1n)), teasers, hex(url(sub(x, 2n), pick(LEN_URL, x >> 24n), 3))],
    );
  }
  return bytesOf(sub(x, 1n), mod(x >> 8n, 70));
}

/** A mutation of params p from word x (`_mutate`): half the time none. */
function mutate(p, x) {
  const m = mod(x, 12);
  const len = p.length;
  if (m === 6 && len > 0) return p.subarray(0, len - 1);
  if (m === 7) return concatU8([p, Uint8Array.of(Number((x >> 8n) & 0xffn))]);
  if (m === 8 && len > 0) {
    const q = Uint8Array.from(p);
    q[mod(x >> 8n, len)] = Number((x >> 16n) & 0xffn);
    return q;
  }
  if (m === 9 && len >= 32) {
    const q = Uint8Array.from(p);
    q.set(hexToBytes(hex32((x >> 8n) % 300n)), 0);
    return q;
  }
  if (m === 10) return concatU8([new Uint8Array(32), p]);
  if (m === 11) return bytesOf(sub(x, 1n), mod(x >> 8n, 70));
  return p;
}

/** An add-on list from word x (`_addOnList`): 0-9 entries, ids from IDS, params canonical then maybe mutated, sorted
 * by id (a stable insertion sort) three times out of four. */
function addOnList(x) {
  const count = pick([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2], x);
  const list = [];
  for (let i = 0; i < count; i++) {
    const xi = sub(x, 1n + BigInt(i));
    const id = pick(IDS, xi);
    list.push({ id, params: hex(mutate(paramsFor(id, sub(xi, 1n)), sub(xi, 2n))) });
  }
  if (mod(x >> 8n, 4) !== 0) insertionSort(list);
  return list;
}

function insertionSort(list) {
  for (let i = 1; i < list.length; i++) {
    for (let j = i; j > 0 && list[j - 1].id > list[j].id; j--) {
      const t = list[j - 1];
      list[j - 1] = list[j];
      list[j] = t;
    }
  }
}

// ------------------------------------------------------------------------------------------------ contexts
const Q18 = '0x1800000000000000000000000000000000000018';
const Q6 = '0x0600000000000000000000000000000000000006';
const QFIT = '0xf170000000000000000000000000000000000f17';
const QBOX = '0xb0c5000000000000000000000000000000000b0c';
const E18 = 10n ** 18n;
const TEST_CONTEXT = {
  qList: [
    { token: ZERO_ADDR, decimals: 18, qClass: 1, raisePresets: [E18, 42n * 10n ** 17n, R, 10n * E18] },
    { token: Q18, decimals: 18, qClass: 2, raisePresets: [2500n * E18, 10000n * E18, 25000n * E18] },
    { token: Q6, decimals: 6, qClass: 2, raisePresets: [2500000000n, 10000000000n, 25000000000n] },
    { token: QFIT, decimals: 18, qClass: 3, raisePresets: [10n ** 24n, 10n ** 25n, 5n * 10n ** 25n] },
    { token: QBOX, decimals: 18, qClass: 4, raisePresets: [10n ** 24n, 10n ** 25n, 5n * 10n ** 25n] },
  ],
  gradLayouts: [2],
};
const NO_GRAD_CONTEXT = { qList: [{ token: ZERO_ADDR, decimals: 18, qClass: 1, raisePresets: [R] }], gradLayouts: [] };
const GRAD_LISTS = [[2], [1], [], [1, 2], [2, 3], [3]];
const PRESET_POOL = [R, R / 10n, E18, 2500000000n, 0n];

/** A version context from word x (`_context`). */
function context(x) {
  const v = mod(x, 8);
  if (v <= 2) return bs.CONTEXT_V1;
  if (v <= 4) return bs.CONTEXT_V2;
  if (v === 5) return TEST_CONTEXT;
  if (v === 7) return NO_GRAD_CONTEXT;
  const n = 1 + mod(sub(x, 1n), 3);
  const qList = [];
  for (let i = 0; i < n; i++) {
    const xi = sub(x, 10n + BigInt(i));
    const presetCount = mod(xi >> 32n, 4);
    const raisePresets = [];
    for (let j = 0; j < presetCount; j++) raisePresets.push(pick(PRESET_POOL, sub(xi, 20n + BigInt(j))));
    qList.push({
      token: pick([ZERO_ADDR, addr(xi >> 8n), Q18, Q6], xi),
      decimals: mod(xi >> 16n, 19),
      qClass: pick([1, 2, 3, 4, 0, 5], xi >> 24n),
      raisePresets,
    });
  }
  return { qList, gradLayouts: pick(GRAD_LISTS, x >> 8n) };
}

// ------------------------------------------------------------------------------------------------ specs
const BASES = [bs.BOX_0_MISFITS, bs.DEMO_PLACEHOLDERS, bs.DEMO_OPEN_ART, bs.DEMO_TOKEN_ONLY].map((s) => bs.toBoxSpecV1Bytes(s));
const BASE_PICK = [0, 0, 0, 0, 1, 1, 2, 2, 3, 0, 1, 2];
const M_PICK = [0, 1, 1, 1, 1, 2, 2, 2, 3, 4, 6, 10];
const LEN_A2 = [0, 1, 2, 16, 31, 32, 33, 64];
const LEN_B2 = [0, 1, 5, 10, 11, 12, 32, 3];
const LEN_C2 = [0, 1, 100, 1023, 1024, 1025, 2000, 50];
// 36 targets, the rule-reaching ones (streams, recipient, creator buy, deadline, version, art mode, owner) twice.
const TARGETS = [...Array(36).keys(), 16, 17, 25, 26, 15, 0, 18, 24];
const RAISES = [R, R + 1n, R - 1n, 0n, R / 10n, E18, 42n * 10n ** 17n, 10n * E18, 2500n * E18, 10000n * E18, 2500000000n, 10n ** 24n, 10n ** 25n, 5n * 10n ** 25n, null, U256];

/** The spec and context of vector `seed`, mirrored by AuditU9FableTwin's `_buildSpec`. */
function buildSpec(seed) {
  let k = 0n;
  const next = () => W(seed, k++);
  const r = next();
  const m = pick(M_PICK, r);
  const baseIndex = pick(BASE_PICK, r >> 8n);
  const base = BASES[baseIndex];
  const s = { ...base, addOns: base.addOns.map((a) => ({ ...a })) };
  let ctx = baseIndex === 0 ? bs.CONTEXT_V1 : bs.CONTEXT_V2;
  if (mod(r >> 16n, 8) === 0) ctx = context(sub(r, 7n));
  for (let j = 0; j < m; j++) {
    const x = next();
    const t = TARGETS[mod(x, 44)];
    const a = s.addOns;
    const len = a.length;
    const i = len === 0 ? 0 : mod(x >> 8n, len);
    switch (t) {
      case 0: s.version = pick([0, 1, 2, 3, 255, 65535], x); break;
      case 1: s.boxType = pick([0, 1, 2, 3, 4, 255], x); break;
      case 2: s.tokenName = hex(text(sub(x, 1n), pick(LEN_A2, x >> 8n), 10)); break;
      case 3: s.tokenSymbol = hex(text(sub(x, 1n), pick(LEN_B2, x >> 8n), 10)); break;
      case 4: s.collectionName = hex(text(sub(x, 1n), pick(LEN_A2, x >> 8n), 10)); break;
      case 5: s.collectionSymbol = hex(text(sub(x, 1n), pick(LEN_B2, x >> 8n), 10)); break;
      case 6: s.description = hex(text(sub(x, 1n), pick(LEN_C2, x >> 8n), 5)); break;
      case 7: s.n = pick([0, 1, 9, 10, 11, 100, 1969, 4269, 9999, 10000, 10001, 65535, 4294967295, Number((x >> 16n) & U32)], x); break;
      case 8: s.firstId = pick([0n, 1n, 2n, U256, x >> 8n], x); break;
      case 9: s.q = pick([ZERO_ADDR, addr(sub(x, 1n)), Q18, Q6, QFIT, QBOX, '0x0000000000000000000000000000000000000001'], x); break;
      case 10: { const v = pick(RAISES, x); s.raise = v === null ? x >> 8n : v; break; }
      case 11: s.layout = pick([0, 1, 2, 255], x); break;
      case 12: s.gradLayout = pick([0, 1, 2, 3, 255], x); break;
      case 13: s.launchFormat = pick([0, 1, 2, 255], x); break;
      case 14: s.openAt = pick([0, MIN_OPEN_AT - 1, MIN_OPEN_AT, MIN_OPEN_AT + 1, 1791284400, 4294967295, Number((x >> 8n) & U32)], x); break;
      case 15: s.deadlineDays = pick([0, 30, 60, 90, 180, 1, 29, 31, 179, 181, 65535, Number((x >> 8n) & 0xffffn)], x); break;
      case 16: s.qStream = pick([0, 1, 2, 3, 4, 5, 6, 7, 8, 255], x); break;
      case 17: s.tStream = pick([0, 1, 2, 3, 4, 5, 6, 7, 8, 255], x); break;
      case 18: s.artMode = pick([0, 1, 2, 3, 255], x); break;
      case 19: s.revealRoot = mod(x, 2) === 0 ? ZERO32 : hex32(sub(x, 1n)); break;
      case 20: s.metadataTable = hex(table(sub(x, 1n))); break;
      case 21: s.generatorHash = mod(x, 2) === 0 ? ZERO32 : hex32(sub(x, 1n)); break;
      case 22: s.coverSha256 = mod(x, 2) === 0 ? ZERO32 : hex32(sub(x, 1n)); break;
      case 23: s.revealListId = mod(x, 2) === 0 ? ZERO32 : hex32(sub(x, 1n)); break;
      case 24: s.marketplaceOwner = pick([ZERO_ADDR, addr(sub(x, 1n)), SAFE], x); break;
      case 25: s.creatorFeeRecipient = mod(x, 2) === 0 ? ZERO_ADDR : addr(sub(x, 1n)); break;
      case 26: s.creatorBuy = pick([0n, 1n, R - 1n, R, R + 1n, x >> 8n], x); break;
      case 27: s.collectionCoverSha256 = mod(x, 2) === 0 ? ZERO32 : hex32(sub(x, 1n)); break;
      case 28: s.addOns = addOnList(sub(x, 1n)); break;
      case 29: if (len) a[i] = { ...a[i], params: hex(mutate(hexToBytes(a[i].params), sub(x, 1n))) }; break;
      case 30: if (len) a[i] = { ...a[i], params: hex(paramsFor(a[i].id, sub(x, 1n))) }; break;
      case 31: if (len) a.splice(i, 1); break;
      case 32: if (len && len < 12) a.splice(i + 1, 0, { ...a[i] }); break;
      case 33: if (len >= 2) { const j2 = mod(x >> 16n, len); const t2 = a[i]; a[i] = a[j2]; a[j2] = t2; } break;
      case 34: ctx = context(sub(x, 1n)); break;
      case 35: if (len) a[i] = { ...a[i], id: pick(IDS, x >> 16n) }; break;
      default: throw new Error('unreachable');
    }
  }
  return { s, ctx };
}

// ------------------------------------------------------------------------------------------------ layouts
const LAYOUT_FIXED = [
  R, R / 10n, E18, 42n * 10n ** 17n, 10n * E18, 2500n * E18, 10000n * E18, 25000n * E18, 2500000000n, 10000000000n, 25000000000n,
  10n ** 24n, 10n ** 25n, 5n * 10n ** 25n, 10n ** 26n, 3n * 10n ** 26n, 38n * 10n ** 25n, 10n ** 27n, 10n ** 28n, 10n ** 30n, 10n ** 40n,
  1n, 2n, 1000n, 10n ** 6n, 43_368_000n, 43_369_000n, 43_380_000n, 44_000_000n, 10n ** 8n, 10n ** 9n, 10n ** 12n, 10n ** 15n,
  7_777_777_777_777n, 123_456_789_012_345_678_901n, R * 2n, R * 3n, R - 1n, R + 1n, (1n << 128n) - 1n, 1n << 128n, 1n << 160n, 1n << 255n, U256,
];
function layoutRaises() {
  const out = [...LAYOUT_FIXED];
  for (let j = 0; j < LAYOUT_RANDOM; j++) {
    const x = W(0xa11n, BigInt(j));
    const e = 7 + mod(x, 21);
    const mant = BigInt(mod(x >> 64n, 1_000_000) + 1);
    out.push((mant * 10n ** BigInt(e)) / 1_000_000n);
  }
  return out;
}
/** Error code of a thrown layout error (Solidity: `_layoutCode` of the revert data). */
function layoutCode(e) {
  const m = String(e.message ?? e);
  if (m.startsWith('RaiseIsZero')) return 1n;
  if (m.includes('overflow')) return 2n;
  if (m.startsWith('CentreOutOfRange')) return 3n;
  if (m.startsWith('CurveOutOfRange')) return 4n;
  if (m.startsWith('NoExactLiquidity')) return 5n;
  if (m.startsWith('CurveTooLarge')) return 6n;
  if (m.startsWith('InvalidSqrtPrice')) return 8n;
  if (m.startsWith('InvalidTick')) return 9n;
  if (m.startsWith('InvalidPrice')) return 2n;
  throw e;
}
const toInt = (v) => (v < 0 ? (1n << 256n) + BigInt(v) : BigInt(v));
function layoutRecord(raise, tIsC0) {
  const words = new Array(30).fill(0n);
  words[0] = raise;
  words[1] = tIsC0 ? 1n : 0n;
  let c;
  try {
    c = bs.boxCurve(raise, tIsC0);
  } catch (e) {
    words[2] = layoutCode(e);
    return words;
  }
  words[3] = toInt(c.tickLower);
  words[4] = c.liquidity;
  words[5] = c.curveT;
  const cases = [
    [1, raise, c.poolShare],
    [2, raise, c.poolShare],
    [2, raise - raise / 7n, c.poolShare + c.curveT / 5n],
  ];
  for (let i = 0; i < 3; i++) {
    const [layout, qHeld, tAvail] = cases[i];
    let g;
    try {
      g = bs.boxGraduated(c, layout, qHeld, tAvail);
    } catch (e) {
      words[2] = 10n + layoutCode(e);
      for (let w = 3; w < 30; w++) words[w] = 0n;
      return words;
    }
    const o = 6 + 8 * i;
    words[o] = g.bid.liquidity;
    words[o + 1] = g.bid.amount;
    words[o + 2] = g.sentinel.liquidity;
    words[o + 3] = g.sentinel.amount;
    words[o + 4] = g.ask.liquidity;
    words[o + 5] = g.ask.amount;
    words[o + 6] = g.qDust;
    words[o + 7] = g.tDust;
  }
  return words;
}

// ------------------------------------------------------------------------------------------------ main
function main() {
  const t0 = Date.now();
  const records = [];
  const reasons = new Map();
  const reasonFields = new Map();
  let ok = 0;
  let selfCheckFailures = 0;
  const ctxKinds = new Map();
  for (let i = 0; i < SPEC_COUNT; i++) {
    const { s, ctx } = buildSpec(BigInt(i));
    const encoded = bs.encodeBoxSpecV1Bytes(s);
    const v = bs.validateBoxSpecV1Bytes(s, ctx);
    const h = keccak256(encoded);
    // The twin's other entry points on the same bytes must agree (decode -> validate; re-encode -> hash).
    const v2 = bs.validateEncodedBoxSpecV1(encoded, ctx);
    const h2 = bs.specHashOfEncoded(encoded);
    if (v2.reason !== v.reason || v2.field !== v.field || h2 !== h) selfCheckFailures++;
    if (v.reason === 0) ok++;
    reasons.set(v.reason, (reasons.get(v.reason) ?? 0) + 1);
    const rf = `${v.reason}@${v.field}`;
    reasonFields.set(rf, (reasonFields.get(rf) ?? 0) + 1);
    const ck = ctx === bs.CONTEXT_V1 ? 'v1' : ctx === bs.CONTEXT_V2 ? 'v2' : ctx === TEST_CONTEXT ? 'test' : ctx === NO_GRAD_CONTEXT ? 'no-grad' : 'random';
    ctxKinds.set(ck, (ctxKinds.get(ck) ?? 0) + 1);
    records.push(`${v.reason.toString(16).padStart(4, '0')}${v.field.toString(16).padStart(4, '0')}${h.slice(2)}`);
  }
  const raises = layoutRaises();
  const layoutRecords = [];
  let layoutOk = 0;
  const layoutCodes = new Map();
  for (const raise of raises) {
    for (const tIsC0 of [false, true]) {
      const w = layoutRecord(raise, tIsC0);
      if (w[2] === 0n) layoutOk++;
      layoutCodes.set(Number(w[2]), (layoutCodes.get(Number(w[2])) ?? 0) + 1);
      const rec = w.map((v) => v.toString(16).padStart(64, '0')).join('');
      if (rec.length !== 30 * 64 || rec.includes('-')) throw new Error(`layout record ${raise} ${tIsC0} malformed`);
      layoutRecords.push(rec);
    }
  }
  const viemVersion = JSON.parse(readFileSync(resolve(here, '../../../../../../box-spec/node_modules/viem/package.json'), 'utf8')).version;
  const reasonLines = [...reasons.entries()].sort((a, b) => a[0] - b[0]).map(([r, n]) => `${bs.REASON_NAMES[r] ?? r} ${n}`).join(', ');
  const fieldLines = [...reasonFields.entries()].sort().map(([k, n]) => `${k}:${n}`).join(' ');
  const layoutLines = [...layoutCodes.entries()].sort((a, b) => a[0] - b[0]).map(([c, n]) => `code ${c}: ${n}`).join(', ');
  const header = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// GENERATED FILE, do not edit: packages/contracts/test/box/audit/U9/gen/AuditU9FableGen.mjs writes it from the TypeScript
// twin packages/box-spec/src (validateBoxSpecV1Bytes, encodeBoxSpecV1Bytes, boxCurve, boxGraduated) with viem ${viemVersion}
// on Node ${process.version}. SH-AUDIT-B0-U9 (Fable 5.1), P9.6 / P9.7. Regenerate from packages/contracts with
//   node --import ./test/box/audit/U9/gen/AuditU9FableGenRegister.mjs test/box/audit/U9/gen/AuditU9FableGen.mjs
//
// Spec vectors: ${SPEC_COUNT} (${ok} accepted, ${SPEC_COUNT - ok} refused; twin self-check failures ${selfCheckFailures}).
// Contexts: ${[...ctxKinds.entries()].map(([k, n]) => `${k} ${n}`).join(', ')}.
// Reasons: ${reasonLines}.
// (reason@field: count) ${fieldLines}
// Layout vectors: ${layoutRecords.length} (${raises.length} raises x 2 orders; ${layoutOk} laid out; ${layoutLines}).

/// @notice The twin's answers, replayed by AuditU9FableTwin.t.sol against BoxSpecV1 and BoxLayoutV1.
library AuditU9FableTwinVectors {
    uint256 internal constant SPEC_COUNT = ${SPEC_COUNT};
    /// @dev Per spec vector, 36 bytes: reason (uint16) | field (uint16) | specHash (bytes32).
    uint256 internal constant SPEC_RECORD = 36;
    uint256 internal constant LAYOUT_COUNT = ${layoutRecords.length};
    /// @dev Per layout vector, 30 words: raise | tIsCurrency0 | code (0 laid out; 1 RaiseIsZero, 2 overflow, 3
    /// CentreOutOfRange, 4 CurveOutOfRange, 5 NoExactLiquidity, 6 CurveTooLarge; 10 + code from graduated()) | tickLower
    /// (int256) | liquidity | curveT | then 3 x 8 words (B_PRIME and ASK_FULL_BID_SENTINEL at (raise, poolShare),
    /// ASK_FULL_BID_SENTINEL at (raise - raise / 7, poolShare + curveT / 5)): bid L, bid amount, sentinel L, sentinel
    /// amount, ask L, ask amount, qDust, tDust.
    uint256 internal constant LAYOUT_RECORD = 960;

    /// @dev The four base fixtures in wire form (BOX_0_MISFITS, DEMO_PLACEHOLDERS, DEMO_OPEN_ART, DEMO_TOKEN_ONLY).
    function base(uint256 i) internal pure returns (bytes memory) {
${BASES.map((b, i) => `        if (i == ${i}) return hex"${bs.encodeBoxSpecV1Bytes(b).slice(2)}";`).join('\n')}
        revert("no such base");
    }

    function specData() internal pure returns (bytes memory) {
        return hex"${records.join('')}";
    }

    function layoutData() internal pure returns (bytes memory) {
        return hex"${layoutRecords.join('')}";
    }
}
`;
  writeFileSync(OUT, header);
  say(`wrote ${OUT}`);
  say(`spec vectors ${SPEC_COUNT}: accepted ${ok}, refused ${SPEC_COUNT - ok}, self-check failures ${selfCheckFailures}`);
  say(`contexts: ${[...ctxKinds.entries()].map(([k, n]) => `${k} ${n}`).join(', ')}`);
  say(`reasons: ${reasonLines}`);
  say(`reason@field: ${fieldLines}`);
  say(`layout vectors ${layoutRecords.length}: laid out ${layoutOk}; ${layoutLines}`);
  say(`viem ${viemVersion}, node ${process.version}, ${Date.now() - t0} ms`);
  probeDecoderLeniency();
}

/** Observation for the evidence: what the twin's decoder does with bytes Solidity's abi.decode refuses. */
function probeDecoderLeniency() {
  const enc = bs.encodeBoxSpecV1(bs.BOX_0_MISFITS);
  const words = enc.slice(2).match(/.{64}/g);
  const w = (i, v) => { const d = [...words]; d[i] = v; return `0x${d.join('')}`; };
  const report = [];
  // Word 25 is marketplaceOwner (word 0 is the tuple offset): a dirty top byte on an address.
  try {
    const d = bs.decodeBoxSpecV1Bytes(w(25, '01' + words[25].slice(2)));
    report.push(`dirty address word: viem decodes marketplaceOwner=${d.marketplaceOwner}, verdict ${JSON.stringify(bs.validateEncodedBoxSpecV1(w(25, '01' + words[25].slice(2)), bs.CONTEXT_V1))}`);
  } catch (e) { report.push(`dirty address word: viem throws (${String(e.message).split('\n')[0]})`); }
  // Word 2 is boxType (uint8): 0x101.
  try {
    const d = bs.decodeBoxSpecV1Bytes(w(2, '00'.repeat(30) + '0101'));
    report.push(`dirty uint8 word (0x101): viem decodes boxType=${d.boxType}, verdict ${JSON.stringify(bs.validateEncodedBoxSpecV1(w(2, '00'.repeat(30) + '0101'), bs.CONTEXT_V1))}`);
  } catch (e) { report.push(`dirty uint8 word: viem throws (${String(e.message).split('\n')[0]})`); }
  // A non-zero byte in a string's zero padding: the tokenName "FIT" (3 bytes) sits after its length word.
  const nameOff = Number(BigInt(`0x${words[3]}`)) / 32 + 1;
  const padWord = nameOff + 1;
  try {
    const bytes = w(padWord, words[padWord].slice(0, 62) + 'ff');
    const d = bs.decodeBoxSpecV1Bytes(bytes);
    report.push(`non-zero string padding: viem decodes tokenName=${d.tokenName}, verdict ${JSON.stringify(bs.validateEncodedBoxSpecV1(bytes, bs.CONTEXT_V1))}, specHashOfEncoded == keccak(bytes): ${bs.specHashOfEncoded(bytes) === keccak256(bytes)}`);
  } catch (e) { report.push(`non-zero string padding: viem throws (${String(e.message).split('\n')[0]})`); }
  say(`decoder leniency probe:\n  ${report.join('\n  ')}`);
}

main();
