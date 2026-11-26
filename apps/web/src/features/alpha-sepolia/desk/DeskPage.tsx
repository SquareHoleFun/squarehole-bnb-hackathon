/**
 * F161 (4), SH-ALPHA-SITE, work package D: the founder's approval page (`/desk`, its own build: build/alpha-pages.ts),
 * behind Cloudflare Access: Caddy checks the founder's Access token before it serves a file of the page, and alpha-api
 * checks it again on every call (`/desk/api/signups`, `/desk/api/decide`; docs/runbooks/alpha-access.md).
 *
 * Each sign-up shows its X handle as a link to its X profile (by its X number, which X never gives to another account;
 * a handle can be released and taken: XR-ALPHA-SITE af2), its name and when it signed up: what Privy hands our
 * server, nothing more (Privy gives no account age and no follower count, and the page invents none; the profile
 * behind the link is the founder's to judge). Approve, remove and reset each ask once more before they go. Every profile
 * text is shown as text only (React escapes it), with control and direction characters taken out, so a name cannot
 * reorder or hide what stands next to it. Decisions go by the X number: handles change hands.
 */
import { cleanText } from '@squarehole/chain/write/wallet';
import { useCallback, useEffect, useState } from 'react';
import { alphaApi, X_ID, type AlphaApi, type AlphaStatus, type Decision, type Desk, type DecisionRecord, type Signup } from '../alpha-api';
import { DESK_WORDS, decisionQuestion, refusalLine } from '../alpha-words';

const ORDER: Readonly<Record<AlphaStatus, number>> = { pending: 0, approved: 1, removed: 2 };
const STATUS_WORD: Readonly<Record<AlphaStatus, string>> = { pending: 'Pending', approved: 'Approved', removed: 'Removed' };
const DECISION_WORD: Readonly<Record<Decision, string>> = { approve: 'approved', remove: 'removed', reset: 'reset' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "29 Oct 2026, 12:05 UTC": the same on every machine, whatever its locale or time zone. */
export function utcTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const two = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${two(date.getUTCHours())}:${two(date.getUTCMinutes())} UTC`;
}

/** The decisions a status allows: approve whoever is not approved, remove whoever is not removed, reset whoever is not pending. */
export function decisionsFor(status: AlphaStatus): readonly Decision[] {
  return (['approve', 'remove', 'reset'] as const).filter((decision) => (decision === 'approve' ? status !== 'approved' : decision === 'remove' ? status !== 'removed' : status !== 'pending'));
}

/** The X profile a sign-up links to, by its X number; null for anything that is not one (never a link built from it). */
export const profileOf = (xId: string): string | null => (X_ID.test(xId) ? `https://x.com/i/user/${xId}` : null);

export interface DeskPageProps {
  /** Test seam: our server (the browser's own same-origin requests otherwise). */
  readonly api?: AlphaApi;
}

type Load = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly desk: Desk } | { readonly kind: 'failed'; readonly line: string };

