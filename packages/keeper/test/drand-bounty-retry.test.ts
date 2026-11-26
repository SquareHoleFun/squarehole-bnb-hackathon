import { expect, it, vi } from 'vitest';
import { zeroHash, type Address, type Hex, type LocalAccount } from 'viem';
// F143: box 0 reads its requests and words on its BoxBackedSource (`source`); the round's pot, its post and the bounty
// top-up are the DrandSource's (`drand`), the address the reservation key named before F143.
import { RANDOMNESS_SOURCE as source, DRAND_SOURCE as drand } from '../../box-spec/src/generated/box-spec.v1';
import { DrandReader } from '../src/drand';
import { ViemChain } from '../src/chain';
import { runTick, type ChainPort, type KeeperState } from '../src/run';
import { decodeState, encodeState } from '../src/state';
import { fakeClient, fakeNode } from './support/fake-rpc';
import { addr, keeper, options, quiet, time } from './support/v2';

const target = 10_000_000_000_000_000n;
const blockHash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const restore = (state: KeeperState) => decodeState(encodeState(state, 'bounty-af1'), 'bounty-af1');

/** The real reader and signing adapter, with relays unavailable and an indefinitely unposted round. */
function fixture() {
  const coordinator = addr(1), tickets = addr(7);
  const cfg = { ...options(), dryRun: false, graduationBountyWei: target, boxRegistry: null,
    box0: { coordinator, hook: addr(2), receiver: addr(3), executor: addr(9) } };
  const node = fakeNode({ block: { number: 1000n, timestamp: time, baseFeePerGas: 1n } });
  const pub = fakeClient(node);
  const on = (a: Address, fn: string, result: unknown) => { node.calls[`${a.toLowerCase()}:${fn}`] = () => result; };
  on(coordinator, 'randomness', source); on(coordinator, 'tickets', tickets);
  on(tickets, 'source', source); on(tickets, 'coordinator', coordinator); on(tickets, 'phase', 2);
  on(tickets, 'status', { minted: 2, slots: 2, wordRequestedAt: Number(time - 12n), wordAcceptedAt: 0,
    terminalAt: 0, drawsRequested: 0, drawsSettled: 0 });
  on(source, 'requestOf', [time - 12n, 100n]); on(source, 'wordOf', [zeroHash, 0n]);
  on(source, 'isSilent', false); on(source, 'backupOf', [0n, 0n, 0n, zeroHash]);
  on(drand, 'roundTime', time); on(drand, 'bountyOf', 0n); on(drand, 'owedTo', 0n);
  // Repeated payable calls succeed in pending simulation; DrandSource has no target-pot guard.
  on(drand, 'addBounty', undefined);
  const sign = vi.fn(async (tx: { nonce: number; value?: bigint; to?: Address }) =>
    `0x${(tx.nonce + 1).toString(16).padStart(4, '0')}` as Hex);
  const makePort = (): ChainPort => {
    const reader = new DrandReader(cfg, pub, keeper, quiet);
    const chain = new ViemChain(cfg, pub, keeper,
      { public: { address: keeper, signTransaction: sign } as unknown as LocalAccount, private: null }, null, quiet);
    return {
      read: async () => ({ block: node.block, boxes: [], fitGraduated: false,
        drand: await reader.read(node.block.number - 1n, node.block.timestamp) }),
      prepare: async c => { if (c.job === 'drandPostRound') throw new Error('no valid quicknet relay answer'); return c; },
      simulate: (c, fees) => chain.simulate(c, fees),
      send: (c, gas, fees, privately) => chain.send(c, gas, fees, privately),
      settled: hashes => chain.settled(hashes),
      bountyReverted: (source, hash) => chain.bountyReverted(source, hash),
    };
  };
  let port = makePort();
  const advance = (seconds = 24n) => {
    node.block = { ...node.block, number: node.block.number + 2n, timestamp: node.block.timestamp + seconds };
  };
  const tick = (state: KeeperState = {}, checkpoint?: (state: KeeperState) => Promise<void>) =>
    runTick(port, restore(state), { ...cfg, checkpoint }, quiet);
  return { node, pub, sign, on, tick, advance, restart: () => { port = makePort(); } };
}

it('signs one bounty across pending ticks, journal restores, process restart and UTC rollover', async () => {
  const f = fixture();
  let result = await f.tick();
  expect(result.report.sent.map(c => c.job)).toEqual(['drandGraduationBounty']);
  expect(f.sign).toHaveBeenCalledTimes(1);
  expect(result.state.drandBounties).toEqual({
    [`${drand.toLowerCase()}:100`]: { hash: result.state.budget?.pending?.[0]?.hash },
  });
  // The reservation key is the one written before F143 (the DrandSource's address), so an older journal still binds.
  expect(Object.keys(result.state.drandBounties ?? {})).toEqual(['0xbeece13fbdd67d0a696cb7cfd28103ed37ba79a6:100']);
  expect(f.sign.mock.calls.map(([tx]) => tx.to)).toEqual([drand]);
  // First exercise the review reproducer with the same in-memory nonce counter.
  f.advance(); result = await f.tick(result.state);
  expect(f.sign.mock.calls.map(([tx]) => tx.nonce)).toEqual([0]);
  f.restart(); f.advance(); result = await f.tick(result.state);
  f.advance(86_400n); result = await f.tick(result.state);
  expect(result.state.budget?.day).toBe(time / 86_400n + 1n);
  expect(f.sign.mock.calls.map(([tx]) => tx.value)).toEqual([target]);
  expect(f.node.sent).toHaveLength(1);
});

