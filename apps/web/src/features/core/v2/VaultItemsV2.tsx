/**
 * SH-TA-33: the items panel of a v2 box with a collection. Numbers first (what one item costs to take out, what one
 * brings back, how many are in the vault), then the items in the vault with their pictures (checked against the hash
 * the collection committed at reveal, box-pictures.ts) and the wallet's own items with Put back. Each action is one
 * press; each of its transactions (an exact approval when needed, then the take or the put-back) is one wallet
 * confirmation, through the shared sender's allowlist (vault-items.ts). Opening the page asks the wallet nothing.
 *
 * T06: a revealed item with a 3D model (its nonzero modelHash) has a 3D button on its picture. Only a press opens its
 * model, in the box pages' sheet (BoxSheet: Escape, Close or the backdrop close it, and focus goes back to the button):
 * the picture first, the model once it is drawn (scene/ItemModelView.tsx, every check of loadItemModel), the picture
 * again with "3D unavailable" when it cannot be. Drag or touch turns it; with focus, so do the arrow keys. Nothing of a
 * model, and no three.js, is asked for on navigation, and never for an unrevealed or a 2D item.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatUnits, type Address } from '@squarehole/domain';
import type { Hex } from 'viem';
import { BrowserWalletDialog, DemoWalletDialog, useWallet } from '../../wallet';
import { usePictureState } from '../../boxes/box-pictures';
import { WithheldTile } from '../../pictures/WithheldTile';
import { BoxSheet } from '../../boxes/BoxSheet';
import { InfoButton, InfoPanel, useInfoTip } from '../../fit-pair/InfoTip';
import { ItemModelView, type ItemModelLoader, type ItemModelOutcome } from '../../scene/ItemModelView';
import type { V2Snapshot, V2Source } from './indexer-v2';
import {
  LIMIT_BPS, VAULT_PAGE, insideCandidates, inventoryOf, mineCandidates, modelUrlV2, pendingMoves, readForSend, readItemsV2, REFRESH_LINE, sendPutBackV2, sendTakeOutV2, vaultErrorText, vaultItemsIO, vaultRolesOf,
  type VaultItemV2, type VaultItemsIO, type VaultMoveV2, type VaultStepV2,
} from './vault-items';
import { claimVaultRun, expireVaultMoves } from './vault-operations';
import { ITEM_NOT_REVEALED, reasonText } from './reveal-words';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;
const readOnly = async (): Promise<never> => { throw new Error('Read-only'); };

/** One action's state: waiting on a step, confirmed, or failed (with the reason). */
export type VaultRunV2 =
  | { readonly kind: 'take' | 'return'; readonly id: bigint; readonly account: Address; readonly state: 'waiting'; readonly step: VaultStepV2 | 'checking' }
  | { readonly kind: 'take' | 'return'; readonly id: bigint; readonly account: Address; readonly state: 'confirmed' }
  | { readonly kind: 'take' | 'return'; readonly id: bigint; readonly account: Address; readonly state: 'failed'; readonly reason: string };

/** The status line of an action, a few words: what the wallet is asked now, or how it ended. */
export function runText(run: VaultRunV2): string {
  const what = `${run.kind === 'take' ? 'Take out' : 'Put back'} #${run.id}`;
  if (run.state === 'confirmed') return run.kind === 'take' ? `Confirmed · #${run.id} is in your wallet` : `Confirmed · #${run.id} is back in the vault`;
  if (run.state === 'failed') return `Failed · ${run.reason}`;
  if (run.step === 'confirming') return 'Waiting for confirmation…';
  if (run.step === 'checking') return `${what} · checking…`;
  return `Waiting · ${run.step === 'approve' ? (run.kind === 'take' ? 'approve coins' : 'approve the item') : what} in your wallet…`;
}

export interface VaultItemsV2Props {
  readonly view: V2Snapshot;
  readonly source: V2Source;
  readonly ticker: string;
  /** A stale or unverified read: actions wait. */
  readonly disabled: boolean;
  /** Tests replace the chain and wallet boundary; the page uses vault-items.ts `vaultItemsIO`. */
  readonly io?: (request: Parameters<typeof vaultItemsIO>[2]) => VaultItemsIO;
  /** T06 test seam: how a model is read and drawn (default: scene/ItemModelView.tsx `loadModel`). */
  readonly modelLoader?: ItemModelLoader;
  /** SH-203: the creator's way into Reveal items (RevealEntryV2, which shows only for the creator while items are left). */
  readonly reveal?: ReactNode;
}

