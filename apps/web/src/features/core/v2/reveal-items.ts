/** SH-202. Framework-free open reveal preparation, journal reconciliation and sequential execution. */
import { requireRevealAuthority } from './reveal-session';
import { decodeFunctionData, encodeFunctionData, keccak256, type Address, type Hex } from 'viem';
import { decodeBoxSpecV2, encodeBoxSpecV2 } from '../../../../../../packages/box-spec/src/generated/box-spec.v2';
import { boxCollectionAbi } from '@squarehole/chain/abi';
import { collectionTargetV2, type CollectionTargetV2 } from '../../../../../../packages/chain/src/core/v2/collection-calls-v2';
import { rolesOfV2, type BoxRecordV2 } from '../../../../../../packages/chain/src/core/v2/record-v2';
import { parseOpenRevealFileV2, planOpenRevealBatchesV2, readOpenRevealReceiptV2, readOpenRevealResultsV2, type CheckedOpenRevealFileV2, type RevealBatch } from '../../../../../../packages/chain/src/core/v2/open-reveal-batches-v2';
import { foldReveals, multicall3Abi, type RevealCall } from '../../../../../../packages/chain/src/core/v2/reveal-batch-calls-v2';
import { assertSendableCallV2, type WriteCallV2 } from '../../../../../../packages/chain/src/core/v2/write-calls-v2';
import { checkRequestPrice, NetworkPriceError, readSendFees, sendCostCap, WalletContextChangedError, WalletRejectedError, submitWrite, type SendFeeReader, type SendFees } from '../../../../../../packages/chain/src/write/executor';
import { parseAccounts, parseChainId, toQuantity, type Eip1193Request } from '../../../../../../packages/chain/src/write/eip1193';
import { parseKept, type KeptReveal } from '../../create/v2/reveal-keep';
import { readRevealProgress, revealProgressKey, saveRevealIntent, saveRevealChanges, readyRevealIntents, hasActiveRevealIds, findRevealIntent, requireRevealValue, journalRevision, journalWork, spentRevealCaps, unresolvedIntent, type RevealIntent, type RevealLock, type RevealProgress, type RevealProgressStore } from './reveal-items-store';

import { releaseWait, startReleaseClock, type RevealClock } from './reveal-clock';
import { revealTestOverride } from './reveal-test-seam';

export const REVEAL_GAS_CAP = 16_777_216n;
export const REVEAL_RETRIES = 2;
export const UNKNOWN_WAIT_MS = 30 * 60 * 1000;
// One block after inclusion protects against a stale tip. Finality is a separate gate.
export const REVEAL_CONFIRMATION_BLOCKS = 1n;
const RECEIPT_POLLS = 360;
const RECEIPT_POLL_MS = 5_000;
export type RevealReason = 'wrong-chain' | 'wrong-registry' | 'wrong-token' | 'wrong-creator' | 'wrong-spec' | 'wrong-code'
  | 'read-chain-changed'
  | 'wrong-commitment' | 'wrong-mode' | 'invalid-source' | 'invalid-plan' | 'plan-changed' | 'estimate-failed' | 'simulation-failed'
  | 'gas-cap' | 'read-failed' | 'store-failed' | 'progress-invalid' | 'unknown-send' | 'receipt-pending' | 'reorg'
  | 'wallet-refused' | 'account-changed' | 'chain-changed' | 'cancelled' | 'running-elsewhere' | 'lock-unavailable'
  | 'revert-limit' | 'inner-failure-limit' | 'awaiting-finality' | 'release-too-soon' | 'release-not-allowed'
  | 'gas-price-unread' | 'gas-price-high' | 'gas-price-rose';
export type RevealResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: RevealReason };
export class RevealRefusal extends Error { constructor(readonly reason: RevealReason) { super(reason); } }
function refuse(reason: RevealReason): never { throw new RevealRefusal(reason); }
/** SH-258 round 3: the chain's price as its own reason (no usable price, above the ceiling, risen since the fee was set). */
export const priceReason = (e: unknown): 'gas-price-unread' | 'gas-price-high' | 'gas-price-rose' | null =>
  e instanceof NetworkPriceError ? (e.kind === 'no_price' ? 'gas-price-unread' : e.kind === 'above_ceiling' ? 'gas-price-high' : 'gas-price-rose') : null;
const reasonOf = (e: unknown, fallback: RevealReason): RevealReason => e instanceof RevealRefusal ? e.reason : priceReason(e) ?? fallback;
export const sameRevealValue = (a: string | undefined, b: string | undefined): boolean => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

