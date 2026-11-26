/**
 * SH-EXISTING-NFTS-E08C: an outside item's small picture beside its id, read lazily and defensively (set-pictures.ts).
 * Until a picture is read and checked, or when it never is, a plain square stands in; the id beside it says which
 * item this is, so the picture is decoration (empty alt text). SH-WITHHELD-SITE: a picture our withheld list names is
 * the neutral tile, which says so (its name and title; too small for its words).
 */
import type { Address } from 'viem';
import { WithheldTile } from '../pictures/WithheldTile';
import { useItemPicture } from './set-pictures';
import type { SetReads } from './set-reads';

export interface SetItemPictureProps {
  /** The source's reads; null: nothing is read (the square stays). */
  readonly reads: Pick<SetReads, 'read'> | null;
  readonly chainId: number;
  readonly collection: Address;
  readonly id: bigint;
  /** Our own IPFS gateways. */
  readonly ipfs: readonly string[];
}

export function SetItemPicture({ reads, chainId, collection, id, ipfs }: SetItemPictureProps) {
  const { url, withheld } = useItemPicture(reads, chainId, collection, id, ipfs);
  if (withheld) return <WithheldTile className="sh-set-item__picture" />;
  return url
    ? <img className="sh-set-item__picture" src={url} width={40} height={40} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
    : <span className="sh-set-item__picture sh-set-item__picture--none" aria-hidden="true" />;
}
