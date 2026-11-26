import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LifeActivityControllerV2 } from './useLifeActivity';
import { holdersV2 } from './life-activity';
const URL_BASE = 'https://indexer.example/v2/boxes/11155111/0xbox/activity';
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const account = '0x0000000000000000000000000000000000000001';
const base = (block: number) => ({ id: `${block}-1`, block: String(block), logIndex: 1, blockHash: hash(block), txHash: hash(block * 10), timestamp: String(1_793_083_300 + block) });
const items = [
  ...Array.from({ length: 949 }, (_, i) => ({ ...base(950 - i), kind: 'v2_event', data: { source: 'token', event: 'Transfer', from: account, to: account, amount: '100' } })),
  { ...base(1), kind: 'v2_event', data: { source: 'token', event: 'Transfer', from: '0x0000000000000000000000000000000000000000', to: account, amount: '100' } },
];
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
// XR4-BOX-LIFE-VIEW (Codex round-4 review): a failed holders page gives its page back even when the tab was hidden.
it.each([false, true])('a holders page failing with hidden=%s retains its allowance and completes after return', async (hidden) => {
  const calls: string[] = [];
  let failFirstOlder = true;
  let release = () => {};
  const fetcher = async (url: string) => {
    calls.push(url);
    const query = new URL(url).searchParams;
    const before = query.get('before');
    if (before && failFirstOlder) {
      failFirstOlder = false;
      await new Promise<void>(resolve => { release = resolve; });
      return { ok: false, status: 503, json: async () => ({ error: 'busy' }) };
    }
    const remaining = before ? items.filter(i => BigInt(i.block) < BigInt((before.split('-')[0] ?? '0'))) : items;
    const limit = Number(query.get('limit'));
    const page = remaining.slice(0, limit);
    return { ok: true, status: 200, json: async () => ({ asOf: { block: '1000' }, items: page, next: page.length === limit ? (page.at(-1)?.id ?? null) : null }) };
  };
  const c = new LifeActivityControllerV2(URL_BASE, fetcher);
  try {
    c.start(true);
    c.signal(1000n, 'unchanged');
    await vi.advanceTimersByTimeAsync(0);
    c.wantHistory(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    if (hidden) c.setVisible(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    if (hidden) {
      await vi.advanceTimersByTimeAsync(120_000);
      expect(calls).toHaveLength(2);
      c.setVisible(true);
    }
    await vi.advanceTimersByTimeAsync(300_000);
    const state = c.getState();
    expect({ rows: state.store.items.length, next: state.store.next, reading: state.readingHistory }).toEqual({ rows: 950, next: null, reading: false });
    expect(holdersV2(state.store, 1000n, { totalSupplyT: 100n, holderCount: 1n }, { roleOf: () => null, partOf: () => null }).status).toBe('ready');
  } finally { c.stop(); }
});
