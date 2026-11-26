import { formatUnits } from '@squarehole/domain';
import { Suspense, lazy } from 'react';
import { Link } from 'react-router';
import type { Address } from 'viem';
import { PAGE_TITLE_ID, PageHeading, usePageTitle } from '../../../pages/page-parts';
import type { BoxRecord } from '../../boxes/box-model';
import { BoxHeader, type Stat } from '../../boxes/BoxHeader';
import { shortAddress } from '../../fit-pair/fit-format';
import { CopyButton } from '../../pair/CopyButton';
import { BackIcon } from '../../pair/pair-icons';
import { AddPictureV2 } from './AddPictureV2';
import { phaseV2, summaryV2 } from './record-v2';
import { rolesOfV2 } from '../../../../../../packages/chain/src/core/v2';
import { useClockMs } from '../useCore';
import { closeStateOf, type BoxV2Facts } from './box-v2';
import { failCauseOf } from './v2-frozen';
import { address, checkingV2, claimPriceV2, shopCeilingPresetV2, type V2Snapshot, type V2Source } from './indexer-v2';
import { closingPricePerMillionV2, NO_FIGURE, pAmountV2, tShortV2 } from './stats-v2';
import { V2Actions } from './V2Actions';
import { BurnLogV2 } from './BurnLogV2';
import { SafesV2 } from './SafesV2';
import './v2-page.css';
import { ShopV2 } from './ShopV2';
import { HolderEarningsV2 } from './HolderEarningsV2';
import { ItemPayoutsV2, inVaultText } from './ItemPayoutsV2';
import { VaultItemsV2, vaultMovesOpenV2 } from './VaultItemsV2';
import { vaultRolesOf } from './vault-items';
import { CoinPileV2, pileRedeemOpenV2 } from './CoinPileV2';
import { ClaimAllV2 } from './ClaimAllV2';
import { hasClaimsV2, useCreatorQuoteV2 } from './claim-reads';
import { DisclosureIcon } from '../../fit-pair/FitParts';
import { eatLabelV21, itemPoliciesV2 } from '../../../../../../packages/chain/src/core/v2';
import { EatenV2 } from './EatenV2';
import { pileConfigV2 } from '../../../../../../packages/chain/src/core/v2';
import { useBoxAlchemist } from '../../create/v2/alchemist';
import { buyBackBurnLabel } from '../../create/v2/fee-words';
import { InboxV2 } from './InboxV2';
import { LaunchTaxV2 } from './LaunchTaxV2';
import { LifeActivityCardV2, LifeMarketV2, LifeStripV2, useLifeV2 } from './LifeViewV2';
import { figuresOfV2 } from './StatsV2';
import { TRADE_IN_BUILD, TradeSlotMount } from './TradeSlotMount';
import { HiddenDrawsV2 } from './HiddenDrawsV2';
import { RevealCopyV2 } from './RevealCopyV2';
import { BoxLinksV2 } from './BoxLinksV2';
import { RevealEntryV2, opensReveal, useBoxSubView, useIsBoxCreator } from './RevealEntryV2';
import { RevealItemsV2 } from './RevealItemsV2';
import { usdNote, usdPriceFor, usdText } from './usd-v2';
import { usePricedViewV2 } from './box-prices-v2';
import { blocksDuration } from '../../data-source/chain-clock';
import { TESTNET } from '../../data-source/testnet';
import { PartBoundary } from '../../../shell/PartFailed';
import { usePileCoin } from './pile-coin';
import type { DoEntry } from './picture/BoxPagePicture';
import { BOX_PICTURE_WORDS } from './picture/box-picture-words';

/**
 * SH-255: the top of the page as the box's picture (picture/BoxPagePicture.tsx): its own chunk, loaded once a v2 box
 * page mounts. While it loads, the name; if it cannot load, today's header in its place (the page stays).
 */
