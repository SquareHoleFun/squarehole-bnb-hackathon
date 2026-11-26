/**
 * Turns a mock executor script (`createMockTxExecutor(...).events(ctx)`) into an interactive profile: which events the
 * scenario injects by itself, and where the flow waits for the person (network switch, signature). The events come
 * from the executor unchanged, so the rendered flow and the executor's own tests share one source of truth.
 */
import type { TxContext, TxEvent, TxHash } from '@squarehole/domain';
import { createMockTxExecutor, mockTxHash, type MockTxScriptName } from '@squarehole/providers';

type EventOf<T extends TxEvent['type']> = Extract<TxEvent, { type: T }>;
export type SimulationEvent = EventOf<'simulate_ok'> | EventOf<'simulate_fail'>;

export interface TxScriptProfile {
  /** The chain the scenario makes the wallet report at preparation (wrong-chain scenarios), else null. */
  readonly scriptedWalletChainId: number | null;
  /** False when the scenario's wallet declines a network switch (`wrong_chain`). */
  readonly switchAccepted: boolean;
  readonly simulation: SimulationEvent;
  /** Events the scenario injects while waiting for a signature (quote deadline, account change). */
  readonly whileAwaitingSignature: readonly TxEvent[];
  /** The scenario's wallet declines the signature request by itself (`reject`). */
  readonly walletDeclines: boolean;
  readonly signHash: TxHash;
  /** Everything after signing: broadcast, inclusion, reorg, finality, revert, replacement, timeout… */
  readonly afterSigning: readonly TxEvent[];
}

const isType =
  <T extends TxEvent['type']>(...types: T[]) =>
  (event: TxEvent): event is EventOf<T> =>
    (types as string[]).includes(event.type);

const successTail = (ctx: TxContext): readonly TxEvent[] => {
  const events = createMockTxExecutor({ script: 'success' }).events(ctx);
  return events.slice(events.findIndex(isType('sign')) + 1);
};

export function txScriptProfile(script: MockTxScriptName, ctx: TxContext): TxScriptProfile {
  const events = createMockTxExecutor({ script }).events(ctx);
  const prepare = events.find(isType('prepare'));
  const scriptedWalletChainId = prepare && prepare.walletChainId !== ctx.chainId ? prepare.walletChainId : null;
  const simulationIndex = events.findIndex(isType('simulate_ok', 'simulate_fail'));
  const decisionIndex = events.findIndex(isType('sign', 'reject'));
  const sign = events.find(isType('sign'));
  const signIndex = sign ? events.indexOf(sign) : -1;
  const simulation = simulationIndex >= 0 ? (events[simulationIndex] as SimulationEvent) : { type: 'simulate_ok' as const };
  const waiting = simulationIndex >= 0 ? events.slice(simulationIndex + 1, decisionIndex >= 0 ? decisionIndex : undefined) : [];

  return Object.freeze({
    scriptedWalletChainId,
    switchAccepted: scriptedWalletChainId === null || events.some(isType('chain_changed')),
    simulation,
    // A scripted deadline on a request without one is a reducer no-op, so it must not stand in for the person's decision.
    whileAwaitingSignature: Object.freeze(
      waiting.filter(isType('deadline_passed', 'account_changed')).filter((event) => event.type !== 'deadline_passed' || ctx.deadline !== null),
    ),
    walletDeclines: events.some(isType('reject')),
    signHash: sign?.hash ?? mockTxHash(1),
    afterSigning: Object.freeze(signIndex >= 0 ? events.slice(signIndex + 1) : successTail(ctx)),
  });
}
