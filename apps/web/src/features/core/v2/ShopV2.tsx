import { formatUnits } from '@squarehole/domain';
import { starterCommitmentV2 } from '../../../../../../packages/chain/src/core/v2';
import { SHOP_FEES_LINE, SHOP_FEES_WARNING } from '../../create/v2/fee-words';
import type { ShopFeesV2, V2Snapshot, V2Source } from './indexer-v2';
import { allowanceV2 } from './shop-book';
import { shopOf } from './shop-actions';
import { useShopBookV2, useCollectionNamesV2 } from './shop-reads';
import { ShopActionsV2, utcDate } from './ShopActionsV2';
import { shopAmountV2 } from './ShopCardsV2';
import { tShortV2 } from './stats-v2';
import { InfoButton, InfoPanel, useInfoTip } from '../../fit-pair/InfoTip';
import { timeLeftWords, waitWords, type ShopConfigV2 } from './shop-wait';
const percent = (bps: number) => `${formatUnits(BigInt(bps), 2)}%`;
/**
 * F132 (ShopVaultV2 `_giveLimit`): each weekly limit, the shop's and a collection's, is at least the cheapest active give
 * price, never more than the week's budget snapshot.
 */
const GIVE_FLOOR = 'each at least one cheapest active give, within the week’s budget';
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * The sellers' P the holders got on a shop with Into the shop: every funded sellers' trade batch (even ids, the hook's
 * `_batchId(false)`), whether the shop did not want it when collected or its queued share was resolved to holders later
 * (R48E). A batch still waiting for the shop has no funding yet. Null without the history.
 */
export function sellersToHoldersP(view: Pick<V2Snapshot, 'm2'>): bigint | null {
  const batches = view.m2?.history?.batches;
  if (!batches) return null;
  return Object.entries(batches).reduce((sum, [id, batch]) => (BigInt(id) % 2n === 0n && batch.fundingP !== null ? sum + batch.fundingP : sum), 0n);
}

/**
 * v2.1 step 7 (R48A-F; SH-V21-FE14): a shop whose sellers chose Into the shop. The fixed ceiling, the live budget, what
 * fees put in so far (T) and spent (P), the sellers' P waiting, and what went to holders instead; Filling while the
 * week's snapshot and the live budget are below the ceiling, else Full. The founder's line and the accepted warning, word
 * for word, and in the details what decides where a batch goes and when.
 */
function ShopFeesPanel({ fees, view, ticker, symbol, t, warning = true }: { fees: ShopFeesV2; view: V2Snapshot; ticker: string; symbol: string; t: (n: bigint) => string; warning?: boolean }) {
  const money = fees.money; const history = fees.history;
  const p = (n: bigint) => shopAmountV2(n, symbol, view.decimals);
  const holders = sellersToHoldersP(view);
  const filling = money !== null && money.feesWanted && money.budgetT < money.ceilingT;
  const state = view.failed ? 'Closed' : money === null ? 'Unavailable' : filling ? 'Filling' : 'Full';
  // A part of the Shop panel under its own heading, as give and pick are (no region of its own: "Shop" stays one region).
  return <section className="sh-v2-shop-fees" data-shop-fees=""><h3>Fees into the shop</h3>
    <p className="sh-m2-chips"><span className="sh-chip" data-state={state}>{state}</span></p>
    <dl className="sh-m3-figures">
      {/* On a phone the ceiling and the two exact P amounts take a row each, so their digits stay on one line. */}
      <div className="sh-m3-figures__wide"><dt>Ceiling</dt><dd>{money ? `${t(money.ceilingT)} · ${fees.preset}x the seed` : `${fees.preset}x the seed`}</dd></div>
      <div><dt>Budget</dt><dd>{money ? t(money.budgetT) : 'Unavailable'}</dd></div>
      <div><dt>From fees</dt><dd>{money ? t(money.feesT) : 'Unavailable'}</dd></div>
      <div className="sh-m3-figures__wide"><dt>Waiting</dt><dd>{money ? p(money.pendingP) : 'Unavailable'}</dd></div>
      <div className="sh-m3-figures__wide"><dt>To holders</dt><dd>{holders !== null && money ? p(holders) : 'Unavailable'}</dd></div>
    </dl>
    <p>{SHOP_FEES_LINE}</p>
    {warning ? <ul className="sh-v2-warnings"><li>{SHOP_FEES_WARNING}</li></ul> : null}
    <details><summary>How fees fill the shop</summary>
      <p>{`Only the sellers’ 10/15 share. After graduation anyone may run the shop’s step: it buys ${ticker} in this box’s own pool with the waiting ${symbol}, within 49 ticks, and adds it to the budget, never past the ceiling. While the shop is filling, waiting ${symbol} too small for one step stays until later collections add to it.${history ? history.spentP > 0n ? ` So far ${p(history.spentP)} bought ${t(history.boughtT)}.` : ' Nothing bought so far.' : ''}`}</p>
      {/* SH-245: a holder batch is claimable only once settled for every holder (HolderLedgerV2 `claimable`, `_take`); a
          trade whose notice the hook skipped for gas (BoxHookV2Base `_noticeTrade`) and the box's own trades (protocol
          units) credit nobody, and that residue goes to the hook, the pool's budget (HolderLedgerV2 `flushResidue`). */}
      <p>{`When the shop is full, or the room left below the ceiling is worth less than one step, the share goes to holders in ${symbol}, claimable under Holder fee share once each batch is fully calculated. The part from the box’s own trades, and from trades sent with too little gas to be counted, goes to the pool.`}</p>
      <p>The collection time decides, not the trade time: each week’s first give, pick or fee step fixes that week’s budget, and a batch collected after a week ends follows the new week.</p>
      <p>{`Picks can take the budget past the ceiling; the shop then takes no fees until it is below again. If the box fails before graduation, the waiting ${symbol} joins the closing claim.`}</p>
    </details>
  </section>;
}

