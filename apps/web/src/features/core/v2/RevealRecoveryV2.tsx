/**
 * SH-203 af1: the reveal session's recovery surface, one piece for both pages that hold a session (the Reveal items view
 * and the hidden draws panel): both reason owners (the session's reads and its last action), the sends it is still
 * checking with their saved or live-only transaction ids, a release as two presses (ask, then confirm) for a send without
 * an id, and the run record's download. It calls the session's public interface only, each action in its own press.
 * The parent mounts it with a key per session: a late completion of an earlier session lands on an unmounted piece, and
 * every continuation is also checked against the session that started it.
 */
import { useEffect, useRef, useState } from 'react';
import { download } from '../../create/v2/box-file-save';
import type { ReleaseDecision, RevealSession, RevealSessionState, UnresolvedReveal } from './reveal-session';
import { REVEAL_WORDS as W, RETRIED_SOURCE_CODES, ethUp, reasonText } from './reveal-words';

export interface RevealRecoveryV2Props {
  readonly session: RevealSession;
  readonly state: RevealSessionState;
  /** The run record's file name. */
  readonly fileName: string;
  /** Leave out the action reason (the parent shows it as its main line). */
  readonly hideActionReason?: boolean;
  /** Keep the same session alive during an export and its automatic source retry. */
  readonly onExporting?: (exporting: boolean) => void;
  /** This piece's own press is running or settled (for the parent's busy line). */
  readonly onActing?: (acting: boolean) => void;
  /** SH-203 af5 (R4-L3b): the wallet signs on the press and keeps no pending list (`signer.confirmsInPage`). */
  readonly confirmsInPage?: boolean;
  /**
   * SH-203 af5 (R4-L4): a request of this tab's run or opening may still be at the wallet (the press has not settled):
   * a stop or a wallet change does not yet mean nothing more is sent.
   */
  readonly requestOut?: boolean;
}

/** SH-203 af5 (R4-L4): the reasons that say nothing more is sent; true only once this tab's request has settled. */
const STOPPED_CODES: ReadonlySet<string> = new Set(['cancelled', 'account-changed', 'chain-changed']);
/** The action reason's line: while a request may still go out, a stop says what is known (it may or may not go out). */
export const actionLine = (code: string, requestOut: boolean): string => reasonText(requestOut && STOPPED_CODES.has(code) ? 'unknown-send' : code);

/** The first read's retry delays (ms): 5, 10, 20, 40, then every 60 seconds, as the session's own poll backs off. */
export const SOURCE_RETRY_MS: readonly number[] = Object.freeze([5_000, 10_000, 20_000, 40_000, 60_000]);

/**
 * SH-203 af2: a session whose first read of the box failed on the chain (`RETRIED_SOURCE_CODES`) never reads it again by
 * itself, and its saved action reason would keep saying so after the chain is back. While the page shows it, this makes
 * the session again after a backing-off wait (a new session, a new first read; no action is called). A wrong or damaged
 * file is not retried: that needs the creator's Try again or another file.
 */
export function useSourceRetry(state: RevealSessionState | null, retry: () => void, paused = false): void {
  const attempts = useRef(0);
  const waiting = state !== null && state.source === 'invalid' && !state.cancelled && RETRIED_SOURCE_CODES.has(state.actionReason ?? '');
  const recovered = state !== null && state.source === 'ready';
  const latest = useRef(retry);
  useEffect(() => { latest.current = retry; });
  useEffect(() => {
    if (recovered) attempts.current = 0;
    if (!waiting || paused) return undefined;
    const delay = SOURCE_RETRY_MS[Math.min(attempts.current, SOURCE_RETRY_MS.length - 1)] as number;
    const timer = setTimeout(() => { attempts.current += 1; latest.current(); }, delay);
    return () => clearTimeout(timer);
  }, [waiting, recovered, paused]);
}

/**
 * A send with an id that the last read found absent (R4-L2a; af6 C-L1: by the release wait's own rule, the transaction
 * read and the receipt read each an explicit null, as the session publishes it in `absent`).
 */
const gone = (attempt: UnresolvedReveal) => attempt.hash !== undefined && attempt.absent === true;
/**
 * A send the session may release on the two presses: one without an id, or (af5, R4-L2b) one with an id that the node no
 * longer has. The session decides: an id needs a whole wait in which every read found it gone.
 */
const releasable = (attempt: UnresolvedReveal) => (attempt.hash === undefined && (attempt.status === 'intent' || attempt.status === 'unknown')) || gone(attempt);

