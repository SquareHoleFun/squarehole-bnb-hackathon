import { recoverAddress, type Hex } from 'viem';
import { z } from 'zod';
import { assetDecimals, buildAction, describeCalls, reconstructAction, validateLot, validateManifest, validateSnapshot } from './builders';
import { Journal, contentHash, toWire } from './journal';
import { address, hash, quarantineSchema, quarantineReasonSchema, present, requireThat, snapshotSchema, sourceSchema, uint } from './schema';
import { envelope, safeDigest, safeTransaction, servicePayload } from './safe';
import { manifestFromWire, validateMigration } from './manifest';
import type { Action, ChainReader, DigestSigner, Draft, Manifest, ReceiptLot, QuarantinedReceipt, Role, SafeProposer, SafeTransaction, Snapshot } from './types';

const executionSchema = z.strictObject({
  status: z.enum(['success', 'failed', 'cancelled']), canonical: z.literal(true), effectsVerified: z.literal(true),
  chainId: uint, safe: address, txHash: hash, logIndex: uint, safeTxHash: hash, nonce: uint, nonceAfter: uint.optional(),
});
const resolutionSchema = executionSchema.extend({
  amountIn: uint.optional(), amountOut: uint.optional(),
  supplyReduction: uint.optional(), budgetFunded: uint.optional(),
});
const transferEvidenceSchema = z.literal('unverified').optional();
export interface Proposal {
  id: Hex; batchId: string; day: bigint; draft: Draft; snapshot: Snapshot; transaction: SafeTransaction;
  status: 'pending' | 'success' | 'failed' | 'cancelled';
}
export interface CancellationProposal {
  id: Hex; replaces: Hex; role: Role; snapshot: Snapshot; transaction: SafeTransaction;
  status: 'pending' | 'success' | 'cancelled';
}
type LotState = { lot: ReceiptLot; consumed: bigint; reserved: bigint };
const object = (input: unknown): Record<string, unknown> => {
  requireThat(input !== null && typeof input === 'object' && !Array.isArray(input), 'journal event object required');
  return input as Record<string, unknown>;
};

