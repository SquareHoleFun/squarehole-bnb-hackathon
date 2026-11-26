/**
 * TA-50: a hidden-art box's draws on its page (hidden-draws.ts). Numbers and pictures first: the draw's price, each
 * draw's state, each item's placeholder until the chain says it is revealed, then its picture checked against the hash
 * the chain stored. The creator loads the reveal file (kept in this tab's memory only, never sent or stored) to open
 * settled draws with their proofs; a drawer without it waits for the reveal. The wallet is asked nothing until a press.
 *
 * SH-203 (SH-202 af2 H): openings go through the reveal session (`createHiddenOpeningSession`, made once the creator's
 * file is loaded on this box's network): Open prepares on its own press and shows the approval (the most this opening can
 * cost, what earlier sends for the item could cost, their sum); Confirm open sends exactly that handle on a second press.
 * The panel adds no sending logic of its own; draws and approvals keep their path (`sendHidden`). Opening words come from
 * reveal-words.ts (the founder's words, desk round 95).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Eip1193Request } from '@squarehole/chain/write/wallet';
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type { Address } from 'viem';
import { rolesOfV2 } from '../../../../../../packages/chain/src/core/v2';
import { usePictureState } from '../../boxes/box-pictures';
import { WithheldTile } from '../../pictures/WithheldTile';
import { formatToken } from '../../fit-pair/fit-format';
import { BrowserWalletDialog, DemoWalletDialog, useWallet } from '../../wallet';
import { roundUpFit } from '../box0/box0-model';
import { box0ErrorText } from '../box0/box0-send';
import {
  createHiddenOpeningSession, DrawBountyRoseError, drawOpen, drawPriceUnavailable, drawRows, hiddenIO, hiddenRolesOf, prepareDrawV2, readHiddenDraws, readOnlyIO, sendHidden,
  type DrawPlanV2, type DrawRow, type HiddenDraw, type HiddenIO, type HiddenReads, type HiddenRoles,
} from './hidden-draws';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { readRevealFile, RevealFileError, type RevealFile } from './reveal-file';
import type { HiddenOpeningHandle } from './reveal-hidden';
import type { RevealSession, RevealSessionState } from './reveal-session';
import { RevealRecoveryV2, useSourceRetry } from './RevealRecoveryV2';
import { HIDDEN_OPEN_WORDS as O, REVEAL_WORDS as W, ethUp, reasonText } from './reveal-words';
import { NATIVE_SYMBOL } from '../../data-source/native-coin';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;
const READ_MS = 12_000;
/** ETH rounded UP at 4 decimals: a charge is never shown below what may be sent. */
const ethDrawUp = (raw: bigint): string => formatToken(((raw + 10n ** 14n - 1n) / 10n ** 14n) * 10n ** 14n, NATIVE_SYMBOL, { digits: 4 });

/** The creator's one line beside the file (TA-50): what the file is for and what losing it means. */
export const REVEAL_FILE_LINE = 'Your reveal file proves each item. Load it to open drawn items.';

export interface HiddenDrawsV2Props {
  readonly view: V2Snapshot;
  readonly source: V2Source;
  readonly ticker: string;
  /** A stale or unverified read: every press waits. */
  readonly disabled: boolean;
  /** Test seams: the chain reads, and the RPC edge of a send. */
  readonly read?: (roles: HiddenRoles, account: Address | null, session: readonly bigint[]) => Promise<HiddenReads>;
  readonly ioFor?: (request: Eip1193Request) => HiddenIO;
  /** Test seam: the opening session's factory (the app passes none: `createHiddenOpeningSession`). */
  readonly createSession?: typeof createHiddenOpeningSession;
}

