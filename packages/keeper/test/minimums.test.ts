import { describe, expect, it } from 'vitest';
import { ViemChain } from '../src/chain';
import { loadConfig } from '../src/config';
import { openBudget } from '../src/decide';
import { emptyMemory, plan } from '../src/plan';
import { runTick, type KeeperState } from '../src/run';
import { seededRng } from '../src/rng';
import { fakeClient, fakeNode, REVERT } from './support/fake-rpc';
import { fundedIncome, addr, box, keeper, quiet, time, v2, world } from './support/v2';

const env = { SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: 'http://fake.invalid' };
const token = addr(0xabcdef);
const override = (q = token, collectRaw = '9007199254740993') =>
  JSON.stringify({ [q]: { collectRaw } });

function fixture(q = addr(0), decimals = 18, extra: Record<string, string> = {}) {
  const registry = addr(10), co = addr(1), hk = addr(2), rc = addr(3), router = addr(6);
  const node = fakeNode({ block: { number: 100n, timestamp: time, baseFeePerGas: 1n } });
  const amounts = { buyersP: 0n, sellersP: 0n, qToReserve: 0n, tip: 0n, fit: 0n, platform: 0n };
  node.versions = { [hk]: 2, [rc]: 2 };
  node.calls = {
    [`${registry}:boxCount`]: () => 1n,
    [`${registry}:roleOf`]: ([, role]) => ({ 0: co, 2: hk, 5: rc, 6: router })[String(role) as '0'] ?? addr(0),
    [`${hk}:q`]: () => q, [`${hk}:poolId`]: () => `0x${'11'.repeat(32)}`,
    [`${hk}:poolManager`]: () => addr(7), [`${hk}:closed`]: () => true,
    [`${hk}:closedAt`]: () => time - 100n, [`${hk}:lastProtocolBlock`]: () => 0n,
    [`${hk}:depthBudget`]: () => 0n,
    [`${co}:graduated`]: () => true, [`${co}:failed`]: () => false,
    [`${co}:gateOpen`]: () => true, [`${co}:openAt`]: () => time - 100n,
    [`${co}:deadline`]: () => time + 100n, [`${co}:rewardOf`]: () => 0n,
    [`${co}:claimReward`]: () => 1n, [`${co}:fail`]: () => undefined,
    [`${co}:failClosed`]: () => undefined,
    [`${rc}:graduationSettled`]: () => true,
    [`${rc}:fitOwed`]: () => amounts.fit, [`${rc}:platformOwed`]: () => amounts.platform,
    [`${rc}:buyBackP`]: () => 0n, [`${rc}:tBurnPending`]: () => 0n,
    [`${rc}:collect`]: () => amounts,
    [`${rc}:payFit`]: () => amounts.fit, [`${rc}:payPlatform`]: () => amounts.platform,
    [`${router}:sweep`]: () => 0n, [`${q}:decimals`]: () => decimals,
  };
  const cfg = { ...loadConfig({ ...env, SH_KEEPER_BOX_REGISTRY: registry, ...extra }),
    keeper, privateEndpoint: false, rng: seededRng(2) };
  const chain = new ViemChain(cfg, fakeClient(node), keeper, { public: null, private: null }, null, quiet);
  // This suite isolates lifecycle/batching against a funded receipt-source double.
  chain.readIncome = async () => fundedIncome(await chain.read());
  return { node, amounts, cfg, chain, co, hk, rc, tick: (state: KeeperState = {}) => runTick(chain, state, cfg, quiet) };
}

