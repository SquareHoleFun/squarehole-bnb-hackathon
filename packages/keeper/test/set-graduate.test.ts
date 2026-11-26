import { describe, expect, it, vi } from 'vitest';
import { getAddress, keccak256, zeroAddress, parseTransaction, decodeFunctionData, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseSetManifest } from '../../chain/src/core/set-v2/manifest-set-v2';
import { core, setManifestInput, identityInput, required, hash } from '../../chain/src/core/set-v2/test-support';
import { standardRuntime } from '../../chain/src/core/v2/clones-v2';
import { destinationGasAdapters, loadConfig } from '../src/config';
import { coordinatorAbi } from '../src/abi';
import { openBudget } from '../src/decide';
import { setKeeperConfig, loadProcessConfig } from '../src/set';
import { ViemChain } from '../src/chain';
import { afterRun, emptyMemory, plan } from '../src/plan';
import { jobSpec } from '../src/jobs';
import { runTick } from '../src/run';
import { fakeNode, fakeClient, REVERT } from './support/fake-rpc';
import { options, quiet, keeper, box, world, time } from './support/v2';

const active = [[0,'coordinator'],[1,'token'],[2,'hook'],[3,'vault'],[5,'receiver'],[6,'launchRouter'],[19,'starterSetLoader']] as const;
const env = () => ({ SH_KEEPER_RPC_URL:'http://fake.invalid', SH_KEEPER_CHAIN_ID:String(core.chainId),
  SH_KEEPER_DESTINATION_FORK:'amsterdam', SH_KEEPER_TRANSACTION_GAS_CAP:'16777216',
  SH_KEEPER_BOX_REGISTRY:setManifestInput().registry.address, SH_KEEPER_STATE_FILE:'.cache/set-keeper-state.json' });
function fixture(live = false) {
  const input = setManifestInput();
  const code = '0x6001' as const;
  for (const pin of [input.factory,input.registry,input.listingRegistry,...Object.values(input.implementations)]) pin.codeHash = keccak256(code);
  const account = live ? privateKeyToAccount(`0x${'12'.repeat(32)}`) : null;
  const cfg = {...setKeeperConfig(loadConfig(env()), core, input),dryRun:!live};
  const roles = identityInput().roles;
  const co = required(roles[0]), hk = required(roles[2]);
  const node = fakeNode({chainId:core.chainId});
  for (const role of roles) node.versions[role.toLowerCase()] = 2;
  node.calls = {
    [`${input.registry.address}:factory`]: () => input.factory.address,
    [`${input.registry.address}:boxCount`]: () => 1n,
    [`${input.registry.address}:entry`]: () => [co,51n,input.templateId,hash('spec'),hash('record')],
    [`${input.registry.address}:roleOf`]: ([,i]) => roles[Number(i)],
    [`${co}:registry`]: () => input.registry.address,
    [`${co}:boxId`]: () => 0n,
    [`${co}:graduated`]: () => false, [`${co}:failed`]: () => false,
    [`${co}:gateOpen`]: () => true, [`${co}:openAt`]: () => time-100n, [`${co}:deadline`]: () => time+900000n,
    [`${hk}:closed`]: () => true, [`${hk}:closedAt`]: () => time-100n,
    [`${hk}:poolId`]: () => hash('pool'), [`${hk}:poolManager`]: () => input.poolManager.address,
    [`${hk}:q`]: () => zeroAddress, [`${co}:graduate`]: () => 0n,
    [`${co}:fail`]: () => undefined, [`${co}:failClosed`]: () => undefined,
  };
  const pub = fakeClient(node);
  const originalRead = pub.readContract.bind(pub);
  const reads = vi.spyOn(pub,'readContract').mockImplementation(async request => {
    if (request.address?.toLowerCase() === input.factory.address.toLowerCase()) {
      return {RELEASE:input.release,TEMPLATE:input.templateId,versionCodeHash:input.versionCodeHash}[request.functionName as 'RELEASE'];
    }
    return originalRead(request);
  });
  const codes = new Map<string,Hex>([input.factory,input.registry,input.listingRegistry,...Object.values(input.implementations)]
    .map(pin => [pin.address.toLowerCase(),code]));
  for (const [i,name] of active) codes.set(required(roles[i]).toLowerCase(),standardRuntime(input.implementations[name].address));
  const bytecode = vi.spyOn(pub,'getBytecode').mockImplementation(async ({address}) => codes.get(address.toLowerCase()));
  const gas = destinationGasAdapters(cfg.destinationGas,pub);
  const chain = new ViemChain(cfg,pub,account?.address ?? keeper,{public:account,private:null},null,quiet,gas.reader,gas.estimator);
  return {input,cfg,roles,co,hk,node,pub,reads,codes,bytecode,chain};
}

