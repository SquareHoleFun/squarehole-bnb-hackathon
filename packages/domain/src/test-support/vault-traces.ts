/**
 * Seeded random vault traces for the v2 T05 differential and property tests. Each op is chosen from the current
 * TypeScript ledger state, so most are valid, and a steady share is deliberately invalid (wrong owner, duplicate IDs,
 * the last Misfit, tight slippage limits, dust-guard burns, unfunded budgets). Test-only.
 *
 * Wire format (JSON, raw integers as decimal strings) is what `vault_oracle_driver.py` reads.
 */
import {
  accrueSlotStream,
  burnFit,
  claimSlotStream,
  conversionRate,
  createVaultLedger,
  escrowSurplus,
  ledgerTotals,
  quoteReturnPrincipal,
  quoteWithdrawPrincipal,
  returnMisfits,
  sendFitToVault,
  transferFit,
  transferMisfit,
  VaultRuleError,
  withdrawMisfits,
  type VaultLedger,
} from '../index';
import type { Prng } from './prng';

/** The oracle-side account that stands for the F23 unsolicited bucket (see vault_oracle_driver.py). */
export const UNSOLICITED = '__vault_unsolicited__';
export const TRACE_ACCOUNTS = ['alice', 'bob', 'carol', 'fees'] as const;

export type TraceOp =
  | { readonly op: 'withdraw'; readonly owner: string; readonly count: number; readonly maxFit?: string; readonly ids?: readonly number[] }
  | { readonly op: 'return'; readonly owner: string; readonly ids: readonly number[]; readonly minFit?: string }
  | { readonly op: 'transferMisfit'; readonly from: string; readonly to: string; readonly id: number }
  | { readonly op: 'transferFit'; readonly from: string; readonly to: string; readonly amount: string }
  | { readonly op: 'sendFitToVault'; readonly from: string; readonly amount: string }
  | { readonly op: 'burn'; readonly owner: string; readonly amount: string }
  | { readonly op: 'accrue'; readonly source: string; readonly budget: string }
  | { readonly op: 'claim'; readonly owner: string };

export interface Trace {
  readonly collectionSize: number;
  readonly allocations: Readonly<Record<string, string>>;
  readonly ops: readonly TraceOp[];
}

export type Outcome = { readonly ok: Readonly<Record<string, unknown>> } | { readonly error: string };
export type QuoteOutcome = { readonly ok: string } | { readonly error: string };

export interface TraceState {
  readonly supply: string;
  readonly escrow: string;
  readonly active: string;
  readonly inside: number;
  readonly outside: number;
  readonly rate: { readonly num: string; readonly den: string };
  readonly surplus: { readonly num: string; readonly den: string };
  readonly burned: string;
  readonly claimsReserve: string;
  readonly balances: Readonly<Record<string, string>>;
  readonly claims: Readonly<Record<string, string>>;
  readonly outsideOwners: Readonly<Record<string, string>>;
  readonly quoteWithdraw1: QuoteOutcome;
  readonly quoteReturn1: QuoteOutcome;
}

export interface TraceStep {
  readonly outcome: Outcome;
  readonly state: TraceState;
}

function attempt(run: () => Readonly<Record<string, unknown>>): Outcome {
  try {
    return { ok: run() };
  } catch (error) {
    if (error instanceof VaultRuleError) return { error: error.code };
    throw error;
  }
}

function quoteOutcome(run: () => bigint): QuoteOutcome {
  try {
    return { ok: run().toString() };
  } catch (error) {
    if (error instanceof VaultRuleError) return { error: error.code };
    throw error;
  }
}

