/**
 * SH-192 (BOXSPEC-AUTOSAVE): on a collection box's page, for its creator only (the connected wallet is the record's
 * creator), this browser's copy of the box's reveal data (create/v2/reveal-keep.ts), while items are unrevealed on
 * chain: "Reveal data saved on this device" with Download again, or, when this device has no copy, one plain line that
 * says so. Once a finalized snapshot shows every item revealed, the copy is removed and the panel goes. Numbers first: how many
 * items are not revealed yet. Reads only (the collection's `revealedCount` and `collectionSize`); no wallet request.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { createPublicClient, http, zeroHash, type Address } from 'viem';
import { boxCollectionAbi } from '@squarehole/chain/abi';
import { rolesOfV2 } from '../../../../../../packages/chain/src/core/v2';
import { ArtMode } from '@squarehole/box-spec';
import { useWallet } from '../../wallet';
import { download } from '../../create/v2/box-file-save';
import { forgetKeptCopy, readKept, type KeptReveal } from '../../create/v2/reveal-keep';
import { completedReveal } from './reveal-finalized';
import type { V2Snapshot, V2Source } from './indexer-v2';

const READ_MS = 30_000;
export const REVEAL_COPY_SAVED = 'Reveal data saved on this device.';
export const REVEAL_COPY_NONE = 'No copy of this box’s reveal data on this device. Keep the box file you saved at Create: without it, unrevealed items cannot be opened.';
export const revealCountText = (unrevealed: bigint, size: bigint): string => `${unrevealed}/${size} not revealed`;

export interface RevealCounts { readonly revealed: bigint; readonly size: bigint }

/** The collection's reveal count and size, read over the source's RPC. */
export async function readRevealCounts(rpc: string, collection: Address): Promise<RevealCounts> {
  const client = createPublicClient({ transport: http(rpc, { retryCount: 0 }) });
  const [revealed, size] = await Promise.all([
    client.readContract({ address: collection, abi: boxCollectionAbi, functionName: 'revealedCount' }),
    client.readContract({ address: collection, abi: boxCollectionAbi, functionName: 'collectionSize' }),
  ]);
  return { revealed: BigInt(revealed), size: BigInt(size) };
}

export interface RevealCopyV2Props {
  readonly view: V2Snapshot;
  readonly source: V2Source;
  /** Test seams: the chain's counts and this device's copy. */
  readonly complete?: typeof completedReveal;
  readonly counts?: (collection: Address) => Promise<RevealCounts>;
  readonly kept?: { readonly read: typeof readKept; readonly forget: typeof forgetKeptCopy };
}

/** Shown only to the creator of a box whose spec commits a reveal root (open or hidden art) and that has a collection. */
export function RevealCopyV2(props: RevealCopyV2Props) {
  const wallet = useWallet();
  const { view } = props;
  const account = wallet.status === 'connected' ? wallet.account : null;
  const collection = rolesOfV2(view.record).contracts.collection;
  const art = Number(view.spec.artMode);
  const commits = (art === ArtMode.OPEN || art === ArtMode.HIDDEN) && view.spec.revealRoot.toLowerCase() !== zeroHash;
  if (!account || account.toLowerCase() !== view.record.creator.toLowerCase() || !commits || !collection) return null;
  return <RevealCopyPanel {...props} collection={collection} />;
}

function RevealCopyPanel({ view, source, collection, counts, complete = completedReveal, kept = { read: readKept, forget: forgetKeptCopy } }: RevealCopyV2Props & { collection: Address }) {
  const chainId = source.manifest.chainId;
  const queries = useQueryClient();
  const copyKey = ['v2-reveal-copy', chainId, view.token.toLowerCase()];
  const chain = useQuery({ queryKey: ['v2-reveal-counts', source.rpc, collection.toLowerCase()], queryFn: () => (counts ?? ((c: Address) => readRevealCounts(source.rpc, c)))(collection), refetchInterval: READ_MS });
  const copy = useQuery({ queryKey: copyKey, queryFn: () => kept.read(chainId, view.token) });
  // Only a copy made for this box's own spec counts (the registry's specHash).
  const held: KeptReveal | null = copy.data && copy.data.specHash === view.record.specHash.toLowerCase() ? copy.data : null;
  const finalized = useQuery({ queryKey: ['v2-reveal-finalized', source.rpc, chainId, view.token, held?.attempt, held?.savedAt, held?.specHash, held?.revealRoot],
    queryFn: () => held ? complete(held, source) : false, enabled: held !== null, refetchInterval: READ_MS });
  const all = chain.data ? chain.data.size > 0n && chain.data.revealed >= chain.data.size : false;
  useEffect(() => {
    // Delete only the captured copy whose identity and complete count were read at one finalized block.
    if (finalized.data !== true || !held) return;
    void kept.forget(held).catch(() => undefined).then(() => queries.invalidateQueries({ queryKey: copyKey }));
    // copyKey is rebuilt each render from these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finalized.data, held, chainId, view.token]);
  if (all || copy.isPending) return null;
  const unrevealed = chain.data ? chain.data.size - chain.data.revealed : null;
  // No copy here: said only once the chain shows unrevealed items (never on an unread chain).
  if (!held && unrevealed === null) return null;
  return (
    <section className="sh-panel sh-v2-reveal-copy" aria-label="Reveal data" data-reveal-copy={held ? 'saved' : 'none'}>
      <h2>Reveal data</h2>
      {chain.data && unrevealed !== null ? <p className="sh-v2-value" data-reveal-count="">{revealCountText(unrevealed, chain.data.size)}</p> : null}
      {held ? (
        <>
          <p>{REVEAL_COPY_SAVED}</p>
          <button type="button" className="sh-button" onClick={() => { download(held.fileName, [held.text]); }}>Download again</button>
        </>
      ) : <p role="alert" data-reveal-copy-none="">{REVEAL_COPY_NONE}</p>}
    </section>
  );
}
