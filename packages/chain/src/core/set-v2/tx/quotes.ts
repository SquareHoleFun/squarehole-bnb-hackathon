import { quoteSetPick, quoteSetReturn, maxIn, minOut, deadlineFrom } from '@squarehole/box-spec';
import { decodeFunctionResult, erc20Abi, erc721Abi, type Abi, type Address } from 'viem';
import type { ChainReader } from '../../../write/rpc';
import { setVaultV2Abi } from '../abi-set-v2';
import { checkSetIdentity } from '../route-set-v2';
import { starterSetLoaderV2Abi } from '../../v2/abi-v2';
import { assertSendableSetCallV2, setCall, type SetTargetV2 } from './calls';
import { setLoadPlan } from './load';

/** All reads use a single block number; a changed canonical hash refuses publication. */
export async function prepareSetConversion(reader: ChainReader, target: SetTargetV2, from: Address, kind: 'pick'|'return', ids: readonly bigint[], slippageBps: bigint, seconds: bigint) {
  if (await reader.chainId() !== target.chainId) throw new Error('set quote chain mismatch');
  const {spec,vault,collection} = checkSetIdentity(target.core,target.release,target.identity);
  const token = target.identity.roles[1] as Address;
  const blockNumber = await reader.blockNumber();
  const block = await reader.getBlock(blockNumber);
  if (!block) throw new Error('quote block unavailable');
  const read = async (to: Address, abi: Abi, fn: string, args: readonly unknown[] = []) => decodeFunctionResult({abi,functionName:fn,
    data:await reader.call(setCall(to,abi,fn,args),blockNumber)});
  const [supply,escrow,inside,principal] = await Promise.all([
    read(token,erc20Abi,'totalSupply'), read(vault,setVaultV2Abi,'escrowPrincipal'), read(vault,setVaultV2Abi,'inside'),
    read(vault,setVaultV2Abi,kind==='pick'?'quoteWithdraw':'quoteReturn',[BigInt(ids.length)]),
  ]) as [bigint,bigint,bigint,bigint];
  const snapshot = {supply,escrow,inside,count:BigInt(spec.count)};
  const quote = kind === 'pick' ? quoteSetPick(snapshot,BigInt(ids.length),BigInt(spec.pickFeeBps)) : quoteSetReturn(snapshot,BigInt(ids.length));
  if (principal !== quote.principal) throw new Error('set quote differential mismatch');
  const limit = 'tokenIn' in quote ? maxIn(quote.tokenIn,slippageBps) : minOut(quote.tokenOut,slippageBps);
  const deadline = deadlineFrom(block.timestamp,seconds);
  const scoped = kind === 'pick' ? {...target,tokenApproval:limit} : target;
  const call = setCall(vault,setVaultV2Abi,kind==='pick'?'withdrawBatch':'returnItems',[ids,limit,deadline]);
  const approvals = kind==='pick' ? [setCall(token,erc20Abi,'approve',[vault,limit])]
    : ids.map(id=>setCall(collection,erc721Abi,'approve',[vault,id]));
  for (const c of [...approvals,call]) assertSendableSetCallV2(c,scoped,from);
  if ((await reader.getBlock(blockNumber))?.hash !== block.hash) throw new Error('quote block changed');
  return {blockNumber,blockHash:block.hash,snapshot,quote,limit,deadline,target:scoped,approvals,call};
}
export async function readSetLoadPlan(reader: ChainReader, target: SetTargetV2, list: unknown, batchSize?: number) {
  if (await reader.chainId() !== target.chainId) throw new Error('set loader chain mismatch');
  const {spec} = checkSetIdentity(target.core,target.release,target.identity);
  const loader = target.identity.roles[19] as Address;
  const block = await reader.blockNumber();
  return setLoadPlan({loader,commitment:{collection:spec.collection,count:spec.count,setHash:spec.setHash},list,
    ...(batchSize === undefined ? {} : {batchSize}), progress: async () => decodeFunctionResult({abi:starterSetLoaderV2Abi,functionName:'progress',
      data:await reader.call(setCall(loader,starterSetLoaderV2Abi,'progress'),block)})});
}
