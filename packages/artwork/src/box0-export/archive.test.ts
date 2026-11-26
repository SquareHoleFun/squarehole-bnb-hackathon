/**
 * The escrow archive of box 0's records (AES-256-GCM with node:crypto, a 32-byte key the founder supplies from a file):
 * the public header is bound to the ciphertext, opening it rebuilds the root and test salts never go in. The header
 * records the escrow intent; the key split and its gate are tested in key-split.test.ts and trustees.test.ts.
 */
import { randomBytes } from 'node:crypto';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { encodeBoxMetadataTable } from '../box-commitment';
import type { Hex32 } from '../hash';
import { messageOf, randomTestSet, readR7, readR7Json, testSalt } from '../test-support/box0-export';
import { DEFAULT_ESCROW, ESCROW_MODES, archiveKeyId, openArchive, parseArchiveKey, sealArchive, sealPayload } from './archive';
import { buildBox0Commitment } from './commitment';
import { parseFrozenSet, parseTraitTable } from './inputs';
import { parseRenderHashes } from './renders';

const n = 13;
const set = randomTestSet(n, readR7().types, [3]);
const input = {
  frozenSet: parseFrozenSet(set.frozenSet, n),
  renders: parseRenderHashes(set.renders, n),
  table: parseTraitTable(readR7Json()),
  generator: { tree: set.generatorTree },
};
const commitment = buildBox0Commitment(input, { n });
const key = new Uint8Array(randomBytes(32));

