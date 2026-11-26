import { ROLE_V2_NAMES } from '@squarehole/chain';
import { setVaultV2Abi, type SetReleaseManifest } from '@squarehole/chain/core/set-v2';
import { decodeEventLog, toEventSelector, zeroAddress, type Abi, type Hex } from 'viem';
import { EVENT_ABI_V2, type BoxRecordV2 } from '../v2/chain-v2';
import { decodeV2Log, type CoreEventV2, type RouteV2 } from '../v2/events-v2';
import type { RawLog } from '../../events';
/** SetVault GateOpened()/FailureEntered() have different selectors; never change the frozen v2 map. */
export const SET_EVENT_ABI = {...EVENT_ABI_V2,vault:setVaultV2Abi.filter(e=>e.type==='event')};
export const SET_TOPICS = SET_EVENT_ABI.vault.map(e=>toEventSelector(e));
export function setRoute(record: BoxRecordV2, release: SetReleaseManifest): RouteV2 {
  const parts = new Map<string,{boxId:bigint;role:typeof ROLE_V2_NAMES[number]}>();
  record.contracts.forEach((a,i)=>{const role=ROLE_V2_NAMES[i]; if(a!==zeroAddress && role) parts.set(a.toLowerCase(),{boxId:record.boxId,role});});
  return {parts,pools:new Map([[record.poolId.toLowerCase(),record.boxId]]),modules:new Set(),registry:release.registry.address,
    listingRegistry:release.listingRegistry.address,poolManager:release.poolManager.address,randomness:zeroAddress};
}
export function decodeSetLogs(logs: readonly RawLog[], route: RouteV2): CoreEventV2[] {
  const seen=new Set<string>(); const out:CoreEventV2[]=[];
  for(const log of [...logs].sort((a,b)=>a.blockNumber===b.blockNumber?a.logIndex-b.logIndex:a.blockNumber<b.blockNumber?-1:1)) {
    const key=`${log.blockHash.toLowerCase()}:${log.logIndex}`;
    if(log.removed || seen.has(key)) continue; seen.add(key);
    const part=route.parts.get(log.address.toLowerCase());
    if(part?.role!=='vault') {const e=decodeV2Log(log,route); if(e) out.push(e); continue;}
    try {
      const e=decodeEventLog({abi:SET_EVENT_ABI.vault as Abi,topics:log.topics as [Hex,...Hex[]],data:log.data,strict:true});
      if(!e.eventName) continue;
      out.push({source:'vault',name:e.eventName,args:(e.args??{}) as Record<string,unknown>,address:log.address,boxId:part.boxId,listingId:null,
        ref:{blockNumber:log.blockNumber,blockHash:log.blockHash,txHash:log.transactionHash,txIndex:log.transactionIndex,logIndex:log.logIndex}});
    } catch { /* A different selector never contributes set state. */ }
  }
  return out;
}
