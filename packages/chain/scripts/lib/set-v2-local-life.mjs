import '../register-ts.mjs';
/** Local E08B lifecycle. Every transaction is estimated, bounded, mined, then independently indexed. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, encodeFunctionData, erc20Abi, http, keccak256, toHex, zeroAddress } from 'viem';
const { SET_FORMAT, SET_SCHEMA, SET_RELEASE, createSetListFile } = await import('@squarehole/box-spec');
const { setFactoryV2Abi, setVaultV2Abi } = await import('@squarehole/chain/core/set-v2');
const { findSetCreateSalts, setCreateCalls, estimateSetCreateGas, readSetLoadPlan, creatorApproval, prepareSetConversion, estimateWithBackoff, setClaimCalls, assertSendableSetCallV2 } = await import('../../src/core/set-v2/tx/index.ts');
const { coordinatorV2Abi, hookV2Abi, registryV2Abi, starterSetLoaderV2Abi, listingRegistryV2Abi } = await import('../../src/core/v2/abi-v2.ts');
const { createChainReader } = await import('../../src/write/rpc.ts');
const { CoreChainIndexer } = await import('../../../indexer/src/core/chain-indexer.ts');
const { RpcCoreReader } = await import('../../../indexer/src/core/core-reader.ts');
import { artifact } from './core-v2-local-manifest.mjs';
import { assertLocalRpc, rpc, waitLocalReceipt, mineTo, json } from './core-v2-local-runtime.mjs';
import { sparseSetIds } from './set-v2-local.mjs';
import { afterSetWindow, prepareFundedSetPick } from './set-v2-local-actions.mjs';

export async function runSetLocalLife(chain, { recipe, callLocal }) {
  await assertLocalRpc(chain.rpcUrl);
  const client=createPublicClient({transport:http(chain.rpcUrl,{retryCount:0})});
  const release=JSON.parse(readFileSync(chain.setManifest,'utf8')),core=JSON.parse(readFileSync(chain.manifest,'utf8'));
  const read=(address,abi,functionName,args=[],blockNumber)=>client.readContract({address,abi,functionName,args,...(blockNumber===undefined?{}:{blockNumber})});
  const actor=chain.accounts.actor,collection=chain.setRelease.nft,factory=chain.setRelease.factory;
  const nftAbi=artifact('SetLocalERC721',{sourceFile:'SetReleaseLocal.s.sol'}).abi;
  const reader=createChainReader(async({method,params})=>rpc(chain.rpcUrl,method,params));
  const indexReader=new RpcCoreReader({urls:[chain.rpcUrl]});
  const indexer=new CoreChainIndexer({manifest:core,setManifest:release,reader:indexReader});
  await indexer.start();
  const snapshots=[];
  const transact=async(call,from=actor,gasLimit)=>{
    await assertLocalRpc(chain.rpcUrl);
    gasLimit??=(await client.estimateGas({account:from,...call})*6n+4n)/5n;
    if(gasLimit<=0n||gasLimit>16_777_216n)throw new Error('local set gas cap');
    const hash=await rpc(chain.rpcUrl,'eth_sendTransaction',[{from,to:call.to,data:call.data,value:toHex(call.value??0n),gas:toHex(gasLimit)}]);
    return waitLocalReceipt(chain.rpcUrl,hash);
  };
  const send=async(address,abi,functionName,args=[],from=actor)=>transact({to:address,data:encodeFunctionData({abi,functionName,args}),value:0n},from);
  const checkpoint=async(label,box,expected={})=>{
    const header=await indexReader.latestHeader();await indexer.enqueue(header);await indexer.idle();
    if(indexer.head()?.hash!==header.hash||indexer.metrics.lastError)throw new Error(`set index checkpoint ${label}: ${indexer.metrics.lastError}`);
    const view=indexer.setBoxView(box.token);if(!view)throw new Error(`set missing at ${label}`);
    const at=header.number;
    const [loaded,remainingHash,notified]=await read(box.loader,starterSetLoaderV2Abi,'progress',[],at);
    for(const [key,actual] of Object.entries({loaded:String(loaded),remainingHash,
      inside:String(await read(box.vault,setVaultV2Abi,'inside',[],at)),escrowPrincipal:String(await read(box.vault,setVaultV2Abi,'escrowPrincipal',[],at)),
      totalSupply:String(await read(box.token,erc20Abi,'totalSupply',[],at)),gateOpen:await read(box.vault,setVaultV2Abi,'gateOpen',[],at),failed:await read(box.vault,setVaultV2Abi,'failed',[],at),seedReady:await read(box.vault,setVaultV2Abi,'seedReady',[],at)})) {
      if(view.box.state[key]!==actual)throw new Error(`set ${label} ${key} differs from chain`);
    }
    for(const [key,value] of Object.entries(expected)) {
      if(view.box.state[key]!==value)throw new Error(`set ${label} did not reach expected ${key}`);
    }
    const members=indexer.setMembersView(box.token);
    if(members?.members.length!==loaded)throw new Error(`set ${label} member count differs`);
    for(const member of members.members) {
      const id=BigInt(member.id);
      const [recorded,eligible,outside,owner]=await Promise.all([
        read(box.vault,setVaultV2Abi,'memberAt',[BigInt(member.index)],at),
        read(box.vault,setVaultV2Abi,'eligible',[id],at),read(box.vault,setVaultV2Abi,'isOutside',[id],at),
        read(collection,nftAbi,'ownerOf',[id],at),
      ]);
      const inside=member.state==='Inside'||member.state==='Deferred';
      if(recorded!==id||!eligible||outside!==(member.state==='Outside')
        ||owner.toLowerCase()!==(inside?box.vault:actor).toLowerCase())throw new Error(`set ${label} member ${member.id} differs`);
    }
    if(label==='recovered-31-deferred-1'&&(members.members.filter(m=>m.state==='Deferred').length!==1
      ||members.members.filter(m=>m.state==='Released').length!==31))throw new Error('set recovery did not defer exactly one item');
    const money=indexer.setMoneyView(box.token);
    const [pot,tLeft]=await read(box.coordinator,coordinatorV2Abi,'claimState',[],at);
    if(money?.money?.claim.pot!==String(pot)||money.money.claim.tLeft!==String(tLeft))throw new Error('set claim state differs');
    const graduated=await read(box.coordinator,coordinatorV2Abi,'graduated',[],at);
    const closed=await read(box.hook,hookV2Abi,'closed',[],at);
    if(money.graduated!==graduated)throw new Error('set graduation view differs');
    if(label==='filled'&&!closed)throw new Error('set curve did not fill');
    if(label==='graduated'&&!graduated)throw new Error('set did not graduate');
    if(label==='claimed'&&await read(box.token,erc20Abi,'balanceOf',[actor],at)!==0n)throw new Error('set holder claim incomplete');
    snapshots.push({label,box:view,members,money,chain:{block:String(at),hash:header.hash,notified,closed,graduated,
      claimPot:String(pot),claimTLeft:String(tLeft)}});
    writeFileSync(join(chain.out,'set-v2-checkpoints.json'),json(snapshots));
  };
  async function create(ids,name) {
    await send(collection,nftAbi,'mintBatch',[actor,ids],chain.accounts.deployer);
    const list=createSetListFile(collection,ids),block=await client.getBlock(),raise=(await read(release.listingRegistry.address,listingRegistryV2Abi,'listing',[0],block.number)).raise;
    const spec={format:SET_FORMAT,schema:SET_SCHEMA,release:SET_RELEASE,tokenName:name,tokenSymbol:'LSET',pricing:{listingId:0,token:zeroAddress},raise,
      openAt:0,deadlineDays:30,creatorBuy:raise/100n,collection,count:40,setHash:list.setHash,pickFeeBps:500,description:'Local committed sparse NFTs',logoSha256:keccak256(toHex(name))};
    const salts=await findSetCreateSalts({priceToken:zeroAddress,tokenAddressLimit:await read(factory,setFactoryV2Abi,'tokenAddressLimit',[zeroAddress],block.number),
      predictBox:cs=>read(factory,setFactoryV2Abi,'predictBox',[actor,spec,cs],block.number)});
    const {bootstrapQ}=await read(factory,setFactoryV2Abi,'boxQParameters',[0,raise],block.number);
    for(const call of setCreateCalls({chainId:chain.chainId,factory,creator:actor,spec,...salts,bootstrapQ})) {
      const gas=await estimateSetCreateGas(req=>client.estimateGas(req),{...call,account:actor},block.gasLimit);await transact(call,actor,gas.gasLimit);
    }
    const coordinator=salts.coordinator,token=salts.token,vault=await read(coordinator,coordinatorV2Abi,'vault'),loader=await read(coordinator,coordinatorV2Abi,'starterSetLoader');
    const boxId=await read(coordinator,coordinatorV2Abi,'boxId');
    const record=await read(release.registry.address,registryV2Abi,'recordOf',[boxId]);
    const target={chainId:chain.chainId,core,release,identity:{registry:release.registry.address,templateId:record.templateId,specHash:record.specHash,
      encodedSpec:(await import('@squarehole/box-spec')).encodeSetSpecV2(spec),creator:actor,roles:record.contracts,vaultCode:await client.getCode({address:vault})}};
    const box={coordinator,token,vault,loader,hook:record.contracts[2],ids,list,target};await checkpoint(`${name}-created`,box,{loaded:'0',inside:'0',gateOpen:false});
    await transact(creatorApproval(target,actor,true));return box;
  }
  async function loadNext(box) {
    const plan=await readSetLoadPlan(reader,box.target,box.list);
    if(!plan.pages.length)return false;
    const batch=await estimateWithBackoff(plan.pages[0].page.ids.length,async size=>(await readSetLoadPlan(reader,box.target,box.list,size)).pages[0].call,
      call=>client.estimateGas({account:actor,...call}));
    await transact(batch.call,actor,batch.gasLimit);return true;
  }
  const ordinaryRecipe=(box,action)=>afterSetWindow({
    effectiveOpenAt:()=>read(box.coordinator,coordinatorV2Abi,'effectiveOpenAt'),
    windowSeconds:()=>read(box.hook,hookV2Abi,'WINDOW_SECONDS'),
    mineTo:at=>mineTo(chain.rpcUrl,at),recipe:()=>recipe(chain,action,box.coordinator),
  });
  try {
    const box=await create(sparseSetIds(),'Local Set');
    await loadNext(box);await checkpoint('load-16-stop',box);
    // Discard all local progress. Each new plan resumes from loader.progress().
    while(await loadNext(box))await checkpoint('resume-page',box);
    await checkpoint('loaded',box,{loaded:'40',inside:'40'});
    await send(box.loader,starterSetLoaderV2Abi,'complete');await transact(creatorApproval(box.target,actor,false));await checkpoint('completed',box,{loaded:'40',inside:'40',seedReady:true});
    await ordinaryRecipe(box,2);await checkpoint('filled',box);
    await callLocal(chain,'BoxCoordinatorV2',box.coordinator,'graduate',[],chain.accounts.keeper);await checkpoint('graduated',box,{gateOpen:true});
    for(const [kind,ids] of [['pick',box.ids.slice(0,32)],['return',box.ids.slice(0,16)]]) {
      const prepare=()=>prepareSetConversion(reader,box.target,actor,kind,ids,100n,3600n);
      const prepared=kind==='pick'?await prepareFundedSetPick({prepare,
        balance:at=>read(box.token,erc20Abi,'balanceOf',[actor],at),
        buy:async()=>{
          // Local native-P set: the actor pays real P; only the actual pool can supply the extra T.
          const key=await read(box.hook,hookV2Abi,'poolKey');
          if(key.currency0!==zeroAddress)throw new Error('local set pick funding requires native P');
          const amount=(await read(box.coordinator,coordinatorV2Abi,'raise'))/4n;
          await transact({to:chain.swapper,data:encodeFunctionData({abi:artifact('PriceLimitSwapper',{sourceFile:'HookGasKit.sol'}).abi,
            functionName:'swap',args:[key,true,-amount,0n]}),value:amount});
        },
      }):await prepare();
      for(const approval of prepared.approvals)await transact(approval);
      await transact(prepared.call);await checkpoint(kind==='pick'?'picked':'returned',box,{inside:kind==='pick'?'8':'24'});
    }
    const failure=await create(Array.from({length:40},(_,i)=>BigInt(i+1)*100003n),'Local Set Failure');
    while(await loadNext(failure)) { /* One mined loading page per new chain progress read. */ }
    await checkpoint('failure-loaded',failure,{loaded:'40',inside:'40'});
    await send(failure.loader,starterSetLoaderV2Abi,'complete');await transact(creatorApproval(failure.target,actor,false));
    await checkpoint('failure-completed',failure,{seedReady:true});
    const beforeFunding=await read(failure.token,erc20Abi,'balanceOf',[actor]);
    await ordinaryRecipe(failure,1);
    if(await read(failure.token,erc20Abi,'balanceOf',[actor])<=beforeFunding)throw new Error('set failure box was not funded');await checkpoint('failure-funded',failure);
    await mineTo(chain.rpcUrl,await read(failure.coordinator,coordinatorV2Abi,'deadline'));
    await send(failure.coordinator,coordinatorV2Abi,'fail',[],chain.accounts.keeper);await checkpoint('failed',failure,{failed:true});
    await send(collection,nftAbi,'setBlocked',[failure.ids[0],true],chain.accounts.deployer);
    await send(failure.vault,setVaultV2Abi,'releaseToCreator',[failure.ids.slice(0,32)],chain.accounts.keeper);await checkpoint('recovered-31-deferred-1',failure,{inside:'9'});
    await send(collection,nftAbi,'setBlocked',[failure.ids[0],false],chain.accounts.deployer);
    await send(failure.vault,setVaultV2Abi,'releaseToCreator',[[failure.ids[0]]],chain.accounts.keeper);await checkpoint('deferred-retried',failure,{inside:'8'});
    const claimT=await read(failure.token,erc20Abi,'balanceOf',[actor]);
    const claim=setClaimCalls(failure.target,actor,claimT);
    for(const call of [claim.approval,claim.call]) {
      assertSendableSetCallV2(call,claim.target,actor);
      await transact(call);
    }
    if(await read(failure.token,erc20Abi,'allowance',[actor,failure.coordinator])!==0n)throw new Error('local claim allowance remains');
    await checkpoint('claimed',failure);
    chain.setBoxes={live:box.coordinator,failure:failure.coordinator};
  } finally { indexer.stop(); }
}
