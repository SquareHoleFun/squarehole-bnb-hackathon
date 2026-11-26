import { usePageTitle } from '../lib/page-title';
import { useEffect, useState, type ReactNode } from 'react';
import { isAddress, parseEventLogs, zeroAddress, type Address, type PublicClient, type TransactionReceipt } from 'viem';
import { erc20Abi } from '../abi/feeRules';
import { curveLauncherAbi, ROUTER_97, rulesVaultFactoryAbi, taxProcessorAbi, taxTokenAbi, tokenCurveLauncherAbi } from '../abi/flap';
import { RulesPanel, type FixedRule } from '../components/RulesPanel';
import { flapOriginOf } from '../lib/flap-origin';
import { dispatchWaitingText } from '../lib/rules';
import { flapRulesPayees } from '../lib/shop';
import { AddressLink, Age, Amount, Help, ReadError, Stat, TxStatus } from '../components/bits';
import { CurveChart } from '../components/CurveChart';
import { MintTestCoin } from '../components/MintTestCoin';
import { PilePanel } from '../components/PilePanel';
import { PoolTradeBox } from '../components/PoolTradeBox';
import { Allowances } from '../components/Allowance';
import { useWriteGate } from '../components/WalletBar';
import { formatAmount, formatBps, minOut, parseAmount, parsePercentToBps, shareBps, toDecimalString } from '../lib/amounts';
import { minimumAtPress, sendWrite, useApp, useChainRead, useTx, withApproval, type Loaded, type Need } from '../lib/app-context';
import { shortAddress } from '../lib/chain';
import type { AppConfig, FlapRulesPair } from '../lib/config';
import { readSaleQuote, valueFor, type SaleQuote } from '../lib/quote';
import { PageRefusal } from '../lib/errors';
import { PHASE, type CurveConfig, type Progress } from '../lib/flap';
import { FlapHolders } from '../components/HoldersPanel';
import { REFUSALS, type Refusal } from '../lib/forms';
import { useWallet } from '../lib/wallet';
import { ShopLinks } from '../components/ShopLinks';
import { LaunchPictureImg } from '../lib/pictures/read';
import { FLOOR_ROSE, saleBelowFloor } from '../lib/flap-floor';
import { FiguresShare, useLiveFigures } from '../picture/live-figures';
import { flapLivePicture } from '../picture/live-picture';
import { LivePicture, type PartTargets } from '../picture/LivePicture';

interface SaleRead {
  progress: Progress;
  config: CurveConfig;
  virtualTokens: bigint;
  now: bigint;
  costToComplete: bigint;
  launch: readonly [Address, Address, Address];
  mine?: { tokens: bigint; owed: bigint; claimable: bigint };
  /** What the sale is paid in: every quote amount on this screen takes its symbol and decimals from here. */
  quote: SaleQuote;
}

async function readSale(c: ReturnType<typeof useApp>['client'], appConfig: AppConfig, launcher: Address, account?: Address): Promise<SaleRead> {
  const r = (functionName: string, args: unknown[] = []) => c.readContract({ address: launcher, abi: curveLauncherAbi, functionName, args });
  const [progress, config, virtualTokens, block, launch] = await Promise.all([
    r('progress') as Promise<Progress>,
    r('config') as Promise<CurveConfig>,
    r('virtualTokens') as Promise<bigint>,
    c.getBlock({ blockTag: 'latest' }),
    r('launchInfo') as Promise<readonly [Address, Address, Address]>,
  ]);
  const costToComplete = progress.phase === PHASE.selling ? ((await r('costToComplete')) as bigint) : 0n;
  let mine: SaleRead['mine'];
  if (account) {
    const [tokens, owed, claimable] = await Promise.all([
      r('tokensOf', [account]) as Promise<bigint>,
      progress.phase === PHASE.failed ? (r('owed', [account]) as Promise<bigint>) : Promise.resolve(0n),
      progress.phase === PHASE.launched ? (r('claimable', [account]) as Promise<bigint>) : Promise.resolve(0n),
    ]);
    mine = { tokens, owed, claimable };
  }
  return { progress, config, virtualTokens, now: block.timestamp, costToComplete, launch, mine, quote: await readSaleQuote(c, appConfig, launcher) };
}

/**
 * Whether OUR factory created this launcher: a sale the deployment file names, or one of the file's launcher factories
 * proven as its maker (lib/flap-origin.ts). Any address can be read; only such a sale gets buttons that send.
 */
export type SaleOrigin = 'native' | 'token' | false;

/** Our factory's sale, with the rules pair when one of the rules launcher factories created it (SH-287). */
export interface SaleTrust {
  origin: SaleOrigin;
  rules?: FlapRulesPair;
}

export function useSaleTrust(launcher: Address): Loaded<SaleTrust> {
  const { config } = useApp();
  return useChainRead(
    async (c): Promise<SaleTrust> => {
      const flap = config.flap;
      if (!flap) return { origin: false };
      // a sale the file names (the first native sale); a token-quote or rules sale only from its factory's proof
      if (flap.sales.some((s) => s.launcher.toLowerCase() === launcher.toLowerCase())) return { origin: 'native' };
      // SH-303: our factory made it, proven from the sale and the factory (lib/flap-origin.ts), not from event scans
      const o = await flapOriginOf(c, config, launcher);
      return o ? { origin: o.origin, ...(o.rules ? { rules: o.rules } : {}) } : { origin: false };
    },
    [launcher],
  );
}

