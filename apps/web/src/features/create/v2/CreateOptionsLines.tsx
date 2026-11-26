/**
 * SH-218 rail 2: the two lines the Create switches show (create-options-words.ts, both founder proposals). A, once per
 * group with a switched-off option (the options themselves stay visible, `aria-disabled`, tied to it by its id); B, where
 * Create waits for a readable list, with the site's Retry.
 */
import { CREATE_OFF, CREATE_UNAVAILABLE } from './create-options-words';

/** Line A under a group, or under the Create bar when the draft holds a switched-off option. */
export function OffLine({ id, alert = false }: { id?: string; alert?: boolean }) {
  return <p id={id} className={alert ? 'sh-newbox-error' : 'sh-newbox-note'} role={alert ? 'alert' : undefined} data-create-options="off">
    {alert ? <><span aria-hidden="true">!</span>{' '}</> : null}{CREATE_OFF}
  </p>;
}

/** Line B with Retry: the list could not be read (or is stale), so nothing new is created; the draft stays as it is. */
export function UnavailableLine({ onRetry }: { onRetry: () => void }) {
  return <div className="sh-v2-create-options" data-create-options="unavailable">
    <p className="sh-newbox-error" role="alert"><span aria-hidden="true">!</span> {CREATE_UNAVAILABLE}</p>
    <button type="button" className="sh-button" onClick={onRetry}>Retry</button>
  </div>;
}

/** Line A's words as a mark under one Overview row that holds a switched-off option (not announced on its own). */
export function OffMark() {
  return <span className="sh-newbox-note sh-v2-off-mark" data-create-options="row">{CREATE_OFF}</span>;
}