export interface RevealIdentity {
  readonly chainId: number; readonly registry: Address; readonly boxId: bigint;
  readonly token: Address; readonly creator: Address; readonly specHash: Hex;
}
export interface RevealBlock { readonly number: bigint; readonly hash: Hex }
/** All fields and per-id reads must be pinned to this block, not independently fetched at latest. */
export interface RevealSnapshot extends RevealIdentity {
  readonly block: RevealBlock; readonly record: BoxRecordV2; readonly encodedSpec: Hex;
  readonly collectionCode: Hex; readonly root: Hex; readonly size: bigint; readonly firstId: bigint;
  readonly triggers: number;
}
export interface RevealReceipt {
  readonly hash: Hex; readonly from: Address; readonly block: RevealBlock; readonly status: 'success' | 'reverted';
  /** Transaction fetched by this hash, checked against the journal and rebuilt batch. */
  readonly nonce: bigint; readonly to: Address; readonly input: Hex; readonly value: bigint;
  readonly logs: readonly { readonly address: Address; readonly data: Hex; readonly topics: readonly Hex[] }[];
}
export interface RevealReads {
  /** Mutable endpoint identity. Never infer this from cached deployment facts. */
  chainId(): Promise<number>;
  heads?(): Promise<{ latest: RevealBlock; finalized: RevealBlock }>;
  snapshot(identity: RevealIdentity, tag: 'latest' | 'finalized'): Promise<RevealSnapshot>;
  canonical(block: RevealBlock): Promise<boolean>;
  /** Bulk adapter must return one boolean per requested ID, from this exact block. */
  revealed(collection: Address, ids: readonly bigint[], block: RevealBlock): Promise<readonly boolean[]>;
  nonce(account: Address, tag: 'pending' | 'finalized'): Promise<bigint>;
  receipt(hash: Hex): Promise<RevealReceipt | null>;
}
/** All reveal sends enter here after their last state and wallet-context read.
 * A refused chain check never writes an intent. After it, only durable storage
 * separates the check from forwarding; the caller performs no more chain reads.
 */
// SH-258 round 3b: `price` checks the request's fee fields against a fresh price after the journal write, immediately
// before the provider; a refusal leaves the intent unsent (the caller records it as refused).
export async function forwardRevealSend(chain: Pick<RevealReads, 'chainId'>, chainId: number,
  persistIntent: () => Promise<void>, forward: () => Promise<unknown>, price: () => Promise<void> = async () => undefined): Promise<unknown> {
  if (await chain.chainId() !== chainId) refuse('read-chain-changed');
  await persistIntent();
  await price();
  return forward();
}
/** Settle every read branch before releasing its lock or scheduling another attempt. */
export async function settleRevealReads<T extends readonly unknown[]>(reads: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const results = await Promise.allSettled(reads);
  return results.map(result => { if (result.status === 'rejected') throw result.reason; return result.value; }) as unknown as T;
}
export interface RevealPorts {
  readonly chain: RevealReads;
  readonly store: RevealProgressStore;
  readonly lock: RevealLock | null;
  readonly wallet: Eip1193Request;
  readonly clock: RevealClock;
  readonly feeReader: SendFeeReader;
  simulate(call: WriteCallV2, account: Address, gasLimit: bigint): Promise<Hex>;
  estimate(call: WriteCallV2, account: Address): Promise<bigint>;
  now(): number;
  attemptId(): string;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  progress?(value: RevealRunProgress): void;
  /** Live public attempt facts, independent of journal reads. */
  observeAttempt?(intent: RevealIntent, durable: boolean): void;
}
export interface RevealCounts {
  readonly size: bigint; readonly finalized: bigint; readonly latest: bigint;
  readonly remainingFinalized: bigint; readonly remainingLatest: bigint;
  /** Input to cleanup only; picture recovery must retain its independent full-file action. */
  readonly finalizedComplete: boolean;
}
export interface RevealSource {
  readonly identity: RevealIdentity; readonly target: CollectionTargetV2;
  readonly file: CheckedOpenRevealFileV2;
}
const sources = new WeakSet<RevealSource>();

// Pure work keyed by the exact bytes and session identity. Nothing about heads or item state is cached here.
const checkedSpecs = new WeakMap<RevealIdentity, { encoded: Hex; hash: Hex; spec: ReturnType<typeof decodeBoxSpecV2> }>();
function checkedSpec(identity: RevealIdentity, encoded: Hex) {
  let checked = checkedSpecs.get(identity);
  if (!checked || checked.encoded !== encoded) {
    const spec = decodeBoxSpecV2(encoded);
    if (encodeBoxSpecV2(spec).toLowerCase() !== encoded.toLowerCase()) refuse('wrong-spec');
    checked = { encoded, hash: keccak256(encoded), spec }; checkedSpecs.set(identity, checked);
  }
  return checked;
}

/** Registry address comes from the verified release, never from the uploaded file. */
export function checkRevealSnapshot(identity: RevealIdentity, snapshot: RevealSnapshot, account: Address, mode: 1 | 2): CollectionTargetV2 {
  if (snapshot.chainId !== identity.chainId) refuse('wrong-chain');
  if (!sameRevealValue(snapshot.registry, identity.registry) || snapshot.boxId !== identity.boxId || snapshot.record.boxId !== identity.boxId) refuse('wrong-registry');
  if (!sameRevealValue(snapshot.token, identity.token)) refuse('wrong-token');
  if (!sameRevealValue(snapshot.creator, identity.creator) || !sameRevealValue(snapshot.record.creator, identity.creator) || !sameRevealValue(account, identity.creator)) refuse('wrong-creator');
  const checked = checkedSpec(identity, snapshot.encodedSpec);
  if (!sameRevealValue(snapshot.specHash, identity.specHash) || !sameRevealValue(snapshot.record.specHash, identity.specHash)
    || !sameRevealValue(checked.hash, identity.specHash)) refuse('wrong-spec');
  const spec = checked.spec;
  const target = collectionTargetV2(identity.chainId, snapshot.record, account);
  if (!sameRevealValue(target.token, identity.token)) refuse('wrong-token');
  if (snapshot.collectionCode === '0x' || !sameRevealValue(keccak256(snapshot.collectionCode), rolesOfV2(snapshot.record).codeHashes.collection ?? undefined)) refuse('wrong-code');
  if (spec.artMode !== mode || snapshot.triggers !== (mode === 1 ? 4 : 1)) refuse('wrong-mode');
  if (snapshot.size <= 0n || snapshot.size > 10_000n || snapshot.firstId !== 1n || BigInt(spec.n) !== snapshot.size
    || spec.firstId !== snapshot.firstId || !sameRevealValue(spec.revealRoot, snapshot.root)) refuse('wrong-commitment');
  return Object.freeze(target);
}