/** The driver's `state(...)` for a TypeScript ledger. The unsolicited bucket appears as the UNSOLICITED account. */
export function traceState(ledger: VaultLedger): TraceState {
  const totals = ledgerTotals(ledger);
  const rate = conversionRate(totals);
  const surplus = escrowSurplus(totals);
  const balances: Record<string, string> = {};
  for (const [account, value] of ledger.balances) if (value !== 0n) balances[account] = value.toString();
  if (ledger.unsolicited !== 0n) balances[UNSOLICITED] = ledger.unsolicited.toString();
  return {
    supply: ledger.supply.toString(),
    escrow: ledger.escrow.toString(),
    active: (ledger.supply - ledger.escrow).toString(),
    inside: ledger.inventory.size,
    outside: ledger.outside.size,
    rate: { num: rate.num.toString(), den: rate.den.toString() },
    surplus: { num: surplus.num.toString(), den: surplus.den.toString() },
    burned: ledger.burned.toString(),
    claimsReserve: ledger.claimsReserve.toString(),
    balances,
    claims: Object.fromEntries([...ledger.claims].map(([owner, value]) => [owner, value.toString()])),
    outsideOwners: Object.fromEntries([...ledger.outside].sort(([a], [b]) => a - b).map(([id, owner]) => [String(id), owner])),
    quoteWithdraw1: quoteOutcome(() => quoteWithdrawPrincipal(totals, 1n)),
    quoteReturn1: quoteOutcome(() => quoteReturnPrincipal(totals, 1n)),
  };
}

export function createTraceLedger(trace: Trace): VaultLedger {
  const allocations = new Map(Object.entries(trace.allocations).map(([account, value]) => [account, BigInt(value)] as const));
  return createVaultLedger({ allocations, collectionSize: trace.collectionSize });
}

const optionalBig = (value: string | undefined): bigint | undefined => (value === undefined ? undefined : BigInt(value));

/** Apply one wire op to a TypeScript ledger. Returns the next ledger (unchanged on a rule error) and the outcome. */
export function applyTraceOp(ledger: VaultLedger, op: TraceOp): { readonly ledger: VaultLedger; readonly outcome: Outcome } {
  let next = ledger;
  const outcome = attempt(() => {
    switch (op.op) {
      case 'withdraw': {
        const result = withdrawMisfits(ledger, { owner: op.owner, count: op.count, maxFit: optionalBig(op.maxFit), ids: op.ids });
        next = result.ledger;
        return { ids: [...result.ids], principal: result.principal.toString() };
      }
      case 'return': {
        const result = returnMisfits(ledger, { owner: op.owner, ids: op.ids, minFit: optionalBig(op.minFit) });
        next = result.ledger;
        return { principal: result.principal.toString() };
      }
      case 'transferMisfit':
        next = transferMisfit(ledger, op.from, op.to, op.id);
        return {};
      case 'transferFit':
        next = transferFit(ledger, op.from, op.to, BigInt(op.amount));
        return {};
      case 'sendFitToVault':
        next = sendFitToVault(ledger, op.from, BigInt(op.amount));
        return {};
      case 'burn':
        next = burnFit(ledger, op.owner, BigInt(op.amount));
        return {};
      case 'accrue': {
        const result = accrueSlotStream(ledger, op.source, BigInt(op.budget));
        next = result.ledger;
        const a = result.allocation;
        return { budget: a.budget.toString(), burned: a.burned.toString(), credited: a.credited.toString(), dust: a.dustRetainedBySource.toString() };
      }
      case 'claim': {
        const result = claimSlotStream(ledger, op.owner);
        next = result.ledger;
        return { paid: result.paid.toString() };
      }
    }
  });
  return { ledger: next, outcome };
}

/** Uniform-ish bigint in [0, max]. */
function below(prng: Prng, max: bigint): bigint {
  if (max <= 0n) return 0n;
  const digits = max.toString().length + 3;
  let text = '';
  for (let i = 0; i < digits; i += 1) text += String(prng.int(10));
  return BigInt(text) % (max + 1n);
}

