/**
 * Transaction state machine (06-ARCHITECTURE; UI-08; ECO-07). Exhaustive: every status x every event type is either
 * a listed legal transition or a no-op that returns the SAME state object.
 */
import { describe, expect, it } from 'vitest';
import {
  TX_EVENT_TYPES,
  TX_IDLE,
  TX_STATUSES,
  isTxSuccess,
  isTxTerminal,
  txReducer,
  type Address,
  type TxContext,
  type TxEvent,
  type TxEventType,
  type TxState,
  type TxStatus,
} from './index';

const HASH = `0x${'11'.repeat(32)}` as const;
const NEW_HASH = `0x${'22'.repeat(32)}` as const;
const ACCOUNT = '0x00000000000000000000000000000000de000001';
const OTHER_ACCOUNT = '0x00000000000000000000000000000000de000002';
const DEADLINE = '2026-09-25T12:20:00Z';
const CTX: TxContext = { kind: 'claim', chainId: 31337, account: ACCOUNT, deadline: DEADLINE };

/** One representative state per status. */
const STATES: Record<TxStatus, TxState> = {
  idle: TX_IDLE,
  preparing: { status: 'preparing', ctx: CTX },
  simulation_failed: { status: 'simulation_failed', ctx: CTX, reason: 'insufficient entitlement' },
  wrong_chain: { status: 'wrong_chain', ctx: CTX, walletChainId: 10 },
  awaiting_signature: { status: 'awaiting_signature', ctx: CTX },
  rejected: { status: 'rejected', ctx: CTX },
  invalidated: { status: 'invalidated', ctx: CTX, cause: 'account_changed' },
  submitted: { status: 'submitted', ctx: CTX, hash: HASH },
  pending: { status: 'pending', ctx: CTX, hash: HASH },
  replaced: { status: 'replaced', ctx: CTX, hash: HASH, newHash: NEW_HASH },
  confirmed_unfinalized: { status: 'confirmed_unfinalized', ctx: CTX, hash: HASH, block: '39600' },
  finalized: { status: 'finalized', ctx: CTX, hash: HASH, block: '39600' },
  reverted: { status: 'reverted', ctx: CTX, hash: HASH, reason: 'min_payout_not_met' },
  timed_out: { status: 'timed_out', ctx: CTX, hash: HASH },
  unknown: { status: 'unknown', ctx: CTX, hash: HASH, reason: 'receipt unavailable' },
};

/** One representative event per type (the "legal" variant where a condition applies). */
const EVENTS: Record<TxEventType, TxEvent> = {
  prepare: { type: 'prepare', ctx: CTX, walletChainId: 31337 },
  simulate_ok: { type: 'simulate_ok' },
  simulate_fail: { type: 'simulate_fail', reason: 'execution reverted' },
  chain_changed: { type: 'chain_changed', chainId: 1 },
  account_changed: { type: 'account_changed', account: OTHER_ACCOUNT },
  deadline_passed: { type: 'deadline_passed', at: DEADLINE },
  sign: { type: 'sign', hash: HASH },
  reject: { type: 'reject' },
  broadcast: { type: 'broadcast' },
  included: { type: 'included', block: '39601' },
  reorged: { type: 'reorged' },
  finalized: { type: 'finalized' },
  reverted: { type: 'reverted', reason: 'execution reverted' },
  replaced: { type: 'replaced', newHash: NEW_HASH },
  timeout: { type: 'timeout' },
  status_unknown: { type: 'status_unknown', reason: 'node lost the transaction' },
  reset: { type: 'reset' },
};

const NOT_IDLE = TX_STATUSES.filter((status) => status !== 'idle');
const UNRESOLVED_AFTER_SUBMIT: TxStatus[] = ['submitted', 'pending', 'timed_out', 'unknown'];
const BEFORE_SIGNING: TxStatus[] = ['preparing', 'wrong_chain', 'awaiting_signature'];

