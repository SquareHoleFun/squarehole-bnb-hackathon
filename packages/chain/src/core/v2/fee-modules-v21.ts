/** Fixed receiver snapshots survive directory withdrawal; every read uses one canonical block. */
import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem';
import { receiverModulesV21Abi } from './abi-v2';
export interface ModuleSideV21 { readonly module: Address; readonly codeHash: Hex; readonly pendingP: bigint }
export interface FeeModulesV21 { readonly buyers: ModuleSideV21; readonly sellers: ModuleSideV21 }
export async function readFeeModulesV21(reader: { callAt(to: Address, data: Hex, hash: Hex): Promise<Hex> }, receiver: Address, hash: Hex): Promise<FeeModulesV21> {
  const side = async (sellers: boolean): Promise<ModuleSideV21> => {
    const call = async (functionName: 'sideModule' | 'modulePendingP') => decodeFunctionResult({ abi: receiverModulesV21Abi, functionName,
      data: await reader.callAt(receiver, encodeFunctionData({ abi: receiverModulesV21Abi, functionName, args: [sellers] }), hash) });
    const [[module, codeHash], pendingP] = await Promise.all([call('sideModule'), call('modulePendingP')]) as [readonly [Address, Hex], bigint];
    return { module, codeHash, pendingP };
  };
  const [buyers, sellers] = await Promise.all([side(false), side(true)]);
  return { buyers, sellers };
}
/*
 * The four built-in actions each run through their own entry (eatPriceCoin, buyBack, moveToPile). A generic action
 * (choice 10) needs a directory registration plus one day and applies only to boxes created later. The first directory
 * action, The Alchemist, adds executeModuleCallV21 in alchemist-v21.ts; the contract entry stays permissionless.
 * ShopT (11) is fixed core code on the same entry: shopFeesCallV21 builds executeModule(true) only for a prepared
 * shop with choice 11, and the shared guard refuses a declared ShopT side without its shop and holder ledger.
 */
