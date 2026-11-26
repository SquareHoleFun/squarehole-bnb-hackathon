import { decodeEventLog, decodeFunctionData, encodeErrorResult, encodeFunctionResult, parseAbi, toHex, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { expect, it, vi } from 'vitest';
import { CLAIM_SIMULATION_GAS, claimsRpcReaderV2, readCreatorClaimV2 } from '../../../src/core/v2/claims-reads-v2';
import { creatorQuoteCodeV2 } from '../../../src/core/v2/claims-quote-code';
import { coordinatorV2Abi, receiverV2Abi } from '../../../src/core/v2/chain-v2';
import { m2Fixture, H } from '../../../src/core/v2/m2-fixture.test-support';
import { required } from '../../../src/core/v2/m3-fixture.test-support';
import fixtures from './creator-quote.json';

const quoteAbi = parseAbi(['function quote(address receiver,address asset) returns (uint256)']);
const fixture = m2Fixture(false);

it.each(['native', 'paused', 'blocked', 'inexact'] as const)('AF1 decodes the real receiver/PoolManager %s refusal without losing its entitlement', async kind => {
  const recorded = fixtures[kind];
  const wallet = recorded.wallet as Address;
  const receiver = recorded.receiver as Address;
  const asset = recorded.asset as Address;
  const row = { ...fixture.row, q: asset, contracts: { ...fixture.row.contracts, receiver } };
  const callAt = vi.fn(async (to: Address, data: Hex) => {
    const abi: Abi = to === receiver ? receiverV2Abi : coordinatorV2Abi;
    const { functionName } = decodeFunctionData({ abi, data });
    return encodeFunctionResult({ abi, functionName, result: functionName === 'creatorPayee' ? wallet : functionName === 'graduated' });
  });
  const creatorEntitlementAt = vi.fn(async () => kind === 'native' ? 1234n : kind === 'paused' ? 10n : 1500n);
  const reader = { callAt, callFromAt: async () => { throw Object.assign(new Error('execution reverted'), { cause: { data: recorded.data } }); }, creatorEntitlementAt };
  const got = await readCreatorClaimV2(reader, row, wallet, H(100));
  expect(got).toEqual({ amountP: kind === 'native' ? 1234n : kind === 'paused' ? 10n : 1500n, payout: 'unavailable' });
  expect(creatorEntitlementAt).toHaveBeenCalledWith(wallet, receiver, asset, H(100));
  if (kind === 'native') {
    const paid = decodeEventLog({ abi: receiverV2Abi, eventName: 'CreatorClaimed', data: fixtures.redirected.data as Hex, topics: fixtures.redirected.topics as [Hex, ...Hex[]] });
    expect(paid.args).toMatchObject({ payee: wallet, token: asset, amount: got?.amountP });
    expect(paid.args.to.toLowerCase()).toBe('0x0000000000000000000000000000000000000b0b');
  }
});

it('AF1 pins quote overrides and payout simulations to the same canonical hash and gas bound', async () => {
  const request = vi.fn(async () => encodeFunctionResult({ abi: quoteAbi, functionName: 'quote', result: 4n * ((1n << 127n) - 1n) }));
  const client = { request, getBlock: vi.fn() } as unknown as Pick<PublicClient, 'request' | 'getBlock'>;
  const reader = claimsRpcReaderV2(client);
  const { wallet, receiver, asset } = fixtures.native as { wallet: Address; receiver: Address; asset: Address };
  expect(await required(reader.creatorEntitlementAt)(wallet, receiver, asset, H(100))).toBe(4n * ((1n << 127n) - 1n));
  const expectedData = expect.any(String);
  expect(request).toHaveBeenCalledWith({ method: 'eth_call', params: [
    { from: wallet, to: wallet, data: expectedData, gas: toHex(CLAIM_SIMULATION_GAS) },
    { blockHash: H(100), requireCanonical: true }, { [wallet]: { code: creatorQuoteCodeV2 } },
  ] });
  const call = request.mock.calls[0] as unknown as [{ params: [{ data: Hex }] }];
  expect(decodeFunctionData({ abi: quoteAbi, data: call[0].params[0].data }).args).toEqual([receiver, asset]);
  request.mockClear();
  await required(reader.callFromAt)(wallet, receiver, '0x1234', H(100));
  expect(request).toHaveBeenCalledWith({ method: 'eth_call', params: [
    { from: wallet, to: receiver, data: '0x1234', gas: toHex(CLAIM_SIMULATION_GAS) },
    { blockHash: H(100), requireCanonical: true },
  ] });
});

it('AF1 never downgrades unsupported overrides, missing hashes or malformed quotes to zero', async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error('state overrides unsupported')).mockRejectedValueOnce(new Error('block not canonical')).mockResolvedValueOnce('0x');
  const reader = claimsRpcReaderV2({ request, getBlock: vi.fn() } as unknown as Pick<PublicClient, 'request' | 'getBlock'>);
  const { wallet, receiver, asset } = fixtures.native as { wallet: Address; receiver: Address; asset: Address };
  await expect(required(reader.creatorEntitlementAt)(wallet, receiver, asset, H(100))).rejects.toThrow('state overrides unsupported');
  await expect(required(reader.creatorEntitlementAt)(wallet, receiver, asset, H(100))).rejects.toThrow('block not canonical');
  await expect(required(reader.creatorEntitlementAt)(wallet, receiver, asset, H(100))).rejects.toThrow();
});

it.each([true, false])('AF1 scopes unreadable token balances to the payout recipient (matching=%s)', async matching => {
  const { wallet, receiver, asset } = fixtures.paused as { wallet: Address; receiver: Address; asset: Address };
  const row = { ...fixture.row, q: asset, contracts: { ...fixture.row.contracts, receiver } };
  const errors = parseAbi(['error BalanceUnreadable(address token,address account)']);
  const error = Object.assign(new Error('balance read refused'), { data: encodeErrorResult({ abi: errors, errorName: 'BalanceUnreadable', args: [asset, matching ? wallet : receiver] }) });
  const reader = {
    callAt: async (to: Address, data: Hex) => {
      const abi: Abi = to === receiver ? receiverV2Abi : coordinatorV2Abi;
      const { functionName } = decodeFunctionData({ abi, data });
      return encodeFunctionResult({ abi, functionName, result: functionName === 'creatorPayee' ? wallet : functionName === 'graduated' });
    },
    callFromAt: async () => { throw error; }, creatorEntitlementAt: vi.fn(async () => 10n),
  };
  if (matching) expect(await readCreatorClaimV2(reader, row, wallet, H(100))).toEqual({ amountP: 10n, payout: 'unavailable' });
  else {
    await expect(readCreatorClaimV2(reader, row, wallet, H(100))).rejects.toThrow('balance read refused');
    expect(reader.creatorEntitlementAt).not.toHaveBeenCalled();
  }
});