/** An item's picture once its bytes verify; SH-WITHHELD-SITE: the neutral tile when our withheld list names it. */
function ItemPicture({ hash, revealed, gateways, id, className = 'sh-vault-item__picture' }: { hash: `0x${string}` | null; revealed: boolean; gateways: readonly string[]; id: bigint; className?: string }) {
  const { url, withheld } = usePictureState(hash, gateways);
  if (withheld) return <WithheldTile className={className} label={`Item #${id}, picture withheld`} />;
  return url ? <img className={className} src={url} width={160} height={160} alt={`Item #${id}`} loading="lazy" decoding="async" />
    : <span className={`${className} sh-vault-item__picture--none`} role="img" aria-label={revealed ? `Item #${id}, picture unavailable` : `Item #${id}, not revealed`} />;
}

type ModelItem = VaultItemV2 & { readonly modelHash: Hex };
/** T06: a revealed item whose model can be asked for (a nonzero committed hash, and a gateway to ask: modelUrlV2). */
const withModel = (item: VaultItemV2, gateways: readonly string[]): item is ModelItem => item.revealed && modelUrlV2(item.modelHash, gateways) !== null;

/**
 * SH-203 on the line: why an unrevealed item's button is off, said on its tile (ITEM_NOT_REVEALED) and tied to that
 * button (`aria-describedby`); a revealed item gets no line.
 */
function NotRevealed({ id }: { id: string }) {
  return <p id={id} className="sh-vault-item__note" data-not-revealed="">{ITEM_NOT_REVEALED}</p>;
}

/** An item's picture, with its 3D button when it has a model. */
function ItemArt({ item, gateways, onModel }: { item: VaultItemV2; gateways: readonly string[]; onModel: (item: ModelItem) => void }) {
  return <div className="sh-vault-item__art">
    <ItemPicture revealed={item.revealed} hash={item.imageHash} gateways={gateways} id={item.id} />
    {withModel(item, gateways) ? <button type="button" className="sh-vault-item__3d" aria-label={`View 3D model of item ${item.id}`} onClick={() => onModel(item)}>3D</button> : null}
  </div>;
}

/**
 * T06: one item's model in the box pages' sheet. Its picture stays until the model is drawn, and stays with "3D
 * unavailable" when it cannot be; closing the sheet unmounts the view, which aborts the read and disposes the renderer.
 * The model is asked of the source's first gateway only, once (XR-ITEM-3D-V2 F3).
 */
function ModelSheet({ item, gateways, load, onClose }: { item: ModelItem; gateways: readonly string[]; load?: ItemModelLoader; onClose: () => void }) {
  const titleId = useId();
  const hintId = useId();
  const [outcome, setOutcome] = useState<ItemModelOutcome | null>(null);
  const url = modelUrlV2(item.modelHash, gateways);
  return <BoxSheet titleId={titleId} title={`Item #${item.id}`} onClose={onClose} className="sh-box-sheet--model">
    <div className="sh-vault-model" data-model={outcome ?? 'loading'} aria-busy={outcome === null ? true : undefined}>
      {url !== null ? <ItemModelView url={url} sha256={item.modelHash} label={`3D model of item #${item.id}`} className="sh-vault-model__view" keyboard anonymous describedBy={outcome === 'shown' ? hintId : undefined} onOutcome={setOutcome} load={load} /> : null}
      {outcome !== 'shown' ? <ItemPicture revealed={item.revealed} hash={item.imageHash} gateways={gateways} id={item.id} className="sh-vault-model__picture" /> : null}
    </div>
    {outcome === 'shown' ? <p id={hintId} className="sh-visually-hidden">Drag, or use the arrow keys, to turn it.</p> : null}
    {outcome === 'failed' ? <p role="status" className="sh-vault-model__status">3D unavailable</p> : null}
  </BoxSheet>;
}

