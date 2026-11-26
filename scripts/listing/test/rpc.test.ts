import { describe, expect, it } from 'vitest';
import { httpRpc, Reader, RpcError } from '../rpc.mjs';
import { parseInput } from '../config.mjs';
import { fakeRpc, input, A } from './rpc.mjs';

describe('bounded streaming and resumable log scans', () => {
  it('cancels an oversized streaming body before draining it, without trusting content-length', async () => {
    let reads = 0, cancelled = false;
    const rpc = httpRpc('https://rpc.invalid', { allowMainnet: true }, async () => ({
      ok: true, headers: new Headers({ 'content-length': '1' }),
      body: { getReader: () => ({
        async read() { reads++; if (reads > 34) throw new Error('stream drained'); return { done: false, value: new Uint8Array(1024 * 1024) }; },
        async cancel() { cancelled = true; }, releaseLock() {},
      }) },
      async text() { reads = 100; return '{}'; },
    }));
    await expect(rpc.request('eth_chainId', [])).rejects.toThrow();
    expect(reads).toBe(33);
    expect(cancelled).toBe(true);
  });

  it('decodes JSON split across streamed UTF-8 chunks', async () => {
    const rpc = httpRpc('https://rpc.invalid', { allowMainnet: true }, async (_url, options) => {
      const { id } = JSON.parse(options.body);
      const bytes = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id, result: '€' }));
      return new Response(new ReadableStream({ start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      } }));
    });
    expect(await rpc.request('eth_chainId', [])).toBe('€');
  });

  it('bounds scanned blocks, persists only completed pages, and resumes with no skipped or repeated range', async () => {
    const rpc = fakeRpc(), ranges = [], config = parseInput({ ...input(), logChunk: '2', maxScanBlocks: '4' }, true);
    const original = rpc.request.bind(rpc);
    rpc.request = (method, params) => { if (method === 'eth_getLogs') ranges.push([params[0].fromBlock, params[0].toBlock]); return original(method, params); };
    let cursor;
    const first = await new Reader(rpc, config, { saveCursor: value => { cursor = structuredClone(value); } }).init();
    await expect(first.logs(A(24), [], 0n, 5n)).rejects.toThrow(/scan.*incomplete/i);
    expect(ranges).toEqual([['0x0', '0x1'], ['0x2', '0x3']]);
    expect(cursor.pages).toHaveLength(2);
    const second = await new Reader(rpc, config, { cursor }).init();
    expect(await second.logs(A(24), [], 0n, 5n)).toEqual([]);
    expect(ranges).toEqual([['0x0', '0x1'], ['0x2', '0x3'], ['0x4', '0x5']]);
  });

  it('backs off transient log failures without advancing a failed page', async () => {
    const rpc = fakeRpc(), original = rpc.request.bind(rpc), delays = [], ranges = [];
    let failures = 2;
    rpc.request = async (method, params) => {
      if (method === 'eth_getLogs') { ranges.push(params[0]); if (failures-- > 0) throw new RpcError(429); }
      return original(method, params);
    };
    const reader = await new Reader(rpc, parseInput(input(), true), { sleep: async ms => { delays.push(ms); } }).init();
    await reader.logs(A(24), [], 0n, 1n);
    expect(delays).toEqual([250, 500]);
    expect(ranges).toHaveLength(3);
    expect(ranges.every(r => r.fromBlock === '0x0' && r.toBlock === '0x1')).toBe(true);
    expect(reader.cursor.pages).toHaveLength(1);
  });

  it('stops after bounded retries and can resume a provider interruption', async () => {
    const rpc = fakeRpc(), original = rpc.request.bind(rpc), delays = [];
    let fail = true;
    rpc.request = async (method, params) => {
      if (method === 'eth_getLogs' && fail) throw new RpcError(-32005);
      return original(method, params);
    };
    const config = parseInput(input(), true);
    const reader = await new Reader(rpc, config, { sleep: async ms => { delays.push(ms); } }).init();
    await expect(reader.logs(A(24), [], 0n, 1n)).rejects.toThrow();
    expect(delays).toEqual([250, 500, 1000]);
    expect(reader.cursor.pages).toEqual([]);
    fail = false;
    const resumed = await new Reader(rpc, config, { cursor: reader.cursor }).init();
    await expect(resumed.logs(A(24), [], 0n, 1n)).resolves.toEqual([]);
  });

  it('rejects cursors from a different input, changed snapshot, or broken page sequence', async () => {
    const config = parseInput({ ...input(), logChunk: '2' }, true), rpc = fakeRpc();
    const first = await new Reader(rpc, config).init();
    await first.logs(A(24), [], 0n, 3n);
    await expect(new Reader(fakeRpc(), { ...config, chainId: '11155111' }, { cursor: first.cursor }).init()).rejects.toThrow();
    const other = { ...config, referenceAmount: '1' };
    await expect(new Reader(fakeRpc(), other, { cursor: first.cursor }).init()).rejects.toThrow(/cursor/);
    const reorg = fakeRpc(); reorg.reorg = true; reorg.finalizedReads = 1;
    await expect(new Reader(reorg, config, { cursor: first.cursor }).init()).rejects.toThrow(/snapshot/);
    const cursor = structuredClone(first.cursor); cursor.pages[0].to = '999';
    const broken = await new Reader(fakeRpc(), config, { cursor }).init();
    await expect(broken.logs(A(24), [], 0n, 3n)).rejects.toThrow(/cursor/);
  });
});
