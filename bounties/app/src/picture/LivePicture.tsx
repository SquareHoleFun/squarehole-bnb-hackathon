/**
 * SH-319: a launched token's picture on its page: the create form's picture (LaunchPictureSvg), read only. Pressing a
 * part takes the page to that part's panel below (the first of its panels on the page) and gives it the focus.
 */
import { useId } from 'react';
import type { PartId } from './launch-picture';
import type { LaunchPicture } from './launch-picture';
import { LaunchPictureSvg } from './LaunchPictureSvg';
import './picture.css';
import './live-picture.css';

/** Each part's panels by test id, in the order tried. */
export type PartTargets = Partial<Record<PartId, readonly string[]>>;

let litTimer: number | undefined;

/** The first panel of `ids` on the page, scrolled to and focused. */
export function goToPanel(ids: readonly string[] | undefined): void {
  for (const id of ids ?? []) {
    const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (!el) continue;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
    // one panel lit at a time, for 1.6 s from its last press
    window.clearTimeout(litTimer);
    document.querySelectorAll('.sh-live-lit').forEach((x) => x.classList.remove('sh-live-lit'));
    el.classList.add('sh-live-lit');
    litTimer = window.setTimeout(() => el.classList.remove('sh-live-lit'), 1600);
    return;
  }
}

export function LivePicture({ picture, name, targets }: { picture: LaunchPicture; name: string; targets: PartTargets }) {
  const headingId = useId();
  return (
    <div className="sh-lp-page sh-live" data-testid="live-picture">
      <h2 id={headingId} className="sh-visually-hidden">
        {name}
      </h2>
      <div className="sh-pic-stage">
        <LaunchPictureSvg picture={picture} open={null} onPart={(id) => goToPanel(targets[id])} labelledBy={headingId} idPrefix="sh-live" leads testId="live-picture-svg" />
      </div>
    </div>
  );
}