/**
 * A shop box's panel (M2-53; SH-V21-FE13): its budget in the box's coin, the items inside, what gives can still take
 * this week (for the shop and per collection), the fixed prices, the collection list and the starter set; then give,
 * pick and, for the curator, add a collection (ShopActionsV2). Amounts are the box's coin, named by its ticker.
 */
function starterOf(view: V2Snapshot): ReturnType<typeof starterCommitmentV2> {
  try {
    return starterCommitmentV2(view.spec);
  } catch {
    return null;
  }
}

type ShopProps = { view: V2Snapshot; source: V2Source; ticker: string; symbol?: string; disabled: boolean };
export function ShopV2(props: ShopProps) {
  // SH-300: a shop configuration that does not decode shows no wait and no action that depends on it; the rest of the
  // box page stays readable.
  const config = props.view.shopConfig;
  if (!config) return <section className="sh-panel sh-m2-shop" aria-label="Shop"><h2>Shop</h2><p>Shop settings unavailable</p></section>;
  return <ShopReady {...props} config={config} />;
}

function ShopReady({ view, source, ticker, symbol = 'P', disabled, config }: ShopProps & { config: ShopConfigV2 }) {
  // SH-300 guard: a starter add-on (8) that does not decode shows no starter part; the rest of the shop stays.
  const commitment = starterOf(view);
  const shop = view.m2?.money?.shop; const progress = view.m2?.money?.starter; const history = view.m2?.history?.shop;
  const vault = shopOf(view, null)?.shop ?? null;
  const { book, failed: bookFailed } = useShopBookV2(source, view, vault);
  const listed = shopOf(view, book)?.collections ?? [];
  const names = useCollectionNamesV2(source, listed);
  const allowance = book ? allowanceV2(book, config, view.timestamp) : null;
  const t = (n: bigint) => shopAmountV2(n, ticker);
  const tip = useInfoTip();
  const loaded = progress?.loaded;
  const state = view.failed ? 'Loading closed' : loaded === undefined ? 'Loading progress unavailable' : loaded < (commitment?.count ?? 0) ? 'Waiting for starter items' : !shop?.seedReady ? 'Waiting for seed' : !progress?.notified ? 'Ready to complete' : !view.gate.open ? 'Waiting for table' : commitment?.count === 0 ? 'Seed loaded' : 'Starter set complete';
  const frozen = shop && /^0x0{40}$/i.test(shop.curator);
  // SH-297 (the founder, 26 November 2026: "a huge wall of text"): the cards first, the two figures a visitor acts on
  // beside them, and everything else behind the (?), closed until opened; its first line is the shop's warning.
  return <section className="sh-panel sh-m2-shop" aria-label="Shop">
    <div className="sh-v2-shop-head"><h2>Shop</h2><InfoButton tip={tip} label="About the shop" /></div>
    <InfoPanel tip={tip}>
      {view.shopFees ? <ul className="sh-v2-warnings"><li>{SHOP_FEES_WARNING}</li></ul> : null}
      <p>{view.failed ? 'Shop closed' : 'Give budget'}{shop ? ` · ${t(view.failed ? shop.failedT : shop.budgetT)}${view.failed ? ' awaiting burn' : ''} · ${shop.inside} ${shop.inside === 1n ? 'item' : 'items'} inside` : ''}</p>
      {!view.failed && allowance ? <dl className="sh-m3-figures sh-v2-shop-week">
        <div><dt>Left this week</dt><dd>{t(allowance.weeklyLeftT)}</dd></div>
        <div><dt>Per collection</dt><dd>{`up to ${t(allowance.collectionLimitT)}`}</dd></div>
        <div><dt>Week ends</dt><dd>{book?.week ? utcDate(book.week.endsAt) : '—'}</dd></div>
      </dl> : null}
      {view.shopFees ? <ShopFeesPanel fees={view.shopFees} view={view} ticker={ticker} symbol={symbol} t={t} warning={false} /> : null}
      <table aria-label={`Fixed prices in ${ticker}`}><thead><tr><th>Tier</th><th>Give</th><th>Pick</th></tr></thead><tbody>{config.givePricesT.map((give, i) => <tr key={i}><th>{i + 1}</th><td>{t(give)}</td><td>{t((give * BigInt(config.pickBps) + 9999n) / 10000n)}</td></tr>)}</tbody></table>
      <h3>Budget and collection list</h3>
      <p>{view.shopFees ? `${ticker} is this box’s coin. Seed, picks and the sellers’ fees, up to the ceiling, fund gives. The last item stays.` : `${ticker} is this box’s coin. Seed and picks fund gives. Fees do not fund this shop. The last item stays.`}</p>
      <p>{`${percent(config.weeklyBps)} per week · ${percent(config.collectionBps)} per collection · ${GIVE_FLOOR} · ${waitWords(config.listDelay)} before a new entry accepts gives.`}</p>
      <p>Each week’s first move fixes its allowance. Picks fund later weeks; unused allowance does not carry.</p>
      <p>One press: when it is needed, a pick first lets the shop take exactly its price; a give, just that one item.</p>
      <p>{frozen ? 'List frozen' : 'Curator can only add, at most once a week. Handover needs the next curator’s acceptance. Renouncing freezes the list.'}</p>
      {shop ? <><p className="sh-v2-address">{shop.curator}</p>{!/^0x0{40}$/i.test(shop.pendingCurator) ? <p className="sh-v2-address">{`Pending curator: ${shop.pendingCurator}`}</p> : null}</> : <p>Current curator unavailable</p>}
      {history ? <ul className="sh-v2-shop-list" aria-label="Collections">{Object.entries(history.collections).map(([collection, terms]) => {
        const left = allowance && !view.failed && view.timestamp >= terms.activeAt ? ` · ${t(allowance.leftFor(collection))} left this week` : '';
        return <li key={collection}><span>{names(collection) ?? short(collection)}</span>{` · tier ${terms.tier + 1} · ${view.timestamp >= terms.activeAt ? 'Active' : `${timeLeftWords(terms.activeAt, view.timestamp)} to activation`}${left}`}<span className="sh-v2-address">{collection}</span></li>;
      })}</ul> : <p>Collection list unavailable</p>}
    </InfoPanel>
    {view.failed ? <><p className="sh-v2-value">{shop ? `${t(shop.failedT)} awaiting burn` : 'Budget unavailable'}</p><p>Shop closed</p></> : null}
    {!view.failed ? <ShopActionsV2 view={view} source={source} ticker={ticker} disabled={disabled} book={book} bookFailed={bookFailed} /> : null}
    {!view.failed ? <dl className="sh-m3-figures sh-v2-shop-figures">
      <div><dt>Give budget</dt><dd>{shop ? `${tShortV2(shop.budgetT)} ${ticker}` : 'Unavailable'}</dd></div>
      <div><dt>Left this week</dt><dd>{allowance ? `${tShortV2(allowance.weeklyLeftT)} ${ticker}` : '—'}</dd></div>
    </dl> : null}
    {commitment ? <section aria-label="Starter loading"><h3>{commitment.count > 0 ? 'Starter set' : 'Seed'}</h3>
      {/* A seed-only set (no starter items, as the create flow makes it) shows its state alone, never "0 / 0 items". */}
      {commitment.count > 0 ? <p className="sh-v2-value">{loaded === undefined ? '—' : `${loaded} / ${commitment.count} items`}</p> : null}
      {loaded !== undefined && commitment.count > 0 ? <progress aria-label="Starter items loaded" max={commitment.count} value={loaded} /> : null}
      <p role="status">{state}</p>
      <details><summary>Loading details</summary><p>No starter item moves at creation. The creator approves the shop, then loads up to 32 items at a time. Anyone may complete once all items and seed arrive. Both the table and completion must be ready to open.</p>
        <p>{shop ? `Seed: ${shop.seedReady ? 'Ready' : 'Waiting'}` : 'Seed readiness unavailable'}</p>
        <p>The unopened box can close after 14 days. This is separate from the seven-day graduation hatch.</p>
        {view.failed ? <><p>{`Starter items return only to the creator, with separate retries. The shop’s ${ticker} stays excluded from the closing claim and awaits burning.`}</p><p>{history ? `${Object.values(history.starters).filter(item => item.returned).length} returns confirmed` : 'Return progress unavailable'}</p></> : null}
      </details>
    </section> : null}
  </section>;
}
