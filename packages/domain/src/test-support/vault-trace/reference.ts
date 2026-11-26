/**
 * The TypeScript side of the differential harness (v2 T06; placeholder tickets stage 1): apply trace operations to the
 * reference ledger (`vault-ledger.ts`, `vault-math.ts`) and report every field that differs from a trace's expected
 * steps. Test-only.
 */
import { isDeepStrictEqual } from 'node:util';
import {
  accrueSlotStream,
  allReturnEnvelope,
  burnFit,
  claimSlotStream,
  conversionRate,
  createVaultLedger,
  deliverTickets,
  donateFitToEscrow,
  escrowObligation,
  escrowSurplus,
  ledgerTotals,
  openVaultGate,
  pickMisfits,
  quoteReturnPrincipal,
  quoteTake,
  quoteWithdrawPrincipal,
  releaseTickets,
  returnRevealedMisfits,
  revealMisfits,
  sendFitToVault,
  sendMisfitToVault,
  takeTickets,
  transferFit,
  transferMisfit,
  transferTicket,
  VaultRuleError,
  waiveHandBackFee,
  type ExactRatio,
  type VaultLedger,
} from '../../index';
import {
  groupCustody,
  ticketHolder,
  VAULT_HOLDER,
  type ConversionFeePolicy,
  type CustodyChanges,
  type QuoteOutcome,
  type TraceOp,
  type TraceOutcome,
  type TracePolicy,
  type TraceResult,
  type TraceState,
  type TraceStep,
  type VaultTrace,
} from './format';
import { identityTerms } from './identities';

export function ledgerFromAllocations(
  collectionSize: number,
  allocations: Readonly<Record<string, string>>,
  fees: ConversionFeePolicy,
): VaultLedger {
  const map = new Map(Object.entries(allocations).map(([account, value]) => [account, BigInt(value)] as const));
  return createVaultLedger({ allocations: map, collectionSize, fees });
}

/** The initial ledger of a trace: its `initial.balances` are the one-time issuance. */
export function initialLedger(trace: VaultTrace): VaultLedger {
  return ledgerFromAllocations(trace.collectionSize, trace.initial.balances, trace.policy.conversionFees);
}

const optionalBig = (value: string | undefined): bigint | undefined => (value === undefined ? undefined : BigInt(value));

function attempt(run: () => { ledger: VaultLedger; result: TraceResult }): { ledger: VaultLedger | null; outcome: TraceOutcome } {
  try {
    const { ledger, result } = run();
    return { ledger, outcome: { ok: result } };
  } catch (error) {
    if (error instanceof VaultRuleError) return { ledger: null, outcome: { error: error.code } };
    throw error;
  }
}

const charged = (principal: bigint, fee: bigint): TraceResult => ({ principal: principal.toString(), fee: fee.toString() });

