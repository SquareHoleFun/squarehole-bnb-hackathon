import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeErrorResult, RpcRequestError,
  zeroHash, type Address, type Hex, type LocalAccount } from 'viem';
import { BACKUP_AFTER_SECONDS, BACKUP_LATEST_START_SECONDS, BACKUP_RECENT_BLOCKS, BACKUP_TARGET_BLOCKS,
  RANDOMNESS_SOURCE as source, DRAND_SOURCE as drand } from '../../box-spec/src/generated/box-spec.v1';
import { backedSourceAbi, drandSourceAbi, ABI_OF_JOB } from '../src/abi';
import { DrandReader, START_INCLUSION_SECONDS, HISTORY_WINDOW, DRAND_KEYS_PER_TICK } from '../src/drand';
import { ViemChain, interpret } from '../src/chain';
import { runTick, type ChainPort, type KeeperState } from '../src/run';
import { feesFor } from '../src/gas';
import { incomeCapped } from '../src/income';
import type { Candidate } from '../src/types';
import { fakeClient, fakeNode } from './support/fake-rpc';
import { fakeHeader } from './support/backup';
import { addr, keeper, options, quiet, time } from './support/v2';

const round = 123n, due = time, deadline = due - 12n + 604800n;
const coordinator = addr(1), tickets = addr(7), registry = addr(50), v2Tickets = addr(17);
const mix = `0x${'12'.repeat(32)}` as Hex;
const candidate = (job: 'backupStart' | 'backupFix'): Candidate => ({ job, key: `${job}:${source.toLowerCase()}:${round}`,
  to: source, fn: job === 'backupStart' ? 'startBackup' : 'fixBackup', args: job === 'backupStart' ? [round] : [round, 1000n],
  version: 1, retryAfterBlocks: 2n, drandDeadline: job === 'backupStart' ? due + BACKUP_LATEST_START_SECONDS : deadline });
const status = { minted: 2, slots: 2, wordRequestedAt: 100, wordAcceptedAt: 0, terminalAt: 0, drawsRequested: 0, drawsSettled: 0 };

function fixture(graduationBountyWei = 0n) {
  const cfg = { ...options(), dryRun: false, graduationBountyWei, fromBlock: 0n, boxRegistry: registry,
    box0: { coordinator, hook: addr(2), receiver: addr(3), executor: addr(9) } };
  const node = fakeNode({ block: { number: 1001n, timestamp: due + 432001n, baseFeePerGas: 1n } });
  const base = fakeClient(node);
  let final: bigint | null = 999n;
  let brokenHeader = false;
  let finalError: Error | undefined;
  const rpc = vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
    const p = (params ?? []) as unknown[];
    if (method === 'debug_getRawHeader') return brokenHeader ? '0xc0' : fakeHeader(BigInt(p[0] as string), node.block.timestamp).raw;
    if (method === 'eth_getBlockByNumber') {
      const tag = p[0];
      if (tag === 'finalized' && finalError) throw finalError;
      if (tag === 'finalized' && final === null) throw new Error('private provider payload');
      const n = tag === 'pending' ? node.block.number : tag === 'latest' ? node.block.number - 1n
        : tag === 'finalized' ? final ?? 0n : BigInt(tag as string);
      const { block } = fakeHeader(n, node.block.timestamp);
      return brokenHeader ? { ...block, futureHeaderRoot: mix } : block;
    }
    return base.request({ method, params } as never);
  });
  const pub = createPublicClient({ transport: custom({ request: rpc }, { retryCount: 0 }) });
  const on = (address: Address, fn: string, value: unknown) => { node.calls[`${address.toLowerCase()}:${fn}`] = () => value; };
  on(coordinator, 'randomness', source); on(coordinator, 'tickets', tickets); on(registry, 'boxCount', 0n);
  on(tickets, 'source', source); on(tickets, 'coordinator', coordinator); on(tickets, 'phase', 2); on(tickets, 'status', status);
  on(source, 'requestOf', [due - 12n, round]); on(source, 'wordOf', [zeroHash, 0n]); on(source, 'isSilent', false);
  on(source, 'backupOf', [0n, 0n, 0n, zeroHash]); on(drand, 'roundTime', due); on(drand, 'owedTo', 0n);
  on(source, 'startBackup', 1257n); on(source, 'fixBackup', mix);
  const log = { ...quiet, info: vi.fn(), warn: vi.fn() };
  const reader = new DrandReader(cfg, pub, keeper, log);
  const read = () => reader.read(node.block.number - 1n, node.block.timestamp);
  const account = { address: keeper, signTransaction: vi.fn(async () => '0x1234' as Hex) } as unknown as LocalAccount;
  const relayFetch = vi.fn(async () => { throw new Error('offline relay failure'); });
  const chain = new ViemChain(cfg, pub, keeper, { public: account, private: null }, null, log, undefined, undefined, relayFetch);
  const port: ChainPort = { read: async () => ({ block: node.block, boxes: [], fitGraduated: false, drand: await read() }),
    prepare: (c, f) => chain.prepare(c, f), simulate: (c, f) => chain.simulate(c, f), send: (c, g, f, p) => chain.send(c, g, f, p) };
  return { cfg, node, pub, rpc, on, log, reader, read, chain, port, account, relayFetch,
    finalize: (n: bigint | null) => { final = n; }, finalFailure: (error: Error) => { finalError = error; }, breakHeader: () => { brokenHeader = true; } };
}
const backups = (cs: Candidate[]) => cs.filter(c => c.job === 'backupStart' || c.job === 'backupFix');

