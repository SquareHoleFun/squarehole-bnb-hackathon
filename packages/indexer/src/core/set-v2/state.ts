import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem';
import { setVaultV2Abi, setBoxDataSchema, type SetBoxData } from '@squarehole/chain/core/set-v2';
import { toSetSpecV2Wire } from '@squarehole/box-spec';
import { starterSetLoaderV2Abi } from '../v2/chain-v2';
import { applyV2Block, type LiveStateV2 } from '../v2/views-v2';
import { readMoneyV2 } from '../v2/money-v2';
import type { SetBoxRowV2 } from '../core-row';
import type { CoreReader } from '../core-reader';
import { batchViews } from '../multicall';
import type { BlockHeader } from '../../model';
import type { RawLog } from '../../events';
import { projectSetRow } from './project';
import { decodeSetLogs,setRoute } from './events';
import { reduceSetMembers,type SetMembersState } from './members';
export interface SetStateV2 extends LiveStateV2 {readonly membership:SetMembersState;readonly set:SetBoxData['state']}
export async function applySetBlock(previous:SetStateV2|undefined,header:BlockHeader,logs:readonly RawLog[],row:SetBoxRowV2,reader:Pick<CoreReader,'callAt'>) {
  const events=decodeSetLogs(logs,setRoute(row.record,row.release)).filter(e=>e.boxId===row.boxId);
  const projection=projectSetRow(row);
  const outcome=applyV2Block(previous,header,events,projection);
  const membership=reduceSetMembers(previous?.membership,events,row.spec);
  const money=await readMoneyV2(reader,projection,outcome.state.view,header.number,header.hash);
  const state=await readSetState(reader,row,header.hash,money.values['token.totalSupply'] as string);
  if(BigInt(state.loaded)!==BigInt(membership.members.length) || BigInt(state.inside)!==membership.inside) throw new Error('set membership/read mismatch');
  return {...outcome,state:{...outcome.state,money,membership,set:state} satisfies SetStateV2};
}
export async function readSetState(reader:Pick<CoreReader,'callAt'>,row:SetBoxRowV2,hash:Hex,totalSupply:string):Promise<SetBoxData['state']> {
  reader=batchViews(reader);
  const read=async(functionName:'inside'|'escrowPrincipal'|'gateOpen'|'failed'|'seedReady')=>decodeFunctionResult({abi:setVaultV2Abi,functionName,
    data:await reader.callAt(row.contracts.vault as Address,encodeFunctionData({abi:setVaultV2Abi,functionName}),hash)});
  const [inside,escrowPrincipal,gateOpen,failed,seedReady,progress]=await Promise.all([
    read('inside'),read('escrowPrincipal'),read('gateOpen'),read('failed'),read('seedReady'),
    reader.callAt(row.contracts.starterSetLoader as Address,encodeFunctionData({abi:starterSetLoaderV2Abi,functionName:'progress'}),hash)
      .then(data=>decodeFunctionResult({abi:starterSetLoaderV2Abi,functionName:'progress',data})),
  ]);
  return {loaded:String(progress[0]),remainingHash:progress[1],inside:String(inside),escrowPrincipal:String(escrowPrincipal),totalSupply,
    gateOpen:gateOpen as boolean,failed:failed as boolean,seedReady:seedReady as boolean};
}
export function setBoxData(row:SetBoxRowV2,state:SetStateV2):SetBoxData {
  return setBoxDataSchema.parse({registry:row.registry,boxId:String(row.boxId),coordinator:row.contracts.coordinator,token:row.contracts.token,
    vault:row.contracts.vault,loader:row.contracts.starterSetLoader,creator:row.creator,collection:row.spec.collection,
    templateId:row.templateId,specHash:row.specHash,encodedSpec:row.encodedSpec,spec:toSetSpecV2Wire(row.spec),state:state.set});
}
