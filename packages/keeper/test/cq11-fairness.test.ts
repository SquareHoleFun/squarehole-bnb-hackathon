import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { ViemChain } from '../src/chain';
import { loadConfig } from '../src/config';
import { runTick, type ChainPort, type KeeperState, type RunConfig } from '../src/run';
import { seededRng } from '../src/rng';
import { fakeClient, fakeNode } from './support/fake-rpc';
import { fundedIncome, addr, box, keeper, quiet, time, v2, world } from './support/v2';

const config = (): RunConfig => ({
  // Keep the scaled conservation/fairness model above its explicit raw-unit batching thresholds.
  ...loadConfig({ SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: 'http://fake.invalid',
    SH_KEEPER_COIN_MINIMUMS: JSON.stringify({ [addr(0)]: { collectRaw: '1' } }),
  }),
  keeper, dryRun: false, privateEndpoint: false, rng: seededRng(2),
});

describe('CQ11-E admission fairness (fix round)', () => {
  it('collects and pays both fixed Safes fairly for every box over 201 blocks', async () => {
    const registry = addr(10);
    const node = fakeNode({ block: { number: 100n, timestamp: time, baseFeePerGas: 1n } });
    const boxes = Array.from({ length: 5 }, (_, i) => ({
      id: BigInt(i), co: addr(100 + i * 10), hk: addr(101 + i * 10), rc: addr(102 + i * 10), router: addr(103 + i * 10),
      fees: 0n, fitOwed: 0n, platformOwed: 0n, fitPaid: 0n, platformPaid: 0n, otherShares: 0n,
      collects: [] as bigint[], fitPayouts: [] as bigint[], platformPayouts: [] as bigint[],
    }));
    node.calls[`${registry}:boxCount`] = () => BigInt(boxes.length);
    node.calls[`${registry}:roleOf`] = ([id, role]) => {
      const b = boxes.find((b) => b.id === id);
      if (!b) throw new Error('unknown box');
      return new Map([[0n, b.co], [2n, b.hk], [5n, b.rc], [6n, b.router]]).get(role as bigint) ?? addr(0);
    };
    for (const b of boxes) {
      node.versions[b.hk] = 2;
      node.versions[b.rc] = 2;
      Object.assign(node.calls, {
        [`${b.hk}:q`]: () => addr(0), [`${b.hk}:poolId`]: () => `0x${(b.id + 1n).toString(16).padStart(64, '0')}`,
        [`${b.hk}:poolManager`]: () => addr(7), [`${b.hk}:closed`]: () => true,
        [`${b.hk}:closedAt`]: () => time - 100n, [`${b.hk}:lastProtocolBlock`]: () => 0n,
        [`${b.hk}:depthBudget`]: () => 0n,
        [`${b.co}:graduated`]: () => true, [`${b.co}:failed`]: () => false,
        [`${b.co}:gateOpen`]: () => true, [`${b.co}:openAt`]: () => time - 100n,
        [`${b.co}:deadline`]: () => time + 900_000n, [`${b.co}:rewardOf`]: () => 0n,
        [`${b.rc}:graduationSettled`]: () => true,
        [`${b.rc}:fitOwed`]: () => b.fitOwed, [`${b.rc}:platformOwed`]: () => b.platformOwed,
        [`${b.rc}:buyBackP`]: () => 0n, [`${b.rc}:tBurnPending`]: () => 0n,
        [`${b.rc}:collect`]: () => ({ buyersP: b.fees, sellersP: 0n, qToReserve: 0n, tip: 0n }),
        [`${b.rc}:payFit`]: () => b.fitOwed, [`${b.rc}:payPlatform`]: () => b.platformOwed,
        [`${b.router}:sweep`]: () => 0n,
      });
    }
    const cfg = config();
    expect(cfg.limits.maxTxPerBlock).toBe(4);
    expect(cfg.retryBlocks).toBe(25n);
    const chain = new ViemChain(
      loadConfig({ SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: 'http://fake.invalid', SH_KEEPER_BOX_REGISTRY: registry }),
      fakeClient(node), keeper, { public: null, private: null }, null, quiet,
    );
    // RPC reads/simulations are pure. Only an admitted send changes the synthetic on-chain ledgers.
    const port: ChainPort = {
      readIncome: async () => fundedIncome(await chain.read()),
      read: () => chain.read(), simulate: (c, fees) => chain.simulate(c, fees),
      send: async (c) => {
        const b = boxes.find((b) => b.id === c.boxId);
        if (!b) throw new Error('unknown box');
        if (c.job === 'collect') {
          b.fitOwed += b.fees * 2n / 15n;
          b.platformOwed += b.fees / 15n;
          b.otherShares += b.fees * 12n / 15n;
          b.fees = 0n;
          b.collects.push(node.block.number);
        } else if (c.job === 'receiverPayFit') {
          b.fitPaid += b.fitOwed;
          b.fitOwed = 0n;
          b.fitPayouts.push(node.block.number);
        } else if (c.job === 'receiverPayPlatform') {
          b.platformPaid += b.platformOwed;
          b.platformOwed = 0n;
          b.platformPayouts.push(node.block.number);
        } else throw new Error(`unexpected send: ${c.job}`);
        return '0x01';
      },
    };
    let state: KeeperState = {};
    let deferred = 0;
    for (let block = 100n; block <= 300n; block++) {
      node.block = { ...node.block, number: block, timestamp: time + (block - 100n) * 12n };
      for (const b of boxes) b.fees += 45n;
      const out = await runTick(port, state, cfg, quiet);
      state = out.state;
      expect(out.report.sent.length).toBeLessThanOrEqual(cfg.limits.maxTxPerBlock);
      expect(out.report.skipped.every((s) => ['rate limit', 'nothing to do'].includes(s.why))).toBe(true);
      deferred += out.report.skipped.filter((s) => s.why === 'rate limit').length;
    }
    expect(deferred).toBeGreaterThan(0);
    expect(state.budget?.totalWei).toBeLessThan(cfg.limits.totalWeiPerDay - cfg.limits.reserveWeiPerDay);
    // A never-serviced box must not hide behind the healthy totals of the registry prefix.
    const collects = boxes.map((b) => b.collects.length);
    expect(collects.every((count) => count > 1), `collect counts: ${collects.join(',')}`).toBe(true);
    for (const b of boxes) {
      for (const runs of [b.collects, b.fitPayouts, b.platformPayouts]) {
        expect(runs.length).toBeGreaterThan(1);
        // Include both ends of the run, proving bounded service throughout, not just once at startup.
        let previous = 100n;
        for (const block of [...runs, 301n]) {
          expect(block - previous).toBeLessThanOrEqual(30n);
          previous = block;
        }
      }
      expect(b.fitPaid).toBeGreaterThan(0n); expect(b.platformPaid).toBeGreaterThan(0n);
      expect(b.fitOwed).toBeGreaterThanOrEqual(0n); expect(b.platformOwed).toBeGreaterThanOrEqual(0n);
      expect(b.fees + b.fitOwed + b.platformOwed + b.fitPaid + b.platformPaid + b.otherShares).toBe(45n * 201n);
    }
  }, shLimit(30_000));

  it.each(['rate limit', 'fee ceiling reached', 'daily ceiling reached', 'ours budget spent'])(
    'retries a ready collect next block after %s without losing its previous attempt', async (why) => {
      const cfg = config();
      const limits = { ...cfg.limits };
      if (why === 'rate limit') limits.maxTxPerBlock = 0;
      if (why === 'fee ceiling reached') limits.maxFeePerGas = 1n;
      if (why === 'daily ceiling reached') limits.totalWeiPerDay = limits.reserveWeiPerDay;
      if (why === 'ours budget spent') limits.oursWeiPerDay = limits.reserveWeiPerDay;
      const b = box({ v2: { ...v2, buyBackP: 0n, depthBudget: 0n } });
      let w = world(b);
      const sends: bigint[] = [];
      const port: ChainPort = {
        readIncome: async () => fundedIncome(w),
        read: async () => w,
        simulate: async (c) => ({ ok: c.job === 'collect', tipWei: null, estimate: 100_000n }),
        send: async () => { sends.push(w.block.number); return '0x01'; },
      };
      const previous = await runTick(port, {}, cfg, quiet);
      w = world(b, 125n);
      const deferred = await runTick(port, previous.state, { ...cfg, limits }, quiet);
      expect(deferred.report.skipped).toContainEqual(expect.objectContaining({ job: 'collect', why }));
      w = world(b, 126n);
      await runTick(port, deferred.state, cfg, quiet);
      expect(sends).toEqual([100n, 126n]);
    },
  );

  it.each(['nothing to do', 'simulation error', 'send error'])(
    'retains the 25-block backoff after %s', async (why) => {
      const cfg = config();
      const b = box({ v2: { ...v2, buyBackP: 0n, depthBudget: 0n } });
      let w = world(b);
      const sends: bigint[] = [];
      const port: ChainPort = {
        readIncome: async () => fundedIncome(w),
        read: async () => w,
        simulate: async (c) => {
          if (c.job === 'collect' && w.block.number === 100n && why === 'simulation error') throw new Error('RPC unavailable');
          return { ok: c.job === 'collect' && !(w.block.number === 100n && why === 'nothing to do'), tipWei: null, estimate: 100_000n };
        },
        send: async () => {
          if (w.block.number === 100n && why === 'send error') throw new Error('ambiguous timeout');
          sends.push(w.block.number);
          return '0x01';
        },
      };
      let out = await runTick(port, {}, cfg, quiet);
      expect(out.report.skipped).toContainEqual(expect.objectContaining({ job: 'collect', why }));
      expect(out.state.budget.totalWei > 0n).toBe(why === 'send error');
      for (const block of [101n, 124n]) {
        w = world(b, block);
        out = await runTick(port, out.state, cfg, quiet);
        expect(out.report.sent).toEqual([]);
      }
      w = world(b, 125n);
      await runTick(port, out.state, cfg, quiet);
      expect(sends).toEqual([125n]);
    },
  );
});
