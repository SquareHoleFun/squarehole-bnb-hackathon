import { abiCall, decodeFunctionResult, keccak256, need, toHex } from './common.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const METHODS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt', 'eth_getLogs', 'eth_call']);
export class RpcError extends Error {
  constructor(code, data) { super('read-only RPC request failed'); this.code = code; this.data = data; }
}
/** No URL, response error message or exception cause can escape into public output. */
export function httpRpc(url, { chainId = '1', allowMainnet = false } = {}, fetcher = globalThis.fetch) {
  need(['1', '11155111', '31337'].includes(chainId), 'unsupported listing chain');
  need(chainId !== '1' || allowMainnet === true, 'mainnet requires --allow-mainnet');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('invalid RPC environment value'); }
  need(!parsed.username && !parsed.password && !parsed.hash, 'RPC userinfo and fragment refused');
  if (chainId === '31337') {
    // Check the literal authority too: URL normalizes aliases such as 127.1 and decimal IPv4.
    need(/^http:\/\/127\.0\.0\.1(?::[0-9]+)?(?:[/?]|$)/.test(url) && parsed.hostname === '127.0.0.1', 'fork RPC must use http://127.0.0.1');
  } else need(parsed.protocol === 'https:', 'RPC must be HTTPS');
  let id = 0;
  return { async request(method, params) {
    need(METHODS.has(method), 'RPC method refused');
    const requestId = ++id;
    let body;
    try {
      const response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new RpcError([429, 502, 503, 504].includes(response.status) ? response.status : -2);
      }
      body = JSON.parse(await boundedBody(response));
    } catch (error) { throw error instanceof RpcError ? error : new RpcError(-1); }
    need(body?.jsonrpc === '2.0' && body.id === requestId, 'RPC response identity mismatch');
    if (body.error) {
      // Only bounded ABI revert bytes are retained, never arbitrary nested error objects or messages.
      const data = typeof body.error.data === 'string' && /^0x[0-9a-f]{0,136}$/i.test(body.error.data) ? body.error.data : undefined;
      throw new RpcError(Number.isSafeInteger(body.error.code) ? body.error.code : -2, data);
    }
    need(Object.hasOwn(body, 'result'), 'RPC result missing');
    return body.result;
  } };
}

async function boundedBody(response) {
  const reader = response.body?.getReader();
  need(reader, 'RPC response stream required');
  const decoder = new TextDecoder('utf-8', { fatal: true }), parts = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 32 * 1024 * 1024) throw new RpcError(-2);
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } finally {
    try { await reader.cancel(); } catch { /* The bounded public error is sufficient. */ }
    reader.releaseLock();
  }
}

export class ScanIncomplete extends Error {
  constructor() { super('log scan incomplete; resume with the same input and cursor'); }
}

