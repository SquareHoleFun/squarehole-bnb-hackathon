import { formatUnits } from '@squarehole/domain';
import type { AlchemistRowV21 } from '../../../../../../packages/chain/src/core/v2';
import { Details, InfoButton, InfoPanel, useInfoTip } from '../../fit-pair/InfoTip';
import { FieldError } from '../create-parts';
import type { AlchemistAnswer } from './alchemist';
import { ALCHEMIST_ROUTE_FIXED, SHOP_FEES_LINE, SHOP_FEES_WARNING, alchemistLine, buyBackBurnLabel, dustText, feeLegend, hopText, triggerText } from './fee-words';
import { amountText, isBoxToken, issuerLines, type SiteListing } from './listings';
import { V2_CONTROL } from './model';
import { RisksLink } from './RisksLink';
import { CEILING_PRESETS, INSIDE, INSIDE_LABEL, MENU, alchemistPick, ceilingOf, choiceLabel, choiceOf, eatLabel, eatOffered, inCoin, insideOf, moduleIdOf, payoutCoinOf, pickFor, type CeilingPreset, type FeeChoice, type FeeSide, type InsidePolicy, type PayoutCoin, type RecipeCtx, type SidePick } from './recipes';
import { tOf, type ShopChoice } from './shop';
import { saleListRows, type SaleListAnswer } from './sale-list';
import { TESTNET } from '../../data-source/testnet';

/** SH-258: the inbox's sale list (CoW, whole lots) where the test network has it; not on BNB Chain testnet (`cowSales`). */
const COW_SALES = TESTNET.switches.cowSales;
/** SH-258: box 0, FIT and the Misfits exist on this test network (not on BNB Chain testnet). */
const BOX0 = (import.meta.env?.SH_BNB !== true && TESTNET.switches.box0);
import { OffLine } from './CreateOptionsLines';
/**
 * ALCH-TEMPLATE: where the inbox's money goes, and what that means for a sellers'-only Alchemist. SH-ALCHEMIST-LESS-TEXT:
 * neither is in the default view any more: the first is in Fee details, after the inbox paragraph it sums up; the second
 * in the sellers' Alchemist Details.
 * SH-245: the receiver books inbox money (royalties, CoW sales, any P it did not get from a trade batch) as a buyers'
 * source with no batch (ReceiverBooksV21 `bookRoyalty` and `allocateBatches`' surplus call `split(.., false)`, id 0), and
 * `_splitSource` funds holders only from a trade batch: with To holders (P or T) on the buyers' side, the 10/15 of that
 * money goes to Grow, the box's own pool at graduation, or the closing claim if the box fails first (`routeFailureBooks`
 * routes GROW and the held ROYALTY ledger to the pot). Every other buyers' choice takes it as it takes buyers' fees.
 */
export const INBOX_SIDE_LINE = 'Inbox money follows the buyers’ side.';
export const INBOX_HOLDERS_LINE = 'In this version of the boxes, inbox money skips holders, because holders are paid from trades and inbox money has no trade behind it. Its 10/15 goes into the pool, or into the closing claim if the box fails.';
/** The inbox line for the buyers' current choice (none chosen yet: the general line). */
export const inboxSideLine = (buyers: FeeChoice | null): string => (buyers === 'holders' || buyers === 'holders-t' ? INBOX_HOLDERS_LINE : INBOX_SIDE_LINE);
export const ALCHEMIST_NO_INBOX = 'The inbox will not feed the sellers’ Alchemist.';

export interface FeesStepProps {
  readonly buyers: SidePick; readonly sellers: SidePick; readonly ctx: RecipeCtx;
  /** M3: "To items" pays every item of the box's own new collection, so it is offered only with one. */
  readonly collection: boolean;
  /** v2.1 step 3: "To the pile" is offered only on a coin pile in the box's own price coin. */
  readonly pileInPrice?: boolean;
  /** v2.1 step 7 (R48A-D): a shop box's settings; Into the shop is offered on its sellers' side only. */
  readonly shop?: ShopChoice | null;
  /**
   * v2.1 step 8: a coin pile in another coin than the price coin, with the Alchemist rows the page resolved for that
   * pair (alchemist.ts); The Alchemist is offered on either side only when one resolved. Null without such a pile.
   */
  readonly alchemist?: { readonly pile: SiteListing; readonly answer: AlchemistAnswer } | null;
  /** SH-RC7-SITE-INBOX: the release's sale list a box created now copies, read-only (sale-list.ts); off in the Demo. */
  readonly saleList?: SaleListAnswer;
  readonly errorFor: (control: string) => string | null;
  readonly set: (patch: { buyers?: SidePick; sellers?: SidePick }) => void;
  /**
   * SH-218 rail 2: whether this side's choice (a payout in the coin it names) needs a switched-off option. Such a choice
   * stays on the page, `aria-disabled`, and cannot be made; a chosen one stays chosen. To holders or To items picks the
   * other coin when only the current one is off.
   */
  readonly off?: (side: FeeSide, choice: FeeChoice) => boolean;
  /**
   * SH-251: the visual Create opens one side's choice in place (create/picture): only that side's card, the rest as here.
   * Absent on the steps, which show both sides.
   */
  readonly only?: FeeSide;
}