export function matchingKeptReveal(value: KeptReveal, identity: RevealIdentity, snapshot: RevealSnapshot, mode: 'open' | 'hidden'): KeptReveal {
  const kept = parseKept(value);
  if (!kept || kept.chainId !== identity.chainId || !sameRevealValue(kept.token, identity.token) || !sameRevealValue(kept.creator, identity.creator)
    || !sameRevealValue(kept.specHash, identity.specHash) || !sameRevealValue(kept.revealRoot, snapshot.root) || BigInt(kept.n) !== snapshot.size || kept.artMode !== mode) refuse('invalid-source');
  return kept;
}

/** No settings import: the original bytes are read through SH-199, without new salts or defaults. */
export async function loadRevealItems(identity: RevealIdentity, account: Address, input: Blob | KeptReveal, chain: RevealReads): Promise<RevealResult<RevealSource>> {
  try {
    const snapshot = await chain.snapshot(identity, 'finalized');
    const target = checkRevealSnapshot(identity, snapshot, account, 1);
    const blob = input instanceof Blob ? input : new Blob([matchingKeptReveal(input, identity, snapshot, 'open').text]);
    const file = await parseOpenRevealFileV2(blob, { root: snapshot.root, size: snapshot.size, firstId: snapshot.firstId, specHash: snapshot.specHash });
    if (!await chain.canonical(snapshot.block)) refuse('reorg');
    const source = Object.freeze({ identity: Object.freeze({ ...identity }), target, file });
    sources.add(source);
    return { ok: true, value: source };
  } catch (e) { return { ok: false, reason: reasonOf(e, 'invalid-source') }; }
}

interface IndexedReveal { readonly call: RevealCall; readonly hashes: { image: Hex; avatar: Hex; model: Hex } }
const indexes = new WeakMap<RevealSource, ReadonlyMap<string, IndexedReveal>>();
function index(source: RevealSource): ReadonlyMap<string, IndexedReveal> {
  if (!sources.has(source)) refuse('invalid-source');
  let found = indexes.get(source);
  if (!found) {
    const entries = new Map<string, IndexedReveal>();
    // Generate and verify each proof once for this checked source, then address calls by ID.
    for (const batch of planOpenRevealBatchesV2(source.file, { collection: source.target.collection })) {
      for (const inner of decodeFunctionData({ abi: multicall3Abi, data: batch.data }).args[0]) {
        const decoded = decodeFunctionData({ abi: boxCollectionAbi, data: inner.callData });
        if (decoded.functionName !== 'reveal') refuse('invalid-source');
        const [id, , image, avatar, model] = decoded.args;
        entries.set(id.toString(), { call: { id: id.toString(), to: inner.target, value: '0', data: inner.callData }, hashes: { image, avatar, model } });
      }
    }
    found = entries; indexes.set(source, found);
  }
  return found;
}
function batchFor(source: RevealSource, ids: readonly string[]): RevealBatch {
  const entries = index(source);
  const calls = ids.map(id => { const entry = entries.get(id); if (!entry) refuse('progress-invalid'); return entry.call; });
  const batch = foldReveals(calls, 40)[0];
  if (!batch || batch.ids.length !== ids.length) refuse('progress-invalid');
  return batch;
}
const countsOf = (source: RevealSource, finalized: Set<bigint>, head: Set<bigint>): RevealCounts => Object.freeze({
  size: source.file.size, finalized: BigInt(finalized.size), latest: BigInt(head.size),
  remainingFinalized: source.file.size - BigInt(finalized.size), remainingLatest: source.file.size - BigInt(head.size),
  finalizedComplete: BigInt(finalized.size) === source.file.size,
});
interface RunState {
  final: RevealSnapshot; latest: RevealSnapshot; finalized: Set<bigint>; head: Set<bigint>; counts: RevealCounts;
  journal?: RevealProgress; full: boolean; awaiting: Map<string, bigint>; discovery: number;
}
async function state(source: RevealSource, chain: RevealReads, previous?: RunState, touched: readonly string[] = [], progress?: RevealProgress, discover = false): Promise<RunState> {
  if (!sources.has(source)) refuse('invalid-source');
  const [final, latest] = await settleRevealReads([chain.snapshot(source.identity, 'finalized'), chain.snapshot(source.identity, 'latest')]);
  for (const snapshot of [final, latest]) {
    const target = checkRevealSnapshot(source.identity, snapshot, source.identity.creator, 1);
    if (!sameRevealValue(target.collection, source.target.collection) || !sameRevealValue(snapshot.root, source.file.root)
      || snapshot.size !== source.file.size || snapshot.firstId !== source.file.firstId) refuse('wrong-commitment');
  }
  const full = !previous || (progress !== undefined && previous.journal !== progress) || final.block.number < previous.final.block.number || latest.block.number < previous.latest.block.number || !await chain.canonical(previous.latest.block) || !await chain.canonical(previous.final.block);
  const finalized = full ? new Set<bigint>() : previous.finalized;
  const head = full ? new Set<bigint>() : previous.head;
  const awaiting = full ? new Map<string, bigint>() : previous.awaiting;
  const ids = new Set(full ? index(source).keys() : touched);
  // Latest reveals by other callers have no journal intent. Revisit them once their observed block is final.
  if (previous && final.block.number > previous.final.block.number) {
    for (const [id, observedAt] of awaiting) if (observedAt <= final.block.number) ids.add(id);
  }
  let discovery = previous?.discovery ?? 0;
  // Bounded round-robin discovery: at most 256 IDs on each new finalized head.
  if (discover && previous && final.block.hash !== previous.final.block.hash) {
    const all = [...index(source).keys()];
    for (let n = 0; n < Math.min(256, all.length); n++) {
      const id = requireRevealValue(all[discovery % all.length]); discovery++;
      if (!finalized.has(BigInt(id))) ids.add(id);
    }
  }
  for (const intent of progress ? readyRevealIntents(progress, final.block.number) : []) {
    journalWork.scanned++;
    if (unresolvedIntent(intent) || (intent.status === 'included' && intent.block && BigInt(intent.block.number) <= final.block.number)) {
      for (const id of intent.ids) ids.add(id);
    }
  }
  if (ids.size) {
    const requested = [...ids].map(BigInt);
    const [f, l] = await settleRevealReads([chain.revealed(source.target.collection, requested, final.block), chain.revealed(source.target.collection, requested, latest.block)]);
    if (!Array.isArray(f) || !Array.isArray(l) || f.length !== requested.length || l.length !== requested.length
      || f.some(value => typeof value !== 'boolean') || l.some(value => typeof value !== 'boolean')) refuse('read-failed');
    if (!await chain.canonical(final.block) || !await chain.canonical(latest.block)) refuse('reorg');
    requested.forEach((id, i) => {
      if (f[i]) finalized.add(id); else finalized.delete(id);
      if (l[i]) head.add(id); else head.delete(id);
      if (l[i] && !f[i]) { if (!awaiting.has(id.toString())) awaiting.set(id.toString(), latest.block.number); }
      else awaiting.delete(id.toString());
    });
  }
  if (!ids.size && (!await chain.canonical(final.block) || !await chain.canonical(latest.block))) refuse('reorg');
  return { final, latest, finalized, head, counts: countsOf(source, finalized, head), full, awaiting, discovery, journal: progress };
}

