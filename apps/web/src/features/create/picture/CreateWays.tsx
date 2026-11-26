/**
 * SH-251, SH-254: the ways into Create, in one rounded control (the founder, 24 November 2026: "Make the "Picture" the
 * default, I would also rename it to "Visual", can the examples be part of the rounded element as well?"): Visual (the
 * default), the six Steps, and, once the app has them (examples-entry.ts), Examples. Visual and Steps share one draft,
 * so switching keeps everything entered; Examples hands the visit over to the explainer's own page. `aria-current`
 * marks the way one is on.
 */
import { Link } from 'react-router';
import { PICTURE_WORDS } from '../../box-picture/picture-words';
import { v2Path } from '../v2/v2-steps';
import { EXAMPLES_IN_APP, EXAMPLES_PATH } from './examples-entry';
import { LaunchOn } from './LaunchOn';
import { PICTURE_PATH } from './picture-route';

/** `examples`: whether the way to the examples shows (the app's own setting; tests pass both). */
export function CreateWays({ current, examples = EXAMPLES_IN_APP }: { current: 'steps' | 'picture'; examples?: boolean }) {
  return (
    <nav className="sh-pic-ways" aria-label={PICTURE_WORDS.ways}>
      <LaunchOn />
      <span className="sh-pic-ways__switch">
        <Link to={PICTURE_PATH} className="sh-pic-ways__option" aria-current={current === 'picture' ? 'true' : undefined}>{PICTURE_WORDS.visual}</Link>
        <Link to={v2Path('v2-basics')} className="sh-pic-ways__option" aria-current={current === 'steps' ? 'true' : undefined}>{PICTURE_WORDS.steps}</Link>
        {examples ? <Link to={EXAMPLES_PATH} className="sh-pic-ways__option">{PICTURE_WORDS.examples}</Link> : null}
      </span>
    </nav>
  );
}
