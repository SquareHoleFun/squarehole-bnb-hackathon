import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, zeroHash, type Address, type Hex, type LocalAccount } from 'viem';
import { drandSourceAbi } from '../../chain/src/abi/drandSource';
// F143: box 0 (v1) reads through its BoxBackedSource (`source`); v2 tickets and every post use the DrandSource (`drand`).
import { RANDOMNESS_SOURCE as source, DRAND_SOURCE as drand } from '../../box-spec/src/generated/box-spec.v1';
import { DrandReader } from '../src/drand';
import { drandFeeApplies } from '../src/drand-fee';
import { ViemChain, checkChainId } from '../src/chain';
import { loadConfig } from '../src/config';
import { runTick, type ChainPort } from '../src/run';
import { plan, emptyMemory } from '../src/plan';
import { decide, openBudget } from '../src/decide';
import { feesFor } from '../src/gas';
import { jobSpec } from '../src/jobs';
import { fakeClient, fakeNode, REVERT } from './support/fake-rpc';
import { decodeFunctionData } from 'viem';
import { drandTicketsAbi } from '../src/abi';
import { encodeState, decodeState } from '../src/state';
import { addr, keeper, options, quiet } from './support/v2';
import type { Candidate } from '../src/types';
import type { World } from '../src/world';

const vectors = JSON.parse(readFileSync(new URL('../../contracts/test/vectors/drand-quicknet.json', import.meta.url), 'utf8')) as {
  rounds: number[]; roundTimes: number[]; signatures: Hex[]; signaturesXY: Hex[]; randomness: Hex[];
};
const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing public test vector');
  return value;
}
const round = BigInt(required(vectors.rounds[1]));
const due = BigInt(required(vectors.roundTimes[1]));
const relayBody = { round: String(round), signature: required(vectors.signatures[1]).slice(2), randomness: required(vectors.randomness[1]).slice(2) };
const word = `0x${'12'.repeat(32)}` as Hex;
const coordinator = addr(1), tickets = addr(7), v2Tickets = addr(17), registry = addr(50);
const status = () => ({ minted: 2, slots: 2, wordRequestedAt: 0, wordAcceptedAt: 0, terminalAt: 0, drawsRequested: 0, drawsSettled: 0 });