function receiptFixture(status: 'success' | 'reverted', over: Record<string, unknown> = {}) {
  const f = fixture();
  const receipts = new Map<Hex, Record<string, unknown>>();
  vi.spyOn(f.pub, 'getTransactionReceipt').mockImplementation(async ({ hash }) => {
    const receipt = receipts.get(hash);
    if (!receipt) throw new Error('receipt unavailable');
    return receipt as never;
  });
  const getBlock = f.pub.getBlock.bind(f.pub);
  vi.spyOn(f.pub, 'getBlock').mockImplementation(async args => {
    if (args?.blockTag === 'finalized') return { number: 999n, hash: blockHash(999) } as never;
    if (args?.blockNumber === 998n || args?.blockNumber === 999n)
      return { number: args.blockNumber, hash: blockHash(Number(args.blockNumber)) } as never;
    return getBlock(args);
  });
  const mined = async () => {
    const result = await f.tick();
    const hash = result.state.budget?.pending?.[0]?.hash as Hex;
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    receipts.set(hash, { transactionHash: hash, from: keeper, to: drand, status,
      blockNumber: 998n, blockHash: blockHash(998), gasUsed: 100_000n, effectiveGasPrice: 1n, ...over });
    f.node.counts[keeper] = 1;
    return result.state;
  };
  return { ...f, mined };
}

it('allows exactly one retry after a finalized canonical revert proves no transfer executed', async () => {
  const f = receiptFixture('reverted');
  let state = await f.mined();
  f.restart(); f.advance(86_400n);
  state = (await f.tick(state)).state;
  expect(f.sign.mock.calls.map(([tx]) => tx.nonce)).toEqual([0, 1]);
  expect(f.sign.mock.calls.map(([tx]) => tx.value)).toEqual([target, target]);
  // The retry has no receipt: the earlier revert cannot authorize a third transfer.
  f.restart(); f.advance();
  await f.tick(state);
  expect(f.sign).toHaveBeenCalledTimes(2);
});

it('never funds the round again after a successful receipt even if bountyOf still reports zero', async () => {
  const f = receiptFixture('success');
  let state = await f.mined();
  f.restart(); f.advance();
  state = (await f.tick(state)).state;
  expect(state.budget?.pending).toEqual([]);
  f.advance(86_400n); await f.tick(state);
  expect(f.sign).toHaveBeenCalledTimes(1);
});

it.each([
  ['unfinalized', { blockNumber: 1000n }],
  ['orphaned', { blockHash: blockHash(997) }],
  ['another sender', { from: addr(88) }],
  ['another destination', { to: addr(88) }],
  ['another transaction', { transactionHash: blockHash(88) }],
] as const)('keeps a reverted receipt reserved when it is %s', async (_name, over) => {
  const f = receiptFixture('reverted', over);
  const state = await f.mined();
  f.restart(); f.advance();
  await f.tick(state);
  expect(f.sign).toHaveBeenCalledTimes(1);
});

it.each(['unavailable', 'changed'] as const)('keeps the reservation when the finalized anchor is %s', async mode => {
  const f = receiptFixture('reverted');
  const state = await f.mined();
  const getBlock = vi.mocked(f.pub.getBlock).getMockImplementation();
  if (!getBlock) throw new Error('fixture block reader missing');
  vi.spyOn(f.pub, 'getBlock').mockImplementation(async args => {
    if (mode === 'unavailable' && args?.blockTag === 'finalized') throw new Error('RPC unavailable');
    if (mode === 'changed' && args?.blockNumber === 999n) return { number: 999n, hash: blockHash(888) } as never;
    return getBlock(args);
  });
  f.restart(); f.advance();
  await f.tick(state);
  expect(f.sign).toHaveBeenCalledTimes(1);
});

it('retains the pre-signing reservation if submission is ambiguous and no hash was checkpointed', async () => {
  const f = fixture();
  let checkpoint: KeeperState = {};
  f.node.onSend = () => { throw new Error('accepted, then connection lost'); };
  await f.tick({}, async state => { checkpoint = restore(state); });
  expect(f.sign).toHaveBeenCalledTimes(1);
  expect(checkpoint.budget?.pending?.[0]?.hash).toBeUndefined();
  f.restart(); f.advance(86_400n);
  await f.tick(checkpoint);
  expect(f.sign).toHaveBeenCalledTimes(1);
});

it('reserves before signing and blocks retries from that checkpoint if acceptance was not saved', async () => {
  const f = fixture();
  let beforeSign: KeeperState = {};
  await f.tick({}, async state => {
    if (f.sign.mock.calls.length === 0) beforeSign = restore(state);
  });
  expect(f.sign).toHaveBeenCalledTimes(1);
  expect(beforeSign.budget?.pending?.[0]?.hash).toBeUndefined();
  expect(beforeSign.drandBounties).toEqual({ [`${drand.toLowerCase()}:100`]: {} });
  f.restart(); f.advance();
  await f.tick(beforeSign);
  expect(f.sign).toHaveBeenCalledTimes(1);
});

it('does not sign when the reservation checkpoint fails', async () => {
  const f = fixture();
  await expect(f.tick({}, async () => { throw new Error('journal unavailable'); })).rejects.toThrow('journal unavailable');
  expect(f.sign).not.toHaveBeenCalled();
});

it('a reservation for one round does not suppress a different round', async () => {
  const f = fixture();
  const first = await f.tick();
  f.on(source, 'requestOf', [time - 12n, 101n]);
  f.advance(); await f.tick(first.state);
  expect(f.sign).toHaveBeenCalledTimes(2);
});