export interface RevealBatchPlan { readonly batch: RevealBatch; readonly estimate: bigint; readonly gasLimit: bigint; readonly capWei: bigint }
export interface RevealPlan {
  readonly counts: RevealCounts; readonly batches: readonly RevealBatchPlan[]; readonly fee: SendFees;
  readonly retryReserveWei: bigint; readonly ceilingWei: bigint; readonly spentWei: bigint;
}
const plans = new WeakMap<RevealPlan, { source: RevealSource; progress: number }>();
const writeCall = (batch: RevealBatch): WriteCallV2 => ({ to: batch.to, data: batch.data, value: 0n });
function missing(source: RevealSource, revealed: ReadonlySet<bigint>): RevealBatch[] {
  const ids = [...index(source).keys()].filter(id => !revealed.has(BigInt(id)));
  const batches: RevealBatch[] = [];
  for (let i = 0; i < ids.length; i += 40) batches.push(batchFor(source, ids.slice(i, i + 40)));
  return batches;
}
function subset(batch: RevealBatch, start: number, end: number): RevealBatch {
  const calls = decodeFunctionData({ abi: multicall3Abi, data: batch.data }).args[0].slice(start, end);
  return Object.freeze({ ...batch, ids: Object.freeze(batch.ids.slice(start, end)), data: encodeFunctionData({ abi: multicall3Abi, functionName: 'aggregate3', args: [calls] }) });
}
/** Only explicit allowance errors authorize shrinking. Connectivity and other RPC errors remain failures. */
function gasAllowance(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /gas required exceeds allowance|exceeds (?:the )?(?:block gas limit|gas allowance)|transaction gas limit.*(?:cap|exceed)|gas limit.*exceeds.*(?:cap|block)/i.test(error.message)
    || (error.cause !== error && gasAllowance(error.cause));
}
async function estimateBatches(batch: RevealBatch, source: RevealSource, ports: RevealPorts, fee: SendFees): Promise<RevealBatchPlan[]> {
  const call = writeCall(batch);
  assertSendableCallV2(call, source.target, source.identity.creator);
  const shrink = async (reason: 'gas-cap' | 'simulation-failed'): Promise<RevealBatchPlan[]> => {
    if (batch.ids.length === 1) refuse(reason);
    const middle = Math.floor(batch.ids.length / 2);
    return [...await estimateBatches(subset(batch, 0, middle), source, ports, fee), ...await estimateBatches(subset(batch, middle, batch.ids.length), source, ports, fee)];
  };
  let estimate: bigint;
  try { estimate = await ports.estimate(call, source.identity.creator); }
  catch (e) { if (gasAllowance(e)) return shrink('gas-cap'); refuse('estimate-failed'); }
  if (typeof estimate !== 'bigint' || estimate <= 0n) refuse('estimate-failed');
  let gasLimit = estimate + estimate / 5n;
  if (gasLimit > REVEAL_GAS_CAP) return shrink('gas-cap');
  // An allowFailure outer estimate may describe failed inners. Prove each proposed exact limit.
  for (;;) {
    let success = false;
    try {
      const result = readOpenRevealResultsV2(batch, 'success', await ports.simulate(call, source.identity.creator, gasLimit));
      success = !result.failed.length && !result.unknown.length;
    } catch (e) { if (!gasAllowance(e)) refuse('simulation-failed'); }
    if (success) return [Object.freeze({ batch: Object.freeze({ ...batch, ids: Object.freeze([...batch.ids]) }), estimate, gasLimit, capWei: sendCostCap(gasLimit, fee, 0n) })];
    if (gasLimit === REVEAL_GAS_CAP) return shrink('simulation-failed');
    gasLimit = gasLimit * 2n > REVEAL_GAS_CAP ? REVEAL_GAS_CAP : gasLimit * 2n;
  }
}
async function journal(source: RevealSource, ports: RevealPorts): Promise<RevealProgress> {
  try { return await readRevealProgress(ports.store, revealProgressKey(source.identity.chainId, source.identity.token), source.identity.specHash); }
  catch { return refuse('progress-invalid'); }
}
async function persist(source: RevealSource, ports: RevealPorts, progress: RevealProgress, intent: RevealIntent): Promise<RevealProgress> {
  if (intent.hash) ports.observeAttempt?.(intent, false);
  try {
    const saved = await saveRevealIntent(ports.store, revealProgressKey(source.identity.chainId, source.identity.token), progress, intent);
    ports.observeAttempt?.(intent, true);
    return saved;
  }
  catch { return refuse('store-failed'); }
}
const spent = spentRevealCaps;

