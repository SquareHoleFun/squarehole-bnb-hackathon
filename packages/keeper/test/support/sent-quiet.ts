/**
 * SH-249 A7: a scripted quiet run (every reply arrives) through the real scheduler and the real chain adapter on the fake
 * node. Its sends, their order, nonces and raw bytes, and every charge are recorded once on the line (b5c72fba1) in
 * `test/fixtures/sent-quiet-line.json`; the saved-before-sent keeper must give the same result.
 */
import { parseTransaction, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ViemChain } from '../../src/chain';
import { runTick, type KeeperState, type RunConfig } from '../../src/run';
import type { IncomeSnapshot } from '../../src/income';
import { fakeClient, fakeNode, type FakeNode } from './fake-rpc';
import { addr, options, quiet, time } from './v2';

/** An obvious dummy key: never a real account. */
export const DUMMY_KEY = `0x${'01'.repeat(32)}` as const;
export const dummy = privateKeyToAccount(DUMMY_KEY);

export interface QuietWiring {
  /** Attach durable books to the adapter and supply the checkpoint; the line has none. */
  wire?(chain: ViemChain, state: KeeperState): { checkpoint?: RunConfig['checkpoint']; state: KeeperState };
}

export function quietFixture() {
  const registry = addr(10), co = addr(1), hk = addr(2), rc = addr(3), router = addr(6);
  const node: FakeNode = fakeNode({ block: { number: 100n, timestamp: time, baseFeePerGas: 1n } });
  const me = dummy.address.toLowerCase();
  node.counts = { [me]: 7 };
  node.latestCounts = { [me]: 7 };
  const amounts = { buyersP: 0n, sellersP: 0n, qToReserve: 0n, tip: 0n, fit: 0n, platform: 0n };
  node.versions = { [hk]: 2, [rc]: 2 };
  node.calls = {
    [`${registry}:boxCount`]: () => 1n,
    [`${registry}:roleOf`]: ([, role]) => ({ 0: co, 2: hk, 5: rc, 6: router })[String(role) as '0'] ?? addr(0),
    [`${hk}:q`]: () => addr(0), [`${hk}:poolId`]: () => `0x${'11'.repeat(32)}`,
    [`${hk}:poolManager`]: () => addr(7), [`${hk}:closed`]: () => true,
    [`${hk}:closedAt`]: () => time - 100n, [`${hk}:lastProtocolBlock`]: () => 0n,
    [`${hk}:depthBudget`]: () => 0n,
    [`${co}:graduated`]: () => true, [`${co}:failed`]: () => false,
    [`${co}:gateOpen`]: () => true, [`${co}:openAt`]: () => time - 100n,
    [`${co}:deadline`]: () => time + 100n, [`${co}:rewardOf`]: () => 0n,
    [`${rc}:graduationSettled`]: () => true,
    [`${rc}:fitOwed`]: () => amounts.fit, [`${rc}:platformOwed`]: () => amounts.platform,
    [`${rc}:buyBackP`]: () => 0n, [`${rc}:tBurnPending`]: () => 0n,
    [`${rc}:collect`]: () => amounts,
    [`${rc}:payFit`]: () => amounts.fit, [`${rc}:payPlatform`]: () => amounts.platform,
    [`${router}:sweep`]: () => 0n,
  };
  const cfg = { ...options(), boxRegistry: registry, keeper: dummy.address, dryRun: false };
  const client = fakeClient(node);
  const chain = new ViemChain(cfg, client, dummy.address, { public: dummy, private: null }, null, quiet);
  let funded = true;
  chain.readIncome = async () => {
    const w = await chain.read();
    const snapshot: IncomeSnapshot = { at: w.block.timestamp, platformWei: funded ? 10n ** 30n : 0n,
      boxes: { [rc]: { shareWei: funded ? 10n ** 30n : 0n, tipsWei: 0n } }, mined: {} };
    return snapshot;
  };
  return { node, client, chain, cfg, amounts, rc, me, setFunded: (f: boolean) => { funded = f; } };
}

const text = (value: unknown) => JSON.parse(JSON.stringify(value, (_k, v: unknown) => typeof v === 'bigint' ? v.toString() : v)) as unknown;

/** Five ticks: ordinary sends, a lagging mined count, a first collection (start) and its lock; all replies arrive. */
export async function quietRun(wiring: QuietWiring = {}) {
  const f = quietFixture();
  let state: KeeperState = {};
  let checkpoint: RunConfig['checkpoint'];
  if (wiring.wire) ({ checkpoint, state } = wiring.wire(f.chain, state));
  const ticks: unknown[] = [];
  const mine = (lag: boolean) => {
    const pending = f.node.counts[f.me] ?? 0;
    if (!lag) f.node.latestCounts = { [f.me]: pending };
  };
  const script: { block: bigint; funded: boolean; tip: bigint; lag: boolean }[] = [
    { block: 100n, funded: true, tip: 1n, lag: false },
    { block: 103n, funded: true, tip: 1n, lag: true },
    { block: 106n, funded: false, tip: 10n ** 17n, lag: false },
    { block: 109n, funded: false, tip: 10n ** 17n, lag: false },
    { block: 112n, funded: true, tip: 1n, lag: false },
  ];
  for (const step of script) {
    f.node.block.number = step.block;
    f.node.block.timestamp = time + (step.block - 100n) * 12n;
    f.setFunded(step.funded);
    Object.assign(f.amounts, { buyersP: 10n ** 16n, tip: step.tip, fit: 7n + step.block, platform: 9n + step.block });
    const before = f.node.sent.length;
    const out = await runTick(f.chain, state, { ...f.cfg, ...(checkpoint ? { checkpoint } : {}) }, quiet);
    state = out.state;
    const raws = f.node.sent.slice(before).map(s => s.raw as Hex);
    // The node takes each accepted send into its pool; `mine` moves the latest count up to it, or lags a tick.
    f.node.counts = { [f.me]: (f.node.counts[f.me] ?? 0) + raws.length };
    mine(step.lag);
    ticks.push(text({
      block: step.block,
      sent: out.report.sent,
      skipped: out.report.skipped.map(s => ({ job: s.job, why: s.why })),
      raws: raws.map(raw => ({ nonce: parseTransaction(raw).nonce, raw })),
      budget: state.budget,
      incomeSpend: state.incomeSpend,
      drandBounties: state.drandBounties,
    }));
  }
  return { ticks, sentTotal: f.node.sent.length };
}
