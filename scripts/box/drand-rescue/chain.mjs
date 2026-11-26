import { readFile } from 'node:fs/promises';
import { viem } from './deps.mjs';
import { ABI } from './abi.mjs';
import { PINS, SILENCE, SILENCE_UNREQUESTED, roundTime } from './quicknet.mjs';
import { address } from './options.mjs';
import { json } from './http.mjs';

export class Failure extends Error {}
export const same = (a, b) => a.toLowerCase() === b.toLowerCase();
export const hex = n => `0x${n.toString(16)}`;
export function connection(io, rpcUrl) {
  let id = 0;
  const request = async ({ method, params = [] }, settings) => {
    const body = { jsonrpc: '2.0', id: ++id, method, params };
    let response;
    try { response = await json(io, rpcUrl, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, settings); }
    catch { throw new Failure('RPC unavailable'); }
    if (response?.id !== body.id || response?.jsonrpc !== '2.0') throw new Failure('invalid RPC response');
    if (response.error) {
      const raw = response.error.data;
      // Preserve only ABI revert bytes, never provider text/URL/headers.
      const data = typeof raw === 'string' && /^0x[\da-f]*$/i.test(raw) ? raw : undefined;
      throw new viem.RpcRequestError({ body, url: '', error: {
        code: typeof response.error.code === 'number' ? response.error.code : -32000,
        message: 'RPC request failed', data,
      } });
    }
    if (!Object.hasOwn(response, 'result')) throw new Failure('invalid RPC response');
    return response.result;
  };
  const client = viem.createPublicClient({ transport: viem.custom({ request }, { retryCount: 0 }) });
  const rpc = (method, params = []) => client.request({ method, params });
  const read = (block, target, functionName, args = []) => client.readContract({
    address: target, abi: ABI, functionName, args, blockNumber: block.number,
  });
  return {
    client, rpc, read,
    async block(settings) {
      const b = await request({ method: 'eth_getBlockByNumber', params: ['latest', false] }, settings);
      if (!b || b.baseFeePerGas == null) throw new Failure('block or base fee unavailable');
      return { number: BigInt(b.number), now: BigInt(b.timestamp), gasLimit: BigInt(b.gasLimit), base: BigInt(b.baseFeePerGas) };
    },
    async pin(block, target, expectedHash) {
      if (!address(target)) throw new Failure('refused address pin');
      const code = await rpc('eth_getCode', [target, hex(block.number)]);
      if (viem.keccak256(code) !== expectedHash) throw new Failure('refused code pin');
    },
  };
}
export function errorName(error) {
  for (let e = error, depth = 0; e && depth < 12; e = e.cause, depth++) {
    if (typeof e.data?.errorName === 'string') return e.data.errorName;
    if (typeof e.data === 'string') {
      try { return viem.decodeErrorResult({ abi: ABI, data: e.data }).errorName; } catch { /* not an ABI error */ }
    }
  }
  return null;
}
export async function discover(conn, cfg, chainId, block) {
  if (cfg.tickets.length) return { tickets: cfg.tickets };
  const defaultPath = new URL(`../../../packages/contracts/deployments/core-v1/${chainId}.json`, import.meta.url);
  let manifest;
  try { manifest = JSON.parse(await readFile(cfg.manifest ?? defaultPath, 'utf8')); }
  catch (error) {
    if (!cfg.manifest && error.code === 'ENOENT') throw new Failure(`no core-v1 manifest for chain ${chainId}; pass --tickets`);
    throw new Failure('manifest unavailable or invalid');
  }
  if (manifest?.schema !== 'squarehole.core-deployment/v1' || String(manifest.chainId) !== String(chainId)) {
    throw new Failure('manifest identity refused');
  }
  if (manifest.status === 'awaiting-broadcast') return { tickets: [], message: `box 0 not deployed on chain ${chainId}` };
  if (manifest.status !== 'deployed') throw new Failure('manifest status refused');
  const versions = manifest.versions?.filter(v => v.version === 1);
  if (versions?.length !== 1) throw new Failure('manifest version 1 missing or repeated');
  const registry = versions[0].registry;
  if (!registry || !/^0x[\da-f]{64}$/i.test(registry.codeHash)) throw new Failure('registry pin missing');
  await conn.pin(block, registry.address, registry.codeHash);
  const coordinator = await conn.read(block, registry.address, 'coordinatorOf', [0n]);
  if (!address(coordinator)) throw new Failure('box 0 coordinator missing');
  const tickets = await conn.read(block, coordinator, 'tickets');
  if (!address(tickets)) throw new Failure('box 0 tickets missing');
  return { tickets: [tickets.toLowerCase()] };
}
export const KEYS_PER_SNAPSHOT = 64n;
export function pendingCount(state) {
  return (state.slots !== 0n && state.wordRequestedAt !== 0n && state.wordAcceptedAt === 0n ? 1n : 0n)
    + state.drawsRequested - state.drawsSettled;
}
export function pendingKeys(state) {
  const keys = [];
  if (state.slots !== 0n && state.wordRequestedAt !== 0n && state.wordAcceptedAt === 0n) keys.push(0n);
  for (let k = state.drawsSettled + 1n; k <= state.drawsRequested && BigInt(keys.length) < KEYS_PER_SNAPSHOT; k++) keys.push(k);
  return keys;
}
export async function snapshot(conn, chainId, addresses, block) {
  const pin = PINS[String(chainId)];
  const tickets = [], notices = [], backups = new Map();
  let finalized = null;
  for (const target of addresses) {
    try {
      const source = await conn.read(block, target, 'source');
      const backed = same(source, pin.backedAddress);
      let drand = source;
      try {
        if (!backed && !same(source, pin.address)) throw new Error();
        await conn.pin(block, source, backed ? pin.backedCodeHash : pin.codeHash);
        if (backed) {
          drand = await conn.read(block, source, 'DRAND');
          if (!same(drand, pin.address)) throw new Error();
          await conn.pin(block, drand, pin.codeHash);
        }
      } catch { throw new Failure('refused source pin'); }
      const raw = await conn.read(block, target, 'status');
      // viem decodes uint32/40 as safe integers; immediately convert at the ABI boundary.
      const state = Object.fromEntries(Object.entries(raw).map(([k, value]) => [k, BigInt(value)]));
      const phase = BigInt(await conn.read(block, target, 'phase'));
      if (state.terminalAt !== 0n) {
        notices.push(`tickets=${target} terminal`);
        continue;
      }
      const entry = { address: target, source, drand, backed, state, phase, keys: [], pending: pendingCount(state), requestDeadline: null, blocked: false };
      if (phase === 2n && state.wordRequestedAt === 0n) {
        const vault = await conn.read(block, target, 'vault');
        entry.requestDeadline = BigInt(await conn.read(block, vault, 'gateOpenedAt')) + SILENCE_UNREQUESTED;
      }
      for (const key of pendingKeys(state)) {
        const q = await conn.read(block, source, 'requestOf', [target, key]);
        const w = await conn.read(block, source, 'wordOf', [target, key]);
        const requestedAt = BigInt(q[0]), round = BigInt(q[1]), readyAt = BigInt(w[1]);
        if (requestedAt === 0n || round === 0n) throw new Failure('pending request missing');
        let backup = null;
        if (backed) {
          if (!backups.has(round)) {
            const b = await conn.read(block, source, 'backupOf', [round]);
            const backup = { startedAt: BigInt(b[0]), targetBlock: BigInt(b[1]), fixedAt: BigInt(b[2]), targetTime: null };
            if (backup.startedAt !== 0n && backup.fixedAt === 0n) {
              if (finalized === null) {
                const final = await conn.rpc('eth_getBlockByNumber', ['finalized', false]);
                finalized = BigInt(final.number);
              }
              if (backup.targetBlock <= finalized && backup.targetBlock < block.number) {
                const target = await conn.rpc('eth_getBlockByNumber', [hex(backup.targetBlock), false]);
                if (!target || BigInt(target.number) !== backup.targetBlock) throw new Failure('backup header refused');
                backup.targetTime = BigInt(target.timestamp);
              }
            }
            backups.set(round, backup);
          }
          backup = backups.get(round);
        }
        const deadline = requestedAt + SILENCE;
        const usable = w[0] !== viem.zeroHash && readyAt >= requestedAt && readyAt <= block.now && readyAt <= deadline;
        const silent = block.now > deadline && !usable;
        const item = { tickets: target, key, requestedAt, round, roundTime: roundTime(round), backup, readyAt, deadline, usable, silent };
        entry.keys.push(item);
        if (silent) notices.push(`tickets=${target} key=${key} round=${round} silent deadline=${deadline}`);
      }
      // _head chooses unrequested graduation before any draws as well.
      const head = state.slots !== 0n && state.wordAcceptedAt === 0n
        ? entry.keys.find(k => k.key === 0n) : entry.keys.find(k => k.key === state.drawsSettled + 1n);
      entry.blocked = Boolean(head?.silent);
      tickets.push(entry);
    } catch (error) {
      notices.push(`tickets=${target} ${error instanceof Failure ? error.message : 'state read failed'}`);
    }
  }
  return { block, tickets, notices, finalized };
}
