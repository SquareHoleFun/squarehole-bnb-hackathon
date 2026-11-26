import { useQuery } from '@tanstack/react-query';
import { createPublicClient, http, parseAbi } from 'viem';
import { formatUnits } from '@squarehole/domain';
import { type V2Snapshot, type V2Source } from './indexer-v2';
import { FitBurnLogV2 } from './FitBurnLogV2';
import { DisclosureIcon } from '../../fit-pair/FitParts';
import { coinLabelV2 } from './price-coin';
const ABI = parseAbi(['function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)', 'function VERSION() view returns (string)']);
/**
 * RC5-C: the two fixed Safes of every v2 release. P from royalties waits until graduation and is then split in
 * fifteenths on the buyers' side (ReceiverBooksV21.split), so these Safes get FIT's 2/15 and the platform's 1/15 of it as
 * fee shares whatever the buyers' choice (SH-245: with To holders its 10/15 goes to the pool, so the card no longer says
 * "split like buyers' fees"); a
 * failed box's royalty P joins its pot instead, and royalty coins other than P never reach them (F138).
 */
const KINDS = ['fit', 'platform'] as const;
const NAMES = { fit: 'FIT buy-back Safe', platform: 'Platform Safe' } as const;
const PAYMENTS = { fit: 'Paid to FIT Safe', platform: 'Paid to platform Safe' } as const;
export async function readSafesV2(source: V2Source, view: V2Snapshot) {
  const money = view.money;
  if (!money) throw new Error('Safe addresses unavailable');
  const client = createPublicClient({ transport: http(source.rpc, { retryCount: 0 }) });
  if (await client.getChainId() !== source.manifest.chainId) throw new Error('Wrong RPC chain');
  const rows = await Promise.all(KINDS.map(async (kind) => {
    const address = money.safes[kind];
    const [owners, threshold, version] = await Promise.all([
      client.readContract({ address, abi: ABI, functionName: 'getOwners', blockNumber: view.block }),
      client.readContract({ address, abi: ABI, functionName: 'getThreshold', blockNumber: view.block }),
      client.readContract({ address, abi: ABI, functionName: 'VERSION', blockNumber: view.block }),
    ]);
    if (threshold <= 0n || threshold > BigInt(owners.length)) throw new Error('Invalid Safe threshold');
    return { kind, address, owners, threshold, version };
  }));
  if ((await client.getBlock({ blockNumber: view.block })).hash !== view.blockHash) throw new Error('Safe read block changed');
  return rows;
}
export function SafesV2({ source, view, coin = coinLabelV2(view.record.q, null) }: { source: V2Source; view: V2Snapshot; coin?: string }) {
  const safes = useQuery({ queryKey: ['v2-safes', source.network, source.rpc, view.blockHash, view.token], queryFn: () => readSafesV2(source, view), enabled: view.money !== null, retry: false });
  return <details className="sh-fit-details"><summary><span className="sh-fit-details__chevron" aria-hidden="true"><DisclosureIcon /></span>Safes and payments</summary>
    {KINDS.map((kind) => {
      const row = safes.data?.find((r) => r.kind === kind);
      return <section key={kind}><h3>{NAMES[kind]}</h3><p className="sh-v2-address">{view.money?.safes[kind] ?? 'Address unavailable'}</p>
        {row ? <><p>{`${row.threshold} of ${row.owners.length} signatures · Safe ${row.version}`}</p><ul>{row.owners.map((owner) => <li className="sh-v2-address" key={owner}>{owner}</li>)}</ul></> : <p>{view.money && safes.isPending ? 'Reading owners and threshold…' : 'Owners and threshold unavailable'}</p>}
      </section>;
    })}
    <p>Burns from the FIT Safe need a second owner’s signature.</p>
    <h3>Safe payouts</h3>
    {view.safePayments.length ? <ul>{view.safePayments.map((p, i) => <li key={`${p.txHash}-${i}`}><span>{`${PAYMENTS[p.kind as keyof typeof PAYMENTS]} · ${p.token.toLowerCase() === view.record.q.toLowerCase() ? `${formatUnits(p.amount, view.decimals)} ${coin}` : p.amount + ' raw units'}`}</span><details><summary>Transaction</summary><p className="sh-v2-address">{p.txHash}</p><p className="sh-v2-address">{p.token}</p><p className="sh-v2-address">{p.safe}</p></details></li>)}</ul> : <p>No recorded payments.</p>}
    <p>{`A payout is not a burn. After graduation, these Safes also get 2/15 and 1/15 of royalties in ${coin}; royalty coins other than ${coin} never reach a Safe.`}</p>
    {/* SH-258: FIT's burn log is box 0's (core v1 version 1); a release without box 0 (chain 97: `versions` empty) has none. */}
    {source.manifest.versions.some((v) => v.version === 1) ? <FitBurnLogV2 source={source} view={view} /> : null}
    <h3>Bot log</h3>
    <p>The bot’s sales, funding and Safe burns will appear here once published.</p>
  </details>;
}
