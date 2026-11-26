import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { buildListingKit } from '../kit.mjs';
import { fakeRpc, input, A, H, PLAIN, FEE, REBASE, PAUSED, BLACKLIST, BURN, unpack } from './rpc.mjs';

const { decodeFunctionData, parseAbi, toFunctionSelector, encodeFunctionResult } = createRequire(new URL('../../../packages/burn-bot/package.json', import.meta.url))('viem');

describe('listing kit admission and unsigned artifacts', () => {
  it('requires explicit mainnet permission before even reading RPC', async () => {
    const rpc = fakeRpc();
    await expect(buildListingKit(input(), rpc)).rejects.toThrow(/allow-mainnet/);
    expect(rpc.requests).toHaveLength(0);
    await expect(buildListingKit({ ...input(), chainId: '11155111' }, rpc, true)).rejects.toThrow(/chain/);
    rpc.chainId = '0xaa36a7';
    await expect(buildListingKit(input(), rpc, true)).rejects.toThrow(/chain/);
  });

  it('reports every token double, batches only plain and checked burn, using raw strings', async () => {
    const rpc = fakeRpc();
    const result = await buildListingKit(input(), rpc, true);
    expect(result.coins.map(c => [c.token, c.eligible])).toEqual([
      [PLAIN, true], [FEE, false], [REBASE, false], [PAUSED, false], [BLACKLIST, false], [BURN, true],
    ]);
    expect(result.coins[0].raise.amount).toBe('4206980085000000000');
    expect(result.coins[0].checks.every(c => c.status === 'pass')).toBe(true);
    expect(result.coins[1].checks).toContainEqual(expect.objectContaining({ id: 'transfers', status: 'fail' }));
    expect(result.coins[2].powers.policyBlocks).toContain('rebase');
    expect(result.coins[3].powers.proxies).toContainEqual(expect.objectContaining({ kind: 'eip1967', admin: A(81) }));
    expect(result.coins[4].powers.functions).toContainEqual(expect.objectContaining({ signature: 'blacklist(address)' }));
    expect(result.coins[5].checks).toContainEqual(expect.objectContaining({ id: 'burn', status: 'pass' }));
    expect(result.safeBatch.chainId).toBe('1');
    expect(result.safeBatch.transactions).toHaveLength(6);
    expect(result.multiSend.operation).toBe(1);
    expect(result.multiSend.value).toBe('0');
    expect(result.dust.every(d => d.required === '10000')).toBe(true);
    expect(result.dust.every(d => d.consumedByProbe === '0')).toBe(true);
    expect(result.runner.routes).toHaveLength(2);
    expect(result.issuerSheets[PAUSED]).toContain('pause');
    expect(result.issuerSheets[PLAIN]).toContain('not proof of absence');
    expect(rpc.requests.every(r => ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt', 'eth_getLogs', 'eth_call'].includes(r.method))).toBe(true);
    expect(rpc.requests.some(r => r.method === 'eth_call' && r.params.length === 3)).toBe(true);
  });

  it('keeps reporting if one token has no code or malformed decimals', async () => {
    const rpc = fakeRpc(); rpc.noCode.add(FEE); rpc.decimals.set(REBASE, '0x12');
    const result = await buildListingKit(input(), rpc, true);
    expect(result.coins).toHaveLength(6);
    expect(result.coins[1].checks).toContainEqual(expect.objectContaining({ id: 'code', status: 'fail' }));
    expect(result.coins[2].checks).toContainEqual(expect.objectContaining({ id: 'decimals', status: 'fail' }));
    expect(result.coins[5].eligible).toBe(true);
  });

  it('marks unsupported overrides and unfunded probes fork run needed, never batched', async () => {
    const rpc = fakeRpc(); rpc.overrides = false;
    const result = await buildListingKit(input(), rpc, true);
    expect(result.safeBatch.transactions).toEqual([]);
    expect(result.coins[0].checks).toContainEqual(expect.objectContaining({ id: 'transfers', status: 'fork run needed' }));
    const unfunded = fakeRpc(); unfunded.funded = false;
    const second = await buildListingKit(input(), unfunded, true);
    expect(second.dust[0].shortfall).toBe('10000');
    expect(second.safeBatch.transactions).toEqual([]);
  });

  it('rejects existing listings, wrong lister, broken burn and reorgs', async () => {
    const rpc = fakeRpc(); rpc.listed.add(PLAIN); rpc.badBurn = true;
    const result = await buildListingKit(input(), rpc, true);
    expect(result.coins[0].eligible).toBe(false);
    expect(result.coins[5].checks).toContainEqual(expect.objectContaining({ id: 'burn', status: 'fail' }));
    const wrong = fakeRpc(); wrong.lister = A(999);
    await expect(buildListingKit(input(), wrong, true)).rejects.toThrow(/lister/);
    const reorg = fakeRpc(); reorg.reorg = true;
    await expect(buildListingKit(input(), reorg, true)).rejects.toThrow(/block changed/);
  });

  it('rejects duplicate coins, numeric amounts, arbitrary selectors and unknown input fields', async () => {
    for (const change of [
      { tokens: [input().tokens[0], input().tokens[0]] },
      { referenceAmount: 10000 },
      { tokens: [{ token: PLAIN, class: 'OTHER', burnSelector: '0xdeadbeef' }] },
      { rpcUrl: 'obviously-fake-value' },
    ]) await expect(buildListingKit({ ...input(), ...change }, fakeRpc(), true)).rejects.toThrow();
  });

  it('does not mistake a Safe fallback response for a probe pass when overrides are silently ignored', async () => {
    const rpc = fakeRpc(), original = rpc.request.bind(rpc);
    rpc.request = (method, params) => method === 'eth_call' && params.length === 3 ? Promise.resolve('0x') : original(method, params);
    const result = await buildListingKit(input(), rpc, true);
    expect(result.safeBatch.transactions).toEqual([]);
    expect(result.coins[0].checks).toContainEqual(expect.objectContaining({ id: 'transfers', status: 'fork run needed' }));
  });
});

// SH-RC6-LISTING-LOTS LL-01: the signed artifact must include the lot, not merely a report suggestion.
it('sets sequential admitted listing IDs and records the snapshot price in the Safe notes', async () => {
  const rpc = fakeRpc();
  const config = input(); config.tokens[5].class = 'STOCK';
  const result = await buildListingKit(config, rpc, true);
  const abi = parseAbi(['function approve(address,uint256)', 'function add(address,uint8,uint256)',
    'function addWithBurn(address,uint8,uint256,bytes4)', 'function setRoyaltyLot(uint32,uint256)']);
  const calls = result.safeBatch.transactions.map(c => decodeFunctionData({ abi, data: c.data }));
  expect(calls.map(c => c.functionName)).toEqual(['approve', 'add', 'setRoyaltyLot', 'approve', 'addWithBurn', 'setRoyaltyLot']);
  expect(calls[2].args).toEqual([1, 50000000000000000n]);
  expect(calls[5].args).toEqual([2, 250000000000000000n]);
  expect(result.royaltyLots.entries.map(e => e.lot)).toEqual(['50000000000000000', '250000000000000000']);
  expect(result.royaltyLots.entries[0].price).toMatchObject({ tokenAmount: '1000000000000000000',
    wethAmount: '1000000000000000000', blockNumber: '1000', blockHash: H(1000), timestamp: '2008000' });
  expect(result.safeBatch.meta.description).toContain(result.royaltyLots.entries[0].price.source);
  expect(result.safeBatch.meta.description).toContain(H(1000));
});

it('refuses a fixed raise with no recorded market price rather than emitting a default lot', async () => {
  const rpc = fakeRpc(), original = rpc.request.bind(rpc);
  rpc.request = (method, params) => method === 'eth_call' && params[0].data.startsWith(toFunctionSelector('getPool(address,address,uint24)'))
    ? Promise.resolve(H(0)) : original(method, params);
  const config = { ...input(), tokens: [{ token: PLAIN, class: 'OTHER' }],
    raisePolicy: { kind: 'fixed', amounts: { [PLAIN]: '1000000' } } };
  const result = await buildListingKit(config, rpc, true);
  expect(result.safeBatch.transactions).toEqual([]);
  expect(result.coins[0].checks).toContainEqual(expect.objectContaining({ id: 'royalty-lot', status: 'fail' }));
});

it('withholds all artifacts when the lot-setting transaction reverts', async () => {
  const rpc = fakeRpc(), original = rpc.request.bind(rpc);
  const abi = parseAbi(['function multiSend(bytes)', 'function setRoyaltyLot(uint32,uint256)']);
  rpc.request = async (method, params) => {
    if (method === 'eth_call' && params.length === 3 && params[0].data !== '0x') {
      const decoded = decodeFunctionData({ abi, data: params[0].data });
      if (unpack(decoded.args[0]).some(c => c.data.startsWith(toFunctionSelector('setRoyaltyLot(uint32,uint256)')))) {
        throw new Error('synthetic lot-setting refusal');
      }
    }
    return original(method, params);
  };
  const result = await buildListingKit(input(), rpc, true);
  expect(result.safeBatch.transactions).toEqual([]);
  expect(result.royaltyLots.entries).toEqual([]);
  expect(result.multiSend).toBeNull();
});

it('uses six-decimal token units for the USDC listing batch', async () => {
  const rpc = fakeRpc(), original = rpc.request.bind(rpc);
  const slotAbi = parseAbi(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)']);
  // sqrt(2e-9) * Q96, integer square root: 2000 USDC per WETH.
  const value = 2n * (1n << 192n) / 1000000000n;
  let sqrt = value, next = (sqrt + 1n) / 2n;
  while (next < sqrt) { sqrt = next; next = (sqrt + value / sqrt) / 2n; }
  rpc.decimals.set(PLAIN, H(6));
  rpc.request = (method, params) => method === 'eth_call' && params[0].data === toFunctionSelector('slot0()')
    ? Promise.resolve(encodeFunctionResult({ abi: slotAbi, functionName: 'slot0', result: [sqrt, 0, 0, 1, 1, 0, true] }))
    : original(method, params);
  const result = await buildListingKit({ ...input(), tokens: [{ token: PLAIN, class: 'STABLE', referenceAmount: '1000000' }],
    raisePolicy: { kind: 'fixed', amounts: { [PLAIN]: '1000000000' } } }, rpc, true);
  expect(result.coins[0].eligible).toBe(true);
  expect(result.royaltyLots.entries[0].lot).toBe('100000000');
  const abi = parseAbi(['function setRoyaltyLot(uint32,uint256)']);
  expect(decodeFunctionData({ abi, data: result.safeBatch.transactions[2].data }).args).toEqual([1, 100000000n]);
});
