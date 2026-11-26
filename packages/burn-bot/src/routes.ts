import { encodeAbiParameters, encodeFunctionData, encodePacked, parseAbi, zeroAddress, type Hex } from 'viem';
import type { Manifest, SafeCall } from './types';
import { requireThat } from './schema';

// Third-party execution interfaces; project/quoter ABIs are imported from packages/chain.
export const universalRouterAbi = parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable']);
export const permit2Abi = parseAbi(['function approve(address token,address spender,uint160 amount,uint48 expiration)']);
export const v4SwapParams = [{ type: 'tuple', components: [
  { name: 'currencyIn', type: 'address' }, { name: 'path', type: 'tuple[]', components: [
    { name: 'intermediateCurrency', type: 'address' }, { name: 'fee', type: 'uint24' },
    { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }, { name: 'hookData', type: 'bytes' },
  ] }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' },
] }] as const;
export const v4HopSwapParams = [{ type: 'tuple', components: [
  ...v4SwapParams[0].components.slice(0, 2), { name: 'minHopPriceX36', type: 'uint256[]' },
  ...v4SwapParams[0].components.slice(2),
] }] as const;
type Route = Manifest['routes'][number];
export function v3Path(route: Extract<Route, { kind: 'v3' }>): Hex {
  let path: Hex = route.path[0] as Hex;
  for (let i = 0; i < route.fees.length; i++) {
    const fee = route.fees[i], token = route.path[i + 1];
    requireThat(fee !== undefined && token, 'incomplete route path');
    path = `${path}${encodePacked(['uint24', 'address'], [fee, token]).slice(2)}`;
  }
  return path;
}
export const v4Path = (route: Extract<Route, { kind: 'v4' }>) => route.path.map(p => ({ ...p,
  // Bounded ABI metadata, never monetary quantities.
  fee: parseInt(p.fee, 10), tickSpacing: parseInt(p.tickSpacing, 10), hookData: p.hookData as Hex,
}));
export function v4Calls(route: Extract<Route, { kind: 'v4' }>, amount: bigint, minimum: bigint, deadline: bigint): SafeCall[] {
  requireThat(amount < 2n ** 128n && minimum < 2n ** 128n && deadline < 2n ** 48n, 'v4 ABI bounds');
  const params = { currencyIn: route.tokenIn, path: v4Path(route), amountIn: amount, amountOutMinimum: minimum };
  const swap = route.routerVersion === 'UniversalRouter-v2' ? encodeAbiParameters(v4SwapParams, [params])
    : encodeAbiParameters(v4HopSwapParams, [{ ...params, minHopPriceX36: [] }]);
  // SETTLE_ALL pays exact input; TAKE_ALL delivers output to UniversalRouter's locked msgSender (the Safe).
  // No allow-revert bit, intermediate router custody, arbitrary recipient, or partial input accounting.
  const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ['0x070c0f', [swap,
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [route.tokenIn, amount]),
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [route.tokenOut, minimum]),
  ]]);
  const inputs = [input];
  if (route.tokenIn === zeroAddress) inputs.push(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [zeroAddress, '0x0000000000000000000000000000000000000001', 0n]));
  const swapCall: SafeCall = { to: route.router, value: route.tokenIn === zeroAddress ? amount : 0n, operation: 0,
    data: encodeFunctionData({ abi: universalRouterAbi, functionName: 'execute', args: [route.tokenIn === zeroAddress ? '0x1004' : '0x10', inputs, deadline] }) };
  if (route.tokenIn === zeroAddress) return [swapCall];
  const permit = (value: bigint, expiration: number): SafeCall => ({ to: route.permit2, value: 0n, operation: 0,
    data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [route.tokenIn, route.router, value, expiration] }) });
  // uint48 timestamp is exact as a JS integer; the amount always remains bigint.
  return [permit(amount, parseInt(deadline.toString(), 10)), swapCall, permit(0n, 0)];
}
