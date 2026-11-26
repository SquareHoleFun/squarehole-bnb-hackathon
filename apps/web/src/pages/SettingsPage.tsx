import { CastCharacter } from '@squarehole/design';
import { useId, useState } from 'react';
import { DataSourceSettings } from '../features/data-source/DataSourceSettings';
import {
  resetPreferences,
  savePreferences,
  usePreferences,
  useSystemReducedMotion,
  type MotionPreference,
  type Preferences,
  type SaveResult,
} from '../features/settings';
import { PAGE_TITLE_ID, PageHeading, usePageTitle } from './page-parts';

/**
 * `/settings` (01-PRODUCT: data provider, motion and theme; "Save local preferences"). Choices apply at once and are
 * stored in this browser only (guarded localStorage); the page says when storage refused them. The data source (SH-C)
 * chooses where the app reads from and which wallet it offers; nothing here changes rewards or sends a transaction.
 */
export function SettingsPage() {
  usePageTitle('Settings');
  const preferences = usePreferences();
  const systemReduced = useSystemReducedMotion();
  const [result, setResult] = useState<SaveResult | null>(null);
  const motionHint = useId();
  const shortcutTitle = useId();
  const shortcutHint = useId();

  function update(next: Partial<Preferences>) {
    setResult(savePreferences({ ...preferences, ...next }));
  }

  return (
    <section className="sh-page sh-settings" aria-labelledby={PAGE_TITLE_ID}>
      <div className="sh-page__header">
        <PageHeading>Settings</PageHeading>
        <p className="sh-page__lede">Preferences for this browser. They are stored on this device only and never sent anywhere.</p>
      </div>

      <div className="sh-settings__layout">
        <div className="sh-settings__sections">
          <DataSourceSettings />

          <fieldset className="sh-panel sh-settings__section" aria-describedby={motionHint}>
            <legend className="sh-section-title">Motion</legend>
            <MotionOption
              value="allow"
              current={preferences.motion}
              title="Allow motion"
              hint="Animations and transitions may play. Your system’s reduced-motion setting still turns them off."
              onChange={(motion) => update({ motion })}
            />
            <MotionOption
              value="reduce"
              current={preferences.motion}
              title="Reduce motion"
              hint="Static artwork only: no animations, no pulsing status marks, no transitions."
              onChange={(motion) => update({ motion })}
            />
            <p id={motionHint} className="sh-settings__hint">
              {systemReduced
                ? 'Your system asks for reduced motion, so motion stays off either way.'
                : 'Nothing essential ever depends on motion.'}
            </p>
          </fieldset>

          <fieldset className="sh-panel sh-settings__section">
            <legend className="sh-section-title">Keyboard shortcuts</legend>
            <label className="sh-settings__option">
              <input
                type="checkbox"
                checked={preferences.searchShortcut}
                aria-labelledby={shortcutTitle}
                aria-describedby={shortcutHint}
                onChange={(event) => update({ searchShortcut: event.currentTarget.checked })}
              />
              <span>
                <span id={shortcutTitle} className="sh-settings__option-title">
                  Press <kbd>/</kbd> to search
                </span>
                <span id={shortcutHint} className="sh-settings__hint">
                  A single-key shortcut that opens the pair search from any page. Turn it off if you use speech input or
                  it gets in your way. The Search button in the top bar always works.
                </span>
              </span>
            </label>
          </fieldset>

          <section className="sh-panel sh-settings__section" aria-labelledby="settings-theme-title">
            <h2 id="settings-theme-title" className="sh-section-title">
              Theme
            </h2>
            <p>
              <strong>Dark only.</strong> Square Hole has one dark theme for now; there is no light theme to switch to.
            </p>
          </section>

          <div className="sh-settings__footer">
            <p className="sh-settings__status" role="status" aria-live="polite" data-save-result={result ?? undefined}>
              {result === 'saved' ? 'Saved on this device.' : null}
              {result === 'not_saved'
                ? 'Could not save on this device (browser storage is blocked or full). Your choice applies until you close this tab.'
                : null}
            </p>
            <button type="button" className="sh-button" onClick={() => setResult(resetPreferences())}>
              Reset to defaults
            </button>
          </div>
        </div>
        <div className="sh-settings__cast">
          <CastCharacter id="sorter" size={120} caption={false} />
          <p className="sh-settings__cast-line">Motion is optional. The square hole isn’t.</p>
        </div>
      </div>
    </section>
  );
}

interface MotionOptionProps {
  readonly value: MotionPreference;
  readonly current: MotionPreference;
  readonly title: string;
  readonly hint: string;
  readonly onChange: (value: MotionPreference) => void;
}

function MotionOption({ value, current, title, hint, onChange }: MotionOptionProps) {
  const titleId = useId();
  const hintId = useId();
  return (
    <label className="sh-settings__option">
      <input
        type="radio"
        name="motion"
        value={value}
        checked={current === value}
        aria-labelledby={titleId}
        aria-describedby={hintId}
        onChange={() => onChange(value)}
      />
      <span>
        <span id={titleId} className="sh-settings__option-title">
          {title}
        </span>
        <span id={hintId} className="sh-settings__hint">
          {hint}
        </span>
      </span>
    </label>
  );
}
