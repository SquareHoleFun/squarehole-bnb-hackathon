/**
 * SH-203: the creator's "Reveal items" view of an open-art box (`?view=reveal` on the box page, RevealEntryV2.tsx).
 * It renders the reveal session (reveal-session.ts) and calls its public interface only: no engine, store, clock or test
 * seam is imported here (reveal-page-boundary.test.ts). Every send happens inside the session, on a native press:
 * Prepare and Start are separate presses, as are a release's ask and confirm, and nothing here calls an action from an
 * effect or a timer. Numbers first (revealed, left, final, in flight; after Prepare the transactions and the most the run
 * can cost); one status line; both reason owners when both are set; the codes only behind Details. The session is made
 * again when the wallet, its network, the box file or the box changes, and on Try again after a failed first read of the
 * file. The run record (the session's journal) and the release controls stay reachable while reading fails: they are the
 * shared recovery piece (RevealRecoveryV2.tsx), which the hidden draws panel uses too. In flight counts every item of a
 * send the journal checks and the batch this tab's run has out (af1 M2), Unknown when it cannot know.
 * Every text comes from reveal-words.ts (the founder's words, desk round 95; two lines there are proposals).
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { Address } from 'viem';
import { useWallet } from '../../wallet';
import { createRevealSession, type RevealSession, type RevealSessionState } from './reveal-session';
import { RevealRecoveryV2, useSourceRetry } from './RevealRecoveryV2';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { REVEAL_WORDS as W, REASON_WORDS, ethUp, reasonText } from './reveal-words';

export interface RevealItemsV2Props {
  readonly view: V2Snapshot;
  readonly source: V2Source;
  readonly onClose: () => void;
  /** Test seam: the session factory (the app passes none: `createRevealSession`). */
  readonly createSession?: typeof createRevealSession;
}

interface Live { readonly key: string; readonly session: RevealSession; readonly state: RevealSessionState }
/** A note from a press, tied to the session it was made in: a late answer of an earlier session shows nothing. */
interface Note { readonly session: RevealSession | null; readonly code: string }
/** A key per session, so the recovery piece of an earlier session never lives on in a later one. */
const sessionKeys = new WeakMap<RevealSession, number>();
let nextSessionKey = 0;
const keyOf = (session: RevealSession): number => {
  let id = sessionKeys.get(session);
  if (id === undefined) { id = ++nextSessionKey; sessionKeys.set(session, id); }
  return id;
};

/** A run this tab started and that has not settled: a reveal run (Start) or a picture run (Send pictures). */
interface Running { readonly session: RevealSession; readonly kind: 'reveal' | 'pictures' }

/**
 * The one status line. `acting`: a press of this tab is still running (the session's `busy` also covers its own
 * background reads, which get no line of their own: they only disable the presses); `revealing`: that press is a reveal
 * run, whose phase the line names (af2 R2-M3: never a picture run, never a finished run's last phase).
 */
function statusLine(state: RevealSessionState, acting: boolean, revealing: boolean, confirmsInPage: boolean): string {
  // af5 (R4-L4): a stop or a wallet change says nothing more is sent only once this tab's run has settled; until then a
  // request already at the wallet may still go out.
  if (state.cancelled) return revealing ? reasonText('unknown-send') : W.cancelled;
  if (state.source === 'loading') return W.loading;
  const counts = state.counts;
  const finished = finishedCounts(state);
  // af5 (R4-L5): every item revealed (the kept copy is removed once all are final): the finished line, not the file.
  if (finished && state.source === 'needs-file') return counts?.finalizedComplete ? W.allDone : W.allLatest;
  if (state.source === 'needs-file') return W.needsFile;
  if (state.source === 'invalid') return reasonText(state.actionReason ?? 'invalid-source', 'source');
  // af5 (R4-L3b): a wallet that signs on the press opens no window to confirm in.
  if (revealing && state.progress) return state.progress.phase === 'wallet' && confirmsInPage ? W.phase.running : W.phase[state.progress.phase];
  if (acting) return W.busy;
  if (finished) return counts?.finalizedComplete ? W.allDone : W.allLatest;
  return state.plan ? W.planReady : W.ready;
}
/** Every item revealed at the latest block, by the counts the session read. */
const finishedCounts = (state: RevealSessionState): boolean => state.counts !== undefined && state.counts.size > 0n && state.counts.remainingLatest === 0n;

