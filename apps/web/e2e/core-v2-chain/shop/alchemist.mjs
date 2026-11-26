import { encodeAbiParameters, getAddress } from 'viem';
import { artifact } from '../../../../../packages/chain/scripts/lib/core-v2-local-manifest.mjs';
import { send } from './life.mjs';

/**
 * The creator deploys; only the fixture's keeper starts conversions before the seven-day fallback. `dustMax` is the
 * largest raw-P step a pool may pay nothing for and still stay in the box's pool depth (positive, at most `inputCap`).
 */
export async function deployAlchemist(chain, release, pm, route, inputCap, dustMax, sendTransaction = send) {
  const { actor, keeper } = chain.accounts;
  const action = artifact('AlchemistFeeModuleV21');
  const args = encodeAbiParameters(action.abi.find((entry) => entry.type === 'constructor').inputs,
    [pm, release.implementations.receiver.address, release.implementations.coordinator.address, route, inputCap, dustMax, keeper]);
  const made = await sendTransaction(chain, actor, null, `${action.bytecode.object}${args.slice(2)}`, 0n, 15_000_000n);
  return getAddress(made.contractAddress);
}
