/**
 * SH-ONE-PRESS-TRADE: a press's progress when it needed an approval, on one line: two small ticks, Approve and the trade
 * (Buy, Sell or Swap), each waiting, under way, done or stopped. The words come from trade-words.ts; the trade box and
 * the swap card show it under their button, from the press until the next amount.
 */
import type { Progress, StepState } from './one-press';
import { STEP_STATES, STEP_WORDS, STEPS_LABEL } from './trade-words';

// Each mark sits in a small ring (trade-box.css): empty while waiting.
const MARKS: Readonly<Record<StepState, string>> = Object.freeze({ waiting: '', active: '•', done: '✓', stopped: '✕' });

export function Steps({ progress, trade }: { readonly progress: Progress; readonly trade: string }) {
  const steps = [['approve', STEP_WORDS.approve, progress.approve], ['trade', trade, progress.trade]] as const;
  return (
    <ol className="sh-trade-steps" aria-label={STEPS_LABEL}>
      {steps.map(([id, word, state]) => (
        <li key={id} className="sh-trade-steps__step" data-step={id} data-state={state}>
          <span className="sh-trade-steps__mark" aria-hidden="true">{MARKS[state]}</span>
          <span>{word}</span>
          <span className="sh-visually-hidden">{`, ${STEP_STATES[state]}`}</span>
        </li>
      ))}
    </ol>
  );
}