export function RevealRecoveryV2({ session, state, fileName, hideActionReason = false, onActing, onExporting, confirmsInPage = false, requestOut = false }: RevealRecoveryV2Props) {
  const [asked, setAsked] = useState<{ readonly attempt: string; readonly decision: ReleaseDecision } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [released, setReleased] = useState(false);
  const [exporting, setExporting] = useState(false);
  // The lifetime check: a continuation that outlives this mount (or this session) changes nothing.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, [session]);
  const settle = (work: () => void) => { if (alive.current) work(); };

  const press = (action: () => Promise<unknown>) => {
    setNote(null);
    setReleased(false);
    onActing?.(true);
    void action()
      .catch((error: unknown) => settle(() => {
        const code = error instanceof Error ? error.message : 'read-failed';
        const state = session.getState();
        if (code !== state.actionReason && code !== state.pollReason) setNote(code);
      }))
      .finally(() => settle(() => onActing?.(false)));
  };
  const exportRecord = async () => {
    setExporting(true);
    onExporting?.(true);
    try {
      const text = await session.exportJournal();
      settle(() => { download(fileName, [text]); });
    } catch (error) {
      settle(() => setNote(error instanceof Error ? error.message : 'read-failed'));
    } finally {
      settle(() => { setExporting(false); onExporting?.(false); });
    }
  };
  const shownNote = note !== null && note !== state.actionReason && note !== state.pollReason ? note : null;

  return (
    <div className="sh-v2-recovery" data-recovery="">
      {state.pollReason ? <p data-reason-owner="poll">{`${W.pollOwner}: ${reasonText(state.pollReason, 'poll')}`}</p> : null}
      {state.actionReason && !hideActionReason ? <p data-reason-owner="action">{`${W.actionOwner}: ${actionLine(state.actionReason, requestOut)}`}</p> : null}
      {shownNote ? <p data-reason-owner="press">{reasonText(shownNote)}</p> : null}
      {state.unresolved.length > 0 ? (
        <section aria-label={W.attempts} data-reveal-attempts="">
          <h3>{W.attempts}</h3>
          <ul>
            {state.unresolved.map((attempt) => {
              const mine = asked?.attempt === attempt.attempt ? asked.decision : null;
              const token = mine?.eligible ? mine.token : null;
              return (
                <li key={attempt.attempt} data-attempt={attempt.attempt} data-attempt-hash={attempt.hash ? (attempt.hashDurable ? 'saved' : 'live') : 'none'}>
                  <span>{W.attemptItems(attempt.ids.length)}</span>{' '}
                  {attempt.hash ? <span>{W.attemptHash(attempt.hash)}</span> : <span>{W.attemptNoHash}</span>}
                  {attempt.hash && !attempt.hashDurable ? <p>{W.attemptNotSaved}</p> : null}
                  {gone(attempt) ? <p data-attempt-gone="">{W.attemptGone}</p> : null}
                  {!releasable(attempt) ? null : token && mine ? (
                    // Second press: the confirm, with the facts the ask returned; then a fresh Prepare and Start (or Open).
                    <div role="group" aria-label={W.release} data-release="confirm">
                      <p>{confirmsInPage ? W.releaseFactsInPage : W.releaseFacts}</p>
                      <p>{`${W.releaseCost}: ${ethUp(mine.capWei)}`}</p>
                      <button type="button" className="sh-button sh-button--primary" disabled={state.busy}
                        onClick={() => press(async () => {
                          // af5 (R4-L1): a refused confirm used the token up; the row offers Release again (a new ask).
                          try { await session.confirmRelease(token); } catch (error) { settle(() => setAsked(null)); throw error; }
                          settle(() => { setAsked(null); setReleased(true); });
                        })}>{W.releaseConfirm}</button>
                    </div>
                  ) : (
                    <div data-release="ask">
                      {mine ? <p>{W.releaseWait(Math.max(1, Math.ceil(mine.waitRemainingMs / 60_000)))}</p> : null}
                      <button type="button" className="sh-button" disabled={state.busy}
                        onClick={() => press(async () => { const decision = await session.askRelease(attempt.attempt); settle(() => setAsked({ attempt: attempt.attempt, decision })); })}>{W.release}</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {released ? <p role="status" data-release="done">{W.releaseDone}</p> : null}
      <p><button type="button" className="sh-button" disabled={exporting} onClick={() => void exportRecord()}>{W.exportRecord}</button></p>
    </div>
  );
}