/** The complete legal transition table for the representative events. Everything else is a no-op. */
const TABLE: Partial<Record<TxStatus, Partial<Record<TxEventType, TxStatus>>>> = {
  idle: { prepare: 'preparing' },
  preparing: { simulate_ok: 'awaiting_signature', simulate_fail: 'simulation_failed' },
  wrong_chain: { chain_changed: 'wrong_chain' },
  awaiting_signature: { sign: 'submitted', reject: 'rejected' },
  submitted: { broadcast: 'pending' },
  pending: {},
  confirmed_unfinalized: { finalized: 'finalized', reorged: 'pending' },
  timed_out: {},
  unknown: {},
};
for (const status of BEFORE_SIGNING) {
  TABLE[status] = { ...TABLE[status], account_changed: 'invalidated', deadline_passed: 'invalidated' };
}
TABLE.preparing = { ...TABLE.preparing, chain_changed: 'invalidated' };
TABLE.awaiting_signature = { ...TABLE.awaiting_signature, chain_changed: 'invalidated' };
for (const status of UNRESOLVED_AFTER_SUBMIT) {
  TABLE[status] = { ...TABLE[status], included: 'confirmed_unfinalized', reverted: 'reverted', replaced: 'replaced' };
}
for (const status of ['submitted', 'pending'] as const) {
  TABLE[status] = { ...TABLE[status], timeout: 'timed_out', status_unknown: 'unknown' };
}
for (const status of NOT_IDLE) TABLE[status] = { ...TABLE[status], reset: 'idle' };

const CASES = TX_STATUSES.flatMap((status) => TX_EVENT_TYPES.map((type) => [status, type] as const));

describe('txReducer transition table (exhaustive)', () => {
  it('covers every status and every event type', () => {
    expect(TX_STATUSES).toHaveLength(15);
    expect(TX_EVENT_TYPES).toHaveLength(17);
    expect(Object.keys(STATES).sort()).toEqual([...TX_STATUSES].sort());
    expect(Object.keys(EVENTS).sort()).toEqual([...TX_EVENT_TYPES].sort());
    expect(CASES).toHaveLength(15 * 17);
  });

  it.each(CASES)('%s + %s', (status, type) => {
    const state = STATES[status];
    const next = txReducer(state, EVENTS[type]);
    const expected = TABLE[status]?.[type];
    if (expected === undefined) {
      expect(next).toBe(state);
    } else {
      expect(next.status).toBe(expected);
      expect(next).not.toBe(state);
      expect(Object.isFrozen(next)).toBe(true);
    }
  });

  it('never mutates its input', () => {
    for (const [status, type] of CASES) {
      const state = structuredClone(STATES[status]);
      const before = JSON.stringify(state);
      txReducer(state, EVENTS[type]);
      expect(JSON.stringify(state)).toBe(before);
    }
  });
});

