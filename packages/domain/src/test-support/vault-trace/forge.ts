/**
 * Column export of the vault traces for Foundry (`squarehole.vault-trace.forge/v2`; placeholder tickets stage 1).
 * Test-only.
 *
 * Foundry reads JSON with `vm.readFile` + `vm.parseJson*`, one path per call, so the export is column-oriented (one
 * array per field, like the existing `test/vectors/*.json`) and every value fits a Solidity type: amounts are
 * decimal strings ≤ 2^256 − 1 (read with `vm.parseUint`), indexes and counts are JSON integers. Products that can pass
 * 2^256 (the identity terms E·n, m·A …) are not exported; Solidity recomputes them with 512-bit arithmetic. K is
 * exported as `floor(K)` and the remainder of E·n − m·A over n, both below 2^256.
 *
 * Per-account columns are flattened step-major: value of account i after step s is at `s·numAccounts + i`. Variable-
 * length lists (op IDs, custody changes) are flattened with `…Start`/`…Count` offsets; a take's IDs are the IDs it
 * reserved (empty when refused). A custody holder index below `numAccounts` is that account, equal to `numAccounts`
 * the vault, and `numAccounts + 1 + i` account i's tickets.
 */
import { custodyPairs, OP_KINDS, TICKET_PREFIX, VAULT_HOLDER, type QuoteOutcome, type TraceOp, type VaultTrace } from './format';
import { feeBps } from './identities';

export const FORGE_SCHEMA = 'squarehole.vault-trace.forge/v2';
export const FORGE_INDEX_SCHEMA = 'squarehole.vault-trace.forge-index/v2';

/** Refusal codes in export order; index 0 means success (v1's codes keep their indexes). */
export const ERROR_CODES = [
  '',
  'invalid_quantity',
  'last_misfit',
  'max_fit_exceeded',
  'min_fit_not_met',
  'insufficient_fit',
  'ineligible_ids',
  'invalid_id_list',
  'not_owner',
  'return_below_unit',
  'escrow_insolvent',
  'dust_guard',
  'stream_not_funded',
  'unsolicited_misfit',
  'invalid_amount',
  'reserved_account',
  'invalid_totals',
  'gate_closed',
  'gate_already_open',
  'no_hidden',
  'hidden_misfit',
  'not_revealed',
  'not_revealable',
  'already_revealed',
  'fee_already_waived',
] as const;

export const LIMIT_NONE = 0;
export const LIMIT_MAX_FIT = 1;
export const LIMIT_MIN_FIT = 2;

function errorIndex(code: string): number {
  const index = (ERROR_CODES as readonly string[]).indexOf(code);
  if (index <= 0) throw new Error(`no export code for refusal "${code}"`);
  return index;
}

function quoteColumns(quote: QuoteOutcome): [string, number] {
  return 'ok' in quote ? [quote.ok, 0] : ['0', errorIndex(quote.error)];
}

interface OpColumns {
  a: string | null;
  b: string | null;
  amount: string;
  tokenId: number;
  count: number;
  limitKind: number;
  limit: string;
  ids: readonly number[];
}

function opColumns(op: TraceOp, reserved: readonly number[]): OpColumns {
  const base = { a: null, b: null, amount: '0', tokenId: 0, count: 0, limitKind: LIMIT_NONE, limit: '0', ids: [] as readonly number[] };
  const max = (maxFit: string | undefined) => (maxFit === undefined ? {} : { limitKind: LIMIT_MAX_FIT, limit: maxFit });
  const min = (minFit: string | undefined) => (minFit === undefined ? {} : { limitKind: LIMIT_MIN_FIT, limit: minFit });
  switch (op.op) {
    case 'take':
      return { ...base, a: op.owner, count: op.count, ids: reserved, ...max(op.maxFit) };
    case 'release':
      return { ...base, a: op.owner, ids: op.ids, ...min(op.minFit) };
    case 'deliver':
      return { ...base, a: op.owner, ids: op.ids };
    case 'openGate':
    case 'waiveHandBackFee':
      return base;
    case 'reveal':
      return { ...base, ids: op.ids };
    case 'withdraw':
      return { ...base, a: op.owner, ids: op.ids, ...max(op.maxFit) };
    case 'return':
      return { ...base, a: op.owner, ids: op.ids, ...min(op.minFit) };
    case 'transferTicket':
    case 'transferMisfit':
      return { ...base, a: op.from, b: op.to, tokenId: op.id };
    case 'transferFit':
      return { ...base, a: op.from, b: op.to, amount: op.amount };
    case 'sendFitToVault':
      return { ...base, a: op.from, amount: op.amount };
    case 'sendMisfitToVault':
      return { ...base, a: op.from, tokenId: op.id };
    case 'burn':
      return { ...base, a: op.owner, amount: op.amount };
    case 'allocateStream':
      return { ...base, a: op.source, amount: op.budget };
    case 'claim':
      return { ...base, a: op.owner };
  }
}

