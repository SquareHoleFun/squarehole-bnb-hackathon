/**
 * The preview is the product (box creation flow § 7): the real feed card and box header, fed by the record the draft's
 * spec makes through `recordFromSpec`, the same path a created box takes. Tape "Demo" on the Demo, "Preview" on a chain
 * source, on the card and on the header's cover. Not links, no counters: nothing can be done with a box that does not
 * exist yet. Beside the card, the header's own stats row, so steps 2-4 show their effect at once.
 */
import { BoxType, specHash, type BoxSpecV1 } from '@squarehole/box-spec';
import { DEMO_CHAIN_ID, type Address } from '@squarehole/domain';
import { BoxCard } from '../boxes/BoxCard';
import { demoSummary } from '../boxes/box-figure';
import type { BoxRecord, SiteLinks } from '../boxes/box-model';
import { demoHeader } from '../boxes/box-stats';
import { BoxHeader, BoxStats } from '../boxes/BoxHeader';
import { OwnRow, PeekStrip } from '../boxes/HeaderSide';
import { demoTokenFor, recordFromSpec } from '../boxes/spec-record';

export interface PreviewInput {
  readonly spec: BoxSpecV1;
  readonly coverUrl: string | null;
  /** A new collection's own cover (field 28), as the card shows it (SH-BOX-PICTURE-FIT); null: the logo stands in. */
  readonly collectionCoverUrl?: string | null;
  readonly thumbs: readonly string[];
  readonly demo: boolean;
  readonly chainId: number;
  readonly networkLabel: string;
  readonly nowMs: number;
  readonly bannerUrl?: string | null;
  readonly teaserUrls?: readonly string[];
  readonly links?: SiteLinks;
  readonly creator?: Address | null;
}

/** The record a created box would get (names filled in so an empty draft still reads as a box). */
export function previewRecord({ spec, coverUrl, collectionCoverUrl = null, thumbs, demo, chainId, networkLabel, nowMs, bannerUrl = null, teaserUrls = [], links, creator = null }: PreviewInput): BoxRecord {
  const token = spec.boxType === BoxType.TOKEN_ONLY;
  const name = spec.tokenName || 'Your box';
  const named = { ...spec, tokenName: name, collectionName: token ? '' : spec.collectionName || name, tokenSymbol: spec.tokenSymbol || spec.collectionSymbol || 'TICKER' };
  let hash: `0x${string}`;
  try {
    hash = specHash(spec);
  } catch {
    hash = `0x${'0'.repeat(64)}`;
  }
  return recordFromSpec(named, hash, {
    chainId: demo ? DEMO_CHAIN_ID : chainId,
    networkLabel,
    token: demoTokenFor(hash),
    demo,
    order: 0,
    coverUrl,
    collectionCoverUrl,
    thumbs,
    createdAtMs: nowMs,
    nowMs,
    bannerUrl,
    teaserUrls,
    links,
    creator,
  });
}

export function CardPreview({ record }: { record: BoxRecord }) {
  return (
    <ul className="sh-box-grid sh-newbox-card" aria-label="Card preview">
      <BoxCard summary={demoSummary(record)} to="/" preview={{ tape: 'Preview' }} />
    </ul>
  );
}

/** The box page's stats row (Items · Target · Deadline · Creator) for the draft, as on its page. */
export function StatsPreview({ record }: { record: BoxRecord }) {
  return (
    <div className="sh-newbox-stats-preview" role="group" aria-label="Box page figures">
      <BoxStats stats={demoHeader(record).stats} />
    </div>
  );
}

export function HeaderPreview({ record }: { record: BoxRecord }) {
  const head = demoHeader(record);
  return (
    <div className="sh-newbox-header-preview" aria-label="Box page preview" role="group">
      <BoxHeader
        preview
        tape="Preview"
        record={record}
        banner={record.spec?.bannerUrl ?? null}
        state="upcoming"
        band={head.band}
        line={record.line}
        idLine={
          <p className="sh-fit-ca sh-fit-ca--compact">
            <strong>{record.ticker}</strong>
            <span className="sh-muted">Address at creation</span>
          </p>
        }
        phase={head.phase ? <p className="sh-box-phase" data-state="upcoming">{head.phase}</p> : null}
        stats={head.stats}
        counters={[]}
        side={
          <div inert>
            <PeekStrip record={record} state="upcoming" size={record.itemCount} launchContent={false} onOpen={() => undefined} />
            <OwnRow record={record} state="upcoming" onOpen={() => undefined} />
          </div>
        }
      />
    </div>
  );
}
