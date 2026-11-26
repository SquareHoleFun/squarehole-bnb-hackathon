import { createPublicClient, http } from 'viem';
import { boxCollectionAbi, boxTokenAbi } from '@squarehole/chain/abi';
import { coordinatorV2Abi } from '../../../../../../packages/chain/src/core/v2';
import type { KeptReveal } from '../../create/v2/reveal-keep';
import type { V2Source } from './indexer-v2';

/** Identity, root, size and count from one finalized block. No finality means no completion-based deletion. */
export async function completedReveal(copy: KeptReveal, source: V2Source): Promise<boolean> {
  const client = createPublicClient({ transport: http(source.rpc, { retryCount: 0 }), ccipRead: false });
  if (await client.getChainId() !== copy.chainId) return false;
  const block = await client.getBlock({ blockTag: 'finalized' });
  if (block.number === null || !block.hash) return false;
  const blockNumber = block.number;
  const canonical = async () => (await client.getBlock({ blockNumber })).hash === block.hash;
  if (copy.discardWhenAbsent && !copy.owners?.length) {
    const code = await client.getCode({ address: copy.token, blockNumber });
    // Finalized absence alone cannot exclude a recent deployment.
    if (!code || code === '0x') {
      const head = await client.getCode({ address: copy.token });
      return (!head || head === '0x') && await canonical();
    }
  }
  const coordinator = await client.readContract({ blockNumber, address: copy.token, abi: boxTokenAbi, functionName: 'initialHolder' });
  const [specHash, collection] = await Promise.all([
    client.readContract({ blockNumber, address: coordinator, abi: coordinatorV2Abi, functionName: 'specHash' }),
    client.readContract({ blockNumber, address: coordinator, abi: coordinatorV2Abi, functionName: 'collection' }),
  ]);
  if (specHash.toLowerCase() !== copy.specHash) return false;
  const [root, size, revealed] = await Promise.all([
    client.readContract({ blockNumber, address: collection, abi: boxCollectionAbi, functionName: 'revealRoot' }),
    client.readContract({ blockNumber, address: collection, abi: boxCollectionAbi, functionName: 'collectionSize' }),
    client.readContract({ blockNumber, address: collection, abi: boxCollectionAbi, functionName: 'revealedCount' }),
  ]);
  return root.toLowerCase() === copy.revealRoot && BigInt(size) === BigInt(copy.n) && BigInt(size) > 0n && BigInt(revealed) === BigInt(size) && await canonical();
}
