import { zeroAddress, type Hex } from 'viem';
import { Bot, type Proposal } from './bot';
import { buildAction } from './builders';
import { reconcileAsset } from './reconcile';
import { safeTransaction } from './safe';
import { requireChain } from './config';
import { requireThat, roleSchema } from './schema';
import type { ChainObservation } from './chain';
import type { QuoteSource } from './quotes';
import type { SafeService } from './service';
import type { Action, ChainReader, DigestSigner, Role } from './types';

export interface ReconciledExecution { kind: 'action' | 'cancellation'; id: Hex; result: Record<string, unknown> }
/** The FIT Safe's reader. It has no platform Safe, cap evidence or platform receipts (F164 D2, F160). */
export interface RunnerReader extends ChainReader {
  observe(): Promise<ChainObservation>;
  reconcile(bot: Bot, observation: ChainObservation): Promise<ReconciledExecution[]>;
}
export interface CycleOptions {
  bot: Bot; reader: RunnerReader; quotes: QuoteSource; service: SafeService; dryRun: boolean;
  allowMainnet?: boolean; signer?: DigestSigner; cancel?: Hex[];
}
export async function runCycle(options: CycleOptions) {
  const { bot, reader, quotes, service, dryRun, signer } = options, m = bot.manifest;
  requireChain(m.chainId, options.allowMainnet);
  requireThat(dryRun || signer, 'managed signer required to propose');
  bot.requireRunnerMode(dryRun);
  const observation = await reader.observe();
  const waiting: { id: string; reason: string }[] = [];
  const defer = (id: string, reason: string) => { const row = { id, reason }; waiting.push(row); bot.audit('runner-waiting', row); };
  const reconciled = await reader.reconcile(bot, observation);
  for (const r of reconciled) {
    if (r.kind === 'action') bot.resolve(r.id, r.result);
    else bot.resolveCancellation(r.id, r.result);
  }
  for (const lot of observation.lots) if (!bot.hasReceipt(lot)) bot.receive(lot);
  for (const { lot, reason, transferEvidence } of observation.quarantined ?? []) {
    bot.quarantine(lot, reason, transferEvidence); defer(lot.id, reason);
  }
  const state = bot.inspect();
  for (const role of roleSchema.options) {
    const s = observation.snapshots[role];
    for (const [asset, closing] of Object.entries(s.balances)) {
      const liability = state.lots.filter(v => v.lot.role === role && v.lot.asset === asset).reduce((n, v) => n + v.lot.amount - v.consumed, 0n);
      requireThat(liability >= 0n && liability <= closing, 'unbacked receipt inventory; reconcile before planning');
      // Unlabelled balances are visible and excluded from spendable lots, never assigned to a box.
      const inventory = state.lots.filter(v => v.lot.role === role && v.lot.asset === asset);
      const receipts = inventory.filter(v => v.lot.kind === 'fee').reduce((n, v) => n + v.lot.amount, 0n);
      const swapOutputs = inventory.filter(v => v.lot.kind === 'proceeds').reduce((n, v) => n + v.lot.amount, 0n);
      const consumedInputs = inventory.reduce((n, v) => n + v.consumed, 0n);
      const transfers = receipts + swapOutputs - consumedInputs - liability;
      const reserved = inventory.reduce((n, v) => n + v.reserved, 0n);
      const accounting = { opening: 0n, receipts, swapOutputs, consumedInputs, transfers, reserved, liabilities: liability,
        returns: 0n, funds: 0n, burns: 0n, unrelatedIn: closing - liability, unrelatedOut: 0n, closing };
      reconcileAsset(accounting);
      bot.audit('runner-reconciliation', { block: s.block, safe: s.safe, asset, accounting, unallocated: closing - liability });
    }
  }
  const cancelled = new Set<Hex>();
  for (const id of options.cancel ?? []) {
    const target = state.proposals.find(p => p.id === id && p.status === 'pending');
    requireThat(target, 'unknown pending cancellation target');
    const existing = state.cancellations.find(c => c.replaces === id && c.status === 'pending');
    const c = existing ?? bot.planCancellation(id, observation.snapshots[target.draft.role]);
    requireThat(await reader.simulate(c.snapshot.safe, c.transaction, c.snapshot.block, m.limits.transactionGas), 'cancellation simulation failed');
    if (!dryRun) await bot.proposeCancellation(c.id, reader, service, signer);
    cancelled.add(id);
  }
  const blocked = new Set<Role>();
  const nonces = new Map<Role, bigint>();
  for (const role of roleSchema.options) {
    const s = observation.snapshots[role], rows = await service.listPending(s.safe);
    const pending = bot.inspect().proposals.filter(p => p.status === 'pending' && p.snapshot.safe === s.safe);
    const known = new Set([...pending.map(p => p.id), ...bot.inspect().cancellations.filter(c => c.status === 'pending').map(c => c.id)]);
    if (rows.some(row => row.nonce >= s.nonce && !known.has(row.hash))) {
      blocked.add(role); defer(role, 'foreign-pending-proposal'); continue;
    }
    if (pending.some(p => p.transaction.nonce < s.nonce)) throw new Error('consumed Safe nonce lacks verified execution');
    let nonce = s.nonce;
    for (const p of pending.sort((a, b) => a.transaction.nonce < b.transaction.nonce ? -1 : 1)) {
      requireThat(p.transaction.nonce === nonce, 'pending Safe nonce gap'); nonce++;
      if (dryRun || cancelled.has(p.id) || rows.some(row => row.hash === p.id)) continue;
      try { await bot.propose(p.id, reader, service, signer); }
      catch { defer(p.id, 'pending-revalidation-or-submission-failed'); blocked.add(role); }
    }
    // Never schedule behind a cancellation or an expired quote that needs explicit replacement.
    if (bot.inspect().cancellations.some(c => c.status === 'pending' && c.role === role)
      || pending.some(p => p.draft.request.kind === 'sale' && p.draft.request.quote.deadline <= s.block.timestamp)) {
      blocked.add(role); defer(role, 'pending-cancellation-or-expired-quote');
    }
    nonces.set(role, nonce);
  }
  const proposals: Proposal[] = [];
  for (const { lot } of bot.inspect().lots) {
    if (blocked.has(lot.role)) continue;
    const available = bot.available(lot.id); if (available === 0n) continue;
    const s = { ...observation.snapshots[lot.role], nonce: nonces.get(lot.role) ?? 0n };
    let action: Action;
    if (lot.asset === zeroAddress || lot.asset === m.box0.fit) {
      if (!s.box0.graduated || s.box0.failed) { defer(lot.id, 'box-0-not-graduated'); continue; }
      action = { kind: lot.asset === zeroAddress ? 'fund' : 'burn', lotId: lot.id, amount: available };
    } else {
      const output = zeroAddress;
      const route = m.routes.find(r => r.tokenIn === lot.asset && r.tokenOut === output);
      if (!route) { defer(lot.id, 'unsupported-route'); continue; }
      const amount = available < route.maxInput ? available : route.maxInput;
      try { action = { kind: 'sale', lotId: lot.id, amount, routeId: route.id, quote: await quotes.quote(route.id, amount, s.block) }; }
      catch { defer(lot.id, 'quote-unavailable'); continue; }
    }
    let p: Proposal;
    try {
      const draft = buildAction(m, s, { ...lot, amount: available }, action);
      const tx = safeTransaction(m, s, draft);
      requireThat(await reader.simulate(s.safe, tx, s.block, m.limits.transactionGas), 'simulation refused');
      p = bot.plan(s, action);
    } catch { defer(lot.id, 'build-budget-or-simulation-refused'); continue; }
    nonces.set(lot.role, s.nonce + 1n); proposals.push(p);
    if (!dryRun) {
      try { await bot.propose(p.id, reader, service, signer); }
      catch { defer(p.id, 'submission-unconfirmed'); blocked.add(lot.role); }
    }
  }
  bot.audit('runner-cycle', { dryRun, block: observation.snapshots.fit.block, proposals: proposals.map(p => p.id),
    reconciled: reconciled.map(r => r.id), credits: observation.credits, ...(observation.executor ? { executor: observation.executor } : {}), waiting });
  return { dryRun, proposals, cancellations: bot.inspect().cancellations.filter(c => c.status === 'pending'), waiting,
    block: observation.snapshots.fit.block };
}