const NONE_OFF = (): boolean => false;

/**
 * SH-RC7-SITE-INBOX: the coins this box's inbox would offer for P on CoW and each one's lot, as the release lists them
 * now (read-only, details on demand). The box keeps the list it is created with; later changes apply to new boxes.
 */
function SaleList({ answer, ctx }: { answer: SaleListAnswer; ctx: RecipeCtx }) {
  if (answer.state === 'off') return null;
  const rows = answer.state === 'ready' ? saleListRows(answer.list, ctx.pricing, ctx.listings, answer.weth) : [];
  return <details className="sh-newbox-more" data-sale-list="">
    <summary>{answer.state === 'ready' ? `Sale list · ${rows.length} ${rows.length === 1 ? 'coin' : 'coins'}` : 'Sale list'}</summary>
    {answer.state === 'checking' ? <p>Reading the sale list…</p> : answer.state === 'failed' ? <p>Sale list unavailable.</p> : <>
      {rows.length > 0 ? <><p className="sh-muted">{`Offered for ${ctx.pricing.symbol} on CoW in whole lots of`}</p>
        <dl className="sh-newbox-rows">{rows.map((row) => <div key={row.coin} className="sh-newbox-row"><dt>{row.name}</dt><dd>{row.lot}</dd></div>)}</dl></>
        : <p>No coins on the sale list.</p>}
      {answer.list.complete ? null : <p>Some coins could not be read.</p>}
      <p className="sh-muted">As listed now. Your box keeps the list it is created with.</p>
    </>}
  </details>;
}

/**
 * v2.1 step 8: the row's fixed route, as its helper holds it (never typed or chosen here), the one line, and the pile
 * coin's issuer powers (a tokenized coin's issuer can pause or freeze it, which can stop a conversion or a hand-in).
 * G1: the row's admitted per-step cap, its dust size and its fixed trigger, as the module answers them (`inputCap()`,
 * `dustMax()`, `conversionTrigger()`), before the side is chosen; the trigger by its address, whoever it is (F153).
 * SH-ALCHEMIST-LESS-TEXT (founder, 2026-10-27: details "should never be the default"): all of it, in this order, behind
 * the side's closed Details, which ends with the link to the Terms' risks; `note` is the sellers'-only inbox note.
 */
function AlchemistRoute({ row, side, pile, price, listings, note = null }: { row: AlchemistRowV21; side: FeeSide; pile: SiteListing; price: SiteListing; listings: readonly SiteListing[]; note?: string | null }) {
  const powers = issuerLines(pile);
  return <div data-alchemist={row.id}>
    <Details name={`Alchemist, ${side === 'buyers' ? 'buyers’' : 'sellers’'} fees`}>
      <p className="sh-newbox-label">{`Route · row ${row.id}`}</p>
      <ol className="sh-v2-route">{row.route.map((hop, i) => <li key={i}>{hopText(hop, listings)}</li>)}</ol>
      <dl className="sh-newbox-rows sh-v2-alchemist-terms">
        <div className="sh-newbox-row"><dt>Each step</dt><dd>{`Up to ${amountText(row.inputCap, price)}`}</dd></div>
        <div className="sh-newbox-row"><dt>Too small</dt><dd>{dustText(amountText(row.dustMax, price))}</dd></div>
        <div className="sh-newbox-row"><dt>Started by</dt><dd>{triggerText(row.conversionTrigger)}</dd></div>
      </dl>
      <p className="sh-newbox-hint">{alchemistLine(pile.symbol)}</p>
      <p className="sh-newbox-hint" data-alchemist-fixed="">{ALCHEMIST_ROUTE_FIXED}</p>
      {powers.length > 0 ? <ul className="sh-newbox-warnings">{powers.map((line) => <li key={line}>{line}</li>)}</ul> : null}
      {note ? <p className="sh-newbox-hint" data-alchemist-inbox="">{note}</p> : null}
      <RisksLink />
    </Details>
  </div>;
}

