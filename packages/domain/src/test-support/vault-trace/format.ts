/**
 * Differential trace format, `squarehole.vault-trace/v2` (v2 T06; placeholder tickets stage 1, F36 a). Test-only;
 * never imported by runtime code.
 *
 * A trace is a list of vault operations, each with the outcome and the complete post-state that the TypeScript
 * reference (`vault-ledger.ts`) produced. The same file is replayed against the TypeScript reference
 * (`reference.ts`), checked against the docs/03 identities and transition laws (`laws.ts`), replayed against the
 * preserved Python oracle (`scripts/vault-trace-oracle-diff.py`, on a scratch copy) and exported for the Solidity
 * tests (`forge.ts`).
 *
 * v2 against v1: hidden Misfits leave only through tickets (`take`, then `deliver` after `openGate`); `withdraw` is the
 * named pick of revealed shelf Misfits; `return` needs the reveal; the flat fees of F23 C3 apply under the policy
 * `flat-f23` (`none` keeps the v2 docs/03 examples fee-free). A reserved ID is held by the custody holder
 * `ticket:<account>` until it is delivered. v1 lives in git history (`git show 3baefb8:packages/domain/src/__traces__`).
 *
 * Wire rules: every FIT amount, and every product of amounts, is a decimal string of a non-negative integer in raw
 * units (no Number, no float). Misfit IDs and counts are JSON integers (IDs are 0 … N−1; larger IDs are foreign on
 * purpose). The custody holder `vault` means "inside the vault"; no account may use that name.
 */
import { z } from 'zod';

export const TRACE_SCHEMA = 'squarehole.vault-trace/v2';
/** Custody holder for a Misfit inside the vault. */
export const VAULT_HOLDER = 'vault';
/** Custody holder prefix for a reserved ID (a ticket not yet delivered). */
export const TICKET_PREFIX = 'ticket:';
export const ticketHolder = (account: string): string => `${TICKET_PREFIX}${account}`;

/**
 * How FIT sent to the vault outside a conversion is treated (v2-G06).
 * - `quote-neutral`: F23 as recorded and as T05 built it. The FIT stays in the vault as permanent surplus D outside
 *   the principal E, so no quote moves. Default.
 * - `raw-balance`: ADR-0014 draft (under review) and the oracle's literal `donate_fit_to_escrow`. The FIT joins E, so
 *   r falls by amount/n, like a burn.
 */
export type UnsolicitedFitPolicy = 'quote-neutral' | 'raw-balance';
/** `none`: the v2 docs/03 examples (fee-free); `flat-f23`: draw 1%, named pick 25%, return 5% (F23 C3). */
export type ConversionFeePolicy = 'none' | 'flat-f23';

export interface TracePolicy {
  /** F23 C2 / v2-G04: the last Misfit cannot be withdrawn (the oracle's `block_last`). */
  readonly lastMisfit: 'block-last';
  readonly unsolicitedFit: UnsolicitedFitPolicy;
  /** v2-G06 (F24 d): a Misfit sent to the vault outside a return is refused. */
  readonly unsolicitedMisfit: 'refuse';
  readonly conversionFees: ConversionFeePolicy;
  /** Hidden Misfits leave only through tickets; named picks take revealed shelf Misfits (Fable R-09, R-14). */
  readonly selection: 'tickets';
}

export const policyFor = (unsolicitedFit: UnsolicitedFitPolicy, conversionFees: ConversionFeePolicy): TracePolicy => ({
  lastMisfit: 'block-last',
  unsolicitedFit,
  unsolicitedMisfit: 'refuse',
  conversionFees,
  selection: 'tickets',
});