/**
 * SH-235 (founder, 17 Nov 2026: "Make a button with (?) and hide the details there"): the card's heading with its info
 * button, and right after it the panel the button opens (fit-pair/InfoTip.tsx, as the box page's Price card in
 * boxes/OwningPanel.tsx). The card reads and works without it; the panel starts closed.
 */
function ItemsHead({ ticker, quote, roles }: {
  ticker: string;
  quote: { readonly pickFeeBps: bigint | null; readonly returnFeeBps: bigint | null } | null;
  roles: { readonly vault: Address; readonly collection: Address; readonly tickets: Address | null };
}) {
  const tip = useInfoTip();
  return <>
    <div className="sh-box-block-head"><h2>Items</h2><InfoButton tip={tip} label="Item details" /></div>
    <InfoPanel tip={tip}>
      {quote?.pickFeeBps != null && quote.returnFeeBps != null ? <p>{`Taking one out costs one item’s share of the ${ticker} in circulation, plus a ${formatUnits(quote.pickFeeBps, 2)}% fee that is burned. Putting one back pays that share, less a ${formatUnits(quote.returnFeeBps, 2)}% fee that is burned.`}</p> : null}
      <p>{`A price that moves more than ${formatUnits(LIMIT_BPS, 2)}% against you stops the move.`}</p>
      <p>The last item stays when you take one out.</p>
      {roles.tickets ? <p>Items still hidden for draws are not listed; only items that came back can be taken out by number.</p> : null}
      <p className="sh-v2-address">{roles.vault}</p><p className="sh-v2-address">{roles.collection}</p>
    </InfoPanel>
  </>;
}

/**
 * SH-255 (round 3, D10): whether this card's moves are open (its gate; a closed box takes none). The page's "Put it
 * back" entry uses this same rule; whether this reader holds an item is the card's wallet read, made only on a press.
 */
export function vaultMovesOpenV2(view: Pick<V2Snapshot, 'gate' | 'failed'>): boolean {
  return view.gate.open && !view.failed;
}

