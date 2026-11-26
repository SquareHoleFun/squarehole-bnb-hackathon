import { createContext, useContext, type ReactNode } from 'react';
import { demoNowMs } from './demo-clock';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export interface TxFlowConfig {
  /** Delay between scripted steps, so each state is visible (tests pass 0 or use fake timers). */
  readonly stepMs: number;
  /** Clock for deadlines, epoch ms. */
  readonly now: () => number;
  /**
   * Whether a request without a chain spec may run the demo flow (default true). Chain data sources set it to false,
   * so a page that forgot its chain spec can never show a scripted demo "success" next to real chain data.
   */
  readonly demoFlows?: boolean;
}

/** Demo builds keep the mock executor for the demo fixtures; chain data sources use `CHAIN_TX_FLOW_CONFIG`. */
export const TX_DEMO_MODE = DEMO_BUILD;

/** Chain data sources: wall-clock deadlines (quotes come from the chain) and no demo flows. */
export const CHAIN_TX_FLOW_CONFIG: TxFlowConfig = Object.freeze({ stepMs: 0, now: () => Date.now(), demoFlows: false });

/** The default: the Demo's clock and flows; the production site's is the chain's (it has no Demo). */
export const DEFAULT_TX_FLOW_CONFIG: TxFlowConfig = DEMO_BUILD ? Object.freeze({ stepMs: 700, now: demoNowMs, demoFlows: true }) : CHAIN_TX_FLOW_CONFIG;

const TxFlowConfigContext = createContext<TxFlowConfig>(DEFAULT_TX_FLOW_CONFIG);

/** Test seam: step timing and clock for every `useTxFlow` below it. The app uses the defaults. */
export function TxFlowConfigProvider({ value, children }: { value: TxFlowConfig; children: ReactNode }) {
  return <TxFlowConfigContext.Provider value={value}>{children}</TxFlowConfigContext.Provider>;
}

export function useTxFlowConfig(): TxFlowConfig {
  return useContext(TxFlowConfigContext);
}
