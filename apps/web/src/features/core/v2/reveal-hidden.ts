/** SH-202. Complete hidden draw discovery and one selected finalized opening. Never bulk reveal. */
import { requireRevealAuthority } from './reveal-session';
import { decodeEventLog, encodeFunctionData, isAddress, zeroAddress, type Address, type Hex } from 'viem';
import { decodeBoxSpecV2 } from '../../../../../../packages/box-spec/src/generated/box-spec.v2';
import { readOpenRevealJsonV2 } from '../../../../../../packages/chain/src/core/v2/open-reveal-json-v2';
import { boxCollectionAbi, boxTicketsAbi } from '@squarehole/chain/abi';
import type { WriteCallV2 } from '../../../../../../packages/chain/src/core/v2/write-calls-v2';
import { checkRequestPrice, readSendFees, sendCostCap, submitWrite, WalletRejectedError, type SendFees } from '../../../../../../packages/chain/src/write/executor';
import { readRevealProgress, revealProgressKey, saveRevealIntent, saveRevealChanges, spentRevealItemCaps, activeRevealIntents, findRevealIntent, requireRevealValue, journalRevision, unresolvedIntent, type RevealIntent, type RevealProgress, type RevealProgressStore, type RevealLock } from './reveal-items-store';
import type { KeptReveal } from '../../create/v2/reveal-keep';
import { readRevealFile, type RevealFile } from './reveal-file';
import { hiddenTarget, type HiddenIO, type HiddenRoles } from './hidden-draws';
import { checkRevealSnapshot, matchingKeptReveal, priceReason, sameRevealValue, forwardRevealSend, RevealRefusal, REVEAL_GAS_CAP, type RevealBlock, type RevealReceipt, type RevealIdentity, type RevealReads, type RevealResult } from './reveal-items';

import { releaseWait, startReleaseClock, type RevealClock } from './reveal-clock';
import { revealTestOverride } from './reveal-test-seam';
import { toQuantity } from '../../../../../../packages/chain/src/write/eip1193';

export interface HiddenRevealSource { readonly identity: RevealIdentity; readonly collection: Address; readonly tickets: Address; readonly file: RevealFile }
const sources = new WeakSet<HiddenRevealSource>();
const specText = (value: unknown): string => JSON.stringify(value, (key, v: unknown) => {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string' && ['token', 'marketplaceOwner', 'creatorFeeRecipient'].includes(key)) return v.toLowerCase();
  return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v;
});
export async function loadHiddenReveal(identity: RevealIdentity, account: Address, input: Blob | KeptReveal, chain: RevealReads): Promise<RevealResult<HiddenRevealSource>> {
  try {
    const snapshot = await chain.snapshot(identity, 'finalized');
    if (!isAddress(account) || account === zeroAddress) return { ok: false, reason: 'invalid-source' };
    const target = checkRevealSnapshot(identity, snapshot, identity.creator, 2);
    if (!target.tickets) return { ok: false, reason: 'wrong-mode' };
    const blob = input instanceof Blob ? input : new Blob([matchingKeptReveal(input, identity, snapshot, 'hidden').text]);
    // A wrapper must carry this exact spec. A bare reveal list is bound by its root and every leaf.
    const frame = await readOpenRevealJsonV2(blob) as { format?: unknown; encoded?: unknown; specHash?: unknown; spec?: unknown; revealList?: unknown };
    if (frame.format === 'squarehole.boxspec/2' && (frame.encoded !== snapshot.encodedSpec || frame.specHash !== snapshot.specHash
      || specText(frame.spec) !== specText(decodeBoxSpecV2(snapshot.encodedSpec)))) return { ok: false, reason: 'wrong-spec' };
    frame.revealList = undefined; // Release the projected list before the hidden reader owns its checked rows.
    const file = await readRevealFile(blob, snapshot.root, snapshot.size);
    if (!await chain.canonical(snapshot.block)) return { ok: false, reason: 'reorg' };
    const source = Object.freeze({ identity: Object.freeze({ ...identity }), collection: target.collection, tickets: target.tickets, file: Object.freeze(file) });
    sources.add(source);
    return { ok: true, value: source };
  } catch (e) { return { ok: false, reason: e instanceof RevealRefusal ? e.reason : 'invalid-source' }; }
}