/** Apply one operation. On a rule error the ledger is returned unchanged (the reference is immutable). */
export function applyTraceOp(
  ledger: VaultLedger,
  op: TraceOp,
  policy: TracePolicy,
): { readonly ledger: VaultLedger; readonly outcome: TraceOutcome } {
  const applied = attempt(() => {
    switch (op.op) {
      case 'take': {
        const r = takeTickets(ledger, { owner: op.owner, count: op.count, maxFit: optionalBig(op.maxFit) });
        return { ledger: r.ledger, result: { ...charged(r.principal, r.fee), ids: [...r.ids] } };
      }
      case 'release': {
        const r = releaseTickets(ledger, { owner: op.owner, ids: op.ids, minFit: optionalBig(op.minFit) });
        return { ledger: r.ledger, result: charged(r.principal, r.fee) };
      }
      case 'deliver':
        return { ledger: deliverTickets(ledger, { owner: op.owner, ids: op.ids }), result: {} };
      case 'openGate':
        return { ledger: openVaultGate(ledger), result: {} };
      case 'waiveHandBackFee':
        return { ledger: waiveHandBackFee(ledger), result: {} };
      case 'reveal':
        return { ledger: revealMisfits(ledger, op.ids), result: {} };
      case 'withdraw': {
        const r = pickMisfits(ledger, { owner: op.owner, ids: op.ids, maxFit: optionalBig(op.maxFit) });
        return { ledger: r.ledger, result: charged(r.principal, r.fee) };
      }
      case 'return': {
        const r = returnRevealedMisfits(ledger, { owner: op.owner, ids: op.ids, minFit: optionalBig(op.minFit) });
        return { ledger: r.ledger, result: charged(r.principal, r.fee) };
      }
      case 'transferTicket':
        return { ledger: transferTicket(ledger, op.from, op.to, op.id), result: {} };
      case 'transferMisfit':
        return { ledger: transferMisfit(ledger, op.from, op.to, op.id), result: {} };
      case 'transferFit':
        return { ledger: transferFit(ledger, op.from, op.to, BigInt(op.amount)), result: {} };
      case 'sendFitToVault': {
        const send = policy.unsolicitedFit === 'quote-neutral' ? sendFitToVault : donateFitToEscrow;
        return { ledger: send(ledger, op.from, BigInt(op.amount)), result: {} };
      }
      case 'sendMisfitToVault':
        return { ledger: sendMisfitToVault(ledger, op.from, op.id), result: {} };
      case 'burn':
        return { ledger: burnFit(ledger, op.owner, BigInt(op.amount)), result: {} };
      case 'allocateStream': {
        const r = accrueSlotStream(ledger, op.source, BigInt(op.budget));
        const a = r.allocation;
        return {
          ledger: r.ledger,
          result: { burned: a.burned.toString(), credited: a.credited.toString(), dust: a.dustRetainedBySource.toString() },
        };
      }
      case 'claim': {
        const r = claimSlotStream(ledger, op.owner);
        return { ledger: r.ledger, result: { paid: r.paid.toString() } };
      }
    }
  });
  return { ledger: applied.ledger ?? ledger, outcome: applied.outcome };
}

function quote(run: () => bigint): QuoteOutcome {
  try {
    return { ok: run().toString() };
  } catch (error) {
    if (error instanceof VaultRuleError) return { error: error.code };
    throw error;
  }
}

const exact = (value: ExactRatio) => ({ num: value.num.toString(), den: value.den.toString() });

/** Who holds each ID outside the vault: an account (a Misfit) or `ticket:<account>` (a reserved ID). */
function holders(ledger: VaultLedger): Map<number, string> {
  const out = new Map<number, string>(ledger.outside);
  for (const [id, holder] of ledger.tickets) out.set(id, ticketHolder(holder));
  return out;
}

/** Misfits whose holder differs between two ledgers, grouped by new holder. */
export function custodyChanges(before: VaultLedger | null, after: VaultLedger, accounts: readonly string[]): CustodyChanges {
  const changes: [number, string][] = [];
  if (before !== null) {
    const pre = holders(before);
    const post = holders(after);
    for (const [id, holder] of post) if (pre.get(id) !== holder) changes.push([id, holder]);
    for (const id of pre.keys()) if (!post.has(id)) changes.push([id, VAULT_HOLDER]);
  }
  return groupCustody(changes, accounts);
}