export function DeskPage({ api: given }: DeskPageProps) {
  const [api] = useState<AlphaApi>(() => given ?? alphaApi());
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [asking, setAsking] = useState<{ readonly xId: string; readonly decision: Decision } | null>(null);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await api.signups();
    if (result.ok) setLoad({ kind: 'ready', desk: result.value });
    else setLoad({ kind: 'failed', line: result.status === 0 || result.status === 401 ? DESK_WORDS.accessExpired : refusalLine(result) });
  }, [api]);

  useEffect(() => {
    let live = true;
    void api.signups().then((result) => {
      if (!live) return;
      if (result.ok) setLoad({ kind: 'ready', desk: result.value });
      else setLoad({ kind: 'failed', line: result.status === 0 || result.status === 401 ? DESK_WORDS.accessExpired : refusalLine(result) });
    });
    return () => { live = false; };
  }, [api]);

  async function decide(xId: string, decision: Decision) {
    setBusy(true);
    setLine(null);
    const result = await api.decide(xId, decision);
    setBusy(false);
    setAsking(null);
    if (!result.ok) { setLine(result.status === 0 || result.status === 401 ? DESK_WORDS.accessExpired : refusalLine(result)); return; }
    await refresh();
  }

  const rows = load.kind === 'ready' ? [...load.desk.signups].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.signedUpAt.localeCompare(a.signedUpAt) || a.xId.localeCompare(b.xId)) : [];
  const lastDecision = (xId: string): DecisionRecord | null => (load.kind === 'ready' ? [...load.desk.decisions].reverse().find((record) => record.xId === xId) ?? null : null);
  const counts = (['pending', 'approved', 'removed'] as const).map((status) => [status, rows.filter((row) => row.status === status).length] as const);

  const row = (signup: Signup) => {
    const handle = cleanText(signup.handle, 15);
    const name = cleanText(signup.name, 80);
    const profile = profileOf(signup.xId);
    const decided = lastDecision(signup.xId);
    const question = asking?.xId === signup.xId ? asking.decision : null;
    return (
      <li key={signup.xId} className="sh-desk__row" data-status={signup.status} data-x-id={signup.xId}>
        <div className="sh-desk__who">
          {profile ? <a className="sh-desk__handle" href={profile} target="_blank" rel="noopener noreferrer">@{handle}<span className="sh-visually-hidden"> (opens X in a new tab)</span></a> : <span className="sh-desk__handle">@{handle}</span>}
          <span className="sh-desk__name">{name}</span>
          <span className="sh-desk__meta">{`Signed up ${utcTime(signup.signedUpAt)} · X ${signup.xId}`}</span>
          {decided ? <span className="sh-desk__meta">{`${DECISION_WORD[decided.decision]} ${utcTime(decided.at)}`}</span> : null}
        </div>
        <span className="sh-desk__status" data-status={signup.status}>{STATUS_WORD[signup.status]}</span>
        <div className="sh-desk__actions">
          {question ? (
            <>
              <span className="sh-desk__question" role="status">{decisionQuestion(question, handle)}</span>
              <button type="button" className="sh-button sh-button--primary" disabled={busy} aria-busy={busy || undefined} onClick={() => void decide(signup.xId, question)}>{DESK_WORDS.confirm}</button>
              <button type="button" className="sh-button" disabled={busy} onClick={() => setAsking(null)}>{DESK_WORDS.cancel}</button>
            </>
          ) : decisionsFor(signup.status).map((decision) => (
            <button key={decision} type="button" className={`sh-button${decision === 'approve' ? ' sh-button--primary' : ''}`} disabled={busy || asking !== null}
              onClick={() => { setLine(null); setAsking({ xId: signup.xId, decision }); }}>
              {`${decision === 'approve' ? DESK_WORDS.approve : decision === 'remove' ? DESK_WORDS.remove : DESK_WORDS.reset} `}
              <span className="sh-visually-hidden">{`@${handle}`}</span>
            </button>
          ))}
        </div>
      </li>
    );
  };

  return (
    <main className="sh-join sh-desk">
      <section className="sh-join__card sh-panel" aria-labelledby="desk-title">
        <header className="sh-desk__header">
          <h1 id="desk-title" className="sh-join__title">{DESK_WORDS.title}</h1>
          <button type="button" className="sh-button" disabled={busy || load.kind === 'loading'} onClick={() => { setLine(null); void refresh(); }}>{DESK_WORDS.refresh}</button>
        </header>
        {load.kind === 'loading' ? <p className="sh-join__line" aria-busy="true">{DESK_WORDS.loading}</p> : null}
        {load.kind === 'failed' ? <p className="sh-join__line" role="alert">{load.line}</p> : null}
        {load.kind === 'ready' ? (
          <>
            <dl className="sh-desk__counts">
              {counts.map(([status, count]) => <div key={status}><dt>{STATUS_WORD[status]}</dt><dd>{count}</dd></div>)}
            </dl>
            {load.desk.load ? <p className="sh-join__line">{`Cap ${load.desk.load.cap} · Claims waiting ${load.desk.load.claimsWaiting} · Sender float ${load.desk.load.senderFloat === 'low' ? 'needs refill' : load.desk.load.senderFloat}`}</p> : null}
            {rows.length === 0 ? <p className="sh-join__line">{DESK_WORDS.empty}</p> : <ul className="sh-desk__list" aria-label="Sign-ups">{rows.map(row)}</ul>}
          </>
        ) : null}
        {line ? <p className="sh-join__line" role="alert">{line}</p> : null}
        {import.meta.env?.SH_PRODUCTION ? <p className="sh-join__meta"><a href="/desk/assets/third-party-notices.txt">Third-party notices</a></p> : null}
      </section>
    </main>
  );
}
