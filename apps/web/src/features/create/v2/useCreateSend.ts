/**
 * TA-22: the Overview's Create on a real build (create-send.ts). Reads go to the source's RPC; the only wallet requests
 * are the executor's creation entry point's (`submitCreateWriteV2`, a shop's starter approvals included: steps of the
 * creation plan since SH-STARTER-GUARD), each after the creator's Create or Continue press. A run in this tab
 * (create-send-store.ts) is shown again after a reload, from the chain's state, before anything is sent. Leaving Create
 * stops the run (the step in flight finishes, its hash kept); the next step waits for Continue, and the tab has one runner.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TransactionNotFoundError, TransactionReceiptNotFoundError, createPublicClient, http, type Abi, type Address, type Hex } from 'viem';
import { InsufficientGasFundsError, NetworkPriceError, NotSendableError, WalletContextChangedError, WalletRejectedError, WalletRequestError, createChainReader, createHttpRequest, refusedRetryFetch, submitCreateWriteV2, writeChain, isWriteChainId, type FetchLike } from '@squarehole/chain/write';
import type { Eip1193Request } from '@squarehole/chain/write/wallet';
import type { V2Source } from '../../core/v2/indexer-v2';
import { liveChainLabel } from '../../wallet';
import { gasFundsLine } from '../../tx/gas-words';
import { CreateRefusal, labelCtxOf, planOfRun, prepareCreateV2, readProgressV2, runCreateV2, sameRun, specOfRun, type CreateChainV2, type CreateProgressV2, type CreateReadsV2, type CreateRunV2 } from './create-send';
import type { SiteListing } from './listings';
import { clearRunV2, loadRunV2, saveRunV2 } from './create-send-store';
import type { StarterItem } from './shop';
import { abandonKept, markUnsentKept } from './reveal-keep';
import type { BoxSpecV2 } from './spec-types';
import type { CreateSendPlanV2 } from '../../../../../../packages/chain/src/core/v2';
import { createReleaseOf } from '../../core/v2/releases';

export type CreateSendView =
  | { readonly phase: 'idle' }
  | { readonly phase: 'preparing' }
  | { readonly phase: 'running'; readonly progress: CreateProgressV2; readonly sending: number | null; readonly stopping: boolean }
  | { readonly phase: 'stopped'; readonly progress: CreateProgressV2 }
  | { readonly phase: 'failed'; readonly progress: CreateProgressV2 | null; readonly message: string }
  | { readonly phase: 'done'; readonly progress: CreateProgressV2; readonly box: string };

/**
 * The source's RPC as create-send.ts reads it (no wallet, no CCIP lookups). SH-278: a read the endpoint refused with
 * HTTP 429 goes again to the same endpoint (`refusedRetryFetch`: three more tries at most, 400, 900, 1,800 ms); viem's
 * own retries stay off (they would repeat other statuses too).
 */
