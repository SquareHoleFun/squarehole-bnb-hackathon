// @vitest-environment node
import { createPublicClient, encodeEventTopics, erc721Abi, http, toHex, type Address, type Hex } from 'viem';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { shopVaultV2Abi } from '../../../../../../packages/chain/src/core/v2';
import { cardReaderV2 } from './card-reads';
import { readShopBookV2 } from './shop-book';
import { rpcShopLogReaderV2 } from './shop-reads';
import { liveBnbSourceV2 } from './test-support/live-bnb-v2';

const PRIMARY = 'https://bsc-testnet-rpc.publicnode.com';
const HISTORY = 'https://bsc-prebsc-dataseed.bnbchain.org';
const source = { ...liveBnbSourceV2(), rpc: PRIMARY };
const SHOP = '0x0000000000000000000000000000000000000001';
const COLLECTION = '0x0000000000000000000000000000000000000002';
const OWNER = '0x0000000000000000000000000000000000000003';
const OLD = 144_770_777n;

interface Filter { address: Address | Address[]; fromBlock: Hex; toBlock: Hex; topics: unknown[] }
interface Call { id: number; method: string; params: [Filter] }

/** Record each HTTP post and answer a JSON-RPC batch in reverse order. */
function endpoint(answer: (rpc: string, call: Call) => unknown) {
  const posts: { rpc: string; calls: Call[] }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const rpc = new URL(url).origin;
    const body = JSON.parse(String(init.body)) as Call | Call[];
    const calls = Array.isArray(body) ? body : [body];
    posts.push({ rpc, calls });
    const replies = calls.map((call) => ({ jsonrpc: '2.0', id: call.id, result: answer(rpc, call) }));
    return Response.json(Array.isArray(body) ? replies.reverse() : replies[0]);
  });
  return posts;
}
const rawLog = (at: Hex) => ({ address: SHOP, blockNumber: at, logIndex: '0x0', topics: [], data: '0x' });
const clientAt = (rpc: string) => createPublicClient({ transport: http(rpc, { retryCount: 0 }) });
const filter = { address: SHOP, fromBlock: OLD, toBlock: OLD + 10_000n } as const;

// Direct helper tests each start with no previously verified endpoint.
let historyLogs: typeof import('./history-logs').historyLogs;
beforeEach(async () => {
  vi.resetModules();
  ({ historyLogs } = await import('./history-logs'));
});
afterEach(() => vi.unstubAllGlobals());

it('batches contiguous inclusive ranges on the history endpoint and joins the replies in block order', async () => {
  const posts = endpoint((_rpc, call) => call.method === 'eth_chainId' ? '0x61' : [rawLog(call.params[0].fromBlock)]);
  const logs = await historyLogs(source, () => clientAt(PRIMARY), filter);
  expect(posts.map(({ rpc, calls }) => [rpc, calls.map((c) => c.method)])).toEqual([
    [HISTORY, ['eth_chainId']], [HISTORY, ['eth_getLogs', 'eth_getLogs', 'eth_getLogs']],
  ]);
  expect(posts[1]?.calls.map(({ params: [q] }) => [BigInt(q.fromBlock), BigInt(q.toBlock)])).toEqual([
    [OLD, OLD + 4_999n], [OLD + 5_000n, OLD + 9_999n], [OLD + 10_000n, OLD + 10_000n],
  ]);
  expect(logs.map((l) => l.blockNumber)).toEqual([OLD, OLD + 5_000n, OLD + 10_000n]);
});

it('reads an unmapped endpoint on chain 97 in one original range', async () => {
  const local = liveBnbSourceV2();
  const posts = endpoint(() => [rawLog(toHex(OLD))]);
  const logs = await historyLogs(local, () => clientAt(local.rpc), filter);
  expect(logs.map((l) => l.blockNumber)).toEqual([OLD]);
  expect(posts).toMatchObject([{ rpc: local.rpc, calls: [{ method: 'eth_getLogs', params: [{
    address: SHOP, fromBlock: toHex(OLD), toBlock: toHex(filter.toBlock),
  }] }] }]);
});

it.each(['wrong chain', 'offline'])('rejects a history chain check (%s) and retries the check on the next read', async (failure) => {
  let recovered = false;
  const posts = endpoint((_rpc, call) => {
    if (call.method !== 'eth_chainId') return [];
    if (recovered) return '0x61';
    if (failure === 'offline') throw new Error('offline');
    return '0x38';
  });
  const read = () => historyLogs(source, () => clientAt(PRIMARY), { ...filter, toBlock: OLD });
  await expect(read()).rejects.toThrow(failure === 'offline' ? /offline/ : /Wrong network/);
  expect(posts.map(({ rpc, calls }) => [rpc, calls.map((c) => c.method)])).toEqual([[HISTORY, ['eth_chainId']]]);
  recovered = true;
  await expect(read()).resolves.toEqual([]);
});

it('replays the old shop seed and finds the wallet transfer, sharing one history chain check', async () => {
  const seed = { ...rawLog(toHex(OLD)), topics: encodeEventTopics({ abi: shopVaultV2Abi, eventName: 'SeedFunded' }), data: toHex(9n, { size: 32 }) };
  const transfer = { ...rawLog(toHex(OLD)), address: COLLECTION, topics: encodeEventTopics({
    abi: erc721Abi, eventName: 'Transfer', args: { from: SHOP, to: OWNER, tokenId: 7n },
  }) };
  const posts = endpoint((rpc, call) => {
    if (call.method === 'eth_chainId') return '0x61';
    if (call.method === 'eth_getCode') return '0x';
    if (call.method === 'eth_getBlockByNumber' && rpc === PRIMARY) return { timestamp: '0x123' };
    if (call.method !== 'eth_getLogs') throw new Error(call.method);
    if (rpc === PRIMARY) return [];
    const q = call.params[0];
    if (q.address === SHOP) return [seed];
    expect(q.address).toEqual([COLLECTION, SHOP]);
    expect(q.topics).toEqual(encodeEventTopics({ abi: erc721Abi, eventName: 'Transfer', args: { to: OWNER } }));
    return [transfer];
  });
  const shop = rpcShopLogReaderV2(source);
  const [book, cards] = await Promise.all([
    readShopBookV2(shop, SHOP, OLD, OLD, 0n, 9n),
    cardReaderV2(source).transfersTo([COLLECTION, SHOP], OWNER, OLD, OLD),
  ]);
  expect(book.budgetT).toBe(9n);
  expect(cards).toEqual([{ collection: COLLECTION, id: 7n }]);
  const historyCalls = posts.filter((p) => p.rpc === HISTORY).flatMap((p) => p.calls);
  expect(historyCalls.map((c) => c.method)).toEqual(['eth_chainId', 'eth_getLogs', 'eth_getLogs']);
  expect(await shop.timestamp(OLD)).toBe(0x123n);
});