/** Shown only on a hidden-art box with tickets (open art and token boxes have no hidden draws). */
export function HiddenDrawsV2(props: HiddenDrawsV2Props) {
  const { view, source } = props;
  const roles = useMemo(() => {
    const c = rolesOfV2(view.record).contracts;
    return hiddenRolesOf(source.manifest.chainId, view.record, { tickets: c.tickets, vault: c.vault, collection: c.collection, token: c.token }, view.spec.artMode);
  }, [view.record, view.spec.artMode, source.manifest.chainId]);
  return roles ? <HiddenDrawsPanel {...props} roles={roles} /> : null;
}

type Pending = { readonly kind: 'draw'; readonly plan: DrawPlanV2 };
/**
 * An opening on the session: the draw pressed; then the session's approval handle, named by ITS item (af1 M6); then
 * sending, while the second press's `open` runs.
 */
interface Opening { readonly session: RevealSession; readonly draw: HiddenDraw; readonly handle: HiddenOpeningHandle | null; readonly sending: boolean }

/**
 * An item: its placeholder until revealed on chain, then its picture once the bytes hash to the chain's record.
 * SH-WITHHELD-SITE: a picture our withheld list names is the neutral tile instead (never fetched, never shown).
 */
function ItemFigure({ draw, gateways }: { draw: HiddenDraw; gateways: readonly string[] }) {
  // A null hash fetches nothing: an item's picture is asked for only once the chain stores its revealed hash.
  const { url, withheld } = usePictureState(draw.imageHash, gateways);
  const name = draw.itemId > 0n ? `Item ${draw.itemId}` : `Draw ${draw.id}`;
  if (withheld) return <WithheldTile className="sh-v2-draws__placeholder" label={`${name} · picture withheld`} />;
  if (url) {
    return (
      <figure className="sh-v2-draws__figure" data-hash-checked="">
        <img src={url} alt={name} />
        <figcaption>Hash checked</figcaption>
      </figure>
    );
  }
  // A plain tile, as the box pictures' (SH-NO-PICTURE-GATE): no glyph, word or badge.
  return <div className="sh-v2-draws__placeholder" role="img" aria-label={`${name} · placeholder`} data-placeholder="" />;
}

/** A key per session, so the recovery piece of an earlier session never lives on in a later one (af1 L1). */
const recoveryKeys = new WeakMap<RevealSession, number>();
let nextRecoveryKey = 0;
const recoveryKey = (session: RevealSession): number => {
  let id = recoveryKeys.get(session);
  if (id === undefined) { id = ++nextRecoveryKey; recoveryKeys.set(session, id); }
  return id;
};

const lineOf = (row: DrawRow, account: Address | null): string => {
  const { draw } = row;
  const item = `Item ${draw.itemId}`;
  switch (row.kind) {
    case 'waiting-round': return `Draw ${draw.id} · waiting for its random number`;
    case 'settling': return `Draw ${draw.id} · settling`;
    case 'open': return account !== null && draw.drawer.toLowerCase() === account.toLowerCase() ? item : `${item} · draw ${draw.id}`;
    case 'waiting-reveal': return `${item} · waiting for the reveal`;
    case 'revealed': return item;
    case 'unrevealed': return `${item} · opened without its picture`;
  }
};