export type TraceOp =
  /** k tickets (placeholders during the curve, draws after): reserves the lowest unreserved hidden IDs. */
  | { readonly op: 'take'; readonly owner: string; readonly count: number; readonly maxFit?: string }
  /** Hand back (gate closed, 5%) or cancel (gate open, no fee) the owner's tickets on these reserved IDs. */
  | { readonly op: 'release'; readonly owner: string; readonly ids: readonly number[]; readonly minFit?: string }
  /** After graduation: the Misfits behind the owner's tickets leave the vault. */
  | { readonly op: 'deliver'; readonly owner: string; readonly ids: readonly number[] }
  | { readonly op: 'openGate' }
  /**
   * The coordinator's one-way hand-back fee waiver (F38 4 hook; stage-1 review). Not a state field: a release after
   * it carries fee 0 while the gate is closed.
   */
  | { readonly op: 'waiveHandBackFee' }
  /** The collection's reveals (exit trigger), all or nothing. */
  | { readonly op: 'reveal'; readonly ids: readonly number[] }
  /** Named pick of revealed shelf Misfits (+25%). */
  | { readonly op: 'withdraw'; readonly owner: string; readonly ids: readonly number[]; readonly maxFit?: string }
  /** Return of revealed Misfits (−5%). */
  | { readonly op: 'return'; readonly owner: string; readonly ids: readonly number[]; readonly minFit?: string }
  | { readonly op: 'transferTicket'; readonly from: string; readonly to: string; readonly id: number }
  | { readonly op: 'transferMisfit'; readonly from: string; readonly to: string; readonly id: number }
  | { readonly op: 'transferFit'; readonly from: string; readonly to: string; readonly amount: string }
  | { readonly op: 'sendFitToVault'; readonly from: string; readonly amount: string }
  | { readonly op: 'sendMisfitToVault'; readonly from: string; readonly id: number }
  | { readonly op: 'burn'; readonly owner: string; readonly amount: string }
  | { readonly op: 'allocateStream'; readonly source: string; readonly budget: string }
  | { readonly op: 'claim'; readonly owner: string };

export type TraceOpKind = TraceOp['op'];

/** Operation kinds in their fixed export order (the forge `opKind` code is the index; v1's nine keep their codes). */
export const OP_KINDS: readonly TraceOpKind[] = [
  'withdraw',
  'return',
  'transferMisfit',
  'transferFit',
  'sendFitToVault',
  'sendMisfitToVault',
  'burn',
  'allocateStream',
  'claim',
  'take',
  'release',
  'deliver',
  'openGate',
  'reveal',
  'transferTicket',
  'waiveHandBackFee',
];

/** What a successful operation reports. Only the fields that belong to the op kind are present. */
export interface TraceResult {
  /** take, withdraw: FIT locked into E; release, return: FIT released from E. */
  readonly principal?: string;
  /** take, withdraw, release, return: the flat fee burned ("0" when none). */
  readonly fee?: string;
  /** take: the reserved IDs (labels). */
  readonly ids?: readonly number[];
  /** allocateStream: inside share burned, outside shares credited, rounding dust left with the source. */
  readonly burned?: string;
  readonly credited?: string;
  readonly dust?: string;
  /** claim: FIT paid to the owner. */
  readonly paid?: string;
}

export type TraceOutcome = { readonly ok: TraceResult } | { readonly error: string };

/** Holder → Misfit IDs (ascending). Holders appear in account order, then their ticket holders, then `vault`. */
export type CustodyChanges = Readonly<Record<string, readonly number[]>>;

/** The declared custody holders of a trace, in their fixed order. */
export const custodyHolders = (accounts: readonly string[]): string[] => [...accounts, ...accounts.map(ticketHolder), VAULT_HOLDER];

/** Group (id, holder) pairs by holder, holders in `custodyHolders` order, IDs ascending. */
export function groupCustody(pairs: Iterable<readonly [number, string]>, accounts: readonly string[]): Record<string, number[]> {
  const byHolder = new Map<string, number[]>();
  for (const [id, holder] of pairs) {
    const ids = byHolder.get(holder);
    if (ids) ids.push(id);
    else byHolder.set(holder, [id]);
  }
  const out: Record<string, number[]> = {};
  for (const holder of custodyHolders(accounts)) {
    const ids = byHolder.get(holder);
    if (ids) out[holder] = [...ids].sort((a, b) => a - b);
    byHolder.delete(holder);
  }
  if (byHolder.size > 0) throw new Error(`custody holder not declared: ${[...byHolder.keys()].join(', ')}`);
  return out;
}

/** The (id, holder) pairs of a custody record, sorted by id. */
export function custodyPairs(changes: CustodyChanges): [number, string][] {
  const pairs: [number, string][] = [];
  for (const [holder, ids] of Object.entries(changes)) for (const id of ids) pairs.push([id, holder]);
  return pairs.sort(([a], [b]) => a - b);
}
export type QuoteOutcome = { readonly ok: string } | { readonly error: string };

/** Exact non-negative rational in lowest terms, den > 0. */
export interface ExactRational {
  readonly num: string;
  readonly den: string;
}

/**
 * The docs/03 identity terms, as exact integers (they can exceed 2^256; that is why they are strings).
 * - E·n ≥ m·A (escrow solvency, VLT-08); K·n = E·n − m·A ≥ 0 (K = E − L, K ≥ 0). m counts tickets.
 * - S·n = K·n + N·A (S = K + N·r).
 * - held = Σ every FIT holding, vault buckets included = S; issued = S + true burns = initial issuance (GOV-05).
 * - (E + D)·n ≥ m·A: the vault's FIT balance covers the outside Misfits and tickets ("more than enough", F23 C2).
 */
