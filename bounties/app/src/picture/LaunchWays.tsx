/**
 * SH-281: the row above both create screens, in the platform's look (apps/web/src/features/create/picture/LaunchOn.tsx
 * and CreateWays.tsx at main b8fbcef9, `.sh-pic-ways`): "Launch on" Flap · Four.meme · Own pool (the founder's words,
 * 25 November 2026; "Own pool" is the platform's own Create), then the two ways of this screen, Visual and Steps.
 */
export type Rail = 'flap' | 'four';
export type Way = 'visual' | 'steps';

/** The platform's own Create, on the same site. */
export const OWN_POOL_PATH = '/create';

export const LAUNCH_ON = Object.freeze({ label: 'Launch on', flap: 'Flap', four: 'Four.meme', own: 'Own pool', ways: 'Launch', visual: 'Visual', steps: 'Steps' });

export function LaunchWays({ rail, way, onWay }: { rail: Rail; way: Way; onWay: (way: Way) => void }) {
  return (
    <nav className="sh-pic-ways" aria-label={LAUNCH_ON.ways} data-testid="launch-ways">
      <span className="sh-pic-ways" role="group" aria-label={LAUNCH_ON.label} data-launch-on="">
        <span aria-hidden="true">{LAUNCH_ON.label}</span>
        <span className="sh-pic-ways__switch">
          <a href="#/flap/create" className="sh-pic-ways__option" aria-current={rail === 'flap' ? 'true' : undefined} data-testid="launch-on-flap">
            {LAUNCH_ON.flap}
          </a>
          <a href="#/four/create" className="sh-pic-ways__option" aria-current={rail === 'four' ? 'true' : undefined} data-testid="launch-on-four">
            {LAUNCH_ON.four}
          </a>
          <a href={OWN_POOL_PATH} className="sh-pic-ways__option" data-testid="launch-on-own">
            {LAUNCH_ON.own}
          </a>
        </span>
      </span>
      <span className="sh-pic-ways__switch" role="group" aria-label={LAUNCH_ON.ways}>
        {(['visual', 'steps'] as const).map((w) => (
          <button
            key={w}
            type="button"
            className="sh-pic-ways__option sh-lp-way"
            aria-current={way === w ? 'true' : undefined}
            aria-pressed={way === w}
            onClick={() => onWay(w)}
            data-testid={`way-${w}`}
          >
            {w === 'visual' ? LAUNCH_ON.visual : LAUNCH_ON.steps}
          </button>
        ))}
      </span>
    </nav>
  );
}
