/**
 * End-to-end run on a LOCAL anvil fork of Sepolia (nothing is sent to Sepolia; the fork only reads its state through
 * the keyless public RPC; no keys: anvil's impersonation signs nothing). The rehearsal pool never traded after its
 * bootstrap buy, so this replays a launch on the fork: router buys at three window offsets (taxed), buys and sells
 * through v4's PoolSwapTest harness after the window, a collector flush (burn), then a forced reorg
 * (`anvil_rollback`) that removes a block with a trade. The service runs in this process against the fork's
 * websocket (newHeads) and HTTP endpoints, with the memory store or Redis, and an SSE client records what a viewer
 * would get. At the end the derived state is checked against the fork's slot0 and totalSupply at the head.
 *
 * Two bursts put `--burst` (default 32) swaps into ONE block each (interval mining paused, then `evm_mine`): router
 * buys inside the launch window (traders from TaxedBuy.buyer, no lookups) and PoolSwapTest buys after it (senders
 * from one eth_getBlockByHash). Their processing time is reported apart from ordinary blocks.
 *
 *   pnpm --filter @squarehole/indexer exec node --experimental-transform-types --no-warnings=ExperimentalWarning \
 *     --import ./scripts/register-ts.mjs scripts/fork-e2e.ts --out ../../docs/evidence/realtime-poc/fork-e2e.json
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { SEPOLIA_REHEARSAL, loadServiceConfig } from '../src/config';
import { startService } from '../src/service';
import type { BlockEvent, ReorgEvent } from '../src/views';
import { openSse } from '../test/sse-client';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const T = SEPOLIA_REHEARSAL;
const port = Number(arg('port', '8563'));
const forkBlock = arg('fork-block', (T.openBlock - 14n).toString());
const forkUrl = arg('fork-url', 'https://ethereum-sepolia-rpc.publicnode.com');
const out = arg('out', '');
const burst = Number(arg('burst', '32'));
const rpcUrl = `http://127.0.0.1:${port}`;
const POOL_SWAP_TEST: Address = '0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe';
const MIN_SQRT_PLUS_ONE = 4_295_128_740n;
const MAX_SQRT_MINUS_ONE = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341n;
const buyers: Address[] = ['0x00000000000000000000000000000000000b0b01', '0x00000000000000000000000000000000000b0b02', '0x00000000000000000000000000000000000b0b03', '0x00000000000000000000000000000000000b0b04', '0x00000000000000000000000000000000000b0b05'];

const routerAbi = parseAbi(['function buy(uint256 minTokensOut, address recipient, uint256 deadline) payable returns (uint256)']);
const tokenAbi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const collectorAbi = parseAbi(['function flush() returns (uint256, uint256, uint256)']);
const swapTestAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }',
  'struct TestSettings { bool takeClaims; bool settleUsingBurn; }',
  'function swap(PoolKey key, SwapParams params, TestSettings testSettings, bytes hookData) payable returns (int256)',
]);
const poolKey = { currency0: '0x0000000000000000000000000000000000000000' as Address, currency1: T.token, fee: 10_000, tickSpacing: 60, hooks: T.hook };

let rpcId = 0;
async function rpc<R>(method: string, params: unknown[] = []): Promise<R> {
  const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: (rpcId += 1), method, params }) });
  const body = (await res.json()) as { result?: R; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as R;
}

const head = async (): Promise<bigint> => BigInt(await rpc<Hex>('eth_blockNumber'));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitHead(atLeast: bigint): Promise<void> {
  while ((await head().catch(() => 0n)) < atLeast) await sleep(200);
}

interface Sent { label: string; hash: Hex; block: bigint | null; status: string }
const sent: Sent[] = [];
async function send(label: string, from: Address, to: Address, data: Hex, value = 0n): Promise<Sent> {
  const hash = await rpc<Hex>('eth_sendTransaction', [{ from, to, data, value: `0x${value.toString(16)}`, gas: '0x1e8480' }]);
  let receipt: { blockNumber: Hex; status: Hex } | null = null;
  while (!receipt) {
    await sleep(250);
    // The fork forwards unknown hashes to the remote RPC, which can reset a connection: keep polling.
    receipt = await rpc<{ blockNumber: Hex; status: Hex } | null>('eth_getTransactionReceipt', [hash]).catch(() => null);
  }
  const entry = { label, hash, block: BigInt(receipt.blockNumber), status: receipt.status === '0x1' ? 'ok' : 'reverted' };
  sent.push(entry);
  process.stdout.write(`${label}: block ${entry.block} ${entry.status}\n`);
  return entry;
}

const anvil = spawn(`${process.env['HOME']}/.foundry/bin/anvil`, ['--fork-url', forkUrl, '--fork-block-number', forkBlock, '--port', String(port), '--block-time', '2', '--silent'], { stdio: 'ignore' });
const stopAnvil = () => anvil.kill('SIGTERM');
process.on('exit', stopAnvil);
for (let i = 0; i < 100; i += 1) {
  try {
    await head();
    break;
  } catch {
    await sleep(300);
  }
}
process.stdout.write(`anvil fork of Sepolia at ${forkBlock} on ${port}; head ${await head()}\n`);
// Burst accounts: one per swap, so no two transactions of a burst share a nonce.
const burstAccounts = (offset: number): Address[] => Array.from({ length: burst }, (_, i) => `0x${(0xb0000 + offset + i).toString(16).padStart(40, '0')}` as Address);
for (const buyer of [...buyers, ...burstAccounts(0), ...burstAccounts(0x1000)]) {
  await rpc('anvil_setBalance', [buyer, '0x56BC75E2D63100000']); // 100 ETH (fork only)
  await rpc('anvil_impersonateAccount', [buyer]);
}

// This run replays the route rehearsal's launch (its fork block and contracts): the service follows that pool.
const config = { ...loadServiceConfig({ SH_POOL_TARGET: T.id, SH_STORE: arg('store', 'memory'), SH_INDEXER_PORT: '5396', SH_WS_URLS: `ws://127.0.0.1:${port}`, SH_HTTP_URLS: rpcUrl, SH_REDIS_URL: arg('redis', 'redis://127.0.0.1:5395/1'), SH_REDIS_NAMESPACE: 'fork-e2e' }) };
const service = await startService(config);
const base = `http://127.0.0.1:5396/v1/pools/${T.chainId}/${T.poolId}`;
const blocks: BlockEvent[] = [];
const received = new Map<string, number>();
const reorgs: ReorgEvent[] = [];
let tradersFrames = 0;
const stream = openSse(`${base}/stream`, {
  keep: false,
  onMessage: (m) => {
    if (m.event === 'block') {
      const event = JSON.parse(m.data) as BlockEvent;
      blocks.push(event);
      received.set(event.head.hash, m.receivedAtMs);
    }
    if (m.event === 'reorg') reorgs.push(JSON.parse(m.data) as ReorgEvent);
    if (m.event === 'traders') tradersFrames += 1;
  },
});

/** Sends every transaction into the mempool with interval mining paused, then mines them into one block. */
async function burstBlock(label: string, txs: readonly { from: Address; to: Address; data: Hex; value: bigint }[]): Promise<bigint> {
  await rpc('evm_setIntervalMining', [0]);
  const hashes: Hex[] = [];
  for (const tx of txs) hashes.push(await rpc<Hex>('eth_sendTransaction', [{ from: tx.from, to: tx.to, data: tx.data, value: `0x${tx.value.toString(16)}`, gas: '0x61a80' }]));
  await rpc('evm_mine');
  await rpc('evm_setIntervalMining', [2]);
  const receipts = await Promise.all(hashes.map((hash) => rpc<{ blockNumber: Hex; status: Hex }>('eth_getTransactionReceipt', [hash])));
  const numbers = new Set(receipts.map((r) => BigInt(r.blockNumber)));
  const ok = receipts.filter((r) => r.status === '0x1').length;
  const block = [...numbers][0] ?? 0n;
  process.stdout.write(`${label}: ${ok}/${txs.length} ok in ${numbers.size} block(s) (${[...numbers].join(', ')})\n`);
  sent.push({ label: `${label} (${ok}/${txs.length} ok)`, hash: hashes[0] ?? '0x', block, status: numbers.size === 1 && ok === txs.length ? 'ok' : 'split-or-reverted' });
  return block;
}

