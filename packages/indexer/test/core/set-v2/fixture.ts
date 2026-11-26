import { required as present } from '../../../../chain/src/core/set-v2/test-support';
import { encodePacked, getContractAddress, keccak256, padHex, stringToHex, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { buildSetCommitment, encodeSetSpecV2 } from '@squarehole/box-spec';
import { parseSetManifest } from '@squarehole/chain/core/set-v2';
import { core as baseCore, identityInput, setManifestInput, spec as baseSpec, hash, address } from '../../../../chain/src/core/set-v2/test-support';
import { standardRuntime } from '../../../../chain/src/core/v2/clones-v2';
import { rolesOfV2, type BoxRecordV2 } from '../../../src/core/v2/chain-v2';
import type { SetBoxRowV2 } from '../../../src/core/core-row';
export const core={...baseCore,chain:{...baseCore.chain,poolManager:{...baseCore.chain.poolManager},platformSafe:{...baseCore.chain.platformSafe}}};
export {hash,address};
import { SYNTH_START_TIME } from '../core-synth';
import { poolIdV2 } from '../../../src/core/v2/discovery-v2';
export const creationTime = SYNTH_START_TIME + 51n * 12n;
export function fixture(openAt = 0) {
  const ids=[0n,(1n<<256n)-1n,...Array.from({length:38},(_,i)=>BigInt(i*101+7))];
  const spec={...baseSpec,openAt,...buildSetCommitment(baseSpec.collection,ids).commitment};
  const input={...setManifestInput(),poolManager:core.chain.poolManager,platformSafe:core.chain.platformSafe}; const codes=new Map<string,Hex>();
  for(const [i,pin] of [input.factory,input.registry,input.listingRegistry,input.poolManager,input.platformSafe,...Object.values(input.implementations)].entries()) {
    const code=`0x60${i.toString(16).padStart(2,'0')}` as Hex; codes.set(pin.address.toLowerCase(),code);
    pin.codeHash=keccak256(code);
  }
  const release=parseSetManifest(input,core), roles=[...identityInput().roles], creator=identityInput().creator;
  const coordinator=present(roles[0]);
  const nonces=new Uint8Array(24);
  for(const [role,nonce] of [[1,1],[5,2],[6,3],[3,4],[19,5]] as const){roles[role]=getContractAddress({from:coordinator,nonce:BigInt(nonce)});nonces[role]=nonce;}
  const encodedSpec=encodeSetSpecV2(spec),specHash=keccak256(encodedSpec);
  const code=(role:number,impl:keyof typeof release.implementations,args:Hex='0x')=>codes.set(present(roles[role]).toLowerCase(),standardRuntime(release.implementations[impl].address,args));
  code(0,'coordinator',encodePacked(['address','uint128','uint128','uint128','address','bytes32','address','address','address','address','uint32','uint32','uint16','bytes24'],
    [spec.pricing.token,spec.raise,spec.creatorBuy,1n,creator,specHash,zeroAddress,zeroAddress,release.registry.address,release.listingRegistry.address,0,spec.openAt,30,`0x${Array.from(nonces).map(b=>b.toString(16).padStart(2,'0')).join('')}`]));
  code(1,'token',encodePacked(['address','address','address','uint256','bytes32','uint8','bytes11','uint8'],[coordinator,present(roles[3]),zeroAddress,1000000n,padHex(stringToHex(spec.tokenName),{size:32,dir:'right'}),spec.tokenName.length,padHex(stringToHex(spec.tokenSymbol),{size:11,dir:'right'}),spec.tokenSymbol.length]));
  code(2,'hook'); code(5,'receiver');code(6,'launchRouter');
  code(3,'vault',encodePacked(['address','address','address','address','address','uint32','bytes32','uint16'],[coordinator,present(roles[1]),present(roles[19]),creator,spec.collection,spec.count,spec.setHash,spec.pickFeeBps]));
  code(19,'starterSetLoader',encodePacked(['address','address','bytes32','uint32'],[coordinator,present(roles[3]),spec.setHash,spec.count]));
  const record:BoxRecordV2={boxId:0n,templateId:release.templateId,specHash,creator,pricingListingId:0,q:zeroAddress,raise:spec.raise,
    poolManager:release.poolManager.address,poolId:poolIdV2(spec.pricing.token,present(roles[1]),present(roles[2])),creationBlock:51n,openAt:BigInt(openAt)<=creationTime?creationTime+1n:BigInt(openAt),randomness:zeroAddress,
    contracts:roles,codeHashes:roles.map(a=>a===zeroAddress?zeroHash:keccak256(present(codes.get(a.toLowerCase()))))};
  const row:SetBoxRowV2={...record,...rolesOfV2(record),record,spec,release,protocol:'set-v2',chainId:core.chainId,registry:release.registry.address,encodedSpec,pDecimals:18,origin:{blockHash:hash('block'),txHash:hash('tx'),logIndex:0}};
  return {row,codes,ids,reader:{headerByHash:async(h:Hex)=>({number:51n,hash:h,parentHash:hash('parent'),timestamp:creationTime}),codeAt:async(a:Address)=>codes.get(a.toLowerCase())??'0x' as Hex}};
}