export function VaultItemsV2({ view, source, ticker, disabled, io, modelLoader, reveal }: VaultItemsV2Props) {
  const roles = vaultRolesOf(view);
  const wallet = useWallet(); const queries = useQueryClient(); const primary = useRef<HTMLButtonElement>(null);
  const noteId = useId();
  const [page, setPage] = useState(0);
  const [minePage, setMinePage] = useState(0);
  const [run, setRun] = useState<VaultRunV2 | null>(null);
  // SH-235: an action holds the whole card from its press until the refresh after it has finished; the ref closes the
  // gap before React renders the busy state (a second press in the same tick).
  const [acting, setActing] = useState(false);
  const latch = useRef(false);
  const [dialog, setDialog] = useState(false);
  // T06: the one item whose model is open (one WebGL view at a time); null: none.
  const [viewing, setViewing] = useState<ModelItem | null>(null);
  const chainId = source.manifest.chainId;
  const account = wallet.status === 'connected' && wallet.account ? wallet.account.toLowerCase() as Address : null;
  const wrong = account !== null && (wallet.chainId !== chainId || wallet.kind !== 'injected');
  const make = io ?? ((request) => vaultItemsIO(source, view, request));
  const reader = make(readOnly);
  const base = ['v2-vault', source.network, chainId, roles?.vault ?? null] as const;
  // SH-235: the items history of a box whose fees pay its items, else the vault inventory every collection vault has.
  const history = inventoryOf(view);
  // Places proved in this visit (newest first), overlaid until the feed reaches their blocks; never send locks.
  const movesKey = [...base, 'moves'] as const;
  const { data: moves = [] } = useQuery<readonly VaultMoveV2[]>({ queryKey: movesKey, queryFn: skipToken, gcTime: Infinity, staleTime: Infinity });
  const pending = pendingMoves(moves, history, view.block);
  // Receipts and increases in the mined count raise the account's floor. No later look may be older.
  queries.setQueryDefaults([...base, 'floor'], { gcTime: Infinity });
  queries.setQueryDefaults([...base, 'count'], { gcTime: Infinity });
  const floorKey = (who: Address) => [...base, 'floor', who.toLowerCase()] as const;
  const floor = () => account ? queries.getQueryData<bigint>(floorKey(account)) ?? 0n : 0n;
  const onReceipt = (block: bigint) => { if (account) queries.setQueryData<bigint>(floorKey(account), (before = 0n) => before > block ? before : block); };
  const onCount = (mined: bigint, block: bigint) => {
    const key = [...base, 'count', account?.toLowerCase()];
    const before = queries.getQueryData<{ mined: bigint; block: bigint }>(key);
    // The count is read at a named block not below the floor.
    // A lower count means a reorg; remember it without lowering the floor.
    if (before === undefined || mined !== before.mined) queries.setQueryData(key, { mined, block });
    if (before === undefined || mined > before.mined) onReceipt(block);
  };
  const live = roles !== null && !view.failed;
  const quote = useQuery({ queryKey: [...base, 'quote', view.blockHash], queryFn: () => reader.quote(), enabled: live, retry: false, placeholderData: (previous) => previous });
  const candidates = roles ? insideCandidates(roles, history, page, VAULT_PAGE, pending) : { ids: [], pages: 1 };
  const mineAll = account ? mineCandidates(history, account, pending) : [];
  const minePages = Math.max(1, Math.ceil(mineAll.length / VAULT_PAGE));
  const mineAt = Math.min(minePage, minePages - 1);
  const mineIds = mineAll.slice(mineAt * VAULT_PAGE, (mineAt + 1) * VAULT_PAGE);
  // Include the finished line's item even off-page. One accepted read checks both lists and that line.
  const ids = [...new Set([...candidates.ids, ...mineIds, ...(run ? [run.id] : [])])];
  const items = useQuery({
    queryKey: [...base, 'items', account, ids.join(','), view.blockHash],
    queryFn: async () => {
      const block = await readForSend(reader.head(floor()));
      if (block < floor()) throw new Error(REFRESH_LINE);
      if (account) { const counts = await readForSend(reader.counts(account, block)); onCount(counts.mined, block); }
      const read = await readForSend(readItemsV2(reader, ids, block));
      if (account && roles) expireVaultMoves(chainId, await readForSend(reader.now(block)));
      const own = read.items.some((item) => mineIds.includes(item.id) && item.outside && item.owner?.toLowerCase() === account);
      const balance = account && !own ? await readForSend(reader.balanceOf(account, block)).catch(() => null) : null;
      return { ...read, block, balance };
    }, enabled: live, retry: false, placeholderData: (previous) => previous,
  });
  const coins = useQuery({ queryKey: [...base, 'coins', account, view.blockHash], queryFn: () => reader.coins(account as Address), enabled: live && account !== null, retry: false });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Also inspect the synchronous floor cache after each render.
  useEffect(() => {
    const read = items.data;
    if (!run || run.state === 'waiting' || !read || items.isPlaceholderData || read.block < floor()) return;
    const item = read.items.find((item) => item.id === run.id);
    if (!item) return;
    const trueNow = run.kind === 'take' ? item.outside && item.owner?.toLowerCase() === run.account : !item.outside && (item.onShelf || item.owner?.toLowerCase() === roles?.vault.toLowerCase());
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Retire stored UI text once an accepted external read disproves it; the null guard prevents a loop.
    if (run.state === 'confirmed' && !trueNow) setRun(null);
    if (run.state === 'failed' && [reasonText('unknown-send'), 'Sent, but not confirmed. Check your wallet before trying again.'].includes(run.reason) && trueNow) {
      queries.setQueryData<readonly VaultMoveV2[]>(movesKey, (before = []) => [{ id: run.id, inside: run.kind === 'return', account: run.account, block: read.block }, ...before]);
      setRun(null);
    }
  });
  // Another wallet or network drops a finished line (also on switching back).
  const scope = `${account}:${wallet.chainId}:${wallet.kind}`;
  const [seenScope, setSeenScope] = useState(scope);
  if (seenScope !== scope) { setSeenScope(scope); if (run?.state !== 'waiting') setRun(null); }
  if (!roles) return null;

  const t = (raw: bigint) => `${formatUnits(raw, 18)} ${ticker}`;
  // A long exact figure takes its own row on a phone (as the item payouts' figures do).
  const wide = (raw: bigint | null) => (raw !== null && t(raw).length > 18 ? 'sh-m3-figures__wide' : undefined);
  const q = quote.data ?? null;
  // Only the ids each list asks for now: an answer kept from a read before a move cannot put an item in both lists.
  const asked = new Set(candidates.ids.map(String)); const mineAsked = new Set(mineIds.map(String));
  const shelf = (items.data?.items ?? []).filter((item) => item.onShelf && asked.has(item.id.toString()));
  const own = (items.data?.items ?? []).filter((item) => item.outside && mineAsked.has(item.id.toString()) && account !== null && item.owner?.toLowerCase() === account.toLowerCase());
  // A list is claimed empty only when every read answered (or there was nothing to read); otherwise it is unavailable.
  const unread = (ids: readonly bigint[]) => items.isError || ids.some((id) => items.data && !items.data.items.some((item) => item.id === id));
  const insideFailed = unread(candidates.ids); const mineFailed = unread(mineIds);
  const insideKnown = candidates.ids.length === 0 || (items.isSuccess && !insideFailed);
  const mineKnown = items.data?.balance === 0n && items.data.block >= floor() && !items.isError && !items.isPlaceholderData;
  const busy = acting || run?.state === 'waiting';
  const gateOpen = vaultMovesOpenV2(view);
  const canSend = !disabled && !wrong && !busy && gateOpen && !view.failed;
  const takeT = q?.takeT ?? null; const returnT = q?.returnT ?? null;
  const short = coins.data && takeT !== null && coins.data.balance < takeT;
  const readFailed = quote.isError || insideFailed || mineFailed;
  const reading = quote.isFetching || items.isFetching;
  const retry = () => { void quote.refetch(); void items.refetch(); };
  const gateways = source.art ?? [];

  const act = async (kind: 'take' | 'return', id: bigint) => {
    if (!account || !wallet.signer) { setDialog(true); return; }
    const shown = kind === 'take' ? takeT : returnT;
    if (!canSend || shown === null || latch.current) return;
    const release = claimVaultRun(queries, `${base.join(':')}:${account.toLowerCase()}`);
    if (!release) return;
    latch.current = true; setActing(true);
    const who = account;
    setRun({ kind, id, account: who, state: 'waiting', step: 'checking' });
    const onStep = (step: VaultStepV2) => setRun({ kind, id, account: who, state: 'waiting', step });
    try {
      const sendIO = make(wallet.signer.request);
      const options = { floor: floor(), onReceipt, onCount };
      const result = await (kind === 'take'
        ? sendTakeOutV2(source, view, who, id, shown, sendIO, onStep, options)
        : sendPutBackV2(source, view, who, id, shown, sendIO, onStep, options));
      const move: VaultMoveV2 = { id, inside: kind === 'return', account: who.toLowerCase() as Address, block: result.receipt.blockNumber };
      queries.setQueryData<readonly VaultMoveV2[]>(movesKey, (before = []) => [move, ...before]);
      setRun({ kind, id, account: who, state: 'confirmed' });
    } catch (error) {
      setRun({ kind, id, account: who, state: 'failed', reason: vaultErrorText(error) });
    }
    try {
      await readForSend(Promise.all([queries.invalidateQueries({ queryKey: ['v2-feed'] }), queries.invalidateQueries({ queryKey: base })]));
    } catch { /* A refresh can fail after a confirmed send. Preserve its outcome and always release the card. */ }
    finally { release(); latch.current = false; setActing(false); }
  };

  const status = view.failed ? 'Closed' : !gateOpen ? 'Opens with the box' : quote.isFetching && !q ? 'Reading…' : q?.lastItem ? 'Last item stays' : null;
  const shown = run && run.account === account && !wrong ? run : null;
  return <section className="sh-panel sh-vault" aria-label="Items in the vault">
    <ItemsHead ticker={ticker} quote={q} roles={roles} />
    <dl className="sh-m3-figures sh-vault-figures">
      <div className={wide(takeT)}><dt>Take one out</dt><dd>{takeT !== null ? t(takeT) : q?.lastItem ? 'Last item stays' : 'Unavailable'}</dd></div>
      <div className={wide(returnT)}><dt>One back pays</dt><dd>{returnT !== null ? t(returnT) : 'Unavailable'}</dd></div>
      <div><dt>In the vault</dt><dd>{q?.inside != null ? q.inside.toString() : 'Unavailable'}</dd></div>
      {account ? <div className={wide(coins.data?.balance ?? null)}><dt>{`Your ${ticker}`}</dt><dd>{coins.data ? t(coins.data.balance) : 'Unavailable'}</dd></div> : null}
    </dl>
    <p className="sh-m2-chips">{status ? <span role="status">{status}</span> : null}
      {readFailed && !reading ? <button type="button" className="sh-chip sh-chip--pending" aria-label="Read failed. Retry" onClick={retry}>Retry</button> : null}
    </p>
    {reveal}
    {shelf.length ? <ul className="sh-vault-grid" aria-label="In the vault">{shelf.map((item) => <li key={item.id.toString()} className="sh-vault-item">
      <ItemArt item={item} gateways={gateways} onModel={setViewing} />
      <span className="sh-vault-item__id">{`#${item.id}`}</span>
      {item.revealed ? null : <NotRevealed id={`${noteId}-in-${item.id}`} />}
      <button ref={primary} type="button" className="sh-button" aria-label={`Take out item ${item.id}`} aria-describedby={item.revealed ? undefined : `${noteId}-in-${item.id}`}
        disabled={(account !== null && !canSend) || (takeT === null || !item.revealed || short === true)} onClick={() => void act('take', item.id)}>Take out</button>
    </li>)}</ul> : items.isFetching ? null : <p>{insideKnown ? 'No items to take out on this page.' : 'Items unavailable.'}</p>}
    {shelf.length > 0 && insideFailed && !items.isFetching ? <p>Some items unavailable.</p> : null}
    {short ? <p>More than this wallet holds.</p> : null}
    {candidates.pages > 1 ? <div className="sh-v2-actions">
      <button type="button" className="sh-button" aria-label={`More items, page ${((Math.min(page, candidates.pages - 1) + 1) % candidates.pages) + 1} of ${candidates.pages}`} disabled={items.isFetching} onClick={() => setPage((Math.min(page, candidates.pages - 1) + 1) % candidates.pages)}>More items</button>
    </div> : null}
    {account ? <>
      <h3>Yours</h3>
      {own.length ? <ul className="sh-vault-grid" aria-label="Your items">{own.map((item) => <li key={item.id.toString()} className="sh-vault-item">
        <ItemArt item={item} gateways={gateways} onModel={setViewing} />
        <span className="sh-vault-item__id">{`#${item.id}`}</span>
        {item.revealed ? null : <NotRevealed id={`${noteId}-mine-${item.id}`} />}
        <button type="button" className="sh-button" data-entry-target="in" aria-label={`Put back item ${item.id}`} aria-describedby={item.revealed ? undefined : `${noteId}-mine-${item.id}`} disabled={!canSend || (returnT === null || !item.revealed)} onClick={() => void act('return', item.id)}>Put back</button>
      </li>)}</ul> : <p>{items.isFetching ? 'Reading…' : mineKnown ? 'None of this box’s items in this wallet.' : 'Items unavailable.'}</p>}
      {own.length > 0 && mineFailed && !items.isFetching ? <p>Some items unavailable.</p> : null}
      {minePages > 1 ? <div className="sh-v2-actions">
        <button type="button" className="sh-button" aria-label={`More items, page ${((mineAt + 1) % minePages) + 1} of ${minePages}`} disabled={items.isFetching} onClick={() => setMinePage((mineAt + 1) % minePages)}>More items</button>
      </div> : null}
    </> : null}
    {shown ? <p role="status" data-state={shown.state}>{runText(shown)}</p> : null}
    {wrong ? <p>Use a browser wallet on this box’s network.</p> : null}
    {viewing ? <ModelSheet key={`${viewing.id}:${viewing.modelHash}`} item={viewing} gateways={gateways} load={modelLoader} onClose={() => setViewing(null)} /> : null}
    <BrowserWalletDialog open={dialog && wallet.defaultDialog === 'browser'} onClose={() => setDialog(false)} returnFocus={primary} />
    {DEMO_BUILD ? <DemoWalletDialog open={dialog && wallet.defaultDialog === 'demo'} onClose={() => setDialog(false)} returnFocus={primary} /> : null}
  </section>;
}
