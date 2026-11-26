import { describe, expect, it } from 'vitest';
import { ETH_LOCAL, GENESIS_FIT, ONE_FIT, snapshotOf } from '../test-support/core-fixtures';
import {
  CoreModelError,
  MISFITS_FEE_POLICY_F23,
  MISFITS_QUOTE_POLICY_DRAFT,
  MISFITS_VAULT_POLICY_F23,
  amountOf,
  assertQuoteUsable,
  buildQuote,
  nftTokenId,
  policyId,
  principalFor,
  quoteIssues,
  type ConversionQuote,
  type QuoteContext,
} from './index';

const NOW = 1_790_000_000;
const CONTEXT: QuoteContext = {
  quotePolicy: MISFITS_QUOTE_POLICY_DRAFT,
  feePolicy: MISFITS_FEE_POLICY_F23,
  vaultPolicy: MISFITS_VAULT_POLICY_F23,
  nowSeconds: NOW,
};
const ids = (...values: number[]) => values.map((value) => nftTokenId(BigInt(value)));
const paths = (quote: ConversionQuote, context: QuoteContext = CONTEXT): string[] => quoteIssues(quote, context).map((issue) => issue.path.join('.'));

describe('principal from one pre-operation snapshot (v2 docs/03)', () => {
  it('EX01: withdrawing 5,000 of 10,000 locks half the supply', () => {
    expect(principalFor(snapshotOf(), 'withdraw', 5_000n).raw).toBe(GENESIS_FIT / 2n);
  });

  it('withdraw rounds up, return rounds down, in raw units', () => {
    expect(principalFor(snapshotOf({ S: 1_000n, initial: 1_000n, n: 3n, N: 3n }), 'withdraw', 1n).raw).toBe(334n);
    expect(principalFor(snapshotOf({ S: 1_000n, E: 500n, initial: 1_000n, n: 3n, N: 4n }), 'return', 1n).raw).toBe(166n);
  });

  it('refuses a quote with no Misfit inside (r undefined)', () => {
    expect(() => principalFor(snapshotOf({ E: GENESIS_FIT, n: 0n }), 'return', 1n)).toThrow(CoreModelError);
  });
});