function HiddenDrawsPanel({ view, roles, source, ticker, disabled, read, ioFor = hiddenIO.bind(null, source.rpc), createSession = createHiddenOpeningSession }: HiddenDrawsV2Props & { roles: HiddenRoles }) {
  const wallet = useWallet();
  const queries = useQueryClient();
  const ref = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [drawn, setDrawn] = useState<bigint | null>(null);
  const [exporting, setExporting] = useState<RevealSession | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [session, setSession] = useState<readonly bigint[]>([]);
  const [file, setFile] = useState<RevealFile | null>(null);
  // The same file as bytes, for the opening session (which checks it again against the chain).
  const [chosen, setChosen] = useState<File | null>(null);
  const [fileLine, setFileLine] = useState<string | null>(null);
  const [live, setLive] = useState<{ readonly session: RevealSession; readonly state: RevealSessionState } | null>(null);
  const [opening, setOpening] = useState<Opening | null>(null);
  // af2 R2-L2: a first read that failed on the chain makes the session again after a backing-off wait.
  const [retries, setRetries] = useState(0);
  const connected = wallet.status === 'connected' && wallet.account !== null;
  const account = connected ? (wallet.account as Address) : null;
  const wrong = connected && (wallet.chainId !== roles.chainId || wallet.kind !== 'injected');
  const creator = account !== null && account.toLowerCase() === roles.creator.toLowerCase();
  const request = wallet.signer?.request ?? null;
  const walletName = wallet.signer?.walletName ?? '';
  const confirmsInPage = wallet.signer?.confirmsInPage === true;
  const { onAccountsChanged, onChainChanged } = wallet;
  const box = useRef(view);
  const rpc = useRef(source);
  useEffect(() => { box.current = view; rpc.current = source; });
  // The opening session, for the creator on this box's network (af1 M1: with or without a loaded file, so the sends it
  // still checks, their release and the run record are always reachable); made again when the wallet, its network or
  // the file changes (af1 M5: at the moment another file is chosen), and disposed with the panel.
  const liveSession = useRef<RevealSession | null>(null);
  useEffect(() => {
    if (!creator || wrong || account === null || request === null) return undefined;
    const controller = new AbortController();
    let session: RevealSession;
    try {
      session = createSession({ chainId: roles.chainId, box: box.current, account, rpc: rpc.current, signal: controller.signal,
        wallet: { signer: { request, walletName }, onAccountsChanged, onChainChanged }, ...(chosen ? { file: chosen } : {}) });
    } catch {
      return () => controller.abort();
    }
    liveSession.current = session;
    const off = session.subscribe((state) => setLive({ session, state }));
    return () => {
      off(); session.dispose(); controller.abort();
      if (liveSession.current === session) liveSession.current = null;
      setLive((now) => (now?.session === session ? null : now));
    };
  }, [creator, wrong, account, request, walletName, chosen, retries, createSession, roles.chainId, source.rpc, onAccountsChanged, onChainChanged]);
  /** af1 L1: an answer counts only while the session that gave it is still the panel's. */
  const isLive = (session: RevealSession) => liveSession.current === session;
  // af1 M5: only the latest file choice may publish its result.
  const selection = useRef(0);
  const key = ['v2-hidden-draws', source.rpc, roles.tickets, account ?? '', session.join(',')];
  const query = useQuery({ queryKey: key, queryFn: () => (read ?? ((r, a, s) => readHiddenDraws(r, a, s, readOnlyIO(source.rpc))))(roles, account, session), refetchInterval: READ_MS });
  const reads = query.data;
  // Fix round 1 (F2): the latest read failed (the first one, or a later one with older reads still shown). Every press
  // waits until a read succeeds; the panel says Unavailable, with Retry, and is never left out.
  const failed = query.isError;
  const unavailable = (
    <p className="sh-m2-chips">
      <span role="status" data-draws-status="">Unavailable</span>
      {!query.isFetching ? <button type="button" className="sh-chip sh-chip--pending" aria-label="Read failed. Retry" onClick={() => void query.refetch()}>Retry</button> : null}
    </p>
  );
  // The file is kept only while this wallet is the creator's.
  const loaded = creator ? file : null;
  const current = live !== null && creator && !wrong ? live : null;
  const shownOpening = opening !== null && opening.session === current?.session ? opening : null;
  // The approval stands while the session still holds this very handle (a journal change withdraws it), or while it is sent.
  const handle = shownOpening?.handle && (shownOpening.sending || current?.state.opening === shownOpening.handle) ? shownOpening.handle : null;
  // af2 R2-L2: the session withdrew the prepared handle (its journal changed) before the second press: no preparation
  // runs any more, so the panel says so and asks for Open again instead of "Working out the cost…".
  const withdrawn = shownOpening !== null && shownOpening.handle !== null && handle === null;
  useSourceRetry(current?.state ?? null, () => setRetries((n) => n + 1), exporting !== null && exporting === current?.session);
  const recovery = current ? (
    <RevealRecoveryV2 key={recoveryKey(current.session)} session={current.session} state={current.state}
      onExporting={(on) => setExporting(on ? current.session : null)} fileName={`reveal-run-${roles.chainId}-${roles.token.toLowerCase()}.json`}
      confirmsInPage={confirmsInPage} requestOut={shownOpening?.sending === true} />
  ) : null;
  // A pending first draws read shows no panel (as before SH-203), unless the session has something to recover (af2).
  const recoverable = current !== null && (current.state.unresolved.length > 0 || current.state.pollReason !== undefined || current.state.actionReason !== undefined);
  if (!reads) return failed || recoverable ? <section className="sh-panel sh-v2-draws" aria-label="Draws"><h2>Draws</h2>{failed ? unavailable : null}{recovery}</section> : null;
  const offer = drawOpen(reads) && typeof reads.quote === 'bigint' ? reads.quote : null;
  // Fix round 1 (F2): the tickets draw but the price is unread: the draw shows, disabled, as Unavailable.
  const priceUnread = drawPriceUnavailable(reads);
  const rows = drawRows(reads, account, loaded);
  const off = disabled || busy || failed;

  const run = async (work: (io: HiddenIO, me: Address) => Promise<void>) => {
    if (!wallet.signer || !account || wrong || disabled || busy || failed) return;
    setBusy(true);
    setMessage(null);
    try {
      await work(ioFor(wallet.signer.request), account);
    } catch (error) {
      setMessage(box0ErrorText(error));
    } finally {
      setBusy(false);
    }
  };
  const refresh = () => queries.invalidateQueries({ queryKey: ['v2-hidden-draws'] });
  const begin = (next: () => void) => {
    setMessage(null);
    if (!connected) setDialog(true);
    else next();
  };
  const startDraw = () => begin(() => { setOpening(null); void run(async (io, me) => setPending({ kind: 'draw', plan: await prepareDrawV2(roles, me, io) })); });
  /** A session's answer as a message, unless its reason line already says it (the recovery piece shows both owners). */
  const sessionMessage = (session: RevealSession, text: string | null, code?: string) => {
    if (!isLive(session)) return;
    const state = session.getState();
    setMessage(code !== undefined && (code === state.actionReason || code === state.pollReason) ? null : text);
  };
  const dropOpening = (session: RevealSession) => setOpening((now) => (now?.session === session ? null : now));
  /**
   * First press: the session prepares this draw's opening (its own press grant). The approval names the item of the
   * handle it will send (af1 M6); a handle for another item than the row pressed is not offered: open again.
   */
  const openStart = (session: RevealSession, draw: HiddenDraw) => {
    setPending(null);
    setMessage(null);
    setOpening({ session, draw, handle: null, sending: false });
    void session.prepareOpening(draw.id).then(
      (prepared) => {
        if (!isLive(session)) return;
        if (prepared.itemId !== draw.itemId) { dropOpening(session); setMessage(reasonText('changed')); return; }
        setOpening((now) => (now?.session === session && now.draw.id === draw.id && now.handle === null ? { ...now, handle: prepared } : now));
      },
      (error: unknown) => { if (!isLive(session)) return; dropOpening(session); const code = error instanceof Error ? error.message : 'read-failed'; sessionMessage(session, reasonText(code), code); },
    );
  };
  /** Second press: exactly the shown handle is opened; the result names the handle's item. */
  const confirmOpen = (session: RevealSession, shown: HiddenOpeningHandle) => {
    setMessage(null);
    setOpening((now) => (now?.session === session && now.handle === shown ? { ...now, sending: true } : now));
    void session.open(shown).then(
      (result) => { if (!isLive(session)) return; dropOpening(session); sessionMessage(session, result.reason === 'sent' ? O.sent(shown.itemId) : reasonText(result.reason), result.reason === 'sent' ? undefined : result.reason); void refresh(); },
      (error: unknown) => { if (!isLive(session)) return; dropOpening(session); const code = error instanceof Error ? error.message : 'read-failed'; sessionMessage(session, reasonText(code), code); },
    );
  };
  const confirm = () =>
    void run(async (io, me) => {
      if (!pending) return;
      if (pending.kind === 'draw') {
        if (pending.plan.needsApproval) {
          await sendHidden(roles, me, { kind: 'approve', amount: pending.plan.limit }, io);
          setPending({ kind: 'draw', plan: await prepareDrawV2(roles, me, io) });
          setMessage(`${ticker} approved. Now confirm the draw.`);
          return;
        }
        let sent: Awaited<ReturnType<typeof sendHidden>>;
        try {
          // Fix round 1 (F1): exactly the bounty this confirmation showed.
          sent = await sendHidden(roles, me, { kind: 'draw', limit: pending.plan.limit, value: pending.plan.value }, io);
        } catch (error) {
          if (!(error instanceof DrawBountyRoseError)) throw error;
          // Nothing was sent: the new amount is shown and needs its own confirmation.
          setPending(null);
          setPending({ kind: 'draw', plan: await prepareDrawV2(roles, me, io) });
          setMessage(error.message);
          return;
        }
        if (sent.ticketId !== undefined) setSession((s) => [...s, sent.ticketId as bigint]);
        setDrawn(sent.ticketId ?? null);
        setMessage('Drawn.');
      }
      setPending(null);
      await refresh();
    });
  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (!picked) return;
    // af1 M5: the earlier file and its session end at the choice itself (its approval too); only this choice may publish.
    const mine = ++selection.current;
    setOpening(null);
    setFile(null);
    setChosen(null);
    setFileLine(O.readingFile);
    try {
      // The collection's size and root as the chain reads them now; ids run from 1 (FIRST_ID) in every created box.
      if (reads.firstId !== 1n) throw new RevealFileError('This box’s items cannot be opened with a reveal file.');
      const parsed = await readRevealFile(picked, reads.revealRoot, reads.collectionSize);
      if (mine !== selection.current) return;
      setFile(parsed);
      setChosen(picked);
      setFileLine(`Reveal file · ${parsed.n} items`);
    } catch (error) {
      if (mine !== selection.current) return;
      setFileLine(error instanceof RevealFileError ? error.message : 'This reveal file could not be read.');
    }
  };

  // Hidden only on the chain's own answer: no draw now (the phase, or the vault's refusal), nothing followed, not the creator.
  if (offer === null && !priceUnread && rows.length === 0 && !creator && !failed) return null;
  return (
    <section className="sh-panel sh-v2-draws" aria-label="Draws">
      <h2>Draws</h2>
      {wrong ? <p>Connect a browser wallet on this box’s network.</p> : null}
      {offer !== null || priceUnread ? (
        <button ref={ref} type="button" className="sh-button sh-button--primary" disabled={off || offer === null} onClick={startDraw}>
          {`Draw one · ${offer !== null ? formatToken(roundUpFit(offer), ticker) : 'Unavailable'}`}
        </button>
      ) : null}
      {failed || priceUnread ? unavailable : null}
      {rows.length > 0 ? (
        <ul className="sh-v2-draws__rows">
          {rows.map((row) => (
            <li key={String(row.draw.id)} data-draw={String(row.draw.id)} data-state={row.kind}>
              <ItemFigure draw={row.draw} gateways={source.art ?? []} />
              <span>{lineOf(row, account)}</span>
              {row.kind === 'open' ? (
                <button type="button" className="sh-button" disabled={off || current === null || chosen === null || current.state.source !== 'ready' || current.state.busy}
                  onClick={() => begin(() => { if (current) openStart(current.session, row.draw); })}>
                  {O.open}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {creator ? (
        <div className="sh-v2-draws__file">
          <input ref={fileInput} id="sh-v2-reveal-file" type="file" accept=".json,application/json" className="sh-visually-hidden" aria-label="Reveal file" onChange={(event) => void onFile(event)} />
          <button type="button" className="sh-button" onClick={() => fileInput.current?.click()}>
            {loaded ? 'Load another reveal file' : 'Load reveal file'}
          </button>
          <p role="status" data-reveal-file="">{fileLine ?? REVEAL_FILE_LINE}</p>
        </div>
      ) : null}
      <details>
        <summary>How draws work</summary>
        <p>A draw takes one hidden item. It waits for a public random number (drand), then names the item.</p>
        <p>The item opens with its proof from the creator’s reveal file, posted by the creator or the reveal service. After reveal, its picture can show when verified bytes are available and the picture is not withheld.</p>
      </details>
      {pending ? (
        <div role="group" aria-label="Confirm transaction">
          <p>{`Up to ${formatToken(roundUpFit(pending.plan.limit), ticker)}`}</p>
          <p>{`+ up to ${ethDrawUp(pending.plan.value)} for the random number, the unused part comes back`}</p>
          {pending.plan.short ? <p>{`Not enough ${ticker}`}</p> : null}
          <button type="button" className="sh-button sh-button--primary" disabled={off || wrong || pending.plan.short || priceUnread} onClick={confirm}>
            {busy ? 'Waiting for confirmation…' : pending.plan.needsApproval ? `Approve ${ticker}` : 'Confirm draw'}
          </button>
          <button type="button" className="sh-button" disabled={busy} onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      ) : null}
      {withdrawn ? <p role="status" data-opening-withdrawn="">{O.withdrawn}</p> : null}
      {shownOpening && current && !withdrawn ? (
        <div role="group" aria-label="Confirm transaction" data-opening={String(shownOpening.draw.id)}>
          {handle ? (
            <>
              <p>{O.ask(handle.itemId)}</p>
              <dl>
                <div><dt>{O.cost}</dt><dd>{ethUp(handle.capWei)}</dd></div>
                {handle.spentWei > 0n ? <div><dt>{O.spentBefore}</dt><dd>{ethUp(handle.spentWei)}</dd></div> : null}
                <div><dt>{O.together}</dt><dd>{ethUp(handle.ceilingWei)}</dd></div>
              </dl>
            </>
          ) : <p>{O.preparing}</p>}
          <button type="button" className="sh-button sh-button--primary" disabled={off || wrong || handle === null || shownOpening.sending || current.state.busy}
            onClick={() => { if (handle) confirmOpen(current.session, handle); }}>
            {/* af5 (R4-L3b): a wallet that signs on the press asks for no confirmation; the page's own busy line then. */}
            {shownOpening.sending ? (confirmsInPage ? W.busy : O.waiting) : O.confirm}
          </button>
          <button type="button" className="sh-button" disabled={shownOpening.sending} onClick={() => setOpening(null)}>
            Cancel
          </button>
        </div>
      ) : null}
      {current && chosen !== null && current.state.source === 'invalid' ? <p role="status" data-opening-source="">{reasonText(current.state.actionReason ?? 'invalid-source', 'source')}</p> : null}
      {message ? <p role="status" data-draws-message="">{message === 'Drawn.' && !failed && rows.some(row => row.draw.id === drawn && row.kind === 'waiting-round') ? 'Drawn · waiting for its random number' : message}</p> : null}
      {recovery}
      <BrowserWalletDialog open={dialog && wallet.defaultDialog === 'browser'} onClose={() => setDialog(false)} returnFocus={ref} />
      {DEMO_BUILD ? <DemoWalletDialog open={dialog && wallet.defaultDialog === 'demo'} onClose={() => setDialog(false)} returnFocus={ref} /> : null}
    </section>
  );
}
