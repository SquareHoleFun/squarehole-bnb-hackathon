import { useEffect, useId, useRef } from 'react';
import { useChainRuntimeState, useDataSource } from './data-source-context';
import { DATA_LABELS, readLastDataSourceChange, saveDataSource, useLastDataSourceChange, type DataSourceId, type DataSourceOption } from './data-source';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

/**
 * Settings → Data source (SH-C). Three choices, stored in this browser only: the demo fixtures (default), the local
 * anvil chain, and Sepolia, which stays disabled with the reason until its deployment manifest exists. Choosing one
 * applies at once: the app below the data source starts a fresh session (the page stays), then focus returns to the
 * chosen option and the result is announced. The production site has one source (Sepolia), so no switching words and
 * no Demo fallback notice.
 */
export function DataSourceSettings() {
  const source = useDataSource();
  const runtime = useChainRuntimeState();
  const change = useLastDataSourceChange();
  const hintId = useId();
  const groupRef = useRef<HTMLFieldSetElement>(null);

  // After a switch the page remounted: bring focus back to the option that was chosen (once per change).
  useEffect(() => {
    const last = readLastDataSourceChange();
    if (last === null || last.id === null || focusedFor === last) return;
    focusedFor = last;
    groupRef.current?.querySelector<HTMLInputElement>(`input[value="${last.id}"]`)?.focus();
  }, []);

  const storedUnavailable = DEMO_BUILD && source.stored !== null && source.stored !== source.id;
  return (
    <fieldset ref={groupRef} className="sh-panel sh-settings__section" aria-describedby={hintId} data-testid="data-source-settings">
      <legend className="sh-section-title">Data source</legend>
      {source.options.map((option) => (
        <SourceOption key={option.id} option={option} current={source.id} />
      ))}
      <p id={hintId} className="sh-settings__hint">
        {DEMO_BUILD
          ? 'Switching starts a fresh session in this tab: requests that are still open here stop being tracked on this page (a transaction already sent stays on its chain). '
          : null}
        The indexer behind a chain source is rebuilt from chain events in this browser and never decides balances or claims:
        those are read from the contracts.
      </p>
      {storedUnavailable && source.stored ? (
        <p className="sh-account-notice" data-tone="warning" role="note">
          <span className="sh-account-notice__mark" aria-hidden="true" />
          <span>
            Your saved choice, {DATA_LABELS[source.stored]}, is not available in this build, so the sample data is shown.
          </span>
        </p>
      ) : null}
      {source.chain && runtime.status === 'error' ? (
        <p className="sh-account-notice" data-tone="warning" role="alert">
          <span className="sh-account-notice__mark" aria-hidden="true" />
          <span>The {DATA_LABELS[source.id]} source could not be loaded: {runtime.message}</span>
        </p>
      ) : null}
      {/* A polite live region without the status role: the page keeps one status (the preferences' save result). */}
      <p className="sh-settings__status" aria-live="polite" data-testid="data-source-status" data-save-result={change?.result ?? undefined}>
        {change !== null && change.id !== null ? statusText(change.id, change.result) : null}
      </p>
    </fieldset>
  );
}

// Module-level so a StrictMode double effect or a later re-render does not move focus again for the same change.
let focusedFor: object | null = null;

function statusText(id: DataSourceId, result: 'saved' | 'not_saved'): string {
  return result === 'saved'
    ? `Showing ${DATA_LABELS[id]}. Saved on this device.`
    : `Showing ${DATA_LABELS[id]} in this tab. Could not save on this device (browser storage is blocked or full).`;
}

function SourceOption({ option, current }: { option: DataSourceOption; current: DataSourceId }) {
  const titleId = useId();
  const hintId = useId();
  return (
    <label className="sh-settings__option" data-disabled={!option.available || undefined}>
      <input
        type="radio"
        name="data-source"
        value={option.id}
        checked={current === option.id}
        disabled={!option.available}
        aria-labelledby={titleId}
        aria-describedby={hintId}
        onChange={() => saveDataSource(option.id)}
      />
      <span>
        <span id={titleId} className="sh-settings__option-title">
          {option.title}
          {current === option.id ? <span className="sh-chip">In use</span> : null}
          {!option.available ? <span className="sh-chip sh-chip--pending">{option.id === 'sepolia' ? 'Not deployed yet' : 'Not configured'}</span> : null}
        </span>
        <span id={hintId} className="sh-settings__hint">
          {option.available ? option.hint : option.unavailableReason}
        </span>
      </span>
    </label>
  );
}
