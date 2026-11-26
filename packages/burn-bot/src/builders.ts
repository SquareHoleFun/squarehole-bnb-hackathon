import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, keccak256, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { actionSchema, lotSchema, manifestSchema, present, requireThat, snapshotSchema } from './schema';
import { permit2Abi, universalRouterAbi, v3Path, v4Calls, v4HopSwapParams, v4SwapParams } from './routes';
import { pinnedSaleRoute } from './listing-routes';
import type { Draft, Manifest, ReceiptLot, Role, SafeCall, Snapshot } from './types';

export const tokenAbi = parseAbi(['function approve(address spender,uint256 amount) returns (bool)', 'function burn(uint256 amount)', 'function transfer(address recipient,uint256 amount) returns (bool)']);
export const executorAbi = parseAbi(['function fundBudget() payable']);
export const wethAbi = parseAbi(['function deposit() payable', 'function withdraw(uint256 amount)']);
export const deadlineRouterAbi = parseAbi(['function multicall(uint256 deadline,bytes[] data) payable returns (bytes[])']);
export const routerAbi = parseAbi([
  'function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256)',
  'function multicall(bytes[] data) payable returns (bytes[])',
  'function unwrapWETH9(uint256 amountMinimum,address recipient) payable',
]);
const call = (to: Address, data: Hex, value = 0n): SafeCall => ({ to, data, value, operation: 0 });
export function describeCalls(calls: readonly SafeCall[], routes: Manifest['routes'] = []): unknown[] {
  function describe(data: Hex, target?: Address): unknown {
    const decoded = decodeFunctionData({ abi: [...tokenAbi, ...executorAbi, ...wethAbi, ...routerAbi, ...deadlineRouterAbi, ...permit2Abi, ...universalRouterAbi], data });
    let v4: unknown;
    if (decoded.functionName === 'execute') {
      const route = routes.find(r => r.router === target && r.kind === 'v4');
      requireThat(route?.kind === 'v4', 'v4 description requires route manifest');
      const [actions, inputs] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], present(decoded.args[1][0], 'missing v4 input'));
      const swap = route.routerVersion === 'UniversalRouter-v2'
        ? decodeAbiParameters(v4SwapParams, present(inputs[0], 'missing swap'))[0]
        : decodeAbiParameters(v4HopSwapParams, present(inputs[0], 'missing swap'))[0];
      v4 = { actions, swap, recipient: 'calling-safe',
        settle: decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], present(inputs[1], 'missing settle')),
        take: decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], present(inputs[2], 'missing take')),
        refund: decoded.args[1][1] ? decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], decoded.args[1][1]) : null };
    }
    return { functionName: decoded.functionName, args: decoded.args ?? [], ...(v4 ? { v4 } : {}),
      ...(decoded.functionName === 'multicall' ? { inner: (decoded.args.at(-1) as readonly Hex[]).map(data => describe(data, target)) } : {}) };
  }
  return calls.map(c => ({ ...c, ...(describe(c.data, c.to) as object), calldataHash: keccak256(c.data) }));
}
const approval = (token: Address, spender: Address, amount: bigint) => call(token,
  encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [spender, amount] }));
