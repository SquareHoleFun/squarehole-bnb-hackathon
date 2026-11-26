/**
 * The logo loader (F51, founder 2026-10-01: "a cool animation using our logo for loading/caching waiting on the
 * page"). Variant A of the preview, "Shapes find the hole": at card (48 px) and page (160 px) size the five toy shapes
 * drop into the mark's hole one by one, 1.6 s each. At button (16 px) and inline (24 px) size the brand's hinted
 * drawing only breathes its glow (variant B), because a dropping shape would be a 5 px blip next to text.
 *
 * The mark itself never rotates, skews or changes size, and only transform and opacity animate (loader.css). With
 * reduced motion (the system setting or Settings → Reduce motion) the moving layers are left out and the still mark
 * stays, so the text beside it carries the state.
 *
 * Accessibility: a loader on its own is a status with a short spoken label ("Loading" unless told otherwise). Beside
 * visible text that already says what is happening, pass `decorative` and it is hidden from screen readers. The
 * waiting mode is a mark, a short label and an optional status line (a countdown, a block), for longer waits.
 */
import { useId } from 'react';
import { useReducedMotion } from '../settings';
import { FullMark, Shapes, SmallMark } from './loader-art';

export type LoaderSize = 'button' | 'inline' | 'card' | 'page';

/** The box of each size in CSS px (fixed, so nothing around a loader moves). */
export const LOADER_PX: Readonly<Record<LoaderSize, number>> = Object.freeze({ button: 16, inline: 24, card: 48, page: 160 });

export const DEFAULT_LOADER_LABEL = 'Loading';

interface LoadingProps {
  readonly mode?: 'loading';
  /** Default `inline` (24 px). */
  readonly size?: LoaderSize;
  /** What a screen reader hears (default "Loading"). Ignored when `decorative`. */
  readonly label?: string;
  /** Hidden from screen readers: visible text next to it already says what is loading. */
  readonly decorative?: boolean;
  readonly className?: string;
}

interface WaitingProps {
  readonly mode: 'waiting';
  /** Default `page` (160 px). */
  readonly size?: 'card' | 'page';
  /** The one visible line, announced politely ("Waiting for the random number"). */
  readonly label: string;
  /** An optional short line under it, not announced on every change ("About 0:20", "Block 1,420"). */
  readonly status?: string | null;
  readonly className?: string;
}

export type LoaderProps = LoadingProps | WaitingProps;

const classes = (...names: readonly (string | undefined)[]) => names.filter(Boolean).join(' ');

function LoaderMark({ size, label, className }: { size: LoaderSize; label: string | null; className?: string }) {
  const reduced = useReducedMotion();
  // React's ids may hold characters an SVG url(#…) reference cannot; the gradients only need uniqueness.
  const id = `shl${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const px = LOADER_PX[size];
  const moving = !reduced;
  const art = px >= 48 ? (
    <>
      <FullMark id={id} moving={moving} />
      {moving ? <Shapes /> : null}
    </>
  ) : (
    <SmallMark px={px === 16 ? 16 : 24} moving={moving} />
  );
  const common = { className: classes('sh-loader', className), 'data-size': size, 'data-motion': reduced ? 'reduce' : 'allow' } as const;
  if (label === null) {
    return (
      <span {...common} aria-hidden="true">
        {art}
      </span>
    );
  }
  return (
    <span {...common} role="status">
      <span className="sh-visually-hidden">{label}</span>
      {art}
    </span>
  );
}

export function Loader(props: LoaderProps) {
  if (props.mode === 'waiting') {
    const size = props.size ?? 'page';
    return (
      <div className={classes('sh-loader-wait', props.className)} data-size={size}>
        <div className="sh-loader-wait__status" role="status">
          <LoaderMark size={size} label={null} />
          <p className="sh-loader-wait__label">{props.label}</p>
        </div>
        {props.status ? <p className="sh-loader-wait__line">{props.status}</p> : null}
      </div>
    );
  }
  return <LoaderMark size={props.size ?? 'inline'} label={props.decorative ? null : (props.label ?? DEFAULT_LOADER_LABEL)} className={props.className} />;
}