/** The full post-state of a ledger in trace form. `before` is the previous ledger (null for the initial state). */
export function ledgerState(ledger: VaultLedger, before: VaultLedger | null, accounts: readonly string[]): TraceState {
  const totals = ledgerTotals(ledger);
  const balances: Record<string, string> = {};
  const claimable: Record<string, string> = {};
  const nftCounts: Record<string, number> = {};
  const ticketCounts: Record<string, number> = {};
  const tickets = new Map<string, number>();
  for (const holder of ledger.tickets.values()) tickets.set(holder, (tickets.get(holder) ?? 0) + 1);
  let accountsTotal = 0n;
  for (const account of accounts) {
    const balance = ledger.balances.get(account) ?? 0n;
    balances[account] = balance.toString();
    claimable[account] = (ledger.claims.get(account) ?? 0n).toString();
    ticketCounts[account] = tickets.get(account) ?? 0;
    nftCounts[account] = (ledger.ownerCounts.get(account) ?? 0) - (ticketCounts[account] ?? 0);
  }
  for (const [account, balance] of ledger.balances) {
    if (!accounts.includes(account) && balance !== 0n) throw new Error(`FIT reached undeclared account ${account}`);
    accountsTotal += balance;
  }
  return {
    supply: ledger.supply.toString(),
    escrow: ledger.escrow.toString(),
    unsolicited: ledger.unsolicited.toString(),
    vaultFit: (ledger.escrow + ledger.unsolicited).toString(),
    active: (ledger.supply - ledger.escrow).toString(),
    inside: ledger.inventory.size,
    outside: ledger.collectionSize - ledger.inventory.size,
    hidden: ledger.hidden.size,
    tickets: ledger.tickets.size,
    gateOpen: ledger.gateOpen,
    revealed: ledger.revealed.size,
    burned: ledger.burned.toString(),
    claimsReserve: ledger.claimsReserve.toString(),
    balances,
    claimable,
    nftCounts,
    ticketCounts,
    custodyChanges: custodyChanges(before, ledger, accounts),
    quoteWithdraw1: quote(() => quoteWithdrawPrincipal(totals, 1n)),
    quoteReturn1: quote(() => quoteReturnPrincipal(totals, 1n)),
    quoteTake1: quote(() => quoteTake(totals, 1n, BigInt(ledger.hidden.size), ledger.fees).total),
    rate: exact(conversionRate(totals)),
    obligation: exact(escrowObligation(totals)),
    surplus: exact(escrowSurplus(totals)),
    envelope: exact(allReturnEnvelope(totals)),
    identities: identityTerms({
      supply: ledger.supply,
      escrow: ledger.escrow,
      unsolicited: ledger.unsolicited,
      collectionSize: totals.collectionSize,
      inside: totals.inside,
      accountsTotal,
      claimsReserve: ledger.claimsReserve,
      burned: ledger.burned,
    }),
  };
}

/** Outside Misfits grouped by owner (the `final.outside` form). */
export function outsideByOwner(ledger: VaultLedger, accounts: readonly string[]): CustodyChanges {
  return groupCustody(ledger.outside, accounts);
}

/** Reserved IDs grouped by ticket holder (the `final.tickets` form). */
export function ticketsByHolder(ledger: VaultLedger, accounts: readonly string[]): CustodyChanges {
  return groupCustody([...ledger.tickets].map(([id, holder]) => [id, ticketHolder(holder)] as const), accounts);
}

export interface ReplayResult {
  readonly initial: TraceState;
  readonly steps: readonly TraceStep[];
  readonly final: VaultTrace['final'];
}

/** Replay a trace's operations on a fresh reference ledger and return what the reference produces. */
export function replayOnReference(trace: VaultTrace): ReplayResult {
  let ledger = initialLedger(trace);
  const initial = ledgerState(ledger, null, trace.accounts);
  const steps: TraceStep[] = trace.steps.map(({ op }) => {
    const before = ledger;
    const applied = applyTraceOp(ledger, op, trace.policy);
    ledger = applied.ledger;
    return { op, outcome: applied.outcome, state: ledgerState(ledger, before, trace.accounts) };
  });
  return { initial, steps, final: { outside: outsideByOwner(ledger, trace.accounts), tickets: ticketsByHolder(ledger, trace.accounts) } };
}

export interface Mismatch {
  readonly trace: string;
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

function diffValues(trace: string, path: string, expected: unknown, actual: unknown, out: Mismatch[]): void {
  if (isDeepStrictEqual(expected, actual)) return;
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
  if (isObject(expected) && isObject(actual) && Array.isArray(expected) === Array.isArray(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) diffValues(trace, `${path}.${key}`, expected[key], actual[key], out);
    return;
  }
  out.push({ trace, path, expected, actual });
}

/** Every field where the reference replay differs from the trace (empty when they agree exactly). */
export function diffAgainstReference(trace: VaultTrace): Mismatch[] {
  const replay = replayOnReference(trace);
  const out: Mismatch[] = [];
  diffValues(trace.id, 'initial', trace.initial, replay.initial, out);
  if (replay.steps.length !== trace.steps.length) out.push({ trace: trace.id, path: 'steps.length', expected: trace.steps.length, actual: replay.steps.length });
  trace.steps.forEach((step, i) => {
    const actual = replay.steps[i];
    if (actual) {
      diffValues(trace.id, `steps.${i}.outcome`, step.outcome, actual.outcome, out);
      diffValues(trace.id, `steps.${i}.state`, step.state, actual.state, out);
    }
  });
  diffValues(trace.id, 'final', trace.final, replay.final, out);
  return out;
}
