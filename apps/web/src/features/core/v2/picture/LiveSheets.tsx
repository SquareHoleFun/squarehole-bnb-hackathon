/**
 * SH-255: what each part's sheet says on the box page: what today's page said about that part (its header tiles, the
 * Fees, Buy-back progress and Creator's claim cards, the coin pile's and the inbox's figures), numbers first, every
 * explanation behind the sheet's (?), closed by default. Exact amounts as those cards printed them (every digit).
 */
import type { ReactNode } from 'react';
import { formatUnits } from '@squarehole/domain';
import type { BoxRecord } from '../../../boxes/box-model';
import { formatAgo, formatBps } from '../../../fit-pair/fit-format';
import { pileConfigV2 } from '../../../../../../../packages/chain/src/core/v2';
import { PICTURE_WORDS, aboutOf, pictureWords } from '../../../box-picture/picture-words';
import { iconOf, whyOf, SIDES, type PartId, type Side, type StationIcon } from '../../../box-picture/picture';
import { headerStatsV2 } from '../V2BoxPage';
import { sellersToHoldersP } from '../ShopV2';
import { shopAmountV2 } from '../ShopCardsV2';
import type { V2Snapshot } from '../indexer-v2';
import { pAmountV2, tShortV2 } from '../stats-v2';
import { PRICE_STEP_LINE, closedLine, endsInLine } from '../v2-words';
import { failCauseOf } from '../v2-frozen';
import { deadlinePassedV2, timeLeftV2, type LiveCoin, type LiveModel } from './live-picture';
import { BOX_PICTURE_WORDS as W, SHEET_TITLES } from './box-picture-words';
import { TESTNET } from '../../../data-source/testnet';

/**
 * SH-273: whether this build's network has Square Hole's two Safes (the page's Safes panel shows under the same switch,
 * V2BoxPage). BNB Chain testnet has none: the two fees go to the deploy wallet's holding contracts, and FIT is not there.
 */
const SAFES_IN_BUILD = import.meta.env?.SH_BNB !== true && TESTNET.switches.box0;

export type LivePartId = PartId | 'inbox';

export interface LiveSheet {
  readonly title: string;
  readonly icon: StationIcon | 'blank' | 'inbox' | 'mark';
  readonly why: readonly string[];
  readonly whyLabel: string | null;
  readonly body: ReactNode;
}

export interface SheetContext {
  readonly record: BoxRecord;
  readonly view: V2Snapshot;
  readonly model: LiveModel;
  readonly nowSec: bigint;
  readonly pileCoin: LiveCoin | null;
  /** The Creator's claim, as today's card reads it (a live quote after graduation): the page's own component. */
  readonly creatorClaim: ReactNode;
}

interface Row { readonly label: string; readonly value: string; readonly sub?: string | null }
function Facts({ rows }: { rows: readonly Row[] }) {
  if (rows.length === 0) return null;
  return (
    <dl className="sh-bpic-facts">
      {rows.map((row, i) => <div key={`${row.label}-${i}`}><dt>{row.label}</dt><dd>{row.value}{row.sub ? <small>{row.sub}</small> : null}</dd></div>)}
    </dl>
  );
}
function Big({ value, unit }: { value: string; unit?: string | null }) {
  return <p className="sh-bpic-big"><strong>{value}</strong>{unit ? <span>{unit}</span> : null}</p>;
}
const Note = ({ children }: { children: ReactNode }) => <p className="sh-bpic-note">{children}</p>;
/** A box total under the title of the card that showed it (Buy-back progress, Coin pile, Eaten): never a side's own. */
function Results({ title, rows }: { title: string; rows: readonly Row[] }) {
  if (rows.length === 0) return null;
  return <section className="sh-bpic-results" data-results={title}><h3>{title}</h3><Facts rows={rows} /></section>;
}

/** The causes as the indexer names them, as the page's facts read them (V2BoxPage `factsV2`). */
const CAUSE: Readonly<Record<string, number>> = { Deadline: 1, ClosedPastCap: 2, GraduationTimedOut: 3 };

