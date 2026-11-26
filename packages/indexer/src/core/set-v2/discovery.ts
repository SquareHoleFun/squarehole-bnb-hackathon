import { checkSetIdentity, checkSetFactoryIdentity, type SetCoreManifest, type SetReleaseManifest } from '@squarehole/chain/core/set-v2';
import { poolIdV2 } from '../v2/discovery-v2';
import { decodeSetSpecV2 } from '@squarehole/box-spec';
import { decodeFunctionResult, encodeFunctionData, encodePacked, getContractAddress, keccak256, sliceHex, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { decodeBoxCreatedV2, decodeBoxSpecLogV2, decodeBoxTokenV2Runtime, isStandardCloneOf, rolesOfV2 } from '../v2/chain-v2';
import type { SetBoxRowV2 } from '../core-row';
import type { CoreReader } from '../core-reader';
import type { BoxVerdict } from '../discovery';
import type { RawLog } from '../../events';
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const active = [[0,'coordinator'],[1,'token'],[2,'hook'],[3,'vault'],[5,'receiver'],[6,'launchRouter'],[19,'starterSetLoader']] as const;
export async function checkSetStartup(reader:Pick<CoreReader,'callAt'|'codeAt'>,release:SetReleaseManifest,hash:Hex):Promise<void> {
  for(const pin of [release.factory,release.registry,release.listingRegistry,release.poolManager,release.platformSafe,...Object.values(release.implementations)]) {
    const code=await reader.codeAt(pin.address,hash);
    if(code==='0x'||!same(keccak256(code),pin.codeHash)) throw new Error('set release runtime differs from manifest');
  }
  await checkSetFactoryIdentity(release,async r=>decodeFunctionResult({abi:r.abi,functionName:r.functionName,
    data:await reader.callAt(r.address,encodeFunctionData({abi:r.abi,functionName:r.functionName}),hash)}));
}
/** Own discovery; set coordinators intentionally have no drand role. Transport failures propagate for retry. */
export async function checkSetBoxV2(reader:Pick<CoreReader,'codeAt'|'headerByHash'>,core:SetCoreManifest,release:SetReleaseManifest,row:SetBoxRowV2,hash:Hex):Promise<BoxVerdict> {
  const record=row.record;
  const creation=await reader.headerByHash(hash);
  if(!creation) throw new Error('set creation block unavailable');
  const role=(i:number):Address=>{const a=record.contracts[i];if(!a)throw new Error('missing set role');return a;};
  const addresses=[...record.contracts.filter(a=>a!==zeroAddress),release.factory.address,release.registry.address,release.listingRegistry.address,...Object.values(release.implementations).map(p=>p.address)];
  const codes=new Map(await Promise.all([...new Set(addresses.map(a=>a.toLowerCase() as Address))].map(async a=>[a,await reader.codeAt(a,hash)] as const)));
  const code=(a:Address)=>codes.get(a.toLowerCase() as Address)??'0x';
  const must=(ok:boolean,why:string)=>{if(!ok) throw new Error(why);};
  try {
    must(creation.number===record.creationBlock&&same(creation.hash,hash),'set creation block mismatch');
    must(same(record.poolId,poolIdV2(record.q,role(1),role(2))),'set pool key');
    const {spec}=checkSetIdentity(core,release,{registry:row.registry,creator:record.creator,templateId:record.templateId,
      specHash:record.specHash,encodedSpec:row.encodedSpec,roles:record.contracts,vaultCode:code(role(3))});
    must(same(record.randomness,zeroAddress)&&same(record.poolManager,release.poolManager.address),'set pool/randomness');
    // _initGate resolves an arrived request; _build records openAt(), not the raw immutable argument.
    const requested=BigInt(spec.openAt),resolved=requested<=creation.timestamp?creation.timestamp+1n:requested;
    must(record.pricingListingId===spec.pricing.listingId&&same(record.q,spec.pricing.token)&&record.raise===spec.raise
      &&record.openAt===resolved,'set record/spec mismatch');
    for(const pin of [release.factory,release.registry,release.listingRegistry,...Object.values(release.implementations)])
      must(code(pin.address)!=='0x'&&same(keccak256(code(pin.address)),pin.codeHash),'set implementation/release code hash');
    for(const [i,name] of active) {
      const runtime=code(role(i));
      must(same(keccak256(runtime),record.codeHashes[i]??'')&&isStandardCloneOf(runtime,release.implementations[name].address),`set ${name} clone/code hash`);
    }
    for(let i=0;i<24;i++) if(!active.some(([r])=>r===i)) must(record.codeHashes[i]===zeroHash,'absent set role hash');
    const c=role(0),v=role(3),loader=role(19);
    const loaderArgs=encodePacked(['address','address','bytes32','uint32'],[c,v,spec.setHash,spec.count]);
    must(same(sliceHex(code(loader),45),loaderArgs),'set loader 76-byte arguments');
    const args=sliceHex(code(c),45);
    must(args.length===470,'set coordinator 234-byte arguments');
    const field=(o:number,n:number)=>sliceHex(args,o,o+n);
    must(same(field(0,20),spec.pricing.token)&&BigInt(field(20,16))===spec.raise&&BigInt(field(36,16))===spec.creatorBuy
      &&same(field(68,20),record.creator)&&same(field(88,32),record.specHash)&&same(field(120,20),zeroAddress)&&same(field(140,20),zeroAddress)
      &&same(field(160,20),release.registry.address)&&same(field(180,20),release.listingRegistry.address)
      &&BigInt(field(200,4))===BigInt(spec.pricing.listingId)&&BigInt(field(204,4))===BigInt(spec.openAt)&&BigInt(field(208,2))===BigInt(spec.deadlineDays),'set coordinator arguments');
    const nonces=new Map([[1,1n],[5,2n],[6,3n],[3,4n],[19,5n]]);
    for(let i=0;i<24;i++) {const nonce=nonces.get(i)??0n;must(BigInt(field(210+i,1))===nonce,'set coordinator nonces');
      if(nonce) must(same(getContractAddress({from:c,nonce}),role(i)),'set CREATE role');}
    const token=decodeBoxTokenV2Runtime(code(role(1)),release.implementations.token.address);
    must(!!token&&same(token.holder,c)&&same(token.vault,v)&&same(token.ledger,zeroAddress)&&token.name===spec.tokenName&&token.symbol===spec.tokenSymbol,'set token arguments');
    return {classification:'shown',reason:null};
  } catch(error) {return {classification:'refused',reason:error instanceof Error?error.message:String(error)};}
}
export function rowsFromSetLogs(logs:readonly RawLog[],release:SetReleaseManifest,chainId:number):SetBoxRowV2[] {
  const own=logs.filter(l=>!l.removed&&same(l.address,release.registry.address)&&l.blockNumber>=BigInt(release.startBlock));
  const rows:SetBoxRowV2[]=[];
  for(const log of own) try {
    const {record}=decodeBoxCreatedV2(log); if(record.creationBlock!==log.blockNumber) continue;
    const specs=own.filter(l=>same(l.blockHash,log.blockHash)&&same(l.transactionHash,log.transactionHash)).flatMap(l=>{try {const s=decodeBoxSpecLogV2(l);return s.boxId===record.boxId?[s]:[];} catch{return [];}});
    if(specs.length!==1) continue;
    const encodedSpec=specs[0]?.encodedSpec; if(!encodedSpec) continue;
    const spec=decodeSetSpecV2(encodedSpec);
    rows.push({...record,...rolesOfV2(record),record,spec,encodedSpec,protocol:'set-v2',registry:release.registry.address,release,chainId,pDecimals:18,
      origin:{blockHash:log.blockHash,txHash:log.transactionHash,logIndex:log.logIndex}});
  } catch { /* No canonical creation/spec pair. */ }
  return rows;
}
