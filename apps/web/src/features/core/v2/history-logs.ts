import { createPublicClient, http, type AbiEvent, type GetLogsParameters, type PublicClient } from 'viem';
import { refusedRetryFetch } from '@squarehole/chain/write';
import { VIEW_HTTP_BATCH } from '../../create/v2/view-client';
import type { V2Source } from './indexer-v2';

// On 26 November 2026 the first chain-97 read endpoint returned empty eth_getLogs results before block
// 145,000,000. The second still served the full history, in ranges of at most 5,000 blocks.
const HISTORY = new Map([
  ['https://bsc-testnet-rpc.publicnode.com', { rpc: 'https://bsc-prebsc-dataseed.bnbchain.org', span: 5_000n }],
]);

export function batchedLogClient(rpc: string) {
  return createPublicClient({ transport: http(rpc, { batch: VIEW_HTTP_BATCH, retryCount: 0, fetchFn: refusedRetryFetch() }), ccipRead: false });
}

type LogClient = Pick<PublicClient, 'getLogs'>;
const checkedClients = new Map<string, Promise<LogClient>>();

function historyClient(rpc: string, chainId: number): Promise<LogClient> {
  const key = `${chainId}|${rpc}`;
  let checked = checkedClients.get(key);
  if (!checked) {
    const client = batchedLogClient(rpc);
    checked = client.getChainId().then((id) => {
      if (id !== chainId) throw new Error('Wrong network');
      return client;
    }).catch((error) => { checkedClients.delete(key); throw error; });
    checkedClients.set(key, checked);
  }
  return checked;
}

/** One log range with its original filter. Only mapped endpoints need a different client and smaller ranges. */
export async function historyLogs<const Event extends AbiEvent | undefined = undefined>(
  source: V2Source, sourceClient: () => LogClient | Promise<LogClient>,
  filter: GetLogsParameters<Event> & { fromBlock: bigint; toBlock: bigint },
) {
  const history = HISTORY.get(source.rpc);
  if (!history) return (await sourceClient()).getLogs<Event>(filter);

  const client = await historyClient(history.rpc, source.manifest.chainId);
  const parts = [];
  for (let fromBlock = filter.fromBlock; fromBlock <= filter.toBlock; fromBlock += history.span) {
    const end = fromBlock + history.span - 1n;
    parts.push(client.getLogs<Event>({ ...filter, fromBlock, toBlock: end < filter.toBlock ? end : filter.toBlock }));
  }
  return (await Promise.all(parts)).flat();
}
