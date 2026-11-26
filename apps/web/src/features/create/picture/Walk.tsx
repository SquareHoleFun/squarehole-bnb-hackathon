/**
 * SH-254: the guided walk under the picture, the examples' own player (apps/web/public/examples/follow.js, the bar):
 * Play (Pause while it plays, Play again at its end), the row of Steps ("Step 2 of 8, Priced in"), Next step, and the
 * line "2/8 Priced in" for the step it is on. Every word is the player's own or a part's own name; nothing new.
 *
 * It goes through the parts in the order a box is set up (the six steps' order: the token and its price coin, what is
 * in the box, the buyers' and the sellers' fees, the raise, the opening) and ends at Overview. Each step marks its part
 * and opens its sheet; it never changes a value. Any press or key elsewhere on the page stops it where it is (the
 * page's own handler, CreatePicture). With reduced motion it never moves on by itself: Play goes one step.
 */
import type { ReactNode } from 'react';
import type { PartId } from '../../box-picture/picture';
import { WALK_WORDS, walkWords } from '../../box-picture/picture-words';

export type WalkStop = PartId | 'overview';
/** The order a box is set up in (the six steps: Basics, Contents, Fees, Raise, Opening, then the Overview). */
export const WALK_ORDER: readonly WalkStop[] = Object.freeze(['token', 'price', 'contents', 'buyers', 'sellers', 'raise', 'creator', 'overview']);
/**
 * The walk's one switch (the coordinator, 24 November 2026: off for site update 25; it returns with its own fix round).
 * Off, nothing of it reaches the page: no player, no reserved room, no exemption in the sheet's rules. The unit tests
 * turn it on for their own cases.
 */
export const walkSwitch: { on: boolean } = { on: false };

/** How long the walk stays on a step while it plays (the examples' steps run about this long). */
export const WALK_STEP_MS = 4000;

export interface WalkStepView { readonly id: WalkStop; readonly name: string; readonly icon: ReactNode }

const ICON = {
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  replay: 'M2.5 4v6h6M4.6 15a8.5 8.5 0 1 0 2-8.8L2.5 10',
  next: 'M9.5 6l6 6-6 6',
} as const;
const STROKED = new Set<keyof typeof ICON>(['replay', 'next']);

function Icon({ name }: { name: keyof typeof ICON }) {
  return (
    <svg className={`sh-pic-walk__icon sh-pic-walk__icon--${STROKED.has(name) ? 'line' : 'fill'}`} viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
      <path d={ICON[name]} />
    </svg>
  );
}

export interface WalkProps {
  readonly steps: readonly WalkStepView[];
  /** The step it is on, -1 before the first. */
  readonly at: number;
  readonly playing: boolean;
  readonly onPlay: () => void;
  readonly onStep: (index: number) => void;
  readonly onNext: () => void;
}

export function Walk({ steps, at, playing, onPlay, onStep, onNext }: WalkProps) {
  const count = steps.length;
  const ended = !playing && at === count - 1;
  const state = playing ? 'pause' : ended ? 'replay' : 'play';
  const current = at >= 0 ? steps[at] : undefined;
  return (
    <div className="sh-pic-walk" data-walk="">
      <div className="sh-pic-walk__bar">
        <button type="button" className="sh-pic-walk__btn sh-pic-walk__play" data-state={state} aria-label={WALK_WORDS[state]} onClick={onPlay}>
          <Icon name={state} />
        </button>
        <ol className="sh-pic-walk__steps" aria-label={WALK_WORDS.steps}>
          {steps.map((step, index) => (
            <li key={step.id}>
              <button type="button" className={`sh-pic-walk__btn sh-pic-walk__step${index < at ? ' is-done' : ''}`} aria-label={walkWords.step(index, count, step.name)}
                aria-current={index === at ? 'step' : undefined} onClick={() => onStep(index)}>
                {step.icon}
              </button>
            </li>
          ))}
        </ol>
        <button type="button" className="sh-pic-walk__btn sh-pic-walk__next" aria-label={WALK_WORDS.next} aria-disabled={at === count - 1 || undefined}
          onClick={() => { if (at < count - 1) onNext(); }}>
          <Icon name="next" />
        </button>
      </div>
      {/* The step it is on, said once each time it changes (the examples' own "1/8" and the part's name). */}
      <p className="sh-pic-walk__say" role="status">
        {current ? <><span className="sh-pic-walk__n">{walkWords.count(at, count)}</span> <strong>{current.name}</strong></> : null}
      </p>
    </div>
  );
}