const deadline = BigInt(Math.floor(Date.now() / 1_000) + 3_600);
const buy = (label: string, buyer: Address, eth: bigint) => send(label, buyer, T.launchRouter, encodeFunctionData({ abi: routerAbi, functionName: 'buy', args: [1n, buyer, deadline] }), eth);
// Router buys in the window: sent while the head is open + k − 1, they land at offset k.
await waitHead(T.openBlock - 1n);
await buy('router buy sent at the window open', buyers[0] as Address, 5n * 10n ** 16n);
await waitHead(T.openBlock + 9n);
await buy('router buy near offset 10', buyers[1] as Address, 2n * 10n ** 17n);
await waitHead(T.openBlock + 13n);
const routerBurst = await burstBlock(`${burst} router buys in one block`, burstAccounts(0).map((from) => ({ from, to: T.launchRouter, data: encodeFunctionData({ abi: routerAbi, functionName: 'buy', args: [1n, from, deadline] }), value: 10n ** 16n })));
await waitHead(T.openBlock + 24n);
await buy('router buy near offset 25', buyers[2] as Address, 5n * 10n ** 17n);
await waitHead(T.closeBlock);
const swap = (label: string, from: Address, zeroForOne: boolean, amountIn: bigint) =>
  send(label, from, POOL_SWAP_TEST, encodeFunctionData({
    abi: swapTestAbi,
    functionName: 'swap',
    args: [poolKey, { zeroForOne, amountSpecified: -amountIn, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PLUS_ONE : MAX_SQRT_MINUS_ONE }, { takeClaims: false, settleUsingBurn: false }, '0x'],
  }), zeroForOne ? amountIn : 0n);
