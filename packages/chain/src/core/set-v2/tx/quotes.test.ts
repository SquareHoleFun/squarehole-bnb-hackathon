import { required as present } from '../test-support';
import { expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, erc721Abi, getAddress } from 'viem';
import { core, identityInput, setManifestInput, hash, required } from '../test-support';
import { parseSetManifest, setVaultV2Abi } from '../index';
import { prepareSetConversion } from './quotes';
import type { ChainReader } from '../../../write/rpc';
const target = {chainId:core.chainId,core,release:parseSetManifest(setManifestInput(),core),identity:identityInput()};
it('E08B-QUOTE pins all reads and applies fee-inclusive limits/deadlines, refusing an on-chain differential', async () => {
  const reads: unknown[] = []; let wrong = false;
  const reader = {
    chainId: async () => target.chainId,
    blockNumber: async () => 51n,
    getBlock: async () => ({number:51n,hash:hash('block'),timestamp:100n}),
    call: async (req: {to: string;data: `0x${string}`}, block: unknown) => {
      reads.push(block);
      if(req.to === target.identity.roles[1]) return `0x${(10000n).toString(16).padStart(64,'0')}`;
      const {functionName} = decodeFunctionData({abi:setVaultV2Abi,data:req.data});
      const result = ({inside:10n,escrowPrincipal:0n,quoteWithdraw:wrong?999n:1000n} as Record<string,bigint>)[functionName];
      return encodeFunctionResult({abi:setVaultV2Abi,functionName,result} as never);
    },
  } as unknown as ChainReader;
  const result = await prepareSetConversion(reader,target,target.identity.creator,'pick',[0n],100n,60n);
  expect(reads).toEqual([51n,51n,51n,51n]);
  expect(decodeFunctionData({abi:setVaultV2Abi,data:result.call.data}).args).toEqual([[0n],1061n,160n]);
  expect(result.approvals).toHaveLength(1);
  expect(result.target.tokenApproval).toBe(1061n);
  wrong = true;
  await expect(prepareSetConversion(reader,target,target.identity.creator,'pick',[0n],0n,60n)).rejects.toThrow(/differential/);
  expect(required(result.approvals[0]).to).toBe(target.identity.roles[1]);
});

it('E08B-QUOTE returns with per-id approvals, minOut and deadline, and refuses a changed canonical block', async () => {
  let changed=false,headers=0; const reads:unknown[]=[];
  const reader={chainId:async()=>target.chainId,blockNumber:async()=>51n,
    getBlock:async()=>({number:51n,hash:changed&&++headers%2===0?hash('replacement'):hash('block'),timestamp:100n}),
    call:async(req:{to:string;data:`0x${string}`},block:unknown)=>{
      reads.push(block);
      if(req.to===target.identity.roles[1]) return `0x${(10000n).toString(16).padStart(64,'0')}`;
      const {functionName}=decodeFunctionData({abi:setVaultV2Abi,data:req.data});
      return encodeFunctionResult({abi:setVaultV2Abi,functionName,result:({inside:8n,escrowPrincipal:2000n,quoteReturn:2000n} as Record<string,bigint>)[functionName]} as never);
    }} as unknown as ChainReader;
  const ids=[0n,(1n<<256n)-1n];
  const result=await prepareSetConversion(reader,target,target.identity.creator,'return',ids,100n,60n);
  expect(reads).toEqual([51n,51n,51n,51n]);
  expect(decodeFunctionData({abi:setVaultV2Abi,data:result.call.data}).args).toEqual([ids,1881n,160n]);
  expect(result.approvals.map(a=>decodeFunctionData({abi:erc721Abi,data:a.data}).args)).toEqual(ids.map(id=>[getAddress(present(target.identity.roles[3])),id]));
  changed=true;
  await expect(prepareSetConversion(reader,target,target.identity.creator,'return',ids,100n,60n)).rejects.toThrow(/block changed/);
});
