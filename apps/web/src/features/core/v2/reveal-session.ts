/** Page entry point. It owns adapters, locks, journal, clock, cancellation and explicit press capabilities.
 * A trusted click dispatch (including keyboard activation) grants one action during that dispatch.
 * Rendering and truthful wording remain a UI trust boundary; code cannot prove what a person understood.
 */
import type { Address, Hex } from 'viem';
import { TESTNET, type TestnetSwitches } from '@squarehole/chain/write/wallet';
import type { InjectedWalletAdapter } from '../../wallet/injected-adapter';
import { readKept } from '../../create/v2/reveal-keep';
import { createRevealRPC, type RevealBox } from './reveal-rpc';
import type { V2Source } from './indexer-v2';
import { indexedDBRevealStore, RevealStorageRefusal } from './reveal-indexeddb';
import { browserRevealClock, observeAbsence, releaseWait, type AbsenceWindow } from './reveal-clock';
import { unresolvedIntent, unresolvedRevealIntents, findRevealIntent, requireRevealValue, journalRevision, readRevealProgress, revealProgressKey, saveRevealIntent, webRevealLock, type RevealIntent } from './reveal-items-store';
import { loadRevealItems, prepareRevealItems, reconcileRevealItems, runRevealItems, revealItemHashes, sameRevealValue, settleRevealReads, UNKNOWN_WAIT_MS, type RevealCounts, type RevealPlan, type RevealPorts, type RevealRun, type RevealRunProgress, type RevealSource } from './reveal-items';
import { loadHiddenReveal, openHiddenReveal, pendingHiddenDraws, reconcileHiddenReveal, prepareHiddenReveal, type HiddenOpening, type HiddenOpeningHandle, type HiddenRevealSource } from './reveal-hidden';
import { boxFileAssetBytes, revealAssets, type RevealAssetProgress, type RevealAssetsResult } from './reveal-assets';
import { revealTestOverride } from './reveal-test-seam';

// These objects are created here and stay inside the session. There is no exported mint/install path.
const authorities = new WeakSet<object>();
/**
 * SH-258: whether a reveal's pictures may go to the alpha's server (alpha-sepolia/reveal-asset-upload.ts): only on a test
 * network with the closed alpha (Sepolia). SH-275: BNB Chain testnet's open-site alpha (`alphaOpen`) keeps its item
 * pictures on its own stack, not on the sign-in service, so the upload is never built there.
 */
export const revealUploadAllowed = (switches: Pick<TestnetSwitches, 'alphaGate' | 'alphaOpen'>): boolean => switches.alphaGate && !switches.alphaOpen;

export function requireRevealAuthority(target: object): void {
  if (!authorities.has(target) && !revealTestOverride(target)?.authorized) throw new Error('session-authority-required');
}

