import { required as present } from '../../../../chain/src/core/set-v2/test-support';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CoreGateway } from '../../../src/core/core-gateway';
import { describe,expect,it } from 'vitest';
import { decodeEventLog,decodeFunctionData,encodeFunctionResult,zeroHash,type Abi,type Hex } from 'viem';
import { buildSetCommitment } from '@squarehole/box-spec';
import { setFactoryV2Abi,setVaultV2Abi,setFeedSchema,setMembersSchema } from '@squarehole/chain/core/set-v2';
import { boxTokenAbi,poolManagerAbi } from '@squarehole/chain/abi';
import { coordinatorV2Abi,hookV2Abi,receiverV2Abi,starterSetLoaderV2Abi,registryV2Abi } from '../../../src/core/v2/chain-v2';
import { CoreChainIndexer } from '../../../src/core/chain-indexer';
import { MemoryHistory } from '../../../src/history/memory-history';
import { PgHistory } from '../../../src/history/pg-history';
import { HistoryWriter } from '../../../src/history/writer';
import { startTempPostgres } from '../../history/pg-cluster';
import { World,event } from '../core-synth';
import { ScriptedCoreChain } from '../scripted-core-chain';
import { coreGatewaySource } from '../../../src/core/core-service';
import { toJson } from '../../../src/model';
import { fixture,core } from './fixture';

