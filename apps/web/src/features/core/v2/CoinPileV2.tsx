import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { parseUnits, type Address } from 'viem';
import { formatUnits } from '@squarehole/domain';
import { InsufficientGasFundsError, NotSendableError } from '@squarehole/chain/write';
import { gasFundsLine } from '../../tx/gas-words';
import { BrowserWalletDialog, DemoWalletDialog, useWallet } from '../../wallet';
import type { AlchemistModuleV21 } from '../../../../../../packages/chain/src/core/v2';
import { hopText, shortAddress } from '../../create/v2/fee-words';
import { Details } from '../../fit-pair/InfoTip';
import { NO_RESCUE_LINE } from './v2-words';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { m3ActionIO, sendPileApproveV2, sendPileRedeemV2, sendSeedReturnV2 } from './m3-actions';
import { leaveBehindOf, perCoin, quoteOf } from './m3-data';
import { usePileCoin } from './pile-coin';
import { withSingleClaim, type SingleKnown } from './claim-all';
import { singleSessionKey } from './claim-reads';
import { UsdLine } from './UsdLineV2';
import { usdPriceFor } from './usd-v2';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

type Action = { readonly kind: 'approve' | 'redeem'; readonly tIn: bigint; readonly minOut: bigint } | { readonly kind: 'return' };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Coins to hand in: a plain decimal with at most T's 18 places. */
const coinsOf = (text: string): bigint | null => (/^(?:0|[1-9][0-9]{0,59})(?:\.[0-9]{1,18})?$/.test(text) ? parseUnits(text, 18) : null);

/** v2.1 step 8: the sides whose fees a directory action takes (choice 10), and the P waiting for them at the snapshot hash. */
export function moduleWaitingP(view: Pick<V2Snapshot, 'choices' | 'modules'>): bigint | null {
  const sides = (['buyers', 'sellers'] as const).filter((side) => view.choices[side] === 'module');
  if (sides.length === 0 || !view.modules) return null;
  const modules = view.modules;
  return sides.reduce((sum, side) => sum + modules[side].pendingP, 0n);
}

/**
 * A coin pile (M3-53; S5; R43-M3D/M3E): its seed coin and amount, what one coin gets after graduation, a redemption
 * with an exact minimum out, and the seed's return after failure. v2.1 step 3: its fixed leave-behind (0% or 5%, applied
 * to every quote here as `quoteRedeem` applies it) and, for a pile its fees go to, the fees waiting in the box and moved
 * in so far. v2.1 step 8 (SH-V21-FE14), a pile whose fees The Alchemist converts: the P it spent, the P still waiting
 * (in the price coin), the pile coin it delivered and the redeemable balance, each apart, never added up; the route
 * once the module is checked as The Alchemist (`alchemist`). G1 (SH-V21-G1-INT): its fixed per-step cap and the last
 * two steps' split, the P of too-small steps kept in the box for its own pool depth as a figure of its own (RC5-B), up to
 * the module's fixed dust size (`dustMax()`), and its fixed trigger (the module's `conversionTrigger()`, by its short
 * address: any address, never called a keeper, F153) with the seven-day fallback and its limits; the short address and
 * the route in tabular figures (`.sh-numeric`), as the create flow's rows draw them. One visible sentence: no rescue.
 *
 * SH-ALCHEMIST-LESS-TEXT (founder, 2026-10-27: details "should never be the default"): the default view is the pile, its
 * phase, what one coin gets (and a failed box's seed return), the no-rescue line and the redeem box; every other figure,
 * in its old order, then every paragraph, the route and the addresses wait behind the closed Pile details, below the
 * actions, so opening it never moves a button.
 */
/**
 * SH-255 (round 3, D10): whether this card renders its Redeem form: its history read and the pile's money saying
 * redemption is open. The page's "Hand in" entry uses this same rule, so it is offered exactly where the form is.
 */
export function pileRedeemOpenV2(view: V2Snapshot): boolean {
  return Boolean(view.m3?.pile) && view.m3?.pileMoney?.redemptionOpen === true;
}

