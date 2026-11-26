import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseLiveEvent } from '../live-model';
import { buildFitLiveFixture, fixtureTarget } from './fit-fixtures';

const E2E = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../e2e/fixtures');
const RECORD = JSON.parse(readFileSync(resolve(E2E, 'fit-market-31337.json'), 'utf8')) as unknown;
const FILE = resolve(E2E, 'fit-live-31337.json');

describe('e2e fixtures for the local FIT market', () => {
  const fixture = buildFitLiveFixture(RECORD);

  it('are exactly what the generator builds (SH_WRITE_FIXTURES=1 rewrites them)', () => {
    const text = `${JSON.stringify(fixture, null, 2)}\n`;
    if (process.env.SH_WRITE_FIXTURES === '1') writeFileSync(FILE, text);
    expect(readFileSync(FILE, 'utf8')).toBe(text);
  });

  it('parse cleanly with the page’s own parser and match the market', () => {
    const target = fixtureTarget(RECORD);
    const snapshot = parseLiveEvent('snapshot', fixture.snapshot, target);
    expect(snapshot.type).toBe('snapshot');
    if (snapshot.type !== 'snapshot') return;
    expect(snapshot.data.curveMismatch).toBeNull();
    expect(snapshot.data.stateMismatch).toBeNull();
    expect(snapshot.data.head.number.toString()).toBe(fixture.head);
    expect(snapshot.data.window.status).toBe('open');
    expect(snapshot.data.trades.length).toBeGreaterThan(0);
    const after = parseLiveEvent('snapshot', fixture.snapshotAfter, target);
    expect(after.type === 'snapshot' && after.data.head.number.toString()).toBe(fixture.headAfter);
    const wrong = fixture.streams.wrongPool.split('data: ')[1]?.split('\n')[0] ?? '';
    expect(() => parseLiveEvent('snapshot', wrong, target)).toThrow(/another chain or pool/);
  });
});