function shuffled<T>(prng: Prng, values: readonly T[]): T[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = prng.int(i + 1);
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

function allocationsFor(prng: Prng, collectionSize: number): Record<string, string> {
  const regime = prng.int(4);
  const n = BigInt(collectionSize);
  const out: Record<string, string> = {};
  for (const account of TRACE_ACCOUNTS) {
    let value: bigint;
    if (regime === 0) value = below(prng, 3n * n); // dust regime: about one raw unit per Misfit
    else if (regime === 1) value = below(prng, 10n ** BigInt(3 + prng.int(12))); // odd raw amounts
    else if (regime === 2) value = BigInt(prng.int(1_000_000)) * 10n ** 18n + below(prng, 10n ** 18n); // 18 decimals
    else value = account === 'fees' ? below(prng, 10n ** BigInt(2 + prng.int(20))) : below(prng, n / 4n); // concentrated
    out[account] = value.toString();
  }
  out.fees = (BigInt(out.fees ?? '0') + n).toString(); // guarantees S ≥ N
  return out;
}

const pickAccount = (prng: Prng): string => prng.pick(TRACE_ACCOUNTS);

/** Half the time the richest account, so conversions are usually funded. */
function pickPayer(prng: Prng, ledger: VaultLedger): string {
  if (prng.int(2) === 0) return pickAccount(prng);
  let best: string = TRACE_ACCOUNTS[0];
  for (const account of TRACE_ACCOUNTS) if ((ledger.balances.get(account) ?? 0n) > (ledger.balances.get(best) ?? 0n)) best = account;
  return best;
}

/** Mostly someone who owns an outside Misfit. */
function pickHolder(prng: Prng, ledger: VaultLedger): string {
  const holders = [...ledger.ownerCounts.keys()];
  return holders.length > 0 && prng.int(5) !== 0 ? prng.pick(holders) : pickAccount(prng);
}

function amountFrom(prng: Prng, balance: bigint): bigint {
  const roll = prng.int(10);
  if (roll === 0) return balance + 1n + below(prng, 1000n); // unfunded
  if (roll === 1) return balance;
  return below(prng, balance);
}

function withdrawOp(prng: Prng, ledger: VaultLedger): TraceOp {
  const n = ledger.inventory.size;
  const roll = prng.int(12);
  const most = Math.max(1, Math.min(n - 1, roll < 9 ? 3 : 3000));
  const count = roll === 0 ? 0 : roll === 1 ? n : roll === 2 ? n + 1 : 1 + prng.int(most);
  const owner = pickPayer(prng, ledger);
  const op: { op: 'withdraw'; owner: string; count: number; maxFit?: string; ids?: number[] } = { op: 'withdraw', owner, count };
  if (prng.int(4) === 0) {
    try {
      const quote = quoteWithdrawPrincipal(ledgerTotals(ledger), BigInt(count));
      op.maxFit = (quote - BigInt(prng.int(2))).toString();
    } catch {
      op.maxFit = '0';
    }
  }
  if (prng.int(3) === 0) {
    const inside = shuffled(prng, [...ledger.inventory]).slice(0, count);
    const flaw = prng.int(6);
    if (flaw === 0 && ledger.outside.size > 0) inside[0] = prng.pick([...ledger.outside.keys()]);
    else if (flaw === 1 && inside.length > 1) inside[1] = inside[0] as number;
    else if (flaw === 2) inside.push(ledger.collectionSize + 5);
    op.ids = inside;
  }
  return op;
}

function returnOp(prng: Prng, ledger: VaultLedger): TraceOp {
  const owner = pickHolder(prng, ledger);
  const owned = [...ledger.outside].filter(([, who]) => who === owner).map(([id]) => id);
  const ids = shuffled(prng, owned).slice(0, owned.length === 0 ? 0 : 1 + prng.int(owned.length));
  const flaw = prng.int(8);
  if (flaw === 0) ids.push(prng.pick([...ledger.inventory]));
  else if (flaw === 1 && ids.length > 0) ids.push(ids[0] as number);
  else if (flaw === 2 && ledger.outside.size > 0) ids.push(prng.pick([...ledger.outside.keys()]));
  const op: { op: 'return'; owner: string; ids: number[]; minFit?: string } = { op: 'return', owner, ids };
  if (prng.int(4) === 0) {
    try {
      const quote = quoteReturnPrincipal(ledgerTotals(ledger), BigInt(Math.max(1, ids.length)));
      op.minFit = (quote + BigInt(prng.int(2))).toString();
    } catch {
      op.minFit = '1';
    }
  }
  return op;
}

function burnOp(prng: Prng, ledger: VaultLedger): TraceOp {
  const owner = prng.int(3) === 0 ? pickAccount(prng) : 'fees';
  const balance = ledger.balances.get(owner) ?? 0n;
  if (prng.int(4) === 0) {
    const totals = ledgerTotals(ledger);
    const edge = totals.supply - totals.escrow - totals.inside + BigInt(prng.int(2)); // dust-guard boundary
    return { op: 'burn', owner, amount: (edge < 0n ? 0n : edge).toString() };
  }
  return { op: 'burn', owner, amount: amountFrom(prng, balance / BigInt(1 + prng.int(50))).toString() };
}

function accrueOp(prng: Prng, ledger: VaultLedger): TraceOp {
  const source = prng.int(4) === 0 ? pickAccount(prng) : 'fees';
  if (prng.int(4) === 0) {
    // Budget whose burned inside share lands at or just past the dust-guard boundary (burn ≥ A − n).
    const totals = ledgerTotals(ledger);
    const target = totals.supply - totals.escrow - totals.inside + BigInt(prng.int(2));
    const budget = (target * totals.collectionSize + totals.inside - 1n) / totals.inside;
    return { op: 'accrue', source, budget: budget.toString() };
  }
  return { op: 'accrue', source, budget: amountFrom(prng, ledger.balances.get(source) ?? 0n).toString() };
}

/** One op chosen from the current ledger state. */
export function nextTraceOp(prng: Prng, ledger: VaultLedger): TraceOp {
  const kind = prng.int(20);
  if (kind < 5) return withdrawOp(prng, ledger);
  if (kind < 9) return returnOp(prng, ledger);
  if (kind < 11) {
    const outside = [...ledger.outside];
    const [id, owner] = outside.length > 0 ? prng.pick(outside) : [0, 'alice'];
    return { op: 'transferMisfit', from: prng.int(6) === 0 ? pickAccount(prng) : owner, to: pickAccount(prng), id };
  }
  if (kind < 13) {
    const from = pickAccount(prng);
    return { op: 'transferFit', from, to: pickAccount(prng), amount: amountFrom(prng, ledger.balances.get(from) ?? 0n).toString() };
  }
  if (kind < 15) {
    const from = pickAccount(prng);
    return { op: 'sendFitToVault', from, amount: amountFrom(prng, ledger.balances.get(from) ?? 0n).toString() };
  }
  if (kind < 17) return burnOp(prng, ledger);
  if (kind < 19) return accrueOp(prng, ledger);
  return { op: 'claim', owner: pickAccount(prng) };
}

/** A random trace plus the TypeScript steps it produced. */
export function generateTrace(prng: Prng, options: { readonly collectionSize: number; readonly ops: number }): {
  readonly trace: Trace;
  readonly steps: readonly TraceStep[];
} {
  const allocations = allocationsFor(prng, options.collectionSize);
  const base: Trace = { collectionSize: options.collectionSize, allocations, ops: [] };
  let ledger = createTraceLedger(base);
  const ops: TraceOp[] = [];
  const steps: TraceStep[] = [];
  for (let i = 0; i < options.ops; i += 1) {
    const op = nextTraceOp(prng, ledger);
    const applied = applyTraceOp(ledger, op);
    ledger = applied.ledger;
    ops.push(op);
    steps.push({ outcome: applied.outcome, state: traceState(ledger) });
  }
  return { trace: { ...base, ops }, steps };
}