const BoxPagePicture = lazy(() => import('./picture/BoxPagePicture'));
/** The places on the page that What you can do here leads to. */
const PLACE = Object.freeze({ claims: 'sh-box-place-claims', pile: 'sh-box-place-pile', vault: 'sh-box-place-vault' });
/** The choices whose words need nothing from the box; eating names its coin, a T payout the box token (v2.1). */
const CHOICE_WORDS = { keep: 'Keep', burn: 'Burn', grow: 'Grow the pool', holders: 'To holders', pile: 'To the pile', module: 'Fee module', shop: 'Into the shop' } as const;
export function factsV2(view: V2Snapshot, network: 'local' | 'sepolia', symbol = 'P'): BoxV2Facts {
  return { network, coordinator: address(rolesOfV2(view.record).contracts.coordinator), pricing: { symbol, decimals: view.decimals, address: view.record.q }, openAt: view.record.openAt,
    gateOpen: view.gate.open, effectiveOpenAt: view.gate.effectiveOpenAt, deadline: view.gate.deadline, closedAt: view.closedAt, curve: view.graduated ? 'graduated' : view.closedAt > 0n ? 'filled' : 'open',
    failure: view.failed ? { cause: failCauseOf(({ Deadline: 1, ClosedPastCap: 2, GraduationTimedOut: 3 } as Record<string, number>)[view.failed.cause] ?? 0) ?? 'deadline', at: view.failed.at, closing: null } : null,
    tipMaxQ: 0n, tImplementation: view.verified ? view.release.implementations.token.address : null, releaseTImplementation: view.release.implementations.token.address };
}
/**
 * A side's fee choice: an items side also names its in-vault rule (Keep, Burn or Grow the pool), a payout in the box token names that
 * token, and eating names the price coin by the receiver's own creation snapshot (Burn or Lock; Unavailable unread).
 */
export function feeText(view: V2Snapshot, side: 'buyers' | 'sellers', coin: string, ticker: string, alchemist = false): string {
  const picked = view.choices[side];
  if (!picked) return 'Unavailable';
  const policies = itemPoliciesV2(view.spec);
  const vault = () => inVaultText({ buyers: side === 'buyers' ? policies.buyers : 0, sellers: side === 'sellers' ? policies.sellers : 0 }, ticker);
  switch (picked) {
    case 'eat': return view.eat ? eatLabelV21(coin, view.eat.burned ? '0x42966c68' : '0x00000000') : 'Unavailable';
    case 'burn': return buyBackBurnLabel(ticker || 'the box coin');
    case 'holders-t': return `To holders · in ${ticker}`;
    case 'items': return `To items · ${vault()}`;
    case 'items-t': return `To items · in ${ticker} · ${vault()}`;
    case 'shop': { const preset = shopCeilingPresetV2(view.spec); return preset === null ? CHOICE_WORDS.shop : `${CHOICE_WORDS.shop} · ceiling ${preset}x the seed`; }
    // v2.1 step 8: a module side checked on chain as The Alchemist for this pile's coins; any other action stays "Fee module".
    case 'module': return alchemist ? 'The Alchemist' : CHOICE_WORDS.module;
    default: return CHOICE_WORDS[picked];
  }
}
/**
 * The page's status line: a stale read, a new box not checked yet (the indexer audits every 32 blocks), or one not
 * verified (refuted, or an older box whose audit could not run).
 */
export function statusLine(view: Pick<V2Snapshot, 'audited' | 'verified' | 'block' | 'record'>, stale: boolean): string | null {
  if (stale) return 'Stale · actions wait for a current verified read.';
  // SH-258: Sepolia's sentence as it was; another test network's from its own block time.
  if (checkingV2(view)) return TESTNET.name === 'sepolia' ? 'Checking · a new box is checked within 32 blocks, about 6 minutes on Sepolia.'
    : `Checking · a new box is checked within 32 blocks, ${blocksDuration(32)} on ${TESTNET.networkName}.`;
  return view.verified ? null : 'Unverified · actions wait for a current verified read.';
}
/**
 * The creator's claim: after graduation the receiver's next payment to its payee (FINAL-OC01, the same quote as Claim
 * all, read as the payee), "Unavailable" when that read fails; before graduation the stored figure, with what is held.
 */
