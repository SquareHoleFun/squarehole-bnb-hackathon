import { describe, expect, it } from 'vitest';
import { readCoreV2Json } from '../test-support/core-v2';
import { ETH_LOCAL, FIT_LOCAL, GENESIS_FIT, LOCAL, ONE_FIT, SEPOLIA, blockOn, snapshotOf } from '../test-support/core-fixtures';
import {
  CoreModelError,
  amountOf,
  encodeRatio,
  marketId,
  marketMetricRows,
  mockAssetId,
  snapshotIssues,
  valuationOf,
  vaultMetricRows,
  vaultMetrics,
  type MetricRow,
  type UsdPrice,
} from './index';

interface ReferenceState {
  supplyRaw: string;
  escrowRaw: string;
  activeRaw: string;
  inside: number;
  outside: number;
  rate: { numerator_raw: string; denominator: string };
  surplus: { numerator_raw: string; denominator: string };
}

function referenceStates(): [string, ReferenceState][] {
  const results = readCoreV2Json('examples/reference-results.json') as Record<string, unknown>;
  const found: [string, ReferenceState][] = [];
  for (const [example, body] of Object.entries(results)) {
    if (typeof body !== 'object' || body === null) continue;
    for (const [name, state] of Object.entries(body)) {
      if (typeof state === 'object' && state !== null && 'supplyRaw' in state) found.push([`${example}.${name}`, state as ReferenceState]);
    }
  }
  return found;
}

const BANNED_WORDS = /\b(yield|apy|apr|earn\w*|profit\w*|roi|return\w*|guarante\w*|dividend\w*|interest)\b/i;

function modelCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof CoreModelError ? error.code : `unexpected ${String(error)}`;
  }
  return undefined;
}

describe('vault metrics reproduce the v2 reference results (examples/reference-results.json)', () => {
  const states = referenceStates();

  it('finds the nine reference states', () => {
    expect(states.map(([name]) => name)).toEqual([
      'EX01.halfOutside',
      'EX01.after2500Return',
      'EX02.burned',
      'EX02.after2500Return',
      'EX02.allReturned',
      'EX03.state',
      'EX04.state',
      'EX05.immediate',
      'EX05.delayed',
    ]);
  });

  it.each(states)('%s: A, r = A/n and K = E - m*r match exactly', (_name, state) => {
    const metrics = vaultMetrics(
      snapshotOf({ S: BigInt(state.supplyRaw), E: BigInt(state.escrowRaw), n: BigInt(state.inside), N: BigInt(state.inside + state.outside) }),
    );
    expect(metrics.A.raw.toString()).toBe(state.activeRaw);
    expect(metrics.m).toBe(BigInt(state.outside));
    expect(metrics.r && encodeRatio(metrics.r)).toEqual({ num: state.rate.numerator_raw, den: state.rate.denominator });
    expect(metrics.K && encodeRatio(metrics.K)).toEqual({ num: state.surplus.numerator_raw, den: state.surplus.denominator });
  });
});

describe('vault metrics', () => {
  it('keeps S, E, A, burned, n, m, r, K and L apart', () => {
    const metrics = vaultMetrics(snapshotOf({ S: 950_000_000n * ONE_FIT, E: 500_000_000n * ONE_FIT, n: 5_000n }));
    expect(metrics.S.raw).toBe(950_000_000n * ONE_FIT);
    expect(metrics.E.raw).toBe(500_000_000n * ONE_FIT);
    expect(metrics.A.raw).toBe(450_000_000n * ONE_FIT);
    expect(metrics.burned.raw).toBe(50_000_000n * ONE_FIT);
    expect([metrics.N, metrics.n, metrics.m]).toEqual([10_000n, 5_000n, 5_000n]);
    expect(metrics.r).toEqual({ num: 90_000n * ONE_FIT, den: 1n });
    expect(metrics.L).toEqual({ num: 450_000_000n * ONE_FIT, den: 1n });
    expect(metrics.K).toEqual({ num: 50_000_000n * ONE_FIT, den: 1n });
  });

  it('keeps r and K exact when n does not divide A', () => {
    const metrics = vaultMetrics(snapshotOf({ S: 1_000n, E: 0n, n: 3n, N: 3n, initial: 1_000n }));
    expect(metrics.r).toEqual({ num: 1_000n, den: 3n });
    expect(metrics.K).toEqual({ num: 0n, den: 1n });
  });

  it('leaves r and K undefined when no Misfit is inside', () => {
    const metrics = vaultMetrics(snapshotOf({ E: GENESIS_FIT, n: 0n }));
    expect(metrics.r).toBeNull();
    expect(metrics.K).toBeNull();
    expect(metrics.L).toBeNull();
  });

  it('refuses an insolvent escrow: E*n < m*A', () => {
    expect(modelCode(() => vaultMetrics(snapshotOf({ E: 0n, n: 5_000n })))).toBe('invariant_violation');
  });

  it.each([
    ['E above S', { S: 10n, E: 11n, initial: 10n }],
    ['S above the initial supply', { S: GENESIS_FIT + 1n }],
    ['n above N', { n: 10_001n }],
  ])('refuses %s', (_name, input) => {
    expect(modelCode(() => vaultMetrics(snapshotOf(input)))).toBe('invariant_violation');
  });

  it('reports amounts in the wrong asset and a snapshot on a different chain', () => {
    const base = snapshotOf();
    expect(snapshotIssues({ ...base, escrowFit: amountOf(ETH_LOCAL, 0n) }).map((i) => i.path.join('.'))).toEqual(['escrowFit']);
    expect(snapshotIssues({ ...base, at: blockOn(SEPOLIA) }).map((i) => i.path.join('.'))).toContain('at.chainId');
    expect(snapshotIssues({ ...base, collectionCount: 0n }).map((i) => i.path.join('.'))).toContain('collectionCount');
  });

  it('keeps mock FIT on the demo chain only', () => {
    const base = snapshotOf();
    const mockFit = { ...FIT_LOCAL, id: mockAssetId('FIT'), standard: 'mock' as const, chainId: null, address: null };
    const mock = { ...base, fit: mockFit, initialSupply: amountOf(mockFit, GENESIS_FIT), totalSupply: amountOf(mockFit, GENESIS_FIT), escrowFit: amountOf(mockFit, 0n) };
    expect(snapshotIssues(mock)).toEqual([]);
    expect(snapshotIssues({ ...mock, at: blockOn(SEPOLIA) }).map((i) => i.message)).toContain('mock data is only valid on the demo chain 31337');
  });
});

