import { required as present } from '../../../../chain/src/core/set-v2/test-support';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, zeroHash, type Hex } from 'viem';
import { buildSetCommitment } from '@squarehole/box-spec';
import { setVaultV2Abi } from '@squarehole/chain/core/set-v2';
import { identityInput, core, setManifestInput, spec, hash } from '../../../../chain/src/core/set-v2/test-support';
import { parseSetManifest } from '@squarehole/chain/core/set-v2';
import { decodeSetLogs, setRoute } from '../../../src/core/set-v2/events';
import { reduceSetMembers } from '../../../src/core/set-v2/members';
import { projectSetSpec } from '../../../src/core/set-v2/project';
import type { RawLog } from '../../../src/events';
const identity = identityInput();
const ids = [0n, (1n<<256n)-1n, ...Array.from({length:8},(_,i)=>BigInt(i*77+3))];
const s = {...spec,...buildSetCommitment(spec.collection,ids).commitment};
const row = {record:{boxId:0n,contracts:identity.roles,poolId:zeroHash},registry:identity.registry,release:parseSetManifest(setManifestInput(),core)};
function log(name: string, args: Record<string,unknown>, index: number): RawLog {
  const event = setVaultV2Abi.find(e=>e.type==='event' && e.name===name);
  if(!event || event.type!=='event') throw new Error('event');
  return {address:present(identity.roles[3]),blockNumber:51n,blockHash:hash('block'),transactionHash:hash('tx'),transactionIndex:0,logIndex:index,
    topics:encodeEventTopics({abi:[event],eventName:name,args} as never) as Hex[],data:encodeAbiParameters(event.inputs.filter(i=>!i.indexed),event.inputs.filter(i=>!i.indexed).map(i=>args[i.name])),removed:false};
}
describe('E08B-MEMBERS',()=>{
  it('decodes all-indexed load ids and recomputes root; releases never return; deferrals retry',()=>{
    const route = setRoute(row.record as never,row.release);
    const events = decodeSetLogs(ids.map((id,index)=>log('SetLoaded',{index:BigInt(index),collection:s.collection,id},index)),route);
    expect(events).toHaveLength(10);
    const initial = reduceSetMembers(undefined,events,s);
    expect(initial.members.map(m=>m.id)).toEqual(ids);
    expect(initial.root).toBe(s.setHash);
    const deferred = reduceSetMembers(initial,decodeSetLogs([log('ReleaseDeferred',{collection:s.collection,id:0n},11)],route),s);
    expect(deferred.members[0]?.state).toBe('Deferred');
    const released = reduceSetMembers(deferred,decodeSetLogs([log('ReleaseSucceeded',{collection:s.collection,id:0n,creator:identity.creator},12)],route),s);
    expect(released.members[0]?.state).toBe('Released');
    expect(initial.members[0]?.state).toBe('Inside');
    expect(()=>reduceSetMembers(released,[{...present(events[0]),name:'Returned',args:{ids:[0n]}}],s)).toThrow(/return/);
    expect(()=>reduceSetMembers(undefined,[...events].reverse(),s)).toThrow();
  });
  it('uses separate no-argument gate/failure selectors',()=>{
    const events=decodeSetLogs([log('GateOpened',{},0),log('FailureEntered',{},1)],setRoute(row.record as never,row.release));
    expect(events.map(e=>e.name)).toEqual(['GateOpened','FailureEntered']);
  });
  it('projects the planner Grow recipe and existing-kind fields without changing set spec',()=>{
    const b=projectSetSpec(s);
    expect(b.boxType).toBe(2); expect(b.buyers).toEqual(b.sellers); expect(b.buyers.a.dest).toBe(4);
    expect(b.n).toBe(10); expect(b.addOns).toEqual([{id:8,params:encodeAbiParameters([{type:'bytes32'},{type:'uint32'}],[s.setHash,10])}]);
    expect('firstId' in s).toBe(false);
  });
});
