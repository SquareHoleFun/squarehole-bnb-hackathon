/**
 * The Demo vault's history per Demo scenario (mock data, labelled Demo): how many placeholders were taken during the
 * curve and how many Misfits came back after graduation. One plan drives both the Demo vault counters (useLivePool.ts)
 * and the Demo price picture (boxes/demo-vault.ts), so the dependency runs one way: boxes → fit-pair.
 *
 * 0, 4, 37 and 112 placeholders before, in, after the window and at the target; 22 of the 112 back in the vault after
 * graduation.
 */
import type { DemoScenario } from './demo-chain';

export interface DemoVaultPlan {
  /** Placeholders taken during the curve. */
  readonly takes: bigint;
  /** Misfits put back after graduation. */
  readonly returns: bigint;
  readonly graduated: boolean;
}

const CURVE_PLAN: DemoVaultPlan = Object.freeze({ takes: 37n, returns: 0n, graduated: false });

/** The Demo scenarios' vault histories (a Map: the key comes from the URL). */
const PLANS: ReadonlyMap<DemoScenario, DemoVaultPlan> = new Map<DemoScenario, DemoVaultPlan>([
  ['before_open', Object.freeze({ takes: 0n, returns: 0n, graduated: false })],
  ['window', Object.freeze({ takes: 4n, returns: 0n, graduated: false })],
  ['curve', CURVE_PLAN],
  ['stale', CURVE_PLAN],
  ['unverified', CURVE_PLAN],
  ['reorg', CURVE_PLAN],
  ['completed', Object.freeze({ takes: 112n, returns: 0n, graduated: false })],
  ['migrated', Object.freeze({ takes: 112n, returns: 22n, graduated: true })],
]);

export function demoVaultPlan(scenario: DemoScenario): DemoVaultPlan {
  return PLANS.get(scenario) ?? CURVE_PLAN;
}