export function RevealItemsV2({ view, source, onClose, createSession = createRevealSession }: RevealItemsV2Props) {
  const wallet = useWallet();
  const chainId = source.manifest.chainId;
  const account = wallet.status === 'connected' ? (wallet.account as Address | null) : null;
  const creator = account !== null && account.toLowerCase() === view.record.creator.toLowerCase();
  const signer = wallet.signer;
  const confirmsInPage = signer?.confirmsInPage === true;
  const usable = creator && wallet.kind === 'injected' && wallet.chainId === chainId && signer !== null;
  const [file, setFile] = useState<File | null>(null);
  // Try again after a failed first read, and every new file, make the session again.
  const [generation, setGeneration] = useState(0);
  const [live, setLive] = useState<Live | null>(null);
  const [failed, setFailed] = useState<{ key: string; code: string } | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  // The run or picture run this tab started and that has not settled: its Stop press.
  const [running, setRunning] = useState<Running | null>(null);
  // Automatic source retries wait for this session’s export to finish.
  const [exporting, setExporting] = useState<RevealSession | null>(null);
  // Any press of this tab that has not settled (Prepare, Start, pictures, a release).
  const [acting, setActing] = useState<RevealSession | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // The latest box snapshot for the next session; the session's identity is the keys below, not each refresh.
  const box = useRef(view);
  const rpc = useRef(source);
  useEffect(() => { box.current = view; rpc.current = source; });
  const key = usable && account !== null && signer !== null
    ? [chainId, view.token.toLowerCase(), view.record.specHash, account.toLowerCase(), signer.walletName, generation].join('|') : null;
  const { onAccountsChanged, onChainChanged } = wallet;
  const request = signer?.request ?? null;
  const walletName = signer?.walletName ?? '';

  useEffect(() => {
    if (key === null || request === null || account === null) return undefined;
    const controller = new AbortController();
    let session: RevealSession;
    try {
      session = createSession({ chainId, box: box.current, account, rpc: rpc.current, signal: controller.signal,
        wallet: { signer: { request, walletName }, onAccountsChanged, onChainChanged }, ...(file ? { file } : {}) });
    } catch (error) {
      // The session refused this wallet or box outright (`wrong-identity`): said once, nothing made.
      const code = error instanceof Error ? error.message : 'wrong-identity';
      void Promise.resolve().then(() => setFailed({ key, code }));
      return () => controller.abort();
    }
    const off = session.subscribe((state) => setLive({ key, session, state }));
    return () => { off(); session.dispose(); controller.abort(); };
    // The box and its RPC are read through their refs: a refreshed snapshot of the same box keeps its session.
  }, [key, request, account, chainId, walletName, file, createSession, onAccountsChanged, onChainChanged]);

  const current = live !== null && live.key === key ? live : null;
  // The session now on screen, for continuations to check against (af1 L1).
  const liveSession = useRef<RevealSession | null>(null);
  useEffect(() => { liveSession.current = current?.session ?? null; });
  const s = current?.session ?? null;
  const st = current?.state ?? null;
  const noteCode = note !== null && note.session === s ? note.code : null;
  const shownNote = noteCode !== null && noteCode !== st?.actionReason && noteCode !== st?.pollReason ? noteCode : null;

  /**
   * One press, one action: the session call happens here, in the click, before any await. Its answer is tied to the
   * session that made it (af1 L1): a late answer of a disposed session changes nothing here.
   */
  const press = (action: () => Promise<unknown>) => {
    setNote(null);
    const session = s;
    setActing(session);
    void action()
      .catch((error: unknown) => {
        const code = error instanceof Error ? error.message : 'read-failed';
        const state = session?.getState();
        if (code === state?.actionReason || code === state?.pollReason) return;
        setNote((now) => (session !== null && liveSession.current === session ? { session, code } : now));
      })
      .finally(() => setActing((now) => (now === session ? null : now)));
  };
  /** A run or picture run: the same single press, with Stop offered until it settles. */
  const pressRun = (session: RevealSession, kind: Running['kind'], action: () => Promise<unknown>) => {
    const run: Running = { session, kind };
    setRunning(run);
    press(() => action().finally(() => setRunning((now) => (now === run ? null : now))));
  };
  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (!chosen) return;
    setFile(chosen);
    setGeneration((g) => g + 1);
  };

  const counts = st?.counts;
  const plan = st?.plan;
  const busy = st?.busy ?? true;
  // In flight (af1 M2): every item of a send the journal still checks (no id, an id, unknown), and while this tab's run
  // has a batch at the wallet or awaiting its block, that batch's items. Unknown, never 0, when they cannot be known:
  // another tab holds the run, or a batch is out without its items.
  // af2 R2-M3: only a reveal run of this tab that has not settled counts; a picture run sends no reveal, and the
  // session's progress of a finished run has expired (it stays in its state, so the page reads it only while that run
  // is in flight). Contention counts from either reason owner: another tab's run seen by a read, or refusing a press.
  const revealing = running !== null && running.session === s && running.kind === 'reveal';
  const progress = revealing ? st?.progress : undefined;
  const out = progress && progress.phase !== 'running' ? progress : null;
  const flying = new Set([...(st?.unresolved.flatMap((attempt) => attempt.ids) ?? []), ...(out?.ids ?? [])]);
  const flightUnknown = st?.outstandingCurrent !== true || st?.pollReason === 'running-elsewhere' || st?.actionReason === 'running-elsewhere' || (out !== null && out.ids === undefined);
  const pictures = st?.pictures;
  const pictureCodes = new Set(pictures?.outcomes.map((outcome) => outcome.reason) ?? []);
  const pictureFailures = pictures?.outcomes.filter((outcome) => !['ready', 'not-finalized', 'not-available', 'transport-unavailable', 'deferred', 'needs-box-file'].includes(outcome.reason)).length ?? 0;
  const notInFile = pictures?.outcomes.filter((outcome) => outcome.reason === 'needs-box-file').length ?? 0;
  // af2 R2-L2: a first read that failed on the chain is read again (a new session) after a backing-off wait.
  useSourceRetry(st, () => setGeneration((g) => g + 1), exporting !== null && exporting === s);
  const codes = [st?.pollReason, st?.actionReason, shownNote, failed?.key === key ? failed?.code : undefined].filter((code): code is string => code !== undefined && code !== null);
  const filePicker = (
    <>
      <input ref={fileInput} type="file" accept=".json,application/json" className="sh-visually-hidden" aria-label={W.fileLabel} onChange={onFile} />
      <button type="button" className="sh-button" onClick={() => fileInput.current?.click()}>{file ? W.otherFile : W.chooseFile}</button>
    </>
  );

  return (
    <section className="sh-panel sh-v2-stats sh-v2-reveal" aria-label={W.title} data-reveal-source={st?.source ?? 'none'} data-reveal-busy={st?.busy ? '' : undefined}>
      <h2>{W.title}</h2>
      <p><button type="button" className="sh-button" onClick={onClose}>{W.back}</button></p>
      <dl className="sh-v2-stats__grid">
        <div><dt>{W.revealed}</dt><dd data-reveal-count="revealed"><span className="sh-v2-stats__value">{counts ? `${counts.latest}/${counts.size}` : '—'}</span></dd></div>
        <div><dt>{W.left}</dt><dd data-reveal-count="left"><span className="sh-v2-stats__value">{counts ? String(counts.remainingLatest) : '—'}</span></dd></div>
        <div><dt>{W.final}</dt><dd data-reveal-count="final"><span className="sh-v2-stats__value">{counts ? `${counts.finalized}/${counts.size}` : '—'}</span></dd></div>
        <div><dt>{W.inFlight}</dt><dd data-reveal-count="in-flight"><span className="sh-v2-stats__value">{flightUnknown ? W.unknown : flying.size > 0 ? W.attemptItems(flying.size) : '0'}</span></dd></div>
      </dl>
      <p>{W.inFlightHelp}</p>
      {!usable ? <p role="status" data-reveal-status="connect">{W.connect}</p> : null}
      {usable && failed?.key === key ? <p role="status" data-reveal-status="refused">{reasonText(failed.code, 'source')}</p> : null}
      {st ? <p role="status" data-reveal-status="">{statusLine(st, acting !== null && acting === s, revealing, confirmsInPage)}</p> : null}
      {shownNote ? <p data-reason-owner="press">{reasonText(shownNote)}</p> : null}
      {st && ((st.source === 'needs-file' && !finishedCounts(st)) || st.source === 'invalid') ? (
        <p className="sh-m2-chips">
          {st.source === 'invalid' ? <button type="button" className="sh-button sh-button--primary" onClick={() => setGeneration((g) => g + 1)}>{W.tryAgain}</button> : null}
          {filePicker}
        </p>
      ) : null}
      {plan ? (
        <dl className="sh-v2-stats__grid" data-reveal-plan="">
          <div><dt>{W.transactions}</dt><dd><span className="sh-v2-stats__value">{plan.batches.length}</span></dd></div>
          <div><dt>{W.mostCost}</dt><dd><span className="sh-v2-stats__value">{ethUp(plan.ceilingWei)}</span></dd></div>
          {plan.spentWei > 0n ? <div><dt>{W.spent}</dt><dd>{ethUp(plan.spentWei)}</dd></div> : null}
        </dl>
      ) : null}
      {s && st && st.source === 'ready' ? (
        <p className="sh-m2-chips">
          {plan ? (
            <button type="button" className="sh-button sh-button--primary" disabled={busy} onClick={() => pressRun(s, 'reveal', () => s.start(plan))}>{W.start}</button>
          ) : counts?.remainingLatest !== 0n ? (
            <button type="button" className="sh-button sh-button--primary" disabled={busy} onClick={() => press(() => s.prepare())}>{W.prepare}</button>
          ) : null}
          {running !== null && running.session === s ? <button type="button" className="sh-button" onClick={() => s.cancel()}>{W.stop}</button> : null}
        </p>
      ) : null}
      {s && st ? (
        <RevealRecoveryV2 key={keyOf(s)} session={s} state={st} fileName={`reveal-run-${chainId}-${view.token.toLowerCase()}.json`}
          onExporting={(on) => setExporting(on ? s : null)} hideActionReason={st.source === 'invalid'} onActing={(on) => setActing(on ? s : (now) => (now === s ? null : now))}
          confirmsInPage={confirmsInPage} requestOut={revealing} />
      ) : null}
      {s && st && counts && counts.finalized > 0n ? (
        <section aria-label={W.pictures} data-reveal-pictures="">
          <h3>{W.pictures}</h3>
          {st.pictureProgress && st.busy ? <p>{W.picturesProgress(st.pictureProgress.completedItems, st.pictureProgress.totalItems)}</p> : null}
          {pictures ? <p data-reveal-pictures-ready="">{W.picturesReady(pictures.picturesReady.finalized, pictures.revealed.finalized)}</p> : null}
          {pictureCodes.has('transport-unavailable') ? <p>{W.picturesNoTransport}</p> : null}
          {pictureCodes.has('not-available') ? <p data-reveal-pictures-off="">{W.picturesOff}</p> : null}
          {pictureCodes.has('deferred') && !pictureCodes.has('not-available') ? <p>{W.picturesLater}</p> : null}
          {notInFile > 0 ? <p data-reveal-pictures-need-file="">{W.picturesNotInFile(notInFile)}</p> : null}
          {pictureFailures > 0 ? <p>{W.picturesFailed(pictureFailures)}</p> : null}
          {/* af1 L2: the file choice stays, so a proof-only copy can be swapped for the full box file. */}
          {file ? null : <p>{W.picturesNeedFile}</p>}
          <p className="sh-m2-chips">
            {file ? <button type="button" className="sh-button" disabled={busy} onClick={() => pressRun(s, 'pictures', () => s.startPictures(file))}>{W.sendPictures}</button> : null}
            {/* af5 (R4-L5): with every item revealed the file is asked for here only, for the pictures. */}
            {(st.source === 'needs-file' && !finishedCounts(st)) || st.source === 'invalid' ? null : filePicker}
          </p>
        </section>
      ) : null}
      <details className="sh-v2-reveal__details">
        <summary>{W.details}</summary>
        {counts ? <p>{`${W.revealed} ${counts.latest} · ${W.final} ${counts.finalized} · ${counts.size}`}</p> : null}
        {progress ? <p>{`${W.reserved}: ${ethUp(progress.reservedWei)}`}</p> : null}
        {codes.length > 0 ? <p className="sh-v2-address">{codes.map((code) => (code in REASON_WORDS ? code : `${code} (?)`)).join(' · ')}</p> : null}
      </details>
    </section>
  );
}