/** Reconcile active evidence. Included work is resolved for sending, then checked again at finality. */
async function reconcile(source: RevealSource, ports: RevealPorts, progress: RevealProgress, current: RunState, included?: (attempt: string) => void): Promise<RevealProgress> {
  let pending: RevealReason | null = null;
  const intents: RevealIntent[] = [];
  const canonical = new Map<string, boolean>();
  for (const original of current.full ? progress.intents : readyRevealIntents(progress, current.final.block.number)) {
    journalWork.scanned++;
    if (original.ticket) refuse('progress-invalid');
    // Validate IDs against the checked source without regenerating other proofs.
    if (current.full) for (const id of original.ids) if (!index(source).has(id)) refuse('progress-invalid');
    let intent = original;
    if (intent.status === 'refused' || intent.status === 'user-released') { continue; }
    if (intent.status === 'finalized' || intent.status === 'reverted') {
      let invalidated = current.full && ((intent.block !== undefined && BigInt(intent.block.number) > current.final.block.number)
        || intent.succeeded?.some(id => !current.finalized.has(BigInt(id))));
      if (current.full && intent.block) {
        let valid = canonical.get(intent.block.hash);
        if (valid === undefined) { valid = await ports.chain.canonical({ number: BigInt(intent.block.number), hash: intent.block.hash }); canonical.set(intent.block.hash, valid); }
        invalidated ||= !valid;
      }
      if (!invalidated) { continue; }
      intent = { ...intent, status: intent.hash ? 'submitted' : 'unknown' };
    }
    if (intent.status === 'included' && !current.full && intent.block && BigInt(intent.block.number) > current.final.block.number) {
      continue;
    }
    const finalized = intent.ids.filter(id => current.finalized.has(BigInt(id)));
    let resolved = false;
    let waiting: RevealReason = intent.hash ? 'receipt-pending' : 'unknown-send';
    if (intent.hash) {
      const receipt = await ports.chain.receipt(intent.hash);
      if (receipt) {
        const batch = batchFor(source, intent.ids);
        // These are the fetched transaction's fields, not wallet-request assumptions. Nonce is observed, not compared.
        if (!sameRevealValue(receipt.hash, intent.hash) || !sameRevealValue(receipt.from, intent.account) || receipt.nonce < 0n
          || !sameRevealValue(receipt.to, batch.to) || !sameRevealValue(receipt.input, batch.data) || receipt.value !== 0n) refuse('read-failed');
        if (!await ports.chain.canonical(receipt.block)) waiting = 'reorg';
        else {
          included?.(intent.attempt);
          if (current.latest.block.number >= receipt.block.number + REVEAL_CONFIRMATION_BLOCKS) {
            const final = receipt.block.number <= current.final.block.number;
            const succeeded = final ? finalized : intent.ids.filter(id => current.head.has(BigInt(id)));
            intent = { ...intent, nonce: receipt.nonce.toString(), status: final ? (receipt.status === 'reverted' ? 'reverted' : 'finalized') : 'included',
              block: { number: receipt.block.number.toString(), hash: receipt.block.hash }, receiptStatus: receipt.status,
              succeeded, emitted: readOpenRevealReceiptV2(batch, receipt).succeeded };
            resolved = true;
          }
        }
      }
    }
    if (!resolved && finalized.length === intent.ids.length) {
      intent = { ...intent, status: 'finalized', succeeded: finalized, emitted: [], receiptStatus: undefined, block: { number: current.final.block.number.toString(), hash: current.final.block.hash } };
      resolved = true;
    }
    if (!resolved) {
      intent = { ...intent, status: intent.hash ? 'submitted' : 'unknown' };
      pending ??= waiting;
    }
    if (intent !== original) intents.push(intent);
  }
  try { progress = await saveRevealChanges(ports.store, revealProgressKey(source.identity.chainId, source.identity.token), progress, intents); }
  catch { refuse('store-failed'); }
  intents.forEach((intent) => ports.observeAttempt?.(intent, true));
  if (pending) refuse(pending);
  return progress;
}
async function planUnlocked(source: RevealSource, ports: RevealPorts): Promise<RevealPlan> {
  if (await ports.chain.chainId() !== source.identity.chainId) refuse('read-chain-changed');
  let progress = await journal(source, ports);
  const current = await state(source, ports.chain, undefined, [], progress);
  progress = await reconcile(source, ports, progress, current);
  const fee = Object.freeze(await readSendFees(ports.feeReader, source.identity.chainId));
  const batches: RevealBatchPlan[] = [];
  for (const batch of missing(source, current.head)) batches.push(...await estimateBatches(batch, source, ports, fee));
  const retryReserveWei = batches.reduce((max, b) => b.capWei > max ? b.capWei : max, 0n) * BigInt(REVEAL_RETRIES);
  const spentWei = spent(progress);
  const plan = Object.freeze({ counts: current.counts, batches: Object.freeze(batches), fee, retryReserveWei, spentWei,
    ceilingWei: batches.reduce((sum, b) => sum + b.capWei, retryReserveWei + spentWei) });
  plans.set(plan, { source, progress: journalRevision(progress) });
  return plan;
}
async function locked<T>(source: RevealSource, ports: RevealPorts, work: () => Promise<T>): Promise<RevealResult<T>> {
  requireRevealAuthority(ports);
  if (!sources.has(source)) return { ok: false, reason: 'invalid-source' };
  if (!ports.lock) return { ok: false, reason: 'lock-unavailable' };
  try {
    const result = await ports.lock.run(revealProgressKey(source.identity.chainId, source.identity.token), work);
    return result.acquired ? { ok: true, value: result.value } : { ok: false, reason: 'running-elsewhere' };
  } catch (e) { return { ok: false, reason: reasonOf(e, 'read-failed') }; }
}
export const prepareRevealItems = (source: RevealSource, ports: RevealPorts): Promise<RevealResult<RevealPlan>> => locked(source, ports, () => planUnlocked(source, ports));
/** The page calls this only from its explicit "nothing pending in my wallet" decision. No automatic release. */
export const releaseUnknownRevealIntent = (source: RevealSource, attempt: string, ports: RevealPorts): Promise<RevealResult<void>> => locked(source, ports, async () => {
  const progress = await journal(source, ports);
  const intent = findRevealIntent(progress, attempt);
  if (!intent || intent.hash || !['intent', 'unknown'].includes(intent.status)) refuse('release-not-allowed');
  try { if (!await releaseWait(ports.store, revealProgressKey(source.identity.chainId, source.identity.token), progress, intent, ports.clock)) refuse('release-too-soon'); }
  catch (e) { if (e instanceof RevealRefusal) throw e; refuse('release-too-soon'); }
  await persist(source, ports, progress, { ...requireRevealValue(findRevealIntent(progress, attempt)), status: 'user-released' });
});
/** Read-only counts remain available while another tab holds the sender lock. */
export async function readRevealItemCounts(source: RevealSource, chain: RevealReads): Promise<RevealResult<RevealCounts>> {
  try { return { ok: true, value: (await state(source, chain)).counts }; }
  catch (e) { return { ok: false, reason: reasonOf(e, 'read-failed') }; }
}
const finalityStates = new WeakMap<RevealSource, RunState>();
/** Poll separately after the run: only active intents newly eligible for finality need item reads. */
export async function reconcileRevealItems(source: RevealSource, ports: RevealPorts): Promise<RevealResult<RevealCounts> & { readonly counts?: RevealCounts }> {
  const result = await locked(source, ports, async () => {
    const progress = await journal(source, ports);
    const current = await state(source, ports.chain, finalityStates.get(source), [], progress, true);
    finalityStates.set(source, current);
    await reconcile(source, ports, progress, current);
    return current.counts;
  });
  return { ...result, counts: finalityStates.get(source)?.counts };
}