function worldOf() {
  const f=fixture(),{row,ids}=f,w=new World('sets');
  w.block(10n);
  const vaultEvent=(name:string,args:Record<string,unknown>)=>event(setVaultV2Abi,present(row.contracts.vault ?? undefined),name,args);
  const load=(start:number,end:number)=>ids.slice(start,end).map((id,i)=>vaultEvent('SetLoaded',{index:BigInt(start+i),collection:row.spec.collection,id}));
  w.block(51n,[[event(registryV2Abi,row.registry,'BoxCreated',{boxId:row.boxId,templateId:row.templateId,specHash:row.specHash,record:row.record}),event(registryV2Abi,row.registry,'BoxSpec',{boxId:row.boxId,encodedSpec:row.encodedSpec}),...load(0,16)]]);
  w.block(52n,load(16,32));w.block(53n,load(32,40));
  w.block(54n,[vaultEvent('GateOpened',{})]);
  const picked=ids.slice(0,32);
  w.block(55n,[vaultEvent('Withdrawn',{owner:row.creator,ids:picked,principal:100n,fee:5n,supplyAfter:995n,escrowAfter:100n,insideAfter:8n})]);
  w.to(57n);
  const chain=new ScriptedCoreChain(core.chainId,w.headers,w.logs,a=>f.codes.get(a.toLowerCase())??'0x');
  const abis:readonly [string,Abi][]=[[row.release.factory.address,setFactoryV2Abi],[row.poolManager,poolManagerAbi],[present(row.contracts.vault ?? undefined),setVaultV2Abi],
    [present(row.contracts.starterSetLoader ?? undefined),starterSetLoaderV2Abi],[present(row.contracts.coordinator ?? undefined),coordinatorV2Abi],[present(row.contracts.token ?? undefined),boxTokenAbi],[present(row.contracts.hook ?? undefined),hookV2Abi],[present(row.contracts.receiver ?? undefined),receiverV2Abi]];
  chain.callAt=async(to,data,hash)=>{
    const abi=abis.find(([a])=>a.toLowerCase()===to.toLowerCase())?.[1];if(!abi)throw new Error('fixture target');
    const decoded=decodeFunctionData({abi,data});const fn=abi.find(f=>f.type==='function'&&f.name===decoded.functionName);
    if(!fn||fn.type!=='function')throw new Error('fixture function');
    const values:Record<string,unknown>={versionCodeHash:row.release.versionCodeHash,RELEASE:row.release.release,TEMPLATE:row.release.templateId,extsload:zeroHash,buyersChoice:3,sellersChoice:3};
    const all=[];let h=chain.byHash.get(hash.toLowerCase());while(h){all.unshift(...(chain.logsOf.get(h.hash.toLowerCase())??[]));h=chain.byHash.get(h.parentHash.toLowerCase());}
    let loaded=0,inside=0n,gate=false,escrow=0n;
    for(const l of all.filter(l=>l.address.toLowerCase()===present(row.contracts.vault ?? undefined).toLowerCase())) {
      const e=decodeEventLog({abi:setVaultV2Abi,data:l.data,topics:l.topics as [Hex,...Hex[]]});
      if(e.eventName==='SetLoaded'){loaded++;inside++;}
      if(e.eventName==='GateOpened')gate=true;
      if(e.eventName==='Withdrawn'){inside-=BigInt(e.args.ids.length);escrow+=e.args.principal;}
    }
    const pages=buildSetCommitment(row.spec.collection,ids,1).pages;
    Object.assign(values,{inside,escrowPrincipal:escrow,gateOpen:gate,seedReady:loaded===40,progress:[loaded,loaded?present(pages[loaded-1]).nextHash:row.spec.setHash,gate]});
    const defaults=fn.outputs.map(o=>o.type==='bool'?false:o.type==='address'?row.release.platformSafe.address:o.type==='uint8'?0:0n);
    const result=values[fn.name]??(defaults.length===1?defaults[0]:defaults);
    return encodeFunctionResult({abi,functionName:fn.name,result} as never);
  };
  return {f,w,chain,load,vaultEvent};
}
for(const pg of [false,true]) describe.runIf(!pg||process.env.SH_HISTORY_PG==='1')(`E08B-REORG history ${pg?'Postgres':'memory'}`,()=>{
  it('rolls back orphan pages and picks, reapplies, and deep-rebuilds without contaminating the v2 feed',async()=>{
    const cluster=pg?await startTempPostgres():null;
    if(pg&&!cluster)throw new Error('SH_HISTORY_PG requested but PostgreSQL binaries unavailable');
    const store=cluster?new PgHistory(cluster):new MemoryHistory();
    if(store instanceof PgHistory)await store.init();
    const writer=new HistoryWriter(store,{depth:1});
    const {f,w,chain,load,vaultEvent}=worldOf();
    const indexer=new CoreChainIndexer({manifest:core,setManifest:f.row.release,reader:chain,windowBlocks:8,onHistory:writer.accept});
    try {
      await indexer.start();await writer.flush();expect(indexer.metrics.lastError).toBeNull();
      expect(indexer.setsV2.size).toBe(1);
      expect(setFeedSchema.parse(indexer.setFeedView()).boxes[0]?.state).toMatchObject({loaded:'40',inside:'8'});
      expect(setMembersSchema.parse(indexer.setMembersView(present(f.row.contracts.token ?? undefined))).members[0]?.state).toBe('Outside');
      const states = present([...indexer.setsV2.values()][0]).states;
      const picked = present(states.find(s => s.block === 55n)).membership;
      expect(picked.inside).toBe(8n);
      expect(states.filter(s => s.block >= 55n).every(s => s.membership === picked)).toBe(true);
      expect(picked.positions).toBe(present(states.find(s => s.block === 53n)).membership.positions);
      const baseline=new CoreChainIndexer({manifest:core,reader:chain});await baseline.start();
      expect(indexer.v2FeedView()).toEqual(baseline.v2FeedView());
      expect(JSON.stringify(indexer.v2FeedView())).toMatchSnapshot();
      const gatewaySource=coreGatewaySource(indexer,chain,store,60000).source;
      const memorySource=coreGatewaySource(indexer,chain,null,60000).source;
      let following=true;
      const gateway=new CoreGateway({source:{...gatewaySource,health:()=>({following,reason:null,history:null})},host:'localhost',port:0});
      // A history generation cannot certify in-memory set changes. Keep it fixed to expose stale cache reuse.
      const memoryGateway=new CoreGateway({source:{...memorySource,dataVersion:()=>0n,health:()=>({following,reason:null,history:null})},host:'localhost',port:0});
      const get=async(url:string,target=gateway)=>{
        let status=0,body='';
        await target.route({method:'GET',url} as IncomingMessage,{writeHead:(s:number)=>{status=s;},end:(s:string)=>{body=s;}} as unknown as ServerResponse);
        return {status,body:JSON.parse(body)};
      };
      const path=`/v2/sets/${core.chainId}/${f.row.contracts.token}`;
      const activityMatches=async(target=gateway,src=gatewaySource)=>{
        const expected=await src.activity(present(f.row.contracts.token ?? undefined).toLowerCase(),{kind:null,before:null,limit:50});
        const response=await get(`${path}/activity`,target);
        expect(response).toEqual({status:200,body:JSON.parse(toJson(expected))});
        return response.body.items;
      };
      expect((await get('/v2/sets/feed')).body).toEqual(indexer.setFeedView());
      expect((await get(path)).body).toEqual(indexer.setBoxView(present(f.row.contracts.token ?? undefined)));
      const page=await get(`${path}/members?offset=1&limit=1`);
      expect(setMembersSchema.parse(page.body).members[0]?.id).toBe(String((1n<<256n)-1n));
      expect((await get(`${path}/money`)).body).toEqual(indexer.setMoneyView(present(f.row.contracts.token ?? undefined)));
      expect((await get(`${path}/activity`)).body.items.length).toBeGreaterThan(0);
      const originalMemoryActivity=await activityMatches(memoryGateway,memorySource);
      await activityMatches();
      expect((await get(`${path}/members?offset=-1`)).status).toBe(400);
      expect((await get('/v2/sets/feed?chain=1')).status).toBe(404);
      following=false;expect((await get(path)).status).toBe(503);
      following=true;
      const canonical=await store.dump(core.chainId);
      const fork=w.fork(52n,'orphan');fork.to(58n);chain.setBranch(fork.headers.filter(h=>h.number>52n),fork.logs.filter(l=>l.blockNumber>52n));
      await indexer.enqueue(chain.header(58n));await writer.flush();expect(indexer.metrics.lastError).toBeNull();
      expect(indexer.setBoxView(present(f.row.contracts.token ?? undefined))?.box.state).toMatchObject({loaded:'32',inside:'32'});
      const rewound = present(present([...indexer.setsV2.values()][0]).states.at(-1)).membership;
      expect(rewound.inside).toBe(32n);expect(rewound.positions.size).toBe(32);
      expect(picked.inside).toBe(8n);expect(picked.positions.size).toBe(40);
      const undone=await store.dump(core.chainId);expect(undone.activity.length).toBeLessThan(canonical.activity.length);
      await activityMatches();
      const rolledBackMemoryActivity=await activityMatches(memoryGateway,memorySource);
      expect(rolledBackMemoryActivity.length).toBeLessThan(originalMemoryActivity.length);
      const replay=fork.fork(58n,'reapplied');replay.block(59n,load(32,40));replay.block(60n,[vaultEvent('GateOpened',{})]);replay.block(61n,[vaultEvent('Withdrawn',{owner:f.row.creator,ids:f.ids.slice(0,32),principal:100n,fee:5n,supplyAfter:995n,escrowAfter:100n,insideAfter:8n})]);
      chain.setBranch(replay.headers.filter(h=>h.number>58n),replay.logs.filter(l=>l.blockNumber>58n));await indexer.enqueue(chain.header(61n));
      expect(indexer.setBoxView(present(f.row.contracts.token ?? undefined))?.box.state).toMatchObject({loaded:'40',inside:'8'});
      expect(present(present([...indexer.setsV2.values()][0]).states.at(-1)).membership).toEqual(picked);
      const reappliedMemoryActivity=await activityMatches(memoryGateway,memorySource);
      expect(reappliedMemoryActivity.length).toBeGreaterThan(rolledBackMemoryActivity.length);
      expect(reappliedMemoryActivity).not.toEqual(originalMemoryActivity);
      await writer.flush();await activityMatches();
      // Deep replacement of the creation itself rebuilds all rows and history.
      const deep=w.fork(50n,'deep');deep.to(62n);chain.setBranch(deep.headers.filter(h=>h.number>50n),[]);
      await indexer.enqueue(chain.header(62n));await writer.flush();expect(indexer.setsV2.size).toBe(0);expect(indexer.metrics.rebuilds).toBeGreaterThan(0);
      expect((await store.dump(core.chainId)).activity).toEqual([]);
      expect(await get(`${path}/activity`)).toEqual({status:404,body:{error:'unknown set'}});
      expect(await get(`${path}/activity`,memoryGateway)).toEqual({status:404,body:{error:'unknown set'}});
      const source=coreGatewaySource(indexer,chain,store,60000).source;expect(source.setFeed?.()?.boxes).toEqual([]);
    } finally {indexer.stop();await writer.stop();await store.close();await cluster?.stop();}
  });
});