function requested(consumer: Address, key: bigint, at = 10n, r = round) {
  return { address: source, topics: encodeEventTopics({ abi: drandSourceAbi, eventName: 'Requested', args: { consumer, key } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [r, 0n]),
    blockNumber: `0x${at.toString(16)}`, blockHash: word, transactionHash: word, transactionIndex: '0x0', logIndex: '0x0', removed: false };
}

function fixture() {
  const cfg = { ...options(), fromBlock: 10n, boxRegistry: registry,
    box0: { coordinator, hook: addr(2), receiver: addr(3), executor: addr(9) } };
  const node = fakeNode({ block: { number: 20n, timestamp: due, baseFeePerGas: 1n } });
  const pub = fakeClient(node);
  const log = { ...quiet, warn: vi.fn() };
  const on = (address: Address, fn: string, result: unknown) => { node.calls[`${address.toLowerCase()}:${fn}`] = () => result; };
  on(coordinator, 'tickets', tickets); on(coordinator, 'randomness', source);
  on(registry, 'boxCount', 2n);
  node.calls[`${registry}:roleOf`] = ([id, role]) => id === 1n ? addr(0) : role === 7n ? v2Tickets : addr(11);
  for (const t of [tickets, v2Tickets]) {
    on(t, 'coordinator', t === tickets ? coordinator : addr(11));
    on(t, 'source', t === tickets ? source : drand); on(t, 'status', status()); on(t, 'phase', 2);
  }
  on(source, 'owedTo', 0n); on(source, 'requestOf', [due - 12n, round]);
  on(source, 'wordOf', [zeroHash, 0n]); on(source, 'isSilent', false);
  on(source, 'roundTime', due);
  // Box 0's backed source: no backup started (F143; the DrandSource has no backupOf).
  on(source, 'backupOf', [0n, 0n, 0n, zeroHash]);
  // The fake DrandSource answers as the fake backed source does (the tests set one behaviour for both reads), so a
  // test that changes `source` changes `drand` too; the calls a test expects say which of the two is the target.
  for (const fn of ['requestOf', 'wordOf', 'isSilent', 'roundTime', 'owedTo', 'postRound', 'withdrawBounty', 'bountyOf', 'addBounty']) {
    node.calls[`${drand.toLowerCase()}:${fn}`] = args => required(node.calls[`${source.toLowerCase()}:${fn}`])(args);
  }
  const reader = new DrandReader(cfg, pub, keeper, log);
  return { cfg, node, pub, log, on, reader };
}

function queuedFixture(t: Address) {
  const f = fixture();
  const headRequestedAt = due - 604_800n - 1n;
  const headRound = round - 201_600n;
  f.on(t, 'phase', 3);
  f.on(t, 'status', { ...status(), wordRequestedAt: 100, wordAcceptedAt: 113, drawsRequested: 2 });
  f.on(t === tickets ? v2Tickets : tickets, 'phase', 1);
  // Backfill has only the later draw: the head must come from current ticket state.
  f.node.logs = () => [requested(t, 2n)];
  f.node.calls[`${source.toLowerCase()}:requestOf`] = ([consumer, key]) =>
    consumer === t && key === 1n ? [headRequestedAt, headRound] : [due - 12n, round];
  f.node.calls[`${source.toLowerCase()}:isSilent`] = ([consumer, key]) => consumer === t && key === 1n;
  f.node.calls[`${source.toLowerCase()}:roundTime`] = ([r]) => r === headRound ? headRequestedAt + 12n : due;
  return { ...f, headRequestedAt, headRound };
}

// SH-249: real signatures differ per nonce; the saved record refuses two entries with one hash.
const signedBytes = (tx: { nonce?: number }) => `0x1234${(tx.nonce ?? 0).toString(16).padStart(8, '0')}` as Hex;

describe('drand discovery and consumer recovery (DRAND-02/03)', () => {
  it.each([true, false])('af1 F3 rechecks the scan anchor after logs without historical state (pending anchor: %s)', async anchored => {
    const f = fixture();
    let canonical = true;
    const changed = `0x${'34'.repeat(32)}` as Hex;
    const header = vi.spyOn(f.pub, 'getBlock').mockImplementation(async ({ blockNumber = 50_000n } = {}) => ({
      number: blockNumber, hash: canonical ? word : changed, parentHash: canonical ? word : changed,
    } as never));
    f.node.logs = () => { canonical = false; return []; };
    await f.reader.read(19n, due, anchored ? word : undefined);
    expect(f.reader.observation().complete).toBe(false);
    expect(header).toHaveBeenCalledWith(anchored ? { blockNumber: 19n } : { blockNumber: 20n });
    canonical = true;
    f.node.logs = () => [];
    f.node.ranges.length = 0;
    await f.reader.read(21n, due, anchored ? word : undefined);
    expect(f.node.ranges.map(r => [r.from, r.to])).toEqual([[10n, 21n], [10n, 21n]]);
    expect(f.reader.observation().complete).toBe(true);
  });

  it('af1 F3 rejects a changed backfill anchor through its fresh canonical child', async () => {
    const f = fixture();
    let canonical = false;
    const header = vi.spyOn(f.pub, 'getBlock').mockImplementation(async ({ blockNumber = 50_000n } = {}) => ({
      number: blockNumber, hash: word, parentHash: canonical ? word : `0x${'34'.repeat(32)}`,
    } as never));
    await f.reader.read(50_000n, due, word);
    expect(f.reader.observation().complete).toBe(false);
    expect(header).toHaveBeenCalledWith({ blockNumber: 16_010n });
    canonical = true;
    f.node.ranges.length = 0;
    await f.reader.read(50_000n, due, word);
    expect(f.node.ranges[0]?.from).toBe(10n);
  });

  it('discovers box 0 coordinator/tickets and every registered v2 ticket, deduplicating a shared round', async () => {
    const f = fixture();
    f.node.logs = () => [requested(coordinator, 0n), requested(tickets, 0n), requested(v2Tickets, 1n), requested(addr(999), 3n)];
    const cs = await f.reader.read(19n, due);
    expect(cs.filter(c => c.job === 'drandPostRound')).toMatchObject([{ to: drand, args: [round] }]);
    expect(cs.some(c => c.to === addr(999))).toBe(false);
    // One Requested scan per source: box 0's on its backed source, the v2 tickets' on the DrandSource.
    expect(f.node.ranges).toEqual([{ address: source, from: 10n, to: 19n }, { address: drand, from: 10n, to: 19n }]);
  });

  it('F143: reads box 0 on its backed source and v2 tickets on the DrandSource, and posts every round on the DrandSource', async () => {
    const f = fixture();
    const v1Round = round, v2Round = round + 3n;
    f.node.logs = (address: Address) => same(address, source) ? [requested(tickets, 1n, 10n, v1Round)]
      : same(address, drand) ? [requested(v2Tickets, 1n, 10n, v2Round)] : [];
    // Each source knows only its own consumers' requests (the backed source keys DrandSource's by itself).
    f.node.calls[`${source.toLowerCase()}:requestOf`] = ([consumer]) => consumer === tickets ? [due - 12n, v1Round] : [0n, 0n];
    f.node.calls[`${drand.toLowerCase()}:requestOf`] = ([consumer]) => consumer === v2Tickets ? [due - 12n, v2Round] : [0n, 0n];
    f.node.calls[`${drand.toLowerCase()}:wordOf`] = () => [zeroHash, 0n];
    f.node.calls[`${drand.toLowerCase()}:isSilent`] = () => false;
    f.node.calls[`${drand.toLowerCase()}:roundTime`] = () => due;
    const cs = await f.reader.read(19n, due);
    const posts = cs.filter(c => c.job === 'drandPostRound');
    expect(posts.map(c => c.args[0])).toEqual([v1Round, v2Round]);
    expect(posts.every(c => c.to === drand)).toBe(true);
    expect(cs.some(c => c.to === source)).toBe(false);
  });

  it('F143 review F4: does not post a box 0 round whose backup started (drand is ignored there), unless a v2 box needs it', async () => {
    const started = [due + 432_001n, 1_000n, 0n, zeroHash] as const;
    // Box 0 alone on the round: its backup started, so a drand post would be ignored (and RoundKnown after it).
    const f = fixture();
    f.node.logs = (address: Address) => same(address, source) ? [requested(tickets, 1n)] : [];
    f.on(source, 'backupOf', started);
    f.node.calls[`${drand.toLowerCase()}:requestOf`] = () => [0n, 0n];
    const cs = await f.reader.read(19n, due);
    expect(cs.filter(c => c.job === 'drandPostRound')).toEqual([]);
    expect(f.log.warn).toHaveBeenCalledWith('box 0 round on its backup', expect.objectContaining({ consumer: tickets, key: 1n, round }));
    // A v2 box on the same round still gets it posted once, on the DrandSource.
    const g = fixture();
    g.node.logs = (address: Address) => same(address, source) ? [requested(tickets, 1n)]
      : same(address, drand) ? [requested(v2Tickets, 1n)] : [];
    g.on(source, 'backupOf', started);
    g.node.calls[`${source.toLowerCase()}:requestOf`] = ([consumer]) => consumer === tickets ? [due - 12n, round] : [0n, 0n];
    g.node.calls[`${drand.toLowerCase()}:requestOf`] = ([consumer]) => consumer === v2Tickets ? [due - 12n, round] : [0n, 0n];
    g.node.calls[`${drand.toLowerCase()}:wordOf`] = () => [zeroHash, 0n];
    g.node.calls[`${drand.toLowerCase()}:isSilent`] = () => false;
    g.node.calls[`${drand.toLowerCase()}:roundTime`] = () => due;
    const posts = (await g.reader.read(19n, due)).filter(c => c.job === 'drandPostRound');
    expect(posts).toMatchObject([{ to: drand, args: [round] }]);
  });

  it('does not post before the requested round is due, after posting, for vanished requests, or for silent requests', async () => {
    for (const kind of ['future', 'posted', 'vanished', 'silent'] as const) {
      const f = fixture(); f.node.logs = () => [requested(tickets, 1n)];
      if (kind === 'posted') f.on(source, 'wordOf', [word, due]);
      if (kind === 'vanished') f.on(source, 'requestOf', [0n, 0n]);
      if (kind === 'silent') f.on(source, 'isSilent', true);
      const cs = await f.reader.read(19n, kind === 'future' ? due - 1n : due);
      expect(cs.some(c => c.job === 'drandPostRound'), kind).toBe(false);
    }
  });

  it.each([tickets, v2Tickets])('recovers key 0 then accepts it and settles only the oldest ready draw for %s', async t => {
    const f = fixture();
    expect((await f.reader.read(19n, due)).some(c => c.to === t && c.fn === 'requestGraduationWord')).toBe(true);
    f.on(t, 'status', { ...status(), wordRequestedAt: 100, drawsRequested: 3 });
    f.on(source, 'requestOf', [100n, round]); f.on(source, 'wordOf', [word, 112n]);
    let cs = await f.reader.read(19n, due);
    expect(cs.filter(c => c.to === t).map(c => c.fn)).toEqual(['acceptGraduationWord']);
    f.on(t, 'status', { ...status(), wordRequestedAt: 100, wordAcceptedAt: 113, drawsRequested: 3, drawsSettled: 1 });
    f.on(t, 'phase', 3);
    const requestRead = vi.fn(() => [due - 12n, round]);
    f.node.calls[`${source.toLowerCase()}:requestOf`] = requestRead;
    f.on(source, 'wordOf', [word, due]);
    cs = await f.reader.read(19n, due);
    expect(cs.find(c => c.to === t && c.fn === 'settle')?.args).toEqual([8n]);
    expect(requestRead).toHaveBeenCalledWith([t, 2n]);
    f.on(source, 'wordOf', [zeroHash, 0n]);
    expect((await f.reader.read(19n, due)).some(c => c.to === t && c.fn === 'settle')).toBe(false);
  });

  it('never schedules terminal entry, user claims, delivery, or a draw after terminal mode', async () => {
    const f = fixture();
    for (const t of [tickets, v2Tickets]) f.on(t, 'status', { ...status(), terminalAt: 100, drawsRequested: 1 });
    f.node.logs = () => [requested(tickets, 1n), requested(v2Tickets, 1n)];
    expect(await f.reader.read(19n, due)).toEqual([]);
  });

  describe.each([tickets, v2Tickets])('queue viability before terminal entry for %s (DRAND-AF1)', t => {
    it.each(['unposted', 'posted late'] as const)('suppresses later draws behind a permanently silent %s head, retaining warnings and bounty withdrawal', async kind => {
      const f = queuedFixture(t);
      if (kind === 'posted late') {
        f.node.calls[`${source.toLowerCase()}:wordOf`] = ([consumer, key]) =>
          consumer === t && key === 1n ? [word, due] : [zeroHash, 0n];
      }
      f.on(source, 'owedTo', 1234567890123456789n);
      const cs = await f.reader.read(19n, due);
      expect(cs.filter(c => c.job === 'drandPostRound')).toEqual([]);
      expect(cs.map(c => c.fn)).toEqual(['withdrawBounty']);
      expect(cs[0]).toMatchObject({ to: drand, args: [keeper] });
      expect(f.log.warn).toHaveBeenCalledWith('drand request silent', expect.objectContaining({
        consumer: t, key: 1n, round: f.headRound, deadline: due - 1n, secondsLeft: 0n,
      }));
    });

    it('keeps a shared round eligible exactly once for another viable consumer', async () => {
      const f = queuedFixture(t);
      const healthy = t === tickets ? v2Tickets : tickets;
      f.on(healthy, 'phase', 3);
      f.on(healthy, 'status', { ...status(), wordRequestedAt: 100, wordAcceptedAt: 113, drawsRequested: 1 });
      f.node.logs = () => [requested(t, 2n), requested(healthy, 1n)];
      const cs = await f.reader.read(19n, due);
      expect(cs).toMatchObject([{ job: 'drandPostRound', to: drand, args: [round] }]);
      expect(cs).toHaveLength(1);
      expect(f.log.warn).toHaveBeenCalledWith('drand request silent', expect.objectContaining({ consumer: t, key: 1n }));
    });

    it('also suppresses draws behind a permanently silent assignment word', async () => {
      const f = queuedFixture(t);
      f.on(t, 'phase', 2);
      f.on(t, 'status', { ...status(), wordRequestedAt: 100, drawsRequested: 2 });
      f.node.calls[`${source.toLowerCase()}:requestOf`] = ([consumer, key]) =>
        consumer === t && key === 0n ? [100n, f.headRound] : [due - 12n, round];
      f.node.calls[`${source.toLowerCase()}:isSilent`] = ([consumer, key]) => consumer === t && key === 0n;
      expect((await f.reader.read(19n, due)).filter(c => c.job === 'drandPostRound')).toEqual([]);
      expect(f.log.warn).toHaveBeenCalledWith('drand request silent', expect.objectContaining({ consumer: t, key: 0n }));
    });

    it('keeps later rounds at the head deadline, but suppresses them once the pending timestamp crosses it', async () => {
      const f = queuedFixture(t);
      f.on(source, 'isSilent', false); // canonical snapshot precedes the pending deadline
      f.on(source, 'roundTime', due - 1n);
      let cs = await f.reader.read(19n, due - 1n);
      expect(cs.filter(c => c.job === 'drandPostRound').map(c => c.args)).toEqual([[f.headRound], [round]]);
      cs = await f.reader.read(19n, due);
      expect(cs.filter(c => c.job === 'drandPostRound')).toEqual([]);
    });

    it('keeps a timely head usable after its deadline and posts the later draw', async () => {
      const f = queuedFixture(t);
      f.on(source, 'isSilent', false);
      f.node.calls[`${source.toLowerCase()}:wordOf`] = ([consumer, key]) =>
        consumer === t && key === 1n ? [word, due - 1n] : [zeroHash, 0n];
      const cs = await f.reader.read(19n, due);
      expect(cs.filter(c => c.job === 'drandPostRound')).toMatchObject([{ args: [round] }]);
      expect(cs.find(c => c.to === t)).toMatchObject({ fn: 'settle', args: [8n] });
      expect(f.log.warn).not.toHaveBeenCalled();
    });

    it('defers posts on a failed head read and retries the consumer next tick', async () => {
      const f = queuedFixture(t);
      const requestOf = required(f.node.calls[`${source.toLowerCase()}:requestOf`]);
      f.node.calls[`${source.toLowerCase()}:requestOf`] = args => {
        if (args[0] === t && args[1] === 1n) throw REVERT;
        return requestOf(args);
      };
      expect((await f.reader.read(19n, due)).filter(c => c.job === 'drandPostRound')).toEqual([]);
      expect(f.log.warn).toHaveBeenCalledWith('drand read failed', expect.any(Object));
      f.on(source, 'requestOf', [due - 12n, round]);
      f.on(source, 'isSilent', false);
      expect((await f.reader.read(20n, due)).filter(c => c.job === 'drandPostRound')).toMatchObject([{ args: [round] }]);
    });
  });

  it('claims only the keeper bounty, without counting an unwithdrawn pot as income', async () => {
    const f = fixture();
    const owed = vi.fn(() => 1234567890123456789n);
    f.node.calls[`${source.toLowerCase()}:owedTo`] = owed;
    const cs = await f.reader.read(19n, due);
    expect(cs.find(c => c.fn === 'withdrawBounty')).toMatchObject({ to: drand, args: [keeper] });
    expect(owed).toHaveBeenCalledWith([keeper]);
  });
  it('does no drand reads with neither box 0 nor a registry configured', async () => {
    const f = fixture(); const read = vi.spyOn(f.pub, 'readContract');
    const reader = new DrandReader({ ...f.cfg, box0: null, boxRegistry: null }, f.pub, keeper, quiet);
    expect(await reader.read(19n, due)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('warns in the final 24 hours and after silence, including above the gas ceiling', async () => {
    const f = fixture(); f.node.logs = () => [requested(tickets, 1n)];
    f.on(source, 'requestOf', [due - 604800n + 3600n, round]);
    await f.reader.read(19n, due);
    expect(f.log.warn).toHaveBeenCalledWith('drand request nearing silence', expect.objectContaining({ consumer: tickets, key: 1n, secondsLeft: 3600n }));
    f.on(source, 'isSilent', true);
    await f.reader.read(19n, due + 7200n);
    expect(f.log.warn).toHaveBeenCalledWith('drand request silent', expect.objectContaining({ consumer: tickets }));
  });

  it('posts at the exact silence deadline, but refuses a late pending block even if the snapshot is not silent yet', async () => {
    const f = fixture(); f.node.logs = () => [requested(tickets, 1n)];
    const deadline = due - 12n + 604800n;
    expect((await f.reader.read(19n, deadline)).some(c => c.job === 'drandPostRound')).toBe(true);
    expect((await f.reader.read(19n, deadline + 1n)).some(c => c.job === 'drandPostRound')).toBe(false);
  });

  it('isolates a broken consumer and rejects substituted source wiring', async () => {
    const f = fixture();
    f.on(tickets, 'source', addr(999));
    const cs = await f.reader.read(19n, due);
    expect(cs.some(c => c.to === tickets)).toBe(false);
    expect(cs.some(c => c.to === v2Tickets)).toBe(true);
    expect(f.log.warn).toHaveBeenCalled();
  });

  it('pages historical logs and replays after restart, a reorg, or newly discovered consumers', async () => {
    const f = fixture();
    await f.reader.read(4010n, due);
    // Each page is scanned on both sources (box 0's backed source, the v2 tickets' DrandSource; F143).
    for (const at of [source, drand]) {
      expect(f.node.ranges.filter(r => r.address === at).map(r => [r.from, r.to])).toEqual([[10n, 2009n], [2010n, 4009n], [4010n, 4010n]]);
    }
    // The fake returns no block hash: caching must be disabled, never trust an unverifiable cursor.
    f.node.logs = () => [requested(tickets, 1n)];
    expect((await f.reader.read(19n, due)).some(c => c.job === 'drandPostRound')).toBe(true);
  });

  it('uses a verified event cursor, rewinds on a changed block hash, and retains work after a failed log page', async () => {
    const f = fixture();
    let hash = word;
    const getBlock = f.pub.getBlock.bind(f.pub);
    vi.spyOn(f.pub, 'getBlock').mockImplementation(async args => ({ ...await getBlock(args), number: args?.blockNumber ?? 50_001n, hash, parentHash: hash }));
    f.node.logs = () => [requested(tickets, 1n)];
    await f.reader.read(19n, due);
    f.node.ranges.length = 0;
    await f.reader.read(21n, due);
    expect(f.node.ranges.map(r => [r.from, r.to])).toEqual([[20n, 21n], [20n, 21n]]);
    f.node.ranges.length = 0;
    hash = `0x${'34'.repeat(32)}`;
    await f.reader.read(21n, due);
    expect(f.node.ranges.map(r => [r.from, r.to])).toEqual([[10n, 21n], [10n, 21n]]);
    f.node.logs = () => { throw new Error('fake log outage'); };
    expect((await f.reader.read(23n, due)).some(c => c.job === 'drandPostRound')).toBe(true);
    f.node.logs = () => [];
    f.node.ranges.length = 0;
    await f.reader.read(24n, due);
    expect(f.node.ranges.map(r => [r.from, r.to])).toEqual([[22n, 24n], [22n, 24n]]);
  });

  it('bounds a long backfill to eight pages per tick while still servicing the current ticket head', async () => {
    const f = fixture();
    const getBlock = f.pub.getBlock.bind(f.pub);
    vi.spyOn(f.pub, 'getBlock').mockImplementation(async args => ({ ...await getBlock(args), number: args?.blockNumber ?? 50_001n, hash: word, parentHash: word }));
    f.on(tickets, 'status', { ...status(), wordRequestedAt: 100 });
    const cs = await f.reader.read(50_000n, due);
    const pages = () => f.node.ranges.filter(r => r.address === source);
    expect(pages()).toHaveLength(8);
    expect(f.node.ranges).toHaveLength(16); // the same eight pages on the DrandSource (F143)
    expect(pages().at(-1)?.to).toBe(16009n);
    expect(cs.some(c => c.job === 'drandPostRound')).toBe(true);
    f.node.ranges.length = 0;
    await f.reader.read(50_001n, due);
    expect(pages()[0]?.from).toBe(16010n);
    expect(pages()).toHaveLength(8);
  });

  it('follows v2 failure assignment phase without triggering any holder or item payout', async () => {
    const f = fixture();
    f.on(v2Tickets, 'phase', 1); // failure hand-back window still open
    expect((await f.reader.read(19n, due)).some(c => c.to === v2Tickets)).toBe(false);
    f.on(v2Tickets, 'phase', 2); // window closed, placeholders now frozen
    const cs = await f.reader.read(19n, due);
    expect(cs.filter(c => c.to === v2Tickets).map(c => c.fn)).toEqual(['requestGraduationWord']);
  });
});

describe('drand uses the keeper execution boundary (DRAND-04/05)', () => {
  const post = (): Candidate => ({ job: 'drandPostRound', key: `drandPostRound:${round}`, to: drand, fn: 'postRound', args: [round], version: 1 });
  const world = (cs: Candidate[], baseFeePerGas = 1n): World => ({ block: { number: 20n, timestamp: due, baseFeePerGas }, boxes: [], fitGraduated: false, drand: cs });

  it('plans drand with normal retry memory and keeps request/post/accept/settle recovery in the shared reserve', () => {
    const w = world([post()]);
    expect(plan(w, emptyMemory(), options()).candidates).toHaveLength(1);
    for (const job of ['drandPostRound', 'drandRequestWord', 'drandAcceptWord', 'drandSettle'] as const) expect(jobSpec(job).reserved).toBe(true);
    expect(jobSpec('drandWithdrawBounty').reserved).toBe(false);
    const limits = { ...options().limits, oursWeiPerDay: 1_000_000n, totalWeiPerDay: 1_000_000n, reserveWeiPerDay: 1_000_000n };
    const ctx = { fees: feesFor(1n, 0n), budget: openBudget(undefined, 20n, due), limits, privateEndpoint: false };
    expect(decide('drandPostRound', { ok: true, tipWei: null, estimate: 100_000n }, ctx).send).toBe(true);
    expect(decide('drandWithdrawBounty', { ok: true, tipWei: null, estimate: 100_000n }, ctx).send).toBe(false);
  });

  it('uses fee pause, block rate, daily liability, checkpoint-before-send, and a no-send dry run', async () => {
    const order: string[] = [];
    const p: ChainPort = { read: async () => world([post()]),
      prepare: async c => { order.push('prepare'); return c; },
      simulate: async () => ({ ok: true, tipWei: null, estimate: 100_000n }),
      send: async () => { order.push('send'); return 'fake-hash'; } };
    const cfg = { ...options(), dryRun: false, checkpoint: async () => { order.push('checkpoint'); } };
    const live = await runTick(p, {}, cfg, quiet);
    expect(order.indexOf('checkpoint')).toBeLessThan(order.indexOf('send'));
    expect(live.state.budget?.totalWei).toBeGreaterThan(0n);
    order.length = 0;
    await runTick(p, {}, { ...cfg, dryRun: true }, quiet);
    expect(order).not.toContain('send');
    order.length = 0;
    const capped = await runTick(p, {}, { ...cfg, limits: { ...cfg.limits, totalWeiPerDay: 1n, reserveWeiPerDay: 0n } }, quiet);
    expect(capped.report.skipped[0]?.why).toBe('daily ceiling reached');
    expect(order).not.toContain('send');
    order.length = 0;
    p.read = async () => world([post()], 3_000_000_001n);
    expect((await runTick(p, {}, cfg, quiet)).report.skipped[0]?.why).toBe('fee ceiling reached');
    expect(order).not.toContain('prepare');
    p.read = async () => world([post()]);
    const repeated = await runTick(p, live.state, cfg, quiet);
    expect(repeated.report.sent).toEqual([]);
  });

  it('prepares via relays, simulates each contract call with loaded ABIs, then sends with the same signer', async () => {
    const f = fixture();
    const sign = vi.fn(async (tx: { nonce?: number }) => signedBytes(tx));
    const account = { address: keeper, signTransaction: sign } as unknown as LocalAccount;
    const fetcher: typeof fetch = async () => new Response(JSON.stringify(relayBody));
    const port = new ViemChain({ ...f.cfg, dryRun: false }, f.pub, keeper, { public: account, private: null }, null, quiet, undefined, undefined, fetcher);
    f.on(source, 'postRound', word);
    const fees = feesFor(1n, 0n);
    const prepared = await port.prepare(post(), fees);
    expect(prepared.args).toEqual([round, vectors.signaturesXY[1]]);
    const calls: Candidate[] = [prepared,
      { job: 'drandWithdrawBounty', key: 'bounty', to: drand, fn: 'withdrawBounty', args: [keeper] },
      ...([1, 2] as const).flatMap(version => {
        const to = version === 1 ? tickets : v2Tickets;
        return [
          { job: 'drandRequestWord' as const, key: `request:${version}`, to, fn: 'requestGraduationWord', args: [], version },
          { job: 'drandAcceptWord' as const, key: `accept:${version}`, to, fn: 'acceptGraduationWord', args: [], version },
          { job: 'drandSettle' as const, key: `settle:${version}`, to, fn: 'settle', args: [8n], version },
        ];
      })];
    for (const c of calls) {
      f.on(c.to, c.fn, c.fn === 'postRound' ? word : ['settle', 'withdrawBounty'].includes(c.fn) ? 1n : undefined);
      expect((await port.simulate(c, fees)).ok, c.key).toBe(true);
      await port.send(c, 250_000n, fees, false);
      f.node.calls[`${c.to.toLowerCase()}:${c.fn}`] = () => { throw REVERT; };
      expect((await port.simulate(c, fees)).ok, c.key).toBe(false);
    }
    expect(sign).toHaveBeenCalledTimes(8);
    expect(f.node.sent).toHaveLength(8);
  });

  it('progresses from a shared round through acceptance, draw settlement and bounty withdrawal across ticks', async () => {
    const f = fixture();
    let ready = 0n, accepted = 0, settled = 0, owed = 0n;
    let fn = '';
    const signed: string[] = [];
    const signer = { address: keeper, signTransaction: async (tx: { to: Address; data: Hex; nonce?: number }) => {
      const decoded = decodeFunctionData({ abi: tx.to === source || tx.to === drand ? drandSourceAbi : drandTicketsAbi, data: tx.data });
      fn = decoded.functionName; signed.push(fn); return signedBytes(tx);
    } } as unknown as LocalAccount;
    const fetcher: typeof fetch = async () => new Response(JSON.stringify(relayBody));
    f.on(v2Tickets, 'status', { ...status(), terminalAt: 1 });
    f.node.calls[`${tickets}:status`] = () => ({ ...status(), wordRequestedAt: 100, wordAcceptedAt: accepted, drawsRequested: 1, drawsSettled: settled });
    f.node.calls[`${tickets}:phase`] = () => accepted ? 3 : 2;
    f.node.calls[`${source.toLowerCase()}:wordOf`] = () => ready ? [word, ready] : [zeroHash, 0n];
    f.node.calls[`${source.toLowerCase()}:owedTo`] = () => owed;
    f.node.calls[`${source.toLowerCase()}:postRound`] = () => { if (ready) throw REVERT; return word; };
    f.node.calls[`${source.toLowerCase()}:withdrawBounty`] = () => { if (!owed) throw REVERT; return owed; };
    f.node.calls[`${tickets}:acceptGraduationWord`] = () => { if (!ready || accepted) throw REVERT; };
    f.node.calls[`${tickets}:settle`] = () => { if (!accepted || settled) throw REVERT; return 1n; };
    f.node.logs = () => [requested(tickets, 0n), requested(tickets, 1n)];
    f.node.onSend = () => {
      if (fn === 'postRound') { ready = due; owed = 600_000n; }
      if (fn === 'acceptGraduationWord') accepted = 1;
      if (fn === 'settle') settled = 1;
      if (fn === 'withdrawBounty') owed = 0n;
    };
    const cfg = { ...f.cfg, dryRun: false };
    const port = new ViemChain(cfg, f.pub, keeper, { public: signer, private: null }, null, quiet, undefined, undefined, fetcher);
    const first = await runTick(port, {}, cfg, quiet);
    expect(first.report.sent.map(c => c.job)).toEqual(['drandPostRound']);
    const state = decodeState(encodeState(first.state, 'fake-deployment'), 'fake-deployment');
    f.node.block.number++;
    const second = await runTick(port, state, cfg, quiet);
    expect(second.report.sent.map(c => c.job)).toEqual(['drandAcceptWord', 'drandWithdrawBounty']);
    f.node.block.number++;
    const third = await runTick(port, second.state, cfg, quiet);
    expect(third.report.sent.map(c => c.job)).toEqual(['drandSettle']);
    f.node.block.number++;
    expect((await runTick(port, third.state, cfg, quiet)).report.sent).toEqual([]);
    expect(signed).toEqual(['postRound', 'acceptGraduationWord', 'withdrawBounty', 'settle']);
    expect(third.state.budget.totalWei).toBe(first.state.budget.totalWei * 4n);
  });

  it('requires explicit mainnet authorization in settings and in chain checks', async () => {
    const env = { SH_KEEPER_RPC_URL: 'https://rpc.example.invalid', SH_KEEPER_CHAIN_ID: '1', SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216' };
    expect(() => loadConfig(env)).toThrow(/SH_KEEPER_ALLOW_MAINNET/);
    expect(loadConfig({ ...env, SH_KEEPER_ALLOW_MAINNET: '1' }).allowMainnet).toBe(true);
    await expect(checkChainId({ getChainId: async () => 1 }, 1)).rejects.toThrow(/mainnet/i);
    await expect(checkChainId({ getChainId: async () => 1 }, 1, true)).resolves.toBeUndefined();
    await expect(checkChainId({ getChainId: async () => 1 }, 11155111, true)).rejects.toThrow(/chain id/);
  });

  it('refuses direct signing in dry-run mode or when the RPC changes chain', async () => {
    const f = fixture();
    const sign = vi.fn(async (tx: { nonce?: number }) => signedBytes(tx));
    const account = { address: keeper, signTransaction: sign } as unknown as LocalAccount;
    const make = (dryRun: boolean) => new ViemChain({ ...f.cfg, dryRun }, f.pub, keeper, { public: account, private: null }, null, quiet);
    const c = { ...post(), args: [round, vectors.signaturesXY[1]] };
    await expect(make(true).send(c, 250000n, feesFor(1n, 0n), false)).rejects.toThrow(/dry run/);
    f.node.chainId = 1;
    await expect(make(false).send(c, 250000n, feesFor(1n, 0n), false)).rejects.toThrow(/chain id/);
    expect(sign).not.toHaveBeenCalled();
    expect(f.node.sent).toEqual([]);
  });
});

describe('R62 reader deadlines', () => {
  it('uses the earliest viable request deadline for shared rounds and key zero for acceptance', async () => {
    const f = fixture();
    for (const t of [tickets, v2Tickets]) f.on(t, 'status', { ...status(), wordRequestedAt: 100 });
    f.node.calls[`${source.toLowerCase()}:requestOf`] = ([c]) => [due - (c === tickets ? 100n : 200n), round];
    expect((await f.reader.read(19n, due)).find(c => c.job === 'drandPostRound')?.drandDeadline).toBe(due - 200n + 604800n);
    f.on(source, 'wordOf', [word, due]);
    expect((await f.reader.read(19n, due)).find(c => c.job === 'drandAcceptWord' && c.to === tickets)?.drandDeadline).toBe(due - 100n + 604800n);
  });
  it('uses gate time for v1, failure window when nonzero for v2, and no deadline for an unreadable vault', async () => {
    const f = fixture();
    f.on(tickets, 'vault', addr(70)); f.on(v2Tickets, 'vault', addr(71));
    f.on(addr(70), 'gateOpenedAt', 100n); f.on(addr(71), 'gateOpenedAt', 200n); f.on(addr(71), 'failureWindowEnds', 300n);
    let cs = await f.reader.read(19n, due);
    expect(cs.find(c => c.to === tickets)?.drandDeadline).toBe(2592100n);
    expect(cs.find(c => c.to === v2Tickets)?.drandDeadline).toBe(2592300n);
    f.on(addr(71), 'failureWindowEnds', 0n);
    cs = await f.reader.read(19n, due);
    expect(cs.find(c => c.to === v2Tickets)?.drandDeadline).toBe(2592200n);
    f.node.calls[`${addr(70)}:gateOpenedAt`] = () => { throw REVERT; };
    expect((await f.reader.read(19n, due)).find(c => c.to === tickets)?.drandDeadline).toBeUndefined();
    f.on(tickets, 'status', { ...status(), terminalAt: 1 });
    expect((await f.reader.read(19n, due)).some(c => c.to === tickets)).toBe(false);
  });
  it('checks the deadline at signing from the last pending read', async () => {
    const f = fixture(); const sign = vi.fn(async (tx: { nonce?: number }) => signedBytes(tx));
    const port = new ViemChain({ ...f.cfg, dryRun: false }, f.pub, keeper, { public: { address: keeper, signTransaction: sign } as unknown as LocalAccount, private: null }, null, quiet);
    await port.read();
    const c: Candidate = { job: 'drandPostRound', key: 'post', to: source, fn: 'postRound', args: [round, vectors.signaturesXY[1]], drandDeadline: due + 73n * 3600n };
    const fees = feesFor(1_600_000_000n, 50_000_000n);
    await expect(port.send(c, 600000n, fees, false)).rejects.toThrow('fee ceiling reached');
    await expect(port.send({ ...c, drandDeadline: due + 71n * 3600n }, 600000n, fees, false)).resolves.toBeDefined();
    expect(sign).toHaveBeenCalledTimes(1);
  });
});

describe('S3(f) sequential keys survive log outages', () => {
  it.each([false, true])('reads at most 64 keys from the head, including queued draws while awaiting word: %s', async awaiting => {
    const f = fixture(); f.on(v2Tickets, 'status', { ...status(), terminalAt: 1 });
    f.on(tickets, 'phase', awaiting ? 2 : 3);
    f.on(tickets, 'status', { ...status(), wordRequestedAt: 100, wordAcceptedAt: awaiting ? 0 : 113, drawsRequested: 100 });
    f.node.logs = () => { throw new Error('offline logs'); };
    const read = vi.fn(([consumer, key]: readonly unknown[]) => [due - 100n, round + (consumer === tickets ? key as bigint : 0n)]);
    f.node.calls[`${source.toLowerCase()}:requestOf`] = read;
    const cs = await f.reader.read(19n, due);
    const keys = read.mock.calls.filter(([args]) => args[0] === tickets).map(([args]) => args[1]);
    expect(keys).toEqual(Array.from({ length: 64 }, (_, i) => BigInt(i + (awaiting ? 0 : 1))));
    expect(cs.filter(c => c.job === 'drandPostRound')).toHaveLength(64);
    expect(f.reader.observation().complete).toBe(false);
  });
  it('posts the head and three due queued rounds oldest first without any logs', async () => {
    const f = fixture(); f.on(v2Tickets, 'status', { ...status(), terminalAt: 1 });
    f.on(tickets, 'phase', 3); f.on(tickets, 'status', { ...status(), wordRequestedAt: 100, wordAcceptedAt: 113, drawsRequested: 4 });
    f.node.logs = () => { throw new Error('offline logs'); };
    f.node.calls[`${source.toLowerCase()}:requestOf`] = ([, key]) => [due - 100n, round + (key as bigint)];
    expect((await f.reader.read(19n, due)).filter(c => c.job === 'drandPostRound').map(c => c.args[0])).toEqual([1n, 2n, 3n, 4n].map(i => round + i));
  });
});

describe('S5 box zero graduation bounty', () => {
  it('is off by default and proposes only the missing pot, once per round, for box zero', async () => {
    const f = fixture(); for (const t of [tickets, v2Tickets]) f.on(t, 'status', { ...status(), wordRequestedAt: 100 });
    f.on(source, 'bountyOf', 3n);
    expect((await f.reader.read(19n, due)).some(c => c.job === 'drandGraduationBounty')).toBe(false);
    const reader = new DrandReader({ ...f.cfg, graduationBountyWei: 10n }, f.pub, keeper, f.log);
    // The pot is the DrandSource's (F143: box 0's backed source only forwards), so the top-up goes there.
    expect((await reader.read(19n, due)).filter(c => c.job === 'drandGraduationBounty')).toEqual([expect.objectContaining({ to: drand, version: 1, key: `drandGraduationBounty:${drand.toLowerCase()}:${round}`, fn: 'addBounty', args: [round], value: 7n })]);
    f.on(source, 'bountyOf', 10n);
    expect((await reader.read(20n, due)).some(c => c.job === 'drandGraduationBounty')).toBe(false);
  });
  it.each(['posted', 'silent', 'terminal', 'accepted', 'unrequested', 'v2 only'])('never tops up when %s', async kind => {
    const f = fixture(); for (const t of [tickets, v2Tickets]) f.on(t, 'status', { ...status(), wordRequestedAt: 100 });
    f.on(source, 'bountyOf', 0n);
    if (kind === 'posted') f.on(source, 'wordOf', [word, due]);
    if (kind === 'silent') f.on(source, 'isSilent', true);
    if (kind === 'terminal' || kind === 'v2 only') f.on(tickets, 'status', { ...status(), terminalAt: 1 });
    if (kind === 'accepted') f.on(tickets, 'status', { ...status(), wordRequestedAt: 100, wordAcceptedAt: 113 });
    if (kind === 'unrequested') f.on(tickets, 'status', status());
    const reader = new DrandReader({ ...f.cfg, graduationBountyWei: 10n }, f.pub, keeper, f.log);
    expect((await reader.read(19n, due)).some(c => c.job === 'drandGraduationBounty')).toBe(false);
  });
  it('F143 × S5: never tops up a box 0 round whose backup started, where a drand post can no longer serve box 0', async () => {
    const f = fixture(); f.on(tickets, 'status', { ...status(), wordRequestedAt: 100 });
    f.on(v2Tickets, 'status', { ...status(), terminalAt: 1 });
    f.on(source, 'bountyOf', 0n);
    const reader = new DrandReader({ ...f.cfg, graduationBountyWei: 10n }, f.pub, keeper, f.log);
    // The control: before a start the unposted graduation round's pot is topped up, on the DrandSource.
    expect((await reader.read(19n, due)).filter(c => c.job === 'drandGraduationBounty'))
      .toMatchObject([{ to: drand, args: [round], value: 10n }]);
    // Five days later someone started the round's backup: box 0 now ignores a drand post for it (F143, review F7).
    const later = due + 432_001n;
    f.on(source, 'backupOf', [later, 1_000n, 0n, zeroHash]);
    const cs = await reader.read(20n, later);
    expect(cs.filter(c => c.job === 'drandGraduationBounty' || c.job === 'drandPostRound')).toEqual([]);
    expect(f.log.warn).toHaveBeenCalledWith('box 0 round on its backup', expect.objectContaining({ consumer: tickets, key: 0n, round }));
  });
  it('passes native value through pending simulation, estimation, signing and durable settlement', async () => {
    const f = fixture(); f.on(drand, 'addBounty', undefined);
    const sign = vi.fn(async (tx: { nonce?: number }) => signedBytes(tx));
    const account = { address: keeper, signTransaction: sign } as unknown as LocalAccount;
    const port = new ViemChain({ ...f.cfg, dryRun: false }, f.pub, keeper, { public: account, private: null }, null, quiet);
    const simulation = vi.spyOn(f.pub, 'simulateContract'); const estimate = vi.spyOn(f.pub, 'estimateGas');
    const c: Candidate = { job: 'drandGraduationBounty', key: 'bounty', to: drand, version: 1, fn: 'addBounty', args: [round], value: 10n };
    const fees = feesFor(1n, 0n);
    expect((await port.simulate(c, fees)).ok).toBe(true); await port.send(c, 250000n, fees, false);
    for (const spy of [simulation, estimate, sign]) expect(spy).toHaveBeenCalledWith(expect.objectContaining({ value: 10n }));
  });
});

// rc8 part 2a: the paths the merge of F143's reader with part 1's safeguards creates. Here the two fake sources answer
// separately: box 0's requests live on its backed source, v2's on the DrandSource (each answers (0, 0) for the other).
describe('F143 x part 1: the backed reader with the R62 deadlines, the sequential keys and the S5 bounty', () => {
  const split = (f: ReturnType<typeof fixture>, box0: (key: bigint) => readonly [bigint, bigint], v2: (key: bigint) => readonly [bigint, bigint]) => {
    const none = [0n, 0n] as const;
    const box0Reads = vi.fn(([consumer, key]: readonly unknown[]) => consumer === tickets ? box0(key as bigint) : none);
    const v2Reads = vi.fn(([consumer, key]: readonly unknown[]) => consumer === v2Tickets ? v2(key as bigint) : none);
    f.node.calls[`${source.toLowerCase()}:requestOf`] = box0Reads;
    f.node.calls[`${drand.toLowerCase()}:requestOf`] = v2Reads;
    f.on(drand, 'wordOf', [zeroHash, 0n]); f.on(drand, 'isSilent', false); f.on(drand, 'roundTime', due);
    f.node.logs = () => { throw new Error('offline logs'); };
    return { box0Reads, v2Reads };
  };

  it('a shared round carries the earliest deadline, and only the v2 deadline once box 0 is on its backup', async () => {
    const f = fixture();
    for (const t of [tickets, v2Tickets]) f.on(t, 'status', { ...status(), wordRequestedAt: 100 });
    split(f, () => [due - 3612n, round], () => [due - 12n, round]);
    const post = async (now: bigint) => (await f.reader.read(19n, now)).filter(c => c.job === 'drandPostRound');
    // Both requests need the round: one post on the DrandSource with box 0's earlier deadline (part 1's R62 rule).
    expect(await post(due)).toMatchObject([{ to: drand, args: [round], drandDeadline: due - 3612n + 604800n }]);
    // Box 0's backup started: box 0 no longer needs the post, the v2 box still does, with its own deadline.
    const later = due + 432_001n;
    f.on(source, 'backupOf', [later, 1_000n, 0n, zeroHash]);
    expect(await post(later)).toMatchObject([{ to: drand, args: [round], drandDeadline: due - 12n + 604800n }]);
    expect(f.log.warn).toHaveBeenCalledWith('box 0 round on its backup', expect.objectContaining({ consumer: tickets, key: 0n, round }));
  });

  it("reads box 0's queued draws on its backed source and the v2 box's on the DrandSource, and posts them all there", async () => {
    const f = fixture();
    f.on(tickets, 'phase', 3); f.on(tickets, 'status', { ...status(), wordRequestedAt: 100, wordAcceptedAt: 113, drawsRequested: 3 });
    f.on(v2Tickets, 'phase', 3); f.on(v2Tickets, 'status', { ...status(), wordRequestedAt: 100, wordAcceptedAt: 113, drawsRequested: 2 });
    const { box0Reads, v2Reads } = split(f, key => [due - 12n, round + key], key => [due - 12n, round + 10n + key]);
    const posts = (await f.reader.read(19n, due)).filter(c => c.job === 'drandPostRound');
    const asked = (reads: typeof box0Reads) => reads.mock.calls.map(([args]) => `${String(args[0])}:${String(args[1])}`);
    expect(asked(box0Reads).filter(a => a.startsWith(tickets))).toEqual([`${tickets}:1`, `${tickets}:2`, `${tickets}:3`]);
    expect(asked(v2Reads).filter(a => a.startsWith(v2Tickets))).toEqual([`${v2Tickets}:1`, `${v2Tickets}:2`]);
    expect(posts.map(c => c.args[0])).toEqual([1n, 2n, 3n, 11n, 12n].map(i => round + i));
    expect(posts.every(c => c.to === drand)).toBe(true);
  });

  it("tops up the graduation round from the DrandSource's pot, never through the backed source", async () => {
    const f = fixture(); f.on(tickets, 'status', { ...status(), wordRequestedAt: 100 });
    f.on(v2Tickets, 'status', { ...status(), terminalAt: 1 });
    f.node.calls[`${source.toLowerCase()}:bountyOf`] = () => { throw REVERT; };
    f.on(drand, 'bountyOf', 4n);
    const reader = new DrandReader({ ...f.cfg, graduationBountyWei: 10n }, f.pub, keeper, f.log);
    expect((await reader.read(19n, due)).filter(c => c.job === 'drandGraduationBounty')).toEqual([expect.objectContaining({
      to: drand, fn: 'addBounty', args: [round], value: 6n, key: `drandGraduationBounty:${drand.toLowerCase()}:${round}` })]);
  });

  it("accepts box 0's timely backup word with ordinary limits", async () => {
    const f = fixture(); f.on(tickets, 'status', { ...status(), wordRequestedAt: 100 });
    f.on(v2Tickets, 'status', { ...status(), terminalAt: 1 });
    const requestedAt = due - 12n, fixedAt = due + 432_001n + 3_600n, now = fixedAt + 60n;
    split(f, () => [requestedAt, round], () => [0n, 0n]);
    f.on(source, 'backupOf', [due + 432_001n, 1_000n, fixedAt, word]);
    f.on(source, 'wordOf', [word, fixedAt]);
    const cs = await f.reader.read(19n, now);
    const accept = cs.find(c => c.job === 'drandAcceptWord');
    expect(accept).toMatchObject({ to: tickets, drandDeadline: requestedAt + 604800n });
    expect(cs.some(c => c.job === 'drandPostRound' || c.job === 'drandGraduationBounty')).toBe(false);
    // A timely backup word stays usable: even inside 72 hours acceptance keeps ordinary limits.
    expect(drandFeeApplies(accept as Candidate, now, f.cfg.limits)).toBe(false);
  });
});

it('keeps draws live when no placeholders required an assignment word', async () => {
  const f = fixture(); f.on(v2Tickets, 'status', { ...status(), terminalAt: 1 });
  f.on(tickets, 'phase', 3);
  f.on(tickets, 'status', { ...status(), slots: 0, drawsRequested: 1 });
  f.node.logs = () => { throw new Error('offline logs'); };
  f.node.calls[`${source.toLowerCase()}:requestOf`] = ([, key]) => key === 0n ? [0n, 0n] : [due - 12n, round];
  expect((await f.reader.read(19n, due)).filter(c => c.job === 'drandPostRound')).toMatchObject([{ args: [round] }]);
});

it('READS-3 skips scans on a failed consumer read without rewinding its cursor', async () => {
  const f = fixture();
  vi.spyOn(f.pub, 'getBlock').mockImplementation(async ({ blockNumber = 50_001n } = {}) => ({ number: blockNumber, hash: word, parentHash: word } as never));
  await f.reader.read(19n, due);
  const count = f.node.ranges.length;
  f.node.calls[`${tickets}:status`] = () => { throw new Error('temporary RPC failure'); };
  await f.reader.read(20n, due + 12n);
  expect(f.node.ranges).toHaveLength(count);
  expect(f.reader.observation().complete).toBe(false);
  f.on(tickets, 'status', status());
  await f.reader.read(21n, due + 24n);
  expect(f.node.ranges.slice(count)).toEqual([
    { address: source, from: 20n, to: 21n }, { address: drand, from: 20n, to: 21n },
  ]);
});

it('READS-3 learns pruned history once and never scans below the served floor after a reset', async () => {
  const f = fixture();
  vi.spyOn(f.pub, 'getBlock').mockImplementation(async ({ blockNumber = 50_001n } = {}) => ({ number: blockNumber, hash: word, parentHash: word } as never));
  let prune = true;
  const events = vi.spyOn(f.pub, 'getContractEvents').mockImplementation(async args => {
    if (prune && typeof args.fromBlock === 'bigint' && args.fromBlock < 15n) throw Object.assign(new Error('pruned history unavailable'), { code: 4444 });
    return [];
  });
  await f.reader.read(19n, due);
  expect(events.mock.calls.some(([a]) => a.fromBlock === 15n)).toBe(true);
  events.mockClear(); prune = false;
  // Adding a consumer resets the checkpoint, but cannot recover history the endpoint has pruned.
  f.on(registry, 'boxCount', 0n);
  await f.reader.read(21n, due + 24n);
  expect(events.mock.calls.length).toBeGreaterThan(0);
  expect(events.mock.calls.every(([a]) => typeof a.fromBlock === 'bigint' && a.fromBlock >= 15n)).toBe(true);
});
