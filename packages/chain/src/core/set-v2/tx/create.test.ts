import { expect,it } from 'vitest';
import { decodeFunctionData,getAddress,erc20Abi,zeroAddress,toHex } from 'viem';
import { setCreateCalls,assertSendableSetCreate,estimateSetCreateGas } from './index';
import { spec,address } from '../test-support';
import { setFactoryV2Abi } from '../abi-set-v2';
import { submitSetCreateWrite } from '../../../write/executor';
import { TEST_FEE_READER } from '../../../write/test-support/index';
it('E08B-CREATE exact P approval and factory calldata, native value, capped estimation and dedicated executor guard',async()=>{
  const base={chainId:31337,factory:address('factory'),creator:address('creator'),spec,cs:toHex(0n,{size:32}),hs:toHex(1n,{size:32}),bootstrapQ:1500n};
  const native=setCreateCalls(base);expect(native).toHaveLength(1);expect(native[0]?.value).toBe(1500n);
  const listed={...base,spec:{...spec,pricing:{listingId:1,token:address('P')},creatorBuy:13n}};
  const [approve,create]=setCreateCalls(listed);expect(approve&&decodeFunctionData({abi:erc20Abi,data:approve.data}).args).toEqual([getAddress(base.factory),1513n]);
  expect(create?.value).toBe(0n);expect(create&&decodeFunctionData({abi:setFactoryV2Abi,data:create.data}).functionName).toBe('createBox');
  for(const call of setCreateCalls(listed)) {
    expect(()=>assertSendableSetCreate(call,listed,base.creator)).not.toThrow();
    for(const bad of [{...call,value:call.value+1n},{...call,to:address('other')},{...call,data:`${call.data}00` as const}])expect(()=>assertSendableSetCreate(bad,listed,base.creator)).toThrow();
  }
  if(!create)throw new Error('missing');
  expect((await estimateSetCreateGas(async()=>9_003_499n,{...create,account:base.creator},30_000_000n)).gasLimit).toBe(10_804_199n);
  await expect(estimateSetCreateGas(async()=>14_535_045n,{...create,account:base.creator},30_000_000n)).rejects.toThrow(/ceiling/);
  let sends=0;
  await submitSetCreateWrite({ feeReader: TEST_FEE_READER,plan:listed,call:create,from:base.creator,gasLimit:10_804_199n,wallet:async({method})=>{
    if(method==='eth_chainId')return '0x7a69';if(method==='eth_accounts')return [base.creator];sends++;return toHex(1n,{size:32});}});
  expect(sends).toBe(1);
  expect(()=>setCreateCalls({...base,factory:zeroAddress})).toThrow();
});