/**
 * v2.1 step 7 (R48C): the ceiling, 2x, 4x or 8x the shop's seed, fixed at Create; each with its amount in the box's coin
 * once the seed is typed. Then the founder's line and the accepted warning, shown with the issuer-power warnings' style.
 */
function Ceiling({ ceiling, seedT, ticker, onPick }: { ceiling: CeilingPreset; seedT: bigint | null; ticker: string; onPick: (ceiling: CeilingPreset) => void }) {
  return <fieldset className="sh-v2-vault">
    <legend className="sh-newbox-label">Ceiling</legend>
    <div className="sh-newbox-chips__row">
      {CEILING_PRESETS.map((preset) => <button key={preset} type="button" className="sh-button sh-v2-ceiling" aria-pressed={ceiling === preset} onClick={() => onPick(preset)}>
        {`${preset}x the seed`}{seedT !== null && seedT > 0n ? <small>{`${formatUnits(seedT * BigInt(preset), 18)} ${ticker}`}</small> : null}
      </button>)}
    </div>
    <p className="sh-newbox-hint">{SHOP_FEES_LINE}</p>
    <ul className="sh-newbox-warnings"><li>{SHOP_FEES_WARNING}</li></ul>
  </fieldset>;
}

/**
 * R43-M3A: what an item still in the vault does with its share. Keep is the default; Burn is the Misfits' way; Grow the
 * pool (v2.1 step 5, Depth) sends the share, still in P, to the box's own pool, so with T only items out of the vault get T.
 */
function InVault({ side, inside, symbol, ticker, coin, onPick }: { side: FeeSide; inside: InsidePolicy; symbol: string; ticker: string; coin: PayoutCoin; onPick: (inside: InsidePolicy) => void }) {
  const tip = useInfoTip();
  return <fieldset className="sh-v2-vault">
    <legend className="sh-newbox-label">In the vault <InfoButton tip={tip} label={`About items in the vault, ${side}`} /></legend>
    <InfoPanel tip={tip}>
      <p>{`Keep: the share stays with the item and its owner claims it once the item is out. ${buyBackBurnLabel(ticker)}: the share buys back and burns ${ticker} in this box’s own pool${BOX0 ? ', the Misfits’ way' : ''}.`}</p>
      <p>{`Grow the pool: the share goes into this box’s own pool for good, in ${symbol}${coin === 'T' ? `; only items out of the vault claim ${ticker}` : ''}.`}</p>
      <p>Undrawn items share one hidden pool; each draw takes its equal part.</p>
    </InfoPanel>
    <div className="sh-newbox-chips__row">
      {([INSIDE.keep, INSIDE.burn, INSIDE.depth] as const).map((value) => <button key={value} type="button" className="sh-button" data-inside-policy={value} aria-pressed={inside === value} aria-label={`${value === INSIDE.burn ? buyBackBurnLabel(ticker) : INSIDE_LABEL[value]} in the vault`} onClick={() => onPick(value)}>{value === INSIDE.burn ? buyBackBurnLabel(ticker) : INSIDE_LABEL[value]}</button>)}
    </div>
  </fieldset>;
}

/** v2.1 step 2: a holder or item payout in the price coin, or in the box token, which the fees buy first. */
function ClaimedIn({ coin, symbol, ticker, items, onPick, off, offId }: { coin: PayoutCoin; symbol: string; ticker: string; items: boolean; onPick: (coin: PayoutCoin) => void; off: (coin: PayoutCoin) => boolean; offId: string }) {
  return <fieldset className="sh-v2-vault">
    <legend className="sh-newbox-label">Claimed in</legend>
    <div className="sh-newbox-chips__row">
      {([['P', symbol], ['T', ticker]] as const).map(([value, name]) => <button key={value} type="button" className="sh-button" aria-pressed={coin === value} aria-label={`Claimed in ${name}`}
        data-create-off={off(value) || undefined} aria-disabled={off(value) ? 'true' : undefined} aria-describedby={off(value) ? offId : undefined} onClick={() => { if (!off(value)) onPick(value); }}>{name}</button>)}
    </div>
    {coin === 'T' ? <p className="sh-newbox-hint">{`Fees buy ${ticker} first, then ${items ? 'items' : 'holders'} claim it.`}</p> : null}
  </fieldset>;
}

