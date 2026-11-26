import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, numberToHex, pad, type Address, type Hex } from 'viem';
import { curveFactoryAbi } from '../src/abi/flap';
import { publicClientFor } from '../src/lib/chain';
import type { AppConfig } from '../src/lib/config';
import { forgetScans, readEvents } from '../src/lib/logs';

// Two local endpoints like the live ones: A refuses an eth_getLogs range above `limitA` blocks (HTTP 403 with a
// JSON-RPC error, as PublicNode does above 50,000); B answers every eth_getLogs with an error inside HTTP 200. The head
// is 120,000 blocks past the factory's deploy block; three sales were created at blocks spread over that span.
const DEPLOY = 144_770_777n;
const HEAD = DEPLOY + 120_000n;
const FACTORY = ('0x' + '15'.repeat(20)) as Address;
const sales: { block: bigint; launcher: Address }[] = [
  { block: DEPLOY + 10n, launcher: ('0x' + 'a1'.repeat(20)) as Address },
  { block: DEPLOY + 60_000n, launcher: ('0x' + 'a2'.repeat(20)) as Address },
  { block: DEPLOY + 119_000n, launcher: ('0x' + 'a3'.repeat(20)) as Address },
];
const creator = ('0x' + 'c0'.repeat(20)) as Address;
let limitA = 50_000n;
let refuseAllA = false;
const ranges: bigint[] = [];

function logOf(s: { block: bigint; launcher: Address }, i: number) {
  const topics = encodeEventTopics({ abi: curveFactoryAbi, eventName: 'CurveLauncherCreated', args: { launcher: s.launcher, creator } } as never) as Hex[];
  return {
    address: FACTORY,
    topics,
    data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'bool' }], [pad('0x01'), true]),
    blockNumber: numberToHex(s.block),
    blockHash: pad(numberToHex(s.block)),
    transactionHash: pad(numberToHex(1000 + i)),
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false,
  };
}

type Call = { id: number; method: string; params: { fromBlock: Hex; toBlock: Hex; topics?: (Hex | null)[] }[] };
function answer(name: 'A' | 'B', call: Call): { status: number; body: unknown } {
  if (call.method === 'eth_chainId') return { status: 200, body: { jsonrpc: '2.0', id: call.id, result: '0x61' } };
  if (call.method === 'eth_blockNumber') return { status: 200, body: { jsonrpc: '2.0', id: call.id, result: numberToHex(HEAD) } };
  if (call.method === 'eth_getLogs') {
    const f = call.params[0]!;
    const from = BigInt(f.fromBlock);
    const to = BigInt(f.toBlock ?? numberToHex(HEAD));
    if (name === 'B') return { status: 200, body: { jsonrpc: '2.0', id: call.id, error: { code: -32005, message: 'eth_getLogs is not served here' } } };
    if (refuseAllA || to - from + 1n > limitA) {
      return { status: 403, body: { jsonrpc: '2.0', id: call.id, error: { code: -32701, message: 'exceed maximum block range: 50000' } } };
    }
    ranges.push(to - from + 1n);
    const want = f.topics?.[1];
    const logs = sales
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.block >= from && s.block <= to && (!want || want.toLowerCase() === pad(s.launcher).toLowerCase()))
      .map(({ s, i }) => logOf(s, i));
    return { status: 200, body: { jsonrpc: '2.0', id: call.id, result: logs } };
  }
  return { status: 200, body: { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'no' } } };
}

const servers: http.Server[] = [];
async function serve(name: 'A' | 'B'): Promise<string> {
  const s = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d)).on('end', () => {
      const j = JSON.parse(raw) as Call | Call[];
      const calls = Array.isArray(j) ? j : [j];
      const out = calls.map((c) => answer(name, c));
      res.statusCode = out.some((o) => o.status !== 200) ? 403 : 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(j) ? out.map((o) => o.body) : out[0]!.body));
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

let a = '';
let b = '';
beforeAll(async () => {
  a = await serve('A');
  b = await serve('B');
});
afterAll(() => servers.forEach((s) => s.close()));
beforeEach(() => {
  forgetScans();
  limitA = 50_000n;
  refuseAllA = false;
  ranges.length = 0;
});

const client = () => publicClientFor({ rpcUrls: [a, b], explorer: 'https://testnet.bscscan.com' } as AppConfig);
type Created = { args: { launcher: Address } };
const query = { address: FACTORY, abi: curveFactoryAbi, eventName: 'CurveLauncherCreated', fromBlock: DEPLOY };

describe('event reads in windows (the live fault of 26 November: one range from the deploy block was refused)', () => {
  it('the control: one read from the deploy block to the head is refused by both endpoints', async () => {
    await expect(client().getContractEvents({ ...query, fromBlock: DEPLOY } as never)).rejects.toThrow();
  }, 30_000);

  it('the head 120,000 blocks past the deploy block, an endpoint that refuses more than 50,000: every sale is found', async () => {
    const logs = await readEvents<Created>(client(), query);
    expect(logs.map((l) => l.args.launcher.toLowerCase())).toEqual(sales.map((s) => s.launcher.toLowerCase()));
    expect(ranges.every((r) => r <= 50_000n)).toBe(true);
  }, 30_000);

  it('the creation proof (a filter on the launcher) passes for the sale 119,000 blocks in', async () => {
    const logs = await readEvents<Created>(client(), { ...query, args: { launcher: sales[2]!.launcher } });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.args.launcher.toLowerCase()).toBe(sales[2]!.launcher.toLowerCase());
  }, 30_000);

  it('a refused window is halved and read again', async () => {
    limitA = 12_000n;
    const logs = await readEvents<Created>(client(), query);
    expect(logs).toHaveLength(3);
    expect(ranges.every((r) => r <= 12_000n)).toBe(true);
  }, 60_000);

  it('the next read scans only the new blocks', async () => {
    const c = client();
    await readEvents<Created>(c, query);
    const first = ranges.length;
    await readEvents<Created>(c, query);
    expect(ranges.length).toBe(first); // the head did not move: nothing read again
  }, 30_000);

  it('both endpoints refuse (B with an error inside HTTP 200): the read fails, never an empty list', async () => {
    refuseAllA = true;
    await expect(readEvents<Created>(client(), query)).rejects.toThrow();
  }, 60_000);
});
