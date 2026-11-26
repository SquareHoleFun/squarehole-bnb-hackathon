import '../register-ts.mjs';
/** Separate local add-on manifest. No production identities or ambient endpoint fallback. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http, keccak256 } from 'viem';
const { SET_RELEASE, SET_TEMPLATE } = await import('@squarehole/box-spec');
const { parseSetManifest, setFactoryV2Abi } = await import('@squarehole/chain/core/set-v2');
import { assertLocalRpc, rpc, json } from './core-v2-local-runtime.mjs';
export function sparseSetIds() {return [0n,(1n<<256n)-1n,...Array.from({length:38},(_,i)=>BigInt(i+1)*1009n+17n)];}
export async function setManifestFromReads({chainId,factory,startBlock,block,core,pin,read}) {
  const implementations={};
  for(const [role,name] of [[0,'coordinator'],[1,'token'],[2,'hook'],[3,'vault'],[5,'receiver'],[6,'launchRouter'],[19,'starterSetLoader']]) implementations[name]=await pin(await read('implementation',[BigInt(role)],block),block);
  return parseSetManifest({schema:'squarehole.set-release/v1',network:'local',chainId,release:SET_RELEASE,templateId:SET_TEMPLATE,startBlock,
    factory:await pin(factory,block),registry:await pin(await read('registry',[],block),block),listingRegistry:await pin(await read('listingRegistry',[],block),block),
    versionCodeHash:await read('versionCodeHash',[],block),poolManager:core.chain.poolManager,platformSafe:core.chain.platformSafe,implementations},core);
}
export async function deployLocalSet(chain,localForge,core) {
  await assertLocalRpc(chain.rpcUrl);
  const startBlock=(BigInt(await rpc(chain.rpcUrl,'eth_blockNumber'))+1n).toString();
  const script='script/local/SetReleaseLocal.s.sol:SetReleaseLocal';
  // localForge resolves only after all broadcast receipts succeed. A new process observes mined immutables.
  const deployed=await localForge(chain,script,'runParts(address,address)',[chain.genesisFactory,chain.fit],chain.accounts.deployer,'set-release-parts');
  const parts=deployed.match(/LOCALSET\|parts\|(0x[0-9a-fA-F]{1920})(?![0-9a-fA-F])/u)?.[1];
  const checksLibrary=deployed.match(/LOCALSET\|checksLibrary\|(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/u)?.[1];
  if(!parts||!checksLibrary) throw new Error('local set parts did not return their addresses');
  // Fresh Forge processes can choose new library addresses. Keep the factory's embedded checks runtime identical.
  const libraries=[`src/box-v2/libraries/FactoryChecksCurve.sol:FactoryChecksCurve:${checksLibrary}`];
  const output=await localForge(chain,script,'runLocal(address,address,bytes)',[chain.genesisFactory,chain.fit,parts],chain.accounts.deployer,'set-release',undefined,libraries);
  const addresses=Object.fromEntries([...output.matchAll(/LOCALSET\|(\w+)\|(0x[0-9a-fA-F]{40})/g)].map(m=>[m[1],m[2]]));
  if(!addresses.factory||!addresses.nft) throw new Error('local set deployment did not return its addresses');
  const client=createPublicClient({transport:http(chain.rpcUrl,{retryCount:0})}),block=await client.getBlockNumber({cacheTime:0});
  const manifest=await setManifestFromReads({chainId:chain.chainId,factory:addresses.factory,startBlock,block,core,
    pin:async(address,blockNumber)=>{const code=await client.getCode({address,blockNumber});if(!code||code==='0x')throw new Error('missing set release code');return {address,codeHash:keccak256(code)};},
    read:(functionName,args,blockNumber)=>client.readContract({abi:setFactoryV2Abi,address:addresses.factory,functionName,args,blockNumber})});
  chain.setManifest=join(chain.out,`set-v2-manifest-${chain.chainId}.json`);
  chain.setRelease={...addresses,startBlock};
  writeFileSync(chain.setManifest,json(manifest));
  return manifest;
}