export function FeesStep({ buyers, sellers, ctx, collection, pileInPrice = false, shop = null, alchemist = null, saleList, errorFor, set, off = NONE_OFF, only }: FeesStepProps) {
  const ticker = ctx.ticker || 'the box coin';
  const symbol = ctx.pricing.symbol;
  const seedT = shop ? tOf(shop.seed) : null;
  // The newest resolved row is the one offered; a pick of another row stays named until it resolves again (v2Issues).
  const rows = alchemist?.answer.state === 'ready' ? alchemist.answer.rows : [];
  const newest = rows[0] ?? null;
  const card = (side: FeeSide, pick: SidePick) => {
    const picked = choiceOf(pick);
    const inside = insideOf(pick);
    const ceiling = ceilingOf(pick);
    const coin = payoutCoinOf(picked);
    // A pick the box cannot take stays visible (and named at Fees) instead of disappearing.
    const offered = (choice: FeeChoice) => choice === 'items' ? collection || picked === 'items' || picked === 'items-t'
      : choice === 'pile' ? pileInPrice || picked === 'pile' : choice === 'eat' ? eatOffered(ctx.pricing) || picked === 'eat'
      : choice === 'shop' ? (shop !== null && side === 'sellers') || picked === 'shop'
      : choice === 'alchemist' ? newest !== null || picked === 'alchemist' : true;
    const pressed = (choice: FeeChoice) => picked !== null && inCoin(picked, 'P') === choice;
    // SH-218 rail 2: the choice a button makes (a payout in the current coin, else the other one), or null when every
    // form of it is switched off.
    const target = (choice: FeeChoice): FeeChoice | null => {
      const here = inCoin(choice, coin ?? 'P');
      if (!off(side, here)) return here;
      const there = inCoin(choice, (coin ?? 'P') === 'P' ? 'T' : 'P');
      return there !== here && !off(side, there) ? there : null;
    };
    const choose = (choice: FeeChoice) => {
      const made = target(choice);
      if (made === null) return;
      if (made !== 'alchemist') set({ [side]: pickFor(made, inside ?? undefined, ceiling ?? undefined) });
      else if (newest) set({ [side]: alchemistPick(newest.id) });
    };
    const offId = `${V2_CONTROL[side]}-off`;
    const shownOff = MENU.filter(offered).some((choice) => target(choice) === null) || (picked !== null && off(side, picked));
    const row = picked === 'alchemist' ? rows.find((entry) => entry.id === moduleIdOf(pick)) ?? null : null;
    return <fieldset className="sh-newbox-side" id={V2_CONTROL[side]} tabIndex={-1} aria-describedby={errorFor(V2_CONTROL[side]) ? `${V2_CONTROL[side]}-error` : undefined}>
      <legend className="sh-newbox-side__legend">{feeLegend(side, ticker, symbol)}</legend>
      <div className="sh-newbox-chips__row">{MENU.filter(offered).map((choice) =>
        <button key={choice} type="button" className="sh-button" data-fee-choice={choice} aria-pressed={pressed(choice)} data-create-off={target(choice) === null || undefined}
          aria-disabled={target(choice) === null ? 'true' : undefined} aria-describedby={target(choice) === null ? offId : undefined} onClick={() => choose(choice)}>{choiceLabel(choice, ctx)}</button>)}</div>
      {picked !== null && picked !== 'alchemist' && coin !== null ? <ClaimedIn coin={coin} symbol={symbol} ticker={ticker} items={inside !== null} onPick={(next) => set({ [side]: pickFor(inCoin(picked, next), inside ?? undefined) })}
        off={(next) => off(side, inCoin(picked, next))} offId={offId} /> : null}
      {picked !== null && picked !== 'alchemist' && inside !== null ? <InVault side={side} inside={inside} symbol={symbol} ticker={ticker} coin={coin ?? 'P'} onPick={(next) => set({ [side]: pickFor(picked, next) })} /> : null}
      {picked === 'eat' ? <p className="sh-newbox-hint">{ctx.pricing.checkedBurn ? `Burned for good after graduation.` : `Locked forever at a dead address after graduation.`}</p> : null}
      {picked === 'shop' && ceiling !== null ? <Ceiling ceiling={ceiling} seedT={seedT} ticker={ticker} onPick={(next) => set({ [side]: pickFor('shop', undefined, next) })} /> : null}
      {row && alchemist ? <AlchemistRoute row={row} side={side} pile={alchemist.pile} price={ctx.pricing} listings={ctx.listings}
        note={side === 'sellers' && choiceOf(buyers) !== 'alchemist' ? ALCHEMIST_NO_INBOX : null} /> : null}
      {shownOff ? <OffLine id={offId} /> : null}
      <FieldError id={`${V2_CONTROL[side]}-error`} message={errorFor(V2_CONTROL[side])} />
    </fieldset>;
  };
  return <>
    {/* SH-SITE-FIXES-10: the price coin by its own name (as the box page names it, price-coin.ts), no "P =" key. */}
    <p>{`1% of every trade: in ${symbol} on buys, in ${ticker} on sales`}</p><p className="sh-muted">You choose where 10/15 goes</p>
    {only === 'sellers' ? null : card('buyers', buyers)}{only === 'buyers' ? null : card('sellers', sellers)}
    <details className="sh-newbox-more"><summary>Fee details</summary>
      {BOX0 ? <p>2/15 to the FIT Safe · 1/15 to the platform Safe · 2/15 to the pool.</p> : null}
      <p>{`Sale fees in ${ticker} are burned until graduation. After it the box sells them for ${symbol} in its own pool and splits that ${symbol} like the other fees.`}</p>
      <p>{COW_SALES ? `Every box also has an inbox for royalties and gifts in other coins. The box offers coins on its sale list for ${symbol} on CoW. If one does not sell for 30 days, your payee can take it as it is, and any other coin at any time.`
        : 'Every box also has an inbox for royalties and gifts in other coins.'}</p>
      {/* ALCH-TEMPLATE: the inbox's money is booked on the buyers' side (ReceiverBooksV21), so a sellers'-only Alchemist gets
          none; SH-245: with To holders there, its 10/15 goes into the pool instead. */}
      <p data-inbox-side="">{inboxSideLine(choiceOf(buyers))}</p>
      {COW_SALES && isBoxToken(ctx.pricing) ? <p>CoW cannot price box coins, so in this box such sales seldom happen and your payee can take those coins after 30 days.</p> : null}
      <p>{`Keep is claimable by your payee after graduation. ${buyBackBurnLabel(ticker)}: after graduation. Grow the pool adds permanent liquidity.`}</p>
      <p>{`To holders, claimed in ${symbol}: each holder claims its share once a batch is funded and calculated. Nothing is sent automatically. Not converted into ${ticker}. No expiry. Holder fees claimed in ${symbol} stay separate from a failed box’s closing claim.`}</p>
      {collection ? <p>{`To items: every item of this collection gets an equal share in ${symbol}. The item’s current owner claims it, with no expiry and no minimum; nothing is sent automatically. Shares wait until graduation; if the box fails first, they join the closing claim.`}</p> : null}
      {collection ? <p>An item picked just before a payout shares in it: fees and timing decide the result.</p> : null}
      <p>{`Claimed in ${ticker} instead: after graduation the fees buy ${ticker} in this box’s own pool, and holders or items claim that. Nothing is bought before graduation; if the box fails first, the fees join the closing claim.`}</p>
      <p>{`${eatLabel(ctx.pricing)}: after graduation anyone can trigger it, with no tip. ${ctx.pricing.checkedBurn ? `${symbol} records a checked burn, so the share is burned for good.` : `The share is locked forever at a dead address.`} Before graduation it waits; if the box fails first, it joins the closing claim.`}</p>
      {pileInPrice ? <p>To the pile: the share waits until graduation, then anyone moves it into the coin pile. If the box fails first, it joins the closing claim; the seed still goes back to you.</p> : null}
      {/* F153: who starts the steps is the row's own trigger, any address (shown with its route as Started by): never "the keeper". */}
      {alchemist && newest ? <p>{`The Alchemist: after graduation one fixed address starts each step; if a side waits 7 days without one, anyone may start the next. Each step converts at most its row’s amount, and the rest waits for the next one. A step goes along the fixed route, each pool within 49 ticks of its price at the start, or refuses and keeps it waiting for a later try, with no tip. When more than one but less than two full steps are left, two steps split the rest. A step a pool would pay nothing for stays in the box’s pool depth instead, not in the pile, up to its row’s limit; a larger one refuses and waits. It does not know a fair price or promise that a conversion happens. Once anyone may start a step, a trader can move a pool’s price just before it, within the 49 ticks; a step seen early can be traded around the same way. Before graduation the share waits; if the box fails first, it joins the closing claim. ${alchemist.pile.symbol} received joins the pile: handing in ${ticker} takes a share of it, with the pile’s leave-behind.`}</p> : null}
      {shop ? <p>{`Into the shop, sellers’ fees only: after graduation each collected batch buys ${ticker} for the shop in its own pool while the budget is below the ceiling; fees count toward it. When the shop is full, or its room is worth less than one step, the share goes to holders in ${symbol}. The collection time decides, not the trade time: a batch collected after a week ends follows the new week. Picks can take the budget past the ceiling. Before graduation the share waits; if the box fails first, it joins the closing claim.`}</p> : null}
      <p>A paused payout leaves the fee share available to retry.</p>
    </details>
    {saleList && COW_SALES ? <SaleList answer={saleList} ctx={ctx} /> : null}
  </>;
}
