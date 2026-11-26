/**
 * SH-203: the way into the creator's "Reveal items" view. The box page's sub-view sits in its URL (`?view=reveal`, an
 * allowlist, as the section bar's `?tab=`), so a reload keeps it open; closing drops the parameter. The entry is one
 * button, for the box's creator only (the connected wallet is the record's creator), on an open-art box whose spec commits
 * a reveal root, while the chain shows items left to reveal. Hidden-art boxes open their items through their draws
 * (HiddenDrawsV2.tsx). Reads only (the collection's counts, shared with RevealCopyV2's query); no wallet request.
 */
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { zeroHash, type Address } from 'viem';
import { ArtMode } from '@squarehole/box-spec';
import { rolesOfV2 } from '../../../../../../packages/chain/src/core/v2';
import { useWallet } from '../../wallet';
import { readRevealCounts, type RevealCounts } from './RevealCopyV2';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { REVEAL_WORDS as W } from './reveal-words';

const READ_MS = 30_000;
const VIEWS = new Map([['reveal', 'reveal']] as const);

/** The box page's sub-view from `?view=`: only `reveal`; anything else is the box itself. Selecting none drops it. */
export function useBoxSubView(): ['reveal' | null, (next: 'reveal' | null) => void] {
  const [params, setParams] = useSearchParams();
  const selected = VIEWS.get(params.get('view') as 'reveal') ?? null;
  const select = (next: 'reveal' | null) =>
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (next === null) updated.delete('view');
      else updated.set('view', next);
      return updated;
    }, { replace: true });
  return [selected, select];
}

/** An open-art box whose spec commits its items and that has a collection: the boxes this view reveals. */
export function opensReveal(view: Pick<V2Snapshot, 'spec' | 'record'>): boolean {
  return Number(view.spec.artMode) === ArtMode.OPEN && view.spec.revealRoot.toLowerCase() !== zeroHash
    && Boolean(rolesOfV2(view.record).contracts.collection);
}

/** Whether the connected wallet is this box's creator (the view and the entry show for that wallet only). */
export function useIsBoxCreator(view: Pick<V2Snapshot, 'record'>): boolean {
  const wallet = useWallet();
  const account = wallet.status === 'connected' ? wallet.account : null;
  return account !== null && account.toLowerCase() === view.record.creator.toLowerCase();
}

export interface RevealEntryV2Props {
  readonly view: V2Snapshot;
  readonly source: V2Source;
  readonly onOpen: () => void;
  /** Test seam: the chain's counts. */
  readonly counts?: (collection: Address) => Promise<RevealCounts>;
}

export function RevealEntryV2(props: RevealEntryV2Props) {
  const creator = useIsBoxCreator(props.view);
  const collection = rolesOfV2(props.view.record).contracts.collection;
  if (!creator || !opensReveal(props.view) || !collection) return null;
  return <RevealEntryButton {...props} collection={collection} />;
}

function RevealEntryButton({ source, collection, onOpen, counts }: RevealEntryV2Props & { collection: Address }) {
  const chain = useQuery({ queryKey: ['v2-reveal-counts', source.rpc, collection.toLowerCase()], queryFn: () => (counts ?? ((c: Address) => readRevealCounts(source.rpc, c)))(collection), refetchInterval: READ_MS });
  // Said only on the chain's own answer: items left to reveal.
  if (!chain.data || chain.data.size === 0n || chain.data.revealed >= chain.data.size) return null;
  return (
    <p className="sh-v2-reveal-entry">
      <button type="button" className="sh-button sh-button--primary" onClick={onOpen}>{W.entry}</button>
    </p>
  );
}
