import { expect,it } from 'vitest';
import { decodeFunctionData,encodeFunctionResult } from 'viem';
import { setFactoryV2Abi } from '@squarehole/chain/core/set-v2';
import { checkSetStartup } from '../../../src/core/set-v2/discovery';
import { loadCoreConfig } from '../../../src/core/core-config';
import { CoreChainIndexer } from '../../../src/core/chain-indexer';
import { World } from '../core-synth';
import { serviceBoxV2,serviceChainV2,boxLogsV2,listingAddedLog,serviceListingV2 } from '../scripted-core-chain';
import {fixture,core,hash} from './fixture';
it('E08B-STARTUP optional file leaves core unchanged and all factory identities are checked at one block',async()=>{
  const {row,reader}=fixture();
  const env={SH_CORE_MANIFEST:'core.json',SH_CORE_HTTP_URLS:'http://127.0.0.1:5399'};
  const calls:string[]=[];
  const read=(path:string)=>{calls.push(path);return JSON.stringify(path==='core.json'?core:row.release);};
  const absent=loadCoreConfig(env,read);expect(absent.setManifest).toBeUndefined();expect(calls).toEqual(['core.json']);
  const present=loadCoreConfig({...env,SH_SET_MANIFEST:'set.json'},read);expect(present.manifest).toEqual(absent.manifest);expect(present.setManifest?.registry).toEqual(row.release.registry);
  let wrong='';const seen:string[]=[];
  const startup={...reader,callAt:async(to:`0x${string}`,data:`0x${string}`,block:`0x${string}`)=>{
    expect(to).toBe(row.release.factory.address);expect(block).toBe(hash('pinned'));
    const {functionName}=decodeFunctionData({abi:setFactoryV2Abi,data});seen.push(functionName);
    return encodeFunctionResult({abi:setFactoryV2Abi,functionName,result:functionName===wrong?hash('wrong'):({versionCodeHash:row.release.versionCodeHash,RELEASE:row.release.release,TEMPLATE:row.release.templateId} as Record<string,unknown>)[functionName]} as never);
  }};
  await checkSetStartup(startup,row.release,hash('pinned'));expect(seen.sort()).toEqual(['RELEASE','TEMPLATE','versionCodeHash']);
  for(wrong of ['versionCodeHash','RELEASE','TEMPLATE'])await expect(checkSetStartup(startup,row.release,hash('pinned'))).rejects.toThrow(/mismatch/);
});
it('E08B-GOLDEN a populated old v2 feed is byte-for-byte unchanged when the add-on manifest is present',async()=>{
  const {row,codes}=fixture();const box=serviceBoxV2();const world=new World('set-golden');world.block(10n);
  world.block(99n,[listingAddedLog(serviceListingV2())]);world.block(100n,[boxLogsV2(box)]);world.to(102n);
  const reader=serviceChainV2(world,[box]),oldCode=reader.codeAt.bind(reader),oldCall=reader.callAt.bind(reader);
  reader.codeAt=async(a,h)=>codes.get(a.toLowerCase())??oldCode(a,h);
  reader.callAt=async(a,d,h)=>{
    if(a.toLowerCase()!==row.release.factory.address)return oldCall(a,d,h);
    const {functionName}=decodeFunctionData({abi:setFactoryV2Abi,data:d});
    return encodeFunctionResult({abi:setFactoryV2Abi,functionName,result:({versionCodeHash:row.release.versionCodeHash,RELEASE:row.release.release,TEMPLATE:row.release.templateId} as Record<string,unknown>)[functionName]} as never);
  };
  const absent=new CoreChainIndexer({reader,manifest:core}),present=new CoreChainIndexer({reader,manifest:core,setManifest:row.release});
  await absent.start();await present.start();
  expect(absent.metrics.lastError).toBeNull();expect(present.metrics.lastError).toBeNull();
  expect(present.v2FeedView().cards).toHaveLength(1);expect(present.v2FeedView()).toEqual(absent.v2FeedView());
  const feed = present.v2FeedView();
  const cards = feed.cards.map(({ vaultItems, ...legacyCard }) => {
    // SH-235 is additive; the saved snapshot still pins every old field.
    expect(vaultItems).toEqual({ firstId: '1', n: '100', known: [], owners: {} });
    return legacyCard;
  });
  expect({ ...feed, cards }).toMatchSnapshot();absent.stop();present.stop();
});