function pullBatch(token: Address, spender: Address, amount: bigint, calls: SafeCall[]) {
  return [approval(token, spender, 0n), approval(token, spender, amount), ...calls, approval(token, spender, 0n)];
}
/** Native ETH has 18 decimals; token metadata is pinned with the chain's reviewed manifest, never inferred from an input lot. */
export function assetDecimals(m: Manifest, asset: Address): string {
  return asset === zeroAddress ? '18' : present(m.assetDecimals[asset], 'missing pinned asset decimals');
}
/** Validate a self-contained policy revision, including historical ones; current sale admission is separate. */
export function validateManifest(input: unknown): Manifest {
  const m = manifestSchema.parse(input);
  requireThat(m.assetDecimals[zeroAddress] === undefined || m.assetDecimals[zeroAddress] === '18', 'native ETH decimals must be 18');
  for (const asset of [m.weth, m.box0.fit, ...m.boxes.map(b => b.p), ...m.routes.flatMap(r => [r.tokenIn, r.tokenOut])]) {
    assetDecimals(m, asset);
  }
  requireThat(assetDecimals(m, m.weth) === '18', 'WETH decimals must be 18');
  const safes = Object.values(m.safes); const owners = Object.values(m.owners);
  const infrastructure = [...safes, ...owners, m.multiSend.address, m.weth, ...Object.values(m.box0)];
  requireThat(infrastructure.every(a => a !== zeroAddress), 'zero operational address');
  requireThat(new Set(infrastructure).size === infrastructure.length, 'overlapping custody/operational identities');
  requireThat(new Set(m.boxes.map(b => b.id)).size === m.boxes.length && new Set(m.boxes.map(b => b.receiver)).size === m.boxes.length, 'duplicate box identity');
  for (const box of m.boxes) requireThat(box.receiver !== zeroAddress && !infrastructure.includes(box.receiver), 'invalid fee receiver');
  requireThat(new Set(m.routes.map(r => r.id)).size === m.routes.length, 'duplicate route id');
  requireThat(new Set(m.routes.map(r => `${r.tokenIn}:${r.tokenOut}`)).size === m.routes.length, 'one fixed route per asset pair');
  for (const r of m.routes) {
    requireThat(m.routes.filter(other => other.router === r.router).every(other => other.codeHash === r.codeHash
      && other.routerVersion === r.routerVersion), 'inconsistent router pins');
    requireThat(r.tokenIn !== r.tokenOut && r.maxInput <= r.maxDailyInput, 'invalid route bounds');
    requireThat(r.router !== zeroAddress && !infrastructure.includes(r.router), 'invalid router');
    if (r.kind === 'unwrap') {
      requireThat(r.tokenIn === m.weth && r.tokenOut === zeroAddress && r.slippageBps === 0n, 'unwrap must be WETH 1:1');
    } else if (r.kind === 'v4') {
      requireThat(r.permit2 !== zeroAddress && r.permit2 !== r.router && !infrastructure.includes(r.permit2), 'invalid Permit2');
      const currencies = [r.tokenIn, ...r.path.map(p => p.intermediateCurrency)];
      requireThat(currencies.at(-1) === r.tokenOut && new Set(currencies).size === currencies.length, 'invalid v4 path');
      requireThat(r.maxInput < 2n ** 128n, 'v4 input bound');
    } else {
      requireThat(r.fees.length + 1 === r.path.length && r.path.every(a => a !== zeroAddress) && new Set(r.path).size === r.path.length, 'invalid path');
      requireThat(r.path[0] === (r.tokenIn === zeroAddress ? m.weth : r.tokenIn)
        && r.path.at(-1) === (r.tokenOut === zeroAddress ? m.weth : r.tokenOut), 'path/asset mismatch');
    }
  }
  requireThat(m.limits.transactionGas <= m.limits.maxGasPerDay, 'transaction exceeds daily gas budget');
  return m;
}
/** A fresh pinned snapshot is required again before co-signing/execution; no stale simulation is authority. */
export function validateSnapshot(m: Manifest, input: unknown, role: Role): Snapshot {
  const s = snapshotSchema.parse(input);
  requireThat(s.chainId === m.chainId && s.safe === m.safes[role], 'wrong chain or Safe');
  // The FIT Safe is 2-of-3: bot, founder, backup. The bot reads no other Safe (F164 D2), whatever its owners (F151).
  const expected = Object.values(m.owners);
  requireThat(s.threshold === 2n && s.owners.length === expected.length
    && new Set(s.owners).size === expected.length && expected.every(a => s.owners.includes(a)), 'Safe owner/threshold mismatch');
  const pin = m.safeConfigs[role];
  requireThat(s.version === pin.version && s.singleton === pin.singleton && s.modules.length === 0
    && s.guard === pin.guard && s.fallbackHandler === pin.handler
    && s.codeHashes[s.safe] === pin.codeHash && s.codeHashes[pin.singleton] === pin.singletonCodeHash
    && (pin.guard === zeroAddress || s.codeHashes[pin.guard] === pin.guardCodeHash)
    && (pin.handler === zeroAddress || s.codeHashes[pin.handler] === pin.handlerCodeHash), 'unreviewed Safe configuration');
  requireThat(s.codeHashes[m.multiSend.address] === m.multiSend.codeHash, 'unverified MultiSendCallOnly');
  return s;
}
export function validateLot(m: Manifest, input: unknown): ReceiptLot {
  const l = lotSchema.parse(input);
  requireThat(l.chainId === m.chainId && l.safe === m.safes[l.role], 'wrong receipt chain/Safe');
  requireThat(l.decimals === assetDecimals(m, l.asset), 'receipt asset decimals mismatch');
  requireThat(l.boxId === null && l.receiver === null && (l.kind === 'fee' || l.kind === 'proceeds'), 'fee custody mismatch');
  return l;
}

/** Admit new work under today's listing pin, including direct Safe calldata construction. */
export function buildAction(manifest: unknown, snapshot: unknown, source: unknown, request: unknown): Draft {
  const m = manifestSchema.parse(manifest), a = actionSchema.parse(request);
  if (a.kind === 'sale') {
    const route = m.routes.find(r => r.id === a.routeId);
    if (route) pinnedSaleRoute(m, route);
  }
  return reconstructAction(m, snapshot, source, a);
}

/**
 * Internal journal reconstruction under the recorded manifest and quote. This does not admit
 * new sales: planning, signing and direct Safe transaction builders must use buildAction.
 * Keep all custody, quote, bounds and calldata checks; only today's listing pin is inapplicable.
 */