describe('box 0 backup discovery', () => {
  it('pins the source clocks and proof window without another spec owner', () => {
    expect([BACKUP_AFTER_SECONDS, BACKUP_LATEST_START_SECONDS, BACKUP_RECENT_BLOCKS, BACKUP_TARGET_BLOCKS])
      .toEqual([432000n, 496800n, 8n, 256n]);
    expect(START_INCLUSION_SECONDS).toBe(96n); expect(HISTORY_WINDOW).toBe(8191n);
    const sol = readFileSync(new URL('../../contracts/src/box/randomness/BoxBackedSource.sol', import.meta.url), 'utf8');
    expect(sol).toContain(`uint256 public constant HISTORY_WINDOW = ${HISTORY_WINDOW};`);
  });
  it.each([[432000n, false], [432001n, true], [496704n, true], [496705n, false], [496801n, false]] as const)('starts at round plus %s only when the inclusion margin fits', async (offset, allowed) => {
    const f = fixture(); f.node.block.timestamp = due + offset;
    const cs = await f.read();
    expect(backups(cs)).toEqual(allowed ? [candidate('backupStart')] : []);
    expect(cs.some(c => c.job === 'drandPostRound')).toBe(true);
  });
  it.each(['started', 'fixed', 'posted', 'silent', 'terminal', 'unreadable head', 'unrequested', 'coordinator', 'v2'] as const)('never starts for %s', async kind => {
    const f = fixture();
    if (kind === 'started' || kind === 'fixed') f.on(source, 'backupOf', [due + 432001n, 2000n, kind === 'fixed' ? due + 432002n : 0n, zeroHash]);
    if (kind === 'posted') f.on(source, 'wordOf', [mix, due + 1n]);
    if (kind === 'silent') f.on(source, 'isSilent', true);
    if (kind === 'terminal') f.on(tickets, 'status', { ...status, terminalAt: 1 });
    if (kind === 'unreadable head') f.node.calls[`${source.toLowerCase()}:requestOf`] = () => { throw new Error('offline'); };
    if (kind === 'unrequested') f.on(source, 'requestOf', [0n, 0n]);
    if (kind === 'coordinator') {
      f.on(tickets, 'status', { ...status, terminalAt: 1 });
      f.node.logs = () => [{ address: source, topics: encodeEventTopics({ abi: drandSourceAbi, eventName: 'Requested', args: { consumer: coordinator, key: 0n } }),
        data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [round, 0n]), blockNumber: '0x1', blockHash: mix,
        transactionHash: mix, transactionIndex: '0x0', logIndex: '0x0', removed: false }];
    }
    if (kind === 'v2') {
      f.on(tickets, 'status', { ...status, terminalAt: 1 });
      f.on(registry, 'boxCount', 1n); f.node.calls[`${registry}:roleOf`] = ([, role]) => role === 7n ? v2Tickets : addr(11);
      f.on(v2Tickets, 'source', drand); f.on(v2Tickets, 'coordinator', addr(11)); f.on(v2Tickets, 'status', status); f.on(v2Tickets, 'phase', 2);
      f.on(drand, 'requestOf', [due - 12n, round]); f.on(drand, 'wordOf', [zeroHash, 0n]); f.on(drand, 'isSilent', false);
    }
    expect(backups(await f.read())).toEqual([]);
  });
  it('takes Requested hints only within the existing sequential-read bound', async () => {
    const f = fixture();
    f.node.calls[`${source.toLowerCase()}:requestOf`] = ([, key]) => [due - 12n, round + (key as bigint)];
    const hint = { address: source, topics: encodeEventTopics({ abi: drandSourceAbi, eventName: 'Requested', args: { consumer: tickets, key: 1000n } }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [round + 1000n, 0n]), blockNumber: '0x1', blockHash: mix,
      transactionHash: mix, transactionIndex: '0x0', logIndex: '0x0', removed: false };
    f.node.logs = () => [hint];
    expect(backups(await f.read()).map(c => c.args[0])).toEqual([round, round + 1000n]);
    f.on(tickets, 'status', { ...status, drawsRequested: 70 });
    const cs = backups(await f.read());
    expect(BigInt(cs.length)).toBe(DRAND_KEYS_PER_TICK);
    expect(cs.at(-1)?.args).toEqual([round + DRAND_KEYS_PER_TICK - 1n]);
    expect(cs.some(c => c.args[0] === round + 1000n)).toBe(false);
    f.node.calls[`${source.toLowerCase()}:isSilent`] = ([, key]) => key === 0n;
    expect(backups(await f.read())).toEqual([]);
  });
  it('warns hourly per round after the latest start, while keeping its drand post', async () => {
    const f = fixture(); f.node.block.timestamp = due + 496705n;
    f.on(tickets, 'status', { ...status, drawsRequested: 2 });
    for (const advance of [0n, 1n, 3599n]) { f.node.block.timestamp += advance; expect((await f.read()).some(c => c.job === 'drandPostRound')).toBe(true); }
    expect(f.log.warn.mock.calls.filter(([s]) => s === 'box 0 backup past its latest start')).toHaveLength(2);
    expect(f.log.warn).toHaveBeenCalledWith('box 0 backup past its latest start', { consumer: tickets, key: 0n, round });
  });
  it.each([[999n, 1000n, 0n, false], [1000n, 1000n, 0n, true], [1000n, 9183n, 0n, true],
    [1000n, 9184n, 0n, false], [1000n, 1000n, deadline - 96n, true], [1000n, 1000n, deadline - 95n, false]] as const)('fixes with final %s, latest %s and time %s only inside both windows', async (final, latest, now, allowed) => {
    const f = fixture(); f.finalize(final); f.node.block.number = latest + 1n;
    if (now) f.node.block.timestamp = now;
    f.on(source, 'backupOf', [due + 432001n, 1000n, 0n, zeroHash]);
    const cs = await f.read(); expect(backups(cs)).toEqual(allowed ? [candidate('backupFix')] : []);
    expect(cs.some(c => c.job === 'drandPostRound')).toBe(false);
    if (!allowed && final >= 1000n) expect(f.log.warn).toHaveBeenCalledWith('box 0 backup fix window closed', expect.objectContaining({ round, targetBlock: 1000n }));
  });
  it('uses the earliest live request deadline and reads backup and finalized once per tick', async () => {
    const f = fixture(); f.finalize(1000n); f.on(tickets, 'status', { ...status, drawsRequested: 2 });
    f.node.calls[`${source.toLowerCase()}:requestOf`] = ([, key]) => [key === 1n ? due - 20n : due - 12n, round];
    const backup = vi.fn(() => [due + 432001n, 1000n, 0n, zeroHash]); f.node.calls[`${source.toLowerCase()}:backupOf`] = backup;
    expect(backups(await f.read())).toMatchObject([{ job: 'backupFix', drandDeadline: due - 20n + 604800n }]);
    expect(backup).toHaveBeenCalledTimes(1);
    expect(f.rpc.mock.calls.filter(([r]) => r.method === 'eth_getBlockByNumber' && (r.params as unknown[])[0] === 'finalized')).toHaveLength(1);
  });
  it('has no finality read without an unfixed backup, and an unreadable finalized block leaves an incomplete observation', async () => {
    const f = fixture(); await f.read();
    expect(f.rpc.mock.calls.some(([r]) => r.method === 'eth_getBlockByNumber' && (r.params as unknown[])[0] === 'finalized')).toBe(false);
    f.on(source, 'backupOf', [due + 432001n, 1000n, 1n, mix]); expect(backups(await f.read())).toEqual([]);
    f.on(source, 'backupOf', [due + 432001n, 1000n, 0n, zeroHash]); f.finalize(null);
    expect(backups(await f.read())).toEqual([]); expect(f.reader.observation().complete).toBe(false);
  });
  it('counts every unreadable finality answer as incomplete even if its RPC error resembles a contract revert', async () => {
    const f = fixture();
    f.on(source, 'backupOf', [due + 432001n, 1000n, 0n, zeroHash]);
    f.finalFailure(new RpcRequestError({ body: {}, url: 'fake', error: { code: 3, message: 'execution reverted' } }));
    expect(backups(await f.read())).toEqual([]);
    expect(f.reader.observation().complete).toBe(false);
  });
  it('warns hourly per round for the backup and its closed fix window', async () => {
    const f = fixture(); f.on(tickets, 'status', { ...status, drawsRequested: 2 });
    f.on(source, 'backupOf', [due + 432001n, 1000n, 0n, zeroHash]); f.node.block.number = 9185n;
    for (const advance of [0n, 1n, 3599n]) { f.node.block.timestamp += advance; await f.read(); }
    for (const message of ['box 0 round on its backup', 'box 0 backup fix window closed']) {
      expect(f.log.warn.mock.calls.filter(([s]) => s === message)).toHaveLength(2);
    }
    expect(f.log.warn).toHaveBeenCalledWith('box 0 backup fix window closed', { consumer: tickets, key: 0n, round, targetBlock: 1000n });
  });
});