function sideSheet(side: Side, c: SheetContext): LiveSheet {
  const { model, record } = c;
  const fees = model.fees?.[side] ?? null;
  // Exact (round 3, D5): the coin's own decimals, trailing zeros trimmed, never short, as the Buy-back progress rows
  // print theirs. The three parts plus the fee's remainder of 15 make the fee, to the smallest unit.
  const at = (raw: bigint) => formatUnits(raw, model.decimals);
  const printed = fees ? { fee: at(fees.fee), pick: at(fees.pick), pool: at(fees.pool), squareHole: at(fees.squareHole) } : null;
  const input = model.input[side];
  const label = input.label;
  const parts = (n: string, name: string, amount: string | null, key: string) => (
    <li key={key}><span className="sh-pic-ledger__label">{W.partRow(n, name)}</span><span className="sh-pic-ledger__amount">{amount === null ? null : <><b>{amount}</b><small>{model.coin}</small></>}</span></li>
  );
  const waits = model.canGraduate;
  return {
    title: side === 'buyers' ? PICTURE_WORDS.buyersFees : PICTURE_WORDS.sellersFees,
    icon: model.icons[side] !== undefined ? model.icons[side] ?? 'blank' : iconOf(input, model.input.eatBurns) ?? 'blank',
    // The Burn details' line goes with a burning side (today's Buy-back progress card held it).
    why: [...whyOf(side, model.input), ...(side === 'sellers' ? [pictureWords.saleFees(record.ticker, model.coin)] : []), ...(input.choice === 'burn' ? [PRICE_STEP_LINE] : [])],
    whyLabel: aboutOf(side),
    body: (
      <>
        <p className="sh-bpic-muted">{W.everyTrade(model.coin, record.ticker)}</p>
        {printed ? <Big value={printed.fee} unit={model.coin} /> : null}
        <div className="sh-pic-split__bar" aria-hidden="true"><span className="sh-pic-cell--pick" /><span className="sh-pic-cell--pool" /><span className="sh-pic-cell--mark" /></div>
        <ul className="sh-pic-ledger sh-bpic-parts">
          {parts('10', label, printed?.pick ?? null, 'pick')}
          {parts('2', PICTURE_WORDS.pool, printed?.pool ?? null, 'pool')}
          {parts('3', PICTURE_WORDS.squareHole, printed?.squareHole ?? null, 'mark')}
        </ul>
        {fees === null && waits ? <Note>{W.afterGraduation}</Note> : null}
        {boxResults(input.choice, SIDES.every((one) => model.checked[one]), c)}
      </>
    ),
  };
}

/**
 * The box's own totals for a pick, under the title of the card that showed them today, the same in both sides' sheets:
 * the buy-back's (whatever funded it), the coin pile's fees, The Alchemist's conversions (only when EVERY module side
 * of the box is checked as The Alchemist: they are one history over all module sides, D8), the P eaten, a seller
 * shop's rows. Exact, as those cards printed them; a figure not read says so.
 */
function boxResults(choice: string | null, allChecked: boolean, c: SheetContext): ReactNode {
  const { view, model, pileCoin } = c;
  const p = (raw: bigint) => `${formatUnits(raw, view.decimals)} ${model.coin}`;
  // An unread total keeps its titled block, its rows "Unavailable", as the Buy-back progress block does (round 3b, G3).
  const u = W.unavailable;
  if (choice === 'burn') return buyBackResults(c);
  if (choice === 'pile') {
    const fees = view.pileFees ?? null;
    return <Results title={W.coinPile} rows={[{ label: W.feesWaiting, value: fees ? p(fees.pendingP) : u }, { label: W.feesMovedIn, value: fees ? p(fees.movedP) : u }]} />;
  }
  if (choice === 'alchemist' && allChecked) {
    const done = view.alchemist ?? null;
    return <Results title={W.coinPile} rows={[
      { label: W.converted(model.coin), value: done ? p(done.inputP) : u },
      { label: W.addedByConversion, value: addedByConversion(done, pileCoin) },
    ]} />;
  }
  if (choice === 'eat') {
    const eat = view.eat ?? null;
    return <Results title={W.eaten} rows={[{ label: W.eaten, value: eat ? p(eat.eatenP) : u }, { label: W.waiting, value: eat ? p(eat.pendingP) : u }]} />;
  }
  if (choice === 'shop') return shopResults(c);
  return null;
}