function CreatorClaimV2({ source, view, p }: { source: V2Source; view: V2Snapshot; p: (amount: bigint) => string }) {
  const { state, failed } = useCreatorQuoteV2(source, view);
  const money = view.money;
  const live = view.graduated && !view.failed;
  const value = !money ? 'Unavailable' : !live ? p(money.creatorOwed) : /^0x0{40}$/i.test(money.creatorPayee) ? 'No payee' : failed ? 'Unavailable'
    : state.kind === 'ready' ? p(state.read.amount) : state.kind === 'none' ? p(0n) : state.kind === 'claimed' ? 'Claimed' : '—';
  return <section className="sh-panel"><h2>Creator’s claim</h2><p>{value}</p>
    {money ? <details><summary>Payee and held fees</summary><p className="sh-v2-address">{money.creatorPayee}</p><p>{`${p(money.creatorHeld)} held until graduation.`}</p></details> : null}
  </section>;
}

const chose = (view: V2Snapshot, ...choices: readonly string[]) => choices.includes(view.choices.buyers ?? '') || choices.includes(view.choices.sellers ?? '');

/**
 * RC5-A (F136): a failed box's claims never close and nothing is swept to FIT. Once every counted coin has been handed
 * in, what the pot still holds beyond the creator's no-buyer remainder has no claim left: it stays locked for good.
 * RC6 (F138, INBOX af2): inbox P that reaches the pot later is added to that remainder, which `quoteClaim(0)` reports.
 */
export function lockedForGoodP(closing: { readonly pot: bigint; readonly tLeft: bigint; readonly creatorEntitlement: bigint }): bigint {
  return closing.tLeft === 0n && closing.pot > closing.creatorEntitlement ? closing.pot - closing.creatorEntitlement : 0n;
}

/**
 * RC6-RR-INBOX: what the coordinator's pot holds, and the inbox P a claim still moves in first (null: none to show).
 * A no-buyer box's claimState pot counts the inbox's readable P, which only the creator's claim moves into the pot; a
 * holder box's pot does not, and its next claim sweeps it in. Once every counted coin is in, no claim can take it.
 */
export function inboxPartOf(closing: NonNullable<V2Snapshot['closing']>): { readonly held: bigint; readonly waiting: bigint | null; readonly creator: boolean } {
  const waiting = closing.inboxP ?? null;
  const creator = closing.initialT === 0n;
  const held = creator && waiting !== null && closing.pot >= waiting ? closing.pot - waiting : closing.pot;
  const claimable = creator || closing.tLeft > 0n;
  return { held, waiting: claimable && waiting !== null && waiting > 0n ? waiting : null, creator };
}

/**
 * SH-BOX-LIFE-VIEW: a closed box's card in the market's place, numbers first like every other moment of its life: the
 * claim price per 1M of the box's coins, the pot and the coins left, short (the holders are the activity's tab). The
 * exact digits and every explanation wait behind the closed Claim details (the exact pot line word for word, as the
 * chain suites read it).
 */