function timeLeft(seconds: bigint): string {
  if (seconds <= 0n) return '0 m';
  const d = seconds / 86400n;
  const h = (seconds % 86400n) / 3600n;
  const m = (seconds % 3600n) / 60n;
  return d > 0n ? `${d} d ${h} h` : h > 0n ? `${h} h ${m} m` : `${m} m`;
}

export function FlapSale({ launcher }: { launcher: Address }) {
  const wallet = useWallet();
  const { config } = useApp();
  // The sale's public state stays while another account's own numbers are read; the previous account's never show.
  const sale = useChainRead((c) => readSale(c, config, launcher, wallet.account), [launcher, wallet.account], {
    keepOnChange: true,
    owner: wallet.account ?? '',
    forOtherOwner: (v) => ({ ...v, mine: undefined }),
  });
  const trust = useSaleTrust(launcher);
  usePageTitle('flap-sale', sale.state === 'ok' ? sale.value.config.name : undefined);
  // SH-281 step 3: a rules sale's payees (the deployment's rules vault factory's record) and the token it creates, for
  // the shop links and the holders panel; nothing is read for a sale without a rules pair (as before).
  const pairNow = trust.state === 'ok' ? trust.value.rules : undefined;
  const rulesPayees = useChainRead(
    (c) => (pairNow ? flapRulesPayees(c, pairNow.rulesVaultFactory, launcher) : Promise.resolve(undefined)),
    [launcher, pairNow?.rulesVaultFactory],
  );
  const tokenToCome = useChainRead(
    async (c) => (pairNow ? ((await c.readContract({ address: launcher, abi: curveLauncherAbi, functionName: 'predictedToken' })) as Address) : undefined),
    [launcher, pairNow?.rulesVaultFactory],
  );
  // The launch's status lives here: the transaction ends the selling phase, and its link must stay on screen.
  const launchTx = useTx();
  const buyTx = useTx();
  // SH-319: what the panels below read, shared with the picture at the top (no read of its own).
  const [figures, share] = useLiveFigures();
  if (sale.state === 'loading') return <p className="muted">Reading the sale…</p>;
  if (sale.state === 'error' && sale.error.name === 'unknown') return <p className="muted">Could not read the sale yet. Trying again.</p>;
  if (sale.state === 'error') return <p className="muted">No sale at {shortAddress(launcher)}.</p>;
  const s = sale.value;
  const p = s.progress;
  const q = s.quote;
  // Writes only when the factory that made the sale matches what the sale says it is paid in: the native factory's
  // sales in the native coin, the token-quote factory's in the deployment's test token, with its own ABI.
  const origin = trust.state === 'ok' ? trust.value.origin : false;
  const rulesPair = trust.state === 'ok' ? trust.value.rules : undefined;
  const payees = rulesPayees.state === 'ok' ? rulesPayees.value : undefined;
  const tokenPair = config.flap?.tokenQuote;
  // A rules pair's token sales are paid in the deployment's test token too (the same quote as the token pair's).
  const testToken = tokenPair?.quote;
  const trusted =
    (origin === 'native' && q.kind === 'native') ||
    (origin === 'token' && q.kind === 'token' && testToken !== undefined && q.address.toLowerCase() === testToken.toLowerCase());
  const phaseWord = p.phase === PHASE.selling ? 'Selling' : p.phase === PHASE.launched ? 'Launched' : 'Missed';
  const shop = (
    <ShopLinks
      flapLauncher={launcher}
      token={
        p.phase === PHASE.launched
          ? s.launch[0]
          : (config.flap?.sales.concat(config.flap.tokenQuote?.sales ?? []).find((x) => x.launcher.toLowerCase() === launcher.toLowerCase())?.token ??
            (tokenToCome.state === 'ok' ? tokenToCome.value : undefined))
      }
      symbol={s.config.symbol}
      payees={trust.state === 'ok' && !rulesPair ? undefined : payees ?? null}
    />
  );
  const selling = p.phase === PHASE.selling;
  const picture = flapLivePicture({
    ticker: s.config.symbol,
    quote: { symbol: q.symbol, decimals: q.decimals },
    tradeFeeBps: Number(s.config.tradeFeeBps),
    buyTaxBps: Number(s.config.buyTaxBps),
    sellTaxBps: Number(s.config.sellTaxBps),
    burnShareBps: Number(s.config.burnShareBps),
    taxSeconds: BigInt(s.config.taxDuration),
    // the same numbers as the stats below
    raised: p.phase === PHASE.launched ? p.raiseTarget : p.curveBalance,
    target: p.raiseTarget,
    soldBps: shareBps(p.sold, p.saleTokens),
    raisedLabel: p.phase === PHASE.failed ? 'In the sale' : 'Raised',
    timeLeft: selling ? timeLeft(p.deadline - s.now) : undefined,
    ruled: Boolean(rulesPair),
    figures,
  });
  const trade = selling ? ['buy-box', 'sale-raised'] : p.phase === PHASE.launched ? ['pool-trade', 'claim-box'] : ['unwind-box', 'sale-raised'];
  const targets: PartTargets = {
    token: trade,
    buyers: trade,
    sellers: selling ? ['sell-box'] : trade,
    pool: p.phase === PHASE.launched ? ['pool-trade'] : selling ? ['launch-box'] : trade,
    raise: ['sale-raised'],
    price: ['sale-raised'],
    deadline: ['sale-sold'],
    creator: ['rules-panel', 'dispatch-box', 'pile-panel'],
    tax: ['rules-panel', 'dispatch-box', 'pile-panel'],
    pile: ['pile-panel', 'rules-panel'],
    holders: ['holders-panel', 'rules-panel'],
    shop: ['shop-links', 'rules-panel'],
  };
  return (
    <FiguresShare value={share}>
    <div className="screen" data-testid="flap-sale" data-phase={p.phase} data-trusted={trusted ? 'yes' : 'no'}>
      <section className="sh-panel panel">
        <header className="panel-head">
          <h1 className="screen-title">
            <LaunchPictureImg link={s.config.meta} size={40} className="launch-picture launch-picture--head" />
            {s.config.name} <span className="muted">· {s.config.symbol}</span>
          </h1>
          <span className="head-end">
            <Age at={sale.at} stale={sale.stale} />
            <span className={`pill phase-${p.phase}`} data-testid="sale-phase">
              {phaseWord}
            </span>
            <Help label="Rules">
              Curve fee {formatBps(BigInt(s.config.tradeFeeBps))}. After the launch: buy tax {formatBps(BigInt(s.config.buyTaxBps))}, sell tax{' '}
              {formatBps(BigInt(s.config.sellTaxBps))}, for {(BigInt(s.config.taxDuration) / 86400n).toString()} days;{' '}
              {formatBps(BigInt(s.config.burnShareBps))} of the tax is burned, the rest goes to {rulesPair ? 'the rules below' : 'the pile'}, after Flap&apos;s own share. The sale&apos;s
              settings cannot be changed. Launcher <AddressLink address={launcher} />.
            </Help>
          </span>
        </header>
        <div className="sh-live-top">
        <LivePicture picture={picture} name={`${s.config.name} on Flap`} targets={targets} />
        <div className="sh-live-top__rest">
        <CurveChart virtualBnb={s.config.virtualBnb} virtualTokens={s.virtualTokens} saleTokens={p.saleTokens} sold={p.phase === PHASE.selling ? p.sold : undefined} symbol={q.symbol} decimals={q.decimals} />
        <div className="stats">
          {p.phase === PHASE.failed ? (
            <Stat label="In the sale" testId="sale-raised">
              <Amount value={p.curveBalance} decimals={q.decimals} symbol={q.symbol} />
            </Stat>
          ) : (
            <Stat label="Raised" testId="sale-raised">
              {/* After the launch the raise is in the pool, so the curve holds nothing: show the raise. */}
              <Amount value={p.phase === PHASE.launched ? p.raiseTarget : p.curveBalance} decimals={q.decimals} symbol={q.symbol} />{' '}
              <span className="muted small">
                of <Amount value={p.raiseTarget} decimals={q.decimals} />
              </span>
            </Stat>
          )}
          <Stat label="Sold" testId="sale-sold">
            {formatBps(shareBps(p.sold, p.saleTokens))}
          </Stat>
          {p.phase === PHASE.selling ? (
            <>
              <Stat label="Curve price" testId="sale-price">
                <Amount value={p.priceNow} decimals={q.decimals} symbol={q.symbol} />
              </Stat>
              <Stat label="Time left" testId="sale-time">
                {timeLeft(p.deadline - s.now)}
              </Stat>
            </>
          ) : null}
        </div>
        </div>
        </div>
        {s.mine && s.mine.tokens > 0n && p.phase === PHASE.selling ? (
          <p className="review" data-testid="sale-mine">
            You hold <Amount value={s.mine.tokens} decimals={18} symbol={s.config.symbol} /> on the curve
          </p>
        ) : null}
        {trust.state === 'error' ? <ReadError text="Could not check this sale's creation, so it is read only for now." testId="trust-error" /> : null}
        {trust.state === 'ok' && !trusted ? (
          <p className="muted small" data-testid="read-only">
            Read only: this page could not verify this sale for writes.
          </p>
        ) : null}
        <div data-testid="launch-status">
          <TxStatus step={launchTx.step} />
          {p.phase !== PHASE.selling ? <TxStatus step={buyTx.step} /> : null}
        </div>
      </section>
      {rulesPair && p.phase !== PHASE.launched ? <StoredRules launcher={launcher} pair={rulesPair} sale={s} trusted={trusted} /> : null}
      {trusted && p.phase === PHASE.selling ? <SellingBoxes launcher={launcher} sale={s} launchTx={launchTx} buyTx={buyTx} /> : null}
      {trusted && p.phase === PHASE.failed ? <UnwindBox launcher={launcher} sale={s} /> : null}
      {p.phase === PHASE.launched ? <Launched launcher={launcher} sale={s} trusted={trusted} rulesPair={rulesPair} shop={shop} /> : null}
      {trusted ? (
        <Allowances
          pairs={[
            ...(q.kind === 'token'
              ? [
                  { token: q.address, spender: launcher, symbol: q.symbol, decimals: q.decimals, to: 'this sale' },
                  { token: q.address, spender: config.flap?.router ?? ROUTER_97, symbol: q.symbol, decimals: q.decimals, to: 'the pool router' },
                ]
              : []),
            ...(p.phase === PHASE.launched ? [{ token: s.launch[0], spender: config.flap?.router ?? ROUTER_97, symbol: s.config.symbol, decimals: 18, to: 'the pool router' }] : []),
          ]}
        />
      ) : null}
      {p.phase !== PHASE.launched ? shop : null}
      {/* SH-290: holder payouts on the launched token (the creator's own stake made by our factory; else nothing). */}
      {p.phase === PHASE.launched ? (
        <FlapHolders launcher={launcher} token={s.launch[0]} payees={payees === null ? [] : payees} />
      ) : null}
    </div>
    </FiguresShare>
  );
}

