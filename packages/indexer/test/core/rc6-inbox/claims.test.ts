import { expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, erc20Abi, type Address, type Hex } from 'viem';
import recorded from './recorded.json';
import { m2Fixture, H, A } from '../../../src/core/v2/m2-fixture.test-support';
import { readFailureClaimV2 } from '../../../src/core/v2/claims-reads-v2';
import { coordinatorV2Abi, royaltyRouterV2Abi, receiverV2Abi } from '../../../src/core/v2/chain-v2';
import { walletClaimSchemaV2 } from '../../../../chain/src/core/v2/claims-types';
import { WalletClaimsIndexV2 } from '../../../src/core/v2/claims-index-v2';
import { boxViewV2, boxViewContextV2 } from '../../../src/core/v2/views-v2';

function fixture(snapshot = recorded.pending, error?: Error, pending: bigint | Error = BigInt(snapshot.pendingP)) {
  const base = m2Fixture(false);
  const f = { ...base, row: { ...base.row, contracts: { ...base.row.contracts, royaltyRouter: recorded.wiring.router as Address } } };
  const calls: string[] = [];
  const reader = { callAt: async (to: Address, data: Hex, hash: Hex): Promise<Hex> => {
    expect(hash).toBe(H(100));
    const abi = to === f.at(0) ? coordinatorV2Abi : to === f.at(1) ? erc20Abi : to === f.at(5) ? receiverV2Abi : royaltyRouterV2Abi;
    const { functionName } = decodeFunctionData({ abi, data }); calls.push(functionName);
    let result: unknown;
    switch (functionName) {
      case 'failed': result = true; break;
      case 'graduated': result = false; break;
      case 'creatorPayee': result = f.row.creator; break;
      case 'claimState': result = [BigInt(snapshot.pot), BigInt(snapshot.tLeft)]; break;
      case 'balanceOf': result = BigInt(snapshot.coinsT); break;
      case 'allowance': result = 0n; break;
      case 'quoteClaim':
        if (error) throw error;
        if (!snapshot.ok) throw Object.assign(new Error('execution reverted'), { cause: { data: snapshot.quote } });
        return snapshot.quote as Hex;
      case 'pendingPriceCoin':
        if (pending instanceof Error) throw pending;
        result = pending; break;
      default: throw new Error(`unexpected ${functionName}`);
    }
    return encodeFunctionResult({ abi, functionName, result } as never);
  } };
  return { f, reader, calls };
}

/** The recording before RC6-RR-INBOX (SH-V21-RC6-INT part 4): the final quote refused with ClaimFailed while P waited. */
const CLAIM_FAILED = '0x360e42e1';
const legacyPending = { ...recorded.pending, ok: false, quote: CLAIM_FAILED };
const NOTICE = "the claim moves the inbox's P into the pot first";
const big = (s: string) => BigInt(s);

it('RC6-RR-INBOX the recorded final quote includes the inbox P and is published priced, backed by pot plus that P', async () => {
  const { f, reader, calls } = fixture();
  expect(recorded.pending.ok).toBe(true);
  const quoted = big(recorded.pending.quote);
  expect(quoted).toBe(big(recorded.pending.pot) + big(recorded.pending.pendingP));
  const claim = await readFailureClaimV2(reader, f.row, A, H(100), false);
  expect(claim).toMatchObject({ amountP: quoted, pot: big(recorded.pending.pot), coinsT: big(recorded.pending.coinsT),
    collectFirst: { pendingP: big(recorded.pending.pendingP), message: NOTICE } });
  expect(calls).toEqual(['failed', 'claimState', 'balanceOf', 'quoteClaim', 'pendingPriceCoin', 'allowance']);
});

it('publishes the priced final share and its inbox P as a claimable wallet row through the strict chain schema', async () => {
  const { f, reader } = fixture();
  const head = { number: 100n, hash: H(100), parentHash: H(99), timestamp: 1000n };
  const state = { block: 100n, hash: H(100), view: boxViewV2([], boxViewContextV2(f.record, f.spec, 18)),
    p: f.row.q, pDecimals: 18, pool: null, supply: 0n, balances: new Map<string, bigint>(), volumeQ: 0n, volumeT: 0n };
  const source = { chainId: f.row.chainId, head: () => head, hashAt: () => H(100),
    boxesV2: new Map([[f.at(1), { row: f.row, states: [state], verified: true, repairing: false }]]) };
  const index = new WalletClaimsIndexV2(source, { ...reader, headerByNumber: async () => head });
  const page = await index.page(A);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ kind: 'failure', status: 'claimable', amountP: String(big(recorded.pending.quote)),
    payout: 'unverified', coinsT: recorded.pending.coinsT, collectFirst: { pendingP: recorded.pending.pendingP, message: NOTICE } });
});

it('refuses a final quote above the pot plus the same-hash pending P, and an unreadable pending read stays an error', async () => {
  const quote = big(recorded.pending.pot) + big(recorded.pending.pendingP) + 1n;
  const above = { ...recorded.pending, quote: `0x${quote.toString(16).padStart(64, '0')}` };
  await expect(readFailureClaimV2(fixture(above).reader, fixture(above).f.row, A, H(100), false)).rejects.toThrow(/exceeds/);
  const unreadable = fixture(recorded.pending, undefined, new Error('cannot read inbox'));
  await expect(readFailureClaimV2(unreadable.reader, unreadable.f.row, A, H(100), false)).rejects.toThrow(/cannot read inbox/);
});

it('a partial share is bounded by the pot alone and reads no inbox', async () => {
  const { f, reader, calls } = fixture(recorded.partial);
  expect((await readFailureClaimV2(reader, f.row, A, H(100), false))?.amountP).toBe(big(recorded.partial.quote));
  expect(calls).not.toContain('pendingPriceCoin');
});

