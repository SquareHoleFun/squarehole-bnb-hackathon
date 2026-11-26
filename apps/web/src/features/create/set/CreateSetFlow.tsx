/**
 * `/create/set-<step>` (SH-EXISTING-NFTS-E08C): launch a box of NFTs that already exist, the existing-NFTs add-on
 * (docs/design/existing-nfts-v2.md): 10 to 10,000 items of one outside ERC-721 collection, all the creator's, in a box
 * with its own token; after graduation holders pick named items for the token or return them; if the raise fails, the
 * items go back to the creator. Four steps: Basics, Items, Raise, Overview.
 *
 * Local only until the add-on's release ticket: the page needs the add-on on this source, its factory checked
 * (features/set/set-build.ts). On the Overview the creator saves the list file (bound to the set hash), connects a
 * browser wallet (on a click, never on navigation) and presses Create: the run sends one checked transaction at a time
 * (set-send.ts) and resumes from the chain after a reload. Nothing here sends anything without a press.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { Address } from 'viem';
import { setSpecV2Hash } from '@squarehole/box-spec';
import { PAGE_TITLE_ID, usePageTitle } from '../../../pages/page-parts';
import { useDataSource } from '../../data-source';
import { BrowserWalletDialog, useWallet } from '../../wallet';
import { useSetSource, type SetSource } from '../../set/set-build';
import { rpcSetReads, type SetReads } from '../../set/set-reads';
import type { SetSubmit } from '../../set/set-calls';
import { BROWSER_ART, readPicture, type ArtEnvironment } from '../art-files';
import { BackGlyph, focusControl } from '../create-parts';
import type { SiteListing } from '../v2/listings';
import { buildSetSpec, itemsOf, listingOf, setIssues, type SetIssue } from './set-create-model';
import { clearSetDraft, updateSetDraft, useSetDraft } from './set-draft';
import { listSavedFor, saveFile, setListFile } from './set-list-file';
import { useSetListings } from './set-listings';
import { planRows, planTransactions } from './set-send';
import { SET_STEPS, setIndex, setPath, type SetStepId } from './set-steps';
import { SetBasicsStep, SetItemsStep, SetRaiseStep } from './SetSteps';
import { SetOverview, SetSendPanel } from './SetOverview';
import { useSetCreate } from './useSetCreate';
import './create-set.css';

/** The list file could not be built or saved (the browser refused it). */
export const LIST_FILE_FAILED = 'The list file could not be saved. Try again.';
/** Before Create: the file proves the box's list; one line beside the button. */
export const LIST_FILE_NOTE = 'Keep this file: it lists every item in order. Save it before Create.';
export const NO_SENDER = 'Sending is not available in this build.';

function useShown(step: SetStepId, live: readonly SetIssue[]) {
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [submitted, setSubmitted] = useState<ReadonlySet<SetStepId>>(() => new Set());
  const [summaryKey, setSummaryKey] = useState(0);
  const touch = useCallback((control: string) => setTouched((before) => (before.has(control) ? before : new Set([...before, control]))), []);
  const errorFor = useCallback((control: string) => {
    const issue = live.find((entry) => entry.step === step && entry.control === control);
    return issue && (submitted.has(step) || touched.has(control)) ? issue.message : null;
  }, [live, step, submitted, touched]);
  const submit = (issues: readonly SetIssue[]) => {
    setSubmitted((before) => new Set([...before, step]));
    if (issues.length > 0) setSummaryKey((key) => key + 1);
    return issues.length > 0;
  };
  const summary = submitted.has(step) ? live.filter((issue) => step === 'set-overview' || issue.step === step) : [];
  return { touch, errorFor, submit, summaryKey, summary };
}