describe('quotes bind chain, asset and policy and carry limits and a deadline', () => {
  const snapshot = snapshotOf({ E: 500_000_000n * ONE_FIT, n: 5_000n });
  const draw = buildQuote({ action: 'withdraw', selection: 'draw', snapshot, quantity: 2n, nowSeconds: NOW }, CONTEXT);
  const back = buildQuote({ action: 'return', snapshot, quantity: 1n, tokenIds: ids(7), nowSeconds: NOW }, CONTEXT);

  it('builds a draw with a 1% burned fee and a max-spend limit', () => {
    expect(draw.principal.raw).toBe(200_000n * ONE_FIT);
    expect(draw.fees).toEqual([{ action: 'draw', amount: amountOf(draw.snapshot.fit, 2_000n * ONE_FIT), destination: 'burn', policy: { id: 'MISFITS_FEES_F23', version: 1 } }]);
    expect(draw.limit.raw).toBe(202_000n * ONE_FIT);
    expect(draw.expiresAt - draw.quotedAt).toBe(MISFITS_QUOTE_POLICY_DRAFT.maxQuoteTtlSeconds);
    expect(quoteIssues(draw, CONTEXT)).toEqual([]);
  });

  it('builds a return with a 5% burned fee and a min-receive limit', () => {
    expect(back.principal.raw).toBe(100_000n * ONE_FIT);
    expect(back.fees.map((fee) => [fee.action, fee.amount.raw])).toEqual([['return', 5_000n * ONE_FIT]]);
    expect(back.limit.raw).toBe(95_000n * ONE_FIT);
    expect(quoteIssues(back, CONTEXT)).toEqual([]);
  });

  it('prices a named pick at 25% and needs the exact IDs', () => {
    const pick = buildQuote({ action: 'withdraw', selection: 'named_pick', snapshot, quantity: 1n, tokenIds: ids(42), nowSeconds: NOW }, CONTEXT);
    expect(pick.fees.map((fee) => [fee.action, fee.amount.raw])).toEqual([['named_pick', 25_000n * ONE_FIT]]);
    expect(paths({ ...pick, tokenIds: [] })).toContain('tokenIds');
    expect(paths({ ...draw, tokenIds: ids(1, 2) })).toContain('tokenIds');
  });

  it('rounds fees up so a burn is never short', () => {
    const odd = snapshotOf({ S: 1_000n, initial: 1_000n, n: 3n, N: 3n });
    const quote = buildQuote({ action: 'withdraw', selection: 'draw', snapshot: odd, quantity: 1n, nowSeconds: NOW }, CONTEXT);
    expect(quote.principal.raw).toBe(334n);
    expect(quote.fees[0]?.amount.raw).toBe(4n);
  });

  it.each([
    ['another fee policy version', (q: ConversionQuote) => ({ ...q, feePolicy: { ...q.feePolicy, version: 2 } }), 'feePolicy'],
    ['another quote policy', (q: ConversionQuote) => ({ ...q, quotePolicy: { id: policyId('OTHER_QUOTES'), version: 1 } }), 'quotePolicy'],
    ['a snapshot under another vault policy', (q: ConversionQuote) => ({ ...q, snapshot: { ...q.snapshot, vaultPolicy: { id: policyId('OTHER_VAULT'), version: 1 } } }), 'snapshot.vaultPolicy'],
    ['a principal in another asset', (q: ConversionQuote) => ({ ...q, principal: amountOf(ETH_LOCAL, q.principal.raw) }), 'principal'],
    ['a principal one unit short', (q: ConversionQuote) => ({ ...q, principal: amountOf(q.principal.asset, q.principal.raw - 1n) }), 'principal'],
    ['a fee one unit short', (q: ConversionQuote) => ({ ...q, fees: q.fees.map((f) => ({ ...f, amount: amountOf(f.amount.asset, f.amount.raw - 1n) })) }), 'fees.0.amount'],
    ['a fee paid to someone', (q: ConversionQuote) => ({ ...q, fees: q.fees.map((f) => ({ ...f, destination: 'treasury' as 'burn' })) }), 'fees.0.destination'],
    ['a fee under another policy', (q: ConversionQuote) => ({ ...q, fees: q.fees.map((f) => ({ ...f, policy: { id: policyId('OTHER_FEES'), version: 1 } })) }), 'fees.0.policy'],
    ['a missing fee line', (q: ConversionQuote) => ({ ...q, fees: [] }), 'fees'],
    ['a limit below principal plus fee', (q: ConversionQuote) => ({ ...q, limit: amountOf(q.limit.asset, q.limit.raw - 1n) }), 'limit'],
    ['a limit in another asset', (q: ConversionQuote) => ({ ...q, limit: amountOf(ETH_LOCAL, q.limit.raw) }), 'limit'],
    ['an expired deadline', (q: ConversionQuote) => ({ ...q, expiresAt: NOW }), 'expiresAt'],
    ['a deadline beyond the policy window', (q: ConversionQuote) => ({ ...q, expiresAt: q.quotedAt + MISFITS_QUOTE_POLICY_DRAFT.maxQuoteTtlSeconds + 1 }), 'expiresAt'],
    ['a quote time in the future', (q: ConversionQuote) => ({ ...q, quotedAt: NOW + 1 }), 'quotedAt'],
    ['a pending block', (q: ConversionQuote) => ({ ...q, snapshot: { ...q.snapshot, at: { ...q.snapshot.at, finality: 'pending' as const } } }), 'snapshot.at.finality'],
    ['more Misfits than one call allows', (q: ConversionQuote) => ({ ...q, quantity: BigInt(MISFITS_QUOTE_POLICY_DRAFT.maxQuantityPerCall + 1) }), 'quantity'],
    ['no selection for a withdrawal', (q: ConversionQuote) => ({ ...q, selection: null }), 'selection'],
  ])('rejects a withdrawal with %s', (_name, change, path) => {
    expect(paths(change(draw))).toContain(path);
  });

  it('rejects a return with a raised limit, duplicate IDs, a wrong ID count or more than m Misfits', () => {
    expect(paths({ ...back, limit: amountOf(back.limit.asset, back.limit.raw + 1n) })).toContain('limit');
    expect(paths({ ...back, quantity: 2n, tokenIds: ids(7, 7) })).toContain('tokenIds');
    expect(paths({ ...back, tokenIds: ids(7, 8) })).toContain('tokenIds');
    const full = snapshotOf();
    const none = buildQuote({ action: 'return', snapshot: snapshotOf({ E: 100_000n * ONE_FIT, n: 9_999n }), quantity: 1n, tokenIds: ids(1), nowSeconds: NOW }, CONTEXT);
    expect(paths({ ...none, snapshot: full })).toContain('quantity');
  });

  it('F23 C2: the last Misfit cannot leave the vault', () => {
    const two = snapshotOf({ E: GENESIS_FIT - GENESIS_FIT / 5_000n, n: 2n });
    const ok = buildQuote({ action: 'withdraw', selection: 'draw', snapshot: two, quantity: 1n, nowSeconds: NOW }, CONTEXT);
    expect(quoteIssues(ok, CONTEXT)).toEqual([]);
    const last = { ...ok, quantity: 2n, principal: principalFor(two, 'withdraw', 2n) };
    expect(quoteIssues(last, CONTEXT).map((issue) => issue.message)).toContain('the last Misfit cannot leave the vault (F23 C2)');
  });

  it('assertQuoteUsable throws a typed error listing the problems', () => {
    expect(() => assertQuoteUsable(draw, CONTEXT)).not.toThrow();
    expect(() => assertQuoteUsable(draw, { ...CONTEXT, nowSeconds: draw.expiresAt })).toThrow(CoreModelError);
  });
});