export interface TraceIdentities {
  readonly En: string;
  readonly mA: string;
  readonly Kn: string;
  readonly Sn: string;
  readonly NA: string;
  readonly held: string;
  readonly issued: string;
  readonly vaultFitN: string;
}

export interface TraceState {
  /** S: FIT totalSupply. */
  readonly supply: string;
  /** E: FIT in the conversion escrow that quotes subtract (principal; plus donations under `raw-balance`). */
  readonly escrow: string;
  /** D: FIT in the vault outside E (unsolicited sends under `quote-neutral`; always 0 under `raw-balance`). */
  readonly unsolicited: string;
  /** E + D: the vault's actual FIT balance. */
  readonly vaultFit: string;
  /** A = S − E. */
  readonly active: string;
  /** n. */
  readonly inside: number;
  /** m = N − n (outside Misfits and tickets). */
  readonly outside: number;
  /** h: never out of the vault and not reserved. */
  readonly hidden: number;
  /** t: tickets pending. */
  readonly tickets: number;
  /** The phase gate (graduation). */
  readonly gateOpen: boolean;
  /** Revealed Misfits (count). */
  readonly revealed: number;
  /** Cumulative true burns (fees included). */
  readonly burned: string;
  /** FIT credited by the slot stream and not yet claimed. */
  readonly claimsReserve: string;
  /** Every trace account, in `accounts` order. */
  readonly balances: Readonly<Record<string, string>>;
  readonly claimable: Readonly<Record<string, string>>;
  /** Outside Misfits held (the collection's balance). */
  readonly nftCounts: Readonly<Record<string, number>>;
  /** Tickets held (placeholders and draws not yet delivered). */
  readonly ticketCounts: Readonly<Record<string, number>>;
  /** Misfits whose holder changed in this step: holder (an account, a ticket holder or `vault`) → IDs, ascending. */
  readonly custodyChanges: CustodyChanges;
  /** Pre-operation principal quote for one Misfit in each direction, or the refusal code. */
  readonly quoteWithdraw1: QuoteOutcome;
  readonly quoteReturn1: QuoteOutcome;
  /** One ticket: principal plus the draw fee, or the refusal code (last_misfit, no_hidden). */
  readonly quoteTake1: QuoteOutcome;
  /** r = A/n, L = m·r, K = E − L, U = N·r (exact). */
  readonly rate: ExactRational;
  readonly obligation: ExactRational;
  readonly surplus: ExactRational;
  readonly envelope: ExactRational;
  readonly identities: TraceIdentities;
}

export interface TraceStep {
  readonly op: TraceOp;
  readonly outcome: TraceOutcome;
  readonly state: TraceState;
}

export interface VaultTrace {
  readonly schema: typeof TRACE_SCHEMA;
  readonly id: string;
  /** `example`, `adversarial` or `random`. */
  readonly family: 'example' | 'adversarial' | 'random';
  /** Generator family name, e.g. `round-trip` or `EX02`. */
  readonly name: string;
  readonly purpose: string;
  /** v2 acceptance IDs this trace exercises (tests/acceptance.json). */
  readonly acceptance: readonly string[];
  /** Hex seed of the generator run, or null for a fixed script. */
  readonly seed: string | null;
  readonly generator: string;
  readonly policy: TracePolicy;
  /** N. */
  readonly collectionSize: number;
  readonly initialSupply: string;
  /** Ordinary FIT accounts, in a fixed order (the forge export indexes them). */
  readonly accounts: readonly string[];
  /** Named states for the worked examples: name → step index, −1 for the initial state. */
  readonly checkpoints: Readonly<Record<string, number>>;
  readonly initial: TraceState;
  readonly steps: readonly TraceStep[];
  /** After the last step: outside Misfits owner → IDs, reserved IDs holder → IDs (every other ID is inside). */
  readonly final: { readonly outside: CustodyChanges; readonly tickets: CustodyChanges };
}

// ---------------------------------------------------------------------------------------------------------------
// Strict parser for files on disk.

const rawString = z.string().regex(/^(0|[1-9][0-9]*)$/, 'raw amount must be a decimal string of a non-negative integer');
const tokenId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const accountName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'account names are short lowercase words');

const opSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('take'), owner: accountName, count, maxFit: rawString.optional() }),
  z.strictObject({ op: z.literal('release'), owner: accountName, ids: z.array(tokenId), minFit: rawString.optional() }),
  z.strictObject({ op: z.literal('deliver'), owner: accountName, ids: z.array(tokenId) }),
  z.strictObject({ op: z.literal('openGate') }),
  z.strictObject({ op: z.literal('waiveHandBackFee') }),
  z.strictObject({ op: z.literal('reveal'), ids: z.array(tokenId) }),
  z.strictObject({ op: z.literal('withdraw'), owner: accountName, ids: z.array(tokenId), maxFit: rawString.optional() }),
  z.strictObject({ op: z.literal('return'), owner: accountName, ids: z.array(tokenId), minFit: rawString.optional() }),
  z.strictObject({ op: z.literal('transferTicket'), from: accountName, to: accountName, id: tokenId }),
  z.strictObject({ op: z.literal('transferMisfit'), from: accountName, to: accountName, id: tokenId }),
  z.strictObject({ op: z.literal('transferFit'), from: accountName, to: accountName, amount: rawString }),
  z.strictObject({ op: z.literal('sendFitToVault'), from: accountName, amount: rawString }),
  z.strictObject({ op: z.literal('sendMisfitToVault'), from: accountName, id: tokenId }),
  z.strictObject({ op: z.literal('burn'), owner: accountName, amount: rawString }),
  z.strictObject({ op: z.literal('allocateStream'), source: accountName, budget: rawString }),
  z.strictObject({ op: z.literal('claim'), owner: accountName }),
]);

const resultSchema = z.strictObject({
  principal: rawString.optional(),
  fee: rawString.optional(),
  ids: z.array(tokenId).optional(),
  burned: rawString.optional(),
  credited: rawString.optional(),
  dust: rawString.optional(),
  paid: rawString.optional(),
});
const errorCode = z.string().regex(/^[a-z_]+$/);
const outcomeSchema = z.union([z.strictObject({ ok: resultSchema }), z.strictObject({ error: errorCode })]);
const quoteSchema = z.union([z.strictObject({ ok: rawString }), z.strictObject({ error: errorCode })]);
const rationalSchema = z.strictObject({ num: rawString, den: rawString });

const stateSchema = z.strictObject({
  supply: rawString,
  escrow: rawString,
  unsolicited: rawString,
  vaultFit: rawString,
  active: rawString,
  inside: count,
  outside: count,
  hidden: count,
  tickets: count,
  gateOpen: z.boolean(),
  revealed: count,
  burned: rawString,
  claimsReserve: rawString,
  balances: z.record(accountName, rawString),
  claimable: z.record(accountName, rawString),
  nftCounts: z.record(accountName, count),
  ticketCounts: z.record(accountName, count),
  custodyChanges: z.record(z.string(), z.array(tokenId).min(1)),
  quoteWithdraw1: quoteSchema,
  quoteReturn1: quoteSchema,
  quoteTake1: quoteSchema,
  rate: rationalSchema,
  obligation: rationalSchema,
  surplus: rationalSchema,
  envelope: rationalSchema,
  identities: z.strictObject({
    En: rawString,
    mA: rawString,
    Kn: rawString,
    Sn: rawString,
    NA: rawString,
    held: rawString,
    issued: rawString,
    vaultFitN: rawString,
  }),
});

const traceSchema = z.strictObject({
  schema: z.literal(TRACE_SCHEMA),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  family: z.enum(['example', 'adversarial', 'random']),
  name: z.string().min(1),
  purpose: z.string().min(1),
  acceptance: z.array(z.string().regex(/^[A-Z]{3}-\d{2}$/)),
  seed: z.string().regex(/^0x[0-9a-f]+$/).nullable(),
  generator: z.string().min(1),
  policy: z.strictObject({
    lastMisfit: z.literal('block-last'),
    unsolicitedFit: z.enum(['quote-neutral', 'raw-balance']),
    unsolicitedMisfit: z.literal('refuse'),
    conversionFees: z.enum(['none', 'flat-f23']),
    selection: z.literal('tickets'),
  }),
  collectionSize: z.number().int().min(1).max(1_000_000),
  initialSupply: rawString,
  accounts: z.array(accountName).min(1),
  checkpoints: z.record(z.string(), z.number().int().min(-1)),
  initial: stateSchema,
  steps: z.array(z.strictObject({ op: opSchema, outcome: outcomeSchema, state: stateSchema })),
  final: z.strictObject({
    outside: z.record(accountName, z.array(tokenId).min(1)),
    tickets: z.record(z.string(), z.array(tokenId).min(1)),
  }),
});

