import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { ChildProcess } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { inspectBoxPicture, PICTURE_BUDGET } from '@squarehole/artwork/box-picture';
import { PICTURE_CASES, pictureFixture } from '../../artwork/src/picture-fixtures';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { nodeCardAssets, nodeCardEngine } from './engine';
import { testCardEngine } from './webp-test-support';
import { base64, renderCardPng, type CardEngine } from './share-render';
import { convertedPng, MAX_CONVERTED_BYTES } from './converted-picture';
import { WEBP_CHILD_ARGS, WEBP_LIMITS, WebpDecoder } from './webp-decoder';
import { CardService } from './service/card-service';
import { blankPng } from './test-support';
import { memoryWebp } from './webp-fixtures/memory-input';

const path = (name: string) => fileURLToPath(new URL(`./webp-fixtures/${name}`, import.meta.url)).replace(/^\/@fs\//, '/');
const WEBP = { bytes: pictureFixture('lossless.webp'), type: 'image/webp' as const };
const BOX = { chainId: 11155111, token: `0x${'19'.repeat(20)}` as const, chainLabel: 'Sepolia', name: 'Pictures', ticker: 'PIC', demo: false,
  state: { kind: 'open' as const }, logoSha256: null };
const ASSETS = nodeCardAssets();
const decoders: WebpDecoder[] = [];
const children: ChildProcess[] = [];
const tracked = async (mode?: string) => {
  const d = await WebpDecoder.start({ deadlineMs: shLimit(WEBP_LIMITS.deadlineMs), onChild: c => { children.push(c); },
    ...(mode ? { command: { file: process.execPath, args: [path('child.mjs'), mode] } } : {}) });
  decoders.push(d);
  return d;
};
afterEach(async () => {
  vi.useRealTimers();
  // Independent cleanup also reaps children if a shutdown mutation breaks close().
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all(decoders.splice(0).map(d => d.close()));
  children.length = 0;
});
const dead = (child: ChildProcess) => {
  expect(child.pid).not.toBe(process.pid);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(() => process.kill(child.pid ?? -1, 0)).toThrow();
};
const service = (engine: CardEngine) => new CardService({ engine, engineKind: 'test', assets: ASSETS, generic: new Uint8Array(), disk: null,
  config: () => ({ sepoliaManifest: null, localManifest: null, sepoliaRpcUrls: [], localRpcUrl: null, indexerOrigin: null }),
  readers: { fetch: vi.fn(), direct: null, indexerTimeoutMs: shLimit(1000) }, gateways: [], fetchArt: vi.fn(),
  withheld: { has: () => false, snapshot: () => ({ version: 1, hashes: [] }) } });

describe('SH-211 conversion', () => {
  const cases = PICTURE_CASES.filter(f => f.accepted && f.name.endsWith('.webp'));
  let decoder: WebpDecoder;
  beforeAll(async () => { decoder = await WebpDecoder.start({ deadlineMs: shLimit(WEBP_LIMITS.deadlineMs) }); });
  afterAll(async () => { await decoder.close(); });

  it.each(cases)('$name equals independent first-frame PNG pixels in both complete card paths', async ({ name, bytes }) => {
    expect(decoder.available).toBe(true);
    const png = await decoder.decode({ bytes, type: 'image/webp' });
    if (!png) throw new Error(`decode failed: ${name}`);
    const reference = { bytes: new Uint8Array(readFileSync(path(name.replace('.webp', '.png')))), type: 'image/png' as const };
    const info = inspectBoxPicture(bytes);
    if (!info) throw new Error(name);
    for (const kind of ['native', 'wasm'] as const) {
      const engine = await testCardEngine(kind);
      const pixels = (picture: typeof reference) => engine.rgba(`<svg xmlns="http://www.w3.org/2000/svg" width="${info.width}" height="${info.height}"><image width="${info.width}" height="${info.height}" href="data:image/png;base64,${base64(picture.bytes)}"/></svg>`).pixels;
      expect(Buffer.from(pixels(png as typeof reference)).equals(Buffer.from(pixels(reference)))).toBe(true);
      const actual = await renderCardPng(BOX, { bytes, type: 'image/webp' }, ASSETS, engine, false);
      const expected = await renderCardPng(BOX, reference, ASSETS, engine, false);
      const cardPixels = (b: Uint8Array) => engine.rgba(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><image width="1200" height="630" href="data:image/png;base64,${base64(b)}"/></svg>`).pixels;
      expect(Buffer.from(cardPixels(actual)).equals(Buffer.from(cardPixels(expected)))).toBe(true);
    }
  });

  it('refused dimensions, bytes and truncated input never start a child', async () => {
    const d = await tracked();
    const count = children.length;
    for (const fixture of PICTURE_CASES.filter(f => !f.accepted)) expect(await d.decode({ bytes: fixture.bytes, type: 'image/webp' })).toBeNull();
    expect(await d.decode({ bytes: WEBP.bytes.subarray(0, 20), type: 'image/webp' })).toBeNull();
    expect(await d.decode({ bytes: new Uint8Array(PICTURE_BUDGET.bytes + 1), type: 'image/webp' })).toBeNull();
    expect(await d.decode({ bytes: pictureFixture('ordinary.png'), type: 'image/png' })).toBeNull();
    expect(children).toHaveLength(count);
  });

  it('a PNG larger than the public byte cap keeps its pixels without admitting public oversized pictures', async () => {
    const bytes = memoryWebp(72);
    expect(bytes.length).toBe(790040);
    for (const density of [73, 74, 75]) {
      const other = memoryWebp(density);
      expect(other.length).toBe(790040);
      expect(other.equals(bytes)).toBe(false);
      expect(inspectBoxPicture(other)).toMatchObject({ width: 2048, height: 2048 });
    }
    expect(inspectBoxPicture(bytes)).toMatchObject({ width: 2048, height: 2048 });
    const png = await decoder.decode({ bytes, type: 'image/webp' });
    if (!png) throw new Error('large PNG decode failed');
    expect(png.bytes.length).toBeGreaterThan(PICTURE_BUDGET.bytes);
    expect(png.bytes.length).toBe(14370469);
    const engine = await testCardEngine('native');
    expect(engine.pictureDecodes?.(png)).toBe(true);
    const draw = { ...engine, satori: vi.fn(async () => '<svg/>'), png: () => new Uint8Array() };
    await renderCardPng(BOX, png, ASSETS, draw, false);
    expect(draw.satori).toHaveBeenCalledOnce();
    await expect(renderCardPng(BOX, { ...png }, ASSETS, draw, false)).rejects.toThrow('picture cannot be drawn');
    const card = Buffer.from(await renderCardPng(BOX, png, ASSETS, engine, false));
    expect([card.readUInt32BE(16), card.readUInt32BE(20)]).toEqual([1200, 630]);
  });

  it('child applies the pixel limit and first-frame options, cache off and one thread', async () => {
    const d = await WebpDecoder.start({ deadlineMs: shLimit(WEBP_LIMITS.deadlineMs), onChild: c => { children.push(c); },
      command: { file: process.execPath, args: ['--import', path('sharp-contract.mjs'), ...WEBP_CHILD_ARGS] } });
    decoders.push(d);
    expect(d.available).toBe(true);
    expect(await d.decode(WEBP)).not.toBeNull();
    expect(children).toHaveLength(2);
    for (const child of children) dead(child);
    // No native decoder was loaded by the service/test process.
    expect(Object.keys(createRequire(import.meta.url).cache).some(p => /sharp.*\.node$/.test(p))).toBe(false);
  });

  it('the engine delegates WebP to a child without loading sharp in the service process', async () => {
    const d = await tracked();
    const engine = await nodeCardEngine('native', d);
    expect(await engine.decodeWebp?.(WEBP)).not.toBeNull();
    expect(children).toHaveLength(2);
    for (const child of children) dead(child);
    expect(Object.keys(createRequire(import.meta.url).cache).some(p => /sharp.*\.node$/.test(p))).toBe(false);
  });

  it.each(['crash', 'truncated', 'double', 'text', 'crc', 'oversized'])('child %s is refused and reaped', async mode => {
    const d = await tracked(mode);
    expect(d.available).toBe(true);
    expect(await d.decode(WEBP)).toBeNull();
    if (mode === 'oversized') expect(children.at(-1)?.signalCode).toBe('SIGKILL');
    for (const child of children) dead(child);
  });

  it('a PNG of other dimensions is refused', async () => {
    const d = await tracked('wrong-size');
    expect(await d.decode({ bytes: pictureFixture('at-pixel-budget.webp'), type: 'image/webp' })).toBeNull();
  });

  it('converted bytes still go through structural and engine decode checks', async () => {
    const png = convertedPng(new Uint8Array(readFileSync(path('lossless.png'))), { width: 3, height: 2 });
    expect(png).not.toBeNull();
    const native = await testCardEngine('native');
    const probe = vi.fn(() => false);
    const satori = vi.fn(native.satori);
    const engine = { ...native, decodeWebp: async () => png, pictureDecodes: probe, satori };
    await expect(renderCardPng(BOX, WEBP, ASSETS, engine, false)).rejects.toThrow('picture cannot be drawn');
    expect(probe).toHaveBeenCalledOnce();
    expect(satori).not.toHaveBeenCalled();
    const invalid = { ...engine, decodeWebp: async () => ({ bytes: blankPng(8000, 8000), type: 'image/png' as const }) };
    await expect(renderCardPng(BOX, WEBP, ASSETS, invalid, false)).rejects.toThrow('picture cannot be drawn');
    expect(probe).toHaveBeenCalledOnce();
    expect(convertedPng(new Uint8Array(MAX_CONVERTED_BYTES + 1), { width: 3, height: 2 })).toBeNull();
  });
});

describe('SH-211 lifecycle', () => {
  it('hung child is killed at the wall deadline and leaves no process', async () => {
    const d = await tracked('hang');
    vi.useFakeTimers();
    const pending = d.decode(WEBP);
    const child = children.at(-1);
    if (!child) throw new Error('no child');
    await vi.advanceTimersByTimeAsync(shLimit(WEBP_LIMITS.deadlineMs));
    expect(child.killed).toBe(true);
    vi.useRealTimers();
    expect(await pending).toBeNull();
    dead(child);
  });

  it('one child, four queued requests, immediate overflow refusal and queue deadlines', async () => {
    const d = await tracked('hang');
    vi.useFakeTimers();
    const pending = Array.from({ length: WEBP_LIMITS.children + WEBP_LIMITS.queue }, () => d.decode(WEBP));
    expect(children).toHaveLength(2); // Startup probe and one active decode.
    expect(await d.decode(WEBP)).toBeNull();
    await vi.advanceTimersByTimeAsync(shLimit(WEBP_LIMITS.deadlineMs));
    expect(children.at(-1)?.killed).toBe(true);
    vi.useRealTimers();
    expect(await Promise.all(pending)).toEqual(Array.from({ length: 5 }, () => null));
    expect(children).toHaveLength(2); // Expired queued jobs never start.
    for (const child of children) dead(child);
  });

  it('service shutdown kills a running decode and drains the queue', async () => {
    const d = await tracked('hang');
    const engine = await nodeCardEngine('native', d);
    const pending = [d.decode(WEBP), d.decode(WEBP)];
    const closing = service(engine).close();
    expect(children.at(-1)?.killed).toBe(true);
    await closing;
    expect(await Promise.all(pending)).toEqual([null, null]);
    expect(await d.decode(WEBP)).toBeNull();
    for (const child of children) dead(child);
  });

  it.each([true, false])('health reports WebP drawing on=%s, including simulated library load failure', async available => {
    const d = await tracked(available ? undefined : 'load-failure');
    const engine = await nodeCardEngine('native', d);
    expect(d.available).toBe(available);
    const health = await service(engine).handle('GET', '/card/healthz');
    expect(JSON.parse(new TextDecoder().decode(health.body ?? undefined))).toEqual({ ok: true, engine: 'test', webp: available ? 'on' : 'off' });
    if (!available) expect(await renderCardPng(BOX, WEBP, ASSETS, engine)).toEqual(await renderCardPng(BOX, null, ASSETS, engine));
  });
});