/** One shared journal per chain and FIT Safe, across releases. No network transport or key loader. No platform role (F164 D2). */
export class Bot {
  private currentManifest: Manifest;
  private manifestVersions = new Set<string>();
  private proposalsInFlight = 0;
  get manifest(): Manifest { return structuredClone(this.currentManifest); }
  private quarantined = new Map<string, QuarantinedReceipt>();
  private lots = new Map<string, LotState>();
  private proposals = new Map<Hex, Proposal>();
  private cancellations = new Map<Hex, CancellationProposal>();
  // Rebuilt from each attempt's journal manifest revision, never repriced by a later migration.
  private gasCharges = new Map<Hex, bigint>();
  private receipts = new Set<string>();
  private resolutions = new Set<string>();
  private usedNonces = new Set<string>();
  private frozen = false;
  private aggregateExecutorBurned = 0n;
  constructor(manifest: unknown, private journal: Journal) {
    const requested = validateManifest(manifest);
    const firstMigration = journal.entries.map(entry => object(entry.record)).find(e => e.kind === 'manifest-migration');
    this.currentManifest = firstMigration ? manifestFromWire(firstMigration.previousManifest) : requested;
    this.manifestVersions.add(this.currentManifest.policyVersion);
    for (const entry of journal.entries) this.apply(object(entry.record));
    requireThat(contentHash(requested) === contentHash(this.manifest), 'journal manifest changed; explicit migration required');
  }
  /** Append an owner-reviewed configuration revision; every prior row, reservation and consumed nonce survives. */
  migrateManifest(input: unknown) {
    this.active();
    requireThat(this.proposalsInFlight === 0, 'proposal operation in progress; retry migration after it settles');
    const next = validateMigration(this.manifest, input);
    requireThat(!this.manifestVersions.has(next.policyVersion), 'manifest version already used');
    this.append({ kind: 'manifest-migration', previousManifest: this.manifest, nextManifest: next });
  }
  /** Keep validation, signing, transport and its journal evidence on one manifest revision. */
  private async withStableManifest(operation: () => Promise<void>) {
    this.proposalsInFlight++;
    try { await operation(); }
    finally { this.proposalsInFlight--; }
  }
  private append(event: Record<string, unknown>) {
    const sourceLot = event.lot ? object(event.lot) : null;
    const sourceSnapshot = event.snapshot ? object(event.snapshot) : null;
    const sourceResult = event.result ? object(event.result) : null;
    const pending = typeof event.id === 'string' ? this.proposals.get(event.id as Hex) ?? this.cancellations.get(event.id as Hex) : null;
    const safe = event.safe ?? sourceLot?.safe ?? sourceSnapshot?.safe ?? pending?.snapshot.safe ?? null;
    const txHash = sourceResult?.txHash ?? (sourceLot ? object(sourceLot.source).txHash : null);
    const status = sourceResult?.status ?? (event.kind === 'proposal' || event.kind === 'cancellation' ? 'awaiting-signatures'
      : event.kind === 'receipt' ? 'confirmed' : event.kind === 'quarantine' ? 'waiting' : event.kind);
    const wire = toWire({ schemaVersion: '1', recordedUtc: new Date().toISOString(), chainId: this.manifest.chainId,
      safe, batchId: event.batchId ?? (pending ? `${this.manifest.chainId}:${pending.snapshot.safe}:${pending.snapshot.block.timestamp / 86400n}` : null),
      status, txHash, ...event, policyVersion: this.manifest.policyVersion, manifestHash: contentHash(this.manifest) });
    this.journal.append(wire); this.apply(object(wire));
  }
  private active() { requireThat(!this.frozen, 'reconciliation required after reorg/correction'); }
  private receipt(lotInput: unknown) {
    const l = validateLot(this.manifest, lotInput);
    requireThat(l.kind === 'fee', 'only chain receipts; proceeds require confirmed sale');
    const key = `${l.chainId}:${l.source.txHash}:${l.source.logIndex}`;
    requireThat(!this.receipts.has(key) && !this.lots.has(l.id), 'duplicate receipt');
    return { l, key };
  }
  /** Ingest only finalized, attributed chain receipts; the adapter verifies receiver events and exact transfer evidence. */
  receive(input: unknown) { this.active(); const { l } = this.receipt(input); this.append({ kind: 'receipt', lot: l }); }
  /** Unsupported/unlabelled receipts are public backlog, never a spendable liability with a guessed beneficiary. */
  quarantine(input: unknown, reason: QuarantinedReceipt['reason'], transferEvidence?: QuarantinedReceipt['transferEvidence']) {
    this.active();
    const l = quarantineSchema.parse(input);
    requireThat(l.chainId === this.manifest.chainId && l.safe === this.manifest.safes[l.role], 'wrong quarantine chain/Safe');
    quarantineReasonSchema.parse(reason);
    transferEvidenceSchema.parse(transferEvidence);
    const key = `${l.chainId}:${l.source.txHash}:${l.source.logIndex}`;
    if (this.receipts.has(key)) return;
    const previous = this.quarantined.get(key);
    if (previous) {
      requireThat(contentHash(previous.lot) === contentHash(l), 'quarantined receipt changed');
      if (previous.reason === reason && previous.transferEvidence === transferEvidence) return;
    }
    this.append({ kind: 'quarantine', lot: l, reason, ...(transferEvidence ? { transferEvidence } : {}) });
  }
  private executorBurn(input: unknown) {
    const e = z.strictObject({ chainId: uint, executor: address, token: address, source: sourceSchema,
      bought: uint, unsolicited: uint, supplyReduction: uint, canonical: z.literal(true) }).parse(input);
    requireThat(e.chainId === this.manifest.chainId && e.executor === this.manifest.box0.executor && e.token === this.manifest.box0.fit, 'wrong executor burn identity');
    requireThat(e.bought + e.unsolicited > 0n && e.bought + e.unsolicited === e.supplyReduction, 'executor supply reduction mismatch');
    const key = `${e.chainId}:${e.source.txHash}:${e.source.logIndex}`;
    requireThat(!this.receipts.has(key), 'duplicate executor burn event');
    return { e, key };
  }
  /** Record finalized TokensBurned only. Executed summarizes the same burn and must never be counted again. */
  recordExecutorBurn(input: unknown) {
    this.active(); const { e } = this.executorBurn(input);
    this.append({ kind: 'executor-burn', event: e, txHash: e.source.txHash, status: 'confirmed', safe: null });
  }
  executorBurned() { return this.aggregateExecutorBurned; }
  /** Read-only scheduling state; callers cannot mutate reservations or bypass validated planning. */
  inspect() {
    return structuredClone({ lots: [...this.lots.values()], proposals: [...this.proposals.values()],
      quarantined: [...this.quarantined.values()], cancellations: [...this.cancellations.values()] });
  }
  hasReceipt(lot: ReceiptLot) { return this.receipts.has(`${lot.chainId}:${lot.source.txHash}:${lot.source.logIndex}`); }
  requireRunnerMode(dryRun: boolean) {
    for (const entry of this.journal.entries) {
      const e = object(entry.record);
      if (e.kind === 'runner-cycle') requireThat(object(e.detail).dryRun === dryRun, 'runner journal mode mismatch');
    }
    this.audit('runner-cycle', { dryRun, phase: 'started' });
  }
  audit(kind: 'runner-cycle' | 'runner-reconciliation' | 'runner-waiting', detail: Record<string, unknown>) {
    this.append({ kind, detail });
  }

