import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTxSuccess, type TxContext, type TxState } from '@squarehole/domain';
import { MOCK_TX_LABEL, MOCK_TX_SCRIPT_NAMES, createMockTxExecutor, mockTxHash, type MockTxScriptName } from '../index';
import { expectAbortError } from '../test-support';

const CTX: TxContext = {
  kind: 'claim',
  chainId: 31337,
  account: '0x00000000000000000000000000000000de000002',
  deadline: '2026-09-25T12:20:00Z',
};

afterEach(() => {
  vi.useRealTimers();
});

const EXPECTED_FINAL: Record<MockTxScriptName, TxState['status']> = {
  success: 'finalized',
  reject: 'rejected',
  simulation_fail: 'simulation_failed',
  revert: 'reverted',
  min_out_revert: 'reverted',
  replace: 'replaced',
  wrong_chain: 'wrong_chain',
  wrong_chain_then_switch: 'finalized',
  timeout: 'timed_out',
  status_unknown: 'unknown',
  reorg: 'finalized',
  deadline_expiry: 'invalidated',
  account_change: 'invalidated',
};

describe('mock transaction executor (SH-015; no real signing)', () => {
  it('is labelled mock and names every scripted path', () => {
    expect(MOCK_TX_LABEL).toMatch(/^Mock transaction/);
    expect([...MOCK_TX_SCRIPT_NAMES].sort()).toEqual(Object.keys(EXPECTED_FINAL).sort());
    const executor = createMockTxExecutor({ script: 'success' });
    expect(executor.mode).toBe('mock');
    expect(executor.label).toBe(MOCK_TX_LABEL);
  });

  it.each(MOCK_TX_SCRIPT_NAMES.map((name) => [name] as const))('%s: ends in the expected state, and every scripted event is a legal transition', (name) => {
    const trace = createMockTxExecutor({ script: name }).run(CTX);
    expect(trace.final.status).toBe(EXPECTED_FINAL[name]);
    expect(trace.states).toHaveLength(trace.events.length);
    let previous: TxState = { status: 'idle' };
    for (const state of trace.states) {
      expect(state).not.toBe(previous); // no scripted no-ops
      previous = state;
    }
    expect(isTxSuccess(trace.final)).toBe(EXPECTED_FINAL[name] === 'finalized');
  });

  it('a hash alone is never success: submitted, pending and confirmed_unfinalized are all non-success', () => {
    const trace = createMockTxExecutor({ script: 'reorg' }).run(CTX);
    const statuses = trace.states.map((state) => state.status);
    expect(statuses).toEqual(['preparing', 'awaiting_signature', 'submitted', 'pending', 'confirmed_unfinalized', 'pending', 'confirmed_unfinalized', 'finalized']);
    expect(trace.states.slice(0, -1).some(isTxSuccess)).toBe(false);
  });

  it('uses obviously synthetic hashes and keeps min-out and replacement details', () => {
    expect(mockTxHash(1)).toMatch(/^0x0{52}6d6f636b0001$/);
    const minOut = createMockTxExecutor({ script: 'min_out_revert' }).run(CTX).final;
    expect(minOut).toMatchObject({ status: 'reverted', reason: 'min_payout_not_met', hash: mockTxHash(1) });
    const replaced = createMockTxExecutor({ script: 'replace' }).run(CTX).final;
    expect(replaced).toMatchObject({ status: 'replaced', hash: mockTxHash(1), newHash: mockTxHash(2) });
  });

  it('wrong_chain stops at a described switch; nothing is sent on another network', () => {
    const trace = createMockTxExecutor({ script: 'wrong_chain' }).run(CTX);
    expect(trace.final).toEqual({ status: 'wrong_chain', ctx: CTX, walletChainId: 1 });
    expect(trace.states.some((state) => 'hash' in state)).toBe(false);
  });

  it('deadline_expiry invalidates the request before signing', () => {
    expect(createMockTxExecutor({ script: 'deadline_expiry' }).run(CTX).final).toMatchObject({ status: 'invalidated', cause: 'deadline_passed' });
  });

  it('accepts a custom scripted sequence and reports no-ops as the same state', () => {
    const trace = createMockTxExecutor({ script: [{ type: 'prepare', ctx: CTX, walletChainId: 31337 }, { type: 'broadcast' }] }).run(CTX);
    expect(trace.states.map((state) => state.status)).toEqual(['preparing', 'preparing']);
    expect(trace.states[1]).toBe(trace.states[0]);
  });

  it('play() emits states on a deterministic schedule and honours abort', async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const done = createMockTxExecutor({ script: 'success' }).play(CTX, (state) => seen.push(state.status), { stepMs: 100 });
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual(['preparing', 'awaiting_signature']);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(done).resolves.toMatchObject({ status: 'finalized' });
    expect(seen).toHaveLength(6);

    const controller = new AbortController();
    const aborted = createMockTxExecutor({ script: 'success' }).play(CTX, () => undefined, { stepMs: 100, signal: controller.signal });
    controller.abort();
    await expectAbortError(aborted);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects unknown script names', () => {
    expect(() => createMockTxExecutor({ script: 'bogus' as MockTxScriptName })).toThrow(RangeError);
  });
});
