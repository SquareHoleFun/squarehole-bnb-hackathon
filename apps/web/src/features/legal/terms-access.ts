import { createContext, useContext } from 'react';
import { TERMS_PATH } from './terms';

/**
 * Whether the visitor has accepted the current Terms, for the app frame (F19). TermsGate provides it around the routes
 * it lets through: false only on the gate-free pages (the full Terms, About & risks, the privacy notice) before
 * acceptance. Without a gate above it (unit tests of the shell on its own) the app counts as accepted.
 */
export const TermsAccessContext = createContext<boolean>(true);

/** False while the visitor reads a gate-free page without having accepted: the frame hides wallet, launch and search. */
export function useTermsAccess(): boolean {
  return useContext(TermsAccessContext);
}

/** Router state the gate's "Read the full Terms" link carries, so the Terms page can lead back to the requested page. */
export interface TermsReturnState {
  readonly from: string;
}

/** The in-app path a visitor came from (the gate's link state), or null for anything else or a path back to the Terms. */
export function termsReturnPath(state: unknown): string | null {
  if (typeof state !== 'object' || state === null || !('from' in state)) return null;
  const { from } = state as { from: unknown };
  if (typeof from !== 'string' || from.length > 2048 || !from.startsWith('/') || from.startsWith('//') || from.includes('\\')) return null;
  if (from === TERMS_PATH || from.startsWith(`${TERMS_PATH}/`) || from.startsWith(`${TERMS_PATH}?`) || from.startsWith(`${TERMS_PATH}#`)) return null;
  return from;
}