export function CoinPileV2({ view, source, ticker, symbol = 'P', alchemist = null, disabled, nowSec }: { view: V2Snapshot; source: V2Source; ticker: string; symbol?: string; alchemist?: AlchemistModuleV21 | null; nowSec?: bigint; disabled: boolean }) {
  const wallet = useWallet(); const queries = useQueryClient(); const primary = useRef<HTMLButtonElement>(null);
  const history = view.m3?.pile ?? null; const money = view.m3?.pileMoney ?? null;
  const asset = (money?.asset ?? history?.asset ?? '0x0000000000000000000000000000000000000000') as Address;
  const coin = usePileCoin(source, asset, true, view.release);
  const [dialog, setDialog] = useState(false); const [pending, setPending] = useState<{ readonly action: Action; readonly account: Address } | null>(null);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null); const [text, setText] = useState('');
  const account = wallet.status === 'connected' ? wallet.account : null;
  const wrong = account !== null && (wallet.chainId !== source.manifest.chainId || wallet.kind !== 'injected');
  const amount = (raw: bigint) => (coin ? `${formatUnits(raw, coin.decimals)} ${coin.symbol}` : `${raw} raw units`);
  const coins = (raw: bigint) => `${formatUnits(raw, 18)} ${ticker}`;
  const inP = (raw: bigint) => `${formatUnits(raw, view.decimals)} ${symbol}`;
  // v2.1 step 8: a module side's conversions (only parsed for a pile with one).
  const converted = view.alchemist; const waiting = moduleWaitingP(view); const converts = view.alchemist !== undefined;
  if (!history) return <section className="sh-panel sh-m3-pile" aria-label="Coin pile"><h2>Coin pile</h2><p>Pile history unavailable.</p></section>;
  const seed = history.seedAmount;
  const leave = leaveBehindOf(view.spec);
  const tIn = coinsOf(text);
  const quote = money && tIn !== null && leave !== null ? quoteOf(money, tIn, leave) : null;
  const each = money && leave !== null ? perCoin(money, leave) : null;
  // v2.1 step 3: a side chose To the pile (`pileFees` is only parsed then).
  const fees = view.pileFees;
  const open = pileRedeemOpenV2(view);
  const due = money?.seedReturnDue ?? 0n;
  const phase = history.failed || money?.failed ? 'Closed' : open ? 'Redeem open' : seed > 0n && !history.seedLoaded ? 'Seed waiting' : 'After graduation';
  const active = pending && account && same(pending.account, account) ? pending.action : null;
  const canSend = account !== null && !disabled && !wrong && !busy;

  const begin = (action: Action) => { setMessage(null); if (!account) setDialog(true); else setPending({ action, account }); };
  const confirm = async () => {
    if (!active || !canSend || !account || !wallet.signer) return;
    setBusy(true); setMessage(null);
    try {
      const io = m3ActionIO(source, view, wallet.signer.request);
      if (active.kind === 'approve') await sendPileApproveV2(source, view, account, active.tIn, io);
      else if (active.kind === 'redeem') await sendPileRedeemV2(source, view, account, active.tIn, active.minOut, io);
      else {
        const receipt = await sendSeedReturnV2(source, view, account, io);
        // Claim all reads the same record (claim-reads.ts): the seed shows returned, not owed, until the box is read again.
        if (history.seeder.toLowerCase() === account.toLowerCase()) queries.setQueryData<SingleKnown>(singleSessionKey('seed', source.manifest.chainId, view.claimRow?.contracts.vault ?? null, account),
          (known) => withSingleClaim(known, { tx: receipt.transactionHash, block: receipt.blockNumber, paid: due }));
      }
      setMessage(active.kind === 'approve' ? 'Approval confirmed. Redeem in a separate transaction.' : 'Confirmed. Reading the updated box…');
      setPending(null); await queries.invalidateQueries({ queryKey: ['v2-feed'] });
    } catch (error) {
      setMessage(error instanceof NotSendableError ? 'Not sent. Nothing reached your wallet.' : error instanceof InsufficientGasFundsError ? gasFundsLine(error.chainId) : error instanceof Error ? error.message : 'Nothing confirmed. Try again.');
    } finally { setBusy(false); }
  };
  const ready = open && tIn !== null && tIn > 0n && quote !== null && quote > 0n;

  return <section className="sh-panel sh-m3-pile" aria-label="Coin pile"><h2>Coin pile</h2>
    <p className="sh-v2-value">{money?.balance != null ? amount(money.balance) : `— ${coin?.symbol ?? ''}`.trim()}</p>
    {/* SH-266: the pile in dollars, while the indexer's Atlas price of the pile coin is fresh. */}
    {coin && nowSec !== undefined ? <UsdLine raw={money?.balance ?? null} decimals={coin.decimals} price={usdPriceFor(view.prices, asset, nowSec)} nowSec={nowSec} /> : null}
    <p className="sh-m2-chips"><span className="sh-chip" data-phase={phase}>{phase}</span></p>
    <dl className="sh-m3-figures">
      <div><dt>{`Per ${ticker}`}</dt><dd>{each !== null ? amount(each) : '—'}</dd></div>
      {history.failed ? <div><dt>Seed return</dt><dd>{history.seedReturned ? `Returned ${amount(history.returnedAmount)}` : due > 0n ? `${amount(due)} due` : 'None loaded'}</dd></div> : null}
    </dl>
    <p data-no-rescue="">{NO_RESCUE_LINE}</p>
    {open ? <div className="sh-v2-actions" role="group" aria-label="Redeem">
      <label>{`${ticker} to redeem`}<input className="sh-newbox-input" data-entry-target="pile" inputMode="decimal" value={text} onChange={(e) => { setText(e.target.value); setPending(null); }} /></label>
      {quote !== null ? <dl className="sh-m3-quote"><div><dt>You get</dt><dd>{amount(quote)}</dd></div><div><dt>Minimum</dt><dd>{amount(quote)}</dd></div></dl> : null}
      <button type="button" className="sh-button" disabled={(account !== null && !canSend) || !ready} onClick={() => tIn !== null && quote !== null && begin({ kind: 'approve', tIn, minOut: quote })}>Approve coins</button>
      <button ref={primary} type="button" className="sh-button sh-button--primary" disabled={(account !== null && !canSend) || !ready} onClick={() => tIn !== null && quote !== null && begin({ kind: 'redeem', tIn, minOut: quote })}>Redeem</button>
    </div> : null}
    {history.failed && !history.seedReturned && due > 0n ? <div className="sh-v2-actions"><button type="button" className="sh-button" disabled={account !== null && !canSend} onClick={() => begin({ kind: 'return' })}>Return seed</button></div> : null}
    {active ? <div role="group" aria-label="Confirm transaction">
      <p>{active.kind === 'approve' ? `Approve exactly ${coins(active.tIn)} for the pile?` : active.kind === 'redeem' ? `Redeem ${coins(active.tIn)} for ${amount(active.minOut)}, minimum ${amount(active.minOut)}?` : `Send the seed, ${amount(due)}, back to its seeder?`}</p>
      <p className="sh-v2-address">{`To ${active.kind === 'return' ? history.seeder : account}`}</p>
      <button type="button" className="sh-button sh-button--primary" disabled={!canSend} onClick={() => void confirm()}>{busy ? 'Waiting for confirmation…' : 'Confirm'}</button>
      <button type="button" className="sh-button" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
    </div> : null}
    {message ? <p role="status">{message}</p> : null}
    {wrong ? <p>Use a browser wallet on this box’s network.</p> : null}
    <Details label="Pile details">
      <dl className="sh-m3-figures" data-pile-figures="">
        <div><dt>Seed</dt><dd>{amount(seed)}</dd></div>
        <div><dt>{`${ticker} out`}</dt><dd>{money ? coins(money.supply) : 'Unavailable'}</dd></div>
        <div><dt>Leave behind</dt><dd>{leave === null ? 'Unavailable' : `${leave / 100n}%`}</dd></div>
        {fees !== undefined ? <div><dt>Fees waiting</dt><dd>{fees ? amount(fees.pendingP) : 'Unavailable'}</dd></div> : null}
        {fees !== undefined ? <div><dt>Fees moved in</dt><dd>{fees ? amount(fees.movedP) : 'Unavailable'}</dd></div> : null}
        {/* The conversions' five figures, each in its own coin; on a phone each takes a row, so exact digits stay on one line. */}
        {converts ? <div className="sh-m3-figures__wide"><dt>Redeemable</dt><dd>{money?.balance != null ? amount(money.balance) : 'Unavailable'}</dd></div> : null}
        {converts ? <div className="sh-m3-figures__wide"><dt>{`${symbol} converted`}</dt><dd>{converted ? inP(converted.inputP) : 'Unavailable'}</dd></div> : null}
        {converts ? <div className="sh-m3-figures__wide"><dt>{`${symbol} waiting`}</dt><dd>{waiting !== null ? inP(waiting) : 'Unavailable'}</dd></div> : null}
        {converts ? <div className="sh-m3-figures__wide"><dt>Added by conversion</dt><dd>{converted ? amount(converted.receivedAsset) : 'Unavailable'}</dd></div> : null}
        {/* RC5-B: steps too small to convert stay in the box as price-coin claims for its own pool depth; never pile coin, never added up. */}
        {converts ? <div className="sh-m3-figures__wide"><dt>{`${symbol} added to pool depth`}</dt><dd>{converted?.dustToDepthP != null ? inP(converted.dustToDepthP) : 'Unavailable'}</dd></div> : null}
      </dl>
      <p>{`The creator seeds the pile once, after Create; ${fees !== undefined ? 'fees chosen To the pile wait in the box until graduation, then anyone moves them in.' : converts ? `fees chosen for ${alchemist ? 'The Alchemist' : 'its fee module'} wait in ${symbol} until graduation, then convert into ${coin?.symbol ?? 'the pile coin'}.` : 'no fee choice adds to it.'} ${seed > 0n ? 'Trading opens only after the seed arrives.' : 'A zero seed needs no loading.'}`}</p>
      {converts && alchemist ? <>
        <p>{`Each step converts at most ${inP(alchemist.inputCap)}; the rest waits for the next one. A step goes along the fixed route, each pool within 49 ticks of its price at the start, or refuses and keeps it waiting for a later try. When more than one but less than two full steps are left, two steps split the rest. A step of at most ${inP(alchemist.dustMax)} that a pool would pay nothing for stays in this box instead, as ${symbol} for its own pool’s next deepening, shown apart and never added to the pile; a larger one refuses and waits.`}</p>
        <ol className="sh-v2-route sh-numeric" aria-label="Conversion route">{alchemist.route.map((hop, i) => <li key={i}>{hopText(hop, [{ token: view.record.q, symbol }, ...(coin ? [{ token: asset, symbol: coin.symbol }] : [])])}</li>)}</ol>
        <p>{'Only '}<span className="sh-numeric">{shortAddress(alchemist.conversionTrigger)}</span>{` starts a step, until a side has waited 7 days without one; before that, anyone else’s try is refused and nothing moves. After 7 days anyone may start the next step. Graduation and every step that goes through start the 7 days again; a refused try does not.`}</p>
        <p>{`It knows no fair price. Once anyone may start a step, a trader can move a pool’s price just before it, within the 49 ticks; a step seen early can be traded around the same way.`}</p>
      </> : converts ? <p>{`A conversion spends waiting ${symbol} along its fixed route, each pool within 49 ticks of its price at the start, or refuses and keeps it waiting for a later try.`}</p> : null}
      {converts ? <p>{`What it delivers is counted apart from the seed and gifts, in ${coin?.symbol ?? 'the pile coin'}; ${symbol} and ${coin?.symbol ?? 'the pile coin'} are never added up. If the box fails before graduation, the waiting ${symbol} joins the closing claim.`}</p> : null}
      <p>{`After graduation, anyone holding ${ticker} hands some in for the same share of the pile’s live balance; the coins handed in are burned. The minimum is the exact quote, so a smaller payout refuses instead of sending less. Coins of the pile’s own kind sent to it join that balance.`}</p>
      {leave !== null && leave > 0n ? <p>{`Leave behind ${leave / 100n}%: each hand-in pays ${100n - leave / 100n}% of its share and the rest stays in the pile for those still holding. Handing in every ${ticker} still out takes the whole pile.`}</p> : null}
      <p>{`If the box fails, only the recorded seed goes back to the creator, in a separate call anyone can make and retry.${fees !== undefined ? ' Fees not yet moved in join the closing claim.' : ''} Nothing else in the pile has a way out.`}</p>
      <p className="sh-v2-address">{`Seeder ${history.seeder}`}</p>
      <p className="sh-v2-address">{view.claimRow?.contracts.vault ?? 'Pile unavailable'}</p>
      <p>{`Redeeming calls approve(pile, coins) on ${ticker}, then redeem(coins, minimum, your wallet) on the pile.`}</p>
    </Details>
    <BrowserWalletDialog open={dialog && wallet.defaultDialog === 'browser'} onClose={() => setDialog(false)} returnFocus={primary} />
    {DEMO_BUILD ? <DemoWalletDialog open={dialog && wallet.defaultDialog === 'demo'} onClose={() => setDialog(false)} returnFocus={primary} /> : null}
  </section>;
}