/**
 * A seller shop's Fees into the shop rows as ShopV2 prints them (its own words, its own reads: the live budget and
 * ceiling, what fees put in, the P waiting, and the part that went to holders as that card reads it); "Unavailable"
 * where it says so. The card's sums are its own, never added to a fee figure (D2).
 */
function shopResults(c: SheetContext): ReactNode {
  const { view, record, model } = c;
  const fees = view.shopFees ?? null;
  if (!fees) return null;
  const money = fees.money;
  // SH-283: the shop's figures as the shop card prints them (thousands grouped, every digit).
  const t = (raw: bigint) => shopAmountV2(raw, record.ticker);
  const p = (raw: bigint) => shopAmountV2(raw, model.coin, view.decimals);
  const holders = sellersToHoldersP(view);
  return <Results title={W.feesIntoShop} rows={[
    { label: W.shopBudget, value: money ? t(money.budgetT) : W.unavailable },
    { label: W.shopFromFees, value: money ? t(money.feesT) : W.unavailable },
    { label: W.waiting, value: money ? p(money.pendingP) : W.unavailable },
    { label: W.toHolders, value: holders !== null && money ? p(holders) : W.unavailable },
  ]} />;
}

/** What the conversions added to the pile, in the pile's coin; "Unavailable" when the history or the coin is unread. */
function addedByConversion(done: V2Snapshot['alchemist'], pileCoin: LiveCoin | null): string {
  return done && pileCoin ? `${formatUnits(done.receivedAsset, pileCoin.decimals)} ${pileCoin.symbol}` : W.unavailable;
}

/** Today's Buy-back progress card, row for row: in every state, its money rows "Unavailable" while unread. */
export function buyBackResults(c: Pick<SheetContext, 'view' | 'record' | 'model'>): ReactNode {
  const { view, record, model } = c;
  const p = (raw: bigint) => `${formatUnits(raw, view.decimals)} ${model.coin}`;
  return <Results title={W.buyBack} rows={[
    { label: W.spent, value: p(view.buyBack.pSpent) },
    { label: W.burned, value: `${formatUnits(view.buyBack.tBurned, 18)} ${record.ticker}` },
    { label: W.waitingToBurn, value: view.money ? `${formatUnits(view.money.owed.tBurnPending, 18)} ${record.ticker}` : W.unavailable },
    { label: W.budget, value: view.money ? p(view.money.owed.buyBackP) : W.unavailable },
  ]} />;
}