function Summary({ issues, focusKey, onGo }: { issues: readonly SetIssue[]; focusKey: number; onGo: (issue: SetIssue) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (focusKey > 0) ref.current?.focus();
  }, [focusKey]);
  if (issues.length === 0) return null;
  return (
    <div ref={ref} className="sh-newbox-summary" role="alert" aria-labelledby={titleId} tabIndex={-1}>
      <p id={titleId} className="sh-newbox-summary__title">{issues.length === 1 ? 'One thing to fix' : `${issues.length} things to fix`}</p>
      <ul>
        {issues.map((issue) => (
          <li key={`${issue.control}-${issue.message}`}>
            <a href={`#${issue.control}`} onClick={(event) => { event.preventDefault(); onGo(issue); }}>{issue.message}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stepper({ step, reachable, fix }: { step: SetStepId; reachable: number; fix: ReadonlySet<SetStepId> }) {
  const at = setIndex(step);
  return (
    <nav className="sh-newbox-steps" aria-label="Steps">
      <p className="sh-newbox-steps__count" aria-hidden="true">{`${at + 1}/${SET_STEPS.length}`}</p>
      <ol>
        {SET_STEPS.map((entry, index) => {
          const content = (
            <>
              <span className="sh-newbox-steps__dot" aria-hidden="true" />
              <span className="sh-newbox-steps__label">{entry.label}{fix.has(entry.id) ? <span className="sh-newbox-steps__fix"> · Fix</span> : null}</span>
            </>
          );
          return (
            <li key={entry.id} data-state={index < at ? 'done' : index === at ? 'current' : 'todo'} data-fix={fix.has(entry.id) || undefined} aria-current={index === at ? 'step' : undefined}>
              {index < reachable && index !== at ? <Link to={setPath(entry.id)} className="sh-newbox-steps__link">{content}</Link>
                : <span className="sh-newbox-steps__link" aria-disabled={index < reachable ? undefined : 'true'}>{content}</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export interface CreateSetFlowProps {
  readonly step: SetStepId;
  readonly env?: ArtEnvironment;
  /** Test seams: the add-on's source, its price coins, the chain's reads and E-08B's sender. */
  readonly source?: SetSource | null;
  readonly listings?: readonly SiteListing[];
  readonly reads?: SetReads;
  readonly submit?: SetSubmit | null;
}

export function CreateSetFlow(props: CreateSetFlowProps) {
  const checked = useSetSource();
  const source = props.source !== undefined ? props.source : checked.status === 'ready' ? checked.source : null;
  if (!source) {
    const line = props.source === null || checked.status === 'none' || checked.status === 'invalid' ? 'Existing NFTs are not on this source.' : checked.status === 'refused' ? 'Existing NFTs are not available here now.' : 'Reading…';
    return <SetCreateLine line={line} back />;
  }
  return <CreateSetSource {...props} source={source} />;
}

/** The page before the flow can start: one status line (and the way back to Launch when the add-on is not here). */
function SetCreateLine({ line, back = false }: { line: string; back?: boolean }) {
  usePageTitle('Launch a box · Existing NFTs');
  return (
    <section className="sh-page sh-newbox" aria-labelledby={PAGE_TITLE_ID}>
      <h1 id={PAGE_TITLE_ID} className="sh-newbox__title" tabIndex={-1}>Existing NFTs</h1>
      <p role="status">{line}</p>
      {back ? <p><Link to="/create/v2-basics">Launch a box</Link></p> : null}
    </section>
  );
}

function CreateSetSource(props: CreateSetFlowProps & { readonly source: SetSource }) {
  const read = useSetListings(props.listings ? null : props.source, props.reads);
  const listings = props.listings ?? read.listings;
  if (!listings) return <SetCreateLine line={read.error ?? 'Reading price coins…'} />;
  if (listings.length === 0) return <SetCreateLine line="No price coins listed yet" />;
  return <CreateSetReady {...props} listings={listings} />;
}

function CreateSetReady({ step, env = BROWSER_ART, source, listings, reads: givenReads, submit }: CreateSetFlowProps & { readonly source: SetSource; readonly listings: readonly SiteListing[] }) {
  const draft = useSetDraft();
  const data = useDataSource();
  const wallet = useWallet();
  const navigate = useNavigate();
  const location = useLocation();
  const label = SET_STEPS[setIndex(step)]?.label ?? '';
  usePageTitle(`Launch a box · ${label}`);
  const owner: Address | null = wallet.status === 'connected' ? wallet.account : null;
  const listing = listingOf(draft, listings);
  const items = itemsOf(draft);
  const issues = useMemo(() => setIssues(draft, listings), [draft, listings]);
  const spec = useMemo(() => (listing ? buildSetSpec(draft, listing, items) : null), [draft, listing, items]);
  const specHash = useMemo(() => {
    try { return spec ? setSpecV2Hash(spec) : null; } catch { return null; }
  }, [spec]);
  const fix = useMemo(() => new Set(issues.map((issue) => issue.step)), [issues]);
  const reachable = fix.has('set-basics') ? 1 : fix.has('set-items') ? 2 : SET_STEPS.length;
  const shown = useShown(step, issues);
  const reads = useMemo(() => givenReads ?? rpcSetReads(source.rpc), [givenReads, source.rpc]);
  const coin = listing ?? { symbol: 'P', decimals: 0 };
  const signer = wallet.signer;
  const send = useSetCreate({ source, spec: issues.length === 0 ? spec : null, ids: items?.ids ?? null, owner, wallet: signer?.request ?? null, coin, reads, ...(submit !== undefined ? { submit } : {}) });
  const listSaved = listSavedFor(draft.listSaved, items?.commitment ?? null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [logo, setLogo] = useState<{ readonly busy: boolean; readonly problem: string | null }>({ busy: false, problem: null });
  const [browserOpen, setBrowserOpen] = useState(false);
  const fromOverview = (location.state as { fromOverview?: boolean } | null)?.fromOverview === true && step !== 'set-overview';

  const go = (issue: SetIssue) => (issue.step === step ? focusControl(issue.control) : navigate(setPath(issue.step), { state: { fromOverview: step === 'set-overview' } }));
  const next = (event: FormEvent) => {
    event.preventDefault();
    if (shown.submit(issues.filter((issue) => issue.step === step))) return;
    const following = SET_STEPS[setIndex(step) + 1];
    if (fromOverview) navigate(setPath('set-overview'));
    else if (following) navigate(setPath(following.id));
  };
  const onLogo = (file: File) => {
    setLogo({ busy: true, problem: null });
    void readPicture(file, env, 'logo').then(
      (result) => {
        if ('error' in result) { setLogo({ busy: false, problem: result.error }); return; }
        updateSetDraft((d) => ({ ...d, logo: result.picture }));
        setLogo({ busy: false, problem: null });
      },
      () => setLogo({ busy: false, problem: 'The file could not be read.' }),
    );
  };
  const saveList = () => {
    if (!items) return;
    setFileProblem(null);
    try {
      const file = setListFile(items, draft.ticker);
      if (!saveFile(file.name, file.text)) { setFileProblem(LIST_FILE_FAILED); return; }
      updateSetDraft((d) => ({ ...d, listSaved: file.ack }));
    } catch {
      setFileProblem(LIST_FILE_FAILED);
    }
  };
  // Only a press that resumes the saved run skips the draft's checks; any other press prepares this draft, so it must
  // pass every check and its list file must be saved for exactly its set hash.
  const create = () => {
    if (!send.resumes && (shown.submit(issues) || !listSaved)) return;
    void send.start();
  };
  const startOver = () => {
    clearSetDraft();
    send.forget();
    setFileProblem(null);
    navigate(setPath('set-basics'));
  };

  const stepProps = { draft, errorFor: shown.errorFor, touch: shown.touch };
  const overview = step === 'set-overview';
  const previous = SET_STEPS[setIndex(step) - 1];
  const planned = spec ? planRows(spec, listing?.bootstrap ?? 0n, coin, { approved: false, created: false, approvedAll: false, loaded: 0, complete: false }) : [];
  const view = send.view;
  const over = view.phase === 'done' || view.phase === 'closed';
  const connected = owner !== null && signer !== null;
  const wrongChain = signer !== null && wallet.chainId !== source.chainId;
  const progress = 'progress' in view ? view.progress : null;
  const resume = send.resumes && (view.phase === 'stopped' || view.phase === 'failed');
  return (
    <section className="sh-page sh-newbox sh-set-create" aria-labelledby={PAGE_TITLE_ID} data-step={step}>
      <header className="sh-newbox__head">
        <h1 id={PAGE_TITLE_ID} className="sh-newbox__title" tabIndex={-1}>
          <span className="sh-visually-hidden">{`Launch a box of existing NFTs, step ${setIndex(step) + 1} of ${SET_STEPS.length}: `}</span>
          {label}
        </h1>
        <span className="sh-status-chip sh-newbox__source" data-disclosure="">{data.dataLabel}</span>
        <Stepper step={step} reachable={reachable} fix={overview || shown.summary.length > 0 ? fix : new Set()} />
      </header>
      <p className="sh-set-create__kind">Existing NFTs</p>
      <form className="sh-newbox__form" noValidate onSubmit={next} aria-labelledby={PAGE_TITLE_ID}>
        <Summary issues={shown.summary} focusKey={shown.summaryKey} onGo={go} />
        {step === 'set-basics' ? <SetBasicsStep {...stepProps} listings={listings} listing={listing} logo={{ ...logo, onFile: onLogo }} /> : null}
        {step === 'set-items' ? <SetItemsStep {...stepProps} /> : null}
        {step === 'set-raise' ? <SetRaiseStep {...stepProps} listing={listing} /> : null}
        {overview ? (
          <SetOverview draft={draft} listing={listing} items={items} spec={spec} specHash={specHash} fix={fix} listSaved={listSaved}
            reads={reads} chainId={source.chainId} ipfs={source.art}
            plan={<SetSendPanel view={view} planned={planned} transactions={send.runSpec ? planTransactions(send.runSpec) : spec ? planTransactions(spec) : 0} runTicker={send.otherBox} />} />
        ) : null}
        <div className="sh-newbox__bar" data-place={overview ? 'inline' : undefined}>
          {previous && !fromOverview ? (
            <Link to={setPath(previous.id)} className="sh-button sh-newbox__back" aria-label={`Back to ${previous.label}`}><BackGlyph /></Link>
          ) : null}
          {!overview ? (
            <button type="submit" className="sh-button sh-button--primary sh-newbox__next">{fromOverview ? 'Back to overview' : 'Next'}</button>
          ) : over ? (
            <>
              <Link to={view.box} className="sh-button sh-button--primary">Open your box</Link>
              {progress?.approvedAll ? <button type="button" className="sh-button" disabled={send.revoking?.state === 'sending'} onClick={() => void send.revoke()}>Revoke loading approval</button> : null}
              <button type="button" className="sh-button" onClick={startOver}>Start a new box</button>
            </>
          ) : !connected ? (
            <button type="button" className="sh-button sh-button--primary" aria-haspopup="dialog" onClick={() => setBrowserOpen(true)}>Connect to create</button>
          ) : wrongChain ? (
            <button type="button" className="sh-button sh-button--primary" onClick={() => void wallet.switchChain(source.chainId).catch(() => undefined)}>Switch network</button>
          ) : view.phase === 'running' ? (
            <button type="button" className="sh-button sh-button--primary" disabled={view.stopping} onClick={send.stop}>Stop</button>
          ) : view.phase === 'preparing' ? (
            <button type="button" className="sh-button sh-button--primary" disabled>Create</button>
          ) : !send.resumes && !listSaved ? (
            <button type="button" className="sh-button sh-button--primary" disabled={items === null} onClick={saveList}>Save list file</button>
          ) : (
            <button type="button" className="sh-button sh-button--primary" disabled={!send.canSend || (!resume && issues.length > 0)} onClick={create}>{resume ? 'Continue' : 'Create'}</button>
          )}
          {/* A loading attempt that stopped or failed leaves the vault's approval on: it can be taken back now (design
              § 4.11); Continue asks for it again. */}
          {overview && !over && connected && !wrongChain && (view.phase === 'failed' || view.phase === 'stopped') && progress?.approvedAll ? (
            <button type="button" className="sh-button" disabled={send.revoking?.state === 'sending'} onClick={() => void send.revoke()}>Revoke loading approval</button>
          ) : null}
          {overview && !over && listSaved && items ? <button type="button" className="sh-button sh-newbox-download" onClick={saveList}>List file</button> : null}
          {overview && !over && !listSaved && !send.resumes ? <p className="sh-newbox-note" data-list-note="">{LIST_FILE_NOTE}</p> : null}
          {overview && !send.canSend ? <p className="sh-newbox-note" data-no-sender="">{NO_SENDER}</p> : null}
          {fileProblem ? <p className="sh-newbox-error" role="alert"><span aria-hidden="true">!</span> {fileProblem}</p> : null}
          {send.revoking ? <p className="sh-newbox-status" role="status" data-revoke-status="">{send.revoking.state === 'failed' ? send.revoking.message : send.revoking.state === 'sending' ? 'Revoking · confirm in your wallet' : 'Loading approval revoked'}</p> : null}
          {overview && over ? null : overview ? <button type="button" className="sh-newbox-text-button" onClick={startOver}>Start over</button> : null}
        </div>
      </form>
      <BrowserWalletDialog open={browserOpen} onClose={() => setBrowserOpen(false)} />
    </section>
  );
}