async function context(source: RevealSource, ports: RevealPorts, signal: AbortSignal) {
  if (signal.aborted) refuse('cancelled');
  const chain = parseChainId(await ports.wallet({ method: 'eth_chainId' }));
  const accounts = parseAccounts(await ports.wallet({ method: 'eth_accounts' }));
  if (chain !== source.identity.chainId) refuse('chain-changed');
  if (!sameRevealValue(accounts[0], source.identity.creator)) refuse('account-changed');
  if (signal.aborted) refuse('cancelled');
}

export interface RevealRun { readonly counts: RevealCounts; readonly reservedWei: bigint; readonly reason: 'complete' | RevealReason;
  readonly unpersistedHash?: { readonly attempt: string; readonly hash: Hex } }
export interface RevealRunProgress {
  readonly counts: RevealCounts; readonly reservedWei: bigint;
  readonly phase: 'running' | 'wallet' | 'receipt' | 'confirmation' | 'finality';
  /** SH-203, read-only: the items of the batch at the wallet, awaiting its block, or whose earlier send is awaiting finality. */
  readonly ids?: readonly string[];
}
/** Only a plan handle returned to the page may start. Clones and edited plans are refused. */
export async function runRevealItems(plan: RevealPlan, ports: RevealPorts, signal: AbortSignal): Promise<RevealResult<RevealRun>> {
  requireRevealAuthority(ports);
  const held = plans.get(plan);
  if (!held) return { ok: false, reason: 'invalid-plan' };
  const { source } = held;
  return locked(source, ports, async () => {
    let counts = plan.counts, reservedWei = plan.spentWei;
    let unpersistedHash: RevealRun['unpersistedHash'];
    const report = (phase: RevealRunProgress['phase'], ids?: readonly string[]) => ports.progress?.(Object.freeze({ counts: Object.freeze({ ...counts }), reservedWei, phase,
      ...(ids ? { ids: Object.freeze([...ids]) } : {}) }));
    try {
      await context(source, ports, signal);
      let progress = await journal(source, ports);
      if (journalRevision(progress) !== held.progress) refuse('plan-changed');
      let current = await state(source, ports.chain, undefined, [], progress);
      progress = await reconcile(source, ports, progress, current);
      if (journalRevision(progress) !== held.progress) refuse('plan-changed');
      counts = current.counts;
      report('running');
      const initial = [...index(source).keys()].filter(id => !current.head.has(BigInt(id)));
      if (initial.join(',') !== plan.batches.flatMap(b => b.batch.ids).join(',')) refuse('plan-changed');
      const authorized = new Set(initial);
      const queue = [...plan.batches];
      let futureCap = queue.reduce((sum, b) => sum + b.capWei, 0n), retries = 0;
      // SH-203 af5 (R4-L3a): sends this press has started. The page showed the plan's batch count for the press.
      let sends = 0;
      let scopeInvalidated = false;
      const refresh = async (ids: readonly string[]) => {
        current = await state(source, ports.chain, current, ids, progress);
        scopeInvalidated ||= current.full;
        counts = current.counts;
      };
      const retryCap = plan.retryReserveWei / BigInt(REVEAL_RETRIES);
      const queueReorgHoles = (exclude: readonly string[]) => {
        if (!scopeInvalidated && !current.full) return;
        const queued = new Set([...exclude, ...queue.flatMap(b => b.batch.ids)]);
        const holes = [...index(source).keys()].filter(id => !current.head.has(BigInt(id)) && !queued.has(id));
        if (holes.some(id => !authorized.has(id))) refuse('plan-changed');
        for (let i = 0; i < holes.length; i += 40) {
          if (++retries > REVEAL_RETRIES) refuse('plan-changed');
          queue.push({ batch: batchFor(source, holes.slice(i, i + 40)), estimate: 0n, gasLimit: 0n, capWei: retryCap });
          futureCap += retryCap;
        }
        scopeInvalidated = false;
      };
      while (queue.length) {
        await context(source, ports, signal);
        const proposed = queue.shift(); if (!proposed) refuse('invalid-plan');
        futureCap -= proposed.capWei;
        await refresh(proposed.batch.ids);
        progress = await reconcile(source, ports, progress, current);
        counts = current.counts;
        report('running');
        queueReorgHoles(proposed.batch.ids);
        let ids = proposed.batch.ids.filter(id => !current.head.has(BigInt(id)));
        if (!ids.length) continue;
        // A failed/partial inclusion can return to the mempool. Only finality permits overlap.
        // Retry pieces sit after disjoint batches, which keep inclusion-plus-one pacing.
        for (let poll = 0; hasActiveRevealIds(progress, ids); poll++) {
          if (poll >= RECEIPT_POLLS) refuse('awaiting-finality');
          report('finality', ids);
          await ports.sleep(RECEIPT_POLL_MS, signal); await context(source, ports, signal);
          await refresh(ids);
          progress = await reconcile(source, ports, progress, current); counts = current.counts;
        }
        queueReorgHoles(proposed.batch.ids);
        ids = proposed.batch.ids.filter(id => !current.head.has(BigInt(id)));
        if (!ids.length) continue;
        // SH-203 af5 (R4-L3a): one press sends at most the transactions the page showed for it. A split at send time, a
        // retry or a batch a reorg dropped that needs one more ends the run for a new Prepare (which shows the new count);
        // what was sent stays in the journal and in reservedWei.
        if (sends >= plan.batches.length) refuse('plan-changed');
        sends += 1;
        // One fresh endpoint check per send preflight, after any finality wait.
        if (await ports.chain.chainId() !== source.identity.chainId) refuse('read-chain-changed');
        const fee = await readSendFees(ports.feeReader, source.identity.chainId);
        const estimated = await estimateBatches(batchFor(source, ids), source, ports, fee);
        const next = estimated[0]; if (!next) refuse('invalid-plan');
        const cost = estimated.reduce((sum, b) => sum + b.capWei, 0n);
        // Future batches keep their approved reservations. Reprice/re-simulate only the next batch.
        // A future increase must fit this same inequality before its send; otherwise stop for a new plan.
        if (reservedWei + futureCap + cost + retryCap * BigInt(REVEAL_RETRIES - retries) > plan.ceilingWei) refuse('plan-changed');
        queue.unshift(...estimated.slice(1)); futureCap += cost - next.capWei;
        await context(source, ports, signal);
        const nonceHint = await ports.chain.nonce(source.identity.creator, 'pending');
        const attempt = ports.attemptId();
        if (!attempt || findRevealIntent(progress, attempt)) refuse('progress-invalid');
        let intent: RevealIntent = { attempt, ids: next.batch.ids, account: source.identity.creator, createdAt: ports.now(), clock: startReleaseClock(ports.clock), capWei: next.capWei.toString(), status: 'intent' };
        let intentWritten = false;
        let requested = false, charged = false;
        let knownHash: Hex | undefined;
        const charge = () => { if (!charged) { reservedWei += next.capWei; charged = true; } };
        let boundaryReason: RevealReason | null = null;
        const wallet: Eip1193Request = async request => {
          if (request.method !== 'eth_sendTransaction') return ports.wallet(request);
          try {
            await context(source, ports, signal);
            if (requested) refuse('plan-changed');
            if (!Array.isArray(request.params) || request.params.length !== 1) refuse('invalid-plan');
            const tx = request.params[0] as Record<string, unknown>;
            if (!sameRevealValue(tx.to as string, next.batch.to) || tx.data !== next.batch.data || tx.gas !== toQuantity(next.gasLimit)
              || tx.maxFeePerGas !== toQuantity(fee.maxFeePerGas) || tx.value !== '0x0') refuse('invalid-plan');
            if (signal.aborted) refuse('cancelled');
            report('wallet', next.batch.ids);
            if (signal.aborted) refuse('cancelled');
            const reply = await forwardRevealSend(ports.chain, source.identity.chainId, async () => {
              progress = await persist(source, ports, progress, intent); intentWritten = true;
            }, () => {
              if (signal.aborted) refuse('cancelled');
              requested = true;
              return ports.wallet({ ...request, params: [{ ...tx, nonce: toQuantity(nonceHint) }] });
            }, () => checkRequestPrice(ports.feeReader, source.identity.chainId, tx));
            if (typeof reply === 'string' && /^0x[0-9a-fA-F]{64}$/.test(reply)) {
              knownHash = reply as Hex; charge(); unpersistedHash = { attempt, hash: knownHash };
              intent = { ...intent, hash: knownHash, status: 'submitted' };
              progress = await persist(source, ports, progress, intent); unpersistedHash = undefined;
              report('receipt', next.batch.ids);
            }
            return reply;
          } catch (e) { boundaryReason = reasonOf(e, 'unknown-send'); throw e; }
        };
        try {
          const hash = await (revealTestOverride(ports)?.send ?? submitWrite)({ protocol: 'core-v2', target: source.target, call: writeCall(next.batch), from: source.identity.creator,
            wallet, gasLimit: next.gasLimit, fee, feeReader: ports.feeReader });
          if (!requested || !knownHash || !sameRevealValue(hash, knownHash)) refuse('unknown-send');
        } catch (e) {
          if (knownHash) refuse(boundaryReason ?? reasonOf(e, 'receipt-pending'));
          const refused = !requested || e instanceof WalletRejectedError;
          intent = { ...intent, status: refused ? 'refused' : 'unknown' };
          if (requested && !refused) charge();
          if (intentWritten) progress = await persist(source, ports, progress, intent);
          refuse(refused ? boundaryReason ?? priceReason(e) ?? (e instanceof WalletContextChangedError ? `${e.change}-changed` : 'wallet-refused') : 'unknown-send');
        }
        charge();
        let included = false;
        for (let poll = 0; poll < RECEIPT_POLLS; poll++) {
          await context(source, ports, signal);
          await refresh(next.batch.ids);
          counts = current.counts;
          report(included ? 'confirmation' : 'receipt', next.batch.ids);
          try {
            progress = await reconcile(source, ports, progress, current, observed => {
              if (observed === attempt) { included = true; report('confirmation', next.batch.ids); }
            });
            break;
          }
          catch (e) {
            const reason = reasonOf(e, 'read-failed');
            if (reason === 'reorg') { included = false; report('receipt', next.batch.ids); }
            if (!['receipt-pending', 'reorg'].includes(reason) || poll === RECEIPT_POLLS - 1) throw e;
            // Reconciliation may have persisted new evidence before reporting another pending intent.
            progress = await journal(source, ports);
          }
          await ports.sleep(RECEIPT_POLL_MS, signal);
        }
        queueReorgHoles(next.batch.ids);
        const result = findRevealIntent(progress, attempt);
        if (!result) refuse('progress-invalid');
        const holes = next.batch.ids.filter(id => !current.head.has(BigInt(id)));
        if (holes.length) {
          if (++retries > REVEAL_RETRIES) refuse(result.receiptStatus === 'reverted' ? 'revert-limit' : 'inner-failure-limit');
          const limit = Math.max(1, Math.floor(next.batch.ids.length / 2));
          // Divide this retry's reserved cap between its smaller pieces; exact costs are checked before each send.
          const smaller: RevealBatchPlan[] = [];
          for (let i = 0; i < holes.length; i += limit) {
            const batch = batchFor(source, holes.slice(i, i + limit));
            const capWei = retryCap * BigInt(batch.ids.length) / BigInt(holes.length);
            smaller.push({ ...next, batch, capWei }); futureCap += capWei;
          }
          if (result.status === 'included') queue.push(...smaller); else queue.unshift(...smaller);
        }
      }
      finalityStates.set(source, current);
      return { counts, reservedWei, reason: counts.finalizedComplete ? 'complete' : 'awaiting-finality' };
    } catch (e) {
      const reason = reasonOf(e, signal.aborted ? 'cancelled' : 'read-failed');
      if (reason === 'read-chain-changed') plans.delete(plan);
      return { counts, reservedWei, reason, ...(unpersistedHash ? { unpersistedHash } : {}) };
    }
  });
}

/** O(1) lookup from checked source entries; no regeneration of preceding items' proofs. */
export function revealItemHashes(source: RevealSource, id: bigint): { image: Hex; avatar: Hex; model: Hex } | null {
  const hashes = sources.has(source) ? index(source).get(id.toString())?.hashes : null;
  return hashes ? { ...hashes } : null;
}