function raiseSheet(c: SheetContext): LiveSheet {
  const { view, model, nowSec } = c;
  const stage = model.stage;
  const timedOut = stage === 'failed' && view.failed?.cause === 'GraduationTimedOut';
  const raise = `${formatUnits(view.record.raise, view.decimals)} ${model.coin}`;
  const progress = stage === 'raising' || stage === 'window' || stage === 'scheduled' ? view.statistics?.raiseProgress ?? null : null;
  const rows: Row[] = [];
  const notes: string[] = [];
  if (progress) rows.push({ label: W.raised, value: `${pAmountV2(progress.raisedP, view.decimals)} / ${raise}` });
  // Chain time decides, as for the page's close control: the count only falls, and meets the deadline as it passes.
  if ((stage === 'raising' || stage === 'window') && view.gate.deadline > 0n) notes.push(deadlinePassedV2(view) ? W.deadlinePassed : endsInLine(timeLeftV2(view)));
  if (stage === 'graduated' || stage === 'graduating') rows.push({ label: W.fullRow, value: formatAgo((view.timestamp > nowSec ? view.timestamp : nowSec) - view.closedAt) });
  // The Graduation hatch card's own words and decision (closeStateOf at the snapshot's block time).
  if (stage === 'graduating') notes.push(model.closable ? W.hatchOpen : W.hatchIn(String((view.closedAt + 604800n - view.timestamp + 3599n) / 3600n)));
  if (stage === 'failed' && view.failed) {
    const cause = failCauseOf(CAUSE[view.failed.cause] ?? 0);
    if (cause) notes.push(closedLine(cause, null, model.coin));
  }
  rows.push({ label: W.deadline, value: `${view.spec.deadlineDays} ${W.days}` });
  return {
    // A box closed after its graduation timed out filled and never graduated: "Full, the box graduates." is withheld
    // there (round 3, D15 b); no other word stands in.
    title: SHEET_TITLES.raise, icon: 'pile', why: [...whyOf('raise', model.input).filter((line) => !(timedOut && line.includes('the box graduates'))), W.recordedRaise(raise)], whyLabel: aboutOf('raise'),
    body: (
      <>
        <Big value={progress ? formatBps(Number(progress.progressBps)) : formatUnits(view.record.raise, view.decimals)} unit={progress ? null : model.coin} />
        {progress ? <div className="sh-bpic-bar" role="progressbar" aria-label={W.raised} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.trunc(Number(progress.progressBps) / 100)}><span style={{ width: `${Number(progress.progressBps) / 100}%` }} /></div> : null}
        <Facts rows={rows} />
        {notes.map((line) => <Note key={line}>{line}</Note>)}
      </>
    ),
  };
}

function contentsSheet(c: SheetContext): LiveSheet {
  const { view, model, pileCoin } = c;
  const why = whyOf('contents', model.input);
  if (model.items) {
    return {
      title: SHEET_TITLES.contents, icon: 'collection', why, whyLabel: aboutOf('contents'),
      body: (
        <>
          <Big value={model.items.count} unit={PICTURE_WORDS.kindCollection} />
          <Facts rows={[
            ...(view.vaultItems ? [{ label: W.outRow, value: String(view.vaultItems.known.filter((item) => !item.inside).length) }] : []),
            { label: W.pickFee, value: `${view.spec.pickFeeBps / 100}%` },
          ]} />
        </>
      ),
    };
  }
  if (model.input.pile) {
    const config = (() => { try { return pileConfigV2(view.spec.contentsParams); } catch { return null; } })();
    const rows: Row[] = [];
    if (config && pileCoin) rows.push({ label: W.seed, value: `${formatUnits(config.seedAmount, pileCoin.decimals)} ${pileCoin.symbol}` });
    if (view.pileFees) rows.push({ label: W.feesMovedIn, value: `${formatUnits(view.pileFees.movedP, view.decimals)} ${model.coin}` });
    // One history over every module side: only when each module side is checked as The Alchemist (round 3b, G2), and
    // "Unavailable" while the history or the pile's coin is unread (G3).
    if (view.alchemist !== undefined && SIDES.some((side) => view.choices[side] === 'module') && SIDES.every((side) => model.checked[side])) rows.push({ label: W.addedByConversion, value: addedByConversion(view.alchemist, pileCoin) });
    if (config) rows.push({ label: W.leaveBehind, value: `${config.leaveBehindBps / 100n}%` });
    return { title: PICTURE_WORDS.kindPile, icon: 'pile', why, whyLabel: aboutOf('contents'), body: <>{pileCoin ? <Big value={pileCoin.symbol} /> : null}<Facts rows={rows} /></> };
  }
  // A shop: its items, gives and picks are the Shop card's; the sheet names it and leads there (ShopV2 below).
  if (model.input.contents === 'shop') return { title: SHEET_TITLES.contents, icon: 'shop', why, whyLabel: aboutOf('contents'), body: <Big value={PICTURE_WORDS.kindShop} /> };
  return { title: SHEET_TITLES.contents, icon: 'liquidity', why, whyLabel: aboutOf('contents'), body: <><Big value={PICTURE_WORDS.kindToken} /><p className="sh-bpic-muted">{W.noNfts}</p></> };
}