describe('UI-03 metric rows: S, E, K, A, r, pool reserves, QUSD and valuation basis shown distinctly', () => {
  const metrics = vaultMetrics(snapshotOf({ S: 950_000_000n * ONE_FIT, E: 500_000_000n * ONE_FIT, n: 5_000n }));
  const qUsd: UsdPrice = { state: 'observed', asset: ETH_LOCAL.id, usdPerUnit: '2500', source: 'test price', asOf: '2026-09-28T12:00:00Z' };
  const fitUsd: UsdPrice = { state: 'observed', asset: FIT_LOCAL.id, usdPerUnit: '0.0001', source: 'test price', asOf: '2026-09-28T12:00:00Z' };
  const reserves = {
    market: marketId(LOCAL, `0x${'cd'.repeat(32)}`),
    at: blockOn(LOCAL),
    fit: amountOf(FIT_LOCAL, 100_000_000n * ONE_FIT),
    q: amountOf(ETH_LOCAL, 4_206_980_085_000_000_000n),
  };

  const vaultRows = vaultMetricRows(metrics);
  const marketRows = marketMetricRows({ reserves, qUsd, valuation: valuationOf(metrics, 'total_supply', fitUsd) });
  const rows: MetricRow[] = [...vaultRows, ...marketRows];

  it('has one row per quantity, each with its own key, symbol and label', () => {
    expect(rows.map((row) => row.key)).toEqual(['S', 'E', 'A', 'r', 'K', 'n', 'm', 'burned', 'pool_fit', 'pool_q', 'q_usd', 'valuation']);
    expect(new Set(rows.map((row) => row.label)).size).toBe(rows.length);
    expect(new Set(rows.map((row) => row.symbol)).size).toBe(rows.length);
  });

  it('shows exact values, truncated, with units', () => {
    const value = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    expect(value).toMatchObject({
      S: '950,000,000 FIT',
      E: '500,000,000 FIT',
      A: '450,000,000 FIT',
      r: '90,000 FIT',
      K: '50,000,000 FIT',
      n: '5,000',
      m: '5,000',
      burned: '50,000,000 FIT',
      pool_fit: '100,000,000 FIT',
      pool_q: '4.2069 ETH',
      q_usd: '$2.5K',
      valuation: '$95K',
    });
  });

  it('names the valuation basis in the label, and the escrow is counted only in the total-supply basis', () => {
    const total = valuationOf(metrics, 'total_supply', fitUsd);
    const outside = valuationOf(metrics, 'outside_escrow', fitUsd);
    expect(total).toMatchObject({ basis: 'total_supply', usd: '95000' });
    expect(outside).toMatchObject({ basis: 'outside_escrow', usd: '45000' });
    const totalLabel = marketMetricRows({ reserves, qUsd, valuation: total }).at(-1)?.label;
    const outsideLabel = marketMetricRows({ reserves, qUsd, valuation: outside }).at(-1)?.label;
    expect(totalLabel).toMatch(/total supply/i);
    expect(totalLabel).toMatch(/includes the escrow/i);
    expect(outsideLabel).toMatch(/outside the escrow/i);
  });

  it('shows missing prices and reserves as unavailable, never zero', () => {
    const noPrice: UsdPrice = { state: 'unavailable', asset: FIT_LOCAL.id, reason: 'no trusted price' };
    const valuation = valuationOf(metrics, 'total_supply', noPrice);
    expect(valuation.usd).toBeNull();
    const missing = marketMetricRows({ reserves: null, qUsd: { state: 'unavailable', asset: ETH_LOCAL.id, reason: 'no trusted price' }, valuation });
    for (const row of missing) expect(row.value).toMatch(/^Unavailable/);
  });

  it('refuses a price for the wrong asset', () => {
    expect(modelCode(() => valuationOf(metrics, 'total_supply', qUsd))).toBe('asset_binding');
  });

  it('uses safe wording: no yield, return or earn framing (F23 legal)', () => {
    for (const row of rows) expect(`${row.label} ${row.note ?? ''}`).not.toMatch(BANNED_WORDS);
  });

  it('marks r as undefined with no Misfit inside', () => {
    const empty = vaultMetricRows(vaultMetrics(snapshotOf({ E: GENESIS_FIT, n: 0n })));
    expect(empty.find((row) => row.key === 'r')?.value).toBe('Not defined (no Misfit in the vault)');
  });
});