describe('two-block backup retry cadence', () => {
  for (const job of ['backupStart', 'backupFix', 'drandPostRound'] as const) {
    it.each(['sent', 'no work', 'simulation error'] as const)(`${job} waits two blocks after %s`, async outcome => {
      const f = fixture();
      const c: Candidate = job === 'drandPostRound'
        ? { ...candidate('backupStart'), job, key: `drandPostRound:${drand.toLowerCase()}:${round}`, to: drand, fn: 'postRound' }
        : candidate(job);
      const prepare = vi.fn(async (c: Candidate) => c);
      const simulate = vi.fn(async () => {
        if (outcome === 'simulation error') throw new Error('offline simulation failure');
        return { ok: outcome === 'sent', tipWei: null, estimate: 100000n };
      });
      const send = vi.fn(async () => 'hash');
      const port: ChainPort = {
        read: async () => ({ block: { ...f.node.block }, boxes: [], fitGraduated: false, drand: [c] }),
        prepare, simulate, send,
      };
      const block = f.node.block.number;
      const first = await runTick(port, {}, f.cfg, quiet);
      expect.soft(first.state.mem?.attempts[c.key]).toEqual({ block, next: block + 2n });
      expect(send).toHaveBeenCalledTimes(outcome === 'sent' ? 1 : 0);
      if (outcome !== 'sent') expect(first.report.skipped).toContainEqual(expect.objectContaining({
        job, why: outcome === 'no work' ? 'nothing to do' : 'simulation error',
      }));
      f.node.block.number++; f.node.block.timestamp += 12n;
      const waiting = await runTick(port, first.state, f.cfg, quiet);
      expect.soft(waiting.report).toMatchObject({ sent: [], skipped: [] });
      expect.soft(prepare).toHaveBeenCalledTimes(1);
      expect.soft(simulate).toHaveBeenCalledTimes(1);
      f.node.block.number++; f.node.block.timestamp += 12n;
      const retry = await runTick(port, waiting.state, f.cfg, quiet);
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(simulate).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledTimes(outcome === 'sent' ? 2 : 0);
      expect(retry.state.mem?.attempts[c.key]).toEqual({ block: block + 2n, next: block + 4n });
    });
  }
  for (const job of ['backupStart', 'backupFix'] as const) {
    it.each(['fee', 'budget'] as const)(`${job} stays eligible on the next block after a %s wait`, async kind => {
      const f = fixture(), c = candidate(job);
      const cfg = { ...f.cfg, limits: { ...f.cfg.limits, drandRescueWeiPerDay: 0n } };
      const simulate = vi.fn(async () => ({ ok: true, tipWei: null, estimate: 100000n }));
      const port: ChainPort = {
        read: async () => ({ block: { ...f.node.block }, boxes: [], fitGraduated: false, drand: [c] }),
        simulate, send: vi.fn(async () => 'hash'),
      };
      if (kind === 'fee') f.node.block.baseFeePerGas = 1600000000n;
      const waitingCfg = kind === 'budget' ? { ...cfg, limits: { ...cfg.limits, oursWeiPerDay: 0n } } : cfg;
      const first = await runTick(port, {}, waitingCfg, quiet);
      expect(first.report.skipped).toContainEqual(expect.objectContaining({ job,
        why: kind === 'fee' ? 'fee ceiling reached' : 'ours budget spent' }));
      expect(first.state.mem?.attempts[c.key]).toBeUndefined();
      expect(simulate).toHaveBeenCalledTimes(kind === 'fee' ? 0 : 1);
      f.node.block.number++; f.node.block.timestamp += 12n; f.node.block.baseFeePerGas = 1n;
      const next = await runTick(port, first.state, cfg, quiet);
      expect(next.report.sent.map(c => c.job)).toEqual([job]);
    });
  }
});