describe('E09C-GRADUATE isolated set keeper', () => {
  it('requires matching reviewed manifests, explicit separate state, and no Box 0; ordinary settings stay identical', () => {
    const original = loadConfig(env());
    expect(setKeeperConfig(original,core,setManifestInput())).toEqual({...original,setRelease:parseSetManifest(setManifestInput(),core)});
    expect(() => setKeeperConfig({...original,boxRegistry:required(core.releases[0]).registry.address},core,setManifestInput())).toThrow();
    expect(() => setKeeperConfig({...original,chainId:1},core,setManifestInput())).toThrow();
    expect(() => setKeeperConfig({...original,box0:{coordinator:keeper,hook:keeper,receiver:keeper,executor:keeper}},core,setManifestInput())).toThrow();
    expect(() => setKeeperConfig({...original,stateFile:'.cache/keeper-state.json'},core,setManifestInput())).toThrow();
    expect(() => setKeeperConfig(original,core,{...setManifestInput(),registry:required(core.releases[0]).registry})).toThrow();
    expect(setKeeperConfig({...original,chainId:11155111},{...core,network:'sepolia',chainId:11155111},
      {...setManifestInput(),network:'sepolia',chainId:11155111}).setRelease?.network).toBe('sepolia');
    const read = vi.fn((path: string) => JSON.stringify(path === 'core.json' ? core : setManifestInput()));
    expect(loadProcessConfig(env(),[],read)).toEqual(original);
    expect(read).not.toHaveBeenCalled();
    expect(loadProcessConfig(env(),['--core-manifest','core.json','--set-manifest','set.json'],read).setRelease).toEqual(parseSetManifest(setManifestInput(),core));
    expect(() => loadProcessConfig(env(),['--set-manifest','set.json'],read)).toThrow();
  });
  it('discovers the set role map at one block, queues graduate with no optional-module reads or jobs, and tolerates reorg removal', async () => {
    const f = fixture(); const w = await f.chain.read();
    expect(w.boxes).toHaveLength(1);
    expect(w.boxes[0]).toMatchObject({coordinator:getAddress(f.co),hook:getAddress(f.hk),setLifecycle:{closedAt:time-100n}});
    expect(w.drand).toEqual([]);
    expect(plan(w,emptyMemory(),options()).candidates.map(c=>c.job)).toEqual(['graduate']);
    expect(f.reads.mock.calls.every(([req]) => req.blockNumber === f.node.block.number-1n)).toBe(true);
    expect(f.bytecode.mock.calls.every(([req]) => req.blockNumber === f.node.block.number-1n)).toBe(true);
    const functions = f.reads.mock.calls.map(([req])=>req.functionName);
    for (const fn of ['rewardOf','allocationCursors','buyersChoice','source','status']) expect(functions).not.toContain(fn);
    expect(f.reads.mock.calls.filter(([req])=>req.functionName==='roleOf')).toHaveLength(24);
    f.node.calls[`${f.input.registry.address}:boxCount`] = () => 0n;
    expect((await f.chain.read()).boxes).toEqual([]);
  });
  it.each(['code','factory','template','absent role','active role','coordinator','read'])(
    'schedules nothing on a mismatched or unavailable %s', async fault => {
      const f = fixture();
      if (fault==='code') f.codes.set(f.input.registry.address,'0x6002');
      if (fault==='factory') f.node.calls[`${f.input.registry.address}:factory`] = () => keeper;
      if (fault==='template') f.node.calls[`${f.input.registry.address}:entry`] = () => [f.co,51n,hash('other template'),hash('spec'),hash('record')];
      if (fault==='absent role') f.roles[7] = keeper;
      if (fault==='active role') f.roles[3] = zeroAddress;
      if (fault==='coordinator') f.node.calls[`${f.co}:registry`] = () => keeper;
      if (fault==='read') f.node.calls[`${f.hk}:closed`] = () => {throw REVERT;};
      expect((await f.chain.read()).boxes).toEqual([]);
    });
  it('keeps v2.1 planning unchanged and set lifecycle retries and exact escape boundaries', () => {
    const cfg = options();
    const ordinary = box({graduated:false});
    expect(plan(world(ordinary),emptyMemory(),cfg).candidates.map(c=>c.job)).toEqual(['collect','graduate']);
    const set = {...ordinary,v2:undefined,setLifecycle:{closedAt:time-100n}};
    const w = world(set);
    const c = required(plan(w,emptyMemory(),cfg).candidates[0]);
    expect(plan(w,emptyMemory(),cfg).candidates.map(c=>c.job)).toEqual(['graduate']);
    const mem = afterRun(emptyMemory(),c,false,w);
    expect(plan(world(set,101n),mem,cfg).candidates).toEqual([]);
    expect(plan(world(set,102n),mem,cfg).candidates.map(c=>c.job)).toEqual(['graduate']);
    const jobs = (over: Partial<typeof set>, now = time) => plan(world({...set,...over},100n,now),emptyMemory(),cfg).candidates.map(c=>c.job);
    expect(jobs({curveClosed:false})).toEqual([]);
    expect(jobs({graduated:true})).toEqual([]); expect(jobs({failed:true})).toEqual([]);
    expect(jobs({},time-100n+604799n)).toEqual(['graduate']);
    expect(jobs({},time-100n+604800n)).toEqual(['fail']);
    expect(jobs({curveClosed:false,deadline:time})).toEqual(['fail']);
    expect(jobs({gateOpen:false,openAt:time-1209599n})).toEqual([]);
    expect(jobs({gateOpen:false,openAt:time-1209600n})).toEqual(['failClosed']);
  });
  it.each(['graduate','fail','failClosed'] as const)('uses RESERVED ours budget for set %s without any reward income', async job => {
    const f = fixture();
    if (job==='fail') f.node.calls[`${f.hk}:closedAt`] = () => time-604800n;
    if (job==='failClosed') {
      f.node.calls[`${f.co}:gateOpen`] = () => false;
      f.node.calls[`${f.co}:openAt`] = () => time-1209600n;
    }
    expect(jobSpec(job).reserved).toBe(true);
    const cfg = {...options(),...f.cfg,keeper,privateEndpoint:false};
    const out = await runTick(f.chain,{},cfg,quiet);
    expect(out.report.sent.map(s=>s.job)).toEqual([job]);
    expect(out.state.budget.oursWei).toBeGreaterThan(0n);
    expect(f.node.sent).toEqual([]);
    const blocked = await runTick(f.chain,{}, {...cfg,limits:{...cfg.limits,totalWeiPerDay:0n}},quiet);
    expect(blocked.report.sent).toEqual([]);
    const budget = {...openBudget(undefined,f.node.block.number,f.node.block.timestamp),
      oursWei:cfg.limits.oursWeiPerDay-cfg.limits.reserveWeiPerDay,
      totalWei:cfg.limits.totalWeiPerDay-cfg.limits.reserveWeiPerDay};
    const reserved = await runTick(f.chain,{budget},cfg,quiet);
    expect(reserved.report.sent.map(s=>s.job)).toEqual([job]);
    expect(reserved.state.budget.oursWei).toBeGreaterThan(budget.oursWei);
    const spent = await runTick(f.chain,{budget:{...budget,oursWei:cfg.limits.oursWeiPerDay}},cfg,quiet);
    expect(spent.report.sent).toEqual([]);
  });
  it('signs the canonical graduate only to its discovered coordinator through the offline fake, after durable reservation', async () => {
    const f = fixture(true);
    let reserved = 0n;
    f.node.onSend = () => {expect(reserved).toBeGreaterThan(0n);};
    const out = await runTick(f.chain,{}, {...options(),...f.cfg,keeper,privateEndpoint:false,
      checkpoint:async state => {reserved = state.budget?.oursWei ?? 0n;}},quiet);
    expect(out.report.sent.map(s=>s.job)).toEqual(['graduate']);
    expect(f.node.sent).toHaveLength(1);
    const tx = parseTransaction(required(f.node.sent[0]).raw);
    expect(tx.to?.toLowerCase()).toBe(f.co);
    expect(tx.chainId).toBe(core.chainId);
    expect(tx.value ?? 0n).toBe(0n);
    expect(tx.gas).toBeLessThanOrEqual(16777216n);
    expect(decodeFunctionData({abi:coordinatorAbi,data:required(tx.data)}).functionName).toBe('graduate');
  });
});
