// @vitest-environment node
/**
 * SH-ARWEAVE-PICTURES-WEB: which dropped files "Add picture" accepts: the committed picture itself, the box's BoxSpec
 * file, or the original that shrinks to it; anything else (another picture, a BoxSpec whose entry lies) is refused.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MAX_DROPPED_BYTES, NOT_THIS_PICTURE, matchPicture } from './add-picture';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (seed: number, size = 64) => Uint8Array.from({ length: size }, (_, i) => (i < 8 ? PNG[i] ?? 0 : (seed * 17 + i) & 255));
const shaOf = (bytes: Uint8Array) => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const blob = (bytes: Uint8Array | string, type = 'image/png') => new Blob([typeof bytes === 'string' ? bytes : bytes.slice()], { type });
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const boxSpec = (pictures: readonly { role: string; sha256: string; base64: string }[]) => JSON.stringify({ format: 'squarehole.boxspec/2', specHash: `0x${'1'.repeat(64)}`, spec: {}, pictures, revealList: null }, null, 2);

describe('matchPicture', () => {
  const logo = png(1);
  const cover = png(2);
  const wanted = [shaOf(logo), shaOf(cover)];

  it('the committed picture itself (either missing one)', async () => {
    expect(await matchPicture(blob(cover), wanted, null)).toMatchObject({ sha256: shaOf(cover), from: 'file' });
    expect(Buffer.from((await matchPicture(blob(logo), wanted, null))?.bytes ?? [])).toEqual(Buffer.from(logo));
  });

  it('the BoxSpec file: the entry whose bytes hash to a missing picture; an entry whose bytes lie about their hash is skipped', async () => {
    const file = boxSpec([{ role: 'logo', sha256: shaOf(logo), base64: b64(png(9)) }, { role: 'collection cover', sha256: shaOf(cover).toUpperCase().replace('0X', '0x'), base64: b64(cover) }]);
    expect(await matchPicture(blob(file, 'application/json'), wanted, null)).toMatchObject({ sha256: shaOf(cover), from: 'boxspec' });
    expect(await matchPicture(blob(file, 'application/json'), [shaOf(logo)], null)).toBeNull();
    expect(await matchPicture(blob('{"pictures": 3}', 'application/json'), wanted, null)).toBeNull();
    expect(await matchPicture(blob('{not json', 'application/json'), wanted, null)).toBeNull();
  });

  it('the original picture, shrunk again the way Create did; another picture is refused', async () => {
    const original = png(3, 4_000);
    const reshrink = vi.fn(async () => cover);
    expect(await matchPicture(blob(original), wanted, reshrink)).toMatchObject({ sha256: shaOf(cover), from: 'shrunk' });
    expect(reshrink).toHaveBeenCalledTimes(1);
    expect(await matchPicture(blob(original), wanted, async () => png(4))).toBeNull();
    expect(await matchPicture(blob(original), wanted, async () => { throw new Error('no canvas'); })).toBeNull();
    expect(await matchPicture(blob(original), wanted, null)).toBeNull();
  });

  it('nothing wanted, an empty file, a file over the read cap, or something that is neither: refused unread', async () => {
    expect(await matchPicture(blob(logo), [], null)).toBeNull();
    expect(await matchPicture(blob(new Uint8Array(0)), wanted, null)).toBeNull();
    const huge = { size: MAX_DROPPED_BYTES + 1, slice: () => { throw new Error('read'); }, arrayBuffer: () => { throw new Error('read'); }, text: () => { throw new Error('read'); } } as unknown as Blob;
    expect(await matchPicture(huge, wanted, null)).toBeNull();
    expect(await matchPicture(blob('<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'), wanted, async () => logo)).toBeNull();
    expect(NOT_THIS_PICTURE).toBe('This file is not this box’s picture.');
  });
});
