import { createPublicClient, decodeErrorResult, decodeFunctionResult, encodeFunctionData, http, parseAbi, zeroAddress,
  type Abi, type Address, type Hex } from 'viem';
import { registryV2Abi, royaltyRouterV2Abi, listingRegistryV2Abi } from '../../chain/src/core/v2/abi-v2';
import type { DeployedCoreManifestV2 } from '../../chain/src/core/v2/manifest-v2';
import type { ChainReader, Target, Tradeable } from './types';

/** External protocol interface from IRoyaltyCow.sol; box/listing ABIs come from the chain package. */
export const cowAbi = parseAbi([
  'struct ConditionalOrderParams { address handler; bytes32 salt; bytes staticInput; }',
  'struct CowOrder { address sellToken; address buyToken; address receiver; uint256 sellAmount; uint256 buyAmount; uint32 validTo; bytes32 appData; uint256 feeAmount; bytes32 kind; bool partiallyFillable; bytes32 sellTokenBalance; bytes32 buyTokenBalance; }',
  'function getTradeableOrderWithSignature(address owner, ConditionalOrderParams params, bytes offchainInput, bytes32[] proof) view returns (CowOrder order, bytes signature)',
  'error PollTryAtEpoch(uint256 epoch, string reason)',
  'error PollTryNextBlock(string reason)',
  'error PollTryNextBlock(uint256 blockNumber, string reason)',
  'error OrderNotValid(string reason)',
]);
export const settlementAbi = parseAbi(['function domainSeparator() view returns (bytes32)']);
/** BoxRoyaltyRouterV2.orderParams(coin): the exact parameters the inbox registered with ComposableCoW. The generated
 * chain ABI is the frozen IBoxRoyaltyRouterV2 interface, which leaves this view out. */
export const inboxOrderAbi = parseAbi([
  'struct ConditionalOrderParams { address handler; bytes32 salt; bytes staticInput; }',
  'function orderParams(address coin) view returns (ConditionalOrderParams)',
]);
export interface RpcReader {
  chainId(): Promise<number>;
  blockNumber(): Promise<bigint>;
  call(to: Address, data: Hex, block: bigint): Promise<Hex>;
}
export function rpcReader(url: string): RpcReader {
  const client = createPublicClient({ transport: http(url, { retryCount: 0, timeout: 20_000 }) });
  return { chainId: () => client.getChainId(), blockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    call: async (to, data, blockNumber) => {
      const response = await client.call({ to, data, blockNumber });
      if (!response.data) throw new Error('empty RPC data');
      return response.data;
    } };
}

function poll(error: unknown, observedBlock: bigint | undefined): Tradeable {
  // viem wraps RPC revert bytes in nested causes. Decode bytes only, never infer from an error message.
  let current = error;
  for (let depth = 0; depth < 12 && typeof current === 'object' && current !== null; depth++) {
    const value = current as { data?: unknown; cause?: unknown };
    if (typeof value.data === 'string' && /^0x[0-9a-fA-F]+$/.test(value.data)) {
      try {
        const decoded = decodeErrorResult({ abi: cowAbi, data: value.data as Hex });
        if (decoded.errorName === 'PollTryAtEpoch') return { type: 'PollTryAtEpoch', epoch: decoded.args[0] };
        if (decoded.errorName === 'PollTryNextBlock') {
          if (typeof decoded.args[0] === 'bigint') return { type: 'PollTryNextBlock', block: decoded.args[0] };
          if (observedBlock !== undefined) return { type: 'PollTryNextBlock', block: observedBlock + 1n };
        }
        if (decoded.errorName === 'OrderNotValid') return { type: 'OrderNotValid' };
      } catch { /* Unknown revert: no data this cycle. */ }
    }
    current = value.cause;
  }
  return { type: 'no_data' };
}

export class RpcChain implements ChainReader {
  constructor(private readonly rpc: RpcReader, private readonly manifest: DeployedCoreManifestV2) {}
  chainId() { return this.rpc.chainId(); }
  blockNumber() { return this.rpc.blockNumber(); }
  private async read<T>(to: Address, abi: Abi, functionName: string, args: readonly unknown[], block: bigint): Promise<T> {
    const data = await this.rpc.call(to, encodeFunctionData({ abi, functionName, args }), block);
    return decodeFunctionResult({ abi, functionName, data }) as T;
  }

  async discover(): Promise<{ targets: Target[]; errors: number }> {
    const targets: Target[] = [];
    let errors = 0;
    const block = await this.rpc.blockNumber();
    const seen = new Set<string>();
    for (const release of this.manifest.releases) {
      try {
        const count = await this.read<bigint>(release.registry.address, registryV2Abi, 'boxCount', [], block);
        for (let boxId = 0n; boxId < count; boxId++) {
          try {
            const inbox = await this.read<Address>(release.registry.address, registryV2Abi, 'roleOf', [boxId, 8n], block);
            if (inbox === zeroAddress) continue; // Older releases can lack the role.
            const read = <T>(name: string, args: readonly unknown[] = []) => this.read<T>(inbox, royaltyRouterV2Abi, name, args, block);
            const [registry, version, composableCow, settlement] = await Promise.all([
              read<Address>('listingRegistry'), read<bigint>('listVersion'), read<Address>('composableCow'), read<Address>('settlement'),
            ]);
            if (registry.toLowerCase() !== release.listingRegistry.address.toLowerCase()) throw new Error('listing registry mismatch');
            const coins = await this.read<bigint>(registry, listingRegistryV2Abi, 'sellableCount', [version], block);
            for (let i = 0n; i < coins; i++) {
              try {
                const coin = await this.read<Address>(registry, listingRegistryV2Abi, 'sellableToken', [i], block);
                const lot = await read<bigint>('lotSize', [coin]);
                if (lot === 0n) continue;
                // Registration and allowance refresh are permissionless keeper work, never transactions here.
                if (!await read<boolean>('orderRegistered', [coin])) continue;
                // The inbox registers with ComposableCoW.create(params, false): no ConditionalOrderCreated is emitted
                // (R1-1), so these views find every registered order, and its own orderParams(coin) names the order.
                const params = await this.read<Target['params']>(inbox, inboxOrderAbi, 'orderParams', [coin], block);
                const key = `${inbox}:${coin}`.toLowerCase();
                if (!seen.has(key)) { targets.push({ inbox, coin, composableCow, settlement, params }); seen.add(key); }
              } catch { errors++; }
            }
          } catch { errors++; }
        }
      } catch { errors++; }
    }
    return { targets, errors };
  }

  async tradeable(target: Target): Promise<Tradeable> {
    let block: bigint | undefined;
    try {
      block = await this.rpc.blockNumber();
      const data = await this.rpc.call(target.composableCow, encodeFunctionData({ abi: cowAbi,
        functionName: 'getTradeableOrderWithSignature', args: [target.inbox, target.params, '0x', []] }), block);
      const [order, signature] = decodeFunctionResult({ abi: cowAbi, functionName: 'getTradeableOrderWithSignature', data });
      const domainSeparator = await this.read<Hex>(target.settlement, settlementAbi, 'domainSeparator', [], block);
      return { type: 'order', order, signature, domainSeparator };
    } catch (error) { return poll(error, block); }
  }
}