export type HiddenWait = 'randomness' | 'settlement' | 'finality' | 'grace' | 'closed' | 'missing-proof' | 'invalid-caller' | 'changed' | 'cancelled' | 'unknown-send' | 'send-refused' | 'running-elsewhere' | 'lock-unavailable' | 'store-failed' | 'progress-invalid' | 'receipt-pending' | 'release-too-soon' | 'release-not-allowed' | 'invalid-plan' | 'plan-changed' | 'read-chain-changed' | 'gas-price-unread' | 'gas-price-high' | 'gas-price-rose';
export interface HiddenDrawState {
  readonly id: bigint; readonly drawer: Address; readonly status: 'requested' | 'settled' | 'opened' | 'cancelled' | 'none';
  readonly itemId: bigint; readonly posted: boolean;
  /** drawTicket.revealFallbackAt already includes settlement's rounded hours and the 30-day grace. */
  readonly revealFallbackAt: bigint;
  readonly drawerCode: Hex;
}
/** IBoxTickets DrawStatus: None=0, Requested=1, Settled=2, Opened=3, Cancelled=4. */
export function hiddenDrawStatus(value: unknown): HiddenDrawState['status'] {
  if (value === 0 || value === 0n) return 'none';
  if (value === 1 || value === 1n) return 'requested';
  if (value === 2 || value === 2n) return 'settled';
  if (value === 3 || value === 3n) return 'opened';
  if (value === 4 || value === 4n) return 'cancelled';
  throw new Error('invalid-draw-status');
}
export interface HiddenDrawSnapshot {
  readonly block: RevealBlock; readonly timestamp: bigint; readonly requested: bigint;
}
export interface HiddenRevealReads {
  snapshot(tag: 'finalized' | 'latest'): Promise<HiddenDrawSnapshot>;
  draw(id: bigint, block: RevealBlock): Promise<HiddenDrawState>;
  canonical(block: RevealBlock): Promise<boolean>;
  /** Includes the actual transaction fields, fetched by this hash. */
  receipt(hash: Hex): Promise<RevealReceipt | null>;
}
export interface HiddenOpening {
  readonly draw: HiddenDrawState; readonly reason: 'ready' | HiddenWait;
  readonly recipient: Address; readonly blockedBy?: bigint;
}
export const HIDDEN_PAGE_SIZE = 64n;
export const HIDDEN_GRACE_SECONDS = 30n * 24n * 60n * 60n;
function opening(source: HiddenRevealSource, draw: HiddenDrawState, account: Address, timestamp: bigint): HiddenOpening {
  const mine = sameRevealValue(draw.drawer, account);
  const recipient = mine ? account : draw.drawer;
  let reason: HiddenOpening['reason'];
  if (!isAddress(account) || account === zeroAddress) reason = 'invalid-caller';
  else if (draw.status === 'requested') reason = draw.posted ? 'settlement' : 'randomness';
  else if (draw.status !== 'settled') reason = 'closed';
  else if (!mine && draw.drawerCode !== '0x' && !/^0xef0100[0-9a-fA-F]{40}$/.test(draw.drawerCode)
    && timestamp < draw.revealFallbackAt) reason = 'grace';
  else if (!source.file.revealOf(draw.itemId)) reason = 'missing-proof';
  else reason = 'ready';
  return { draw, reason, recipient };
}

/** Snapshot the complete history once; page 1 starts at ticket 1, never at requested - 64. */
export async function* pendingHiddenDraws(source: HiddenRevealSource, account: Address, reads: HiddenRevealReads, signal: AbortSignal): AsyncGenerator<readonly HiddenOpening[]> {
  if (!sources.has(source)) throw new Error('invalid-source');
  const snapshot = await reads.snapshot('finalized');
  if (snapshot.requested < 0n || snapshot.requested > BigInt(source.file.n)) throw new Error('invalid-draw-count');
  let blockedBy: bigint | undefined;
  for (let first = 1n; first <= snapshot.requested; first += HIDDEN_PAGE_SIZE) {
    if (signal.aborted) return;
    const rows: HiddenOpening[] = [];
    for (let id = first; id < first + HIDDEN_PAGE_SIZE && id <= snapshot.requested; id++) {
      const draw = await reads.draw(id, snapshot.block);
      if (signal.aborted) return;
      if (draw.id !== id) throw new Error('invalid-draw');
      if (draw.status === 'opened') continue;
      const row = opening(source, draw, account, snapshot.timestamp);
      rows.push({ ...row, ...(draw.status === 'requested' && blockedBy !== undefined ? { blockedBy } : {}) });
      if (draw.status === 'requested' && blockedBy === undefined) blockedBy = id;
    }
    if (!await reads.canonical(snapshot.block)) throw new Error('reorg');
    yield rows;
  }
}