function ClosingCardV2({ record, view, now, failedAt }: { record: BoxRecord; view: V2Snapshot; now: bigint; failedAt: bigint }) {
  const closing = view.closing;
  const coin = record.pairAsset;
  const p = (amount: bigint) => `${formatUnits(amount, view.decimals)} ${coin}`;
  const exact = closing ? claimPriceV2(closing.pot, closing.tLeft, view.decimals) : null;
  const short = closing ? closingPricePerMillionV2(closing.pot, closing.tLeft, view.decimals) : null;
  const part = closing ? inboxPartOf(closing) : null;
  const locked = closing ? lockedForGoodP(closing) : 0n;
  return <section className="sh-panel sh-v2-stats sh-life-closing" aria-label="Failure claim"><h2>Closing price</h2>
    {/* The price and its unit are two runs, so on a phone the digits keep one line and the unit may follow (SH-V2-FE4). */}
    <p className="sh-v2-value sh-v2-price">{short === null ? closing?.tLeft === 0n ? 'No coins left to claim' : 'Not available' : <>{`${short} `}<span className="sh-v2-unit">{`${coin} per 1M ${record.ticker}`}</span></>}</p>
    {closing && part ? <dl className="sh-v2-stats__grid">
      <div><dt>Claim pot</dt><dd><span className="sh-v2-stats__value">{pAmountV2(part.held, view.decimals)}</span> <span className="sh-v2-stats__unit">{coin}</span></dd></div>
      <div><dt>Coins left</dt><dd><span className="sh-v2-stats__value">{tShortV2(closing.tLeft)}</span> <span className="sh-v2-stats__unit">{record.ticker}</span></dd></div>
    </dl> : <p>Current claim balances unavailable.</p>}
    {part && part.waiting !== null ? <p>{`${p(part.waiting)} waits in the inbox; the ${part.creator ? 'creator’s' : 'next'} claim moves it into the pot first.`}</p> : null}
    {locked > 0n ? <p>{`Locked for good ${p(locked)}`}</p> : null}
    <details><summary>Claim details</summary>
      {exact !== null ? <p>{`Exact: ${exact} ${coin} per ${record.ticker}`}</p> : null}
      {closing && part ? <p>{`Claim pot ${p(part.held)} · ${formatUnits(closing.tLeft, 18)} coins left`}</p> : null}
      <p>Each claim receives its share of the current pot. The last counted coin takes the remaining pot. Claims never close.</p>
      <p>{`Each holder claim first moves the fees still in the box and the inbox’s ${coin} into the pot, then takes its share. The share of coins nobody hands in, and money arriving after the last claim, stay locked for good: nobody can take them out, Square Hole included.`}</p>
      {closing && closing.creatorEntitlement > 0n ? <p>{`Creator remainder: ${p(closing.creatorEntitlement)}`}</p> : null}
      {/* R2-4a: only a box nobody bought (no coins counted at failure); after a last holder claim tLeft is 0 as well. */}
      {closing && closing.initialT === 0n ? <><p>{`With no buyers, inbox ${coin} that reaches the pot later is added to the creator remainder.`}</p>
        {/* RC6RR2-FC-2: claim(0) takes msg.sender == the immutable creator; a rotated fee payee cannot claim it. */}
        <p>Only the address that made the box can claim it, to any address it names, not a later fee payee.</p></> : null}
      {record.itemCount > 0n ? <p>{now < failedAt + 1209600n ? `Item hand-back: ${(failedAt + 1209600n - now + 86399n) / 86400n} days left` : 'The 14-day item hand-back window has ended.'}</p> : null}
    </details>
  </section>;
}

/**
 * SH-224: the header's number tiles. An open or graduated box: the market's five figures (the market card shows them no
 * more), each with its unit; a closed box: its closing card's three (its closing price per 1M, the claim pot, the coins
 * left), the card's own words.
 */
export function headerStatsV2(record: BoxRecord, view: V2Snapshot, nowSec?: bigint): Stat[] {
  const coin = record.pairAsset;
  // SH-266: "about $X" beside a coin figure, only while the indexer's Atlas price of the coin is fresh; source and age
  // behind the (i).
  const usd = nowSec === undefined ? null : usdPriceFor(view.prices, view.record.q, nowSec);
  const inUsd = (raw: bigint | null | undefined): Pick<Stat, 'unit' | 'info'> => usd && nowSec !== undefined && raw != null
    ? { unit: `${coin}, ${usdText(raw, view.decimals, usd)}`, info: usdNote(usd, nowSec) } : { unit: coin };
  if (view.failed) {
    const closing = view.closing;
    const part = closing ? inboxPartOf(closing) : null;
    const short = closing ? closingPricePerMillionV2(closing.pot, closing.tLeft, view.decimals) : null;
    return [
      { label: 'Closing price', value: short ?? (closing?.tLeft === 0n ? 'No coins left to claim' : 'Not available'), unit: `${coin} per 1M ${record.ticker}` },
      { label: 'Claim pot', value: part ? pAmountV2(part.held, view.decimals) : 'Not available', unit: coin },
      { label: 'Coins left', value: closing ? tShortV2(closing.tLeft) : 'Not available', unit: record.ticker },
    ];
  }
  const f = figuresOfV2(view);
  return [
    { label: 'Price', value: f.price, unit: `${coin} per 1M ${record.ticker}` },
    { label: 'Market cap', value: f.marketCap, ...(f.marketCap === NO_FIGURE ? { unit: coin } : inUsd(view.statistics?.marketCapP)) },
    { label: 'Holders', value: f.holders },
    { label: 'Burned', value: f.burned, unit: record.ticker },
    { label: '24h volume', value: f.volume24h, ...inUsd(view.statistics?.volume24hP) },
  ];
}

/**
 * SH-255: What you can do here: plain entries, each leading to the page's own control below (none asks a wallet):
 * claims, the coin pile's Redeem, the items' Put back (a box anyone may close keeps its own Close box button below).
 */
