/**
 * SH-EXISTING-NFTS-E08C: one set action at a time on a box page, and its status line in a few words: what the wallet
 * is asked now, or how it ended. After every action the page's reads start again (the box, its members, the holders).
 */
import { useState } from 'react';
import type { SetActionStep } from './set-actions';
import { setErrorText } from './set-errors';
import { forgetOwners } from './set-owners';

export type SetRunStatus = { readonly state: 'running' | 'done' | 'failed'; readonly text: string };

const STEP_WORDS: Readonly<Record<SetActionStep, string>> = { checking: 'Checking…', approve: 'Approve in your wallet…', send: 'Confirm in your wallet…' };

export function useSetRun(refresh: () => unknown) {
  const [status, setStatus] = useState<SetRunStatus | null>(null);
  const busy = status?.state === 'running';
  /** `done` is the closing line, or made from what the work found (a release says how many went back). */
  const run = async <T,>(work: (onStep: (step: SetActionStep) => void) => Promise<T>, done: string | ((result: T) => string)): Promise<boolean> => {
    if (busy) return false;
    setStatus({ state: 'running', text: STEP_WORDS.checking });
    try {
      const result = await work((step) => setStatus({ state: 'running', text: STEP_WORDS[step] }));
      setStatus({ state: 'done', text: typeof done === 'function' ? done(result) : done });
      return true;
    } catch (error) {
      setStatus({ state: 'failed', text: setErrorText(error) });
      return false;
    } finally {
      forgetOwners();
      void refresh();
    }
  };
  return { status, busy, run, clear: () => setStatus(null) };
}