function opAccounts(op: TraceOp): string[] {
  switch (op.op) {
    case 'take':
    case 'release':
    case 'deliver':
    case 'withdraw':
    case 'return':
    case 'burn':
    case 'claim':
      return [op.owner];
    case 'transferTicket':
    case 'transferMisfit':
    case 'transferFit':
      return [op.from, op.to];
    case 'sendFitToVault':
    case 'sendMisfitToVault':
      return [op.from];
    case 'allocateStream':
      return [op.source];
    case 'openGate':
    case 'waiveHandBackFee':
    case 'reveal':
      return [];
  }
}

/** Holders in the fixed order, each ID once, IDs ascending. */
function checkCustody(changes: CustodyChanges, holders: readonly string[], where: string): void {
  const keys = Object.keys(changes);
  const order = keys.map((key) => holders.indexOf(key));
  if (order.some((i) => i < 0) || order.some((i, k) => k > 0 && i <= (order[k - 1] as number))) {
    throw new Error(`${where}: holders must be declared and in account order`);
  }
  const seen = new Set<number>();
  for (const ids of Object.values(changes)) {
    ids.forEach((id, k) => {
      if (seen.has(id) || (k > 0 && id <= (ids[k - 1] as number))) throw new Error(`${where}: IDs must be ascending and unique`);
      seen.add(id);
    });
  }
}

/**
 * Parse a trace file strictly: unknown fields, floats, negative or non-decimal amounts, undeclared accounts, a
 * reserved account name or per-state maps that do not list exactly the declared accounts are all rejected.
 */
export function parseVaultTrace(input: unknown): VaultTrace {
  const trace = traceSchema.parse(input) as VaultTrace;
  const declared = new Set(trace.accounts);
  if (declared.size !== trace.accounts.length) throw new Error(`${trace.id}: duplicate account`);
  if (declared.has(VAULT_HOLDER)) throw new Error(`${trace.id}: "${VAULT_HOLDER}" is reserved for custody`);
  const sameKeys = (record: Readonly<Record<string, unknown>>, where: string): void => {
    const keys = Object.keys(record);
    if (keys.length !== trace.accounts.length || keys.some((key, i) => key !== trace.accounts[i])) {
      throw new Error(`${trace.id} ${where}: must list exactly the declared accounts, in order`);
    }
  };
  const holders = custodyHolders(trace.accounts);
  const states = [trace.initial, ...trace.steps.map((step) => step.state)];
  states.forEach((state, i) => {
    const where = i === 0 ? 'initial' : `step ${i - 1}`;
    sameKeys(state.balances, `${where} balances`);
    sameKeys(state.claimable, `${where} claimable`);
    sameKeys(state.nftCounts, `${where} nftCounts`);
    sameKeys(state.ticketCounts, `${where} ticketCounts`);
    checkCustody(state.custodyChanges, holders, `${trace.id} ${where} custodyChanges`);
  });
  checkCustody(trace.final.outside, trace.accounts, `${trace.id} final.outside`);
  checkCustody(trace.final.tickets, trace.accounts.map(ticketHolder), `${trace.id} final.tickets`);
  trace.steps.forEach((step, i) => {
    for (const account of opAccounts(step.op)) {
      if (!declared.has(account)) throw new Error(`${trace.id} step ${i}: undeclared account ${account}`);
    }
  });
  for (const [name, index] of Object.entries(trace.checkpoints)) {
    if (index >= trace.steps.length) throw new Error(`${trace.id}: checkpoint ${name} is past the last step`);
  }
  return trace;
}

/**
 * Deterministic text form: top-level fields one per line, one step per line, so a changed step is a one-line diff.
 * Key order is the construction order of the objects, which the generator fixes.
 */
export function serializeVaultTrace(trace: VaultTrace): string {
  const lines: string[] = [];
  const entries = Object.entries(trace);
  entries.forEach(([key, value], i) => {
    const comma = i < entries.length - 1 ? ',' : '';
    if (key === 'steps') {
      const steps = value as readonly TraceStep[];
      if (steps.length === 0) {
        lines.push(`  "steps": []${comma}`);
        return;
      }
      lines.push('  "steps": [');
      steps.forEach((step, s) => lines.push(`    ${JSON.stringify(step)}${s < steps.length - 1 ? ',' : ''}`));
      lines.push(`  ]${comma}`);
      return;
    }
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`);
  });
  return `{\n${lines.join('\n')}\n}\n`;
}
