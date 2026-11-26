/**
 * Trace builder and seeded random trace generator (v2 T06; placeholder tickets stage 1). Test-only.
 *
 * Expected outcomes and post-states come from the TypeScript reference (`reference.ts`); the same traces are then
 * replayed on the Python oracle and checked by the law checker, so the reference is never its own only witness.
 * Random operations are chosen from the current reference state: most are valid, and a steady share is deliberately
 * invalid (wrong owner, duplicate, foreign, hidden or unrevealed IDs, the last Misfit, too few hidden Misfits, the
 * closed gate, tight limits, dust-guard amounts, unfunded budgets, Misfits sent to the vault).
 */
import { hasLeftVault, ledgerTotals, quotePick, quoteReturnNet, quoteTake, quoteWithdrawPrincipal, quoteReturnPrincipal, type VaultLedger } from '../../index';
import { createPrng, type Prng } from '../prng';
import {
  policyFor,
  TRACE_SCHEMA,
  type ConversionFeePolicy,
  type TraceOp,
  type TraceOutcome,
  type TraceStep,
  type UnsolicitedFitPolicy,
  type VaultTrace,
} from './format';
import { applyTraceOp, ledgerFromAllocations, ledgerState, outsideByOwner, ticketsByHolder } from './reference';

export const GENERATOR = 'packages/domain/src/test-support/vault-trace (v2 T06, placeholder tickets stage 1) v2';
export const MAX_UINT256 = (1n << 256n) - 1n;
export const WAD = 10n ** 18n;

export interface TraceMeta {
  readonly id: string;
  readonly family: VaultTrace['family'];
  readonly name: string;
  readonly purpose: string;
  readonly acceptance: readonly string[];
  readonly seed: number | null;
  readonly policy: UnsolicitedFitPolicy;
  readonly fees: ConversionFeePolicy;
  readonly collectionSize: number;
  /** Initial issuance per account, in account order (zero is allowed). */
  readonly allocations: Readonly<Record<string, bigint>>;
}

export interface TraceBuilder {
  /** The reference ledger after the last applied step. */
  readonly ledger: () => VaultLedger;
  /** Apply and record one operation; returns its outcome. */
  readonly apply: (op: TraceOp) => TraceOutcome;
  /** Name the current state (after the last step; −1 before any step). */
  readonly mark: (name: string) => void;
}

export const seedHex = (seed: number): string => `0x${(seed >>> 0).toString(16)}`;