it('RC6RR-FC-3 the recorded late inbox P after the paid creator claim is the creator\'s claim, with the P it moves first', async () => {
  const { f, reader, calls } = fixture(recorded.noBuyerLate);
  expect(recorded.noBuyerLate).toMatchObject({ pot: '77', tLeft: '0', pendingP: '77', ok: true });
  const claim = await readFailureClaimV2(reader, { ...f.row, creator: A }, A, H(100), true);
  expect(claim).toMatchObject({ amountP: 77n, pot: 77n, collectFirst: { pendingP: 77n, message: NOTICE } });
  expect(calls).toEqual(['failed', 'claimState', 'quoteClaim', 'pendingPriceCoin']);
});

it('the creator\'s bound is its claimState pot, which already holds the readable inbox P (never added twice)', async () => {
  const twice = { ...recorded.noBuyerLate, quote: `0x${(78n).toString(16).padStart(64, '0')}` };
  const { f, reader } = fixture(twice);
  await expect(readFailureClaimV2(reader, { ...f.row, creator: A }, A, H(100), true)).rejects.toThrow(/exceeds/);
});

it.each(['partial', 'noBuyer', 'noBuyerReopened'] as const)('RC6-I4 uses recorded quoteClaim, not an event estimate: %s', async key => {
  const { f, reader, calls } = fixture(recorded[key]);
  const row = { ...f.row, creator: A };
  const claim = await readFailureClaimV2(reader, row, A, H(100), key !== 'partial');
  expect(claim?.amountP).toBe(BigInt(recorded[key].quote));
  // Nothing waits in the inbox: no note, and the recorded swept 77 is the established remainder.
  expect(claim && 'collectFirst' in claim).toBe(false);
  expect(calls).toContain('claimState'); expect(calls).toContain('quoteClaim');
});

it('RC7-I29 rejects the pre-RC6-RR-INBOX refusal even with readable positive pending P, ending at quoteClaim', async () => {
  const { f, reader, calls } = fixture(legacyPending);
  await expect(readFailureClaimV2(reader, f.row, A, H(100), false)).rejects.toThrow('execution reverted');
  expect(calls).toEqual(['failed', 'claimState', 'balanceOf', 'quoteClaim']);
});

it('RC7-I29 rejects the wallet page instead of publishing an unpriced failure row', async () => {
  const { f, reader, calls } = fixture(legacyPending);
  const head = { number: 100n, hash: H(100), parentHash: H(99), timestamp: 1000n };
  const state = { block: 100n, hash: H(100), view: boxViewV2([], boxViewContextV2(f.record, f.spec, 18)),
    p: f.row.q, pDecimals: 18, pool: null, supply: 0n, balances: new Map<string, bigint>(), volumeQ: 0n, volumeT: 0n };
  const source = { chainId: f.row.chainId, head: () => head, hashAt: () => H(100),
    boxesV2: new Map([[f.at(1), { row: f.row, states: [state], verified: true, repairing: false }]]) };
  const index = new WalletClaimsIndexV2(source, { ...reader, headerByNumber: async () => head });
  await expect(index.page(A)).rejects.toThrow('execution reverted');
  expect(calls.at(-1)).toBe('quoteClaim');
  expect(calls).not.toContain('pendingPriceCoin');
});

it.each(['empty', 'unreadable', 'transport', 'partial'] as const)('does not relabel unrelated or unproven refusal: %s', async kind => {
  const error = kind === 'transport' ? new Error('RPC timeout') : Object.assign(new Error('execution reverted'), { data: CLAIM_FAILED });
  const { f, reader } = fixture(kind === 'partial' ? recorded.partial : legacyPending, error,
    kind === 'empty' ? 0n : kind === 'unreadable' ? new Error('cannot read inbox') : 77n);
  await expect(readFailureClaimV2(reader, f.row, A, H(100), false)).rejects.toThrow();
});

it('the chain wire takes a priced final share with its inbox P and refuses an unpriced one (SH-RC7 item 29) and fabricated amounts', () => {
  const f = m2Fixture(false);
  const row = { id: 'failure', kind: 'failure', status: 'claimable', wallet: A, box: { registry: f.row.registry, boxId: '1', token: f.at(1) },
    roleAddress: f.at(0), asset: f.row.q, amountP: String(big(recorded.pending.quote)), asOf: { block: '100', hash: H(100), timestamp: '1000', tier: 'head' },
    payout: 'unverified', payment: null, coinsT: recorded.pending.coinsT, allowanceT: '0', pot: recorded.pending.pot, tLeft: recorded.pending.tLeft,
    collectFirst: { pendingP: recorded.pending.pendingP, message: NOTICE } };
  expect(walletClaimSchemaV2.safeParse(row).success).toBe(true);
  for (const invalid of [{ ...row, amountP: String(big(recorded.pending.quote) + 1n) }, { ...row, coinsT: '1' },
    { ...row, status: 'pending', amountP: null, payout: 'not_ready' },
    { ...row, collectFirst: { ...row.collectFirst, pendingP: '0' } }, { ...row, status: 'pending', payout: 'not_ready' }]) {
    expect(walletClaimSchemaV2.safeParse(invalid).success).toBe(false);
  }
  const creator = { ...row, id: 'no-buyer', kind: 'no_buyer', coinsT: '0', amountP: '77', pot: '77', allowanceT: undefined, tLeft: undefined,
    collectFirst: { pendingP: '77', message: NOTICE } };
  delete (creator as Record<string, unknown>).allowanceT; delete (creator as Record<string, unknown>).tLeft;
  expect(walletClaimSchemaV2.safeParse(creator).success).toBe(true);
  expect(walletClaimSchemaV2.safeParse({ ...creator, amountP: '76' }).success).toBe(false);
});
