import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateStore, decodeState, encodeState } from '../src/state';
import { restartStarts } from './support/start-state';
import { emptyMemory } from '../src/plan';
import { openBudget } from '../src/decide';

const scratch = resolve(import.meta.dirname, '../../../.cache/cq11-e1-state');
mkdirSync(scratch, { recursive: true });
const state = { mem: { ...emptyMemory(), buyBackSince: { pool: 7n } },
  budget: { ...openBudget(undefined, 100n, 172800n), totalWei: 123456789012345678901234567890n } };

describe('CQ11-E durable budgets and alert age', () => {
  it('preserves M2 scan cursors as exact decimal strings and accepts journals written before cursor support', () => {
    const withScan = { ...state, m2Scan: { 'batches:ledger': 8n, 'holders:ledger:1': 9007199254740993n, 'starters:shop': 16n } };
    const encoded = encodeState(withScan, 'm2');
    expect(encoded).toContain('"holders:ledger:1":"9007199254740993"');
    expect(decodeState(encoded, 'm2')).toEqual(withScan);
    expect(decodeState(encodeState(state, 'm2'), 'm2')).toEqual(state);
    for (const value of ['-1', '1.5', 8]) {
      expect(() => decodeState(JSON.stringify({ version: 1, identity: 'm2', state: { m2Scan: { page: value } } }), 'm2')).toThrow();
    }
  });
  it('persists exact decimal money and restores it across process restart', () => {
    const file = `${mkdtempSync(`${scratch}/run-`)}/state.json`;
    const first = new StateStore(file, 'chain:signer:registry');
    expect(first.load()).toEqual({});
    first.save(state, 0n);
    expect(readFileSync(file, 'utf8')).toContain('"totalWei":"123456789012345678901234567890"');
    first.close();
    const second = new StateStore(file, 'chain:signer:registry');
    expect(second.load()).toEqual(state);
    second.close();
  });
  it('refuses malformed amounts, wrong identity and concurrent writers without resetting the budget', () => {
    const file = `${mkdtempSync(`${scratch}/run-`)}/state.json`;
    const store = new StateStore(file, 'a');
    expect(() => new StateStore(file, 'a')).toThrow();
    expect(() => decodeState(encodeState(state, 'a'), 'b')).toThrow(/another chain/);
    expect(() => decodeState(encodeState(state, 'a').replace('"123456789012345678901234567890"', '1.5'), 'a')).toThrow();
    writeFileSync(file, '{broken');
    expect(() => store.load()).toThrow();
    store.close();
  });
});

it('F182 persists every start state without changing old liability', () => {
  const box = '0x0000000000000000000000000000000000000003' as const;
  const hash = `0x${'ab'.repeat(32)}`;
  const startStates = [{ job: 'collect' as const }, { job: 'collect' as const, settledAt: 172801n },
    { job: 'sellFees' as const, repaidAt: 172802n, paymentHashes: [hash] }];
  for (const start of startStates) for (const known of [false, true]) {
    const next = { ...state, incomeSpend: [{ box, at: 172800n, costWei: 50000000000000000n, start, ...(known ? { hash } : {}) }] };
    expect(restartStarts(next)).toEqual(next);
    expect(encodeState(next, 'start')).not.toContain('"start":');
  }
  const old = { ...state, incomeSpend: [{ box, at: 172800n, costWei: 42n, hash }] };
  expect(decodeState(encodeState(old, 'old'), 'old')).toEqual(old);
});

it('F182 disk restarts retain reserved, pending, settled and repaid start records', () => {
  const box = '0x0000000000000000000000000000000000000003' as const;
  const hash = `0x${'ab'.repeat(32)}`;
  for (const entry of [
    { box, at: 172800n, costWei: 50000000000000000n, start: { job: 'collect' as const } },
    { box, at: 172800n, costWei: 50000000000000000n, hash, start: { job: 'collect' as const } },
    { box, at: 172800n, costWei: 50000000000000000n, hash, start: { job: 'collect' as const, settledAt: 172801n } },
    { box, at: 172800n, costWei: 50000000000000000n, hash, start: { job: 'collect' as const, repaidAt: 172802n, paymentHashes: [hash] } },
  ]) {
    const file = `${mkdtempSync(`${scratch}/start-`)}/state.json`;
    const before = new StateStore(file, 'start'); before.save({ incomeSpend: [entry] }, 172800n); before.close();
    const after = new StateStore(file, 'start'); expect(after.load()).toEqual({ incomeSpend: [entry] }); after.close();
  }
});
