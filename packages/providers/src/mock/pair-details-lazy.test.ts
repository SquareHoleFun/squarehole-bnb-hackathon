import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DataValidationError, IdentityError, type PairId } from '@squarehole/domain';
import { describe, expect, it, vi } from 'vitest';
import detailsJson from '../fixtures/pair-details.json';
import { ProviderUnavailableError } from '../errors';
import { createMockFeedProvider } from '../index';
import { pid, query } from '../test-support';

const ORCHARD = pid('66');
const source = () => vi.fn(() => Promise.resolve<unknown>(detailsJson));

describe('pair details load lazily (SH-012, M2/M3 review note)', () => {
  it('feed reads never load pair details; the first readPairDetail loads them exactly once', async () => {
    const load = source();
    const provider = createMockFeedProvider({ pairDetailsSource: load });
    await provider.readFeed(query());
    await provider.readPair(ORCHARD);
    await provider.latestSnapshot();
    expect(load).not.toHaveBeenCalled();

    expect((await provider.readPairDetail(ORCHARD))?.pairId).toBe(ORCHARD);
    expect(load).toHaveBeenCalledTimes(1);
    await provider.readPairDetail(pid('6a'));
    await provider.readPairDetail(pid('99'));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('concurrent first reads share one load', async () => {
    const load = source();
    const provider = createMockFeedProvider({ pairDetailsSource: load });
    const [a, b, c] = await Promise.all([ORCHARD, pid('67'), pid('70')].map((id) => provider.readPairDetail(id)));
    expect([a?.pairId, b?.pairId, c?.pairId]).toEqual([ORCHARD, pid('67'), pid('70')]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('an outage, a malformed id or an already-aborted read never triggers the load', async () => {
    const load = source();
    await expect(createMockFeedProvider({ scenario: 'unavailable', pairDetailsSource: load }).readPairDetail(ORCHARD)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    const provider = createMockFeedProvider({ pairDetailsSource: load });
    await expect(provider.readPairDetail('31337:0x66' as PairId)).rejects.toBeInstanceOf(IdentityError);
    const controller = new AbortController();
    controller.abort();
    await expect(provider.readPairDetail(ORCHARD, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(load).not.toHaveBeenCalled();
  });

  it('a failed load rejects that read (never a fabricated null) and the next read retries', async () => {
    const load = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('chunk failed to load'))
      .mockResolvedValue(detailsJson);
    const provider = createMockFeedProvider({ pairDetailsSource: load });
    await expect(provider.readPairDetail(ORCHARD)).rejects.toThrow('chunk failed to load');
    expect((await provider.readPairDetail(ORCHARD))?.pairId).toBe(ORCHARD);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('validates what it loads: a tampered fixture rejects with DataValidationError', async () => {
    const tampered = structuredClone(detailsJson);
    const orchard = tampered.details.find((detail) => detail.pairId === ORCHARD);
    if (!orchard) throw new Error('ORCHARD detail missing');
    orchard.supply.feeBurnedRaw = '1';
    const provider = createMockFeedProvider({ pairDetailsSource: () => Promise.resolve(tampered) });
    await expect(provider.readPairDetail(ORCHARD)).rejects.toBeInstanceOf(DataValidationError);
  });

  it('the bundled default is a dynamic import (its own chunk), not a static import', () => {
    const file = fileURLToPath(new URL('./mock-feed-provider.ts', import.meta.url));
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/^import[^;]*pair-details\.json/m);
    expect(text).toContain("import('../fixtures/pair-details.json')");
  });

  it('the default source serves the bundled fixture', async () => {
    const detail = await createMockFeedProvider().readPairDetail(ORCHARD);
    expect(detail).toEqual(detailsJson.details.find((d) => d.pairId === ORCHARD));
  });
});
