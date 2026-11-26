import { encodeFunctionData, decodeEventLog, zeroAddress } from 'viem';
import { artifact as standardArtifact } from '../../../../../packages/chain/scripts/lib/core-v2-local-manifest.mjs';
import { localClient } from '../../../../../packages/chain/scripts/local-core-v2-chain.mjs';
import { assertLocalRpc, send } from '../../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';

const files = { LocalERC20: 'LocalQuoteMocks.sol', LocalPriceCoin: 'LocalQuoteMocks.sol', PriceLimitSwapper: 'HookGasKit.sol' };
export const artifact = name => standardArtifact(name, { outDir: process.env.SH_EXAMPLES_ARTIFACTS, sourceFile: files[name] });
export const read = (chain, name, address, functionName, args = [], blockNumber) => localClient(chain).readContract({
  address, abi: artifact(name).abi, functionName, args, blockNumber,
});
export async function call(chain, name, to, functionName, args = [], from = chain.accounts.keeper, value = 0n) {
  await assertLocalRpc(chain.rpcUrl);
  const receipt = await send(chain.rpcUrl, { from, to, value, data: encodeFunctionData({ abi: artifact(name).abi, functionName, args }) });
  return localClient(chain).getTransactionReceipt({ hash: receipt.transactionHash });
}
export const balance = (chain, asset, address) => asset.toLowerCase() === zeroAddress
  ? localClient(chain).getBalance({ address }) : read(chain, 'LocalERC20', asset, 'balanceOf', [address]);
export function events(receipt, name, address, eventName) {
  return receipt.logs.filter(log => log.address.toLowerCase() === address.toLowerCase()).flatMap(log => {
    try {
      const event = decodeEventLog({ abi: artifact(name).abi, ...log });
      return event.eventName === eventName ? [event.args] : [];
    } catch { return []; }
  });
}
