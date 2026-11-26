/** TA-50: the creator's reveal file read back on the box page: kept only for this box's root, and every proof verifies. */
import { boxLeaf, verifyBoxProof } from '@squarehole/artwork';
import { Blob as NodeBlob } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../../../../vitest.timeouts.mjs';
import { buildSpec, commitArt, revealFile } from '../../create/create-model';
import { artOf, formOf, inputOf } from '../../create/test-support/fixtures';
import { MAX_REVEAL_FILE_BYTES, parseRevealFile, readRevealFile, RevealFileError } from './reveal-file';

const input = inputOf({ form: formOf({ artMode: 'hidden' }) });
const art = input.art as NonNullable<typeof input.art>;
const commitment = input.commitment as NonNullable<typeof input.commitment>;
const text = revealFile(buildSpec(input), art, commitment).text;
const root = commitment.revealRoot;
const n = BigInt(art.items.length);
const edit = (change: (body: { items: Record<string, string>[]; revealRoot: string; n: string }) => void) => {
  const body = JSON.parse(text) as { items: Record<string, string>[]; revealRoot: string; n: string };
  change(body);
  return JSON.stringify(body);
};
const refused = (fn: () => unknown, line: string) => {
  let error: unknown;
  try { fn(); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(RevealFileError);
  expect((error as Error).message).toBe(line);
};

describe('TA-50 the reveal file on the box page', () => {
  it('keeps the file for this box: every item’s reveal proves against the collection’s root', () => {
    const file = parseRevealFile(text, root, n);
    expect(file.root).toBe(root.toLowerCase());
    expect(file.n).toBe(art.items.length);
    for (const item of art.items) {
      const reveal = file.revealOf(BigInt(item.id));
      expect(reveal).not.toBeNull();
      if (!reveal) continue;
      expect(reveal.imageHash).toBe(item.imageSha256.toLowerCase());
      expect(reveal.salt).toBe((art.salts[item.id - 1] ?? '').toLowerCase());
      expect(reveal.traitsPacked).toBe(commitment.packed[item.id - 1]);
      const leaf = boxLeaf({ id: item.id, traitsPacked: reveal.traitsPacked, imageSha256: reveal.imageHash, avatarSha256: reveal.avatarHash, modelSha256: reveal.modelHash, salt: reveal.salt }, art.items.length);
      expect(verifyBoxProof(item.id, leaf, reveal.proof, root, art.items.length)).toBe(true);
    }
    expect(file.revealOf(0n)).toBeNull();
    expect(file.revealOf(n + 1n)).toBeNull();
  });

  it('reads hidden salts from the automatic private BoxSpec backup and validates its root', () => {
    const backup = JSON.stringify({ format: 'squarehole.boxspec/2', revealList: JSON.parse(text) });
    const loaded = parseRevealFile(backup, root, n);
    expect(loaded.revealOf(1n)?.salt).toBe(art.salts[0]);
    refused(() => parseRevealFile(backup, `0x${'ab'.repeat(32)}`, n), 'This reveal file is for another box.');
  });

  it('refuses another box’s file: another root on chain, another size, another art', () => {
    refused(() => parseRevealFile(text, `0x${'ab'.repeat(32)}`, n), 'This reveal file is for another box.');
    refused(() => parseRevealFile(text, root, n + 1n), 'This reveal file is for another box.');
    const other = artOf(12, { traits: false });
    const otherCommitment = commitArt(other, 'hidden');
    if (!otherCommitment) throw new Error('fixture');
    refused(() => parseRevealFile(revealFile(buildSpec(input), other, otherCommitment).text, root, n), 'This reveal file is for another box.');
  });

  it('refuses a damaged file: a changed salt, picture hash, trait or order no longer builds the root', () => {
    refused(() => parseRevealFile(edit((b) => { (b.items[0] as Record<string, string>).salt = `0x${'11'.repeat(32)}`; }), root, n), 'This reveal file is damaged.');
    refused(() => parseRevealFile(edit((b) => { (b.items[2] as Record<string, string>).imageSha256 = `0x${'22'.repeat(32)}`; }), root, n), 'This reveal file is damaged.');
    refused(() => parseRevealFile(edit((b) => { (b.items[1] as Record<string, string>).traitsPacked = '7'; }), root, n), 'This reveal file is damaged.');
    refused(() => parseRevealFile(edit((b) => { b.items.reverse(); }), root, n), 'This reveal file is damaged.');
    refused(() => parseRevealFile(edit((b) => { (b.items[0] as Record<string, string>).traitsPacked = (1n << 128n).toString(); }), root, n), 'This reveal file is damaged.');
    refused(() => parseRevealFile(edit((b) => { b.items.pop(); }), root, n), 'This reveal file is damaged.');
  });

  it('refuses what is not a reveal file, and one too large to read', async () => {
    refused(() => parseRevealFile('not json', root, n), 'This is not a reveal file.');
    refused(() => parseRevealFile('[]', root, n), 'This is not a reveal file.');
    refused(() => parseRevealFile(JSON.stringify({ format: 'squarehole.boxspec/1', items: [] }), root, n), 'This is not a reveal file.');
    await expect(readRevealFile(new NodeBlob([text]), root, n)).resolves.toMatchObject({ n: art.items.length });
  });
  it('streams a private backup with 100 distinct 512 KiB pictures through Load reveal file', async () => {
    // Blob parts reuse one small base64 block; no 67 MiB JS string or parsed pictures array.
    const pictureBytes = Buffer.alloc(512 * 1024, 7).toString('base64');
    const pieces: (string | NodeBlob)[] = ['{"format":"squarehole.boxspec/2","pictures":['];
    for (let i = 0; i < 100; i++) {
      const bytes = `${i.toString(16).padStart(4, '0')}${pictureBytes.slice(4)}`;
      pieces.push(new NodeBlob([`${i ? ',' : ''}{"base64":"`, bytes, '"}']));
    }
    pieces.push(`],"revealList":${text}}`);
    const backup = new NodeBlob(pieces);
    expect(backup.size).toBeGreaterThan(MAX_REVEAL_FILE_BYTES);
    let largestRead = 0;
    const bounded = { size: backup.size, slice: (start = 0, end = backup.size) => {
      largestRead = Math.max(largestRead, end - start);
      return backup.slice(start, end);
    } };
    const loaded = await readRevealFile(bounded, root, n);
    expect(loaded.revealOf(1n)).toEqual(parseRevealFile(text, root, n).revealOf(1n));
    expect(largestRead).toBeLessThanOrEqual(64 * 1024);
  }, shLimit(20_000));

  it('bounds retained reveal bytes even when the whole file is streamed', async () => {
    const block = new NodeBlob(['x'.repeat(64 * 1024)]);
    const backup = new NodeBlob(['{"revealList":"', ...Array.from({ length: 513 }, () => block), '"}']);
    await expect(readRevealFile(backup, root, n)).rejects.toThrow('This file is too large to be a reveal file.');
  });

  it('handles chunk boundaries, escaped keys/strings, and fields after the reveal list', async () => {
    const backup = new NodeBlob([`{"revealList":${text},"pictures":["`, 'x'.repeat(65_530),
      '\\"} fake revealList \\"', '"],"for\\u006dat":"squarehole.boxspec/2"}']);
    await expect(readRevealFile(backup, root, n)).resolves.toMatchObject({ n: art.items.length });
  });

  it.each(['{"revealList":', '{"pictures":[}', '{"format":"x",}', '{} trailing',
    '{"format":"x","format":"y"}', '{"pictures":' + '['.repeat(65)])('refuses malformed framing: %s', async (bad) => {
    await expect(readRevealFile(new NodeBlob([bad]), root, n)).rejects.toBeInstanceOf(RevealFileError);
  });

});
