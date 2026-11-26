import { encodeAbiParameters, zeroAddress, zeroHash } from 'viem';
import type { SetSpecV2 } from '@squarehole/box-spec';
import type { BoxSpecV2 } from '../v2/chain-v2';
import type { BoxRowV2, SetBoxRowV2 } from '../core-row';
/** Exact encoding projection of SetFactoryV2Planner.project. Never used for discovery or old-spec validation. */
export function projectSetSpec(s: SetSpecV2): BoxSpecV2 {
  const empty = {leg:0,dest:0,legParams:'0x' as const,destParams:'0x' as const};
  const side = {split:1,splitParams:'0x' as const,a:{...empty,leg:1,dest:4},b:empty};
  return {format:2,version:2,boxType:2,tokenName:s.tokenName,tokenSymbol:s.tokenSymbol,description:s.description,
    coverSha256:s.logoSha256,n:s.count,pricing:s.pricing,raise:s.raise,openAt:s.openAt,deadlineDays:s.deadlineDays,
    creatorBuy:s.creatorBuy,pickFeeBps:s.pickFeeBps,layout:1,gradLayout:3,launchFormat:1,buyers:side,sellers:side,
    addOns:[{id:8,params:encodeAbiParameters([{type:'bytes32'},{type:'uint32'}],[s.setHash,s.count])}],
    collectionName:'',collectionSymbol:'',firstId:0n,artMode:0,revealRoot:zeroHash,metadataTable:'0x',generatorHash:zeroHash,
    revealListId:zeroHash,marketplaceOwner:zeroAddress,creatorFeeRecipient:zeroAddress,collectionCoverSha256:zeroHash,contentsParams:'0x'};
}
/** Internal view-only projection. It never enters boxesV2, the v2 feed, discovery or persistence. */
export function projectSetRow(row: SetBoxRowV2): BoxRowV2 {
  // Existing money/event projection consumes only these release addresses and Safe destinations.
  const release = {...row.release,safes:{platform:row.release.platformSafe}} as unknown as BoxRowV2['release'];
  return {...row,protocol:2,spec:projectSetSpec(row.spec),release,marks:[]};
}
