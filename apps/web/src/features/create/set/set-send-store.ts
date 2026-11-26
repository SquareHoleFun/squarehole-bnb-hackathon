/**
 * SH-EXISTING-NFTS-E08C: the set box being created in this tab (set-send.ts `SetRun`): its spec bytes, salts, predicted
 * addresses, bootstrap, committed ids and each step's last sent hash, so a reload resumes the same box from the chain's
 * state. For this tab only (sessionStorage `sh.create.set-send.v1`, listed in the privacy notice), best effort: every
 * access in try/catch; without it a run still works until the page closes. A stored run is checked again against the
 * chain before use.
 */
import { isAddress, type Address, type Hex } from 'viem';
import type { SetRun } from './set-send';

const KEY = 'sh.create.set-send.v1';
const HEX = /^0x(?:[0-9a-fA-F]{2})+$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const RAW = /^(0|[1-9][0-9]{0,77})$/;

let memory: SetRun | null = null;

/** The stored run, or null when there is none or it is not one. */
export function parseSetRun(value: unknown): SetRun | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const address = (x: unknown): x is Address => typeof x === 'string' && isAddress(x);
  const sent = v.sent;
  if (!Number.isSafeInteger(v.chainId) || (v.chainId as number) <= 0 || !address(v.creator) || !address(v.factory) || !address(v.coordinator) || !address(v.token)
    || typeof v.encoded !== 'string' || !HEX.test(v.encoded) || typeof v.cs !== 'string' || !WORD.test(v.cs) || typeof v.hs !== 'string' || !WORD.test(v.hs)
    || typeof v.bootstrapQ !== 'string' || !RAW.test(v.bootstrapQ) || !Array.isArray(v.ids) || v.ids.length > 10_000 || !v.ids.every((id) => typeof id === 'string' && RAW.test(id))
    || sent === null || typeof sent !== 'object' || !Object.values(sent as Record<string, unknown>).every((hash) => typeof hash === 'string' && WORD.test(hash))) return null;
  return { chainId: v.chainId as number, creator: v.creator, factory: v.factory, encoded: v.encoded as Hex, cs: v.cs as Hex, hs: v.hs as Hex,
    coordinator: v.coordinator, token: v.token, bootstrapQ: v.bootstrapQ, ids: [...(v.ids as string[])], sent: { ...(sent as Record<string, Hex>) } };
}

export function loadSetRun(): SetRun | null {
  try {
    const text = window.sessionStorage.getItem(KEY);
    if (text !== null) memory = parseSetRun(JSON.parse(text));
  } catch {
    // Blocked storage or a damaged value: the run in memory, if any.
  }
  return memory;
}

export function saveSetRun(run: SetRun): void {
  memory = run;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(run));
  } catch {
    // Kept in memory for this page.
  }
}

export function clearSetRun(): void {
  memory = null;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
}
