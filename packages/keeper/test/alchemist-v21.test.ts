import { expect, it, vi } from 'vitest';
import { encodeFunctionData, decodeFunctionData, parseTransaction, recoverTransactionAddress, type TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAbi } from 'viem';
const receiverModulesV21Abi = parseAbi(['function executeModule(bool sellers) returns (uint256)']);
import { abiFor } from '../src/abi';
import { interpret, ViemChain } from '../src/chain';
import { loadConfig, privateSendsReady } from '../src/config';
import { feesFor, transactionGas } from '../src/gas';
import { incomeCapped } from '../src/income';
import { runTick } from '../src/run';
import { decide, openBudget } from '../src/decide';
import { JOBS } from '../src/jobs';
import { afterRun, emptyMemory, plan } from '../src/plan';
import { addr, box, keeper, quiet, time, v2, world, options } from './support/v2';
import { fakeClient, fakeNode, REVERT } from './support/fake-rpc';
const b = () => box({ v2: { ...v2, modulePendingP: [19n,23n] as const } });
const jobs = (w = world(b()), memory = emptyMemory()) => plan(w,memory,options()).candidates.filter(c => c.job === 'executeModule');
it('AL22 schedules each module side as ordinary F111 work without using recovery reserve', () => {
  const cs = jobs(); expect(cs).toHaveLength(2); expect(cs.map(c => c.args)).toEqual([[false],[true]]);
  expect(new Set(cs.map(c => c.key)).size).toBe(2);
  expect(JOBS.find(j => j.name === 'executeModule')).toMatchObject({ reserved: false, tip: 'none', gasPerRun: 3500000n, privately: true });
  for (const c of cs) {
    expect(incomeCapped(c)).toBe(true);
    const data = encodeFunctionData({ abi: abiFor(c), functionName: c.fn, args: c.args });
    expect(decodeFunctionData({ abi: receiverModulesV21Abi,data }).args).toEqual(c.args);
    expect(interpret(c,0n,null).ok).toBe(false); expect(interpret(c,19n,null).ok).toBe(true);
  }
  for (const changes of [{ failed: true },{ graduated: false },{ version: 1 as const }]) expect(jobs(world({ ...b(),...changes }))).toEqual([]);
  const candidate = cs[0]; if (!candidate) throw new Error('missing candidate');
  const held = afterRun(emptyMemory(),candidate,false,world(b()));
  expect(jobs(world(b(),101n),held)).toHaveLength(1);
  expect(jobs(world(b(),102n),held)).toHaveLength(2);
  const sent = afterRun(emptyMemory(),candidate,true,world(b()));
  expect(sent.steps).toEqual({}); expect(jobs(world(b(),101n),sent)).toHaveLength(2);
});

