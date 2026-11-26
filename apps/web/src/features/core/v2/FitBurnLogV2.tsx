import { useQuery } from '@tanstack/react-query';
import { coreVersion1 } from '@squarehole/chain';
import { formatUnits } from '@squarehole/domain';
import { parseFeedView } from '@squarehole/indexer/client';
import type { Fetcher } from '../core-client';
import { address, hash, object, raw, type V2Snapshot, type V2Source } from './indexer-v2';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** FIT remains box 0 (F122). Read its existing publication, without changing v1 indexing or attributing burns to P receipts. */
export async function loadFitBurnLogV2(source: V2Source, fetcher: Fetcher = fetch) {
  const version = coreVersion1(source.manifest);
  const feedReply = await fetcher(`${source.origin}/v1/feed?chain=${source.manifest.chainId}`);
  if (!feedReply.ok) throw new Error('FIT feed unavailable');
  const feed = parseFeedView(await feedReply.json(), {
    chainId: source.manifest.chainId, box0Registry: version.registry.address, registries: [version.registry.address],
  });
  const candidates = feed.cards.filter(({ row }) => row.isBox0);
  const genesis = candidates[0];
  if (candidates.length !== 1 || !genesis || !feed.asOf || genesis.card.stale || genesis.card.verified === false) throw new Error('FIT history unavailable');
  const { row, card } = genesis;
  const token = address(row.contracts.token);
  const executor = address(row.contracts.executor);
  if (!version.supportedTemplates.some((id) => same(id, row.templateId)) || !same(row.poolManager, source.manifest.chain.poolManager.address)) throw new Error('Wrong genesis identity');
  if (card.asOf.block !== feed.asOf.block || !same(card.asOf.hash, feed.asOf.hash)) throw new Error('FIT feed changed');
  const reply = await fetcher(`${source.origin}/v1/boxes/${source.manifest.chainId}/${token.toLowerCase()}/activity?kind=buyback&limit=100`);
  if (!reply.ok) throw new Error('FIT burns unavailable');
  const data = object(await reply.json());
  const at = object(data.asOf);
  if (raw(at.block) !== raw(feed.asOf.block) || !same(hash(at.hash), feed.asOf.hash)) throw new Error('FIT history changed');
  if (!Array.isArray(data.items)) throw new Error('Invalid FIT burn log');
  const seen = new Map<string, string>();
  const burns = data.items.flatMap((item) => {
    const entry = object(item);
    // The core indexer derives buyback only from the genesis executor's TokensBurned event.
    // Proposals, funding and failed transactions provide no such canonical event.
    if (entry.kind !== 'buyback' || entry.removed === true || (entry.status !== undefined && entry.status !== 'confirmed')) return [];
    const event = object(entry.data);
    const block = raw(entry.block);
    const blockHash = hash(entry.blockHash);
    const txHash = hash(entry.txHash);
    const index = entry.logIndex;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) throw new Error('Invalid FIT log index');
    if (block < row.creationBlock || block > raw(at.block) || (block === raw(at.block) && !same(blockHash, hash(at.hash)))) throw new Error('FIT burn outside publication');
    const bought = raw(event.bought); const unsolicited = raw(event.unsolicited);
    const identity = `${blockHash.toLowerCase()}:${index}`;
    const contents = `${txHash.toLowerCase()}:${block}:${bought}:${unsolicited}`;
    const prior = seen.get(identity);
    if (prior !== undefined && prior !== contents) throw new Error('Conflicting FIT burn');
    if (prior !== undefined) return [];
    seen.set(identity, contents);
    return [{ txHash, block, blockHash, index, amount: bought + unsolicited }];
  });
  return { token, executor, asOf: feed.asOf, burns };
}

export function FitBurnLogV2({ source, view }: { source: V2Source; view: V2Snapshot }) {
  const result = useQuery({
    queryKey: ['v2-fit-burns', source.manifest.chainId, source.origin, coreVersion1(source.manifest).registry.address, view.blockHash],
    queryFn: () => loadFitBurnLogV2(source), retry: false,
  });
  // A failed refresh hides old data so an orphaned burn cannot survive a failed canonical read.
  const data = result.isError ? undefined : result.data;
  return <section aria-label="FIT executor burns"><h3>FIT executor burns</h3>
    {data ? data.burns.length ? <ul>{data.burns.map((burn) => <li key={`${burn.blockHash}-${burn.index}`}>
      <span>{`${formatUnits(burn.amount, 18)} FIT`}</span>
      <details><summary>Transaction</summary><p className="sh-v2-address">{burn.txHash}</p><p>{`Block ${burn.block} · log ${burn.index}`}</p><p className="sh-v2-address">{burn.blockHash}</p></details>
    </li>)}</ul> : <p>No FIT executor burns in the latest 100 burn records.</p> : <p>{result.isPending ? 'Reading FIT burns…' : 'FIT executor history unavailable.'}</p>}
    <p>Shared across boxes; these burns are not attributed to this box.</p>
    {data ? <details><summary>FIT burn details</summary><p>Recorded on chain. Recent blocks can change.</p><p>{`Read at block ${data.asOf.block} (${data.asOf.tier}). Up to 100 recent burn records.`}</p><p className="sh-v2-address">{data.token}</p><p className="sh-v2-address">{data.executor}</p></details> : null}
  </section>;
}