function useGuard(): [string, (v: string) => void, bigint | undefined] {
  const [g, setG] = useState('1');
  const r = parsePercentToBps(g);
  return [g, setG, r.ok ? r.value : undefined];
}

type Tx = ReturnType<typeof useTx>;

function SellingBoxes({ launcher, sale, launchTx, buyTx }: { launcher: Address; sale: SaleRead; launchTx: Tx; buyTx: Tx }) {
  const { client } = useApp();
  const wallet = useWallet();
  const q = sale.quote;
  const sym = q.symbol;
  const { ready, gate } = useWriteGate();
  const sellTx = useTx({ decimals: q.decimals });
  const [budget, setBudget] = useState('');
  const [tokens, setTokens] = useState('');
  const [guardText, setGuardText, guard] = useGuard();
  useEffect(() => {
    buyTx.reset();
    sellTx.reset();
  }, [launcher]); // eslint-disable-line react-hooks/exhaustive-deps

  const b = parseAmount(budget, q.decimals);
  const buyQuote = useChainRead(async (c) => (b.ok ? quoteBuyOf(c, launcher, q, b.value) : undefined), [launcher, b.ok ? b.value : -1n]);
  const t = parseAmount(tokens, 18);
  const tRefusal: Refusal | undefined = !t.ok ? t.reason : sale.mine && t.value > sale.mine.tokens ? 'over-balance' : undefined;
  const sellQuote = useChainRead(
    async (c) =>
      t.ok && !tRefusal
        ? ((await c.readContract({ address: launcher, abi: curveLauncherAbi, functionName: 'quoteSell', args: [t.value] })) as readonly [bigint, bigint, bigint])
        : undefined,
    [launcher, t.ok ? t.value : -1n, tRefusal],
  );
  const bq = buyQuote.state === 'ok' ? buyQuote.value : undefined;
  const sq = sellQuote.state === 'ok' ? sellQuote.value : undefined;
  const buyMin = bq && guard !== undefined ? minOut(bq[0], guard) : undefined;
  const sellMin = sq && guard !== undefined ? minOut(sq[2], guard) : undefined;

  const selling = sellingNow(client, launcher);
  // SH-296: Flap's floor for this sale now (the Portal checks it again at the launch; anyone can raise it).
  const floorRose = useChainRead((c) => saleBelowFloor(c, launcher), [launcher, sale.now]);
  const risen = floorRose.state === 'ok' && floorRose.value;
  /** A buy or the launch that would complete the sale is refused while the floor is above it: it would revert. */
  const refuseIfFloorRose = async () => {
    if (await saleBelowFloor(client, launcher)) throw new PageRefusal('floor-rose', FLOOR_ROSE);
  };
  const buy = () =>
    b.ok &&
    guard !== undefined &&
    buyTx.run('Buy', wallet, async (press) => {
      const fresh = await quoteBuyOf(client, launcher, q, b.value);
      const now = (await client.readContract({ address: launcher, abi: curveLauncherAbi, functionName: 'progress' })) as Progress;
      if (fresh[0] >= now.saleTokens - now.sold) await refuseIfFloorRose();
      const least = minimumAtPress(fresh[0], guard, buyMin);
      // Every step needs the sale selling and the quote still at least the minimum, read when it goes to the wallet.
      const need = both(selling, async () => ((await quoteBuyOf(client, launcher, q, b.value))[0] >= least ? null : 'the quote moved below your minimum'));
      if (q.kind === 'native') {
        const { request } = await client.simulateContract({ account: press.account, address: launcher, abi: curveLauncherAbi, functionName: 'buy', args: [least], value: valueFor(q, b.value) });
        return sendWrite(client, wallet, request, press, need);
      }
      // A token quote: approve exactly what the fresh quote pulls (cost plus fee) to this sale's launcher; once the
      // approval is mined, quote again: the buy's maximum cost is the approved amount, its minimum from the new quote.
      const pull = fresh[1] + fresh[2];
      if (q.kind !== 'token') throw new PageRefusal('wrong-coin', 'This sale is not paid in a token.');
      await withApproval(client, wallet, press, {
        token: q.address,
        spender: launcher,
        amount: pull,
        approveLabel: `Approve ${toDecimalString(pull, q.decimals)} ${sym} for this sale`,
        mainLabel: 'Buy',
        need,
      });
      const again = await quoteBuyOf(client, launcher, q, b.value);
      if (again[1] + again[2] > pull) throw new PageRefusal('quote-moved', 'The quote moved. Check the new numbers and press again.');
      const least2 = minimumAtPress(again[0], guard, buyMin);
      const { request } = await client.simulateContract({ account: press.account, address: launcher, abi: tokenCurveLauncherAbi, functionName: 'buy', args: [pull, least2] });
      return sendWrite(
        client,
        wallet,
        request,
        press,
        both(selling, async () => {
          const now = await quoteBuyOf(client, launcher, q, b.value);
          return now[0] >= least2 && now[1] + now[2] <= pull ? null : 'the quote moved below your minimum';
        }),
      );
    });
  const sell = () =>
    t.ok &&
    guard !== undefined &&
    sellTx.run('Sell', wallet, async (press) => {
      const sellQuote = async () => ((await client.readContract({ address: launcher, abi: curveLauncherAbi, functionName: 'quoteSell', args: [t.value] })) as readonly [bigint, bigint, bigint])[2];
      const least = minimumAtPress(await sellQuote(), guard, sellMin);
      const { request } = await client.simulateContract({ account: press.account, address: launcher, abi: curveLauncherAbi, functionName: 'sell', args: [t.value, least] });
      return sendWrite(client, wallet, request, press, both(selling, async () => ((await sellQuote()) >= least ? null : 'the quote moved below your minimum')));
    });
  // Launch: the launcher's own `complete()`, which launches or reverts (never a partial buy). Native: exactly the cost
  // read at the press (costToComplete includes the fee). Token quote: approve exactly that cost; after the approval the
  // cost is read again and that is the call's maximum (never above the approval, never zero). A cost above the one on
  // screen is shown and needs a new press. "Confirmed" only on its Launched event.
  const shownCost = sale.costToComplete;
  /** The rest still costs something, and at most `max`. */
  const costAtMost = (max: bigint) => async () => {
    const c = (await client.readContract({ address: launcher, abi: curveLauncherAbi, functionName: 'costToComplete' })) as bigint;
    return c === 0n ? 'nothing is left to buy' : c > max ? 'the rest now costs more' : null;
  };
  const launch = () =>
    launchTx.run(
      'Launch',
      wallet,
      async (press) => {
        const costNow = () => client.readContract({ address: launcher, abi: curveLauncherAbi, functionName: 'costToComplete' }) as Promise<bigint>;
        const moved = (c: bigint) => new PageRefusal('cost-moved', `The rest now costs ${toDecimalString(c, q.decimals)} ${sym}. Press again to pay that.`);
        const cost = await costNow();
        if (cost === 0n) throw new PageRefusal('nothing-left', 'Nothing is left to buy.');
        await refuseIfFloorRose();
        if (cost > shownCost) throw moved(cost);
        if (q.kind === 'native') {
          const { request } = await client.simulateContract({ account: press.account, address: launcher, abi: curveLauncherAbi, functionName: 'complete', value: cost });
          return sendWrite(client, wallet, request, press, both(selling, costAtMost(cost)));
        }
        await withApproval(client, wallet, press, {
          token: q.address,
          spender: launcher,
          amount: cost,
          approveLabel: `Approve ${toDecimalString(cost, q.decimals)} ${sym} for this sale`,
          mainLabel: 'Launch',
          need: both(selling, costAtMost(cost)),
        });
        const again = await costNow();
        if (again > cost) throw moved(again);
        if (again === 0n) throw new PageRefusal('nothing-left', 'Nothing is left to buy.');
        const { request } = await client.simulateContract({ account: press.account, address: launcher, abi: tokenCurveLauncherAbi, functionName: 'complete', args: [again] });
        return sendWrite(client, wallet, request, press, both(selling, costAtMost(again)));
      },
      (receipt) => (launchedIn(receipt, launcher) ? { ok: true } : { ok: false, error: { name: 'not-launched', sentence: 'The sale did not launch.' } }),
    );

  return (
    <section className="sh-panel panel boxes">
      {q.kind === 'token' ? <MintTestCoin /> : null}
      <div className="box" data-testid="buy-box">
        <h3>Buy</h3>
        <div className="field-row">
          <label className="field">
            <span className="field-label">{sym} to spend</span>
            <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="0" disabled={buyTx.busy} data-testid="buy-amount" />
          </label>
          <label className="field field-narrow">
            <span className="field-label">Guard %</span>
            <input inputMode="decimal" value={guardText} onChange={(e) => setGuardText(e.target.value)} disabled={buyTx.busy || sellTx.busy} data-testid="guard" />
          </label>
        </div>
        {budget !== '' && !b.ok ? <p className="refusal">{REFUSALS[b.reason]}</p> : null}
        {guard === undefined ? <p className="refusal">{REFUSALS['bad-guard']}</p> : null}
        {bq && buyMin !== undefined ? (
          <p className="review" data-testid="buy-review">
            Quote <Amount value={bq[0]} decimals={18} symbol={sale.config.symbol} /> · at least <Amount value={buyMin} decimals={18} />
            {' · '}fee <Amount value={bq[2]} decimals={q.decimals} symbol={sym} />
            {bq[3] > 0n ? (
              <>
                {' · '}back <Amount value={bq[3]} decimals={q.decimals} symbol={sym} />
              </>
            ) : null}
          </p>
        ) : null}
        <div className="actions">
          {gate ??
            (ready ? (
              <button type="button" className="btn btn-primary" disabled={!b.ok || !buyMin || buyTx.busy} onClick={() => void buy()} data-testid="buy">
                Buy
              </button>
            ) : null)}
        </div>
        <TxStatus step={buyTx.step} />
      </div>
      <div className="box" data-testid="sell-box">
        <h3>Sell back</h3>
        <label className="field">
          <span className="field-label">
            {sale.config.symbol} to sell
            {sale.mine ? (
              <span className="muted">
                you hold <Amount value={sale.mine.tokens} decimals={18} />
              </span>
            ) : null}
          </span>
          <input inputMode="decimal" value={tokens} onChange={(e) => setTokens(e.target.value)} placeholder="0" disabled={sellTx.busy} data-testid="sell-amount" />
        </label>
        {tokens !== '' && tRefusal ? (
          <p className="refusal" data-testid="sell-refusal">
            {REFUSALS[tRefusal]}
          </p>
        ) : null}
        {sq && sellMin !== undefined ? (
          <p className="review" data-testid="sell-review">
            Quote <Amount value={sq[2]} decimals={q.decimals} symbol={sym} /> · at least <Amount value={sellMin} decimals={q.decimals} /> · fee{' '}
            <Amount value={sq[1]} decimals={q.decimals} symbol={sym} />
          </p>
        ) : null}
        <div className="actions">
          {gate ??
            (ready ? (
              <button type="button" className="btn" disabled={!t.ok || !!tRefusal || !sellMin || sellTx.busy} onClick={() => void sell()} data-testid="sell">
                Sell back
              </button>
            ) : null)}
        </div>
        <TxStatus step={sellTx.step} />
      </div>
      <div className="box" data-testid="launch-box">
        <h3>Launch</h3>
        <p className="review">
          Buys the rest: about <Amount value={sale.costToComplete} decimals={q.decimals} symbol={sym} />
        </p>
        {risen ? (
          <p className="refusal" data-testid="floor-rose">
            {FLOOR_ROSE}
          </p>
        ) : null}
        <div className="actions">
          {gate ??
            (ready ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={launchTx.busy || sale.costToComplete === 0n || risen}
                onClick={() => void launch()}
                data-testid="launch"
              >
                Launch
              </button>
            ) : null)}
        </div>
      </div>
    </section>
  );
}

