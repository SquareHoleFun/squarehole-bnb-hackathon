/**
 * F128 on My Box: one Claim all for every claim the connected wallet has across this source's v2 boxes, one box
 * after another. Only the wallet's own box claims (a claim always pays its caller); another wallet's box is view only.
 */
import { useMemo, type ReactNode } from 'react';
import type { Address } from 'viem';
import { formatCount } from '../../fit-pair/fit-format';
import type { BoxRecord } from '../../boxes/box-model';
import type { LookupPart } from '../../boxes/box-sources';
import { FEED_WORDS } from '../../boxes/feed-words';
import { PAGE_TITLE_ID } from '../../../pages/page-parts';
import { LiveLine } from '../../../shell/PartFailed';
import { useClockMs } from '../useCore';
import { claimCount } from './claim-all';
import { ClaimAllV2 } from './ClaimAllV2';
import { hasClaimsV2, useClaimsV2, type BoxClaimsV2, type ClaimBoxV2 } from './claim-reads';

/** What the wallet page shows: the Claims tab's heading and content, and the header's "Claims ready". */
export interface WalletClaims {
  readonly lead: string; readonly ready: ReactNode; readonly panel: ReactNode;
  /** SH-291: the wallet's own claims per box (My Box's To claim list) and whether every read answered; absent: none read. */
  readonly boxes?: readonly BoxClaimsV2[]; readonly known?: boolean;
}

/** A v2 box with something claimable for anyone, as Claim all sees it; stale or unverified boxes wait. */
export function claimBoxOf(record: BoxRecord, nowSec: bigint): ClaimBoxV2 | null {
  const view = record.v2Chain?.snapshot; const source = record.v2Chain?.source;
  if (!view || !source || !hasClaimsV2(view)) return null;
  const stale = view.stale || (source.network === 'sepolia' && nowSec > view.timestamp + 60n);
  return { key: record.id, view, source, name: record.name, symbol: record.pairAsset, ticker: record.ticker, disabled: stale || !view.verified };
}

const NO_BOXES: readonly ClaimBoxV2[] = Object.freeze([]);

/**
 * The wallet's claims on the v2 boxes among `records`; another wallet's are view only. Null when the source has no v2
 * box that can hold a claim: the Claims tab then keeps its earlier words rather than saying a v1 wallet has none.
 */
export function useWalletClaimsV2(records: readonly BoxRecord[], account: Address | null, own: boolean): WalletClaims | null {
  const nowSec = BigInt(Math.floor(useClockMs(1000) / 1000));
  const boxes = useMemo(() => records.flatMap((record) => claimBoxOf(record, nowSec) ?? []), [records, nowSec]);
  const claims = useClaimsV2(own ? boxes : NO_BOXES, own ? account : null);
  if (boxes.length === 0) return null;
  if (!own) return { lead: 'View only', ready: <span className="sh-na">View only</span>, panel: <p className="sh-muted">Only this wallet can claim, from its own My Box.</p> };
  const count = claims.reduce((sum, c) => sum + claimCount(c.steps), 0);
  const on = claims.filter((c) => c.steps.length > 0).length;
  const known = claims.every((c) => c.known);
  return {
    lead: count > 0 ? `On ${on} ${on === 1 ? 'box' : 'boxes'}` : known ? 'Nothing to claim' : 'Reading…',
    ready: count > 0 || known ? formatCount(BigInt(count)) : <span className="sh-na">Reading…</span>,
    panel: <ClaimAllV2 scope="wallet" boxes={boxes} />,
    boxes: claims, known,
  };
}

/**
 * SH-246 (finding 11.4): the Claims tab when no v2 box among the source's boxes can hold a claim. Before, it said
 * "Claims are not built yet." and the header "Not built yet" in every such state, as for a source without v2 boxes.
 * Now: "Reading…" while the v2 feed loads; "Not available" with one line and Retry when it could not be read at all.
 * Null once it answered, and without a v2 part: the tab keeps its earlier words there (a true replacement for them must
 * also know box 0's per-item share; a later task).
 */
export function claimsWaiting(v2: LookupPart | null, retry?: () => void): WalletClaims | null {
  if (v2 === null) return null;
  if (v2.loading) return { lead: 'Reading…', ready: <span className="sh-na">Reading…</span>, panel: null };
  if (v2.answered || v2.error === null) return null;
  // Retry takes its own line away (the feed reads again): the page's heading keeps the keyboard, as on the box page.
  const onRetry = retry ? () => { document.getElementById(PAGE_TITLE_ID)?.focus({ preventScroll: true }); retry(); } : undefined;
  return {
    lead: 'Not available',
    ready: <span className="sh-na">Not available</span>,
    panel: (
      <div className="sh-panel sh-part-failed" data-claims="unread">
        <LiveLine text={FEED_WORDS.claims} />
        {onRetry ? <button type="button" className="sh-button" onClick={onRetry}>{FEED_WORDS.retry}</button> : null}
      </div>
    ),
  };
}
