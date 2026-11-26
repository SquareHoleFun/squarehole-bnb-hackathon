/**
 * A box's three counters (BOX-INTERFACE § 2): Conversion (the vault), Claims, Market (links out). What a counter offers
 * comes from the state AND the box's capabilities (its kind and set-up), never from the state alone (the mock's
 * `capsFor`). In this launch set no vault or claim writer exists: Conversion shows the state's actions as disabled
 * buttons with one line ("In the app soon"), Claims stays closed, and the only working action is a verified Market link
 * out (opens in a new tab; never a trade form, never a wallet request).
 */
import { failedWords } from '../core/v2/v2-words';
import type { BoxRecord, BoxState } from './box-model';
import { HOLDERS_PENDING } from './spec-network';

export type CounterId = 'conversion' | 'claims' | 'market';

export interface CounterAction {
  readonly id: string;
  readonly label: string;
  /** A working link out (verified route only), or null. */
  readonly href: string | null;
  /** False while the writer does not exist (every vault action in this launch set). */
  readonly enabled: boolean;
}

export interface Counter {
  readonly id: CounterId;
  readonly label: string;
  /** Closed: a shutter and the reason. Open: the actions (enabled or not) and the reason when they are disabled. */
  readonly open: boolean;
  readonly actions: readonly CounterAction[];
  readonly reason: string | null;
}

export interface CounterInput {
  readonly record: BoxRecord;
  readonly state: BoxState | null;
  /** The verified market link (MarketLinks' execution destination), or null. */
  readonly marketLink: { readonly href: string; readonly host: string } | null;
  /** Why there is no link (MarketLinks' state word, "No links in Demo"). */
  readonly marketReason: string;
}

/** Vault actions exist on chain but not in this app yet (VaultCard; the vault-actions task, F36 (b) open). */
export const NOT_IN_APP = 'In the app soon';

const closed = (id: CounterId, label: string, reason: string): Counter => ({ id, label, open: false, actions: [], reason });
const disabled = (id: string, label: string): CounterAction => ({ id, label, href: null, enabled: false });

function conversion(record: BoxRecord, state: BoxState | null): Counter {
  const label = 'Conversion';
  const placeholders = record.kind !== 'existing';
  switch (state) {
    case null:
      return closed('conversion', label, 'Unavailable');
    case 'upcoming':
      return closed('conversion', label, placeholders ? 'Opens with the curve' : 'Opens at graduation');
    case 'window':
    case 'bonding':
      return placeholders ? { id: 'conversion', label, open: true, actions: [disabled('placeholder', 'Get a placeholder')], reason: NOT_IN_APP } : closed('conversion', label, 'Opens at graduation');
    case 'graduating':
      return closed('conversion', label, 'Graduation pending');
    case 'graduated':
      return { id: 'conversion', label, open: true, actions: [disabled('take', placeholders ? 'Take one out' : 'Pick one out'), disabled('return', 'Put it back')], reason: NOT_IN_APP };
    case 'failed':
      return placeholders
        ? { id: 'conversion', label, open: true, actions: [disabled('open', 'Open placeholder'), disabled('handback', 'Hand back')], reason: NOT_IN_APP }
        : closed('conversion', label, 'NFTs go back to the depositor');
  }
}

function claims(record: BoxRecord, state: BoxState | null): Counter {
  const label = 'Claims';
  if (record.claims === 'none') return closed('claims', label, 'No claims in this set-up');
  if (record.claims === 'per-item' && state !== 'graduated') return closed('claims', label, 'After graduation');
  if (state === 'failed') return closed('claims', label, 'Credited claims stay · not built yet');
  // Holder claims (the Demo only, F74 U1): the words of their tile and of About.
  if (record.claims === 'holders') return closed('claims', label, HOLDERS_PENDING ?? 'Not built yet');
  return closed('claims', label, 'Not built yet');
}

function market(input: CounterInput): Counter {
  const label = 'Market';
  const { state, marketLink, marketReason } = input;
  if (state === null) return closed('market', label, 'Unavailable');
  if (state === 'upcoming') return closed('market', label, 'Starts with the curve');
  if (marketLink === null) return closed('market', label, marketReason);
  const failed = state === 'failed';
  const v2 = input.record.v2 !== undefined;
  return { id: 'market', label, open: true, actions: [{ id: failed && !v2 ? 'refund' : 'market', label: failed ? failedWords(v2).market : 'Open on Uniswap', href: marketLink.href, enabled: true }], reason: null };
}

/**
 * The counters a box shows: Conversion, Claims, Market; a token-only box (F70 "Nothing") has no vault, so no Conversion
 * (a closed "No items in this box" tile would only say what the box is not).
 */
export function countersFor(input: CounterInput): readonly Counter[] {
  const rest = [claims(input.record, input.state), market(input)];
  return input.record.kind === 'token' ? rest : [conversion(input.record, input.state), ...rest];
}

/**
 * What the phone's compact bar says when nothing can be done in the app: nothing for most states (the "Counters" pill
 * opens all three), and for a failed box where its refund goes ("Refund · No links in Demo"). A failed box with a
 * verified link has a working action instead.
 */
export function phoneBarNote(counters: readonly Counter[], state: BoxState | null, v2 = false): string | null {
  if (state !== 'failed') return null;
  const market = counters.find((counter) => counter.id === 'market');
  return `${failedWords(v2).phone} · ${market?.reason ?? 'Unavailable'}`;
}

/** Whether a counter is open but none of its actions is built in this app (shown like a closed counter, with a lock). */
export const notBuilt = (counter: Counter): boolean => counter.open && counter.actions.length > 0 && counter.actions.every((action) => !action.enabled);

/** The phone's sticky bar: the one working action, or "Nothing to do yet" and why. */
export function primaryAction(counters: readonly Counter[]): { readonly counter: Counter; readonly action: CounterAction } | { readonly reason: string } {
  for (const counter of counters) {
    const action = counter.actions.find((candidate) => candidate.enabled);
    if (action) return { counter, action };
  }
  return { reason: counters[0]?.reason ?? 'Unavailable' };
}