/** The launcher's buy quote as (tokens, cost, fee, back): the native launcher returns what comes back of a budget sent
 * as value; the token launcher pulls cost plus fee, nothing comes back. Selling phase only. */
async function quoteBuyOf(c: ReturnType<typeof useApp>['client'], launcher: Address, q: SaleQuote, amount: bigint): Promise<readonly [bigint, bigint, bigint, bigint]> {
  if (q.kind === 'native') {
    return (await c.readContract({ address: launcher, abi: curveLauncherAbi, functionName: 'quoteBuy', args: [amount] })) as readonly [bigint, bigint, bigint, bigint];
  }
  const [tokens, cost, fee] = (await c.readContract({ address: launcher, abi: tokenCurveLauncherAbi, functionName: 'quoteBuy', args: [amount] })) as readonly [bigint, bigint, bigint];
  return [tokens, cost, fee, 0n];
}

/** Both conditions, in order: the first reason found. */
function both(a: Need, b: Need): Need {
  return async () => (await a()) ?? (await b());
}

/** A step that needs the sale in one phase: null while it is, else why not. */
function phaseNow(c: ReturnType<typeof useApp>['client'], launcher: Address, phase: number, why: string) {
  return async () => {
    const p = (await c.readContract({ address: launcher, abi: curveLauncherAbi, functionName: 'progress' })) as Progress;
    return p.phase === phase ? null : why;
  };
}