/** Run `script` against a fresh reference ledger and record every step as a trace. */
export function buildTrace(meta: TraceMeta, script: (builder: TraceBuilder) => void): VaultTrace {
  const accounts = Object.keys(meta.allocations);
  const allocations = Object.fromEntries(Object.entries(meta.allocations).map(([a, v]) => [a, v.toString()]));
  const policy = policyFor(meta.policy, meta.fees);
  let ledger = ledgerFromAllocations(meta.collectionSize, allocations, meta.fees);
  const initial = ledgerState(ledger, null, accounts);
  const steps: TraceStep[] = [];
  const checkpoints: Record<string, number> = {};
  script({
    ledger: () => ledger,
    apply: (op) => {
      const before = ledger;
      const applied = applyTraceOp(ledger, op, policy);
      ledger = applied.ledger;
      steps.push({ op, outcome: applied.outcome, state: ledgerState(ledger, before, accounts) });
      return applied.outcome;
    },
    mark: (name) => {
      checkpoints[name] = steps.length - 1;
    },
  });
  return {
    schema: TRACE_SCHEMA,
    id: meta.id,
    family: meta.family,
    name: meta.name,
    purpose: meta.purpose,
    acceptance: [...meta.acceptance],
    seed: meta.seed === null ? null : seedHex(meta.seed),
    generator: GENERATOR,
    policy,
    collectionSize: meta.collectionSize,
    initialSupply: initial.supply,
    accounts,
    checkpoints,
    initial,
    steps,
    final: { outside: outsideByOwner(ledger, accounts), tickets: ticketsByHolder(ledger, accounts) },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Small helpers shared with the scripted families.

export const idRange = (from: number, to: number): number[] => Array.from({ length: to - from }, (_, i) => from + i);
export const balanceOf = (ledger: VaultLedger, account: string): bigint => ledger.balances.get(account) ?? 0n;
export const insideIds = (ledger: VaultLedger): number[] => [...ledger.inventory].sort((a, b) => a - b);
export const hiddenIds = (ledger: VaultLedger): number[] => [...ledger.hidden].sort((a, b) => a - b);
export const shelfIds = (ledger: VaultLedger): number[] => insideIds(ledger).filter((id) => !ledger.hidden.has(id));
export const ownedIds = (ledger: VaultLedger, owner: string): number[] =>
  [...ledger.outside].filter(([, who]) => who === owner).map(([id]) => id).sort((a, b) => a - b);
export const ticketIds = (ledger: VaultLedger, holder: string): number[] =>
  [...ledger.tickets].filter(([, who]) => who === holder).map(([id]) => id).sort((a, b) => a - b);
export const unrevealedLeft = (ledger: VaultLedger): number[] =>
  idRange(0, ledger.collectionSize).filter((id) => hasLeftVault(ledger, id) && !ledger.revealed.has(id));
export const activeOf = (ledger: VaultLedger): bigint => ledger.supply - ledger.escrow;

/** Withdraw (principal) quote for k, or null when the reference refuses it. */
export function withdrawQuote(ledger: VaultLedger, k: number): bigint | null {
  try {
    return quoteWithdrawPrincipal(ledgerTotals(ledger), BigInt(k));
  } catch {
    return null;
  }
}

/** Return (principal) quote for k, or null when the reference refuses it. */
export function returnQuote(ledger: VaultLedger, k: number): bigint | null {
  try {
    return quoteReturnPrincipal(ledgerTotals(ledger), BigInt(k));
  } catch {
    return null;
  }
}

/** What k tickets cost (principal + draw fee), or null when refused. */
export function takeQuote(ledger: VaultLedger, k: number): bigint | null {
  try {
    return quoteTake(ledgerTotals(ledger), BigInt(k), BigInt(ledger.hidden.size), ledger.fees).total;
  } catch {
    return null;
  }
}

/** What a named pick of k costs (principal + 25%), or null when refused. */
export function pickQuote(ledger: VaultLedger, k: number): bigint | null {
  try {
    return quotePick(ledgerTotals(ledger), BigInt(k), ledger.fees).total;
  } catch {
    return null;
  }
}

/** What a return of k pays (principal − 5%), or null when refused. */
export function returnNetQuote(ledger: VaultLedger, k: number): bigint | null {
  try {
    return quoteReturnNet(ledgerTotals(ledger), BigInt(k), ledger.fees).net;
  } catch {
    return null;
  }
}

/** Uniform-ish bigint in [0, max]. */
export function below(prng: Prng, max: bigint): bigint {
  if (max <= 0n) return 0n;
  const digits = max.toString().length + 3;
  let text = '';
  for (let i = 0; i < digits; i += 1) text += String(prng.int(10));
  return BigInt(text) % (max + 1n);
}

export function shuffled<T>(prng: Prng, values: readonly T[]): T[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = prng.int(i + 1);
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Random traces.

export const RANDOM_ACCOUNTS = ['alice', 'bob', 'carol', 'fees', 'pool'] as const;

/**
 * Initial issuance regimes: about one raw FIT per Misfit (dust), odd raw amounts, 18-decimal amounts, one holder with
 * almost everything, 1bn FIT exactly (the working Misfits issuance, 1e27 raw), and S = 2^256 − 1 (VLT-12 stress).
 */
export type AllocationRegime = 'dust' | 'odd' | 'wad' | 'concentrated' | 'billion' | 'max-supply';
const REGIMES: readonly AllocationRegime[] = ['dust', 'odd', 'wad', 'concentrated'];

export function randomAllocations(prng: Prng, collectionSize: number, regime: AllocationRegime): Record<string, bigint> {
  const n = BigInt(collectionSize);
  const out: Record<string, bigint> = {};
  if (regime === 'billion' || regime === 'max-supply') {
    let rest = regime === 'billion' ? 10n ** 27n : MAX_UINT256;
    RANDOM_ACCOUNTS.forEach((account, i) => {
      const share = i === RANDOM_ACCOUNTS.length - 1 ? rest : account === 'alice' ? (rest * BigInt(50 + prng.int(45))) / 100n : below(prng, rest / 3n);
      out[account] = share;
      rest -= share;
    });
    return out;
  }
  for (const account of RANDOM_ACCOUNTS) {
    let value: bigint;
    if (regime === 'dust') value = below(prng, 3n * n);
    else if (regime === 'odd') value = below(prng, 10n ** BigInt(3 + prng.int(12)));
    else if (regime === 'wad') value = BigInt(prng.int(1_000_000)) * WAD + below(prng, WAD);
    else value = account === 'alice' ? below(prng, 10n ** BigInt(2 + prng.int(20))) : below(prng, n / 4n);
    out[account] = value;
  }
  out.fees = (out.fees ?? 0n) + n; // S ≥ N: at least one raw FIT per Misfit
  return out;
}

const pickAccount = (prng: Prng): string => prng.pick(RANDOM_ACCOUNTS);

/** Half the time the richest account, so conversions are usually funded. */
function pickPayer(prng: Prng, ledger: VaultLedger): string {
  if (prng.int(2) === 0) return pickAccount(prng);
  let best: string = RANDOM_ACCOUNTS[0];
  for (const account of RANDOM_ACCOUNTS) if (balanceOf(ledger, account) > balanceOf(ledger, best)) best = account;
  return best;
}

/** Mostly someone who owns an outside Misfit. */
function pickHolder(prng: Prng, ledger: VaultLedger): string {
  const holders = [...new Set(ledger.outside.values())];
  return holders.length > 0 && prng.int(5) !== 0 ? prng.pick(holders) : pickAccount(prng);
}

/** Mostly someone who holds a ticket. */
function pickTicketHolder(prng: Prng, ledger: VaultLedger): string {
  const holders = [...new Set(ledger.tickets.values())];
  return holders.length > 0 && prng.int(5) !== 0 ? prng.pick(holders) : pickAccount(prng);
}

function amountFrom(prng: Prng, balance: bigint): bigint {
  const roll = prng.int(10);
  if (roll === 0) return balance + 1n + below(prng, 1000n); // unfunded
  if (roll === 1) return balance;
  if (roll === 2) return 0n;
  return below(prng, balance);
}

/** A foreign ID (not in the collection). */
const foreignId = (prng: Prng, ledger: VaultLedger): number => ledger.collectionSize + prng.int(7);

/** Any collection ID of a given kind, or a foreign one when there is none. */
const anyOf = (prng: Prng, ledger: VaultLedger, ids: readonly number[]): number => (ids.length > 0 ? prng.pick(ids) : foreignId(prng, ledger));

/** One of the usual list flaws: an extra ID of another kind, a duplicate or a foreign ID. */
function flawList(prng: Prng, ledger: VaultLedger, ids: number[], wrongKinds: readonly (readonly number[])[]): number[] {
  const flaw = prng.int(9);
  if (flaw === 0 && wrongKinds.length > 0) ids.push(anyOf(prng, ledger, prng.pick(wrongKinds)));
  else if (flaw === 1 && ids.length > 0) ids.push(ids[0] as number);
  else if (flaw === 2) ids.push(foreignId(prng, ledger));
  return ids;
}

function randomTake(prng: Prng, ledger: VaultLedger, maxBatch: number): TraceOp {
  const n = ledger.inventory.size;
  const h = ledger.hidden.size;
  const roll = prng.int(14);
  let count: number;
  if (roll === 0) count = 0;
  else if (roll === 1) count = n;
  else if (roll === 2) count = h + 1;
  else if (roll < 11) count = 1 + prng.int(Math.max(1, Math.min(h, 3)));
  else count = 1 + prng.int(Math.max(1, Math.min(n - 1, h, maxBatch)));
  const owner = pickPayer(prng, ledger);
  if (prng.int(4) !== 0) return { op: 'take', owner, count };
  const quote = takeQuote(ledger, count);
  return { op: 'take', owner, count, maxFit: (quote === null ? 0n : quote - BigInt(prng.int(2))).toString() };
}

function randomRelease(prng: Prng, ledger: VaultLedger): TraceOp {
  const owner = pickTicketHolder(prng, ledger);
  const held = ticketIds(ledger, owner);
  const ids = shuffled(prng, held).slice(0, held.length === 0 ? 0 : 1 + prng.int(Math.min(held.length, 4)));
  flawList(prng, ledger, ids, [[...ledger.tickets.keys()], [...ledger.outside.keys()], hiddenIds(ledger)]);
  if (prng.int(4) !== 0) return { op: 'release', owner, ids };
  const q = ids.length > 0 && returnQuote(ledger, ids.length) !== null ? returnQuote(ledger, ids.length) : null;
  const fee = q === null || ledger.gateOpen ? 0n : (q * ledger.fees.returnBps + 9_999n) / 10_000n;
  return { op: 'release', owner, ids, minFit: (q === null ? 1n : q - fee + BigInt(prng.int(2))).toString() };
}

function randomDeliver(prng: Prng, ledger: VaultLedger): TraceOp {
  const owner = pickTicketHolder(prng, ledger);
  const held = ticketIds(ledger, owner);
  const ids = shuffled(prng, held).slice(0, held.length === 0 ? 0 : 1 + prng.int(Math.min(held.length, 3)));
  return { op: 'deliver', owner, ids: flawList(prng, ledger, ids, [[...ledger.tickets.keys()], hiddenIds(ledger)]) };
}

function randomReveal(prng: Prng, ledger: VaultLedger): TraceOp {
  const candidates = unrevealedLeft(ledger);
  const ids = shuffled(prng, candidates).slice(0, candidates.length === 0 ? 0 : 1 + prng.int(Math.min(candidates.length, 3)));
  return { op: 'reveal', ids: flawList(prng, ledger, ids, [hiddenIds(ledger), [...ledger.revealed], [...ledger.tickets.keys()]]) };
}

function randomPick(prng: Prng, ledger: VaultLedger): TraceOp {
  const shelf = shelfIds(ledger);
  const revealed = shelf.filter((id) => ledger.revealed.has(id));
  const pool = revealed.length > 0 && prng.int(4) !== 0 ? revealed : shelf;
  const ids = shuffled(prng, pool).slice(0, pool.length === 0 ? 0 : 1 + prng.int(Math.min(pool.length, 3)));
  flawList(prng, ledger, ids, [hiddenIds(ledger), [...ledger.outside.keys()], [...ledger.tickets.keys()], shelf.filter((id) => !ledger.revealed.has(id))]);
  const owner = pickPayer(prng, ledger);
  if (prng.int(4) !== 0) return { op: 'withdraw', owner, ids };
  const quote = pickQuote(ledger, ids.length);
  return { op: 'withdraw', owner, ids, maxFit: (quote === null ? 0n : quote - BigInt(prng.int(2))).toString() };
}

function randomReturn(prng: Prng, ledger: VaultLedger): TraceOp {
  const owner = pickHolder(prng, ledger);
  const owned = ownedIds(ledger, owner);
  const revealed = owned.filter((id) => ledger.revealed.has(id));
  const pool = revealed.length > 0 && prng.int(5) !== 0 ? revealed : owned;
  const ids = shuffled(prng, pool).slice(0, pool.length === 0 ? 0 : 1 + prng.int(pool.length));
  flawList(prng, ledger, ids, [insideIds(ledger), [...ledger.outside.keys()], [...ledger.tickets.keys()]]);
  if (prng.int(4) !== 0) return { op: 'return', owner, ids };
  const quote = returnNetQuote(ledger, Math.max(1, ids.length));
  return { op: 'return', owner, ids, minFit: (quote === null ? 1n : quote + BigInt(prng.int(2))).toString() };
}

/** Amount whose effect lands at or just past the dust guard (A − amount ≥ n). */
const dustEdge = (prng: Prng, ledger: VaultLedger): bigint => {
  const edge = activeOf(ledger) - BigInt(ledger.inventory.size) + BigInt(prng.int(2));
  return edge < 0n ? 0n : edge;
};

/**
 * The ticket-side operations, each falling back most of the time to the step that makes it possible when the state
 * has nothing for it (no ticket to deliver, nothing to reveal, no revealed Misfit to return, an empty shelf), so the
 * corpus reaches every success often while the empty lists still show up.
 */
function randomTicketSide(prng: Prng, ledger: VaultLedger, maxBatch: number, kind: number): TraceOp {
  const fallback = prng.int(4) !== 0;
  const revealedOutside = [...ledger.outside.keys()].some((id) => ledger.revealed.has(id));
  const revealedShelf = shelfIds(ledger).some((id) => ledger.revealed.has(id));
  if (kind === 0) return randomRelease(prng, ledger);
  if (kind === 1) {
    if (ledger.tickets.size === 0 && fallback) return randomTake(prng, ledger, maxBatch);
    return randomDeliver(prng, ledger);
  }
  if (kind === 2) {
    if (unrevealedLeft(ledger).length === 0 && fallback) return ledger.tickets.size > 0 ? randomDeliver(prng, ledger) : randomTake(prng, ledger, maxBatch);
    return randomReveal(prng, ledger);
  }
  if (kind === 3) {
    if (!revealedShelf && fallback) return revealedOutside ? randomReturn(prng, ledger) : randomReveal(prng, ledger);
    return randomPick(prng, ledger);
  }
  if (!revealedOutside && fallback) return unrevealedLeft(ledger).length > 0 ? randomReveal(prng, ledger) : randomDeliver(prng, ledger);
  return randomReturn(prng, ledger);
}

/** One operation chosen from the current reference state. */
export function randomOp(prng: Prng, ledger: VaultLedger, policy: UnsolicitedFitPolicy, maxBatch: number): TraceOp {
  const kind = prng.int(30);
  if (kind < 5) return randomTake(prng, ledger, maxBatch);
  if (kind < 7) return randomTicketSide(prng, ledger, maxBatch, 0);
  if (kind < 10) return randomTicketSide(prng, ledger, maxBatch, 1);
  if (kind < 11) return ledger.gateOpen && prng.int(3) !== 0 ? randomTake(prng, ledger, maxBatch) : { op: 'openGate' };
  if (kind < 13) return randomTicketSide(prng, ledger, maxBatch, 2);
  if (kind < 15) return randomTicketSide(prng, ledger, maxBatch, 3);
  if (kind < 18) return randomTicketSide(prng, ledger, maxBatch, 4);
  if (kind < 19) {
    const tickets = [...ledger.tickets];
    const [id, holder] = tickets.length > 0 ? prng.pick(tickets) : [anyOf(prng, ledger, hiddenIds(ledger)), 'alice'];
    return { op: 'transferTicket', from: prng.int(6) === 0 ? pickAccount(prng) : holder, to: pickAccount(prng), id };
  }
  if (kind < 20) {
    const outside = [...ledger.outside];
    const [id, owner] = outside.length > 0 ? prng.pick(outside) : [anyOf(prng, ledger, [...ledger.tickets.keys(), ...insideIds(ledger)]), 'alice'];
    return { op: 'transferMisfit', from: prng.int(6) === 0 ? pickAccount(prng) : owner, to: pickAccount(prng), id };
  }
  if (kind < 22) {
    const from = pickAccount(prng);
    return { op: 'transferFit', from, to: pickAccount(prng), amount: amountFrom(prng, balanceOf(ledger, from)).toString() };
  }
  if (kind < 23) {
    const from = pickAccount(prng);
    const edge = policy === 'raw-balance' && prng.int(4) === 0;
    const amount = edge ? dustEdge(prng, ledger) : amountFrom(prng, balanceOf(ledger, from) / BigInt(1 + prng.int(8)));
    return { op: 'sendFitToVault', from, amount: amount.toString() };
  }
  if (kind < 24) {
    const outside = [...ledger.outside];
    if (outside.length > 0 && prng.int(4) !== 0) {
      const [id, owner] = prng.pick(outside);
      return { op: 'sendMisfitToVault', from: owner, id };
    }
    const tickets = [...ledger.tickets];
    if (tickets.length > 0 && prng.int(2) === 0) {
      const [id, holder] = prng.pick(tickets);
      return { op: 'sendMisfitToVault', from: holder, id };
    }
    const id = prng.int(2) === 0 ? prng.pick([...ledger.inventory]) : foreignId(prng, ledger);
    return { op: 'sendMisfitToVault', from: pickAccount(prng), id };
  }
  if (kind < 26) {
    const owner = prng.int(3) === 0 ? pickAccount(prng) : 'fees';
    if (prng.int(4) === 0) return { op: 'burn', owner, amount: dustEdge(prng, ledger).toString() };
    return { op: 'burn', owner, amount: amountFrom(prng, balanceOf(ledger, owner) / BigInt(1 + prng.int(50))).toString() };
  }
  if (kind < 29) {
    const source = prng.int(4) === 0 ? pickAccount(prng) : 'fees';
    if (prng.int(4) === 0) {
      // Budget whose inside share lands at or just past the dust guard.
      const totals = ledgerTotals(ledger);
      const target = dustEdge(prng, ledger);
      const budget = (target * totals.collectionSize + totals.inside - 1n) / totals.inside;
      return { op: 'allocateStream', source, budget: budget.toString() };
    }
    return { op: 'allocateStream', source, budget: amountFrom(prng, balanceOf(ledger, source)).toString() };
  }
  const withClaims = [...ledger.claims].filter(([, value]) => value > 0n).map(([owner]) => owner);
  return { op: 'claim', owner: withClaims.length > 0 && prng.int(3) !== 0 ? prng.pick(withClaims) : pickAccount(prng) };
}

export interface RandomTraceOptions {
  readonly id: string;
  readonly seed: number;
  readonly policy: UnsolicitedFitPolicy;
  readonly fees: ConversionFeePolicy;
  readonly collectionSize: number;
  readonly ops: number;
  readonly regime?: AllocationRegime;
  /** Largest ordinary ticket batch (keeps N = 10,000 traces small). */
  readonly maxBatch?: number;
}

/** A seeded random trace. The same options always give the same trace (its own PRNG starts from `seed`). */
export function randomTrace(options: RandomTraceOptions): VaultTrace {
  const prng = createPrng(options.seed);
  const regime = options.regime ?? prng.pick(REGIMES);
  const allocations = randomAllocations(prng, options.collectionSize, regime);
  const maxBatch = options.maxBatch ?? options.collectionSize;
  return buildTrace(
    {
      id: options.id,
      family: 'random',
      name: `random/${regime}`,
      purpose: `Seeded random mix of every operation (N = ${options.collectionSize}, ${regime} issuance, ${options.policy} unsolicited FIT, fees ${options.fees}).`,
      acceptance: ['VLT-01', 'VLT-02', 'VLT-03', 'VLT-06', 'VLT-08', 'GOV-05', 'SEL-06'],
      seed: options.seed,
      policy: options.policy,
      fees: options.fees,
      collectionSize: options.collectionSize,
      allocations,
    },
    (b) => {
      for (let i = 0; i < options.ops; i += 1) b.apply(randomOp(prng, b.ledger(), options.policy, maxBatch));
    },
  );
}