export class Reader {
  constructor(rpc, config, options = {}) {
    this.rpc = rpc; this.config = config; this.cache = new Map();
    this.options = options; this.sleep = options.sleep ?? sleep; this.scannedBlocks = 0n;
  }
  async request(method, params, cached = true) {
    need(METHODS.has(method), 'RPC method refused');
    const key = JSON.stringify([method, params]);
    if (!cached) return this.rpc.request(method, params);
    if (!this.cache.has(key)) this.cache.set(key, this.rpc.request(method, params).catch(error => {
      this.cache.delete(key); throw error;
    }));
    return this.cache.get(key);
  }
  async block(tag, cached = true) {
    const b = await this.request('eth_getBlockByNumber', [typeof tag === 'bigint' ? toHex(tag) : tag, false], cached);
    need(b && /^0x[0-9a-f]{64}$/i.test(b.hash), 'block unavailable');
    return { number: BigInt(b.number), hash: b.hash.toLowerCase(), timestamp: BigInt(b.timestamp) };
  }
  async init() {
    need(BigInt(await this.request('eth_chainId', [], false)) === BigInt(this.config.chainId), 'RPC chain mismatch');
    const inputHash = keccak256(toHex(JSON.stringify(this.config)));
    this.cursor = structuredClone(this.options.cursor ?? { format: 'squarehole.listing-scan/1', inputHash, pages: [] });
    need(this.cursor.format === 'squarehole.listing-scan/1' && this.cursor.inputHash === inputHash && Array.isArray(this.cursor.pages), 'cursor input mismatch');
    if (this.cursor.snapshot) {
      this.end = await this.block(BigInt(this.cursor.snapshot.number));
      need(this.end.number.toString() === this.cursor.snapshot.number && this.end.hash === this.cursor.snapshot.hash
        && this.end.timestamp.toString() === this.cursor.snapshot.timestamp, 'cursor snapshot changed');
    } else {
      need(this.cursor.pages.length === 0, 'cursor snapshot missing');
      this.end = await this.block(this.config.chainId === '31337' ? 'latest' : 'finalized');
      this.cursor.snapshot = { number: this.end.number.toString(), hash: this.end.hash, timestamp: this.end.timestamp.toString() };
    }
    this.pages = new Map();
    for (const page of this.cursor.pages) {
      need(/^0x[0-9a-f]{64}$/.test(page.query) && /^(0|[1-9][0-9]*)$/.test(page.from)
        && /^(0|[1-9][0-9]*)$/.test(page.to) && Array.isArray(page.logs), 'invalid cursor page');
      const key = `${page.query}:${page.from}`;
      need(!this.pages.has(key), 'duplicate cursor page'); this.pages.set(key, page);
    }
    this.tag = toHex(this.end.number);
    need(BigInt(this.config.scanFromBlock) <= this.end.number && BigInt(this.config.market.v4.fromBlock) <= this.end.number, 'scan starts after snapshot');
    await this.saveCursor(); return this;
  }
  async canonical() {
    need(BigInt(await this.request('eth_chainId', [], false)) === BigInt(this.config.chainId), 'RPC chain mismatch');
    const b = await this.block(this.end.number, false);
    need(b.hash === this.end.hash && b.timestamp === this.end.timestamp, 'snapshot block changed');
  }
  async code(address, tag = this.tag) {
    const code = await this.request('eth_getCode', [address, tag]);
    need(typeof code === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(code), 'malformed contract code');
    return code.toLowerCase();
  }
  storage(address, slot) { return this.request('eth_getStorageAt', [address, slot, this.tag]); }
  call(to, signature, args = [], tag = this.tag, options = {}) {
    const { data } = abiCall(signature, args);
    return this.request('eth_call', [{ to, data, ...options }, tag]);
  }
  async read(to, signature, args = [], tag = this.tag, options = {}) {
    const { abi, name } = abiCall(signature, args);
    return decodeFunctionResult({ abi, functionName: name, data: await this.call(to, signature, args, tag, options) });
  }
  async pin(pin) {
    const code = await this.code(pin.address);
    need(code !== '0x' && keccak256(code) === pin.codeHash, 'infrastructure code pin mismatch');
  }
  async logs(address, topics, from, to = this.end.number) {
    this.assertScansComplete();
    try { return await this.scanLogs(address, topics, from, to); }
    catch (error) { this.scanError = error; throw error; }
  }
  assertScansComplete() { if (this.scanError) throw this.scanError; }
  async saveCursor() { if (this.options.saveCursor) await this.options.saveCursor(this.cursor); }
  async scanLogs(address, topics, from, to) {
    need(from >= 0n && to <= this.end.number, 'invalid log range');
    const logs = [], seen = new Set(), chunk = BigInt(this.config.logChunk), limit = BigInt(this.config.maxScanBlocks ?? '100000');
    const query = keccak256(toHex(JSON.stringify([address, topics, from.toString(), to.toString()])));
    for (let first = from; first <= to;) {
      const key = `${query}:${first}`, saved = this.pages.get(key);
      const upper = first + chunk - 1n < to ? first + chunk - 1n : to;
      let last, page;
      if (saved) {
        last = BigInt(saved.to); page = saved.logs;
        need(last >= first && last <= upper, 'invalid cursor range');
      } else {
        const remaining = limit - this.scannedBlocks;
        if (remaining === 0n) throw new ScanIncomplete();
        last = first + remaining - 1n < upper ? first + remaining - 1n : upper;
        for (let attempt = 0;; attempt++) {
          try {
            page = await this.request('eth_getLogs', [{ address, topics, fromBlock: toHex(first), toBlock: toHex(last) }], false);
            break;
          } catch (error) {
            if (attempt === 3 || ![-1, -32005, -32016, 429, 502, 503, 504].includes(error.code)) throw error;
            await this.sleep(250 * 2 ** attempt);
          }
        }
      }
      need(Array.isArray(page), 'invalid log response');
      for (const log of page) {
        need(!log.removed && log.address?.toLowerCase() === address && BigInt(log.blockNumber) >= first && BigInt(log.blockNumber) <= last, 'invalid log range');
        need(topics.every((filter, i) => filter === null || (Array.isArray(filter) ? filter.includes(log.topics[i]) : filter === log.topics[i])), 'invalid log topic');
        need((await this.block(BigInt(log.blockNumber))).hash === log.blockHash?.toLowerCase(), 'log block changed');
        const identity = `${BigInt(log.blockNumber)}:${BigInt(log.logIndex)}`;
        need(!seen.has(identity), 'duplicate logs'); seen.add(identity); logs.push(log);
      }
      if (!saved) {
        const entry = { query, from: first.toString(), to: last.toString(), logs: page };
        this.pages.set(key, entry); this.cursor.pages.push(entry); this.scannedBlocks += last - first + 1n;
        await this.saveCursor();
      }
      first = last + 1n;
    }
    logs.sort((a, b) => BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1
      : BigInt(a.logIndex) < BigInt(b.logIndex) ? -1 : 1);
    return logs;
  }
  async atOrBefore(timestamp) {
    let low = 0n, high = this.end.number;
    need((await this.block(low)).timestamp <= timestamp, 'insufficient chain history');
    while (low < high) {
      const mid = (low + high + 1n) / 2n;
      if ((await this.block(mid)).timestamp <= timestamp) low = mid; else high = mid - 1n;
    }
    return this.block(low);
  }
}