/** What a selling-phase step needs, read from the chain when it goes to the wallet: the sale still selling. */
function sellingNow(c: ReturnType<typeof useApp>['client'], launcher: Address) {
  return async () => {
    const p = (await c.readContract({ address: launcher, abi: curveLauncherAbi, functionName: 'progress' })) as Progress;
    return p.phase === PHASE.selling ? null : p.phase === PHASE.launched ? 'the sale has launched' : 'the sale has closed';
  };
}

/** The launcher's Launched event in a receipt. */
export function launchedIn(receipt: TransactionReceipt, launcher: Address): boolean {
  return parseEventLogs({ abi: curveLauncherAbi, logs: receipt.logs, eventName: 'Launched' }).some((l) => l.address.toLowerCase() === launcher.toLowerCase());
}

/** What the launcher paid in a receipt (its Unwound event), or undefined. */
export function unwoundIn(receipt: TransactionReceipt, launcher: Address): bigint | undefined {
  const l = parseEventLogs({ abi: curveLauncherAbi, logs: receipt.logs, eventName: 'Unwound' }).find((x) => x.address.toLowerCase() === launcher.toLowerCase());
  return l ? ((l.args as { paid: bigint }).paid ?? undefined) : undefined;
}

function UnwindBox({ launcher, sale }: { launcher: Address; sale: SaleRead }) {
  const { client } = useApp();
  const wallet = useWallet();
  const q = sale.quote;
  const sym = q.symbol;
  const { ready, gate } = useWriteGate();
  const tx = useTx({ decimals: q.decimals, ownerOnly: true });
  const [to, setTo] = useState('');
  const toOk = to.trim() === '' || isAddress(to.trim());
  const owed = sale.mine?.owed ?? 0n;
  // What the launcher would pay now: its own unwind, simulated in the latest block (it pays a share of what it holds).
  const estimate = useChainRead(
    async (c) => {
      if (!wallet.account || owed === 0n || !toOk) return undefined;
      const recipient = to.trim();
      const { result } =
        recipient !== ''
          ? await c.simulateContract({ account: wallet.account, address: launcher, abi: curveLauncherAbi, functionName: 'unwindTo', args: [recipient as Address] })
          : await c.simulateContract({ account: wallet.account, address: launcher, abi: curveLauncherAbi, functionName: 'unwind' });
      return result as bigint;
    },
    [launcher, wallet.account, owed, to.trim(), toOk],
  );
  const est = estimate.state === 'ok' ? estimate.value : undefined;
  return (
    <section className="sh-panel panel" data-testid="unwind-box">
      <div className="panel-head">
        <h2>Take your money back</h2>
        <Help label="Another address">
          <label className="field">
            <span className="field-label">Pay to</span>
            <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" disabled={tx.busy} data-testid="unwind-to" />
          </label>
          {!toOk ? <span className="refusal">Not an address.</span> : null}
        </Help>
      </div>
      {est !== undefined ? (
        <p className="pile-big" data-testid="owed">
          <span className="muted small">Estimate </span>
          <Amount value={est} decimals={q.decimals} symbol={sym} />
        </p>
      ) : wallet.account && sale.mine !== undefined && owed === 0n ? (
        <p className="muted" data-testid="owed-none">
          Nothing to take back.
        </p>
      ) : wallet.account ? (
        <p className="muted" data-testid="owed-reading">
          Reading…
        </p>
      ) : null}
      <div className="actions">
        {gate ??
          (ready ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!est || tx.busy || !toOk}
              data-testid="unwind"
              onClick={() =>
                void tx.run(
                  'Take back',
                  wallet,
                  async (press) => {
                    const recipient = to.trim();
                    const { request } =
                      recipient !== ''
                        ? await client.simulateContract({ account: press.account, address: launcher, abi: curveLauncherAbi, functionName: 'unwindTo', args: [recipient] })
                        : await client.simulateContract({ account: press.account, address: launcher, abi: curveLauncherAbi, functionName: 'unwind' });
                    return sendWrite(client, wallet, request, press, phaseNow(client, launcher, PHASE.failed, 'the sale is not in its refund phase'));
                  },
                  (receipt) => {
                    const paid = unwoundIn(receipt, launcher);
                    return paid === undefined
                      ? { ok: false, error: { name: 'not-unwound', sentence: 'Nothing was paid.' } }
                      : { ok: true, note: `Paid ${toDecimalString(paid, q.decimals)} ${sym}.` };
                  },
                )
              }
            >
              Take it back
            </button>
          ) : null)}
      </div>
      <TxStatus step={tx.step} />
    </section>
  );
}