export function rpcCreateReads(rpc: string, pollingInterval = 1_000, fetchFn?: FetchLike): CreateReadsV2 {
  const client = createPublicClient({ transport: http(rpc, { retryCount: 0, fetchFn: refusedRetryFetch(fetchFn) }), ccipRead: false, pollingInterval });
  return {
    chainId: () => client.getChainId(),
    blockNumber: () => client.getBlockNumber(),
    blockGasLimit: async () => (await client.getBlock()).gasLimit,
    read: (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint) =>
      client.readContract({ address, abi, functionName, args, ...(blockNumber === undefined ? {} : { blockNumber }) } as never),
    code: async (address) => (await client.getCode({ address })) ?? '0x',
    estimateGas: (r) => client.estimateGas({ account: r.account, to: r.to, data: r.data, value: r.value }),
    receipt: async (hash) => {
      try {
        return (await client.getTransactionReceipt({ hash })).status;
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
    },
    known: async (hash) => {
      try {
        await client.getTransaction({ hash });
        return true;
      } catch (error) {
        if (error instanceof TransactionNotFoundError) return false;
        throw error;
      }
    },
    wait: async (hash: Hex) => (await client.waitForTransactionReceipt({ hash, timeout: 900_000 })).status,
    feeReader: createChainReader(createHttpRequest(rpc)),
  };
}

/** The release a source creates with: the first one (SH-300), its factory, listing registry and coordinator implementation. */
export function createChainOf(source: V2Source): CreateChainV2 | null {
  const release = createReleaseOf(source.manifest);
  const chainId = source.manifest.chainId;
  if (!release || !isWriteChainId(chainId)) return null;
  return { chainId, factory: release.factory.address, listingRegistry: release.listingRegistry.address,
    coordinatorImplementation: release.implementations.coordinator.address, maxTxGas: writeChain(chainId).maxTxGas };
}

/**
 * SH-300: a saved run belongs to Create's release only when it names this chain AND this release's factory (a run of
 * another release, or of an earlier deployment on the same chain, is neither shown nor resumed here).
 */
export const sameRelease = (run: { readonly chainId: number; readonly factory: string }, chain: Pick<CreateChainV2, 'chainId' | 'factory'>): boolean =>
  run.chainId === chain.chainId && run.factory.toLowerCase() === chain.factory.toLowerCase();

/** A plain sentence for what stopped the run (never the wallet's or the RPC's own text). */
export function sendFailureText(error: unknown, chainId: number): string {
  if (error instanceof WalletRejectedError) return 'Declined in the wallet.';
  if (error instanceof WalletContextChangedError) return error.change === 'chain' ? `Switch the wallet to ${liveChainLabel(chainId)}.` : 'The wallet account changed. Connect it again.';
  if (error instanceof CreateRefusal) return error.message;
  if (error instanceof NotSendableError) return 'This step is not one of this box’s. Nothing was sent.';
  if (error instanceof InsufficientGasFundsError) return gasFundsLine(error.chainId);
  // SH-258 round 3: the chain's price as itself (no usable price, above the ceiling, risen since the fee was set).
  if (error instanceof NetworkPriceError) return error.message;
  if (error instanceof WalletRequestError) return 'The wallet did not send this step.';
  return 'The chain could not be read. Try again.';
}

/** One runner per browser tab. Tests supply separate scopes to model tabs sharing IndexedDB. */
type ActiveRun = { readonly ended: Promise<void> } | null;
export class CreateSendScope {
  private active: ActiveRun = null;
  get(): ActiveRun { return this.active; }
  set(active: ActiveRun): void { this.active = active; }
}
const TAB_SCOPE = new CreateSendScope();

export interface CreateSendInput {
  readonly scope?: CreateSendScope;
  readonly source: V2Source | null;
  readonly spec: BoxSpecV2;
  /** A shop's starter items, as add-on 8 commits them (shop.ts `starterItemsOf`); none for any other box. */
  readonly starters?: readonly StarterItem[];
  readonly owner: Address | null;
  readonly wallet: Eip1193Request | null;
  /** The listing book, to name the run's own coins (create-send.ts `labelCtxOf`). */
  readonly listings: readonly SiteListing[];
  /** The source's reads; by default its RPC (`rpcCreateReads`). Tests pass an in-memory chain. */
  readonly reads?: CreateReadsV2;
  /**
   * SH-ARWEAVE-PICTURES-WEB fix round 1: what goes before the run's first wallet request while its box is not created
   * (create-send.ts `beforeWallet`), given the run's own spec: Create publishes the logo and cover there. False stops
   * the run before the wallet; the next press asks it again.
   */
  readonly beforeWallet?: (spec: BoxSpecV2) => Promise<boolean>;
  /**
   * SH-192 (BOXSPEC-AUTOSAVE): what each press does with the run once it is known (prepared, or the saved one it
   * resumes), before the run reads or sends anything: the page keeps the run's reveal data on this device, keyed by its
   * predicted token (reveal-keep.ts). A rejection (a CreateRefusal with its line) stops the press there, nothing sent.
   * `attempt` identifies this press in shared storage, including if the keep later fails.
   * `created` asks the chain, only when the page needs to know, whether the run's box already exists.
   */
  readonly keep?: (run: CreateRunV2, created: () => Promise<boolean>, attempt: string) => Promise<void>;
  /**
   * SH-218 rail 2, required: the Create switches' last check (create-options.ts `checkBeforeWallet`), handed to the
   * executor's creation entry point with every step; it asks it right before the wallet for the payment approval and
   * createBox only. What it throws ends the press as a refusal: the run stays saved, never marked as maybe sent.
   * Since af1 it is also asked before `beforeWallet` publishes the pictures of a run whose box is not created yet.
   */
  readonly createOptionsCheck: (plan: CreateSendPlanV2) => Promise<void>;
}

/** The price coin's approval, the one request a run makes before createBox (create-send.ts `labelledSteps`). */
const APPROVAL = 'approve';
/**
 * SH-256: a run past its approvals: its createBox was sent (mined or not), a wallet request that may have been createBox
 * (or later, or of unknown kind) may have sent without an answer (E1b), or the chain shows its box. Such a run is
 * finished whatever the draft says now; one with approvals only is not (its approvals stay allowances on the chain,
 * which a run prepared from the draft reads and does not ask again).
 */
const pastApprovals = (run: CreateRunV2, created: boolean): boolean => created || run.sent.createBox !== undefined || (run.walletPending === true && run.walletPendingKind !== APPROVAL);
/** E1b: the run marked pending with the request's kind (undefined: unknown, possibly createBox), or settled. */
function pendingAs(run: CreateRunV2, pending: boolean, kind: string | undefined): CreateRunV2 {
  const next: { -readonly [K in keyof CreateRunV2]: CreateRunV2[K] } = { ...run, walletPending: pending };
  if (pending && kind !== undefined) next.walletPendingKind = kind;
  else delete next.walletPendingKind;
  return next;
}

/**
 * Whether a press goes on with the saved run (its spec was checked when it was prepared) instead of preparing the draft.
 * SH-256: only the draft's own run or one past its approvals, so a press that can lead to a createBox request sends
 * exactly the spec the Overview shows (a reload keeps the draft's choices, so after one the draft's run is still its own).
 */
export function resumesRun(run: CreateRunV2 | null, chainId: number | null, owner: Address | null, spec: BoxSpecV2, created: boolean): boolean {
  return run !== null && chainId !== null && owner !== null && (sameRun(run, chainId, owner, spec) || pastApprovals(run, created));
}

const NO_STARTERS: readonly StarterItem[] = Object.freeze([]);

export function useCreateSend({ source, spec, starters = NO_STARTERS, owner, wallet, listings, reads: given, beforeWallet, keep, createOptionsCheck, scope = TAB_SCOPE }: CreateSendInput) {
  const chain = useMemo(() => (source ? createChainOf(source) : null), [source]);
  const reads = useMemo(() => (source ? given ?? rpcCreateReads(source.rpc) : null), [source, given]);
  const [view, setView] = useState<CreateSendView>({ phase: 'idle' });
  const [run, setRun] = useState<CreateRunV2 | null>(null);
  // This page's run in flight: Stop, or leaving the page, marks it stopped (create-send.ts `stopped`).
  const control = useRef<{ stopped: boolean } | null>(null);
  const busy = useRef(false);
  const live = useRef(true);
  // Set again on every mount: React's development double mount runs the cleanup once in between (no run then).
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (control.current) control.current.stopped = true;
    };
  }, []);
  const listingsRef = useRef(listings);
  useEffect(() => { listingsRef.current = listings; }, [listings]);
  const boxOf = (r: CreateRunV2) => `/box/${r.chainId}/${r.token.toLowerCase()}`;
  // SH-256 H3: while the chain is asked about the stored run (it is known from the tab's storage at once), and a
  // document back from the back/forward cache restores again (another document of the tab may have stored a run).
  const [restoring, setRestoring] = useState(false);
  const [restoreKey, setRestoreKey] = useState(0);
  useEffect(() => {
    const again = (event: PageTransitionEvent) => { if (event.persisted) setRestoreKey((key) => key + 1); };
    window.addEventListener('pageshow', again);
    return () => window.removeEventListener('pageshow', again);
  }, []);

  // A run of this tab, for this creator and chain, is shown from the chain before anything is sent. One that is not this
  // draft's and is not past its approvals (SH-256) is forgotten; one past them is kept, whatever the page's choices are.
  useEffect(() => {
    if (!reads || !chain || !owner || busy.current) return;
    let current = true;
    void (async () => {
      const leaving = scope.get();
      if (leaving) {
        // A run this tab left on Create: shown stopping (its step in flight finishes), then read again once it ended.
        const left = loadRunV2();
        if (left && sameRelease(left, chain) && left.creator.toLowerCase() === owner.toLowerCase()) {
          try {
            const progress = await readProgressV2(reads, left, labelCtxOf(specOfRun(left), listingsRef.current));
            if (current && scope.get() === leaving) { setRun(left); setView({ phase: 'running', progress, sending: null, stopping: true }); }
          } catch {
            // Read again below, once the run has ended.
          }
        }
        await leaving.ended;
        if (!current) return;
      }
      const stored = loadRunV2();
      if (!stored || !sameRelease(stored, chain) || stored.creator.toLowerCase() !== owner.toLowerCase()) { setRun(null); setView({ phase: 'idle' }); return; }
      // H3: the stored run counts from now on (a press goes on with it by its own flags); the chain only adds its
      // progress, and a slow or failed read never turns it into "no run".
      setRun(stored);
      setRestoring(true);
      try {
        const created = await reads.code(stored.coordinator) !== '0x';
        // H3: a press that began meanwhile owns the run and the view from here.
        if (!current || busy.current) return;
        // A saved run is not proof of backup ownership: another tab may be using the same run.
        if (!pastApprovals(stored, created) && !sameRun(stored, chain.chainId, owner, spec)) { clearRunV2(); setRun(null); setView({ phase: 'idle' }); return; }
        const progress = await readProgressV2(reads, stored, labelCtxOf(specOfRun(stored), listingsRef.current));
        if (!current || busy.current) return;
        setRun(stored);
        const finished = progress.done.every(Boolean) && progress.later.length === 0;
        setView(finished ? { phase: 'done', progress, box: boxOf(stored) } : created || stored.walletPending || Object.keys(stored.sent).length > 0 ? { phase: 'stopped', progress } : { phase: 'idle' });
      } catch (error) {
        if (current && !busy.current) setView({ phase: 'failed', progress: null, message: sendFailureText(error, chain.chainId) });
      } finally {
        if (current) setRestoring(false);
      }
    })();
    // A superseded restore ends its own `restoring` here: the next run may return before it reads anything (no stored
    // run for this creator, no chain yet), and sets it again only when it really reads.
    return () => { current = false; setRestoring(false); };
    // The draft's spec only decides whether an uncreated stored run is still this draft's (checked once per creator).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reads, chain, owner, scope, restoreKey]);

  const shown = 'progress' in view ? view.progress : null;
  const created = shown !== null && shown.steps.some((step, at) => step.call.kind === 'createBox' && shown.done[at] === true);
  const resumes = resumesRun(run, chain?.chainId ?? null, owner, spec, created);
  // SH-256 H1: a saved run the press would not go on with (approvals only, another spec than the draft's, after an edit
  // in this document) leaves the view and the storage, as on a settled restore: the panel then lists the draft's plan.
  useEffect(() => {
    if (!run || busy.current || restoring || !chain || !owner || resumes) return;
    clearRunV2();
    setRun(null);
    setView({ phase: 'idle' });
  }, [run, restoring, chain, owner, resumes]);

  const start = useCallback(async () => {
    if (!live.current || busy.current || scope.get() || !reads || !chain || !owner || !wallet) return;
    busy.current = true;
    const mine = { stopped: false };
    const attempt = crypto.randomUUID();
    control.current = mine;
    let settle!: () => void;
    const entry = { ended: new Promise<void>((resolve) => { settle = resolve; }) };
    scope.set(entry);
    let progress: CreateProgressV2 | null = null;
    let current = resumes ? run : null;
    // H4: an uncertain request an approval's hash must not settle (set by `submit`, read by `onRun`).
    let held: { readonly kind: string | undefined } | null = null;
    try {
      // The page checked the draft unless this press resumes the saved run (the same decision: `resumes`).
      if (!current) {
        setView({ phase: 'preparing' });
        current = await prepareCreateV2(reads, chain, spec, owner, starters);
        if (mine.stopped || !live.current) return;
        saveRunV2(current);
        setRun(current);
      }
      // SH-192: the run's reveal data is kept on this device before anything of it is sent.
      if (keep) {
        const kept = current;
        await keep(kept, async () => await reads.code(kept.coordinator) !== '0x', attempt);
      }
      if (mine.stopped || !live.current) return;
      const runSpec = specOfRun(current);
      const ended = await runCreateV2(current, {
        reads, chain, ctx: labelCtxOf(runSpec, listingsRef.current),
        submit: async (options, kind) => {
          if (!current) throw new CreateRefusal('refused', 'No box to create.');
          const alreadyUncertain = current.walletPending === true;
          // E1b: the kind already uncertain (undefined on a run saved before kinds were recorded: possibly createBox).
          const uncertainKind = current.walletPendingKind;
          const guardedWallet: Eip1193Request = async (request) => {
            if (mine.stopped || !live.current) throw new CreateRefusal('refused', 'Creation stopped.');
            return wallet(request);
          };
          // Persist uncertainty at the actual send request, before entering the wallet (the executor calls this right
          // before it, in the same turn). A failed preflight needs no secret copy, while a send that loses its
          // response must keep it across reloads. A stopped run is refused by the guarded wallet next, unmarked.
          const onSendRequest = () => {
            if (mine.stopped || !live.current || !current) return;
            // E1b: the request's kind; while an earlier one past the approval (or of unknown kind) is still uncertain,
            // that one stays: the most advanced request that may have been sent.
            current = pendingAs(current, true, alreadyUncertain && uncertainKind !== APPROVAL ? uncertainKind : kind);
            saveRunV2(current);
            setRun(current);
          };
          try {
            const hash = await submitCreateWriteV2({ ...options, wallet: guardedWallet, onSendRequest, createOptionsCheck });
            // H4: an approval's hash does not settle an older createBox request (or one of unknown kind) still uncertain.
            held = alreadyUncertain && uncertainKind !== APPROVAL && kind === APPROVAL ? { kind: uncertainKind } : null;
            return hash;
          }
          catch (error) {
            if (error instanceof WalletRejectedError && current) {
              // Declining this request cannot resolve an earlier request with an unknown outcome.
              current = pendingAs(current, alreadyUncertain, uncertainKind);
              saveRunV2(current);
              if (live.current) setRun(current);
            }
            throw error;
          }
        },
        onRun: (next) => { current = held ? pendingAs(next, true, held.kind) : pendingAs(next, false, undefined); held = null; saveRunV2(current); if (live.current) setRun(current); },
        onProgress: (next, sending) => { progress = next; if (live.current) setView({ phase: 'running', progress: next, sending, stopping: mine.stopped }); },
        stopped: () => mine.stopped,
        // SH-218 rail 2 af1: nothing is published for a creation the switches refuse. Before the pictures of a run whose
        // box is not created yet (runCreateV2 asks this only then), the same fresh check the wallet moment makes; the
        // executor's check stays the last one.
        ...(beforeWallet ? { beforeWallet: async () => {
          if (current) await createOptionsCheck(planOfRun(current));
          return beforeWallet(runSpec);
        } } : {}),
      });
      const finalRun = current;
      if (live.current && progress) setView(ended === 'done' ? { phase: 'done', progress, box: boxOf(finalRun) } : { phase: 'stopped', progress });
    } catch (error) {
      if (!(error instanceof CreateRefusal || error instanceof WalletRejectedError || error instanceof WalletContextChangedError)) console.error('Create v2: a step stopped', error);
      if (live.current) setView({ phase: 'failed', progress, message: sendFailureText(error, chain.chainId) });
    } finally {
      if (current) await discardUnsent(current, reads, attempt);
      busy.current = false;
      if (control.current === mine) control.current = null;
      if (scope.get() === entry) scope.set(null);
      settle();
    }
  }, [reads, chain, owner, wallet, run, spec, starters, resumes, beforeWallet, keep, createOptionsCheck, scope]);

  const requestStop = useCallback(() => {
    if (control.current) control.current.stopped = true;
    setView((before) => (before.phase === 'running' ? { ...before, stopping: true } : before));
  }, []);
  const forget = useCallback(async () => {
    if (control.current) control.current.stopped = true;
    const leaving = scope.get();
    if (leaving) await leaving.ended;
    if (scope.get()) return;
    // The owning press cleans up in finally; never select another tab’s copy by token here.
    clearRunV2();
    if (live.current) { setRun(null); setView({ phase: 'idle' }); }
  }, [scope]);
  const runSpec = useMemo(() => (run ? specOfRun(run) : null), [run]);
  /** The stored run's box when a press goes on with it and it is not the page's draft: its ticker. */
  const otherBox = resumes && run && runSpec && chain && owner && !sameRun(run, chain.chainId, owner, spec) ? runSpec.tokenSymbol : null;
  // SH-ARWEAVE-PICTURES-WEB: `created`: the chain shows the run's createBox done, so its pictures' hashes are public (the
  // page's free check no longer applies to a press that resumes it, and its pictures went before the wallet, fix round 1).
  return { available: chain !== null && reads !== null, view, run, runSpec, otherBox, resumes, created, start, stop: requestStop, forget };
}

/** Keep every possibly sent copy; an ended, confirmed unsent attempt needs no persistent secret. */
async function discardUnsent(run: CreateRunV2, reads: CreateReadsV2, attempt: string): Promise<void> {
  if (run.walletPending || Object.keys(run.sent).length > 0) return;
  try {
    const copy = await markUnsentKept(run.chainId, run.token, attempt);
    if (copy && await reads.code(run.coordinator) === '0x') await abandonKept(copy);
  } catch {
    // An unread chain is not proof of absence. Keep the copy.
  }
}
