import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { v4QuoterAbi } from '../../chain/src/abi/v4Quoter';
import { requireChain, type QuoterConfig } from './config';
import { present, requireThat } from './schema';
import { pinnedSaleRoute } from './listing-routes';
import { v3Path, v4Path } from './routes';
import type { Manifest, Quote, Snapshot } from './types';

export interface QuoteSource { quote(routeId: string, amount: bigint, block: Snapshot['block']): Promise<Quote> }
export interface QuoteRpc {
  getChainId(): Promise<number>;
  getBlock(args: { blockNumber: bigint }): Promise<{ number: bigint | null; hash: Hex | null; timestamp: bigint }>;
  getCode(args: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>;
  call(args: { to: Address; data: Hex; blockNumber: bigint }): Promise<{ data?: Hex }>;
}
const routerFactoryAbi = parseAbi(['function factory() view returns (address)']);
const quoterV2Abi = parseAbi(['function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)']);
export class ViemQuoteSource implements QuoteSource {
  constructor(private manifest: Manifest, private quoters: QuoterConfig[], private rpc: QuoteRpc, allowMainnet = false) {
    requireChain(manifest.chainId, allowMainnet);
  }
  async quote(routeId: string, amount: bigint, block: Snapshot['block']): Promise<Quote> {
    requireThat(BigInt(await this.rpc.getChainId()) === this.manifest.chainId, 'quote RPC chain mismatch');
    const route = present(this.manifest.routes.find(r => r.id === routeId), 'unknown route');
    const pin = pinnedSaleRoute(this.manifest, route);
    requireThat(amount > 0n && amount <= route.maxInput, 'quote input bound');
    const canonical = await this.rpc.getBlock({ blockNumber: block.number });
    requireThat(canonical.hash === block.hash && canonical.timestamp === block.timestamp, 'quote block changed');
    if (pin) {
      const code = await this.rpc.getCode({ address: route.router, blockNumber: block.number });
      requireThat(code && keccak256(code) === route.codeHash, 'unverified listing route router');
      const result = await this.rpc.call({ to: route.router, blockNumber: block.number,
        data: encodeFunctionData({ abi: routerFactoryAbi, functionName: 'factory' }) });
      const factory = decodeFunctionResult({ abi: routerFactoryAbi, functionName: 'factory', data: present(result.data, 'empty listing route factory') });
      requireThat(factory.toLowerCase() === pin.factory.toLowerCase(), 'listing route factory mismatch');
    }
    let quotedOut = amount;
    if (route.kind !== 'unwrap') {
      const quoter = present(this.quoters.find(q => q.routeId === route.id && q.kind === route.kind), 'reviewed quoter required');
      const code = await this.rpc.getCode({ address: quoter.address, blockNumber: block.number });
      requireThat(code && keccak256(code) === quoter.codeHash, 'unverified quoter code');
      const abi = route.kind === 'v4' ? v4QuoterAbi : quoterV2Abi;
      requireThat(route.kind !== 'v4' || amount < 2n ** 128n, 'v4 input bound');
      const data = route.kind === 'v4'
        ? encodeFunctionData({ abi: v4QuoterAbi, functionName: 'quoteExactInput', args: [{ exactCurrency: route.tokenIn, path: v4Path(route), exactAmount: amount }] })
        : encodeFunctionData({ abi: quoterV2Abi, functionName: 'quoteExactInput', args: [v3Path(route), amount] });
      const result = await this.rpc.call({ to: quoter.address, data, blockNumber: block.number });
      quotedOut = decodeFunctionResult({ abi, functionName: 'quoteExactInput', data: present(result.data, 'empty quote') })[0];
    }
    requireThat(quotedOut * (10000n - route.slippageBps) / 10000n > 0n, 'zero quote minimum');
    requireThat((await this.rpc.getBlock({ blockNumber: block.number })).hash === block.hash, 'quote block changed');
    return { chainId: this.manifest.chainId, routeId, routeVersion: route.version, tokenIn: route.tokenIn,
      tokenOut: route.tokenOut, amountIn: amount, quotedOut, block, deadline: block.timestamp + route.quoteLifetime };
  }
}