/** The sale's creator, as the launcher records it: a rule paying it is named "Creator". */
function useLauncherCreator(launcher: Address): Address | undefined {
  const r = useChainRead(async (c) => (await c.readContract({ address: launcher, abi: curveLauncherAbi, functionName: 'creator' })) as Address, [launcher]);
  return r.state === 'ok' ? r.value : undefined;
}

/** What a Flap sale's rules share (RulesCurveLauncher: the curve fees at the launch; then the tax's rest). */
const FLAP_RULES_OF = "Of the curve fees at the launch, and of the tax left after Flap's share and the burned part.";

/** Before the launch: the parts stored for this sale on our rules vault factory (SH-287). */
function StoredRules({ launcher, pair, sale, trusted }: { launcher: Address; pair: FlapRulesPair; sale: SaleRead; trusted: boolean }) {
  const stored = useChainRead(
    async (c) => (await c.readContract({ address: pair.rulesVaultFactory, abi: rulesVaultFactoryAbi, functionName: 'rulesOf', args: [launcher] })) as readonly FixedRule[],
    [launcher, pair.rulesVaultFactory],
  );
  const creator = useLauncherCreator(launcher);
  // the token the sale will create (a shop or a stake can be made for it before the launch)
  const toCome = useChainRead(async (c) => (await c.readContract({ address: launcher, abi: curveLauncherAbi, functionName: 'predictedToken' })) as Address, [launcher]);
  if (stored.state !== 'ok') return null;
  return (
    <RulesPanel
      rail="flap"
      creator={creator}
      token={toCome.state === 'ok' ? toCome.value : undefined}
      fixed={stored.value.map((r) => ({ kind: Number(r.kind), bps: Number(r.bps), target: r.target }))}
      asset={{ symbol: sale.quote.symbol, decimals: sale.quote.decimals }}
      tokenSymbol={sale.config.symbol}
      writable={trusted}
      of={FLAP_RULES_OF}
    />
  );
}

