import { useQuery } from '@tanstack/react-query';
import { formatUnits } from '@squarehole/domain';
import { object, raw, address, hash, type V2Source, type V2Snapshot } from './indexer-v2';
import type { Fetcher } from '../core-client';
import { DisclosureIcon } from '../../fit-pair/FitParts';
export async function loadBurnLogV2(source: V2Source, view: V2Snapshot, fetcher: Fetcher = fetch) {
  const reply = await fetcher(`${source.origin}/v2/boxes/${source.manifest.chainId}/${view.token.toLowerCase()}/activity?limit=100`);
  if (!reply.ok) throw new Error('Burn log unavailable');
  const data = object(await reply.json());
  if (!Array.isArray(data.items)) throw new Error('Invalid burn log');
  return data.items.flatMap((item) => {
    const entry = object(item); if (entry.kind !== 'v2_event') return [];
    const event = object(entry.data);
    if (event.source !== 'token' || event.event !== 'Transfer' || typeof event.to !== 'string' || !/^0x0{40}$/i.test(event.to) || address(event.from).toLowerCase() !== view.record.contracts[5]?.toLowerCase()) return [];
    return [{ tx: hash(entry.txHash), amount: raw(event.amount), index: String(entry.logIndex) }];
  });
}
export function BurnLogV2({ source, view }: { source: V2Source; view: V2Snapshot }) {
  const result = useQuery({ queryKey: ['v2-burns', source.network, source.origin, view.token, view.blockHash], queryFn: () => loadBurnLogV2(source, view), retry: false });
  return <details className="sh-fit-details"><summary><span className="sh-fit-details__chevron" aria-hidden="true"><DisclosureIcon /></span>Burn log</summary>
    {result.data ? result.data.length ? <ul>{result.data.map((burn) => <li key={`${burn.tx}-${burn.index}`}>{formatUnits(burn.amount, 18)} {view.spec.tokenSymbol}<details><summary>Transaction</summary><p className="sh-v2-address">{burn.tx}</p></details></li>)}</ul> : <p>No receiver burns in the latest 100 activity entries.</p> : <p>{result.isPending ? 'Reading burn log…' : 'Burn log unavailable'}</p>}
    <p>Confirmed token burns only. The total above includes all indexed receiver burns.</p>
  </details>;
}
