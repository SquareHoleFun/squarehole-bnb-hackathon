/**
 * v2.1 step 1 on the box page: what an eat box has eaten of its price coin (the receiver's cumulative `eatenP` at the
 * displayed hash), burned or locked as its creation snapshot fixed (`priceBurnSelector`), and what still waits. A missing
 * read is "Unavailable", never 0. The keeper or anyone triggers the eating after graduation; the page offers no action.
 */
import { formatUnits } from '@squarehole/domain';
import type { V2Snapshot } from './indexer-v2';

/** Where a lock sends the price coin (BoxReceiverV2: the first eligible dead wallet). */
export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD';

export function EatenV2({ view, symbol }: { view: V2Snapshot; symbol: string }) {
  const eat = view.eat ?? null;
  const amount = (raw: bigint) => `${formatUnits(raw, view.decimals)} ${symbol}`;
  return <section className="sh-panel" aria-label="Eaten"><h2>Eaten</h2>
    <p className="sh-v2-value">{eat ? amount(eat.eatenP) : 'Unavailable'}</p>
    {eat ? <p className="sh-m2-chips"><span className="sh-chip" data-eat={eat.burned ? 'burn' : 'lock'}>{eat.burned ? 'Burned' : 'Locked'}</span></p> : null}
    {eat ? <dl className="sh-m3-figures"><div><dt>Waiting</dt><dd>{amount(eat.pendingP)}</dd></div></dl> : null}
    <details><summary>Eat details</summary>
      {eat ? <p>{eat.burned ? `The ${symbol} share is burned for good: ${symbol} records a checked burn.` : `The ${symbol} share is locked forever at a dead address.`}</p> : <p>Current eat reads unavailable.</p>}
      {eat && !eat.burned ? <p className="sh-v2-address">{DEAD_ADDRESS}</p> : null}
      <p>After graduation anyone can trigger it, with no tip. Before graduation the share waits; if the box fails first, it joins the closing claim.</p>
    </details>
  </section>;
}
