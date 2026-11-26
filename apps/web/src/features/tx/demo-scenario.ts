/**
 * The tester-facing "Demo scenario" choice (SH-015): which mock executor script the NEXT demo transaction follows.
 * One app-wide value, remembered for the browser session (sessionStorage, best effort: private windows and blocked
 * storage fall back to "success"). A flow reads it when it starts, so changing it never alters a running request.
 */
import { MOCK_TX_SCRIPT_NAMES, type MockTxScriptName } from '@squarehole/providers';
import { useSyncExternalStore } from 'react';

// Renamed from sh.demo-tx-scenario (SH-V2-FE8, F130): the privacy notice shows the key. Tab-only, so nothing to migrate.
const STORAGE_KEY = 'sh.sample-tx-scenario';
const DEFAULT_SCENARIO: MockTxScriptName = 'success';

export const DEMO_SCENARIO_LABELS: Readonly<Record<MockTxScriptName, string>> = Object.freeze({
  success: 'Success: included, then finalized',
  reject: 'The wallet declines the signature',
  simulation_fail: 'Simulation fails before signing',
  revert: 'Included, then reverts',
  min_out_revert: 'Reverts: payout below the signed minimum',
  replace: 'Replaced in the wallet (sped up or cancelled)',
  wrong_chain: 'Wrong network, and the wallet declines the switch',
  wrong_chain_then_switch: 'Wrong network, then the wallet switches',
  timeout: 'No receipt before the wait runs out',
  status_unknown: 'Receipt unavailable: status unknown',
  reorg: 'Included, reorganised out, included again, finalized',
  deadline_expiry: 'Quote deadline passes before signing',
  account_change: 'Wallet account changes before signing',
});

export function isMockTxScriptName(value: unknown): value is MockTxScriptName {
  return typeof value === 'string' && (MOCK_TX_SCRIPT_NAMES as readonly string[]).includes(value);
}

let current: MockTxScriptName | null = null;
const listeners = new Set<() => void>();

function stored(): MockTxScriptName {
  try {
    const value = window.sessionStorage.getItem(STORAGE_KEY);
    return isMockTxScriptName(value) ? value : DEFAULT_SCENARIO;
  } catch {
    return DEFAULT_SCENARIO;
  }
}

export function getDemoTxScenario(): MockTxScriptName {
  if (current === null) current = stored();
  return current;
}

export function setDemoTxScenario(value: MockTxScriptName): void {
  if (!isMockTxScriptName(value) || value === getDemoTxScenario()) return;
  current = value;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage unavailable: the choice still holds for this page.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDemoTxScenario(): MockTxScriptName {
  return useSyncExternalStore(subscribe, getDemoTxScenario, () => DEFAULT_SCENARIO);
}
