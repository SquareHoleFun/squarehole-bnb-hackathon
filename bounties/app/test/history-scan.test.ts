import { afterEach, expect, it, vi } from 'vitest';
import * as viem from 'viem';
import { chainFor } from '../src/lib/chain';
import { forgetScans, readEvents, readEventsMany } from '../src/lib/logs';

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof viem>();
  return { ...actual, http: vi.fn(actual.http) };
});

const PAGE = 'https://bsc-testnet-rpc.publicnode.com';
const HISTORY = 'https://bsc-prebsc-dataseed.bnbchain.org';
const LOCAL = 'http://127.0.0.1:8545';
const address = '0x0000000000000000000000000000000000000001';
const event = viem.parseAbiItem('event Created()');
const topics = viem.encodeEventTopics({ abi: [event], eventName: event.name });
const fromBlock = 11n;

function logAt(block: bigint) {
  return { address, topics, data: '0x', blockNumber: viem.numberToHex(block) };
}

function endpoint(head: bigint) {
  return {
    chainId: vi.fn(() => 97),
    head: vi.fn(() => head),
    logs: vi.fn((_from: bigint, to: bigint) => [logAt(to)]),
  };
}

interface Call {
  id: number;
  method: string;
  params: [{ fromBlock: string; toBlock: string }];
}

function setup(rpcUrls = [PAGE]) {
  const client = viem.createPublicClient({ chain: chainFor({ rpcUrls, explorer: '' }), transport: viem.http() });
  const history = endpoint(10_012n);
  const page = endpoint(10_020n);
  const batches: string[][] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const rpc = new URL(String(url)).origin;
    expect([HISTORY, rpcUrls[0]]).toContain(rpc);
    const target = rpc === HISTORY ? history : page;
    const body = JSON.parse(String(init?.body)) as Call | Call[];
    const calls = Array.isArray(body) ? body : [body];
    batches.push(calls.map((call) => call.method));
    const replies = calls.map(({ id, method, params }) => {
      const envelope = { jsonrpc: '2.0', id };
      try {
        if (method === 'eth_chainId') return { ...envelope, result: viem.numberToHex(target.chainId()) };
        if (method === 'eth_blockNumber') return { ...envelope, result: viem.numberToHex(target.head()) };
        if (method === 'eth_getLogs') return { ...envelope, result: target.logs(BigInt(params[0].fromBlock), BigInt(params[0].toBlock)) };
      } catch {
        return { ...envelope, error: { code: -32000, message: 'read failed' } };
      }
      throw new Error(`Unexpected RPC method ${method}`);
    });
    // JSON-RPC allows replies in any order.
    return Response.json(Array.isArray(body) ? replies.reverse() : replies[0]);
  });
  type Log = { blockNumber: bigint };
  const read = () => readEvents<Log>(client, { address, abi: [event], eventName: event.name, fromBlock });
  const readMany = () => readEventsMany<Log>(client, { address: [address], events: [event], fromBlock });
  return { history, page, batches, read, readMany };
}

afterEach(() => {
  forgetScans();
  vi.restoreAllMocks();
});

it('asks for adjacent inclusive history ranges together and resumes at the next block', async () => {
  const { history, page, batches, read } = setup();
  expect((await read()).map((log) => log.blockNumber)).toEqual([5_010n, 10_010n, 10_012n]);
  expect(history.logs.mock.calls).toEqual([[11n, 5_010n], [5_011n, 10_010n], [10_011n, 10_012n]]);
  expect(batches).toEqual([['eth_chainId'], ['eth_blockNumber'], ['eth_getLogs', 'eth_getLogs', 'eth_getLogs']]);

  history.head.mockReturnValue(10_013n);
  expect((await read()).map((log) => log.blockNumber)).toEqual([5_010n, 10_010n, 10_012n, 10_013n]);
  expect(history.logs.mock.calls.slice(3)).toEqual([[10_013n, 10_013n]]);
  expect(history.chainId).toHaveBeenCalledTimes(1);
  expect(page.head).not.toHaveBeenCalled();
  expect(page.logs).not.toHaveBeenCalled();
});

it('reads no ranges above the history head and one range for a short history', async () => {
  const { history, page, readMany } = setup();
  history.head.mockReturnValue(8n);
  expect(await readMany()).toEqual([]);
  expect(history.logs).not.toHaveBeenCalled();
  history.head.mockReturnValue(15n);
  expect((await readMany()).map((log) => log.blockNumber)).toEqual([15n]);
  history.head.mockReturnValue(12n);
  expect((await readMany()).map((log) => log.blockNumber)).toEqual([15n]);
  history.head.mockReturnValue(16n);
  expect((await readMany()).map((log) => log.blockNumber)).toEqual([15n, 16n]);
  expect(history.logs.mock.calls).toEqual([[11n, 15n], [16n, 16n]]);
  expect(page.head).not.toHaveBeenCalled();
  expect(page.logs).not.toHaveBeenCalled();
});

it('discards all history parts if a part fails and reads the whole range from the page', async () => {
  const { history, page, read } = setup();
  history.logs.mockReturnValueOnce([logAt(5_010n)]).mockImplementationOnce(() => { throw new Error(); });
  expect((await read()).map((log) => log.blockNumber)).toEqual([10_020n]);
  expect(history.logs).toHaveBeenCalledTimes(3);
  expect(page.logs.mock.calls).toEqual([[11n, 10_020n]]);
});

it.each([
  ['a wrong chain ID', (): number => 56],
  ['a failed chain ID read', (): number => { throw new Error(); }],
] as const)('falls back on %s and checks the history endpoint again next time', async (_reason, firstCheck) => {
  const { history, page, read } = setup();
  const http = vi.mocked(viem.http).mockClear();
  history.chainId.mockImplementationOnce(firstCheck);
  expect((await read()).map((log) => log.blockNumber)).toEqual([10_020n]);
  expect(page.logs.mock.calls).toEqual([[11n, 10_020n]]);
  expect(history.head).not.toHaveBeenCalled();
  expect(history.logs).not.toHaveBeenCalled();

  history.head.mockReturnValue(10_025n);
  expect((await read()).map((log) => log.blockNumber)).toEqual([10_020n, 10_025n]);
  expect(history.chainId).toHaveBeenCalledTimes(2);
  expect(history.logs.mock.calls).toEqual([[10_021n, 10_025n]]);
  expect(http.mock.calls.map(([url]) => url)).toEqual([HISTORY, PAGE]);
});

it('falls back to the page head and page logs if the history head fails', async () => {
  const { history, page, readMany } = setup();
  history.head.mockImplementationOnce(() => { throw new Error(); });
  expect((await readMany()).map((log) => log.blockNumber)).toEqual([10_020n]);
  expect(history.head).toHaveBeenCalledOnce();
  expect(history.logs).not.toHaveBeenCalled();
  expect(page.logs.mock.calls).toEqual([[11n, 10_020n]]);
});

it('keeps a local chain on its own endpoint even with the mapped URL second', async () => {
  const { history, page, read } = setup([LOCAL, PAGE]);
  const http = vi.mocked(viem.http).mockClear();
  expect((await read()).map((log) => log.blockNumber)).toEqual([10_020n]);
  expect(http.mock.calls.map(([url]) => url)).toEqual([LOCAL, PAGE]);
  expect(history.chainId).not.toHaveBeenCalled();
  expect(history.head).not.toHaveBeenCalled();
  expect(history.logs).not.toHaveBeenCalled();
  expect(page.logs.mock.calls).toEqual([[11n, 10_020n]]);
});
