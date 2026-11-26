/**
 * Deterministic MOCK transaction executor (SH-015; 06-ARCHITECTURE; UI-08; ECO-07). It never signs, never talks to
 * a wallet or RPC and never broadcasts anything: it replays scripted `TxEvent` sequences through the domain
 * `txReducer` so creation and claim screens can be built and tested against every outcome. Hashes are obviously
 * synthetic (`...6d6f636b` = "mock"). A scripted hash is never success; only `finalized` is.
 */
import { TX_IDLE, txReducer, type TxContext, type TxEvent, type TxHash, type TxState } from '@squarehole/domain';
import { delay, throwIfAborted } from '../abort';

export const MOCK_TX_LABEL = 'Mock transaction: nothing is signed or broadcast';

export const MOCK_TX_SCRIPT_NAMES = [
  'success',
  'reject',
  'simulation_fail',
  'revert',
  'min_out_revert',
  'replace',
  'wrong_chain',
  'wrong_chain_then_switch',
  'timeout',
  'status_unknown',
  'reorg',
  'deadline_expiry',
  'account_change',
] as const;
export type MockTxScriptName = (typeof MOCK_TX_SCRIPT_NAMES)[number];

/** The chain a mock wallet reports in the wrong-chain scripts (any id other than the request's chain). */
const MOCK_WRONG_CHAIN_ID = 1;
/** Another synthetic demo account for the account-change script. */
const MOCK_OTHER_ACCOUNT = '0x00000000000000000000000000000000de0000ff';

/** Synthetic hash n: 52 zero nibbles, "mock" in hex, then n as 4 hex digits. */
export function mockTxHash(n: number): TxHash {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new RangeError('mock hash index must be 0..65535');
  return `0x${'0'.repeat(52)}6d6f636b${n.toString(16).padStart(4, '0')}`;
}

const signed = (): TxEvent[] => [
  { type: 'simulate_ok' },
  { type: 'sign', hash: mockTxHash(1) },
  { type: 'broadcast' },
];

const SCRIPTS: Readonly<Record<MockTxScriptName, (ctx: TxContext) => TxEvent[]>> = {
  success: (ctx) => [{ type: 'prepare', ctx, walletChainId: ctx.chainId }, ...signed(), { type: 'included', block: '39601' }, { type: 'finalized' }],
  reject: (ctx) => [{ type: 'prepare', ctx, walletChainId: ctx.chainId }, { type: 'simulate_ok' }, { type: 'reject' }],
  simulation_fail: (ctx) => [{ type: 'prepare', ctx, walletChainId: ctx.chainId }, { type: 'simulate_fail', reason: 'mock: simulation reverted' }],
  revert: (ctx) => [{ type: 'prepare', ctx, walletChainId: ctx.chainId }, ...signed(), { type: 'reverted', reason: 'mock: execution reverted' }],
  min_out_revert: (ctx) => [{ type: 'prepare', ctx, walletChainId: ctx.chainId }, ...signed(), { type: 'reverted', reason: 'min_payout_not_met' }],
  replace: (ctx) => [{ type: 'prepare', ctx, walletChainId: ctx.chainId }, ...signed(), { type: 'replaced', newHash: mockTxHash(2) }],
  wrong_chain: (ctx) => [{ type: 'prepare', ctx, walletChainId: MOCK_WRONG_CHAIN_ID }],
  wrong_chain_then_switch: (ctx) => [
    { type: 'prepare', ctx, walletChainId: MOCK_WRONG_CHAIN_ID },
    { type: 'chain_changed', chainId: ctx.chainId },
    ...signed(),
    { type: 'included', block: '39601' },
    { type: 'finalized' },
  ],
  timeout: (ctx) => [{ type: 'prepare', ctx, walletChainId: ctx.chainId }, ...signed(), { type: 'timeout' }],
  status_unknown: (ctx) => [{ type: 'prepare', ctx, walletChainId: ctx.chainId }, ...signed(), { type: 'status_unknown', reason: 'mock: receipt unavailable' }],
  reorg: (ctx) => [
    { type: 'prepare', ctx, walletChainId: ctx.chainId },
    ...signed(),
    { type: 'included', block: '39601' },
    { type: 'reorged' },
    { type: 'included', block: '39602' },
    { type: 'finalized' },
  ],
  // Requires a request deadline; without one the event is (correctly) a no-op.
  deadline_expiry: (ctx) => [
    { type: 'prepare', ctx, walletChainId: ctx.chainId },
    { type: 'simulate_ok' },
    { type: 'deadline_passed', at: ctx.deadline ?? '9999-12-31T23:59:59Z' },
  ],
  account_change: (ctx) => [
    { type: 'prepare', ctx, walletChainId: ctx.chainId },
    { type: 'simulate_ok' },
    { type: 'account_changed', account: MOCK_OTHER_ACCOUNT },
  ],
};

export interface TxTrace {
  readonly events: readonly TxEvent[];
  /** State after each event (same length as `events`); an illegal event repeats the previous state object. */
  readonly states: readonly TxState[];
  readonly final: TxState;
}

export interface MockTxExecutor {
  readonly mode: 'mock';
  readonly label: typeof MOCK_TX_LABEL;
  /** The scripted events for a request context. */
  events(ctx: TxContext): readonly TxEvent[];
  /** Replays the whole script synchronously. */
  run(ctx: TxContext): TxTrace;
  /** Replays the script one event per `stepMs` (injected timers; honours abort), reporting each state. */
  play(ctx: TxContext, onState: (state: TxState) => void, options?: { stepMs?: number; signal?: AbortSignal }): Promise<TxState>;
}

export function createMockTxExecutor(options: { script: MockTxScriptName | readonly TxEvent[] }): MockTxExecutor {
  const { script } = options;
  if (typeof script === 'string' && !MOCK_TX_SCRIPT_NAMES.includes(script)) {
    throw new RangeError(`Unknown mock transaction script; expected one of ${MOCK_TX_SCRIPT_NAMES.join(', ')}`);
  }
  const events = (ctx: TxContext): readonly TxEvent[] => Object.freeze(typeof script === 'string' ? SCRIPTS[script](ctx) : [...script]);

  return {
    mode: 'mock',
    label: MOCK_TX_LABEL,
    events,

    run(ctx: TxContext): TxTrace {
      const scripted = events(ctx);
      const states: TxState[] = [];
      let state = TX_IDLE;
      for (const event of scripted) {
        state = txReducer(state, event);
        states.push(state);
      }
      return Object.freeze({ events: scripted, states: Object.freeze(states), final: state });
    },

    async play(ctx, onState, { stepMs = 0, signal } = {}): Promise<TxState> {
      if (!Number.isSafeInteger(stepMs) || stepMs < 0) throw new RangeError('stepMs must be a non-negative integer');
      let state = TX_IDLE;
      for (const event of events(ctx)) {
        throwIfAborted(signal);
        if (stepMs > 0) await delay(stepMs, signal);
        state = txReducer(state, event);
        onState(state);
      }
      return state;
    },
  };
}