describe('archive key', () => {
  it('takes 32 raw bytes or 64 hex digits (an optional 0x, a trailing newline)', () => {
    expect(parseArchiveKey(key)).toEqual(key);
    const hex = bytesToHex(key);
    expect(parseArchiveKey(new TextEncoder().encode(`${hex}\n`))).toEqual(key);
    expect(parseArchiveKey(new TextEncoder().encode(`0x${hex.toUpperCase()}`))).toEqual(key);
  });

  it('refuses anything else and never repeats the file`s content', () => {
    const passphrase = 'correct horse battery staple and more words';
    const message = messageOf(() => parseArchiveKey(new TextEncoder().encode(passphrase)));
    expect(message).toMatch(/the key file must hold 32 raw bytes or 64 hex digits/);
    expect(message).not.toContain('horse');
    expect(messageOf(() => parseArchiveKey(key.slice(1)))).toMatch(/32 raw bytes or 64 hex digits/);
    expect(messageOf(() => parseArchiveKey(new Uint8Array(32)))).toMatch(/the key must not be one repeated byte/);
  });

  it('names a key by a one-way id, the same for the same key', () => {
    expect(archiveKeyId(key)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(archiveKeyId(new Uint8Array(key))).toBe(archiveKeyId(key));
    expect(archiveKeyId(new Uint8Array(randomBytes(32)))).not.toBe(archiveKeyId(key));
    expect(archiveKeyId(key)).not.toContain(bytesToHex(key).slice(0, 16));
  });

  it.each(['\n', '\r\n', '\t', '\r', '\v', '\f'])('refuses a 32-byte text password ending in whitespace (%j)', (suffix) => {
    const password = 'correct horse battery staple!!!'.slice(0, 32 - suffix.length) + suffix;
    const bytes = new TextEncoder().encode(password);
    expect(bytes.length).toBe(32);
    const message = messageOf(() => parseArchiveKey(bytes));
    expect(message).toMatch(/a passphrase is not a key/);
    expect(message).not.toContain('horse');
  });
});

describe('sealed records', () => {
  const sealed = sealArchive(commitment, key, { escrowIntent: 'floor-only' });

  it('hides every salt and file hash; the header carries the public facts and the explicitly selected escrow mode', () => {
    expect(DEFAULT_ESCROW).toBe('trustees-2-of-3');
    expect(ESCROW_MODES).toEqual(['zama-plus-floor', 'trustees-2-of-3', 'floor-only']);
    for (const r of commitment.records) {
      for (const secret of [r.salt, r.imageSha256, r.avatarSha256, r.modelSha256]) {
        expect(sealed.text).not.toContain(secret.slice(2));
        expect(sealed.text.toLowerCase()).not.toContain(secret.slice(2, 18));
      }
    }
    expect(sealed.header.root).toBe(commitment.root);
    expect(sealed.header.n).toBe('13');
    expect(sealed.header.escrowIntent).toBe('floor-only');
    expect(sealed.header).not.toHaveProperty('escrow');
    expect(sealed.header.generatorTree).toBe(set.generatorTree);
    expect(sealed.header.renderGeneratorTree).toBe(set.generatorTree);
    expect(sealed.header.keyId).toBe(archiveKeyId(key));
    expect(sealed.sha256).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sealArchive(commitment, key, { escrowIntent: 'floor-only' }).header.escrowIntent).toBe('floor-only');
    expect(messageOf(() => sealArchive(commitment, key, { escrowIntent: 'zama' as never }))).toMatch(/the escrow intent must be one of/);
  });

  it('opens with the key and rebuilds the same root from the records', () => {
    const opened = openArchive(sealed.text, key);
    expect(opened.header).toEqual(sealed.header);
    expect(opened.root).toBe(commitment.root);
    expect(opened.records).toHaveLength(n);
    opened.records.forEach((r, i) => {
      const c = commitment.records[i];
      expect(r.salt).toBe(c?.salt);
      expect(r.traitsPacked).toBe(c?.traitsPacked.toString());
      expect(r.attributes).toEqual(c?.attributes);
    });
    expect(opened.table).toBe(`0x${bytesToHex(input.table.bytes)}`);
  });

  it('refuses another key, a changed ciphertext and a changed header', () => {
    expect(messageOf(() => openArchive(sealed.text, new Uint8Array(randomBytes(32))))).toMatch(/this key is not the archive's key/);
    const file = JSON.parse(sealed.text) as { ciphertext: string; header: Record<string, string> };
    const flipped = { ...file, ciphertext: `${file.ciphertext.startsWith('A') ? 'B' : 'A'}${file.ciphertext.slice(1)}` };
    expect(messageOf(() => openArchive(JSON.stringify(flipped), key))).toMatch(/cannot open the archive: wrong key or a changed file/);
    const moved = { ...file, header: { ...file.header, root: `0x${'1'.repeat(64)}` } };
    expect(messageOf(() => openArchive(JSON.stringify(moved), key))).toMatch(/cannot open the archive: wrong key or a changed file/);
  });

  it('refuses records that do not rebuild the header`s root', () => {
    const opened = openArchive(sealed.text, key);
    const records = opened.records.map((r, i) => (i === 0 ? { ...r, salt: `0x${'2'.repeat(64)}` as Hex32 } : r));
    const text = sealPayload({ format: 'squarehole.box0-records/1', table: opened.table, records, inputs: opened.inputs }, sealed.header, key);
    expect(messageOf(() => openArchive(text, key))).toMatch(/the records do not rebuild the archive's root/);
  });

  it('refuses a cut tag or an IV of another length before decrypting (GCM keeps its 2^-128 bound only with the full tag)', () => {
    const file = JSON.parse(sealed.text) as { iv: string; tag: string };
    const tag = Buffer.from(file.tag, 'base64');
    for (const length of [4, 8, 12, 15]) {
      const cut = { ...file, tag: tag.subarray(0, length).toString('base64') };
      expect(messageOf(() => openArchive(JSON.stringify(cut), key))).toMatch(/the archive's tag must be 16 bytes/);
    }
    const longIv = { ...file, iv: Buffer.concat([Buffer.from(file.iv, 'base64'), Buffer.alloc(4)]).toString('base64') };
    expect(messageOf(() => openArchive(JSON.stringify(longIv), key))).toMatch(/the archive's iv must be 12 bytes/);
  });

  const payloadOf = (opened: ReturnType<typeof openArchive>, patch: object = {}) => ({
    format: opened.format,
    table: opened.table,
    inputs: opened.inputs,
    records: opened.records,
    ...patch,
  });

  it('refuses archived table bytes that do not hash to the header`s table hash', () => {
    const opened = openArchive(sealed.text, key);
    const described = encodeBoxMetadataTable({ description: 'Another table.', traitTypes: input.table.table.traitTypes });
    const text = sealPayload(payloadOf(opened, { table: `0x${bytesToHex(described)}` }), sealed.header, key);
    expect(messageOf(() => openArchive(text, key))).toMatch(/the archived table does not hash to the header's table hash/);
  });

  it('refuses a header whose value order hash is not the archived table`s', () => {
    const opened = openArchive(sealed.text, key);
    const header = { ...sealed.header, valueOrderHash: `0x${'3'.repeat(64)}` as Hex32 };
    const text = sealPayload(payloadOf(opened), header, key);
    expect(messageOf(() => openArchive(text, key))).toMatch(/the archived table's value order hash is not the header's/);
  });

  it('refuses archived attributes that are not what traitsPacked says (they are not in the leaf, so the root cannot catch it)', () => {
    const opened = openArchive(sealed.text, key);
    const records = opened.records.map((r, i) => (i === 4 ? { ...r, attributes: opened.records[5]?.attributes ?? [] } : r));
    const text = sealPayload(payloadOf(opened, { records }), sealed.header, key);
    const message = messageOf(() => openArchive(text, key));
    expect(message).toMatch(/id 5: the archived attributes are not what its traitsPacked says/);
    for (const a of opened.records[5]?.attributes ?? []) expect(message).not.toContain(a.value);
    const shuffled = opened.records.map((r, i) => (i === 0 ? { ...r, id: 2 } : i === 1 ? { ...r, id: 1 } : r));
    expect(messageOf(() => openArchive(sealPayload(payloadOf(opened, { records: shuffled }), sealed.header, key), key))).toMatch(
      /the archive's record 1 is not id 1/,
    );
  });

  it('records the render file`s generator tree apart from the committed one (MF-17 answered zero)', () => {
    const zero = sealArchive(buildBox0Commitment({ ...input, generator: { zero: true } }, { n }), key, { escrowIntent: 'floor-only' });
    expect(zero.header.generatorHash).toBe(`0x${'0'.repeat(64)}`);
    expect(zero.header.generatorTree).toBe('');
    expect(zero.header.renderGeneratorTree).toBe(set.generatorTree);
    expect(openArchive(zero.text, key).header.renderGeneratorTree).toBe(set.generatorTree);
  });

  it('never seals test salts', () => {
    const test = buildBox0Commitment(input, { n, testSalt });
    expect(messageOf(() => sealArchive(test, key))).toMatch(/test salts never go into an escrow archive/);
  });
});

describe('F115 trustee intent', () => {
  it('seals a trustee-intent archive (the default): the split comes after sealing and is gated by key-split.ts', () => {
    const trustee = sealArchive(commitment, key);
    expect(trustee.header.escrowIntent).toBe('trustees-2-of-3');
    expect(sealArchive(commitment, key, { escrowIntent: 'trustees-2-of-3' }).header.escrowIntent).toBe('trustees-2-of-3');
    expect(openArchive(trustee.text, key).root).toBe(commitment.root);
  });
});
