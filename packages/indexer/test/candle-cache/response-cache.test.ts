import { describe, expect, it, vi } from 'vitest';
import { RESPONSE_CACHE_LIMITS, ResponseCache } from '../../src/core/response-cache';

describe('CC-3: serialized response LRU', () => {
  it('caps entries at 2000 and evicts the least recently used, including hit promotion', async () => {
    expect(RESPONSE_CACHE_LIMITS).toEqual({ entries: 2000, bodyBytes: 64 * 1024 * 1024 });
    const cache = new ResponseCache(() => 0n); const build = vi.fn(async () => ({ candles: [] }));
    for (let i = 0; i < 2000; i++) await cache.read(String(i), build);
    await cache.read('0', build); await cache.read('2000', build); await cache.read('0', build);
    expect(cache.size).toBe(2000); expect(build).toHaveBeenCalledTimes(2001);
    await cache.read('1', build); expect(build).toHaveBeenCalledTimes(2002); expect(cache.size).toBe(2000);
  });

  it('bounds serialized UTF-8 bytes independently of entry count and does not retain oversized bodies', async () => {
    const cache = new ResponseCache(() => 0n, { entries: 2000, bodyBytes: 60 });
    const build = vi.fn(async () => ({ x: 'é'.repeat(10) })); // 28 bytes in UTF-8
    const first = await cache.read('a', build); expect(first?.body.length).toBe(28);
    await cache.read('b', build); await cache.read('a', build); await cache.read('c', build);
    expect(cache.bodyBytes).toBe(56); expect(cache.size).toBe(2);
    await cache.read('a', build); expect(build).toHaveBeenCalledTimes(3);
    await cache.read('b', build); expect(build).toHaveBeenCalledTimes(4);
    const huge = vi.fn(async () => ({ x: 'x'.repeat(100) }));
    await cache.read('huge', huge); await cache.read('huge', huge); expect(huge).toHaveBeenCalledTimes(2); expect(cache.bodyBytes).toBeLessThanOrEqual(60);
  });

  it('bounds pending entries too, sharing builds while excess distinct requests wait for capacity', async () => {
    const cache = new ResponseCache(() => 0n, { entries: 2, bodyBytes: 1000 });
    let release!: () => void; const held = new Promise<void>(r => { release = r; });
    const build = vi.fn(async () => { await held; return { candles: [] }; });
    const a = cache.read('a', build); const b = cache.read('b', build);
    const extra = Array.from({ length: 20 }, () => cache.read('c', build));
    await Promise.resolve(); await Promise.resolve();
    expect(cache.size).toBe(2); expect(build).toHaveBeenCalledTimes(2);
    release(); await Promise.all([a, b, ...extra]);
    expect(build).toHaveBeenCalledTimes(3); expect(cache.size).toBeLessThanOrEqual(2);
  });

  it('serializes only once per build and never retains a failed or obsolete build', async () => {
    let version = 0n; const cache = new ResponseCache(() => version);
    const serialize = vi.fn(() => ({ candles: [] })); const build = vi.fn(async () => ({ toJSON: serialize }));
    await cache.read('a', build); await cache.read('a', build); expect(serialize).toHaveBeenCalledTimes(1);
    version++;
    await cache.read('a', build); expect(serialize).toHaveBeenCalledTimes(2); expect(cache.size).toBe(1);
    const broken = vi.fn(async () => { throw new Error('no data'); });
    await expect(cache.read('bad', broken)).rejects.toThrow('no data'); await expect(cache.read('bad', broken)).rejects.toThrow('no data'); expect(broken).toHaveBeenCalledTimes(2);
  });
});
