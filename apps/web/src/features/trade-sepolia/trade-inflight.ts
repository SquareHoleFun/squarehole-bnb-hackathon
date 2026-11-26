/**
 * F156 (SH-ALPHA-TRADE-BOX, SH-ALPHA-TEST-COINS): one send at a time per account and chain, for the whole visit. A page
 * keeps its own state, which goes when the page does; this module stays with the lazily loaded chunk while the visitor
 * moves between pages, so a box opened again (or another box, or the test-coin page) sees a send still waiting for the
 * wallet or the chain and holds every new plan until it settles. A full reload starts empty; the page then holds while
 * the site's RPC shows anything pending for the account (use-sends.ts).
 *
 * Every entry has its own id, and only that id updates or ends it: a box that went away and finishes late can never
 * touch the slot of a later send (compare and set).
 */
import type { CoinPlan, TradeCall, TradePlan } from '@squarehole/chain/trade-sepolia';
import type { SendTrack } from './trade-run';

/** A plan a send belongs to: a box trade's, or a coin action's (the faucet's drip, a pair swap). */
export type SentPlan = TradePlan | CoinPlan;

export interface SentStep {
  /** The plan's exact approval, its own call (a trade, a drip, a swap), or the revocation of what it left approved. */
  readonly step: 'approve' | 'trade' | 'revoke';
  readonly plan: SentPlan;
  readonly call: TradeCall;
  readonly gasLimit: bigint;
}

export interface InFlightSend {
  readonly id: number;
  readonly sent: SentStep;
  /** The wallet has the request and has not answered yet. */
  readonly asking: boolean;
  readonly track: SendTrack;
}

const sends = new Map<string, InFlightSend>();
let lastId = 0;

/** `${chainId}|${account}` (the account in lower case). */
export const sendKey = (chainId: number, account: string): string => `${chainId}|${account.toLowerCase()}`;
export const inFlightOf = (key: string): InFlightSend | null => sends.get(key) ?? null;

/** Takes the account's one slot: the new entry's id, or null when a send is already under way there. */
export function beginInFlight(key: string, entry: Omit<InFlightSend, 'id'>): number | null {
  if (sends.has(key)) return null;
  const id = ++lastId;
  sends.set(key, { ...entry, id });
  return id;
}

/** Changes the entry `id`, if it still holds the slot. */
export function updateInFlight(key: string, id: number, patch: Partial<Omit<InFlightSend, 'id'>>): void {
  const entry = sends.get(key);
  if (entry && entry.id === id) sends.set(key, { ...entry, ...patch });
}

/** Frees the slot, if entry `id` still holds it. */
export function endInFlight(key: string, id: number): void {
  if (sends.get(key)?.id === id) sends.delete(key);
}

/** Test support: a fresh visit. */
export function clearInFlight(): void {
  sends.clear();
}
