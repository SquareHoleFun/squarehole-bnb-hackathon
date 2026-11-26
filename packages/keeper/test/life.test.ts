import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { receiverV2Abi } from '../src/abi';
import { ViemChain } from '../src/chain';
import { loadConfig } from '../src/config';
import { emptyMemory, plan } from '../src/plan';
import { runTick } from '../src/run';
import { fakeClient, fakeNode, REVERT } from './support/fake-rpc';
import { fundedIncome, addr, keeper, options, quiet, time } from './support/v2';

describe('CQ11-E keeper lifecycle with fake RPC', () => {
  it('discovers v2, decodes four-result steps, retries independent Safe payouts and sweeps after failure', async () => {
    const node = fakeNode({ block: { number: 100n, timestamp: time, baseFeePerGas: 1n } });
    let graduated = false;
    let failed = false;
    let tLeft = 3n;
    let count = 1n;
    let q = addr(0);
    let collectCalls = 0;
    const registry = addr(10), co = addr(1), hk = addr(2), rc = addr(3), router = addr(6);
    // Explicit address ABIs distinguish the unchanged selector's v1/v2 return types.
    node.versions = { [hk]: 2, [rc]: 2 };
    node.logs = (address) => address.toLowerCase() === rc ? [{
      address: rc, blockNumber: '0x63', transactionIndex: '0x0', logIndex: '0x0', removed: false,
      blockHash: `0x${'11'.repeat(32)}`, transactionHash: `0x${'22'.repeat(32)}`,
      topics: encodeEventTopics({ abi: receiverV2Abi, eventName: 'RoyaltyFunded', args: { token: addr(8), destination: 0 } }),
      data: encodeAbiParameters([{ type: 'uint256' }], [4n]),
    }] : [];
    node.calls = {
      [`${registry}:boxCount`]: () => count,
      [`${registry}:roleOf`]: ([, role]) => ({ 0: co, 2: hk, 5: rc, 6: router })[String(role) as '0'] ?? addr(0),
      [`${hk}:q`]: () => q, [`${hk}:poolId`]: () => `0x${'11'.repeat(32)}`,
      [`${hk}:poolManager`]: () => addr(7), [`${hk}:closed`]: () => true,
      [`${hk}:closedAt`]: () => time - 604800n, [`${hk}:lastProtocolBlock`]: () => 0n,
      [`${hk}:depthBudget`]: () => 1000n, [`${hk}:deepen`]: () => [0, 30n, 20n, 1n],
      [`${co}:graduated`]: () => graduated, [`${co}:failed`]: () => failed,
      [`${co}:gateOpen`]: () => true, [`${co}:openAt`]: () => time - 700000n,
      [`${co}:deadline`]: () => time + 1000n, [`${co}:rewardOf`]: ([who]) => who === keeper ? 10n : 0n,
      [`${co}:claimReward`]: () => 10n, [`${co}:claimState`]: () => [100n, tLeft],
      [`${co}:fail`]: () => undefined,
      [`${rc}:graduationSettled`]: () => true,
      [`${rc}:fitOwed`]: () => 100n, [`${rc}:platformOwed`]: () => 200n,
      [`${rc}:buyBackP`]: () => 1000n, [`${rc}:tBurnPending`]: () => 1n,
      [`${rc}:collect`]: () => { collectCalls++; return { buyersP: 10n, sellersP: 5n, qToReserve: 0n, tip: failed ? 0n : 1n }; },
      [`${rc}:buyBack`]: () => [0, 30n, 20n, 1n], [`${rc}:burnPending`]: () => 1n,
      [`${rc}:payFit`]: () => { throw REVERT; }, [`${rc}:payPlatform`]: () => 200n,
      [`${router}:sweep`]: () => 5n,
    };
    const cfg = loadConfig({ SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: 'http://fake.invalid', SH_KEEPER_BOX_REGISTRY: registry });
    const chain = new ViemChain(cfg, fakeClient(node), keeper, { public: null, private: null }, null, quiet);
  // This suite isolates lifecycle/batching against a funded receipt-source double.
  chain.readIncome = async () => fundedIncome(await chain.read());
    const run = () => runTick(chain, {}, { ...options(), limits: { ...cfg.limits, maxTxPerBlock: 30 } }, quiet);
    let out = await run();
    expect(out.report.sent.map((c) => c.job)).toContain('fail');
    graduated = true;
    out = await run();
    expect(out.report.sent.map((c) => c.job)).toEqual(expect.arrayContaining(['buyBack', 'claimReward', 'collect']));
    expect(out.report.sent.map(c => c.job)).toContain('receiverPayPlatform');
    expect(out.report.skipped).toContainEqual(expect.objectContaining({ job: 'receiverPayFit', why: 'nothing to do' }));
    graduated = false; failed = true; tLeft = 0n;
    collectCalls = 0;
    const failedWorld = await chain.read();
    expect(plan(failedWorld, emptyMemory(), options()).candidates.map(c => c.job))
      .toEqual(['receiverPayFit', 'receiverPayPlatform', 'burnPending', 'routerSweep']);
    out = await run();
    expect(out.report.sent.map((c) => c.job)).toEqual(expect.arrayContaining(['routerSweep', 'burnPending', 'receiverPayPlatform']));
    expect(collectCalls).toBe(0);
    q = addr(8);
    expect((await chain.read()).boxes[0]?.qPerEthX18).toBeNull();
    // A reorg removes a registry entry; no cached orphan receives another transaction.
    count = 0n;
    expect((await chain.read()).boxes).toEqual([]);
    count = 1n;
    node.calls[`${co}:failed`] = () => { throw new Error('RPC unavailable'); };
    expect((await chain.read()).boxes).toEqual([]);
    expect(node.sent).toEqual([]);
  });
});
