import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rawBlockCar, rawCidV1 } from '../../../scripts/ipfs/pin-raw-lib.mjs';

const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const sha256 = `0x${createHash('sha256').update(bytes).digest('hex')}`;
const cid = rawCidV1(sha256);
async function kit(files = [{ path: 'logo.png', role: 'logo', sha256 }], content = bytes) {
  const work = await mkdtemp(resolve('.cache/tmp/ta25-kit-'));
  await writeFile(`${work}/logo.png`, content);
  await writeFile(`${work}/box-art.json`, JSON.stringify({ files }));
  return { work, manifest: `${work}/box-art.json`, output: `${work}/cars` };
}

describe('SH-TA-25 founder raw-block export', () => {
  it('exports the existing library CAR format and public pin records without networking or UnixFS wrapping', async () => {
    const { exportKit } = await import('../ipfs/export-kit.mjs');
    const f = await kit();
    await exportKit(f.manifest, f.output);
    expect(await readFile(`${f.output}/${cid}.car`)).toEqual(rawBlockCar(bytes));
    const records = JSON.parse(await readFile(`${f.output}/pins.json`, 'utf8'));
    expect(records).toEqual([expect.objectContaining({ role: 'logo', cid, sha256, bytes: bytes.length, upload: 'car-v1-raw', status: 'computed' })]);
    expect(records[0].path).toBeUndefined();
    await expect(exportKit(f.manifest, f.output)).rejects.toThrow();
    expect(await readFile(`${f.output}/${cid}.car`)).toEqual(rawBlockCar(bytes));
  });

  it.each([
    [{ path: 'logo.png', role: 'logo' }],
    [{ path: 'logo.png', role: 'logo', sha256: `0x${'0'.repeat(64)}` }],
    [{ path: 'logo.png', role: 'logo', sha256 }, { path: 'missing.png', role: 'cover', sha256 }],
  ])('preflights committed hashes and the entire list before creating output', async (...files) => {
    const { exportKit } = await import('../ipfs/export-kit.mjs');
    const f = await kit(files);
    await expect(exportKit(f.manifest, f.output)).rejects.toThrow();
    expect(await readdir(f.work)).toEqual(['box-art.json', 'logo.png']);
  });

  it('refuses SVG and oversized input before any output', async () => {
    const { exportKit } = await import('../ipfs/export-kit.mjs');
    for (const content of [Buffer.from('<svg/>'), Buffer.alloc(1_048_577)]) {
      const hash = `0x${createHash('sha256').update(content).digest('hex')}`;
      const f = await kit([{ path: 'logo.png', role: 'logo', sha256: hash }], content);
      await expect(exportKit(f.manifest, f.output)).rejects.toThrow();
      expect(await readdir(f.work)).toEqual(['box-art.json', 'logo.png']);
    }
  });

  it('refuses role/MIME mismatches, traversal, hidden envelopes and incomplete public lists before output', async () => {
    const { exportKit } = await import('../ipfs/export-kit.mjs');
    for (const file of [{ path: 'logo.png', role: 'model', sha256 },
      { path: 'logo.png', role: 'logo', mime: 'model/gltf-binary', sha256 },
      { path: '../logo.png', role: 'logo', sha256 }]) {
      const f = await kit([file]);
      await expect(exportKit(f.manifest, f.output)).rejects.toThrow();
      expect(await readdir(f.work)).toEqual(['box-art.json', 'logo.png']);
    }
    const f = await kit();
    await writeFile(f.manifest, JSON.stringify({ files: [{ path: 'logo.png', role: 'logo', sha256 }], hiddenPlan: {} }));
    await expect(exportKit(f.manifest, f.output)).rejects.toThrow();
    const zero = `0x${'0'.repeat(64)}`;
    const list = Buffer.from(JSON.stringify({ format: 'squarehole.box-reveal-list/1', items: [{ avatarSha256: zero, id: '1',
      imageSha256: sha256, modelSha256: zero, salt: zero, traitsPacked: '0' }], n: '1' }));
    const g = await kit([{ path: 'logo.png', role: 'public reveal list', sha256: `0x${createHash('sha256').update(list).digest('hex')}` }], list);
    await expect(exportKit(g.manifest, g.output)).rejects.toThrow(/missing.*image/);
    expect(await readdir(g.work)).toEqual(['box-art.json', 'logo.png']);
  });
});
