import type { BoxEntryV2 } from '../chain-indexer';
import type { BoxRowV2 } from '../core-row';
import type { CoreEventV2 } from './events-v2';
import type { FeeChoiceV2 } from './views-v2';

/** Lifetime counters kept in each canonical snapshot, independent of the bounded recent activity list. */
export interface ProtocolActivityV2 {
  readonly itemsTakenOut: bigint;
  readonly itemsReturned: bigint;
  readonly drawsRequested: bigint;
  readonly drawsSettled: bigint;
}

/** Called only with the block reducer's authenticated, ordered, deduplicated events. */
export function protocolActivityV2(previous: ProtocolActivityV2 | undefined, events: readonly CoreEventV2[], boxId: bigint): ProtocolActivityV2 {
  const next = { itemsTakenOut: 0n, itemsReturned: 0n, drawsRequested: 0n, drawsSettled: 0n, ...previous };
  for (const event of events) {
    if (event.boxId !== boxId) continue;
    const key = `${event.source}.${event.name}`;
    // Delivery, not reservation, is the physical exit. Adapter summaries/lifecycle journals would double count it.
    if (key === 'vault.Withdrawn') next.itemsTakenOut += BigInt((event.args.ids as readonly bigint[]).length);
    else if (key === 'vault.Returned') next.itemsReturned += BigInt((event.args.ids as readonly bigint[]).length);
    else if (key === 'vault.TicketDelivered' || key === 'vault.Picked') next.itemsTakenOut += 1n;
    else if (key === 'vault.Given') next.itemsReturned += 1n;
    else if (key === 'tickets.DrawRequested') next.drawsRequested += 1n;
    else if (key === 'tickets.DrawSettled') next.drawsSettled += 1n;
  }
  return next;
}

const emptyFees = () => ({ burn: 0n, holders: 0n, items: 0n, eat: 0n, pile: 0n, shop: 0n, module: 0n,
  keep: 0n, grow: 0n, unclassified: 0n });
type FeeBucket = keyof ReturnType<typeof emptyFees>;
function bucket(choice: FeeChoiceV2 | null): FeeBucket {
  if (choice === 'holders-t') return 'holders';
  if (choice === 'items-t') return 'items';
  return choice ?? 'unclassified';
}
interface PriceCoinTotals {
  readonly priceCoin: string;
  readonly decimals: bigint;
  volumeP: bigint;
  collectedFeesP: bigint;
  readonly feesByChoiceP: ReturnType<typeof emptyFees>;
}
const keyOf = (row: BoxRowV2) => `${row.registry.toLowerCase()}:${row.boxId}`;

/** All discovered v2 rows on one chain, across releases; missing projections are explicitly counted as missing.
 * Fees are gross Collected buyersP/sellersP grouped by the frozen choice, not estimated swap fees or choice payouts.
 * No balances, prices, Safe payments, royalties or module execution summaries are added to collected fees.
 */
export function protocolTotalsV2(rows: readonly BoxRowV2[], entries: Iterable<BoxEntryV2>) {
  const byBox = new Map([...entries].map(entry => [keyOf(entry.row), entry]));
  const coins = new Map<string, PriceCoinTotals>();
  let boxesMade = 0n, boxesIndexed = 0n, boxesGraduated = 0n, boxesFailed = 0n, tokensBurned = 0n;
  let itemsTakenOut = 0n, itemsReturned = 0n, drawsRequested = 0n, drawsSettled = 0n;
  let stale = false;
  let verified: boolean | null = true;
  for (const row of rows) {
    boxesMade += 1n;
    const entry = byBox.get(keyOf(row));
    const state = entry?.states.at(-1);
    stale ||= entry?.repairing === true;
    if (entry?.verified === false) verified = false;
    else if (entry?.verified !== true && verified !== false) verified = null;
    if (!state?.statistics || !state.protocolActivity) continue;
    boxesIndexed += 1n;
    if (state.view.graduated) boxesGraduated += 1n;
    if (state.view.failed) boxesFailed += 1n;
    tokensBurned += state.statistics.burnedT;
    itemsTakenOut += state.protocolActivity.itemsTakenOut;
    itemsReturned += state.protocolActivity.itemsReturned;
    drawsRequested += state.protocolActivity.drawsRequested;
    drawsSettled += state.protocolActivity.drawsSettled;
    const priceCoin = row.q.toLowerCase();
    let coin = coins.get(priceCoin);
    if (!coin) {
      coin = { priceCoin, decimals: BigInt(row.pDecimals), volumeP: 0n, collectedFeesP: 0n, feesByChoiceP: emptyFees() };
      coins.set(priceCoin, coin);
    }
    if (coin.decimals !== BigInt(row.pDecimals)) throw new Error('inconsistent price coin decimals');
    coin.volumeP += state.volumeQ;
    coin.collectedFeesP += state.view.fees.buyersP + state.view.fees.sellersP;
    coin.feesByChoiceP[bucket(state.view.choices.buyers)] += state.view.fees.buyersP;
    coin.feesByChoiceP[bucket(state.view.choices.sellers)] += state.view.fees.sellersP;
  }
  const boxesMissing = boxesMade - boxesIndexed;
  return { boxesMade, boxesGraduated, boxesFailed, priceCoins: [...coins.values()].sort((a, b) => a.priceCoin.localeCompare(b.priceCoin)),
    tokensBurned, itemsTakenOut, itemsReturned, drawsRequested, drawsSettled,
    coverage: { boxesIndexed, boxesMissing, complete: boxesMissing === 0n }, stale, verified };
}