function poolSheet(c: SheetContext): LiveSheet {
  const { model, view, record } = c;
  // A closed box's pool never opens: its (?) keeps no promise that it will.
  // A box that can no longer graduate: its pool never opens, so no promise that it will (canStillGraduateV2).
  const why = model.poolOpen || model.canGraduate ? whyOf('pool', model.input) : whyOf('pool', model.input).filter((line) => !line.includes(W.poolOpens));
  if (!model.poolOpen) return { title: SHEET_TITLES.pool, icon: 'liquidity', why, whyLabel: aboutOf('pool'), body: <><Big value="2" unit={W.ofFifteen} />{model.canGraduate ? <Note>{W.poolOpens}</Note> : null}</> };
  const price = headerStatsV2(record, view).find((stat) => stat.label === 'Price');
  const rows: Row[] = [];
  if (model.poolCoins) rows.push({ label: W.inThePool, value: `${pAmountV2(model.poolCoins.price, view.decimals)} ${model.coin}`, sub: `${tShortV2(model.poolCoins.token)} ${record.ticker}` });
  if (price) rows.push({ label: price.label, value: String(price.value), sub: price.unit ?? null });
  if (model.fees) rows.push({ label: W.fromFees, value: `${formatUnits(model.fees.buyers.pool + model.fees.sellers.pool, view.decimals)} ${model.coin}` });
  return { title: SHEET_TITLES.pool, icon: 'liquidity', why, whyLabel: aboutOf('pool'), body: <Facts rows={rows} /> };
}

