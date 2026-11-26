import { describe, expect, it, vi } from 'vitest';
import { CowHttp } from '../src/api';
import { APP_DATA, orderFields, orderUid } from '../src/order';
import { concat, domainSeparator, hashTypedData, keccak256, toHex, type Address } from 'viem';
import type { Clock, Order } from '../src/types';

function setup(responses: (Response | Error)[]) {
  let now = 0;
  const starts: number[] = [];
  const clock: Clock = { now: () => now, sleep: async ms => { now += ms; }, random: () => 0.5 };
  const fetcher = vi.fn(async () => {
    starts.push(now); const response = responses.shift();
    if (response instanceof Error) throw response;
    return response ?? Response.json({ status: 'open' });
  });
  const log = vi.fn();
  return { api: new CowHttp('https://api.cow.fi/sepolia', clock, log, fetcher), starts, fetcher, log };
}
const uid = `0x${'a'.repeat(112)}`;
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const owner = address(1);
const hash = keccak256(toHex(APP_DATA));
const order: Order = { sellToken: address(2), buyToken: address(3), receiver: owner,
  sellAmount: 100_000_000n, buyAmount: 1n, validTo: 3600, feeAmount: 0n, appData: hash,
  kind: keccak256(toHex('sell')), partiallyFillable: false,
  sellTokenBalance: keccak256(toHex('erc20')), buyTokenBalance: keccak256(toHex('erc20')) };
/** CoW's answer to the poster's request (cowprotocol/services, orderbook quoter `build_order_quote_response`): the app
 * data echoed as sent, so `appData` is the full JSON and `appDataHash` its hash; amounts as decimal strings, the cost
 * fields, and an expiry with nanoseconds. A key set to undefined is left out of the JSON body. */
