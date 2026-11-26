import { zeroAddress, type Address, type Hex } from 'viem';
import type { Manifest, Snapshot, ReceiptLot, Quote, Role } from '../src/types';

export const addr = (n: bigint): Address => `0x${n.toString(16).padStart(40, '0')}`;
export const hash = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;
export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing fixture/result');
  return value;
}
export const safeConfigs = {
  fit: { version: '1.4.1' as const, codeHash: hash(101n), singleton: addr(20n), singletonCodeHash: hash(20n),
    guard: zeroAddress, guardCodeHash: hash(0n), handler: zeroAddress, handlerCodeHash: hash(0n) },
};
export const manifest: Manifest = {
  policyVersion: 'cq11-e2-1', chainId: 1n,
  safes: { fit: addr(1n) },
  owners: { bot: addr(4n), founder: addr(5n), backup: addr(6n) }, safeConfigs,
  multiSend: { address: addr(7n), codeHash: hash(7n), version: '1.4.1-call-only' },
  weth: addr(8n), wethCodeHash: hash(8n),
  box0: { coordinator: addr(9n), executor: addr(10n), fit: addr(11n) },
  boxes: [{ id: '1', receiver: addr(12n), p: addr(13n) }, { id: '2', receiver: addr(14n), p: zeroAddress }],
  assetDecimals: { [addr(8n)]: '18', [addr(11n)]: '18', [addr(13n)]: '18', [addr(15n)]: '18' },
  routes: [
    { id: 'coin-eth', version: '1', kind: 'v3', tokenIn: addr(15n), tokenOut: zeroAddress,
      router: addr(16n), codeHash: hash(16n), routerVersion: 'SwapRouter-v1',
      path: [addr(15n), addr(8n)], fees: [3000], maxInput: 1000n, maxDailyInput: 2000n, slippageBps: 100n, quoteLifetime: 300n },
    { id: 'fit-p', version: '1', kind: 'v3', tokenIn: addr(11n), tokenOut: zeroAddress,
      router: addr(16n), codeHash: hash(16n), routerVersion: 'SwapRouter-v1',
      path: [addr(11n), addr(8n)], fees: [3000], maxInput: 1000n, maxDailyInput: 2000n, slippageBps: 100n, quoteLifetime: 300n },
    { id: 'weth-eth', version: '1', kind: 'unwrap', tokenIn: addr(8n), tokenOut: zeroAddress,
      router: addr(17n), codeHash: hash(17n), routerVersion: 'SwapRouter02',
      maxInput: 1000n, maxDailyInput: 2000n, slippageBps: 0n, quoteLifetime: 300n },
  ],
  limits: { maxActionsPerDay: 20n, maxGasPerDay: 2000000n, transactionGas: 200000n, maxFeePerGas: 100n },
};
export function snapshot(role: Role = 'fit'): Snapshot {
  const config = safeConfigs[role];
  return {
    chainId: 1n, block: { number: 100n, hash: hash(100n), timestamp: 100000n }, canonical: true, finalized: true,
    safe: manifest.safes[role], nonce: 0n, owners: Object.values(manifest.owners),
    threshold: 2n, version: config.version, singleton: config.singleton, modules: [], guard: config.guard, fallbackHandler: config.handler,
    codeHashes: { [manifest.safes[role]]: config.codeHash, [config.singleton]: config.singletonCodeHash,
      ...(config.guard !== zeroAddress ? { [config.guard]: config.guardCodeHash } : {}),
      ...(config.handler !== zeroAddress ? { [config.handler]: config.handlerCodeHash } : {}), [addr(7n)]: hash(7n), [addr(8n)]: hash(8n), [addr(16n)]: hash(16n), [addr(17n)]: hash(17n) },
    box0: { ...manifest.box0, graduated: true, failed: false },
    boxes: manifest.boxes.map(b => ({ ...b, phase: 'graduated' as const })),
    balances: { [zeroAddress]: 10000n, [addr(11n)]: 10000n, [addr(15n)]: 10000n, [addr(8n)]: 10000n, [addr(13n)]: 10000n },
  };
}
export function lot(role: Role = 'fit', asset = addr(15n), id = 'lot-1'): ReceiptLot {
  return { id, role, chainId: 1n, safe: manifest.safes[role], asset, amount: 1000n, decimals: '18',
    boxId: null, receiver: null,
    kind: 'fee',
    source: { txHash: hash(22n), logIndex: 1n, blockNumber: 90n, blockHash: hash(90n), timestamp: 99900n },
  };
}
export function quote(routeId = 'coin-eth'): Quote {
  const route = manifest.routes.find(r => r.id === routeId);
  if (!route) throw new Error('fixture route');
  return { chainId: 1n, routeId, routeVersion: '1', tokenIn: route.tokenIn, tokenOut: route.tokenOut,
    amountIn: 100n, quotedOut: 200n, block: snapshot().block, deadline: 100200n };
}