export async function prepareHiddenOpening(source: HiddenRevealSource, ticket: bigint, account: Address, reads: HiddenRevealReads): Promise<HiddenOpening> {
  if (!sources.has(source)) throw new Error('invalid-source');
  const final = await reads.snapshot('finalized');
  const head = await reads.snapshot('latest');
  const draw = await reads.draw(ticket, final.block);
  const latest = await reads.draw(ticket, head.block);
  const row = opening(source, draw, account, final.timestamp);
  if (draw.id !== ticket || latest.id !== ticket || !await reads.canonical(final.block) || !await reads.canonical(head.block)) return { ...row, reason: 'changed' };
  if (draw.status !== 'settled' && latest.status === 'settled') return { ...row, reason: 'finality' };
  if (draw.status !== latest.status || draw.itemId !== latest.itemId || !sameRevealValue(draw.drawer, latest.drawer)) return { ...row, reason: 'changed' };
  return row;
}

export interface HiddenOpeningJournal {
  observeAttempt?(intent: RevealIntent, durable: boolean): void;
  readonly chain: Pick<RevealReads, 'chainId'>;
  readonly store: RevealProgressStore; readonly lock: RevealLock | null;
  now(): number; attemptId(): string; readonly clock: RevealClock;
  /** A successful direct openDraw at this exact gas limit, or a thrown failure. */
  simulateOpening(call: WriteCallV2, account: Address, gasLimit: bigint): Promise<void>;
}
const hiddenResumes = new WeakMap<HiddenRevealSource, { block: RevealBlock; progress: RevealProgress }>();
async function reconcileHiddenProgress(source: HiddenRevealSource, reads: HiddenRevealReads, durable: HiddenOpeningJournal, progress: RevealProgress): Promise<RevealProgress> {
  const snapshot = await reads.snapshot('finalized');
  const intents: RevealIntent[] = [];
  const before = hiddenResumes.get(source);
  const full = !before || before.progress !== progress || !await reads.canonical(before.block);
  for (const original of full ? progress.intents : activeRevealIntents(progress)) {
    let intent = original;
    if (['closed', 'reverted', 'finalized'].includes(intent.status)) {
      if (intent.block && BigInt(intent.block.number) <= snapshot.block.number && await reads.canonical({ number: BigInt(intent.block.number), hash: intent.block.hash })) continue;
      intent = { ...intent, status: intent.hash ? 'submitted' : 'unknown' };
    }
    if (!unresolvedIntent(intent)) continue;
    if (!intent.ticket) throw new Error('progress-invalid');
    const draw = await reads.draw(BigInt(intent.ticket), snapshot.block);
    if (draw.id !== BigInt(intent.ticket)) throw new Error('invalid-draw');
    if (intent.hash) {
      const receipt = await reads.receipt(intent.hash);
      if (receipt) {
        const selected = source.file.revealOf(BigInt(intent.ids[0] ?? '0'));
        if (!selected) throw new Error('missing-proof');
        const input = encodeFunctionData({ abi: boxTicketsAbi, functionName: 'openDraw', args: [BigInt(intent.ticket), intent.account, selected] });
        if (!sameRevealValue(receipt.hash, intent.hash) || !sameRevealValue(receipt.from, intent.account) || receipt.nonce < 0n
          || !sameRevealValue(receipt.to, source.tickets) || !sameRevealValue(receipt.input, input) || receipt.value !== 0n) throw new Error('invalid-receipt');
        if (receipt.block.number <= snapshot.block.number && await reads.canonical(receipt.block)) {
          const emitted = receipt.status === 'success' && receipt.logs.some(log => {
            if (!sameRevealValue(log.address, source.collection)) return false;
            try {
              const { args } = decodeEventLog({ abi: boxCollectionAbi, eventName: 'Revealed', data: log.data, topics: log.topics as [Hex, ...Hex[]] });
              return args.id.toString() === intent.ids[0] && args.traitsPacked === selected.traitsPacked
                && sameRevealValue(args.imageHash, selected.imageHash) && sameRevealValue(args.avatarHash, selected.avatarHash)
                && sameRevealValue(args.modelHash, selected.modelHash);
            } catch { return false; }
          }) ? intent.ids : [];
          intents.push({ ...intent, nonce: receipt.nonce.toString(), status: receipt.status === 'reverted' ? 'reverted' : 'closed', succeeded: emitted, emitted,
            block: { number: receipt.block.number.toString(), hash: receipt.block.hash }, receiptStatus: receipt.status });
          continue;
        }
      }
    }
    if (draw.status === 'opened' || draw.status === 'cancelled') {
      intents.push({ ...intent, status: 'closed', receiptStatus: undefined, emitted: [], succeeded: draw.status === 'opened' ? intent.ids : [],
        block: { number: snapshot.block.number.toString(), hash: snapshot.block.hash } });
      continue;
    }
    if (intent !== original) intents.push(intent);
  }
  if (!await reads.canonical(snapshot.block)) throw new Error('reorg');
  const next = await saveRevealChanges(durable.store, revealProgressKey(source.identity.chainId, source.identity.token), progress, intents);
  intents.forEach((intent) => durable.observeAttempt?.(intent, true));
  hiddenResumes.set(source, { block: snapshot.block, progress: next }); return next;
}
/** Resume/poll reconciliation uses the same origin-wide sender lock. */
export async function reconcileHiddenReveal(source: HiddenRevealSource, reads: HiddenRevealReads, durable: HiddenOpeningJournal): Promise<void> {
  requireRevealAuthority(durable);
  if (!sources.has(source)) throw new Error('invalid-source');
  if (!durable.lock) throw new Error('lock-unavailable');
  const key = revealProgressKey(source.identity.chainId, source.identity.token);
  const result = await durable.lock.run(key, async () => reconcileHiddenProgress(source, reads, durable,
    await readRevealProgress(durable.store, key, source.identity.specHash)));
  if (!result.acquired) throw new Error('running-elsewhere');
}
/** Same explicit decision and waiting rule as an open reveal's unknown send. */
export async function releaseUnknownHiddenOpening(source: HiddenRevealSource, attempt: string, durable: HiddenOpeningJournal): Promise<{ reason: 'released' | HiddenWait }> {
  requireRevealAuthority(durable);
  if (!sources.has(source)) return { reason: 'changed' };
  if (!durable.lock) return { reason: 'lock-unavailable' };
  const key = revealProgressKey(source.identity.chainId, source.identity.token);
  try {
    const result = await durable.lock.run(key, async (): Promise<{ reason: 'released' | HiddenWait }> => {
      const progress = await readRevealProgress(durable.store, key, source.identity.specHash);
      const intent = findRevealIntent(progress, attempt);
      if (!intent || !intent.ticket || intent.hash || !['intent', 'unknown'].includes(intent.status)) return { reason: 'release-not-allowed' };
      try { if (!await releaseWait(durable.store, key, progress, intent, durable.clock)) return { reason: 'release-too-soon' }; }
      catch { return { reason: 'release-too-soon' }; }
      await saveRevealIntent(durable.store, key, progress, { ...requireRevealValue(findRevealIntent(progress, attempt)), status: 'user-released' });
      return { reason: 'released' };
    });
    return result.acquired ? result.value : { reason: 'running-elsewhere' };
  } catch { return { reason: 'store-failed' }; }
}
/** The frozen handle is the complete cumulative approval for one item, including released caps. */
export interface HiddenOpeningHandle {
  readonly ticket: bigint; readonly itemId: bigint; readonly spentWei: bigint; readonly capWei: bigint;
  readonly ceilingWei: bigint; readonly gasLimit: bigint; readonly fee: SendFees;
}
interface HeldOpening {
  source: HiddenRevealSource; account: Address; roles: HiddenRoles; reads: HiddenRevealReads;
  io: Pick<HiddenIO, 'request' | 'estimate' | 'feeReader'>; durable: HiddenOpeningJournal; revision: number; call: WriteCallV2;
}
const handles = new WeakMap<HiddenOpeningHandle, HeldOpening>();
const itemSpent = spentRevealItemCaps;
export async function prepareHiddenReveal(source: HiddenRevealSource, ticket: bigint, account: Address, roles: HiddenRoles,
  reads: HiddenRevealReads, io: HeldOpening['io'], durable: HiddenOpeningJournal): Promise<{ reason: 'ready'; handle: HiddenOpeningHandle } | { reason: HiddenWait; hash?: Hex }> {
  requireRevealAuthority(durable);
  if (!sources.has(source)) return { reason: 'changed' };
  if (!durable.lock) return { reason: 'lock-unavailable' };
  try {
    const result = await durable.lock.run(revealProgressKey(source.identity.chainId, source.identity.token), async () => {
      if (await durable.chain.chainId() !== source.identity.chainId) return { reason: 'read-chain-changed' as const };
      if (roles.chainId !== source.identity.chainId || !sameRevealValue(roles.token, source.identity.token)
        || !sameRevealValue(roles.collection, source.collection) || !sameRevealValue(roles.tickets, source.tickets)
        || !sameRevealValue(roles.record.specHash, source.identity.specHash)) return { reason: 'changed' as const };
      let progress = await readRevealProgress(durable.store, revealProgressKey(source.identity.chainId, source.identity.token), source.identity.specHash);
      progress = await reconcileHiddenProgress(source, reads, durable, progress);
      const ready = await prepareHiddenOpening(source, ticket, account, reads);
      if (ready.reason !== 'ready') return { reason: ready.reason };
      const pending = activeRevealIntents(progress).find(i => i.ticket === ticket.toString() || i.ids.includes(ready.draw.itemId.toString()));
      if (pending) return { reason: pending.hash ? 'receipt-pending' as const : 'unknown-send' as const, ...(pending.hash ? { hash: pending.hash } : {}) };
      const selected = source.file.revealOf(ready.draw.itemId); if (!selected) return { reason: 'missing-proof' as const };
      const call = { to: source.tickets, value: 0n, data: encodeFunctionData({ abi: boxTicketsAbi, functionName: 'openDraw', args: [ticket, account, selected] }) };
      const estimate = await io.estimate(call, account);
      if (estimate <= 0n) return { reason: 'send-refused' as const };
      const gasLimit = estimate + estimate / 5n > 400_000n ? estimate + estimate / 5n : 400_000n;
      if (gasLimit > REVEAL_GAS_CAP) return { reason: 'send-refused' as const };
      const fee = Object.freeze(await readSendFees(io.feeReader, source.identity.chainId));
      await durable.simulateOpening(call, account, gasLimit);
      const spentWei = itemSpent(progress, ready.draw.itemId.toString()), capWei = sendCostCap(gasLimit, fee, 0n);
      const handle = Object.freeze({ ticket, itemId: ready.draw.itemId, spentWei, capWei, ceilingWei: spentWei + capWei, gasLimit, fee });
      handles.set(handle, { source, account, roles, reads, io, durable, revision: journalRevision(progress), call });
      return { reason: 'ready' as const, handle };
    });
    return result.acquired ? result.value : { reason: 'running-elsewhere' };
  } catch (e) { return { reason: priceReason(e) ?? 'store-failed' }; }
}
/** No bare sender argument. The module binds the executor and its durable wallet wrapper. */
export async function openHiddenReveal(handle: HiddenOpeningHandle, signal: AbortSignal, authority: object = handle): Promise<{ reason: 'sent' | HiddenWait; hash?: Hex; attempt?: string }> {
  requireRevealAuthority(authority);
  if (signal.aborted) return { reason: 'cancelled' };
  const held = handles.get(handle); if (!held) return { reason: 'invalid-plan' };
  handles.delete(handle);
  const { source, account, roles, reads, io, durable, call } = held;
  if (!durable.lock) return { reason: 'lock-unavailable' };
  const key = revealProgressKey(source.identity.chainId, source.identity.token);
  let knownHash: Hex | undefined, knownAttempt: string | undefined;
  try {
    const result = await durable.lock.run(key, async (): Promise<{ reason: 'sent' | HiddenWait; hash?: Hex; attempt?: string }> => {
      if (await durable.chain.chainId() !== source.identity.chainId) return { reason: 'read-chain-changed' };
      let progress = await readRevealProgress(durable.store, key, source.identity.specHash);
      if (journalRevision(progress) !== held.revision) return { reason: 'plan-changed' };
      progress = await reconcileHiddenProgress(source, reads, durable, progress);
      if (journalRevision(progress) !== held.revision) return { reason: 'plan-changed' };
      const ready = await prepareHiddenOpening(source, handle.ticket, account, reads);
      if (ready.reason !== 'ready' || ready.draw.itemId !== handle.itemId) return { reason: 'changed' };
      const fee = await readSendFees(io.feeReader, source.identity.chainId);
      const cap = sendCostCap(handle.gasLimit, fee, 0n);
      if (cap > handle.capWei || itemSpent(progress, handle.itemId.toString()) + cap > handle.ceilingWei) return { reason: 'plan-changed' };
      await durable.simulateOpening(call, account, handle.gasLimit);
      if (signal.aborted) return { reason: 'cancelled' };
      const attempt = durable.attemptId(); knownAttempt = attempt;
      if (findRevealIntent(progress, attempt)) return { reason: 'progress-invalid' };
      let intent: RevealIntent = { attempt, ids: [handle.itemId.toString()], ticket: handle.ticket.toString(), account,
        createdAt: durable.now(), clock: startReleaseClock(durable.clock), capWei: cap.toString(), status: 'intent' };
      const persist = async () => {
        if (intent.hash) durable.observeAttempt?.(intent, false);
        progress = await saveRevealIntent(durable.store, key, progress, intent);
        durable.observeAttempt?.(intent, true);
      };
      let requested = false, intentWritten = false;
      let boundaryReason: 'read-chain-changed' | 'store-failed' | NonNullable<ReturnType<typeof priceReason>> | undefined;
      const wallet: HiddenIO['request'] = async request => {
        if (request.method !== 'eth_sendTransaction') return io.request(request);
        if (requested || signal.aborted) throw new Error('cancelled');
        const current = await prepareHiddenOpening(source, handle.ticket, account, reads);
        if (current.reason !== 'ready' || current.draw.itemId !== handle.itemId || signal.aborted) throw new Error('changed');
        const tx = (request.params as readonly Record<string, unknown>[] | undefined)?.[0];
        if (!tx || tx.data !== call.data || !sameRevealValue(tx.to as string, call.to) || tx.gas !== toQuantity(handle.gasLimit)
          || tx.value !== '0x0' || tx.maxFeePerGas !== toQuantity(fee.maxFeePerGas)) throw new Error('invalid-plan');
        const reply = await forwardRevealSend(durable.chain, source.identity.chainId, async () => {
          try { await persist(); intentWritten = true; }
          catch (error) { boundaryReason = 'store-failed'; throw error; }
        }, () => {
          if (signal.aborted) throw new Error('cancelled');
          requested = true; return io.request(request);
        }, () => checkRequestPrice(io.feeReader, source.identity.chainId, tx)).catch(error => {
          if (error instanceof RevealRefusal && error.reason === 'read-chain-changed') boundaryReason = error.reason;
          boundaryReason = priceReason(error) ?? boundaryReason;
          throw error;
        });
        if (typeof reply !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(reply)) throw new Error('unknown-send');
        knownHash = reply as Hex; intent = { ...intent, hash: knownHash, status: 'submitted' }; await persist(); return reply;
      };
      try {
        const hash = await (revealTestOverride(durable)?.send ?? submitWrite)({ protocol: 'core-v2', target: hiddenTarget(roles, account), call,
          from: account, wallet, gasLimit: handle.gasLimit, fee, feeReader: io.feeReader });
        return knownHash && hash === knownHash ? { reason: 'sent', hash } : { reason: 'unknown-send' };
      } catch (e) {
        if (knownHash) return { reason: 'store-failed', hash: knownHash, attempt: knownAttempt };
        intent = { ...intent, status: requested && !(e instanceof WalletRejectedError) ? 'unknown' : 'refused' };
        if (intentWritten) await persist();
        return { reason: boundaryReason ?? priceReason(e) ?? (signal.aborted ? 'cancelled' : requested && !(e instanceof WalletRejectedError) ? 'unknown-send' : 'send-refused') };
      }
    });
    return result.acquired ? result.value : { reason: 'running-elsewhere' };
  } catch (e) { return { reason: (knownHash ? null : priceReason(e)) ?? 'store-failed', ...(knownHash ? { hash: knownHash, attempt: knownAttempt } : {}) }; }
}