export function doEntriesV2(view: V2Snapshot, at: { readonly ticker: string; readonly revealing?: boolean }): readonly DoEntry[] {
  const W = BOX_PICTURE_WORDS;
  const entries: DoEntry[] = [];
  // The creator's Reveal items view replaces every control an entry leads to: no entries there.
  if (at.revealing) return entries;
  // Round 3 (D10): one predicate per entry, the card's own, fed with the card's own inputs. "Pay in" and "Take one
  // out" are not offered: their cards decide from reads (the trade slot's chunk, the vault's shelf) a list cannot share
  // without a second read or a second copy of their logic.
  if (hasClaimsV2(view)) entries.push({ key: 'claim', icon: 'claim', label: W.claim, note: null, target: PLACE.claims });
  if (view.spec.boxType === 5 && pileRedeemOpenV2(view)) entries.push({ key: 'pile', icon: 'pile', label: W.handIn(at.ticker), note: null, target: PLACE.pile });
  // Put it back: the reader's own Put back when one is there, else the Items card's first control (review fix 7).
  if (vaultRolesOf(view) && vaultMovesOpenV2(view)) entries.push({ key: 'in', icon: 'in', label: W.putBack, note: null, target: PLACE.vault, firstControl: true });
  // A box anyone may close: no entry here; its Close box button and the hatch card sit right under the picture, and a
  // second control of the same name would be ambiguous.
  return entries;
}

/**
 * SH-255: the coin pile's asset as the pile's own card reads it (CoinPileV2: its money's, else its history's); null
 * without either, or for a box without a pile, so the picture asks for no coin the card did not.
 */
export function pileAssetOfV2(view: V2Snapshot): Address | null {
  if (view.spec.boxType !== 5) return null;
  return (view.m3?.pileMoney?.asset ?? view.m3?.pile?.asset ?? null) as Address | null;
}

export function V2BoxPage({ record }: { record: BoxRecord }) {
  usePageTitle(`${record.ticker} · ${record.name}`);
  const view = record.v2Chain?.snapshot; const source = record.v2Chain?.source;
  // SH-224 phase 4: the fallback's name wraps like the header's (a long name without a space never widens the page).
  if (!view || !source) return <section className="sh-page sh-v2-fallback"><PageHeading>{record.name}</PageHeading><p role="status">V2 box data unavailable</p></section>;
  return <V2BoxView record={record} view={view} source={source} />;
}

