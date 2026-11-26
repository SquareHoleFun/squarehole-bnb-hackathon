import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, encodeErrorResult, encodeAbiParameters, parseAbiParameters,
  keccak256, parseAbi, toHex, zeroHash, type Abi, type Address, type Hex } from 'viem';
import { registryV2Abi, royaltyRouterV2Abi, listingRegistryV2Abi } from '../../chain/src/core/v2/abi-v2';
import { synthManifestV2 } from '../../chain/src/core/v2/test-support/synth-v2';
import { RpcChain, cowAbi, inboxOrderAbi, settlementAbi, type RpcReader } from '../src/chain';

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const inbox = address(1), coin = address(2), cow = address(3), settlement = address(4), handler = address(5);
const manifest = synthManifestV2();
const release = manifest.releases[0];
if (!release) throw new Error('fixture release missing');
const registryAddress = release.registry.address, listingsAddress = release.listingRegistry.address;
const params = { handler, salt: zeroHash, staticInput: encodeAbiParameters(parseAbiParameters('address'), [coin]) };
function fixture() {
  const calls: { to: Address; name: string; args: readonly unknown[]; block: bigint }[] = [];
  const rawOrder = { sellToken: coin, buyToken: address(6), receiver: inbox, sellAmount: 100_000_000n,
    buyAmount: 1n, validTo: 7200, appData: zeroHash, feeAmount: 0n, kind: keccak256(toHex('sell')),
    partiallyFillable: false, sellTokenBalance: keccak256(toHex('erc20')), buyTokenBalance: keccak256(toHex('erc20')) };
  let failure: Hex | null = null;
  const rpc: RpcReader = { chainId: async () => 31337, blockNumber: async () => 88n,
    call: async (to, data, block) => {
      let abi: Abi;
      if (to === registryAddress) abi = registryV2Abi;
      else if (to === listingsAddress) abi = listingRegistryV2Abi;
      else if (to === cow) abi = cowAbi;
      else if (to === settlement) abi = settlementAbi;
      else abi = [...royaltyRouterV2Abi, ...inboxOrderAbi];
      const { functionName: name, args = [] } = decodeFunctionData({ abi, data });
      calls.push({ to, name, args, block });
      let result: unknown;
      switch (name) {
        case 'boxCount': result = 2n; break;
        case 'roleOf': if (args[0] === 0n) throw new Error('unreadable box'); result = inbox; break;
        case 'listingRegistry': result = listingsAddress; break;
        case 'listVersion': result = 3n; break;
        case 'sellableCount': result = 2n; break;
        case 'sellableToken': result = args[0] === 0n ? coin : address(9); break;
        case 'lotSize': result = args[0] === coin ? 1_000_000n : 0n; break;
        case 'orderRegistered': result = true; break;
        case 'composableCow': result = cow; break;
        case 'settlement': result = settlement; break;
        // The inbox's own orderParams(coin): (cowHandler, zero salt, abi.encode(coin)).
        case 'orderParams': result = params; break;
        case 'domainSeparator': result = zeroHash; break;
        case 'getTradeableOrderWithSignature':
          if (failure) throw { cause: { data: failure } };
          result = [rawOrder, '0xabcd']; break;
        default: throw new Error(`unexpected ${name}`);
      }
      return encodeFunctionResult({ abi, functionName: name, result });
    } };
  return { chain: new RpcChain(rpc, manifest), calls, fail: (data: Hex) => { failure = data; }, rawOrder };
}
describe('manifest registry and per-coin discovery', () => {
  it('uses role 8, the frozen list version and per-coin lots; isolates a broken box', async () => {
    const f = fixture(); const found = await f.chain.discover();
    expect(found.errors).toBe(1);
    expect(found.targets).toEqual([{ inbox, coin, composableCow: cow, settlement, params }]);
    expect(f.calls).toContainEqual({ to: registryAddress, name: 'roleOf', args: [1n, 8n], block: 88n });
    expect(f.calls).toContainEqual({ to: listingsAddress, name: 'sellableCount', args: [3n], block: 88n });
    expect(f.calls.every(c => c.block === 88n)).toBe(true);
  });
  it('calls ComposableCoW with the contract params, empty input/proof and reads its settlement domain', async () => {
    const f = fixture(); const { targets } = await f.chain.discover();
    const target = targets[0]; if (!target) throw new Error('target missing');
    expect(await f.chain.tradeable(target)).toEqual({ type: 'order', order: f.rawOrder, signature: '0xabcd', domainSeparator: zeroHash });
    expect(f.calls).toContainEqual({ to: cow, name: 'getTradeableOrderWithSignature', args: [inbox, params, '0x', []], block: 88n });
  });
  it.each(['PollTryAtEpoch', 'PollTryNextBlock', 'OrderNotValid'] as const)('decodes nested %s revert data without logging reasons', async name => {
    const f = fixture(); const { targets } = await f.chain.discover();
    f.fail(encodeErrorResult({ abi: cowAbi, errorName: name, args: name === 'OrderNotValid' ? ['secret reason'] : [99n, 'secret reason'] }));
    const target = targets[0]; if (!target) throw new Error('target missing');
    const result = await f.chain.tradeable(target);
    expect(result).toEqual(name === 'PollTryAtEpoch' ? { type: name, epoch: 99n } : name === 'PollTryNextBlock' ? { type: name, block: 99n } : { type: name });
  });
  it('turns a reason-only PollTryNextBlock into the next observed block', async () => {
    const f = fixture(); const { targets } = await f.chain.discover();
    const target = targets[0]; if (!target) throw new Error('target missing');
    f.fail(encodeErrorResult({ abi: parseAbi(['error PollTryNextBlock(string reason)']),
      errorName: 'PollTryNextBlock', args: ['not ready'] }));
    expect(await f.chain.tradeable(target)).toEqual({ type: 'PollTryNextBlock', block: 89n });
  });
});