  available(lotId: string): bigint {
    const l = this.lots.get(lotId); requireThat(l, 'unknown lot'); return l.lot.amount - l.consumed - l.reserved;
  }
  private nonceKey(s: Snapshot) { return `${s.chainId}:${s.safe}:${s.nonce}`; }
  private checkFifo(source: ReceiptLot) {
    const earlier = [...this.lots.values()].some(({ lot: other }) => other.id !== source.id
      && other.role === source.role && other.asset === source.asset && other.boxId === source.boxId
      && (other.kind === 'fee') && this.available(other.id) > 0n
      && (other.source.blockNumber < source.source.blockNumber
        || (other.source.blockNumber === source.source.blockNumber && other.source.logIndex < source.source.logIndex)));
    requireThat(!earlier, 'FIFO: consume earlier available receipt first');
  }
  private checkNonce(s: Snapshot) {
    requireThat(!this.usedNonces.has(this.nonceKey(s)) && ![...this.proposals.values()]
      .some(p => p.status === 'pending' && this.nonceKey(p.snapshot) === this.nonceKey(s)), 'nonce already reserved or consumed');
  }
  private checkDaily(s: Snapshot) {
    const attempts = [...this.proposals.values(), ...this.cancellations.values()]
      .filter(p => p.snapshot.safe === s.safe && p.snapshot.block.timestamp / 86400n === s.block.timestamp / 86400n);
    const gas = attempts.reduce((sum, p) => sum + present(this.gasCharges.get(p.id), 'missing gas reservation'), 0n);
    requireThat(BigInt(attempts.length) + 1n <= this.manifest.limits.maxActionsPerDay
      && gas + this.manifest.limits.transactionGas <= this.manifest.limits.maxGasPerDay, 'daily action/gas budget');
  }
  private simulationGas(id: Hex) {
    const reserved = present(this.gasCharges.get(id), 'missing gas reservation');
    return reserved < this.manifest.limits.transactionGas ? reserved : this.manifest.limits.transactionGas;
  }
  private prepare(snapshot: unknown, request: unknown, replay = false): Proposal {
    this.active(); const lotId = object(request).lotId;
    requireThat(typeof lotId === 'string', 'lot required'); const state = this.lots.get(lotId); requireThat(state, 'unknown lot');
    const draft = (replay ? reconstructAction : buildAction)(this.manifest, snapshot, { ...state.lot, amount: this.available(lotId) }, request);
    const s = snapshotSchema.parse(snapshot);
    // The draft was just validated and built here. Historical envelopes must not re-admit
    // retired routes through safeTransaction; apply still verifies the stored hash/calls/tx.
    const tx = envelope(this.manifest, s, draft.calls);
    this.checkNonce(s); this.checkDaily(s);
    // Pending and failed attempts count in the original UTC day; no service retry resets limits.
    const day = s.block.timestamp / 86400n;
    const daily = [...this.proposals.values()].filter(p => p.day === day && p.draft.role === draft.role);
    if (draft.request.kind === 'sale') {
      this.checkFifo(draft.source);
      const r = present(this.manifest.routes.find(r => r.id === (draft.request as Extract<Action, { kind: 'sale' }>).routeId), 'unknown route');
      const spent = daily.filter(p => p.draft.request.kind === 'sale' && p.draft.request.routeId === r.id)
        .reduce((sum, p) => sum + p.draft.amountIn, 0n);
      requireThat(spent + draft.amountIn <= r.maxDailyInput, 'daily route input budget');
    }
    // Balance is shared across lots. Existing pending reservations must not be pledged again under another lot id.
    const held = [...this.proposals.values()].filter(p => p.status === 'pending' && p.draft.role === draft.role && p.draft.inputAsset === draft.inputAsset)
      .reduce((sum, p) => sum + p.draft.amountIn, 0n);
    requireThat(held + draft.amountIn <= (s.balances[draft.inputAsset] ?? 0n), 'reserved Safe balance');
    const id = safeDigest(this.manifest.chainId, draft.safe, tx);
    requireThat(!this.proposals.has(id), 'duplicate proposal');
    return { id, batchId: `${this.manifest.chainId}:${draft.safe}:${day}`, day, draft, snapshot: s, transaction: tx, status: 'pending' };
  }
  plan(snapshot: unknown, request: unknown): Proposal {
    const p = this.prepare(snapshot, request);
    this.append({ kind: 'proposal', id: p.id, batchId: p.batchId, chainId: this.manifest.chainId, safe: p.draft.safe,
      txHash: null, snapshot: p.snapshot, request: p.draft.request,
      calls: p.draft.calls, decodedCalls: describeCalls(p.draft.calls, this.manifest.routes), minimumOut: p.draft.minimumOut, transaction: p.transaction,
      executionPolicy: { gasLimit: this.manifest.limits.transactionGas, maxFeePerGas: this.manifest.limits.maxFeePerGas } });
    return structuredClone(p);
  }
  /** Idempotent service retry uses the same reserved nonce/hash. */
  async propose(id: Hex, reader: ChainReader, service: SafeProposer, signer?: DigestSigner) {
    return this.withStableManifest(async () => {
      this.active(); const p = this.proposals.get(id); requireThat(p?.status === 'pending', 'pending proposal required');
      this.noCancellation(id);
      const fresh = await reader.snapshot(p.draft.role);
      if (p.draft.request.kind === 'sale') this.checkFifo(p.draft.source);
      const rebuilt = buildAction(this.manifest, fresh, p.draft.source, p.draft.request);
      const tx = safeTransaction(this.manifest, this.queuedSnapshot(fresh, p.transaction.nonce), rebuilt);
      requireThat(safeDigest(this.manifest.chainId, rebuilt.safe, tx) === id, 'nonce or calldata changed; new proposal required');
      const gasLimit = this.simulationGas(id);
      requireThat(await reader.simulate(rebuilt.safe, tx, fresh.block, gasLimit), 'whole-batch simulation refused');
      const signature = await this.sign(id, signer);
      this.active();
      requireThat(this.proposals.get(id)?.status === 'pending', 'proposal resolved while signing');
      this.noCancellation(id);
      // Record before the external side effect. A crash/outage keeps the reservation; safeTxHash is the idempotency key.
      this.append({ kind: 'submission', id, safe: rebuilt.safe, txHash: null, simulationBlock: fresh.block, simulation: 'passed', gasLimit });
      await service.propose(servicePayload(this.manifest, p.draft.role, tx, signature));
      this.append({ kind: 'proposed', id, safe: rebuilt.safe, txHash: null });
    });
  }
  private async sign(id: Hex, signer?: DigestSigner): Promise<Hex> {
    requireThat(signer, 'digest signer required'); const signature = await signer.signDigest(id);
    requireThat(/^0x[0-9a-fA-F]{128}(1b|1c)$/i.test(signature), 'EIP-712 r,s,v signature required');
    requireThat((await recoverAddress({ hash: id, signature })).toLowerCase() === this.manifest.owners.bot, 'signature is not from bot owner');
    return signature;
  }
  private noCancellation(id: Hex) {
    requireThat(![...this.cancellations.values()].some(c => c.replaces === id && c.status === 'pending'), 'cancellation already pending');
  }
  private cancellationTarget(id: Hex) {
    const p = this.proposals.get(id);
    requireThat(p?.status === 'pending', 'pending replacement target required'); return p;
  }
  private prepareCancellation(id: Hex, snapshot: unknown): CancellationProposal {
    this.active(); const target = this.cancellationTarget(id); this.noCancellation(id);
    const role = target.draft.role;
    const s = this.queuedSnapshot(validateSnapshot(this.manifest, snapshot, role), target.transaction.nonce);
    this.checkDaily(s);
    // No trade rebuild: a removed route, expired quote or failed box must not strand the nonce.
    const transaction = envelope(this.manifest, s, [{ to: s.safe, value: 0n, data: '0x', operation: 0 }]);
    const cancelId = safeDigest(this.manifest.chainId, s.safe, transaction);
    requireThat(cancelId !== id && !this.cancellations.has(cancelId), 'duplicate cancellation');
    return { id: cancelId, replaces: id, role, snapshot: s, transaction, status: 'pending' };
  }
  /** Reserve a zero-value self-call at the original nonce. Inputs stay reserved until canonical nonce resolution. */
  planCancellation(id: Hex, snapshot: unknown): CancellationProposal {
    const c = this.prepareCancellation(id, snapshot);
    this.append({ kind: 'cancellation', id: c.id, replaces: id, snapshot: c.snapshot, transaction: c.transaction, txHash: null });
    return structuredClone(c);
  }
  /** The FIT Safe still needs its second owner's signature. */
  async proposeCancellation(id: Hex, reader: ChainReader, service: SafeProposer, signer?: DigestSigner) {
    return this.withStableManifest(async () => {
      this.active(); const c = this.cancellations.get(id); requireThat(c?.status === 'pending', 'pending cancellation required');
      this.cancellationTarget(c.replaces);
      const s = validateSnapshot(this.manifest, await reader.snapshot(c.role), c.role);
      this.queuedSnapshot(s, c.transaction.nonce);
      const gasLimit = this.simulationGas(id);
      requireThat(await reader.simulate(s.safe, c.transaction, s.block, gasLimit), 'cancellation simulation refused');
      const signature = await this.sign(id, signer);
      this.active(); requireThat(c.status === 'pending', 'cancellation resolved while signing'); this.cancellationTarget(c.replaces);
      this.append({ kind: 'submission', id, safe: s.safe, txHash: null, simulationBlock: s.block, simulation: 'passed', gasLimit });
      await service.propose(servicePayload(this.manifest, c.role, c.transaction, signature));
      this.append({ kind: 'proposed', id, safe: s.safe, txHash: null });
    });
  }
  /** The adapter proves this exact self-call succeeded with zero effects and consumed the nonce. */
  resolveCancellation(id: Hex, input: unknown) {
    this.active(); const c = this.cancellations.get(id); requireThat(c?.status === 'pending', 'pending cancellation required');
    const r = executionSchema.parse(input); requireThat(r.status === 'success', 'successful cancellation required');
    this.executionKey(c, r);
    const target = this.cancellationTarget(c.replaces);
    this.resolve(target.id, { ...r, status: 'cancelled' });
  }
  private closeCancellations(id: Hex, executedHash: Hex) {
    for (const c of this.cancellations.values()) if (c.replaces === id && c.status === 'pending') {
      c.status = c.id === executedHash ? 'success' : 'cancelled';
    }
  }
  private executionKey(p: Proposal | CancellationProposal, r: z.output<typeof executionSchema>) {
    requireThat(r.chainId === p.snapshot.chainId && r.safe === p.snapshot.safe, 'wrong execution chain/Safe');
    requireThat(r.nonceAfter !== undefined && r.nonceAfter > r.nonce, 'canonical nonce consumption proof required');
    const key = `${r.chainId}:${r.txHash}:${r.logIndex}`;
    requireThat(r.nonce === p.transaction.nonce && !this.resolutions.has(key), 'nonce/receipt mismatch or duplicate');
    requireThat(r.status === 'cancelled' ? r.safeTxHash !== p.id : r.safeTxHash === p.id, 'wrong Safe execution hash');
    return key;
  }
  private resolution(id: Hex, input: unknown) {
    const p = this.proposals.get(id); requireThat(p?.status === 'pending', 'proposal already resolved or unknown');
    const r = resolutionSchema.parse(input);
    const key = this.executionKey(p, r);
    if (r.status === 'success') {
      requireThat(r.amountIn === p.draft.amountIn, 'exact input effect not verified');
      requireThat(r.amountOut !== undefined && (p.draft.request.kind === 'sale' ? r.amountOut >= p.draft.minimumOut : r.amountOut === 0n), 'output minimum/effect not verified');
      if (p.draft.request.kind === 'burn') requireThat(r.supplyReduction === p.draft.amountIn, 'true FIT supply burn required');
      if (p.draft.request.kind === 'fund') requireThat(r.budgetFunded === p.draft.amountIn, 'BudgetFunded receipt required');
    } else {
      requireThat([r.amountIn, r.amountOut, r.supplyReduction, r.budgetFunded]
        .every(value => value === undefined || value === 0n), 'failed/cancelled batch must have zero atomic effects');
    }
    return { p, r, key };
  }
  /** Adapter proves finality, the Safe execution log identity, consumed nonce and exact effects. Unconsumed nonces stay pending. */
  resolve(id: Hex, input: unknown) { this.active(); const { r } = this.resolution(id, input); this.append({ kind: 'resolution', id, result: r }); }
  freeze(orphanedBlockHash: Hex) {
    hash.parse(orphanedBlockHash); this.append({ kind: 'orphan', blockHash: orphanedBlockHash });
  }
  private queuedSnapshot(fresh: Snapshot, nonce: bigint): Snapshot {
    requireThat(fresh.nonce <= nonce, 'Safe nonce already consumed; reconcile first');
    for (let n = fresh.nonce; n < nonce; n++) {
      requireThat([...this.proposals.values()]
        .some(p => p.status === 'pending' && p.snapshot.safe === fresh.safe && p.transaction.nonce === n), 'unreserved predecessor nonce');
    }
    return { ...fresh, nonce };
  }
  private apply(e: Record<string, unknown>) {
    requireThat(e.manifestHash === contentHash(this.manifest), 'journal manifest changed; owner reconciliation required');
    if (e.kind === 'manifest-migration') {
      this.active();
      requireThat(contentHash(manifestFromWire(e.previousManifest)) === contentHash(this.manifest), 'historical manifest mismatch');
      const next = validateMigration(this.manifest, manifestFromWire(e.nextManifest));
      requireThat(!this.manifestVersions.has(next.policyVersion), 'manifest version already used');
      this.currentManifest = next; this.manifestVersions.add(next.policyVersion);
    } else if (e.kind === 'cancellation') {
      const c = this.prepareCancellation(hash.parse(e.replaces), e.snapshot);
      requireThat(c.id === e.id && contentHash(c.transaction) === contentHash(e.transaction), 'cancellation journal changed');
      this.cancellations.set(c.id, c);
    } else if (e.kind === 'quarantine') {
      const l = quarantineSchema.parse(e.lot), reason = quarantineReasonSchema.parse(e.reason);
      const transferEvidence = transferEvidenceSchema.parse(e.transferEvidence);
      requireThat(l.chainId === this.manifest.chainId && l.safe === this.manifest.safes[l.role], 'wrong quarantine chain/Safe');
      const key = `${l.chainId}:${l.source.txHash}:${l.source.logIndex}`;
      if (!this.receipts.has(key)) this.quarantined.set(key, { lot: l, reason, ...(transferEvidence ? { transferEvidence } : {}) });
    } else if (e.kind === 'receipt') {
      const { l, key } = this.receipt(e.lot); this.quarantined.delete(key); this.receipts.add(key); this.lots.set(l.id, { lot: l, consumed: 0n, reserved: 0n });
    } else if (e.kind === 'proposal') {
      // Stored decimals are revalidated, never revived through Number.
      const s = snapshotFromWire(e.snapshot); const p = this.prepare(s, e.request, true);
      requireThat(p.id === e.id && contentHash(p.draft.calls) === contentHash(e.calls)
        && contentHash(p.transaction) === contentHash(e.transaction), 'proposal journal changed');
      present(this.lots.get(p.draft.source.id), 'missing source lot').reserved += p.draft.amountIn; this.proposals.set(p.id, p);
    } else if (e.kind === 'resolution') {
      const { p, r, key } = this.resolution(hash.parse(e.id), e.result);
      const state = present(this.lots.get(p.draft.source.id), 'missing source lot'); state.reserved -= p.draft.amountIn;
      if (r.status === 'success') {
        state.consumed += p.draft.amountIn;
        if (p.draft.request.kind === 'sale') {
          const output: ReceiptLot = { ...state.lot, id: `${p.id}:output`, asset: p.draft.outputAsset, amount: present(r.amountOut, 'missing output'),
            decimals: assetDecimals(this.manifest, p.draft.outputAsset),
            kind: 'proceeds',
            // Keep the origin event for attribution. Input asset/decimals remain on the separate input lot and parent sale draft.
            // The output id links to that proposal and its canonical execution resolution.
          };
          this.lots.set(output.id, { lot: output, consumed: 0n, reserved: 0n });
        }
      }
      this.usedNonces.add(this.nonceKey(p.snapshot)); this.resolutions.add(key); p.status = r.status;
      this.closeCancellations(p.id, r.safeTxHash);
    } else if (e.kind === 'executor-burn') {
      const event = this.executorBurn(e.event); this.receipts.add(event.key); this.aggregateExecutorBurned += event.e.supplyReduction;
    } else if (e.kind === 'orphan') this.frozen = true;
    else requireThat(e.kind === 'submission' || e.kind === 'proposed'
      || e.kind === 'runner-cycle' || e.kind === 'runner-reconciliation' || e.kind === 'runner-waiting', 'unknown bot journal event');
    if (e.kind === 'proposal' || e.kind === 'cancellation') {
      this.gasCharges.set(hash.parse(e.id), this.manifest.limits.transactionGas);
    }
  }
}

// snapshotSchema accepts only canonical decimal strings or bigint for raw counters, never JSON numeric money.
const snapshotFromWire = (input: unknown) => snapshotSchema.parse(input);
