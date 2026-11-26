/**
 * TA-22: the box being created in this tab (create-send.ts `CreateRunV2`): its spec bytes, salts, predicted addresses,
 * bootstrap, a shop's starter items (SH-SHOP-CREATE: the spec commits only their hash) and each step's last sent hash,
 * so that a reload resumes the same box from the chain's state. For this tab only (sessionStorage), best effort: every
 * access in try/catch; without it a run still works until the page closes. Listed in the privacy notice
 * (features/legal/privacy.ts).
 */
import { isAddress, type Address, type Hex } from 'viem';
import type { CreateRunV2, RunStarterV2 } from './create-send';

const KEY = 'sh.create.send.v2';
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const RAW = /^(0|[1-9][0-9]{0,77})$/;
const KIND = /^[A-Za-z]{1,32}$/;

let memory: CreateRunV2 | null = null;

/** The stored run, or null when there is none or it is not one (a run is checked again against the chain before use). */
export function parseRunV2(value: unknown): CreateRunV2 | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const address = (x: unknown): x is Address => typeof x === 'string' && isAddress(x);
  const sent = v.sent;
  if (!Number.isSafeInteger(v.chainId) || (v.chainId as number) <= 0 || !address(v.creator) || !address(v.factory) || !address(v.coordinator) || !address(v.token)
    || typeof v.encoded !== 'string' || !HEX.test(v.encoded) || typeof v.cs !== 'string' || !WORD.test(v.cs) || typeof v.hs !== 'string' || !WORD.test(v.hs)
    || typeof v.bootstrapQ !== 'string' || !RAW.test(v.bootstrapQ) || sent === null || typeof sent !== 'object'
    || !Object.values(sent as Record<string, unknown>).every((hash) => typeof hash === 'string' && WORD.test(hash))) return null;
  // A shop's starter items, each a collection, a raw id and a tier 0 to 3 (checked again against the spec's hash before use).
  const starter = (x: unknown): x is RunStarterV2 => x !== null && typeof x === 'object' && address((x as RunStarterV2).collection)
    && typeof (x as RunStarterV2).id === 'string' && RAW.test((x as RunStarterV2).id) && [0, 1, 2, 3].includes((x as RunStarterV2).tier);
  if (v.starters !== undefined && (!Array.isArray(v.starters) || !v.starters.every(starter))) return null;
  const starters = v.starters as readonly RunStarterV2[] | undefined;
  return { chainId: v.chainId as number, creator: v.creator, factory: v.factory, encoded: v.encoded as Hex, cs: v.cs as Hex, hs: v.hs as Hex,
    coordinator: v.coordinator, token: v.token, bootstrapQ: v.bootstrapQ,
    ...(starters && starters.length > 0 ? { starters: starters.map((item) => ({ collection: item.collection, id: item.id, tier: item.tier })) } : {}),
    sent: { ...(sent as Record<string, Hex>) }, ...(v.walletPending === true ? { walletPending: true } : {}),
    // SH-256 E1b: the pending request's kind, a call kind's word; anything else is dropped (the run then counts as
    // possibly past its approvals, the careful side).
    ...(v.walletPending === true && typeof v.walletPendingKind === 'string' && KIND.test(v.walletPendingKind) ? { walletPendingKind: v.walletPendingKind } : {}) };
}

export function loadRunV2(): CreateRunV2 | null {
  try {
    const text = window.sessionStorage.getItem(KEY);
    if (text !== null) memory = parseRunV2(JSON.parse(text));
  } catch {
    // Blocked storage or a damaged value: the run in memory, if any.
  }
  return memory;
}

export function saveRunV2(run: CreateRunV2): void {
  memory = run;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(run));
  } catch {
    // Kept in memory for this page.
  }
}

export function clearRunV2(): void {
  memory = null;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
}
