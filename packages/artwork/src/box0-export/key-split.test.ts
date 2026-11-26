/**
 * The key split gate (K5 / MF-16; F115 R30P selects trustees; F122 R37E builds the split on shamir-secret-sharing):
 * the hook hands a splitter the key and the archive's identity once, sanitizes what a splitter throws, and lets
 * trustee escrow through only with the genuine TrusteeKeySplit and its verified receipt. A no-op or any other splitter
 * claiming "shamir-2-of-3" is refused before it sees the key.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { bytesToHex } from '@noble/hashes/utils.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { messageOf, randomTestSet, readR7, readR7Json, rejectionOf } from '../test-support/box0-export';
import { outsideRepoTemp, workspaces } from '../test-support/box0-workspaces';
import { NO_KEY_SPLIT, archiveKeyId, sealArchive, type ArchiveKeySplit, type KeySplitContext } from './archive';
import { buildBox0Commitment } from './commitment';
import { parseFrozenSet, parseTraitTable } from './inputs';
import { assertEscrowAvailable, runKeySplit } from './key-split';
import { parseRenderHashes } from './renders';
import { TrusteeKeySplit, isVerifiedTrusteeReceipt } from './trustees';

const n = 13;
const set = randomTestSet(n, readR7().types, [3]);
const commitment = buildBox0Commitment(
  { frozenSet: parseFrozenSet(set.frozenSet, n), renders: parseRenderHashes(set.renders, n), table: parseTraitTable(readR7Json()), generator: { tree: set.generatorTree } },
  { n },
);
const key = new Uint8Array(randomBytes(32));
const sealed = sealArchive(commitment, key, { escrowIntent: 'trustees-2-of-3' });
const floorContext: KeySplitContext = { archiveSha256: sealed.sha256, keyId: archiveKeyId(key), escrowIntent: 'floor-only' };
const trusteeContext: KeySplitContext = { archiveSha256: sealed.sha256, keyId: sealed.header.keyId, escrowIntent: 'trustees-2-of-3', archiveText: sealed.text };

const ws = workspaces('box0-key-split');
afterEach(() => ws.trash());
const itOutsideRepo = it.skipIf(!outsideRepoTemp);

function trusteeSplitter(dir = ws.make()) {
  return new TrusteeKeySplit({ destinations: [1, 2, 3].map((t) => join(dir, `trustee-${t}`)), exportDir: join(dir, 'out') });
}

describe('key split hook (K5 / MF-16)', () => {
  it('an explicit floor-only choice splits nothing and says so', async () => {
    const receipt = await runKeySplit(NO_KEY_SPLIT, key, floorContext);
    expect(receipt.scheme).toBe('none');
    expect(receipt.note).toMatch(/K5 \(MF-16\)/);
  });

  it('hands a plugged-in splitter the key and the archive identity once', async () => {
    const calls: { keyMatches: boolean; archiveSha256: string; escrowIntent: string }[] = [];
    const splitter: ArchiveKeySplit = {
      scheme: 'test-hook',
      split(k, ctx) {
        calls.push({ keyMatches: bytesToHex(k) === bytesToHex(key), archiveSha256: ctx.archiveSha256, escrowIntent: ctx.escrowIntent });
        return { scheme: 'test-hook', note: 'test hook called; no shares created' };
      },
    };
    const receipt = await runKeySplit(splitter, key, floorContext);
    expect(receipt.scheme).toBe('test-hook');
    expect(calls).toEqual([{ keyMatches: true, archiveSha256: sealed.sha256, escrowIntent: 'floor-only' }]);
    const liar: ArchiveKeySplit = { scheme: 'a', split: () => ({ scheme: 'b', note: '' }) };
    await expect(runKeySplit(liar, key, floorContext)).rejects.toThrow(/the splitter reported a different scheme/);
    const silent = { scheme: 'a', split: () => undefined } as unknown as ArchiveKeySplit;
    await expect(runKeySplit(silent, key, floorContext)).rejects.toThrow(/the splitter reported a different scheme/);
  });

  it('sanitizes splitter failures and mismatched receipts without echoing keys or shares', async () => {
    const secret = bytesToHex(key);
    const splitters: ArchiveKeySplit[] = [
      { scheme: 'test', split: () => { throw new Error(secret); } },
      { scheme: 'test', split: () => Promise.reject(new Error(secret)) },
      { scheme: 'test', split: () => ({ scheme: secret, note: secret }) },
    ];
    for (const splitter of splitters) {
      const message = await rejectionOf(runKeySplit(splitter, key, floorContext));
      expect(message.includes(secret)).toBe(false);
      expect(message).toMatch(/splitter (failed|reported a different scheme)/);
    }
  });
});

describe('trustee escrow only through the verified trustee splitter (F115 R30P, F122 R37E)', () => {
  it('refuses trustee escrow with no splitter, the no-op splitter or any splitter claiming shamir-2-of-3, before handing it a key', async () => {
    const split = vi.fn(() => ({ scheme: 'shamir-2-of-3', note: 'unverified' }));
    const claims: ArchiveKeySplit[] = [NO_KEY_SPLIT, { scheme: 'shamir-2-of-3', split }, { scheme: 'claimed-2-of-3', split }, Object.create(TrusteeKeySplit.prototype) as ArchiveKeySplit];
    const refusal = /trustee escrow \(F115 R30P\) is made only by the 2-of-3 trustee splitter/;
    expect(messageOf(() => assertEscrowAvailable('trustees-2-of-3'))).toMatch(refusal);
    for (const splitter of claims) {
      expect(messageOf(() => assertEscrowAvailable('trustees-2-of-3', splitter))).toMatch(refusal);
      expect(await rejectionOf(runKeySplit(splitter, key, trusteeContext))).toMatch(refusal);
    }
    expect(split).not.toHaveBeenCalled();
  });

  it('refuses a shamir-2-of-3 claim and the trustee splitter for any other escrow intent', async () => {
    const split = vi.fn(() => ({ scheme: 'shamir-2-of-3', note: 'unverified' }));
    const refusal = /a shamir-2-of-3 split goes only with trustee escrow \(trustees-2-of-3\)/;
    expect(messageOf(() => assertEscrowAvailable('floor-only', { scheme: 'shamir-2-of-3', split }))).toMatch(refusal);
    expect(await rejectionOf(runKeySplit({ scheme: 'shamir-2-of-3', split }, key, floorContext))).toMatch(refusal);
    expect(split).not.toHaveBeenCalled();
    expect(messageOf(() => assertEscrowAvailable('zama' as never))).toMatch(/the escrow intent must be one of/);
  });

  itOutsideRepo('accepts the genuine splitter only: not a subclass, and its methods cannot be replaced', async () => {
    const genuine = trusteeSplitter();
    expect(() => assertEscrowAvailable('trustees-2-of-3', genuine)).not.toThrow();
    expect(messageOf(() => assertEscrowAvailable('zama-plus-floor', genuine))).toMatch(/a shamir-2-of-3 split goes only with trustee escrow/);
    expect(() => {
      (genuine as unknown as { split: unknown }).split = () => ({ scheme: 'shamir-2-of-3', note: '' });
    }).toThrow(TypeError);
    expect(() => {
      (TrusteeKeySplit.prototype as unknown as { split: unknown }).split = () => ({ scheme: 'shamir-2-of-3', note: '' });
    }).toThrow(TypeError);
    class Imitation extends TrusteeKeySplit {}
    const dir = ws.make();
    let imitation: unknown;
    try {
      imitation = new Imitation({ destinations: [1, 2, 3].map((t) => join(dir, `t${t}`)), exportDir: join(dir, 'out') });
    } catch {
      imitation = undefined; // a frozen base refuses subclass fields; either way it is not genuine
    }
    if (imitation) expect(messageOf(() => assertEscrowAvailable('trustees-2-of-3', imitation as ArchiveKeySplit))).toMatch(/only by the 2-of-3 trustee splitter/);
    expect(TrusteeKeySplit.isGenuine(genuine)).toBe(true);
    expect(TrusteeKeySplit.isGenuine({ ...genuine })).toBe(false);
  });

  itOutsideRepo('runs the genuine splitter and returns its verified receipt for this archive', async () => {
    const receipt = await runKeySplit(trusteeSplitter(), key, trusteeContext);
    expect(receipt.scheme).toBe('shamir-2-of-3');
    expect(isVerifiedTrusteeReceipt(receipt)).toBe(true);
    expect(receipt).toMatchObject({ keyId: sealed.header.keyId, archiveSha256: sealed.sha256 });
  });

  itOutsideRepo('passes the trustee splitter`s own refusal through (it never holds key or share bytes)', async () => {
    const otherKey = new Uint8Array(randomBytes(32));
    const message = await rejectionOf(runKeySplit(trusteeSplitter(), otherKey, trusteeContext));
    expect(message).toMatch(/the trustee split was refused: the key is not the archive's key/);
    for (const secret of [bytesToHex(otherKey), bytesToHex(key)]) expect(message.includes(secret)).toBe(false);
  });
});