it('AL25 reads only selected side budgets, isolates failed reads and signs exact zero-value receiver calls', async () => {
  const registry = addr(10), co = addr(1), hk = addr(2), rc = addr(3);
  const amount = (1n << 140n) + 1n;
  const node = fakeNode({ block: { number: 100n, timestamp: time, baseFeePerGas: 1n }, versions: { [hk]: 2, [rc]: 2 } });
  node.calls = {
    [`${registry}:boxCount`]: () => 1n,
    [`${registry}:roleOf`]: ([, role]) => ({ 0: co, 2: hk, 5: rc, 6: addr(6) })[String(role) as '0'] ?? addr(0),
    [`${hk}:q`]: () => addr(8), [`${hk}:poolId`]: () => `0x${'11'.repeat(32)}`, [`${hk}:poolManager`]: () => addr(7),
    [`${hk}:closed`]: () => true, [`${hk}:closedAt`]: () => time - 100n, [`${hk}:lastProtocolBlock`]: () => 0n,
    [`${hk}:depthBudget`]: () => 0n,
    [`${co}:graduated`]: () => true, [`${co}:failed`]: () => false, [`${co}:gateOpen`]: () => true,
    [`${co}:openAt`]: () => time - 100n, [`${co}:deadline`]: () => time + 1000n,
    [`${rc}:buyersChoice`]: () => 10, [`${rc}:sellersChoice`]: () => 10,
    [`${rc}:modulePendingP`]: ([sellers]) => sellers ? amount + 1n : amount,
    [`${rc}:executeModule`]: ([sellers]) => sellers ? amount + 1n : amount,
    [`${rc}:platformOwed`]: () => 1n,
  };
  const cfg = loadConfig({ SH_KEEPER_RPC_URL: 'http://fake.invalid', SH_KEEPER_DESTINATION_FORK: 'osaka',
    SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_BOX_REGISTRY: registry,
    SH_KEEPER_PRIVATE_RPC_URL: 'https://private.invalid' });
  const client = fakeClient(node), read = vi.spyOn(client,'readContract');
  const chain = new ViemChain({ ...cfg, dryRun: false },client,keeper,
    { public: privateKeyToAccount(`0x${'11'.repeat(32)}`), private: privateKeyToAccount(`0x${'22'.repeat(32)}`) },fakeClient(node, 'private'),quiet);
  let w = await chain.read();
  expect(w.boxes[0]?.v2?.modulePendingP).toEqual([amount,amount+1n]);
  expect(read.mock.calls.filter(([r]) => r.functionName === 'modulePendingP').map(([r]) => r.blockNumber)).toEqual([99n,99n]);
  for (const c of jobs(w)) {
    const fees = feesFor(1n,1n);
    expect(await chain.simulate(c,fees)).toMatchObject({ ok: true, tipWei: null });
    await chain.send(c,transactionGas(c.job,100_000n),fees,true);
  }
  expect(node.sent).toHaveLength(2);
  for (const [i, sent] of node.sent.entries()) {
    expect(sent.endpoint).toBe('private');
    expect(await recoverTransactionAddress({ serializedTransaction: sent.raw as TransactionSerialized })).toBe(triggerSigner.address);
    const tx = parseTransaction(sent.raw);
    expect(tx.to?.toLowerCase()).toBe(rc); expect(tx.value ?? 0n).toBe(0n); expect(tx.gas).toBe(3_500_000n);
    if (!tx.data) throw new Error('missing calldata');
    expect(decodeFunctionData({ abi: receiverModulesV21Abi,data: tx.data }).args).toEqual([i === 1]);
  }
  node.calls[`${rc}:modulePendingP`] = ([sellers]) => { if (sellers) throw REVERT; return amount; };
  w = await chain.read(); expect(w.boxes[0]?.v2?.modulePendingP).toEqual([amount,null]); expect(jobs(w)).toHaveLength(1);
  expect(plan(w,emptyMemory(),options()).candidates.some(c => c.job === 'receiverPayPlatform')).toBe(true);
  node.calls[`${rc}:buyersChoice`] = () => 2; node.calls[`${rc}:sellersChoice`] = () => 3;
  read.mockClear(); w = await chain.read(); expect(w.boxes[0]?.v2?.modulePendingP).toEqual([0n,0n]);
  expect(read.mock.calls.some(([r]) => r.functionName === 'modulePendingP')).toBe(false);
});