describe('FABLE review item 2: raw per-coin maintenance minimums', () => {
  it.each([6, 8, 18])('batches collects at the %i-decimal default while every positive Safe debt stays eligible', async (decimals) => {
    const f = fixture(token, decimals);
    const minimum = 10n ** BigInt(decimals - 2); // 0.01 P; no ETH valuation.
    for (const amount of [0n, 1n, minimum - 1n, minimum, minimum + 1n]) {
      Object.assign(f.amounts, { buyersP: amount, fit: amount, platform: amount });
      const { report, state } = await f.tick();
      expect(report.sent.map((c) => c.job).sort()).toEqual(amount >= minimum
        ? ['collect', 'receiverPayFit', 'receiverPayPlatform'] : amount > 0n ? ['receiverPayFit', 'receiverPayPlatform'] : []);
      expect(state.budget.totalWei === 0n).toBe(amount === 0n);
    }
    Object.assign(f.amounts, { buyersP: 0n, fit: minimum - 1n, platform: minimum });
    expect((await f.tick()).report.sent.map((c) => c.job)).toEqual(['receiverPayFit', 'receiverPayPlatform']);
    Object.assign(f.amounts, { fit: minimum, platform: minimum - 1n });
    expect((await f.tick()).report.sent.map((c) => c.job)).toEqual(['receiverPayFit', 'receiverPayPlatform']);
  });

  it('uses 18 decimals for native P without a token metadata call', async () => {
    const f = fixture();
    f.node.calls[`${addr(0)}:decimals`] = () => { throw new Error('native coin has no decimals method'); };
    f.amounts.buyersP = 10n ** 16n - 1n;
    expect((await f.tick()).report.sent).toEqual([]);
    f.amounts.buyersP++;
    expect((await f.tick()).report.sent.map((c) => c.job)).toEqual(['collect']);
  });

  it('loads case-insensitive per-coin decimal strings without rounding and applies collect minimums', async () => {
    const f = fixture(token, 6, { SH_KEEPER_COIN_MINIMUMS: override(`0x${token.slice(2).toUpperCase()}`) });
    expect(f.cfg.coinMinimums[token]).toEqual({ collectRaw: 9007199254740993n });
    Object.assign(f.amounts, { buyersP: 9007199254740992n, fit: 9007199254740994n, platform: 9007199254740995n });
    expect((await f.tick()).report.sent.map((c) => c.job)).toEqual(['receiverPayFit', 'receiverPayPlatform']);
    f.amounts.buyersP++;
    f.amounts.fit++;
    expect((await f.tick()).report.sent.map((c) => c.job).sort()).toEqual(['collect', 'receiverPayFit', 'receiverPayPlatform']);
    const other = fixture(addr(12), 6, { SH_KEEPER_COIN_MINIMUMS: override() });
    other.amounts.buyersP = 10000n;
    expect((await other.tick()).report.sent.map((c) => c.job)).toEqual(['collect']);
  });

  it.each([
    'invalid JSON', '[]', 'null', '{"bad-address":{"collectRaw":"1"}}',
    JSON.stringify({ [token]: { collectRaw: 10000 } }),
    ...['0', '-1', '0.01', '1e6', (2n ** 256n).toString()].map((raw) => override(token, raw)),
    JSON.stringify({ [token]: {} }), JSON.stringify({ [token]: { collectRaw: '1', payoutRaw: '1' } }),
    JSON.stringify({ [token]: { collectRaw: '1', typo: '1' } }),
    JSON.stringify({ [token]: { collectRaw: '1' }, [`0x${token.slice(2).toUpperCase()}`]: { collectRaw: '2' } }),
  ])('rejects malformed or ambiguous minimum config: %s', (value) => {
    expect(() => loadConfig({ ...env, SH_KEEPER_COIN_MINIMUMS: value })).toThrow(/SH_KEEPER_COIN_MINIMUMS/);
  });

  it('checks the sum of newly booked fees, reserve and paid tip once, including seller-only fees', async () => {
    const f = fixture(token, 6);
    Object.assign(f.amounts, { buyersP: 4000n, sellersP: 3000n, qToReserve: 2000n, tip: 999n });
    expect((await f.tick()).report.sent).toEqual([]);
    f.amounts.tip++;
    expect((await f.tick()).report.sent.map((c) => c.job)).toEqual(['collect']);
    Object.assign(f.amounts, { buyersP: 0n, sellersP: 10000n, qToReserve: 0n, tip: 0n });
    expect((await f.tick()).report.sent.map((c) => c.job)).toEqual(['collect']);
  });

  it('simulates a v2 payout and admits only positive pending progress', async () => {
    const f = fixture(token, 6);
    f.amounts.fit = 10000n;
    let payoutCalls = 0;
    f.node.calls[`${f.rc}:payFit`] = () => { payoutCalls++; return 10000n; };
    expect((await f.tick()).report.sent.map(c => c.job)).toEqual(['receiverPayFit']);
    expect(payoutCalls).toBe(1);
    f.node.calls[`${f.rc}:payFit`] = () => 0n;
    expect((await f.tick()).report.sent).toEqual([]);
  });

  it('spends no budget over repeated dust cycles, then processes accumulated funds', async () => {
    const f = fixture(token, 6);
    let state: KeeperState = {};
    for (let cycle = 0n; cycle < 5n; cycle++) {
      f.node.block = { ...f.node.block, number: 100n + cycle * 25n };
      f.amounts.buyersP += 1000n;
      const out = await f.tick(state);
      expect(out.report.sent).toEqual([]);
      expect(out.state.budget.totalWei).toBe(0n);
      state = out.state;
    }
    f.node.block = { ...f.node.block, number: 225n };
    Object.assign(f.amounts, { buyersP: 10000n, fit: 10000n, platform: 10000n });
    expect((await f.tick(state)).report.sent.map((c) => c.job).sort()).toEqual(['collect', 'receiverPayFit', 'receiverPayPlatform']);
  });

  it.each([null, 5, 19])('isolates unavailable/unsupported decimals (%s) from failure and fixed-Safe exits', async (decimals) => {
    const f = fixture(token, decimals ?? 6);
    if (decimals === null) f.node.calls[`${token}:decimals`] = () => { throw REVERT; };
    f.node.calls[`${f.co}:graduated`] = () => false;
    f.node.calls[`${f.hk}:closedAt`] = () => time - 604800n;
    Object.assign(f.amounts, { buyersP: 10000n, fit: 10000n, platform: 10000n });
    expect((await f.tick()).report.sent.map((c) => c.job)).toEqual(['fail', 'receiverPayFit', 'receiverPayPlatform']);
  });

  it('can use explicit raw minimums when token decimals are unavailable', async () => {
    const f = fixture(token, 6, { SH_KEEPER_COIN_MINIMUMS: override(token, '100') });
    f.node.calls[`${token}:decimals`] = () => { throw REVERT; };
    Object.assign(f.amounts, { buyersP: 100n, fit: 200n, platform: 199n });
    expect((await f.tick()).report.sent.map((c) => c.job).sort()).toEqual(['collect', 'receiverPayFit', 'receiverPayPlatform']);
  });

  it('recovers refused graduation settlement even without a fee batch or token decimals', async () => {
    const f = fixture(token, 6);
    f.node.calls[`${token}:decimals`] = () => { throw REVERT; };
    f.node.calls[`${f.rc}:graduationSettled`] = () => false;
    expect((await f.tick()).report.sent.map((c) => c.job)).toEqual(['collect']);
  });

  it.each(['deadline', 'hatch', 'closed', 'claim'] as const)('keeps %s eligible for reserved gas with sub-minimum funds', async (exit) => {
    const f = fixture(token, 6, { SH_KEEPER_COIN_MINIMUMS: override() });
    if (exit === 'claim') f.node.calls[`${f.co}:rewardOf`] = () => 1n;
    else f.node.calls[`${f.co}:graduated`] = () => false;
    if (exit === 'deadline') {
      f.node.calls[`${f.hk}:closed`] = () => false;
      f.node.calls[`${f.co}:deadline`] = () => time;
    }
    if (exit === 'hatch') f.node.calls[`${f.hk}:closedAt`] = () => time - 604800n;
    if (exit === 'closed') {
      f.node.calls[`${f.co}:gateOpen`] = () => false;
      f.node.calls[`${f.co}:openAt`] = () => time - 1209600n;
    }
    Object.assign(f.amounts, { buyersP: 1n, fit: 1n, platform: 1n });
    const spent = f.cfg.limits.oursWeiPerDay - f.cfg.limits.reserveWeiPerDay;
    const state = { budget: { ...openBudget(undefined, 100n, time), oursWei: spent, totalWei: spent } };
    const out = await f.tick(state);
    expect(out.report.sent.map((c) => c.job).sort()).toEqual([
      exit === 'claim' ? 'claimReward' : exit === 'closed' ? 'failClosed' : 'fail',
      'receiverPayFit', 'receiverPayPlatform',
    ].sort());
    expect(out.state.budget.oursWei).toBeGreaterThan(spent);
    expect(out.state.budget.oursWei).toBeLessThanOrEqual(f.cfg.limits.oursWeiPerDay);
  });

  it('keeps Box 0 payout policy independent of v2 coin overrides', () => {
    const cfg = { ...loadConfig({ ...env, SH_KEEPER_COIN_MINIMUMS: override(addr(0)) }), keeper, rng: seededRng(2) };
    const b = box({ version: 1, fitOwed: cfg.payoutMinWei - 1n, platformOwed: cfg.payoutMinWei, v2 });
    const jobs = plan(world(b), emptyMemory(), cfg).candidates.map((c) => c.job);
    expect(jobs).not.toContain('receiverPayFit');
    expect(jobs).toContain('receiverPayPlatform');
  });
});