/** The forge export of one trace, as a plain JSON-ready object (key order fixed). */
export function toForgeExport(trace: VaultTrace, canonicalPath: string): Record<string, unknown> {
  const index = new Map(trace.accounts.map((account, i) => [account, i] as const));
  const k = trace.accounts.length;
  const at = (account: string): number => {
    const i = index.get(account);
    if (i === undefined) throw new Error(`${trace.id}: unknown account ${account}`);
    return i;
  };
  const holderIndex = (holder: string): number => {
    if (holder === VAULT_HOLDER) return k;
    if (holder.startsWith(TICKET_PREFIX)) return k + 1 + at(holder.slice(TICKET_PREFIX.length));
    return at(holder);
  };
  const columns = {
    opKind: [] as number[],
    opA: [] as number[],
    opB: [] as number[],
    opAmount: [] as string[],
    opTokenId: [] as number[],
    opCount: [] as number[],
    opLimitKind: [] as number[],
    opLimit: [] as string[],
    opIdsStart: [] as number[],
    opIdsCount: [] as number[],
    opIds: [] as number[],
    expError: [] as number[],
    expPrincipal: [] as string[],
    expFee: [] as string[],
    expStreamBurned: [] as string[],
    expStreamCredited: [] as string[],
    expStreamDust: [] as string[],
    expPaid: [] as string[],
    expSupply: [] as string[],
    expEscrow: [] as string[],
    expUnsolicited: [] as string[],
    expVaultFit: [] as string[],
    expActive: [] as string[],
    expInside: [] as number[],
    expHidden: [] as number[],
    expTickets: [] as number[],
    expGateOpen: [] as number[],
    expRevealed: [] as number[],
    expBurned: [] as string[],
    expClaimsReserve: [] as string[],
    expBalances: [] as string[],
    expClaimable: [] as string[],
    expNftCounts: [] as number[],
    expTicketCounts: [] as number[],
    expQuoteWithdraw1: [] as string[],
    expQuoteWithdraw1Error: [] as number[],
    expQuoteReturn1: [] as string[],
    expQuoteReturn1Error: [] as number[],
    expQuoteTake1: [] as string[],
    expQuoteTake1Error: [] as number[],
    expSurplusFloor: [] as string[],
    expSurplusRemainder: [] as string[],
    expCustodyStart: [] as number[],
    expCustodyCount: [] as number[],
    expCustodyId: [] as number[],
    expCustodyHolder: [] as number[],
  };
  const n0 = BigInt(trace.collectionSize);
  for (const step of trace.steps) {
    const ok = 'ok' in step.outcome ? step.outcome.ok : null;
    const op = opColumns(step.op, ok?.ids ?? []);
    columns.opKind.push(OP_KINDS.indexOf(step.op.op));
    columns.opA.push(op.a === null ? 0 : at(op.a));
    columns.opB.push(op.b === null ? 0 : at(op.b));
    columns.opAmount.push(op.amount);
    columns.opTokenId.push(op.tokenId);
    columns.opCount.push(op.count);
    columns.opLimitKind.push(op.limitKind);
    columns.opLimit.push(op.limit);
    columns.opIdsStart.push(columns.opIds.length);
    columns.opIdsCount.push(op.ids.length);
    columns.opIds.push(...op.ids);

    columns.expError.push(ok ? 0 : errorIndex('error' in step.outcome ? step.outcome.error : ''));
    columns.expPrincipal.push(ok?.principal ?? '0');
    columns.expFee.push(ok?.fee ?? '0');
    columns.expStreamBurned.push(ok?.burned ?? '0');
    columns.expStreamCredited.push(ok?.credited ?? '0');
    columns.expStreamDust.push(ok?.dust ?? '0');
    columns.expPaid.push(ok?.paid ?? '0');

    const s = step.state;
    columns.expSupply.push(s.supply);
    columns.expEscrow.push(s.escrow);
    columns.expUnsolicited.push(s.unsolicited);
    columns.expVaultFit.push(s.vaultFit);
    columns.expActive.push(s.active);
    columns.expInside.push(s.inside);
    columns.expHidden.push(s.hidden);
    columns.expTickets.push(s.tickets);
    columns.expGateOpen.push(s.gateOpen ? 1 : 0);
    columns.expRevealed.push(s.revealed);
    columns.expBurned.push(s.burned);
    columns.expClaimsReserve.push(s.claimsReserve);
    for (const account of trace.accounts) {
      columns.expBalances.push(s.balances[account] ?? '0');
      columns.expClaimable.push(s.claimable[account] ?? '0');
      columns.expNftCounts.push(s.nftCounts[account] ?? 0);
      columns.expTicketCounts.push(s.ticketCounts[account] ?? 0);
    }
    const [qw, qwe] = quoteColumns(s.quoteWithdraw1);
    const [qr, qre] = quoteColumns(s.quoteReturn1);
    const [qt, qte] = quoteColumns(s.quoteTake1);
    columns.expQuoteWithdraw1.push(qw);
    columns.expQuoteWithdraw1Error.push(qwe);
    columns.expQuoteReturn1.push(qr);
    columns.expQuoteReturn1Error.push(qre);
    columns.expQuoteTake1.push(qt);
    columns.expQuoteTake1Error.push(qte);
    const n = BigInt(s.inside);
    const kn = BigInt(s.escrow) * n - (n0 - n) * BigInt(s.active);
    columns.expSurplusFloor.push((kn / n).toString());
    columns.expSurplusRemainder.push((kn % n).toString());
    const changes = custodyPairs(s.custodyChanges);
    columns.expCustodyStart.push(columns.expCustodyId.length);
    columns.expCustodyCount.push(changes.length);
    for (const [id, holder] of changes) {
      columns.expCustodyId.push(id);
      columns.expCustodyHolder.push(holderIndex(holder));
    }
  }
  const finalOutside = custodyPairs(trace.final.outside);
  const finalTickets = custodyPairs(trace.final.tickets);
  const bps = feeBps(trace.policy.conversionFees);
  return {
    schema: FORGE_SCHEMA,
    id: trace.id,
    canonical: canonicalPath,
    policyUnsolicitedFit: trace.policy.unsolicitedFit,
    rawBalanceDonations: trace.policy.unsolicitedFit === 'raw-balance',
    policyConversionFees: trace.policy.conversionFees,
    feeDrawBps: Number(bps.draw),
    feePickBps: Number(bps.pick),
    feeReturnBps: Number(bps.ret),
    collectionSize: trace.collectionSize,
    initialSupply: trace.initialSupply,
    numAccounts: k,
    accounts: trace.accounts,
    initBalances: trace.accounts.map((account) => trace.initial.balances[account] ?? '0'),
    opKinds: OP_KINDS,
    errorCodes: ERROR_CODES,
    steps: trace.steps.length,
    ...columns,
    finalOutsideIds: finalOutside.map(([id]) => id),
    finalOutsideOwners: finalOutside.map(([, owner]) => at(owner)),
    finalTicketIds: finalTickets.map(([id]) => id),
    finalTicketHolders: finalTickets.map(([, holder]) => at(holder.slice(TICKET_PREFIX.length))),
  };
}

/** Text form: one field per line (arrays stay on their line), so diffs stay readable. */
export function serializeForgeExport(value: Record<string, unknown>): string {
  const entries = Object.entries(value);
  const lines = entries.map(([key, v], i) => `  ${JSON.stringify(key)}: ${JSON.stringify(v)}${i < entries.length - 1 ? ',' : ''}`);
  return `{\n${lines.join('\n')}\n}\n`;
}
