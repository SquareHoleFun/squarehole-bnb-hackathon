/**
 * Where personal data comes from (SH-014). Stage A is demo-only: one mock account provider per `?scenario=`, driven
 * by the demo clock (so quotes expire together with the transaction deadline watch), wrapped with this tab's demo
 * settlement ledger. Stage C replaces the source with a chain-backed `AccountProvider` behind the same boundary.
 */
import type { AccountProvider } from '@squarehole/domain';
import { MOCK_ACCOUNT_SCENARIOS, createMockAccountProvider, type MockAccountScenario } from '@squarehole/providers';
import { demoNow } from '../tx';
import { createDemoSettlementLedger, withDemoSettlements, type DemoSettlementLedger } from './demo-settlements';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export type AccountScenario = MockAccountScenario;
export type AccountMode = 'demo' | 'live';

export interface AccountSource {
  readonly provider: AccountProvider;
  /** Demo labelling follows the source mode, never the data's own provenance text. */
  readonly mode: AccountMode;
}

export type AccountSourceFor = (scenario: AccountScenario) => AccountSource;

export interface AccountSources {
  readonly sourceFor: AccountSourceFor;
  /** Demo only: where finalized demo claims are recorded. Null for a chain-backed source (the chain records them). */
  readonly settlements: DemoSettlementLedger | null;
}

// The mock scenarios exist only with the Demo (the production site reads none of them).
export const ACCOUNT_SCENARIOS: readonly AccountScenario[] = DEMO_BUILD ? MOCK_ACCOUNT_SCENARIOS : [];

export function isAccountScenario(value: unknown): value is AccountScenario {
  return DEMO_BUILD && typeof value === 'string' && (MOCK_ACCOUNT_SCENARIOS as readonly string[]).includes(value);
}

export interface DemoAccountSourceOptions {
  /** Demo clock as an ISO string (default: the app's demo clock). */
  readonly now?: () => string;
  /** Simulated provider latency in ms (default 0). */
  readonly latencyMs?: number;
}

/**
 * Where personal data comes from when no source is given: the production site always has its chain session's, so this
 * one never answers, it fails every read (the pages then say "unavailable").
 */
export const NO_ACCOUNT_SOURCES: AccountSources = (() => {
  const fail = (): Promise<never> => Promise.reject(new Error('No account source in this build'));
  const source: AccountSource = Object.freeze({ provider: Object.freeze({ readClaim: fail, listPositions: fail, listClaims: fail }), mode: 'live' });
  return Object.freeze({ sourceFor: () => source, settlements: null });
})();

/** One mock provider per scenario (created lazily), all sharing one settlement ledger for this tab. */
export function createDemoAccountSources(options: DemoAccountSourceOptions = {}): AccountSources {
  const settlements = createDemoSettlementLedger();
  const sources = new Map<AccountScenario, AccountSource>();
  const sourceFor: AccountSourceFor = (scenario) => {
    const existing = sources.get(scenario);
    if (existing) return existing;
    const mock = createMockAccountProvider({ scenario, now: options.now ?? demoNow, latencyMs: options.latencyMs ?? 0 });
    const source: AccountSource = Object.freeze({ provider: withDemoSettlements(mock, settlements), mode: 'demo' });
    sources.set(scenario, source);
    return source;
  };
  return Object.freeze({ sourceFor, settlements });
}
