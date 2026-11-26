/**
 * F166 (SH-ALPHA-ONBOARDING): this device's hint of where the alpha's "Set me up" stands for one X account, so the app's
 * pages know which button to offer ("Set me up", "Finish setup" or none) without reading the chain on every load. A hint
 * only, as the made wallet's memory is (trade-sepolia/made-wallet.ts): every step the press runs reads our server, the
 * chain and Privy again (trade-sepolia/setup-run.ts), and what is offered is decided with our server's claim
 * (alpha-sepolia/welcome-gate.ts `welcomeOffer`): a setup's hint stands only for the claim it made. Nothing here runs a
 * step, and nothing is sent anywhere.
 *
 * `features/legal/privacy.ts` lists the key in the Sepolia trade builds (`STORED_ON_DEVICE`, `SETUP_HINT_ITEM`).
 */
import type { StoredItem } from '../legal/privacy';

export const SETUP_HINT_KEY = 'sh.alpha.setup.v1';
/**
 * X's own handle rule, as alpha-api.ts `X_HANDLE` has it (setup-hint.test.ts keeps the two equal). Not imported from
 * there: the privacy notice reads this module at first paint, and alpha-api.ts belongs to the pages that call our server.
 */
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
/** A claim's id, as our server gives it (alpha-api.ts `UUID`). */
const CLAIM_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/**
 * - `started`: "Set me up" was pressed here and the setup has not ended: a later visit offers "Finish setup" while our
 *   server's claim is none, one the sender's dry run freed, or the one this setup made (`claimId`).
 * - `done`: it ended with the first tETH (or found it taken): nothing more is offered.
 * - `ended`: it ended where no press can help (a refused or failed claim, a claim for another wallet): nothing more is
 *   offered; the Claim card shows where the claim stands.
 * - `manual`: today's steps were chosen ("I'll do it myself") or used (a claim made on the Claim card's own steps):
 *   nothing more is offered, and the Claim card opens on those steps.
 */
export type SetupHintState = 'started' | 'done' | 'ended' | 'manual';
const STATES: readonly SetupHintState[] = ['started', 'done', 'ended', 'manual'];

export interface SetupHint {
  /** The X account the hint is for (another account signed in on this device gets no hint). */
  readonly handle: string;
  readonly state: SetupHintState;
  /** The claim this device's setup made, once it made one. */
  readonly claimId?: string | null;
}

/** A hint as read back for its account. */
export interface SetupHintRecord {
  readonly state: SetupHintState;
  readonly claimId: string | null;
}

type HintStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const deviceStorage = (): HintStorage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** The hint for `handle`, or null (none, another account's, unreadable or not well formed: never trusted as more). */
export function readSetupHint(handle: string, storage: HintStorage | null = deviceStorage()): SetupHintRecord | null {
  let raw: string | null;
  try {
    raw = storage?.getItem(SETUP_HINT_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const hint = value as Partial<Record<keyof SetupHint, unknown>>;
  if (typeof hint.handle !== 'string' || !X_HANDLE.test(hint.handle) || !STATES.includes(hint.state as SetupHintState)) return null;
  if (hint.claimId !== undefined && hint.claimId !== null && (typeof hint.claimId !== 'string' || !CLAIM_ID.test(hint.claimId))) return null;
  if (hint.handle.toLowerCase() !== handle.toLowerCase()) return null;
  return Object.freeze({ state: hint.state as SetupHintState, claimId: typeof hint.claimId === 'string' ? hint.claimId : null });
}

/** Keeps the hint for one account (the last one written wins); storage this browser refuses keeps nothing. */
export function writeSetupHint(hint: SetupHint, storage: HintStorage | null = deviceStorage()): void {
  const claimId = hint.claimId ?? null;
  if (!X_HANDLE.test(hint.handle) || !STATES.includes(hint.state) || (claimId !== null && !CLAIM_ID.test(claimId))) return;
  try {
    storage?.setItem(SETUP_HINT_KEY, JSON.stringify({ handle: hint.handle, state: hint.state, claimId }));
  } catch {
    // Storage unavailable (a private window, blocked site data): the pages then offer the choice again.
  }
}

/** What the privacy notice and the join page list for this key (Sepolia trade builds only). */
export const SETUP_HINT_ITEM: StoredItem = Object.freeze({
  key: SETUP_HINT_KEY,
  store: 'localStorage',
  what: 'Your X handle, how far the alpha’s setup got on this device and the claim it made, so the app shows the right button. Nothing is sent from it.',
  source: 'apps/web/src/features/alpha-sepolia/setup-hint.ts',
});
