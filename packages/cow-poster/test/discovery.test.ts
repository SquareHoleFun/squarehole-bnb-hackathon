import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, getAddress, keccak256, parseAbi, parseAbiParameters,
  toHex, zeroAddress, zeroHash, type Abi, type Address } from 'viem';
import { registryV2Abi, royaltyRouterV2Abi, listingRegistryV2Abi } from '../../chain/src/core/v2/abi-v2';
import { synthManifestV2 } from '../../chain/src/core/v2/test-support/synth-v2';
import { RpcChain, cowAbi, settlementAbi, type RpcReader } from '../src/chain';

/**
 * R1-1 (SH-V21-RC6-INT part 2 fix round): each inbox registers its orders with ComposableCoW.create(params, false), so
 * ComposableCoW emits no ConditionalOrderCreated and CoW's own watch tower never relays them. The poster has to find
 * every registered order from the inbox's own views: the frozen sale list, orderRegistered(coin) and orderParams(coin).
 */
// Checksummed, as viem decodes every address the poster reads back.
const address = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const manifest = synthManifestV2();
const release = manifest.releases[0];
if (!release) throw new Error('fixture release missing');
const registry = release.registry.address, listings = release.listingRegistry.address;
const [WETH, USDC, LINK, WBTC] = [address(0x10), address(0x11), address(0x12), address(0x13)];
const cow = address(0x20), settlement = address(0x21), handler = address(0x22);
const inboxA = address(0xa1), inboxB = address(0xb1);
// The registry's append-only sale list with each coin's first lot version (ListingRegistry._recordLot).
const sellable: readonly (readonly [Address, bigint])[] = [[WETH, 1n], [USDC, 2n], [LINK, 5n], [WBTC, 9n]];
const inboxViews = parseAbi([
  'struct ConditionalOrderParams { address handler; bytes32 salt; bytes staticInput; }',
  'function orderParams(address coin) view returns (ConditionalOrderParams)',
]);
interface Inbox { readonly version: bigint; readonly lots: ReadonlyMap<Address, bigint>; readonly registered: ReadonlySet<Address> }
// Box 0: priced in USDC, froze version 5 (WETH, USDC, LINK); WETH registered, LINK listed but never refreshed.
// Box 1: an older box without role 8. Box 2: priced in ETH, froze version 9; USDC and WBTC registered, LINK not.
const inboxes = new Map<Address, Inbox>([
  [inboxA, { version: 5n, lots: new Map([[WETH, 5n * 10n ** 16n], [LINK, 10n ** 18n]]), registered: new Set([WETH]) }],
  [inboxB, { version: 9n, lots: new Map([[USDC, 10n ** 6n], [LINK, 10n ** 18n], [WBTC, 10n ** 8n]]), registered: new Set([USDC, WBTC]) }],
]);
const roles = [inboxA, zeroAddress, inboxB];
// A distinct salt per order proves the poster uses each inbox's own answer, not a copy of the inbox's rule.
const paramsOf = (inbox: Address, coin: Address) => ({ handler, salt: keccak256(toHex(`${inbox}:${coin}`)),
  staticInput: encodeAbiParameters(parseAbiParameters('address'), [coin]) });
const order = (inbox: Address, coin: Address) => ({ sellToken: coin, buyToken: WETH, receiver: inbox, sellAmount: 10n ** 18n,
  buyAmount: 1n, validTo: 7200, appData: zeroHash, feeAmount: 0n, kind: keccak256(toHex('sell')), partiallyFillable: false,
  sellTokenBalance: keccak256(toHex('erc20')), buyTokenBalance: keccak256(toHex('erc20')) });

