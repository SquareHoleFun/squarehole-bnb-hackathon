import { decodeFunctionResult, type Abi, type Address } from 'viem';
import type { ChainReader } from '../../../write/rpc';
import { coordinatorV2Abi, hookV2Abi } from '../../v2/abi-v2';
import { checkSetIdentity } from '../route-set-v2';
import { assertSendableSetCallV2, setCall, type SetTargetV2 } from './calls';

/** Prepare on user intent, then simulate/estimate and submit through the set executor; never signs itself. */
export async function setGraduateCalls(reader: ChainReader, target: SetTargetV2, from: Address) {
  if (await reader.chainId() !== target.chainId) throw new Error('set graduation chain mismatch');
  const {vault} = checkSetIdentity(target.core,target.release,target.identity);
  const coordinator = target.identity.roles[0], hook = target.identity.roles[2];
  if (!coordinator || !hook) throw new Error('set graduation roles missing');
  const blockNumber = await reader.blockNumber();
  const block = await reader.getBlock(blockNumber);
  if (!block || block.number !== blockNumber) throw new Error('set graduation block unavailable');
  const read = async (to: Address, abi: Abi, fn: string, args: readonly unknown[] = []) => decodeFunctionResult({abi,functionName:fn,
    data:await reader.call(setCall(to,abi,fn,args),blockNumber)});
  const [registry, ownHook, ownVault, closed, graduated, failed] = await Promise.all([
    read(coordinator,coordinatorV2Abi,'registry'), read(coordinator,coordinatorV2Abi,'roleAddress',[2n]),
    read(coordinator,coordinatorV2Abi,'roleAddress',[3n]), read(hook,hookV2Abi,'closed'),
    read(coordinator,coordinatorV2Abi,'graduated'), read(coordinator,coordinatorV2Abi,'failed'),
  ]);
  if (String(registry).toLowerCase() !== target.identity.registry.toLowerCase() || String(ownHook).toLowerCase() !== hook.toLowerCase()
    || String(ownVault).toLowerCase() !== vault.toLowerCase()) throw new Error('set graduation coordinator binding mismatch');
  if (typeof closed !== 'boolean' || typeof graduated !== 'boolean' || typeof failed !== 'boolean') throw new Error('set graduation state unavailable');
  const scoped = {...target,graduation:{blockNumber,blockHash:block.hash,coordinator,hook,closed,graduated,failed}};
  const call = setCall(coordinator,coordinatorV2Abi,'graduate');
  assertSendableSetCallV2(call,scoped,from);
  if ((await reader.getBlock(blockNumber))?.hash !== block.hash) throw new Error('set graduation block changed');
  return {target:scoped,call};
}