await swap('PoolSwapTest buy 0.3 ETH', buyers[3] as Address, true, 3n * 10n ** 17n);
const swapArgs = (amountIn: bigint) => encodeFunctionData({
  abi: swapTestAbi,
  functionName: 'swap',
  args: [poolKey, { zeroForOne: true, amountSpecified: -amountIn, sqrtPriceLimitX96: MIN_SQRT_PLUS_ONE }, { takeClaims: false, settleUsingBurn: false }, '0x'],
});
const swapBurst = await burstBlock(`${burst} PoolSwapTest buys in one block`, burstAccounts(0x1000).map((from) => ({ from, to: POOL_SWAP_TEST, data: swapArgs(10n ** 16n), value: 10n ** 16n })));
const balance = BigInt(await rpc<Hex>('eth_call', [{ to: T.token, data: encodeFunctionData({ abi: tokenAbi, functionName: 'balanceOf', args: [buyers[2] as Address] }) }, 'latest']));
await send('approve PoolSwapTest', buyers[2] as Address, T.token, encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [POOL_SWAP_TEST, balance] }));
await swap('PoolSwapTest sell half of buyer 3', buyers[2] as Address, false, balance / 2n);
await send('collector flush (burn)', buyers[4] as Address, T.collector, encodeFunctionData({ abi: collectorAbi, functionName: 'flush' }));
// A reorg: a buy lands, the indexer applies it, then the fork drops that block and mines a different one.
const doomed = await swap('PoolSwapTest buy 0.1 ETH (to be reorged out)', buyers[4] as Address, true, 10n ** 17n);
await waitHead((doomed.block ?? 0n) + 1n);
await sleep(1_500);
const seenBeforeReorg = blocks.some((b) => b.trades.some((t) => t.txHash === doomed.hash));
await rpc('anvil_rollback', [2]);
process.stdout.write(`rolled back 2 blocks from ${doomed.block !== null ? doomed.block + 1n : '?'}\n`);
await waitHead((doomed.block ?? 0n) + 4n);
await sleep(3_000);

const indexer = service.indexer;
if (!indexer) throw new Error('no indexer');
const verified = await indexer.verifyAgainstChain();
const trades = indexer.recentTrades().filter((t) => t.block > T.deployBlock);
const summary = {
  forkBlock,
  sent: sent.map((s) => ({ ...s, block: s.block?.toString() ?? null })),
  sseBlockEvents: blocks.length,
  reorgEvents: reorgs.map((r) => ({ fromBlock: r.fromBlock, toBlock: r.toBlock, depth: r.depth, droppedTradeIds: r.droppedTradeIds })),
  doomedTradeSeenBeforeReorg: seenBeforeReorg,
  doomedTradeAfterReorg: trades.some((t) => t.txHash === doomed.hash),
  trades: trades.map((t) => ({ block: t.block.toString(), side: t.side, route: t.route, eth: t.ethRaw.toString(), tokens: t.tokenRaw.toString(), taxWei: t.taxRaw.toString(), feeEthRaw: t.feeEthRaw.toString(), feeTokenRaw: t.feeTokenRaw.toString(), trader: t.trader, fillBpsAfter: t.fillBpsAfter })),
  finalState: { head: indexer.head()?.number.toString(), swapCount: indexer.latestState().swapCount, fillBps: blocks.at(-1)?.state.fillBps, retainedEth: blocks.at(-1)?.state.retainedEth, burned: blocks.at(-1)?.state.burned, taxWei: indexer.latestState().taxWei.toString() },
  verifiedAgainstForkAtHead: verified,
  metrics: indexer.metrics,
  tradersFrames,
  processMs: (() => {
    const list = blocks.filter((b) => b.head.source === 'ws' && b.trades.length < 2).map((b) => b.timing.committedAtMs - b.timing.seenAtMs).sort((a, b) => a - b);
    return { note: 'ordinary blocks (0 or 1 trade), header seen → committed', n: list.length, p50: list[Math.floor(list.length / 2)], max: list.at(-1) };
  })(),
  bursts: [routerBurst, swapBurst].map((number) => {
    const event = blocks.find((b) => b.head.number === number.toString());
    if (!event) return { block: number.toString(), published: false };
    const trades = event.trades;
    return {
      block: number.toString(),
      trades: trades.length,
      routes: [...new Set(trades.map((t) => t.route))],
      tradersKnownAtPublish: trades.filter((t) => t.trader !== null).length,
      rpcCalls: event.timing.rpcCalls,
      processMs: event.timing.committedAtMs - event.timing.seenAtMs,
      seenToPageMs: (received.get(event.head.hash) ?? Number.NaN) - event.timing.seenAtMs,
    };
  }),
};
process.stdout.write(`${JSON.stringify(summary, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
if (out) writeFileSync(out, `${JSON.stringify({ ranAt: new Date().toISOString(), ...summary }, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
stream.close();
await service.stop();
stopAnvil();
process.exit(verified ? 0 : 1);