export function sheetOf(id: LivePartId, c: SheetContext): LiveSheet {
  const { record, view, model } = c;
  switch (id) {
    case 'buyers': case 'sellers': return sideSheet(id, c);
    case 'raise': return raiseSheet(c);
    case 'contents': return contentsSheet(c);
    case 'pool': return poolSheet(c);
    case 'token': {
      const stats = headerStatsV2(record, view);
      // Today's Buy-back progress card on every box: an item rule can fund the buy-back with no side picking it.
      return { title: pictureWords.tokenName(record.ticker), icon: 'liquidity', why: whyOf('token', model.input), whyLabel: aboutOf('token'),
        body: <><Facts rows={stats.map((stat) => ({ label: stat.label, value: String(stat.value), sub: stat.unit ?? null }))} />{buyBackResults(c)}</> };
    }
    case 'price': {
      const price = headerStatsV2(record, view).find((stat) => stat.label === 'Price');
      return { title: SHEET_TITLES.price, icon: 'liquidity', why: whyOf('price', model.input), whyLabel: aboutOf('price'),
        body: <><Big value={model.coin} />{price ? <Facts rows={[{ label: price.label, value: String(price.value), sub: price.unit ?? null }]} /> : null}<p className="sh-v2-address">{view.record.q}</p></> };
    }
    case 'creator': {
      const start = view.spec.creatorBuy;
      return { title: SHEET_TITLES.creator, icon: 'creator', why: whyOf('creator', model.input), whyLabel: aboutOf('creator'),
        body: <>{c.creatorClaim}{start > 0n ? <Facts rows={[{ label: W.atStart, value: `${formatUnits(start, view.decimals)} ${model.coin}` }]} /> : null}<p className="sh-v2-address">{view.record.creator}</p></> };
    }
    case 'holders': {
      const to = SIDES.filter((side) => model.input[side].choice === 'holders' || model.input[side].choice === 'holders-t');
      // What holders were paid, in each coin they are paid in: the price coin from the holder ledger's batches (a holders
      // side, or a shop's sellers' share it did not take), the box's coin from the T payouts.
      const inP = to.some((side) => model.input[side].choice === 'holders') || view.choices.sellers === 'shop';
      const inT = to.some((side) => model.input[side].choice === 'holders-t');
      const batches = view.m2?.history?.batches ?? null;
      const paidP = inP && batches ? Object.values(batches).reduce((sum, batch) => sum + batch.paidP, 0n) : null;
      const paidT = inT ? view.payInT?.history?.holdersPaidT ?? null : null;
      const paid: Row[] = [
        ...(paidP !== null ? [{ label: W.paid, value: `${formatUnits(paidP, view.decimals)} ${model.coin}` }] : []),
        ...(paidT !== null ? [{ label: W.paid, value: `${formatUnits(paidT, 18)} ${record.ticker}` }] : []),
      ];
      return { title: SHEET_TITLES.holders, icon: 'holders', why: whyOf('holders', model.input), whyLabel: aboutOf('holders'),
        body: (
          <>
            {/* Unread statistics: the sheets' word for an unread figure (review fix 6). */}
            <Big value={model.holders ?? W.unavailable} />
            {to.length > 0 ? <p className="sh-bpic-muted">{to.map((side) => model.input[side].label).filter((v, i, all) => all.indexOf(v) === i).join(' · ')}</p> : null}
            {model.stage === 'graduated' ? <Facts rows={paid} /> : null}
            {to.length > 0 && model.canGraduate ? <Note>{W.afterGraduation}</Note> : null}
          </>
        ) };
    }
    case 'mark':
      // The fee split is an explanation: behind the (?), closed by default, like every other sheet's.
      // Its 3 parts of the collected fees (exact), then what the Safes were paid under the Safes card's own title: a box
      // total (royalties split through the receiver reach the Safes too), never beside the fee parts as if it were them.
      // The (?) holds the explainer's split line once (whyOf('mark')); the Fee details line said the same again.
      return { title: SHEET_TITLES.mark, icon: 'mark', why: whyOf('mark', model.input), whyLabel: aboutOf('mark'),
        body: <>
          {model.fees ? <Big value={formatUnits(model.fees.buyers.squareHole + model.fees.sellers.squareHole, view.decimals)} unit={model.coin} /> : <Big value="3" unit={W.ofFifteen} />}
          {/* Published payouts in every phase (the receiver pays the Safes while the box raises too; round 3b, G4). */}
          {SAFES_IN_BUILD ? <Results title={W.safePayouts} rows={[
            { label: W.paidToFit, value: view.safePaid ? `${formatUnits(view.safePaid.fit[view.record.q.toLowerCase()] ?? 0n, view.decimals)} ${model.coin}` : W.unavailable },
            { label: W.paidToPlatform, value: view.safePaid ? `${formatUnits(view.safePaid.platform[view.record.q.toLowerCase()] ?? 0n, view.decimals)} ${model.coin}` : W.unavailable },
          ]} /> : null}
        </> };
    case 'inbox': {
      // The Inbox card's three cases: the royalties in the price coin (read with the box's money), the other coins (read
      // with its balances), and a read that missed some coins.
      const inbox = model.inbox;
      return { title: SHEET_TITLES.inbox, icon: 'inbox', why: [W.inboxWhy], whyLabel: W.aboutInbox,
        body: (
          <>
            <Facts rows={[
              ...(inbox.royaltyHeld !== null ? [{ label: W.royaltiesIn(model.coin), value: `${formatUnits(inbox.royaltyHeld, view.decimals)} ${model.coin}` }] : []),
              ...(inbox.coins !== null ? [{ label: W.otherCoins, value: String(inbox.coins) }] : []),
            ]} />
            {inbox.royaltyHeld === null ? <Note>{W.balancesUnavailable}</Note> : null}
            {inbox.coins === null ? <Note>{W.inboxUnavailable}</Note> : !inbox.complete ? <Note>{W.someCoinsUnread}</Note> : null}
          </>
        ) };
    }
  }
}