export function reconstructAction(manifest: unknown, snapshot: unknown, source: unknown, request: unknown): Draft {
  const m = validateManifest(manifest); const l = validateLot(m, source);
  const s = validateSnapshot(m, snapshot, l.role); const a = actionSchema.parse(request);
  requireThat(a.lotId === l.id && a.amount <= l.amount && a.amount <= (s.balances[l.asset] ?? 0n), 'lot/balance/input ceiling');
  requireThat(l.source.blockNumber <= s.block.number && l.source.timestamp <= s.block.timestamp, 'receipt after snapshot');
  requireThat(Object.entries(m.box0).every(([k, v]) => s.box0[k as keyof typeof m.box0] === v), 'wrong box-0 wiring');
  requireThat(!s.box0.failed, 'box 0 failed; pause FIT path and alert owners');
  let calls: SafeCall[]; let minimumOut = 0n; let outputAsset = l.asset;
  if (a.kind === 'sale') {
    requireThat(l.kind !== 'proceeds', 'already converted: use confirmed output');
    requireThat(l.asset !== zeroAddress && l.asset !== m.box0.fit, 'FIT reserved for burn; native ETH needs no sale');
    const r = m.routes.find(r => r.id === a.routeId); const q = a.quote;
    requireThat(r && r.tokenIn === l.asset && r.tokenOut === zeroAddress, 'unknown or wrong asset route');
    requireThat(q.chainId === m.chainId && q.routeId === r.id && q.routeVersion === r.version
      && q.tokenIn === r.tokenIn && q.tokenOut === r.tokenOut && q.amountIn === a.amount, 'quote binding');
    requireThat(q.block.number <= s.block.number && q.block.timestamp <= s.block.timestamp
      && [s.block, ...(s.quoteBlocks ?? [])].some(b => b.number === q.block.number && b.hash === q.block.hash && b.timestamp === q.block.timestamp), 'quote must bind a verified canonical block');
    requireThat(q.deadline > s.block.timestamp && q.deadline <= q.block.timestamp + r.quoteLifetime, 'quote expired or lifetime exceeded');
    requireThat(a.amount <= r.maxInput, 'clip input ceiling');
    minimumOut = q.quotedOut * (10000n - r.slippageBps) / 10000n;
    requireThat(minimumOut > 0n, 'zero output minimum'); outputAsset = r.tokenOut;
    if (r.kind === 'unwrap') {
      requireThat(s.codeHashes[m.weth] === m.wethCodeHash && q.quotedOut === a.amount, 'unverified WETH unwrap');
      requireThat(s.codeHashes[r.router] === r.codeHash, 'unverified deadline router');
      calls = [call(m.weth, encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [r.router, a.amount] })),
        call(r.router, encodeFunctionData({ abi: deadlineRouterAbi, functionName: 'multicall', args: [q.deadline, [
          encodeFunctionData({ abi: routerAbi, functionName: 'unwrapWETH9', args: [a.amount, s.safe] }),
        ]] }))];
    } else if (r.kind === 'v4') {
      requireThat(s.codeHashes[r.router] === r.codeHash && s.codeHashes[r.permit2] === r.permit2CodeHash, 'unverified v4 router/Permit2');
      const swaps = v4Calls(r, a.amount, minimumOut, q.deadline);
      calls = pullBatch(r.tokenIn, r.permit2, a.amount, swaps);
    } else {
      requireThat(s.codeHashes[r.router] === r.codeHash, 'unverified router code');
      const path = v3Path(r);
      const swap = encodeFunctionData({ abi: routerAbi, functionName: 'exactInput', args: [{ path,
        recipient: r.router,
        deadline: q.deadline, amountIn: a.amount, amountOutMinimum: minimumOut }] });
      const data = encodeFunctionData({ abi: routerAbi, functionName: 'multicall', args: [[swap,
          encodeFunctionData({ abi: routerAbi, functionName: 'unwrapWETH9', args: [minimumOut, s.safe] })]] });
      calls = pullBatch(r.tokenIn, r.router, a.amount, [call(r.router, data)]);

    }
  } else {
    requireThat(s.box0.graduated === true, 'box 0 not graduated; hold in Safe');
    if (a.kind === 'fund') {
      requireThat(l.asset === zeroAddress, 'executor funding requires native ETH');
      calls = [call(m.box0.executor, encodeFunctionData({ abi: executorAbi, functionName: 'fundBudget' }), a.amount)];
    } else {
      requireThat(l.asset === m.box0.fit, 'only own FIT can burn');
      calls = [call(m.box0.fit, encodeFunctionData({ abi: tokenAbi, functionName: 'burn', args: [a.amount] }))];
    }
  }
  return { role: l.role, safe: s.safe, calls, source: l, request: a, inputAsset: l.asset, outputAsset, amountIn: a.amount, minimumOut };
}
