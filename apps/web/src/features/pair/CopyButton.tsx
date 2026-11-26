import { useEffect, useState } from 'react';
import { CheckIcon, CopyIcon } from './pair-icons';

type CopyState = 'idle' | 'copied' | 'failed';

const RESET_MS = 4000;

/** What a failed copy says by default: the value is an address. */
const COPY_FAILED = 'Copy failed: select the address and copy it by hand.';

/**
 * Copies an identity (an address) to the clipboard. Never touches a wallet (EXT-04). Clipboard access can be missing
 * or refused (insecure context, permissions), so failure is reported in words and the value stays selectable text.
 * `failed` names what to select when the value is not an address (SH-AI-PLAN: the plan guide's prompt).
 */
export function CopyButton({ value, label, failed = COPY_FAILED }: { value: string; label: string; failed?: string }) {
  const [state, setState] = useState<CopyState>('idle');

  useEffect(() => {
    if (state === 'idle') return undefined;
    const timer = window.setTimeout(() => setState('idle'), RESET_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <span className="sh-copy" data-copy-state={state}>
      <button type="button" className="sh-copy__button" aria-label={label} onClick={() => void copy()}>
        {state === 'copied' ? <CheckIcon /> : <CopyIcon />}
        <span aria-hidden="true">{state === 'copied' ? 'Copied' : 'Copy'}</span>
      </button>
      <span className="sh-copy__status" aria-live="polite">
        {state === 'copied' ? 'Copied.' : state === 'failed' ? failed : ''}
      </span>
    </span>
  );
}