function fixture() {
  const calls: { to: Address; name: string; args: readonly unknown[] }[] = [];
  const base: RpcReader = { chainId: async () => 31337, blockNumber: async () => 88n,
    call: async (to, data) => {
      to = getAddress(to);
      const inbox = inboxes.get(to);
      const abi: Abi = same(to, registry) ? registryV2Abi : same(to, listings) ? listingRegistryV2Abi : to === cow ? cowAbi
        : to === settlement ? settlementAbi : [...royaltyRouterV2Abi, ...inboxViews];
      const { functionName: name, args = [] } = decodeFunctionData({ abi, data });
      calls.push({ to, name, args });
      const coin = typeof args[0] === 'string' ? getAddress(args[0]) : zeroAddress;
      let result: unknown;
      switch (name) {
        case 'boxCount': result = BigInt(roles.length); break;
        case 'roleOf': result = roles[Number(args[0])]; break;
        case 'sellableCount': result = BigInt(sellable.filter(([, first]) => first <= (args[0] as bigint)).length); break;
        case 'sellableToken': result = sellable[Number(args[0])]?.[0]; break;
        case 'listingRegistry': result = listings; break;
        case 'listVersion': result = inbox?.version; break;
        case 'composableCow': result = cow; break;
        case 'settlement': result = settlement; break;
        case 'cowHandler': result = handler; break;
        case 'lotSize': result = inbox?.lots.get(coin) ?? 0n; break;
        case 'orderRegistered': result = inbox?.registered.has(coin) ?? false; break;
        case 'orderParams': result = paramsOf(to, coin); break;
        case 'getTradeableOrderWithSignature': result = [order(coin, decodeCoin(args[1])), '0x1271']; break;
        case 'domainSeparator': result = zeroHash; break;
        default: throw new Error(`unexpected ${name}`);
      }
      if (result === undefined) throw new Error(`no fixture answer for ${name}`);
      return encodeFunctionResult({ abi, functionName: name, result });
    } };
  // The reader is eth_call only: no log, filter or subscription exists for discovery to consult.
  const rpc = new Proxy(base, { get(target, key) {
    if (key !== 'chainId' && key !== 'blockNumber' && key !== 'call') throw new Error(`unexpected reader access ${String(key)}`);
    return target[key as keyof RpcReader];
  } });
  return { chain: new RpcChain(rpc, manifest), calls };
}
function decodeCoin(params: unknown): Address {
  const staticInput = (params as { staticInput: `0x${string}` }).staticInput;
  return getAddress(`0x${staticInput.slice(-40)}`);
}

describe('R1-1: orders registered without ComposableCoW dispatch', () => {
  it('finds exactly the registered orders through the inbox views, each with its inbox’s own orderParams', async () => {
    const f = fixture();
    const { targets, errors } = await f.chain.discover();
    expect(errors).toBe(0);
    expect(targets).toEqual([
      { inbox: inboxA, coin: WETH, composableCow: cow, settlement, params: paramsOf(inboxA, WETH) },
      { inbox: inboxB, coin: USDC, composableCow: cow, settlement, params: paramsOf(inboxB, USDC) },
      { inbox: inboxB, coin: WBTC, composableCow: cow, settlement, params: paramsOf(inboxB, WBTC) },
    ]);
    // Each inbox's frozen list only: box 0 reads three rows, box 2 four; nothing listed after a box's version.
    expect(f.calls.filter(c => c.name === 'sellableToken').map(c => c.args[0])).toEqual([0n, 1n, 2n, 0n, 1n, 2n, 3n]);
    // Registration is read from the inbox itself, for every coin with a lot; discovery never asks ComposableCoW.
    expect(f.calls.filter(c => c.name === 'orderRegistered').map(c => [c.to, c.args[0]]))
      .toEqual([[inboxA, WETH], [inboxA, LINK], [inboxB, USDC], [inboxB, LINK], [inboxB, WBTC]]);
    expect(f.calls.filter(c => c.name === 'orderParams').map(c => [c.to, c.args[0]]))
      .toEqual([[inboxA, WETH], [inboxB, USDC], [inboxB, WBTC]]);
    expect(f.calls.some(c => c.to === cow)).toBe(false);
  });
  it('asks ComposableCoW for each order with exactly the parameters its inbox registered', async () => {
    const f = fixture();
    const { targets } = await f.chain.discover();
    expect(targets).toHaveLength(3);
    for (const target of targets) {
      const result = await f.chain.tradeable(target);
      expect(result).toMatchObject({ type: 'order', order: { sellToken: target.coin, receiver: target.inbox } });
      expect(f.calls).toContainEqual({ to: cow, name: 'getTradeableOrderWithSignature',
        args: [target.inbox, paramsOf(target.inbox, target.coin), '0x', []] });
    }
  });
});