function Launched({ launcher, sale, trusted, rulesPair, shop }: { launcher: Address; sale: SaleRead; trusted: boolean; rulesPair?: FlapRulesPair; shop: ReactNode }) {
  const { client } = useApp();
  const wallet = useWallet();
  const { ready, gate } = useWriteGate();
  const claimTx = useTx({ ownerOnly: true });
  const dispatchTx = useTx();
  const [token, , vaultSlot] = sale.launch;
  // SH-287: in a rules sale the vault slot is a splitter; it is shown only when our rules factory records it as this
  // token's (vaultOf, written in the same call that emits RulesVaultCreated), and the pile is the one it records.
  const ruled = useChainRead(
    async (c) => {
      if (!rulesPair) return null;
      const [vault, pile] = await Promise.all([
        c.readContract({ address: rulesPair.rulesVaultFactory, abi: rulesVaultFactoryAbi, functionName: 'vaultOf', args: [token] }) as Promise<Address>,
        c.readContract({ address: rulesPair.rulesVaultFactory, abi: rulesVaultFactoryAbi, functionName: 'pileOf', args: [token] }) as Promise<Address>,
      ]);
      return vault.toLowerCase() === vaultSlot.toLowerCase() && vault !== zeroAddress ? { splitter: vault, pile } : null;
    },
    [token, vaultSlot, rulesPair?.rulesVaultFactory],
  );
  const rules = ruled.state === 'ok' ? ruled.value : null;
  const creator = useLauncherCreator(launcher);
  const pileVault = rulesPair ? rules?.pile : vaultSlot;
  const tax = useChainRead(
    async (c) => {
      const proc = (await c.readContract({ address: token, abi: taxTokenAbi, functionName: 'taxProcessor' })) as Address;
      if (proc === zeroAddress) return null;
      const waiting = await c.readContract({ address: proc, abi: taxProcessorAbi, functionName: 'marketQuoteBalance' });
      return { proc, waiting };
    },
    [token],
  );
  const balance = useChainRead(
    async (c) => (wallet.account ? c.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet.account] }) : undefined),
    [token, wallet.account],
  );
  const claimable = sale.mine?.claimable ?? 0n;
  const t = tax.state === 'ok' ? tax.value : undefined;
  return (
    <>
      {trusted && (claimable > 0n || claimTx.step.kind !== 'idle') ? (
        <section className="sh-panel panel" data-testid="claim-box">
          <h2>Claim</h2>
          <p className="pile-big">
            <Amount value={claimable} decimals={18} symbol={sale.config.symbol} />
          </p>
          <div className="actions">
            {gate ??
              (ready ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={claimTx.busy || claimable === 0n}
                  data-testid="claim"
                  onClick={() =>
                    void claimTx.run('Claim', wallet, async (press) => {
                      const { request } = await client.simulateContract({ account: press.account, address: launcher, abi: curveLauncherAbi, functionName: 'claim' });
                      return sendWrite(client, wallet, request, press, phaseNow(client, launcher, PHASE.launched, 'the sale has not launched'));
                    })
                  }
                >
                  Claim
                </button>
              ) : null)}
          </div>
          <TxStatus step={claimTx.step} />
        </section>
      ) : null}
      <div className="split">
        <div className="side">
          {pileVault ? (
            <PilePanel pile={pileVault} writable={trusted ? { token } : undefined} />
          ) : rulesPair && ruled.state !== 'loading' ? (
            <p className="muted small" data-testid="rules-unknown">
              This sale&apos;s income goes to a vault this page did not create.
            </p>
          ) : null}
          {shop}
        </div>
        <div className="side">
          {trusted ? (
            <PoolTradeBox
              token={token}
              symbol={sale.config.symbol}
              tokenDecimals={18}
              balance={balance.state === 'ok' ? balance.value : undefined}
              buyTaxBps={sale.config.buyTaxBps}
              sellTaxBps={sale.config.sellTaxBps}
              taxNote="the rate set at creation, which may have ended"
              needs={phaseNow(client, launcher, PHASE.launched, 'the sale has not launched')}
              quote={sale.quote.kind === 'token' ? { address: sale.quote.address, symbol: sale.quote.symbol, decimals: sale.quote.decimals } : undefined}
            />
          ) : null}
          {rules ? (
            <RulesPanel
              rail="flap"
              creator={creator}
              token={token}
              splitter={rules.splitter}
              asset={{ symbol: sale.quote.symbol, decimals: sale.quote.decimals }}
              tokenSymbol={sale.config.symbol}
              writable={trusted}
              of={FLAP_RULES_OF}
            />
          ) : null}
          {trusted && t ? (
            <section className="sh-panel panel box-panel" data-testid="dispatch-box">
              <h3>Tax ready to send</h3>
              <p className="stat-value" data-testid="tax-waiting">
                {dispatchWaitingText(t.waiting) ?? <Amount value={t.waiting} decimals={sale.quote.decimals} symbol={sale.quote.symbol} />}
              </p>
              <div className="actions">
                {gate ??
                  (ready ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={dispatchTx.busy || t.waiting === 0n}
                      data-testid="dispatch"
                      onClick={() =>
                        void dispatchTx.run(rulesPair ? 'Send to the rules' : 'Send to the pile', wallet, async (press) => {
                          const { request } = await client.simulateContract({ account: press.account, address: t.proc, abi: taxProcessorAbi, functionName: 'dispatch' });
                          return sendWrite(client, wallet, request, press, async () =>
                            (await client.readContract({ address: t.proc, abi: taxProcessorAbi, functionName: 'marketQuoteBalance' })) > 0n ? null : 'no quote tax is ready to send',
                          );
                        })
                      }
                    >
                      {rulesPair ? 'Send to the rules' : 'Send to the pile'}
                    </button>
                  ) : null)}
              </div>
              <TxStatus step={dispatchTx.step} />
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}