describe('conditional transitions', () => {
  it('prepare on the wrong wallet chain goes to wrong_chain (no silent transaction on another network)', () => {
    expect(txReducer(TX_IDLE, { type: 'prepare', ctx: CTX, walletChainId: 1 })).toEqual({ status: 'wrong_chain', ctx: CTX, walletChainId: 1 });
  });

  it('switching to the expected chain from wrong_chain re-simulates (preparing)', () => {
    expect(txReducer(STATES.wrong_chain, { type: 'chain_changed', chainId: 31337 })).toEqual({ status: 'preparing', ctx: CTX });
  });

  it('switching wrong_chain to another wrong chain updates the reported chain; the same chain is a no-op', () => {
    expect(txReducer(STATES.wrong_chain, { type: 'chain_changed', chainId: 1 })).toEqual({ status: 'wrong_chain', ctx: CTX, walletChainId: 1 });
    expect(txReducer(STATES.wrong_chain, { type: 'chain_changed', chainId: 10 })).toBe(STATES.wrong_chain);
  });

  it.each(['preparing', 'awaiting_signature'] as const)('%s: a chain change to the same chain is a no-op', (status) => {
    expect(txReducer(STATES[status], { type: 'chain_changed', chainId: 31337 })).toBe(STATES[status]);
  });

  it.each(BEFORE_SIGNING)('%s: the same account (any case) is a no-op; another account invalidates', (status) => {
    expect(txReducer(STATES[status], { type: 'account_changed', account: ACCOUNT.toUpperCase().replace('0X', '0x') as Address })).toBe(STATES[status]);
    expect(txReducer(STATES[status], { type: 'account_changed', account: OTHER_ACCOUNT })).toEqual({ status: 'invalidated', ctx: CTX, cause: 'account_changed' });
  });

  it.each(['preparing', 'awaiting_signature'] as const)('%s: a chain change after simulation invalidates', (status) => {
    expect(txReducer(STATES[status], { type: 'chain_changed', chainId: 1 })).toEqual({ status: 'invalidated', ctx: CTX, cause: 'chain_changed' });
  });

  it.each(BEFORE_SIGNING)('%s: the quote deadline invalidates only once it has actually passed', (status) => {
    expect(txReducer(STATES[status], { type: 'deadline_passed', at: '2026-09-25T12:19:59Z' })).toBe(STATES[status]);
    expect(txReducer(STATES[status], { type: 'deadline_passed', at: '2026-09-25T12:20:00Z' })).toEqual({ status: 'invalidated', ctx: CTX, cause: 'deadline_passed' });
    expect(txReducer(STATES[status], { type: 'deadline_passed', at: 'not a time' })).toBe(STATES[status]);
  });

  it('a request without a deadline cannot expire', () => {
    const state: TxState = { status: 'awaiting_signature', ctx: { ...CTX, kind: 'create_launch', deadline: null } };
    expect(txReducer(state, { type: 'deadline_passed', at: '2030-01-01T00:00:00Z' })).toBe(state);
  });

  it('after signing, chain/account/deadline changes do not touch the submitted transaction', () => {
    for (const status of ['submitted', 'pending', 'confirmed_unfinalized'] as const) {
      for (const type of ['chain_changed', 'account_changed', 'deadline_passed'] as const) {
        expect(txReducer(STATES[status], EVENTS[type])).toBe(STATES[status]);
      }
    }
  });

  it('keeps the hash through submitted -> pending -> confirmed -> finalized, and a reorg returns to pending', () => {
    const events: TxEvent[] = [EVENTS.prepare, EVENTS.simulate_ok, EVENTS.sign, EVENTS.broadcast, EVENTS.included, EVENTS.reorged];
    const reorged = events.reduce(txReducer, TX_IDLE);
    expect(reorged).toEqual({ status: 'pending', ctx: CTX, hash: HASH });
    const final = [EVENTS.included, EVENTS.finalized].reduce(txReducer, reorged);
    expect(final).toEqual({ status: 'finalized', ctx: CTX, hash: HASH, block: '39601' });
  });

  it('records the replacement hash; a replacement with the same hash is a no-op', () => {
    expect(txReducer(STATES.pending, EVENTS.replaced)).toEqual({ status: 'replaced', ctx: CTX, hash: HASH, newHash: NEW_HASH });
    expect(txReducer(STATES.pending, { type: 'replaced', newHash: HASH })).toBe(STATES.pending);
  });

  it('keeps the original revert reason (min-out revert)', () => {
    expect(txReducer(STATES.pending, { type: 'reverted', reason: 'min_payout_not_met' })).toEqual({
      status: 'reverted',
      ctx: CTX,
      hash: HASH,
      reason: 'min_payout_not_met',
    });
  });

  it('ignores malformed hashes, blocks and contexts (typed data from an untrusted wallet/RPC)', () => {
    expect(txReducer(STATES.awaiting_signature, { type: 'sign', hash: '0x1234' as `0x${string}` })).toBe(STATES.awaiting_signature);
    expect(txReducer(STATES.pending, { type: 'replaced', newHash: '0xzz' as `0x${string}` })).toBe(STATES.pending);
    expect(txReducer(STATES.pending, { type: 'included', block: '-1' })).toBe(STATES.pending);
    expect(txReducer(TX_IDLE, { type: 'prepare', ctx: { ...CTX, account: '0x12' as `0x${string}` }, walletChainId: 31337 })).toBe(TX_IDLE);
    expect(txReducer(TX_IDLE, { type: 'prepare', ctx: { ...CTX, chainId: 0 }, walletChainId: 31337 })).toBe(TX_IDLE);
    expect(txReducer(TX_IDLE, { type: 'prepare', ctx: { ...CTX, deadline: 'soon' }, walletChainId: 31337 })).toBe(TX_IDLE);
    expect(txReducer(TX_IDLE, { type: 'bogus' } as unknown as TxEvent)).toBe(TX_IDLE);
  });
});

describe('success semantics (UI-08: a hash is never success)', () => {
  it('only finalized is success', () => {
    for (const status of TX_STATUSES) expect(isTxSuccess(STATES[status])).toBe(status === 'finalized');
  });

  it('terminal states accept only reset; timed_out and unknown can still resolve late', () => {
    const terminal = TX_STATUSES.filter((status) => isTxTerminal(STATES[status]));
    expect(terminal.sort()).toEqual(['finalized', 'invalidated', 'rejected', 'replaced', 'reverted', 'simulation_failed']);
    for (const status of terminal) {
      for (const type of TX_EVENT_TYPES) {
        const next = txReducer(STATES[status], EVENTS[type]);
        expect(next === STATES[status] || (type === 'reset' && next.status === 'idle'), `${status}+${type}`).toBe(true);
      }
    }
  });
});