describe('backup preparation, pending races and signing', () => {
  it.each(['backupStart', 'backupFix'] as const)('%s prepares the exact header and simulates pending', async job => {
    const f = fixture(), fees = feesFor(1n, 1n); const simulate = vi.spyOn(f.pub, 'simulateContract');
    const c = await f.chain.prepare(candidate(job), fees);
    // The start proves the latest block's parent (999; the fixture's latest is 1000); the fix its committed target.
    const header = fakeHeader(job === 'backupStart' ? 999n : 1000n, f.node.block.timestamp).raw;
    expect(c.args).toEqual(job === 'backupStart' ? [round, 999n, header] : [round, header]);
    expect((await f.chain.simulate(c, fees)).ok).toBe(true);
    expect(simulate).toHaveBeenCalledWith(expect.objectContaining({ blockTag: 'pending', args: c.args }));
    expect(ABI_OF_JOB[job]).toBe(backedSourceAbi); expect(incomeCapped(c)).toBe(false);
  });
  // Part 2b review: a provider may simulate `pending` in the latest block's context (NUMBER = latest), and the
  // contract refuses the current block's own header. The parent (latest - 1) proves the format in both contexts,
  // as the second poster and the laptop recipe already do (execution.mjs, never-stuck.md "uses N-1").
  it('takes a start header the contract accepts whether pending simulates at the latest block number or the next', async () => {
    const sol = readFileSync(new URL('../../contracts/src/box/randomness/BoxBackedSource.sol', import.meta.url), 'utf8');
    expect(sol).toContain('if (headerBlock >= block.number || block.number - headerBlock > RECENT_BLOCKS) {');
    const accepts = (headerBlock: bigint, number: bigint) => !(headerBlock >= number || number - headerBlock > BACKUP_RECENT_BLOCKS);
    const f = fixture();
    const latest = (await f.pub.getBlock({ blockTag: 'latest' })).number;
    const c = await f.chain.prepare(candidate('backupStart'), feesFor(1n, 1n));
    const headerBlock = c.args[1] as bigint;
    expect(c.args[2]).toBe(fakeHeader(headerBlock, f.node.block.timestamp).raw);
    for (const number of [latest, latest + 1n]) expect.soft(accepts(headerBlock, number), `NUMBER ${number}`).toBe(true);
    // Still included up to six blocks after the next one.
    expect(accepts(headerBlock, latest + 7n)).toBe(true);
  });
  it('interprets only a positive target and a bytes32 mix as work', () => {
    for (const value of [0n, -1n, undefined, '0x12']) expect(interpret(candidate('backupStart'), value, null).ok).toBe(false);
    expect(interpret(candidate('backupStart'), 1257n, null).ok).toBe(true);
    for (const value of [1n, undefined, '0x12']) expect(interpret(candidate('backupFix'), value, null).ok).toBe(false);
    expect(interpret(candidate('backupFix'), zeroHash, null).ok).toBe(true);
  });
  it.each(['RoundAlreadyPosted', 'BackupAlreadyStarted', 'BackupTooEarly', 'BackupTooLate'] as const)('sends nothing when pending simulation reports %s', async errorName => {
    const f = fixture();
    const data = encodeErrorResult({ abi: backedSourceAbi, errorName, args: errorName === 'BackupTooEarly' || errorName === 'BackupTooLate' ? [round, due] : [round] });
    vi.spyOn(f.pub, 'simulateContract').mockRejectedValue(new RpcRequestError({ body: {}, url: 'fake', error: { code: 3, message: 'execution reverted', data } }));
    f.port.read = async () => ({ block: f.node.block, boxes: [], fitGraduated: false, drand: [candidate('backupStart')] });
    const result = await runTick(f.port, {}, f.cfg, f.log);
    expect(result.report.sent).toEqual([]); expect(f.node.sent).toEqual([]); expect(f.account.signTransaction).not.toHaveBeenCalled();
  });
  it('refuses a late start before a nonce or signature, and logs only hourly per round', async () => {
    const f = fixture(); f.node.block.timestamp = due + 496705n;
    const count = vi.spyOn(f.pub, 'getTransactionCount');
    for (const advance of [0n, 1n, 3599n]) {
      f.node.block.timestamp += advance; await f.chain.read();
      await expect(f.chain.send(candidate('backupStart'), 300000n, feesFor(1n, 1n), false)).rejects.toThrow('backup start window closed');
    }
    expect(count).not.toHaveBeenCalled(); expect(f.account.signTransaction).not.toHaveBeenCalled();
    expect(f.log.warn.mock.calls.filter(([s]) => s === 'backup start window closed')).toHaveLength(2);
  });
  it('logs a header mismatch hourly per round for either job with no provider text or signatures', async () => {
    const f = fixture(); f.breakHeader();
    for (const advance of [0n, 1n, 3599n]) {
      f.node.block.timestamp += advance; await f.chain.read();
      for (const job of ['backupStart', 'backupFix'] as const) {
        await expect(f.chain.prepare(candidate(job), feesFor(1n, 1n))).rejects.toThrow(/^backup header mismatch$/);
      }
    }
    expect(f.log.warn.mock.calls.filter(([s]) => s === 'backup header mismatch')).toHaveLength(2);
    expect(JSON.stringify(f.log.warn.mock.calls, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v)).not.toContain('private provider payload');
    expect(f.account.signTransaction).not.toHaveBeenCalled();
  });
  it.each(['sent', 'simulation error', 'fee wait', 'budget wait'] as const)('drand first: a post with %s has the required effect', async kind => {
    const f = fixture(); await f.chain.read();
    const originalPrepare = f.port.prepare;
    if (!originalPrepare) throw new Error('missing fixture preparation');
    f.port.prepare = (c, fees) => c.job === 'drandPostRound' && kind !== 'simulation error' ? Promise.resolve(c) : originalPrepare(c, fees);
    const originalSim = f.port.simulate;
    f.port.simulate = (c, fees) => c.job === 'drandPostRound' ? Promise.resolve({ ok: true, tipWei: null, estimate: kind === 'budget wait' ? 10000000n : 100000n }) : originalSim(c, fees);
    const sent: string[] = []; f.port.send = async c => { sent.push(c.job); return 'hash'; };
    if (kind === 'fee wait') { f.node.block.baseFeePerGas = 1600000000n;
      const read = f.port.read; f.port.read = async () => { const w = await read(); return { ...w, drand: w.drand?.map(c => c.job === 'drandPostRound' ? { ...c, drandDeadline: undefined } : c) }; }; }
    const cfg = kind === 'budget wait' ? { ...f.cfg, limits: { ...f.cfg.limits, oursWeiPerDay: 100000000000000n, reserveWeiPerDay: 0n, drandRescueWeiPerDay: 0n } } : f.cfg;
    const result = await runTick(f.port, {}, cfg, f.log);
    expect(sent).toEqual(kind === 'sent' ? ['drandPostRound'] : ['backupStart']);
    if (kind === 'sent') {
      expect(result.report.skipped).toContainEqual(expect.objectContaining({ job: 'backupStart', why: 'round posted this tick' }));
      expect(f.log.info).toHaveBeenCalledWith('skipped', expect.objectContaining({ code: 'SLOT_TAKEN' }));
      expect(f.log.warn).not.toHaveBeenCalledWith('skipped', expect.objectContaining({ code: 'SLOT_TAKEN' }));
    }
    if (kind === 'simulation error') expect(result.report.skipped).toContainEqual(expect.objectContaining({ job: 'drandPostRound', why: 'simulation error' }));
  });
  it.each(['reader order', 'start first', 'send error', 'dry run'] as const)('skips a queued graduation bounty when starting its backup: %s', async kind => {
    const f = fixture(10000000000000000n);
    f.on(drand, 'bountyOf', 0n); f.on(drand, 'addBounty', undefined);
    await f.chain.read();
    const queued = await f.read();
    expect(queued.map(c => c.job)).toEqual(['drandGraduationBounty', 'backupStart', 'drandPostRound']);
    expect(queued[0]?.value).toBe(10000000000000000n);
    if (kind === 'start first') {
      const read = f.port.read;
      f.port.read = async () => { const w = await read(); return { ...w, drand: w.drand?.slice().reverse() }; };
    }
    const simulate = vi.spyOn(f.chain, 'simulate');
    const checkpoints: KeeperState[] = [];
    f.node.onSend = () => {
      const signed = vi.mocked(f.account.signTransaction).mock.calls.at(-1)?.[0];
      if (signed?.to?.toLowerCase() === source.toLowerCase()) {
        f.on(source, 'backupOf', [f.node.block.timestamp, f.node.block.number + BACKUP_TARGET_BLOCKS, 0n, zeroHash]);
        if (kind === 'send error') throw new Error('offline reply lost after acceptance');
      }
    };
    const result = await runTick(f.port, {}, { ...f.cfg, dryRun: kind === 'dry run',
      checkpoint: async state => { checkpoints.push(structuredClone(state)); } }, f.log);
    expect(f.relayFetch).toHaveBeenCalledTimes(4);
    expect(result.report.skipped).toContainEqual(expect.objectContaining({ job: 'drandPostRound', why: 'simulation error' }));
    expect.soft(result.report.sent.map(c => c.job)).toEqual(kind === 'send error' ? [] : ['backupStart']);
    expect.soft(simulate.mock.calls.map(([c]) => c.job)).toEqual(['backupStart']);
    expect.soft(result.report.skipped).toContainEqual(expect.objectContaining({ job: 'drandGraduationBounty', why: 'round backup starting this tick' }));
    expect.soft(f.log.info).toHaveBeenCalledWith('skipped', expect.objectContaining({ code: 'SLOT_TAKEN' }));
    expect.soft(f.log.warn).not.toHaveBeenCalledWith('skipped', expect.objectContaining({ code: 'SLOT_TAKEN' }));
    const signed = vi.mocked(f.account.signTransaction).mock.calls.map(([tx]) => tx);
    expect.soft(signed.map(tx => tx.to)).toEqual(kind === 'dry run' ? [] : [source]);
    expect.soft(signed.map(tx => tx.value ?? 0n)).toEqual(kind === 'dry run' ? [] : [0n]);
    expect.soft(f.node.sent).toHaveLength(kind === 'send error' || kind === 'dry run' ? 0 : 1);
    expect(checkpoints.length).toBeGreaterThan(0);
    for (const state of [...checkpoints, result.state]) {
      expect.soft(state.drandBounties).toEqual({});
      expect.soft(state.budget?.pending?.map(r => r.valueWei ?? 0n)).toEqual([0n]);
      expect.soft(state.budget?.totalWei).toBe(250000n * feesFor(f.node.block.baseFeePerGas, f.cfg.priorityFeeWei).maxFeePerGas);
    }
  });
  it('keeps the graduation bounty eligible when the start simulation finds no work', async () => {
    const f = fixture(10000000000000000n);
    f.on(drand, 'bountyOf', 0n); f.on(drand, 'addBounty', undefined); f.on(source, 'startBackup', 0n);
    await f.chain.read();
    const result = await runTick(f.port, {}, f.cfg, f.log);
    expect(result.report.sent.map(c => c.job)).toEqual(['drandGraduationBounty']);
    expect(vi.mocked(f.account.signTransaction).mock.calls.map(([tx]) => tx.value)).toEqual([10000000000000000n]);
    expect(Object.keys(result.state.drandBounties)).toEqual([`${drand.toLowerCase()}:${round}`]);
  });
  it.each(['backupStart', 'backupFix'] as const)('signs %s through the real adapter under R62, including the exact start cutoff', async job => {
    const f = fixture(); f.node.block.baseFeePerGas = 1600000000n;
    f.node.block.timestamp = job === 'backupStart' ? due + 496704n : deadline - 71n * 3600n;
    await f.chain.read();
    const c = candidate(job);
    f.port.read = async () => ({ block: f.node.block, boxes: [], fitGraduated: false, drand: [c] });
    const result = await runTick(f.port, {}, f.cfg, f.log);
    expect(result.report.sent.map(s => s.job)).toEqual([job]); expect(f.node.sent).toHaveLength(1);
    expect(result.state.budget).toMatchObject({ totalWei: 0n, oursWei: 0n, pokesWei: 0n, drandRescueWei: 250000n * 3250000000n });
    const signed = vi.mocked(f.account.signTransaction).mock.calls[0]?.[0];
    expect(signed).toMatchObject({ to: source, maxFeePerGas: 3250000000n, gas: 250000n, nonce: 0 });
    if (!signed?.data) throw new Error('missing signed calldata');
    expect(decodeFunctionData({ abi: backedSourceAbi, data: signed.data }).functionName).toBe(c.fn);
  });
  it('keeps dry runs unsigned', async () => {
    const f = fixture(); await f.chain.read(); const result = await runTick(f.port, {}, { ...f.cfg, dryRun: true }, f.log);
    expect(result.report.sent.map(c => c.job)).toEqual(['backupStart']); expect(f.account.signTransaction).not.toHaveBeenCalled();
  });
  it('lives from a withheld graduation word through start, final target, fix and next-tick acceptance', async () => {
    const f = fixture(); await f.chain.read(); let target = 0n, fixedAt = 0n;
    f.port.send = async c => {
      if (c.job === 'backupStart') { target = f.node.block.number + BACKUP_TARGET_BLOCKS; f.on(source, 'backupOf', [f.node.block.timestamp, target, 0n, zeroHash]); }
      if (c.job === 'backupFix') { fixedAt = f.node.block.timestamp; f.on(source, 'backupOf', [due + 432001n, target, fixedAt, mix]); f.on(source, 'wordOf', [mix, fixedAt]); }
      return 'hash';
    };
    const start = await runTick(f.port, {}, f.cfg, f.log); expect(start.report.sent.map(c => c.job)).toEqual(['backupStart']);
    f.node.block.number = target + 65n; f.node.block.timestamp += (BACKUP_TARGET_BLOCKS + 64n) * 12n; f.finalize(target);
    expect((await f.read()).some(c => c.job === 'drandPostRound')).toBe(false);
    const fix = await runTick(f.port, start.state, f.cfg, f.log); expect(fix.report.sent.map(c => c.job)).toEqual(['backupFix']);
    f.node.block.number++; f.node.block.timestamp += 12n;
    const next = await f.read(); expect(next).toMatchObject([{ job: 'drandAcceptWord', drandDeadline: deadline }]);
    expect(next.some(c => c.job === 'drandPostRound')).toBe(false); expect(fixedAt).toBeLessThan(deadline);
  });
  it('publishes every fixed backup warning in the service allowlist', () => {
    const text = readFileSync(new URL('../../../infra/server/services/keeper.mjs', import.meta.url), 'utf8');
    for (const message of ['box 0 round on its backup', 'box 0 backup past its latest start', 'box 0 backup fix window closed', 'backup header mismatch', 'backup start window closed']) expect(text).toContain(`'${message}'`);
  });
});