function quote(overrides: Record<string, unknown> = {}, expiration = '1970-01-01T00:01:00.000000000Z') {
  return { from: owner, expiration, id: 1, verified: true, protocolFeeBps: '2',
    quote: { ...orderFields(order), sellAmount: '99000000', feeAmount: '1000000', buyAmount: '123', gasAmount: '150000',
      gasPrice: '1000000000', sellTokenPrice: '0.0004', signingScheme: 'eip1271', ...overrides } };
}
describe('shared CoW request queue', () => {
  it('spaces concurrent requests at least four seconds apart', async () => {
    const f = setup([]);
    await Promise.all([f.api.status(uid), f.api.status(uid), f.api.status(uid)]);
    expect(f.starts).toEqual([0, 4000, 8000]);
  });
  it.each([403, 429])('backs off with jitter on %s and honors Retry-After', async status => {
    const f = setup([new Response('CloudFront private body', { status }),
      new Response('', { status, headers: { 'Retry-After': '120' } })]);
    expect(await f.api.status(uid)).toBeNull(); expect(await f.api.status(uid)).toBeNull();
    expect(await f.api.status(uid)).toBe('open');
    expect(f.starts[1]).toBe(33_750); expect(f.starts[2]).toBe(161_250);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('private body');
  });
  it('treats network failures, 5xx and malformed JSON as no data', async () => {
    const f = setup([new Error('secret endpoint'), new Response('', { status: 503 }), new Response('invalid')]);
    expect(await f.api.status(uid)).toBeNull(); expect(await f.api.status(uid)).toBeNull();
    expect(await f.api.status(uid)).toBeNull(); expect(f.starts).toEqual([0, 4000, 8000]);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('secret endpoint');
  });
  it('disables redirects and sets a request deadline', async () => {
    const f = setup([]); await f.api.status(uid);
    expect(f.fetcher).toHaveBeenCalledWith(expect.stringContaining('/api/v1/orders/'), expect.objectContaining({
      redirect: 'error', signal: expect.any(AbortSignal),
    }));
  });
  it('shares rate limits across quote, POST and status, preserving all signed fields and signature', async () => {
    const f = setup([Response.json(quote()), Response.json(uid)]);
    expect(await f.api.quote(order, owner)).toEqual({ feeAmount: 1_000_000n });
    expect(await f.api.post(order, owner, '0xbeef')).toBe(uid);
    expect(await f.api.status(uid)).toBe('open');
    expect(f.starts).toEqual([0, 4000, 8000]);
    const calls = f.fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(String(calls[0]?.[1].body))).toEqual({ sellToken: order.sellToken, buyToken: order.buyToken,
      receiver: owner, kind: 'sell', sellAmountBeforeFee: '100000000', from: owner, signingScheme: 'eip1271',
      onchainOrder: false, validTo: 3600, appData: APP_DATA, appDataHash: order.appData,
      sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' });
    expect(JSON.parse(String(calls[1]?.[1].body))).toEqual({ ...orderFields(order), from: owner,
      signature: '0xbeef', signingScheme: 'eip1271' });
  });
  it.each([
    { feeAmount: '-1' }, { feeAmount: 1000000 }, { sellAmount: '1' }, { buyAmount: '0' },
    { sellToken: address(9) }, { buyToken: address(9) }, { receiver: address(9) },
    { kind: 'buy' }, { validTo: 7200 }, { appData: '0x00' }, { sellTokenBalance: 'external' },
  ])('rejects a malformed or mismatched quote %j', async fields => {
    const f = setup([Response.json(quote(fields))]); expect(await f.api.quote(order, owner)).toBeNull();
  });
  it.each([
    ['the full JSON with its hash, as CoW echoes this request', {}],
    ['the hash alone, as CoW echoes a hash-only request', { appData: hash, appDataHash: undefined }],
    ['the full JSON alone', { appDataHash: undefined }],
    ['the hash in either case', { appData: hash.toUpperCase().replace('0X', '0x'), appDataHash: hash.toUpperCase().replace('0X', '0x') }],
  ])('accepts a quote whose app data is %s', async (_shape, fields) => {
    const f = setup([Response.json(quote(fields))]);
    expect(await f.api.quote(order, owner)).toEqual({ feeAmount: 1_000_000n });
  });
  it.each([
    ['the right JSON with another hash', { appData: APP_DATA, appDataHash: `0x${'0'.repeat(64)}` }],
    ['other JSON beside the right hash', { appData: '{"other":1}' }],
    ['other JSON alone', { appData: '{"other":1}', appDataHash: undefined }],
    ['the same document serialized differently', { appData: APP_DATA.replace('"metadata":{}', '"metadata": {}') }],
    ['the hash beside another hash', { appData: hash, appDataHash: `0x${'0'.repeat(64)}` }],
    ['another hash alone', { appData: `0x${'1'.repeat(64)}`, appDataHash: undefined }],
    ['a hash with no app data', { appData: undefined }],
    ['a null hash', { appDataHash: null }],
  ])('rejects a quote whose app data is %s', async (_shape, fields) => {
    const f = setup([Response.json(quote(fields))]); expect(await f.api.quote(order, owner)).toBeNull();
  });
  it('rejects quotes for another owner and already expired quotes', async () => {
    const f = setup([Response.json({ ...quote(), from: address(9) }), Response.json(quote({}, '1970-01-01T00:00:00.000Z'))]);
    expect(await f.api.quote(order, owner)).toBeNull(); expect(await f.api.quote(order, owner)).toBeNull();
  });
  it('does not send a POST if a quote expires while waiting for the rate limiter', async () => {
    const f = setup([Response.json(quote({}, '1970-01-01T00:00:03.000Z'))]);
    await f.api.quote(order, owner); expect(await f.api.post(order, owner, '0xbeef')).toBeNull();
    expect(f.starts).toEqual([0]);
  });
  it('will not POST without a matching live quote in this API client', async () => {
    const f = setup([]); expect(await f.api.post(order, owner, '0xbeef')).toBeNull(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('will not POST after the signed order expires in the queue', async () => {
    const nearExpiry = { ...order, validTo: 3 };
    const f = setup([Response.json(quote({ validTo: 3 }))]);
    await f.api.quote(nearExpiry, owner); await f.api.post(nearExpiry, owner, '0xbeef'); expect(f.starts).toEqual([0]);
  });
  it('computes the GPv2 UID against an independent EIP-712 encoder', () => {
    const domain = { name: 'Gnosis Protocol', version: 'v2', chainId: 31337, verifyingContract: address(4) };
    const types = { Order: [
      { name: 'sellToken', type: 'address' }, { name: 'buyToken', type: 'address' }, { name: 'receiver', type: 'address' },
      { name: 'sellAmount', type: 'uint256' }, { name: 'buyAmount', type: 'uint256' }, { name: 'validTo', type: 'uint32' },
      { name: 'appData', type: 'bytes32' }, { name: 'feeAmount', type: 'uint256' }, { name: 'kind', type: 'string' },
      { name: 'partiallyFillable', type: 'bool' }, { name: 'sellTokenBalance', type: 'string' }, { name: 'buyTokenBalance', type: 'string' },
    ] } as const;
    const digest = hashTypedData({ domain, types, primaryType: 'Order', message: { ...order, kind: 'sell', sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' } });
    expect(orderUid(order, owner, domainSeparator({ domain }))).toBe(concat([digest, owner, toHex(order.validTo, { size: 4 })]));
  });
});
