import { expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, zeroAddress, type Address, type Hex } from 'viem';
import { listingRegistryV2Abi, receiverV2Abi, royaltyRouterV2Abi } from './abi-v2';
import { claimRoyaltyInKindCallV21, observeRoyaltyCoinCallV21, readInboxCoinsV21, readRoyaltyStateV21 } from './royalty-v21';
import { assertSendableCallV2, type WriteTargetV2 } from './write-calls-v2';
const a = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const target: WriteTargetV2 = { chainId: 1, coordinator: a(1), token: a(2), receiver: a(3), royaltyRouter: a(8), p: a(9) };
it('COW-2 prepares a public coin observation only at the inbox, without value or a recipient', () => {
  const call = observeRoyaltyCoinCallV21(target, a(66));
  expect(decodeFunctionData({ abi: royaltyRouterV2Abi, data: call.data })).toMatchObject({ functionName: 'observe', args: [a(66)] });
  expect(() => assertSendableCallV2(call, target, a(77))).not.toThrow();
  expect(() => assertSendableCallV2({ ...call, to: target.receiver }, target, a(77))).toThrow();
  expect(() => assertSendableCallV2({ ...call, value: 1n }, target, a(77))).toThrow();
  expect(() => assertSendableCallV2({ ...call, data: `${call.data}00` }, target, a(77))).toThrow();
  expect(() => observeRoyaltyCoinCallV21({ ...target, royaltyRouter: undefined }, a(66))).toThrow();
});
it('reads silent receipts at one canonical hash and deduplicates WETH-priced custody', async () => {
  const hash = `0x${'ab'.repeat(32)}` as Hex;
  const readAssets: Address[] = [];
  const state = await readRoyaltyStateV21({ callAt: async (to, data, at) => {
    expect(at).toBe(hash);
    if (to === target.receiver) return encodeFunctionResult({ abi: receiverV2Abi, functionName: 'creatorPayee', result: a(11) });
    expect(to).toBe(target.royaltyRouter);
    const decoded = decodeFunctionData({ abi: royaltyRouterV2Abi, data });
    if (decoded.functionName === 'weth') return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'weth', result: target.p });
    if (decoded.functionName !== 'heldBalance') throw new Error('unexpected read');
    readAssets.push(decoded.args[0]);
    return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'heldBalance', result: 2n ** 200n });
  } }, a(8), target.receiver, target.p, target.token, hash);
  expect(readAssets.sort()).toEqual([zeroAddress, target.p, target.token].sort());
  expect(state.payee).toBe(a(11));
  expect(Object.values(state.balances)).toEqual([2n ** 200n, 2n ** 200n, 2n ** 200n]);
  expect(state.complete).toBe(true);
});
it('RC6RR-FC-1: a coin whose balance the inbox cannot read is left out as unknown, never failing the custody read', async () => {
  const hash = `0x${'ab'.repeat(32)}` as Hex;
  const weth = a(12);
  const state = await readRoyaltyStateV21({ callAt: async (to, data) => {
    if (to === target.receiver) return encodeFunctionResult({ abi: receiverV2Abi, functionName: 'creatorPayee', result: a(11) });
    const decoded = decodeFunctionData({ abi: royaltyRouterV2Abi, data });
    if (decoded.functionName === 'weth') return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'weth', result: weth });
    if (decoded.functionName !== 'heldBalance') throw new Error('unexpected read');
    // The router's own refusal of an outside P (`TokenUnreadable`): a revert, a short word or more than 50,000 gas.
    if (decoded.args[0].toLowerCase() === target.p.toLowerCase()) throw Object.assign(new Error('execution reverted'), { code: 3 });
    return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'heldBalance', result: 7n });
  } }, a(8), target.receiver, target.p, target.token, hash);
  expect(state.complete).toBe(false);
  expect(Object.keys(state.balances).sort()).toEqual([zeroAddress, weth.toLowerCase(), target.token.toLowerCase()].sort());
  expect(Object.values(state.balances)).toEqual([7n, 7n, 7n]);
});
it('claims non-price royalties only at the prepared royalty role, with no chosen destination', () => {
  const call = claimRoyaltyInKindCallV21(target, target.token);
  expect(() => assertSendableCallV2(call, target, a(11))).not.toThrow();
  expect(decodeFunctionData({ abi: royaltyRouterV2Abi, data: call.data })).toMatchObject({ functionName: 'claimInKind', args: [target.token] });
  expect(() => claimRoyaltyInKindCallV21(target, target.p)).toThrow();
  expect(() => assertSendableCallV2({ ...call, to: target.receiver }, target, a(11))).toThrow();
  expect(() => assertSendableCallV2({ ...call, value: 1n }, target, a(11))).toThrow();
});
it('refuses absent, zero or overlapping prepared royalty roles', () => {
  for (const royaltyRouter of [undefined, zeroAddress, target.receiver]) {
    const bad = { ...target, royaltyRouter };
    expect(() => {
      const call = claimRoyaltyInKindCallV21(bad, target.token);
      assertSendableCallV2(call, bad, a(11));
    }).toThrow();
  }
});
it('RC6 prepares a permissionless refresh with no ETH or recipient override', async () => {
  const royalty = await import('./royalty-v21');
  const call = royalty.refreshRoyaltyOrderCallV21(target);
  expect(() => assertSendableCallV2(call, target, a(77))).not.toThrow();
  expect(decodeFunctionData({ abi: royaltyRouterV2Abi, data: call.data }).functionName).toBe('refreshOrder');
  expect(() => assertSendableCallV2({ ...call, value: 1n }, target, a(77))).toThrow();
});
it('reads CoW release wiring, lot and wait at the same canonical hash without rounding', async () => {
  const { readRoyaltyCowStateV21 } = await import('./royalty-v21');
  const hash = `0x${'cd'.repeat(32)}` as Hex;
  const state = await readRoyaltyCowStateV21({ callAt: async (to, data, at) => {
    expect(to).toBe(target.royaltyRouter); expect(at).toBe(hash);
    const { functionName } = decodeFunctionData({ abi: royaltyRouterV2Abi, data });
    if (functionName === 'lotSize' || functionName === 'oldestUnsoldAt') {
      return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName, result: 2n ** 200n });
    }
    if (functionName === 'orderRegistered') return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName, result: true });
    if (functionName === 'composableCow' || functionName === 'settlement' || functionName === 'cowHandler' || functionName === 'vaultRelayer') {
      return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName, result: a(55) });
    }
    throw new Error('unexpected read');
  } }, a(8), hash);
  expect(state).toEqual({ composableCow: a(55), settlement: a(55), handler: a(55), vaultRelayer: a(55),
    lotSize: 2n ** 200n, oldestUnsoldAt: 2n ** 200n, orderRegistered: true });
});
it('IN02 prepares the selected listed coin refresh without signing an order', async () => {
  const { refreshRoyaltyOrderCallV21 } = await import('./royalty-v21');
  const coin = a(66);
  const call = refreshRoyaltyOrderCallV21(target, coin);
  expect(decodeFunctionData({ abi: royaltyRouterV2Abi, data: call.data })).toMatchObject({ functionName: 'refreshOrder', args: [coin] });
  expect(() => assertSendableCallV2(call, target, a(77))).not.toThrow();
});
it('IN08 reads a coin lot and frozen list version at one hash with bigint precision', async () => {
  const { readRoyaltyCowCoinStateV21 } = await import('./royalty-v21');
  const hash = `0x${'ef'.repeat(32)}` as Hex;
  const coin = a(66);
  const state = await readRoyaltyCowCoinStateV21({ callAt: async (to, data, at) => {
    expect(to).toBe(a(8)); expect(at).toBe(hash);
    const call = decodeFunctionData({ abi: royaltyRouterV2Abi, data });
    const functionName = call.functionName;
    if (functionName === 'listVersion') return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName, result: 55n });
    if (functionName === 'listingRegistry') return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName, result: a(55) });
    expect(call.args).toEqual([coin]);
    if (functionName === 'orderRegistered') return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName, result: true });
    if (functionName === 'lotSize' || functionName === 'oldestUnsoldAt') return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName, result: 2n ** 200n });
    throw new Error('unexpected read');
  } }, a(8), coin, hash);
  expect(state).toEqual({ coin, lotSize: 2n ** 200n, oldestUnsoldAt: 2n ** 200n, orderRegistered: true, listingRegistry: a(55), listVersion: 55n });
});
it('RC6: reads the frozen sellable list at one hash, skips lot-zero rows and marks an unreadable coin incomplete', async () => {
  const hash = `0x${'cd'.repeat(32)}` as Hex;
  const registry = a(20); const [usdc, link, own, broken] = [a(21), a(22), a(23), a(24)];
  const rows = [usdc, link, own, broken];
  const reader = { callAt: async (to: Address, data: Hex, at: Hex) => {
    expect(at).toBe(hash);
    if (to === registry) {
      const d = decodeFunctionData({ abi: listingRegistryV2Abi, data });
      if (d.functionName === 'sellableCount') { expect(d.args).toEqual([3n]); return encodeFunctionResult({ abi: listingRegistryV2Abi, functionName: 'sellableCount', result: 4n }); }
      if (d.functionName === 'sellableToken') {
        const row = rows[Number(d.args[0])];
        if (!row) throw new Error('sellable row out of range');
        return encodeFunctionResult({ abi: listingRegistryV2Abi, functionName: 'sellableToken', result: row });
      }
      throw new Error('unexpected registry read');
    }
    expect(to).toBe(target.royaltyRouter);
    const d = decodeFunctionData({ abi: royaltyRouterV2Abi, data });
    const coin = (d.args as readonly Address[] | undefined)?.[0];
    if (coin === broken && d.functionName !== 'lotSize') throw new Error('token refused balanceOf');
    switch (d.functionName) {
      case 'listingRegistry': return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'listingRegistry', result: registry });
      case 'listVersion': return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'listVersion', result: 3n });
      case 'lotSize': return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'lotSize', result: coin === own ? 0n : 100n } as never);
      case 'heldBalance': return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'heldBalance', result: coin === usdc ? 2n ** 200n : 7n });
      case 'oldestUnsoldAt': return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'oldestUnsoldAt', result: coin === usdc ? 1000n : 0n } as never);
      case 'orderRegistered': return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'orderRegistered', result: coin === usdc } as never);
      default: throw new Error(`unexpected ${d.functionName}`);
    }
  } };
  expect(await readInboxCoinsV21(reader, a(8), hash)).toEqual({ listVersion: 3n, complete: false, coins: [
    { coin: usdc, lot: 100n, balance: 2n ** 200n, oldestUnsoldAt: 1000n, registered: true, belowOneLot: false },
    { coin: link, lot: 100n, balance: 7n, oldestUnsoldAt: 0n, registered: false, belowOneLot: true },
  ] });
  // A known in-kind coin has no sale lot but still belongs in the money view.
  expect((await readInboxCoinsV21(reader, a(8), hash, [own])).coins).toContainEqual({
    coin: own, lot: 0n, balance: 7n, oldestUnsoldAt: 0n, registered: false, belowOneLot: false,
  });
});