export interface RevealSessionOptions {
  readonly chainId: number; readonly box: RevealBox; readonly account: Address;
  readonly wallet: Pick<InjectedWalletAdapter, 'signer' | 'onAccountsChanged' | 'onChainChanged'>;
  readonly rpc: Pick<V2Source, 'manifest' | 'rpc'>; readonly file?: Blob; readonly signal: AbortSignal;
}
export interface ReleaseDecision {
  readonly token: object | null; readonly attempt: string; readonly account: Address; readonly ids: readonly string[];
  readonly ticket?: string; readonly persistedAt: number; readonly capWei: bigint; readonly eligible: boolean; readonly waitRemainingMs: number;
  readonly facts: readonly ['send-may-still-land', 'second-send-may-spend-both-caps', 'confirm-no-pending-wallet-transaction'];
}
export interface UnresolvedReveal extends RevealIntent {
  readonly hashDurable?: boolean;
  readonly transaction?: { readonly from: Address; readonly to: Address | null; readonly nonce: bigint; readonly value: bigint; readonly blockNumber: bigint | null } | null;
  /**
   * SH-203 af6 (C-L1): the last read found this send absent by the release wait's own rule: the transaction read and the
   * receipt read each answered an explicit null. A failed read, an error or an empty answer is not absence.
   */
  readonly absent?: true;
}
export interface RevealSessionState {
  readonly source: 'loading' | 'ready' | 'needs-file' | 'invalid'; readonly mode: 'open' | 'hidden';
  readonly busy: boolean; readonly cancelled: boolean; readonly reason?: string;
  readonly pollReason?: string; readonly actionReason?: string;
  readonly counts?: RevealCounts; readonly plan?: RevealPlan; readonly run?: RevealRun;
  readonly progress?: RevealRunProgress; readonly pictureProgress?: RevealAssetProgress;
  /** Only true after current outstanding facts were reconciled and published. */
  readonly outstandingCurrent?: boolean;
  readonly unresolved: readonly UnresolvedReveal[]; readonly hidden: readonly HiddenOpening[];
  readonly opening?: HiddenOpeningHandle; readonly pictures?: RevealAssetsResult;
}
export function trustedRevealPresses(target: EventTarget | undefined) {
  let current: Event | undefined, used = false;
  const capture = (event: Event) => { if (event.isTrusted) { current = event; used = false; } };
  target?.addEventListener('click', capture, true);
  return { take: () => {
    const allowed = !used && current?.isTrusted === true && current.eventPhase !== Event.NONE;
    used = true; return allowed;
  }, dispose: () => { current = undefined; used = true; target?.removeEventListener('click', capture, true); } };
}
export function revealSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('cancelled')); };
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
}
export function createRevealSession(options: RevealSessionOptions) {
  const test = revealTestOverride(options)?.session;
  const adapter = test?.adapter ?? createRevealRPC(options.rpc, options.box);
  if (options.chainId !== adapter.identity.chainId || (options.box.spec.artMode === 1 && !sameRevealValue(options.account, adapter.identity.creator))) throw new Error('wrong-identity');
  const store = test?.store ?? indexedDBRevealStore();
  authorities.add(store);
  const lock = test?.lock === undefined ? webRevealLock(globalThis.navigator?.locks) : test.lock;
  const clock = test?.clock ?? browserRevealClock();
  const gate = trustedRevealPresses(typeof window === 'undefined' ? undefined : window);
  const press = test?.press ?? gate.take;
  const key = revealProgressKey(options.chainId, adapter.identity.token);
  const life = new AbortController(); let operation = new AbortController(), timer: ReturnType<typeof setTimeout> | undefined;
  let observedFinal: string | undefined;
  let observedHeads: { latest: string; finalized: string; revision: number } | undefined;
  let openSource: RevealSource | undefined, hiddenSource: HiddenRevealSource | undefined, revision = -1;
  const listeners = new Set<(state: RevealSessionState) => void>();
  const knownHashes = new Map<string, Hex>();
  const liveAttempts = new Map<string, UnresolvedReveal>();
  const decisions = new WeakMap<object, { attempt: string; revision: number; hash?: Hex; start?: number }>();
  // SH-203 af5 (R4-L2b): per attempt with a transaction id, how long every read has found it gone (reveal-clock.ts).
  const absence = new Map<string, AbsenceWindow>();
  /**
   * One read of a sent transaction: the node's transaction and receipt for its id. Absent only when both reads answered
   * and both answered nothing; a failed read is never absence. Every read moves or ends that attempt's absence window.
   */
  const nodeRead = async (attempt: string, hash: Hex) => {
    const [tx, receipt] = await Promise.allSettled([adapter.transaction(hash), adapter.chain.receipt(hash)]);
    const absent = tx.status === 'fulfilled' && tx.value === null && receipt.status === 'fulfilled' && receipt.value === null;
    const next = observeAbsence(absence.get(attempt), hash, clock(), absent);
    if (next) absence.set(attempt, next); else absence.delete(attempt);
    return { tx: tx.status === 'fulfilled' ? tx.value : undefined, absent };
  };
  /** The row's facts from one node read: the transaction as read (null when none, unset when the read failed) and `absent`. */
  const rowFacts = (read: Awaited<ReturnType<typeof nodeRead>>) => ({
    ...(read.tx !== undefined ? { transaction: read.tx ? Object.freeze({ from: read.tx.from, to: read.tx.to, nonce: read.tx.nonce, value: read.tx.value, blockNumber: read.tx.blockNumber }) : null } : {}),
    ...(read.absent ? { absent: true as const } : {}),
  });
  /**
   * SH-203 af7 (D-N1): the read a Release press makes, published to its row at once (before a refusal is reported), so the
   * row never shows the absent line or offers Release against a newer read that did not find the send absent. Reads only;
   * when a release is possible is unchanged.
   */
  const pressRead = async (attempt: string, hash: Hex) => {
    const read = await nodeRead(attempt, hash);
    if (view.unresolved.some(row => row.attempt === attempt)) {
      emit({ unresolved: Object.freeze(view.unresolved.map(row => {
        if (row.attempt !== attempt) return row;
        const rest = Object.fromEntries(Object.entries(row).filter(([field]) => field !== 'transaction' && field !== 'absent')) as UnresolvedReveal;
        return Object.freeze({ ...rest, ...rowFacts(read) });
      })) });
    }
    return read;
  };
  let view: RevealSessionState = Object.freeze({ source: 'loading', mode: options.box.spec.artMode === 1 ? 'open' : 'hidden', busy: false, cancelled: false, outstandingCurrent: false, unresolved: [], hidden: [] });
  let actionReason: string | undefined, pollReason: string | undefined;
  let retryDelay = 5_000, lastFailure: { key: string; count: number } | undefined;
  let probeHeads: { latest: string; finalized: string } | undefined;
  const emit = (patch: Partial<RevealSessionState>) => {
    view = Object.freeze({ ...view, ...patch, actionReason, pollReason, reason: pollReason ?? actionReason }); for (const listener of listeners) listener(view);
  };
  const observeAttempt = (intent: RevealIntent, durable: boolean) => {
    if (intent.hash && !durable) knownHashes.set(intent.attempt, intent.hash);
    if (durable) knownHashes.delete(intent.attempt);
    const attempt = Object.freeze({ ...intent, ids: Object.freeze([...intent.ids]), hashDurable: durable,
      ...(intent.clock ? { clock: Object.freeze({ ...intent.clock }) } : {}),
      ...(intent.block ? { block: Object.freeze({ ...intent.block }) } : {}),
      ...(intent.succeeded ? { succeeded: Object.freeze([...intent.succeeded]) } : {}),
      ...(intent.emitted ? { emitted: Object.freeze([...intent.emitted]) } : {}) });
    if (unresolvedIntent(intent)) liveAttempts.set(intent.attempt, attempt);
    else liveAttempts.delete(intent.attempt);
    emit({ unresolved: Object.freeze([...view.unresolved.filter(i => i.attempt !== intent.attempt), ...(unresolvedIntent(intent) ? [attempt] : [])]) });
  };
  const ports: RevealPorts = { observeAttempt, chain: adapter.chain, store, lock, clock,
    wallet: request => { const signer = options.wallet.signer; if (!signer || life.signal.aborted) throw new Error('cancelled'); return signer.request(request); },
    feeReader: adapter.feeReader, estimate: adapter.estimate, simulate: adapter.simulate, now: () => clock().wall,
    attemptId: () => crypto.randomUUID(), sleep: revealSleep, progress: progress => emit({ progress, counts: progress.counts }) };
  const durable = { ...ports, simulateOpening: async (...args: Parameters<typeof adapter.simulate>) => { await adapter.simulate(...args); } };
  authorities.add(ports); authorities.add(durable);
  const journal = () => readRevealProgress(store, key, adapter.identity.specHash);
  const refreshJournal = async (transactions = true, onlyChanged = false) => {
    const p = await journal(), next = journalRevision(p);
    if (onlyChanged && revision === next) return p;
    if (revision !== next) emit({ plan: undefined, opening: undefined }); revision = next;
    for (const [attempt, live] of liveAttempts) {
      const saved = findRevealIntent(p, attempt);
      if (saved && (!live.hash || saved.hash === live.hash)) { liveAttempts.delete(attempt); knownHashes.delete(attempt); }
    }
    const unresolved: UnresolvedReveal[] = [];
    for (const i of unresolvedRevealIntents(p)) {
      const hash = i.hash ?? knownHashes.get(i.attempt);
      const read = hash && transactions ? await nodeRead(i.attempt, hash) : undefined;
      unresolved.push(Object.freeze({ ...i, ...(hash ? { hash, hashDurable: i.hash !== undefined, status: 'submitted' as const } : {}), ids: Object.freeze([...i.ids]),
        ...(i.clock ? { clock: Object.freeze({ ...i.clock }) } : {}), ...(i.block ? { block: Object.freeze({ ...i.block }) } : {}),
        ...(i.succeeded ? { succeeded: Object.freeze([...i.succeeded]) } : {}), ...(i.emitted ? { emitted: Object.freeze([...i.emitted]) } : {}),
        ...(read ? rowFacts(read) : {}) }));
    }
    for (const live of liveAttempts.values()) {
      const index = unresolved.findIndex(i => i.attempt === live.attempt);
      if (index >= 0) unresolved[index] = live; else unresolved.push(live);
    }
    emit({ unresolved: Object.freeze(unresolved) }); return p;
  };
  const stop = (reason: string) => {
    operation.abort(); life.abort(); if (timer) clearTimeout(timer); gate.dispose();
    actionReason = reason; pollReason = undefined;
    emit({ cancelled: true, plan: undefined, opening: undefined });
  };
  const offAccount = options.wallet.onAccountsChanged(accounts => { if (!sameRevealValue(accounts[0], options.account)) stop('account-changed'); });
  const offChain = options.wallet.onChainChanged(chain => { if (chain !== options.chainId) stop('chain-changed'); });
  life.signal.addEventListener('abort', () => { offAccount(); offChain(); options.signal.removeEventListener('abort', navigate); }, { once: true });
  const navigate = () => stop('navigation'); options.signal.addEventListener('abort', navigate, { once: true });
  if (options.signal.aborted) navigate();
  if (life.signal.aborted) { offAccount(); offChain(); }
  const failure = (error: unknown) => error instanceof RevealStorageRefusal ? error.reason : error instanceof Error ? error.message : 'read-failed';
  const resetPollRetry = () => {
    lastFailure = undefined; retryDelay = 5_000;
    if (timer) { clearTimeout(timer); schedule(); }
  };
  const action = async <T>(work: () => Promise<T>): Promise<T> => {
    // Consume before the first await. One dispatch cannot grant two actions or survive in an effect.
    if (!press()) throw new Error('user-press-required');
    resetPollRetry();
    if (life.signal.aborted || view.source === 'loading' || view.busy) throw new Error('action-unavailable');
    observedHeads = undefined;
    operation = new AbortController(); actionReason = undefined; emit({ busy: true, cancelled: false });
    try { return await work(); } catch (error) {
      const reason = failure(error);
      actionReason = reason;
      emit({ outstandingCurrent: false, ...(reason === 'read-chain-changed' ? { plan: undefined, opening: undefined } : {}) }); throw error;
    }
    finally { emit({ busy: false }); }
  };
  const poll = async () => {
    if (life.signal.aborted || view.busy) return;
    emit({ busy: true });
    let outcome: string | undefined, publishAfter = false, factsCurrent = false;
    let checkpoint: typeof observedHeads;
    try {
      if (!lock) throw new Error('lock-unavailable');
      // No journal or RPC work while another tab owns the sender lock. Publish
      // readable journal facts even if the following head or reconciliation read fails.
      const probe = await lock.run(key, async () => {
        await refreshJournal(false, true);
        const heads = await adapter.chain.heads?.();
        if (heads) probeHeads = { latest: heads.latest.hash, finalized: heads.finalized.hash };
        return { heads, unchanged: heads !== undefined && observedHeads?.latest === heads.latest.hash
          && observedHeads.finalized === heads.finalized.hash };
      });
      if (!probe.acquired) { outcome = 'running-elsewhere'; return; }
      if (probe.value.unchanged) {
        factsCurrent = true;
        if (observedHeads) checkpoint = { ...observedHeads, revision };
        return;
      }
      publishAfter = true;
      if (openSource) {
        const result = await reconcileRevealItems(openSource, ports);
        if (result.counts) emit({ counts: result.counts });
        if (!result.ok) outcome = result.reason;
        factsCurrent = result.ok || ['receipt-pending', 'unknown-send', 'awaiting-finality'].includes(result.reason);
      } else {
        const final = await adapter.chain.snapshot(adapter.identity, 'finalized');
        if (final.block.hash !== observedFinal) {
          const collection = adapter.roles.collection; if (!collection) throw new Error('wrong-mode');
          const ids: bigint[] = []; for (let id = final.firstId; id < final.firstId + final.size; id++) ids.push(id);
          const scope = { chainId: options.chainId, collection, ids };
          const [f, l] = await settleRevealReads([adapter.assetRead(scope, 'finalized'), adapter.assetRead(scope, 'latest')]);
          if (!await adapter.canonical(f.block) || !await adapter.canonical(l.block)) throw new Error('reorg');
          const finalized = BigInt([...f.items.values()].filter(i => i.revealed).length), latest = BigInt([...l.items.values()].filter(i => i.revealed).length);
          emit({ counts: { size: final.size, finalized, latest, remainingFinalized: final.size - finalized, remainingLatest: final.size - latest, finalizedComplete: finalized === final.size } });
          if (hiddenSource) {
            const rows: HiddenOpening[] = [];
            for await (const page of pendingHiddenDraws(hiddenSource, options.account, adapter.hidden, life.signal)) rows.push(...page);
            emit({ hidden: Object.freeze(rows) });
          }
          observedFinal = final.block.hash;
        }
        if (hiddenSource) await reconcileHiddenReveal(hiddenSource, adapter.hidden, durable);
        factsCurrent = true;
      }
      if (probe.value.heads) checkpoint = { latest: probe.value.heads.latest.hash, finalized: probe.value.heads.finalized.hash, revision };
    } catch (error) { outcome = failure(error); factsCurrent = false; }
    finally {
      // One exit for every reconciliation outcome, including thrown hidden reads.
      // Publication is independent of success; only success certifies observed heads.
      if (publishAfter && lock) {
        try {
          const refreshed = await lock.run(key, refreshJournal);
          if (!refreshed.acquired) { outcome ??= 'running-elsewhere'; factsCurrent = false; }
        } catch (error) { outcome ??= failure(error); factsCurrent = false; }
      }
      if (!outcome && checkpoint) observedHeads = { ...checkpoint, revision };
      if (outcome) observedHeads = undefined;
      pollReason = outcome;
      if (factsCurrent && actionReason === 'running-elsewhere') actionReason = undefined;
      if (view.counts?.finalizedComplete && actionReason === 'awaiting-finality') actionReason = undefined;
      // Failed reads/publication never certify a stale zero or a stale positive count.
      emit({ outstandingCurrent: factsCurrent });
      if (outcome && outcome !== 'running-elsewhere') {
        const signature = JSON.stringify([probeHeads, revision, outcome]);
        const count = lastFailure?.key === signature ? lastFailure.count + 1 : 1;
        lastFailure = { key: signature, count: Math.min(count, 5) };
        retryDelay = Math.min(60_000, 5_000 * 2 ** (lastFailure.count - 1));
      } else {
        retryDelay = 5_000;
        if (!outcome) lastFailure = undefined;
      }
      emit({ busy: false });
    }
  };
  const schedule = () => {
    if (life.signal.aborted || test?.poll === false) return;
    timer = setTimeout(() => { timer = undefined; void poll().finally(schedule); }, retryDelay);
  };
  const ready = (async () => {
    try {
      if (life.signal.aborted) throw new Error('cancelled');
      await adapter.chain.snapshot(adapter.identity, 'finalized');
      const input = options.file ?? await readKept(options.chainId, adapter.identity.token);
      if (input) {
        if (view.mode === 'open') {
          const loaded = await loadRevealItems(adapter.identity, options.account, input, adapter.chain);
          if (!loaded.ok) throw new Error(loaded.reason); openSource = loaded.value;
        } else {
          const loaded = await loadHiddenReveal(adapter.identity, options.account, input, adapter.chain);
          if (!loaded.ok) throw new Error(loaded.reason); hiddenSource = loaded.value;
        }
      }
      emit({ source: input ? 'ready' : 'needs-file' }); await poll();
    } catch (error) { actionReason = failure(error); emit({ source: 'invalid' }); }
    finally { schedule(); }
  })();
  return {
    ready,
    getState: () => view,
    subscribe: (listener: (state: RevealSessionState) => void) => { listeners.add(listener); listener(view); return () => { listeners.delete(listener); }; },
    prepare: () => action(async () => {
      if (!openSource) throw new Error('source-unavailable');
      const result = await prepareRevealItems(openSource, ports); if (!result.ok) throw new Error(result.reason);
      await refreshJournal(); emit({ plan: result.value, counts: result.value.counts, outstandingCurrent: true }); return result.value;
    }),
    start: (plan: RevealPlan) => action(async () => {
      if (view.plan !== plan) throw new Error('invalid-plan'); emit({ plan: undefined, run: undefined, progress: undefined });
      const result = await runRevealItems(plan, ports, operation.signal); if (!result.ok) throw new Error(result.reason);
      if (result.value.unpersistedHash) knownHashes.set(result.value.unpersistedHash.attempt, result.value.unpersistedHash.hash);
      actionReason = result.value.reason === 'complete' ? undefined : result.value.reason;
      emit({ run: result.value, counts: result.value.counts }); await refreshJournal();
      emit({ outstandingCurrent: ['complete', 'awaiting-finality'].includes(result.value.reason) }); return result.value;
    }),
    cancel: () => { resetPollRetry(); operation.abort(); emit({ cancelled: true, plan: undefined, opening: undefined }); },
    askRelease: (attempt: string) => action(async (): Promise<ReleaseDecision> => {
      if (!lock) throw new Error('lock-unavailable');
      const result = await lock.run(key, async () => {
        const p = await journal(), intent = findRevealIntent(p, attempt);
        const hash = intent?.hash ?? knownHashes.get(attempt);
        if (!intent || !['intent', 'unknown', ...(hash ? ['submitted'] : [])].includes(intent.status)) throw new Error('release-not-allowed');
        let eligible: boolean, waited: number, start: number | undefined;
        if (hash) {
          // SH-203 af5 (R4-L2b): a send with an id only after a whole wait in which every read found it gone, this read too.
          const read = await pressRead(attempt, hash), window = absence.get(attempt);
          if (!read.absent || !window) throw new Error('release-not-allowed');
          eligible = window.elapsed >= UNKNOWN_WAIT_MS; waited = window.elapsed; start = window.start;
        } else {
          eligible = await releaseWait(store, key, p, intent, clock); waited = findRevealIntent(p, attempt)?.clock?.elapsed ?? 0;
        }
        const token = eligible ? Object.freeze({}) : null;
        if (token) decisions.set(token, { attempt, revision: journalRevision(p), ...(hash ? { hash, start } : {}) });
        return Object.freeze({ token, attempt, account: intent.account, ids: Object.freeze([...intent.ids]), ticket: intent.ticket,
          persistedAt: intent.createdAt, capWei: BigInt(intent.capWei), eligible, waitRemainingMs: Math.max(0, 1_800_000 - waited),
          facts: ['send-may-still-land', 'second-send-may-spend-both-caps', 'confirm-no-pending-wallet-transaction'] as const });
      });
      if (!result.acquired) throw new Error('running-elsewhere'); await refreshJournal(); return result.value;
    }),
    confirmRelease: (token: object) => action(async () => {
      const decision = decisions.get(token); decisions.delete(token);
      if (!decision || !lock) throw new Error('release-not-allowed');
      const result = await lock.run(key, async () => {
        const p = await journal(), intent = findRevealIntent(p, decision.attempt);
        const hash = intent?.hash ?? knownHashes.get(decision.attempt);
        if (!intent || hash !== decision.hash || !['intent', 'unknown', ...(hash ? ['submitted'] : [])].includes(intent.status) || journalRevision(p) !== decision.revision) throw new Error('release-not-allowed');
        if (hash) {
          // SH-203 af5 (R4-L2b): the same window as at the ask, not ended since, still gone at this read, and long enough.
          const read = await pressRead(decision.attempt, hash), window = absence.get(decision.attempt);
          if (!read.absent || !window || window.start !== decision.start) throw new Error('release-not-allowed');
          if (window.elapsed < UNKNOWN_WAIT_MS) throw new Error('release-too-soon');
          await saveRevealIntent(store, key, p, { ...intent, hash, status: 'user-released' });
          knownHashes.delete(decision.attempt); liveAttempts.delete(decision.attempt); absence.delete(decision.attempt);
          return;
        }
        if (!await releaseWait(store, key, p, intent, clock)) throw new Error('release-too-soon');
        await saveRevealIntent(store, key, p, { ...requireRevealValue(findRevealIntent(p, decision.attempt)), status: 'user-released' });
      });
      if (!result.acquired) throw new Error('running-elsewhere'); await refreshJournal();
    }),
    prepareOpening: (ticket: bigint) => action(async () => {
      if (!hiddenSource || !adapter.roles.tickets || !adapter.roles.vault || !adapter.roles.collection) throw new Error('source-unavailable');
      const roles = { chainId: options.chainId, record: options.box.record, token: adapter.identity.token, creator: adapter.identity.creator,
        collection: adapter.roles.collection, tickets: adapter.roles.tickets, vault: adapter.roles.vault };
      const result = await prepareHiddenReveal(hiddenSource, ticket, options.account, roles, adapter.hidden,
        { request: ports.wallet, estimate: ports.estimate, feeReader: ports.feeReader }, durable);
      if (result.reason !== 'ready') throw new Error(result.reason); await refreshJournal(); emit({ opening: result.handle }); return result.handle;
    }),
    open: (handle: HiddenOpeningHandle) => action(async () => {
      if (view.opening !== handle) throw new Error('invalid-plan'); emit({ opening: undefined });
      const result = await openHiddenReveal(handle, operation.signal, durable);
      if (result.hash && result.attempt) knownHashes.set(result.attempt, result.hash);
      actionReason = result.reason === 'sent' ? undefined : result.reason;
      emit({}); await refreshJournal(); return result;
    }),
    startPictures: (file: Blob) => action(async () => {
      // Works with a full box file even when the kept proof copy no longer exists.
      emit({ pictures: undefined, pictureProgress: undefined });
      const checked = view.mode === 'open' ? await loadRevealItems(adapter.identity, options.account, file, adapter.chain)
        : await loadHiddenReveal(adapter.identity, options.account, file, adapter.chain);
      if (!checked.ok) throw new Error(checked.reason);
      const hashes = (id: bigint) => 'target' in checked.value ? revealItemHashes(checked.value, id)
        : (() => { const reveal = checked.value.file.revealOf(id); return reveal ? { image: reveal.imageHash, avatar: reveal.avatarHash, model: reveal.modelHash } : null; })();
      // Refresh receipt evidence if finality advanced since the run. Outside/state-only reveals carry no hint.
      if ('target' in checked.value) await reconcileRevealItems(checked.value, ports);
      else await reconcileHiddenReveal(checked.value, adapter.hidden, durable);
      const snapshot = await adapter.chain.snapshot(adapter.identity, 'finalized');
      const revealTransactions = new Map<bigint, { hash: Hex; block: { number: bigint; hash: Hex } }>();
      for (const intent of (await journal()).intents) {
        if (!intent.hash || !intent.block || !['finalized', 'closed'].includes(intent.status) || intent.receiptStatus !== 'success') continue;
        for (const id of intent.succeeded ?? []) if (intent.emitted?.includes(id)) {
          revealTransactions.set(BigInt(id), { hash: intent.hash, block: { number: BigInt(intent.block.number), hash: intent.block.hash } });
        }
      }
      const collection = adapter.roles.collection; if (!collection) throw new Error('wrong-mode');
      const ids: bigint[] = []; for (let id = snapshot.firstId; id < snapshot.firstId + snapshot.size; id++) ids.push(id);
      if (!lock) throw new Error('lock-unavailable');
      // SH-258: the alpha server takes the pictures only where the test network has the alpha (never on BNB Chain testnet).
      const upload = !revealUploadAllowed(TESTNET.switches) ? undefined : import.meta.env?.SH_SEPOLIA_TRADE === true
        ? (await import('../../alpha-sepolia/reveal-asset-upload')).createRevealAssetUpload(test?.fetch ?? fetch) : undefined;
      const result = await lock.run(`${key}:pictures`, async () => revealAssets({ chainId: options.chainId, collection, ids }, {
        revealTransactions, upload, fetch: test?.fetch ?? fetch, read: async (scope, tag) => {
          const read = await adapter.assetRead(scope, tag);
          const items = new Map(read.items);
          for (const [id, item] of items) if (item.revealed) {
            const proof = hashes(id);
            if (!proof || !sameRevealValue(proof.image, item.image) || !sameRevealValue(proof.model, item.model)) throw new Error('wrong-commitment');
            // traitsOf omits avatarHash. The checked root proof authenticates it, after the finalized reveal gate.
            items.set(id, { ...item, avatar: proof.avatar });
          }
          return { ...read, items };
        }, canonical: adapter.canonical, bytes: await boxFileAssetBytes(file), now: Date.now, sleep: revealSleep,
        progress: pictureProgress => emit({ pictureProgress }),
      }, operation.signal, ports));
      if (!result.acquired) throw new Error('pictures-running-elsewhere'); emit({ pictures: result.value }); return result.value;
    }),
    exportJournal: async () => {
      const p = await journal();
      return JSON.stringify({ ...p, intents: p.intents.map(i => { const hash = knownHashes.get(i.attempt); return hash && !i.hash ? { ...i, hash, status: 'submitted' } : i; }) });
    },
    dispose: () => stop('navigation'),
  };
}
export type RevealSession = ReturnType<typeof createRevealSession>;