function V2BoxView({ record, view: listed, source }: { record: BoxRecord; view: V2Snapshot; source: V2Source }) {
  // SH-306: the feed's cards carry no `prices` (the indexer publishes them on the box's own answer only): this page
  // reads them from its own box's answer, once a minute while visible, and lays them over the feed's view, so the
  // header, the pile and the holders' share show their dollar figures (SH-266). No answer: the view as listed.
  const view = usePricedViewV2(source, listed);
  const now = BigInt(Math.floor(useClockMs(1000) / 1000));
  // The price coin by its own name (SH-BOX-LIFE-VIEW § 3): the record carries it (ETH, its symbol, or its short address).
  const coin = record.pairAsset;
  const stale = view.stale || (source.network === 'sepolia' && now > view.timestamp + 60n);
  const close = closeStateOf(factsV2(view, source.network, coin), view.timestamp);
  const p = (amount: bigint) => `${formatUnits(amount, view.decimals)} ${record.pairAsset}`;
  const tokenImplementation = rolesOfV2(view.record).contracts.holderLedger ? view.release.implementations.tokenLedger?.address : view.release.implementations.token.address;
  const failedAt = view.failed ? view.failed.at : null;
  // v2.1 step 8: each module side's snapshot, checked as The Alchemist for this pile's coins (view calls, no wallet).
  const pileCoins = view.spec.boxType === 5 ? (() => { try { return { priceCoin: view.record.q, pileCoin: pileConfigV2(view.spec.contentsParams).asset }; } catch { return null; } })() : null;
  const buyersAlchemist = useBoxAlchemist(source, view.choices.buyers === 'module' ? view.modules?.buyers ?? null : null, pileCoins, view.release);
  const sellersAlchemist = useBoxAlchemist(source, view.choices.sellers === 'module' ? view.modules?.sellers ?? null : null, pileCoins, view.release);
  // SH-BOX-LIFE-VIEW: one live activity read for the strip (in the header), the market and the activity card.
  const life = useLifeV2(record, view, source);
  const state = phaseV2(view);
  const summary = summaryV2(record, view, stale);
  const status = statusLine(view, stale);
  const disabled = stale || !view.verified;
  const key = (part: string) => `${part}:${source.manifest.chainId}:${view.token}`;
  // SH-203: the creator's "Reveal items" view in place of the box's parts (`?view=reveal`); anyone else sees the box.
  const [subView, setSubView] = useBoxSubView();
  const creator = useIsBoxCreator(view);
  const revealing = subView === 'reveal' && creator && opensReveal(view);
  const openReveal = () => setSubView('reveal');
  // SH-255: the coin pile's coin, from the asset the pile's own card reads (CoinPileV2: its money's, else its history's),
  // so the picture shares that card's one listings read and makes none the card does not; unknown without them.
  const pileAsset = pileAssetOfV2(view);
  const pileListed = usePileCoin(source, (pileAsset ?? '0x0000000000000000000000000000000000000000') as Address, pileAsset !== null, view.release);
  const pileCoin = pileAsset === null ? null : pileListed;
  const alchemist = { buyers: buyersAlchemist !== null, sellers: sellersAlchemist !== null };
  const idLine = <>
    <p className="sh-fit-ca sh-fit-ca--compact"><strong>{record.ticker}</strong><code className="sh-fit-ca__short" title={record.token}>{shortAddress(record.token)}</code><CopyButton value={record.token} label={`Copy the ${record.ticker} contract address`} /></p>
    {/* LINKS-WEB: the creator's signed links; Edit links (Add links) for the connected creator only. */}
    <BoxLinksV2 key={key('links')} source={source} token={view.token} creator={view.record.creator} inFeed links={view.links} asOf={view.timestamp} feedRead={record.v2Chain?.read ?? null} />
  </>;
  const notice = <>
    {status ? <p className="sh-box-notice" role="status">{status}</p> : null}
    {/* SH-ARWEAVE-PICTURES-WEB: a logo or cover on no gateway: anyone may add the committed picture (no wallet). */}
    <AddPictureV2 record={record} />
  </>;
  // Where the picture cannot load (its chunk failed): today's header and today's three money cards (Fees, Buy-back
  // progress, the Creator's claim) right under it, word for word, so the page keeps every figure and line it had.
  const moneyCards = <div className="sh-v2-cards" data-fallback-cards="">
    <section className="sh-panel"><h2>Fees</h2><p>{`1% of every trade: in ${coin} on buys, in ${record.ticker} on sales`}</p>
      <dl><div><dt>Buyers’ fees</dt><dd>{feeText(view, 'buyers', coin, record.ticker, buyersAlchemist !== null)}</dd></div><div><dt>Sellers’ fees</dt><dd>{feeText(view, 'sellers', coin, record.ticker, sellersAlchemist !== null)}</dd></div></dl>
      <details><summary>Fee details</summary>{(import.meta.env?.SH_BNB !== true && TESTNET.switches.box0) ? <p>2/15 to the FIT Safe · 1/15 to the platform Safe · 2/15 to the pool · 10/15 by the choice on each side.</p> : null}<p>{`Sale fees in ${record.ticker} are burned until graduation. After it the box sells them for ${coin} in its own pool and splits that ${coin} like the other fees.`}</p><p>{`Recorded raise: ${p(view.record.raise)}. Later listing changes apply only to new boxes.`}</p><p className="sh-v2-address">{view.record.q}</p></details>
    </section>
    <section className="sh-panel"><h2>Buy-back progress</h2><dl>
      <div><dt>Spent</dt><dd>{p(view.buyBack.pSpent)}</dd></div><div><dt>Burned</dt><dd>{formatUnits(view.buyBack.tBurned, 18)} {record.ticker}</dd></div>
      <div><dt>Waiting to burn</dt><dd>{view.money ? `${formatUnits(view.money.owed.tBurnPending, 18)} ${record.ticker}` : 'Unavailable'}</dd></div>
      <div><dt>Budget</dt><dd>{view.money ? p(view.money.owed.buyBackP) : 'Unavailable'}</dd></div>
    </dl><details><summary>Burn details</summary><p>Buys pay the 1% fee. Buy-backs and deepening share one step per block within 49 ticks. Coins bought are burned or wait to burn.</p></details></section>
    {/* Not in the creator's Reveal view, where today's page had no creator card either (no read added there). */}
    {revealing ? null : <CreatorClaimV2 source={source} view={view} p={p} />}
  </div>;
  const header = <BoxHeader className="sh-v2-head" record={record} state={state} band={{ figure: summary.figure.text, barBps: summary.figure.barBps }} line={record.line} idLine={idLine} phase={null} notice={notice}
    stats={headerStatsV2(record, view, now)} counters={null} side={<>{record.line ? <p className="sh-v2-head__line">{record.line}</p> : null}<LifeStripV2 steps={life.steps} stage={life.stage} /></>} />;
  const entries = doEntriesV2(view, { ticker: record.ticker, revealing });
  return <section className="sh-page sh-fit-page sh-box-page sh-v2-page" aria-labelledby={PAGE_TITLE_ID}>
    {/* SH-224: the first box's page top (BoxHeader) for every v2 box: the same back link, the picture with the state band,
       the chips, the name, the address with Copy, the life strip at the side and the market's figures as number tiles. */}
    <p className="sh-pair-back"><Link to="/" className="sh-pair-back__link"><BackIcon />Boxes</Link></p>
    {/* SH-273: the picture and the market in one place, so that on a wide page the chart, the trades and the holders sit
       in the picture's column right under it and the trade box, the claims and the actions under the right column
       (v2-page.css .sh-v2-lead); on a phone the order is the page's as before. */}
    <div className="sh-v2-lead">
    <PartBoundary fallback={<>{header}{moneyCards}</>}>
      <Suspense fallback={<header className="sh-bpic-loading"><PageHeading>{record.name}</PageHeading></header>}>
        <BoxPagePicture record={record} view={view} life={{ steps: life.steps, stage: life.stage, nowSec: life.nowSec }} alchemist={alchemist} pileCoin={pileCoin}
          idLine={idLine} notice={notice} creatorClaim={<CreatorClaimV2 source={source} view={view} p={p} />} entries={entries} closable={close.kind === 'closable'} />
      </Suspense>
    </PartBoundary>
    {/* The box's life and what a visitor does: the chart (or a closed box's closing price) with the trade box and the
       claims beside it on a wide screen, under it on a phone; then the live trades and holders. Not in the creator's
       Reveal items view, which takes the place of everything under the header. */}
    {revealing ? null : <div className="sh-v2-top" data-aside={TRADE_IN_BUILD || hasClaimsV2(view) ? '' : undefined}>
      <div className="sh-v2-top__market">
        {failedAt === null ? <LifeMarketV2 record={record} view={view} source={source} stage={life.stage} nowSec={life.nowSec} figures={false} />
          : <ClosingCardV2 record={record} view={view} now={now} failedAt={failedAt} />}
      </div>
      <div className="sh-v2-top__aside">
        <TradeSlotMount key={key('trade')} record={record} view={view} source={source} disabled={disabled} />
        {hasClaimsV2(view) ? <div id={PLACE.claims} className="sh-v2-place"><ClaimAllV2 key={key('claims')} scope="box"
          boxes={[{ key: record.id, view, source, name: record.name, symbol: record.pairAsset, ticker: record.ticker, disabled }]} /></div> : null}
        <V2Actions source={source} view={view} close={close.kind === 'closable' ? close.call : null} disabled={disabled || !view.money} symbol={coin} />
      </div>
      <div className="sh-v2-top__activity"><LifeActivityCardV2 record={record} view={view} activity={life.activity} nowSec={life.nowSec} /></div>
    </div>}
    </div>
    {/* SH-203: the creator's Reveal items view takes the place of everything under the header; the header stays. */}
    {revealing ? <RevealItemsV2 key={key('reveal')} view={view} source={source} onClose={() => setSubView(null)} /> : <>
    <div className="sh-v2-parts">
      {/* TA-50: a hidden-art box's draws, waits, opens and revealed pictures. */}
      {view.failed || !(import.meta.env?.SH_BNB !== true && TESTNET.switches.draws) ? null : <HiddenDrawsV2 key={key('draws')} view={view} source={source} ticker={record.ticker} disabled={disabled} />}
      {/* SH-192: the creator's copy of the reveal data on this device, while items are unrevealed. */}
      <RevealCopyV2 key={key('reveal-copy')} view={view} source={source} />
      {/* Into the shop pays holders the sellers' P the shop does not take (R48E), on the box's holder ledger. */}
      {chose(view, 'holders', 'holders-t') || view.choices.sellers === 'shop' ? <HolderEarningsV2 key={`${source.manifest.chainId}:${view.token}`} view={view} source={source} symbol={record.pairAsset} ticker={record.ticker} disabled={disabled} nowSec={now} /> : null}
      {view.spec.boxType === 4 ? <ShopV2 key={key('shop')} view={view} source={source} ticker={record.ticker} symbol={record.pairAsset} disabled={disabled} /> : null}
      {/* SH-TA-33: a box with a collection: its items in the vault, take one out or put one back for box tokens. */}
      {/* SH-203: the creator's way into Reveal items, while items are left (open art): in the Items card, above the
         unrevealed tiles it is for; on a box without that card (a closed box), on its own in the card's place. */}
      {vaultRolesOf(view) && !view.failed ? <div id={PLACE.vault} className="sh-v2-place"><VaultItemsV2 key={key('vault')} view={view} source={source} ticker={record.ticker} disabled={disabled}
        reveal={<RevealEntryV2 key={key('reveal-entry')} view={view} source={source} onOpen={openReveal} />} /></div>
        : <RevealEntryV2 key={key('reveal-entry')} view={view} source={source} onOpen={openReveal} />}
      {chose(view, 'items', 'items-t') ? <ItemPayoutsV2 key={key('items')} view={view} source={source} symbol={record.pairAsset} ticker={record.ticker} disabled={disabled} /> : null}
      {view.spec.boxType === 5 ? <div id={PLACE.pile} className="sh-v2-place"><CoinPileV2 key={key('pile')} view={view} source={source} ticker={record.ticker} symbol={record.pairAsset} alchemist={buyersAlchemist ?? sellersAlchemist} disabled={disabled} nowSec={now} /></div> : null}
      {chose(view, 'eat') ? <EatenV2 view={view} symbol={coin} /> : null}
    </div>
    {/* The box's money in short cards, side by side on a wide screen; every explanation behind its closed details. */}
    <div className="sh-v2-cards">
      {/* SH-255: the Fees and Buy-back progress cards are the picture's sheets now (the sides, their stations, Square Hole). */}
      {/* SH-RC7-SITE-INBOX (KF-5): only while the launch router's own sweep would move some P now. */}
      <LaunchTaxV2 key={key('tax')} source={source} view={view} p={p} disabled={disabled} />
      {/* SH-255: the Creator's claim is the creator's sheet in the picture. */}
      {!view.failed && !view.graduated && view.closedAt > 0n ? <section className="sh-panel"><h2>Graduation hatch</h2><p>{close.kind === 'closable' ? 'Seven days since fill. Anyone may close this box.' : `Anyone may close in ${(view.closedAt + 604800n - view.timestamp + 3599n) / 3600n} hours: seven days from the first fill.`}</p></section> : null}
    </div>
    <div className="sh-v2-more">
      <InboxV2 key={key('inbox')} view={view} source={source} now={now} p={p} coin={coin} disabled={disabled || !view.money} />
      <BurnLogV2 source={source} view={view} />
      {/* SH-258: the Safes panel names FIT's and the platform's Safes; BNB Chain testnet has no Safe (the two fees go to
          the deploy wallet's holding contracts) and no FIT, so the panel is left out there. */}
      {(import.meta.env?.SH_BNB !== true && TESTNET.switches.box0) ? <SafesV2 source={source} view={view} coin={coin} /> : null}
      <details className="sh-fit-details"><summary><span className="sh-fit-details__chevron" aria-hidden="true"><DisclosureIcon /></span>Contract details</summary><p>{view.verified ? 'Clone, not upgradeable' : 'Implementation not checked'}</p><p className="sh-v2-address">{tokenImplementation ?? 'Unavailable'}</p><p className="sh-v2-address">{record.token}</p><p>{`Read at block ${view.block}`}</p></details>
    </div>
    </>}
  </section>;
}