const publicSigner = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const triggerSigner = privateKeyToAccount(`0x${'22'.repeat(32)}`);
function submission(dryRun = false, privateEndpoint = true) {
  const cfg = loadConfig({ SH_KEEPER_RPC_URL: 'https://public.invalid', SH_KEEPER_DESTINATION_FORK: 'osaka',
    SH_KEEPER_TRANSACTION_GAS_CAP: '16777216',
    SH_KEEPER_PRIVATE_RPC_URL: privateEndpoint ? 'https://private.invalid' : undefined,
    SH_KEEPER_PRIVATE_SEND_ADDRESS: triggerSigner.address });
  const node = fakeNode({ versions: { [addr(3)]: 2 }, calls: { [`${addr(3)}:executeModule`]: () => 1n } });
  const pub = fakeClient(node), priv = fakeClient(node, 'private');
  const simulate = vi.spyOn(pub, 'simulateContract'), estimate = vi.spyOn(pub, 'estimateGas');
  const chain = new ViemChain({ ...cfg, dryRun }, pub, keeper,
    { public: dryRun ? null : publicSigner, private: dryRun ? null : triggerSigner }, privateEndpoint ? priv : null, quiet);
  const c = jobs()[0]; if (!c) throw new Error('candidate missing');
  return { cfg, node, pub, priv, simulate, estimate, chain, c };
}
it('D4 refuses a public conversion send, including a direct adapter bypass', async () => {
  const f = submission();
  await expect(f.chain.send(f.c, 3500000n, feesFor(1n, 1n), false)).rejects.toThrow('private');
  expect(f.node.sent).toEqual([]);
  expect(decide('executeModule', { ok: true, tipWei: null, estimate: 100000n }, {
    fees: feesFor(1n, 1n), budget: openBudget(undefined, 100n, time), limits: options().limits, privateEndpoint: false,
  })).toEqual({ send: false, why: 'no private endpoint' });
});
it('D4 simulates and estimates as the private trigger, including a keyless dry run', async () => {
  for (const dry of [false, true]) {
    const f = submission(dry);
    expect(await f.chain.simulate(f.c, feesFor(1n, 1n))).toMatchObject({ ok: true });
    expect(f.simulate.mock.calls[0]?.[0]).toMatchObject({ account: triggerSigner.address });
    expect(f.estimate.mock.calls[0]?.[0]).toMatchObject({ account: triggerSigner.address });
    if (dry) await expect(f.chain.send(f.c, 3500000n, feesFor(1n, 1n), true)).rejects.toThrow('dry run');
    expect(f.node.sent).toEqual([]);
  }
});
it('D4 unavailable or rejected private submission never falls back to public', async () => {
  const absent = submission(false, false);
  await expect(absent.chain.send(absent.c, 3500000n, feesFor(1n, 1n), true)).rejects.toThrow('private');
  expect(absent.node.sent).toEqual([]);
  const failed = submission();
  const publicSend = vi.spyOn(failed.pub, 'sendRawTransaction');
  failed.node.onSend = () => { throw new Error('private endpoint unavailable'); };
  await expect(failed.chain.send(failed.c, 3500000n, feesFor(1n, 1n), true)).rejects.toThrow();
  expect(publicSend).not.toHaveBeenCalled(); expect(failed.node.sent).toEqual([]);
});
it('D4 refuses a private endpoint on the wrong chain before signing', async () => {
  const f = submission(); vi.spyOn(f.priv, 'getChainId').mockResolvedValue(1);
  const sign = vi.spyOn(triggerSigner, 'signTransaction');
  await expect(f.chain.send(f.c, 3500000n, feesFor(1n, 1n), true)).rejects.toThrow('chain');
  expect(sign).not.toHaveBeenCalled(); expect(f.node.sent).toEqual([]); sign.mockRestore();
});
it('D4 keyless dry runs require an explicit private trigger identity', () => {
  const cfg = loadConfig({ SH_KEEPER_RPC_URL: 'https://public.invalid', SH_KEEPER_PRIVATE_RPC_URL: 'https://private.invalid',
    SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216' });
  expect(privateSendsReady(cfg)).toBe(false);
  expect(privateSendsReady(submission(true).cfg)).toBe(true);
});
it('D5 private conversion retains F111 exact income, gas floor, reserve and dry-run accounting', async () => {
  const w = world(box({ v2: { ...v2, depthBudget: 0n, buyBackP: 0n, modulePendingP: [19n, 0n] } }));
  const cost = 3500000n * 3n;
  const send = vi.fn<ViemChain['send']>(async () => '0x' + 'ab'.repeat(32));
  const boxIncome = { shareWei: cost, tipsWei: 0n };
  const income = { at: time, platformWei: cost * 4n, boxes: { [addr(3)]: boxIncome }, mined: {} };
  const port = { read: async () => w, readIncome: async () => income,
    simulate: async (c: { job: string }) => ({ ok: c.job === 'executeModule', tipWei: null, estimate: 100000n }), send };
  const cfg = { ...options(), dryRun: false, privateEndpoint: true, priorityFeeWei: 1n };
  const first = await runTick(port, {}, cfg, quiet);
  expect(first.report.sent).toHaveLength(1); expect(send.mock.calls[0]?.[3]).toBe(true);
  expect(first.state.incomeSpend).toEqual([{ box: addr(3), at: time, costWei: cost, hash: '0x' + 'ab'.repeat(32) }]);
  send.mockClear(); boxIncome.shareWei = cost - 1n;
  expect((await runTick(port, {}, cfg, quiet)).report.skipped).toContainEqual(expect.objectContaining({ why: 'box income cap' }));
  boxIncome.shareWei = cost; income.platformWei -= 1n;
  expect((await runTick(port, {}, cfg, quiet)).report.skipped).toContainEqual(expect.objectContaining({ why: 'platform income cap' }));
  income.platformWei += 1n;
  const dry = await runTick(port, {}, { ...cfg, dryRun: true }, quiet);
  expect(dry.report.sent).toHaveLength(1); expect(dry.state.budget.totalWei).toBe(cost); expect(send).not.toHaveBeenCalled();
  const reserved = { budget: { ...openBudget(undefined, 100n, time), oursWei: cfg.limits.oursWeiPerDay - cfg.limits.reserveWeiPerDay } };
  expect((await runTick(port, reserved, cfg, quiet)).report.skipped).toContainEqual(expect.objectContaining({ why: 'ours budget spent' }));
});
