/**
 * SH-WITHHELD-SITE fix round af1 (F157 (3)): a box's sealed picture, the Placeholders add-on's hidden SVG (spec-record.ts
 * decodes it from the box's on-chain spec into a data URL), wherever it shows: the header's sealed peek (HeaderSide.tsx)
 * and the contents' sealed counts (ContentsPanel.tsx). On a chain record, the picture's own id (`ipfs:` + the raw CID of
 * its bytes' SHA-256, as our gateway names exactly these bytes) is checked against our withheld list after the list's
 * first read, before the <img> is made, and again on every change of the list: listed, the neutral tile stands in its
 * place. Nothing is drawn from the bytes while that check runs. A local preview (the creation page, the Demo's tab-only
 * boxes) shows the creator's own bytes as before: they were never read from our services.
 */
import type { ReactNode } from 'react';
import { WithheldTile } from '../pictures/WithheldTile';
import { useWithheldInline } from '../pictures/withheld';
import type { BoxRecord } from './box-model';

export interface SealedPictureProps {
  readonly record: BoxRecord;
  /** The picture's size in CSS pixels (the slot's own styles may draw it smaller). */
  readonly size: number;
  /** The tile's class in this slot (its size and corners). */
  readonly tileClassName: string;
  /** What the slot shows when the box has no sealed picture. */
  readonly fallback: ReactNode;
}

export function SealedPicture({ record, size, tileClassName, fallback }: SealedPictureProps) {
  const url = record.spec?.sealedUrl ?? null;
  // A chain record: its registry row read from a chain source, never a creation preview or a tab-only box.
  const chain = record.row?.network === 'local' || record.row?.network === 'sepolia';
  const verdict = useWithheldInline(chain ? url : null);
  if (url === null) return <>{fallback}</>;
  if (chain && verdict === 'withheld') return <WithheldTile className={tileClassName} />;
  if (chain && verdict === 'checking') return <span data-withheld-checking="" aria-hidden="true" style={{ display: 'inline-block', width: size, height: size }} />;
  return <img src={url} width={size} height={size} alt="" loading="lazy" decoding="async" />;
}
