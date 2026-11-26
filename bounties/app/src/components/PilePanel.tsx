import { useEffect, useRef, useState } from 'react';
import { getAbiItem, zeroAddress, type AbiEvent, type Address, type GetContractEventsReturnType, type Hash, type PublicClient } from 'viem';
import { readEventsMany } from '../lib/logs';
import { erc20Abi, feeRulesAbi } from '../abi/feeRules';
import { formatAmount, toDecimalString } from '../lib/amounts';
import { minimumAtPress, sendWrite, useApp, useChainRead, useTx, withApproval } from '../lib/app-context';
import { Allowance } from './Allowance';
import { nativeSymbol, shortAddress, txUrl } from '../lib/chain';
import { PageRefusal } from '../lib/errors';
import { checkRedeem, redeemMinOut, REFUSALS } from '../lib/forms';
import { coinLabel, type AppConfig } from '../lib/config';
import { useWallet } from '../lib/wallet';
import { AddressLink, Age, Amount, Help, ReadError, Stat, TxStatus } from './bits';
import { useWriteGate } from './WalletBar';
import { useShareFigure } from '../picture/live-figures';

interface PileInfo {
  token: Address;
  asset: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  assetSymbol: string;
  assetDecimals: number;
}

interface PileNow {
  pile: bigint;
  circulating: bigint;
  received: bigint;
  paidOut: bigint;
  tokensRedeemed: bigint;
  /** What one whole token redeems for now (the contract's quote); undefined below one circulating token. */
  perToken?: bigint;
  balance?: bigint;
  allowance?: bigint;
}

export interface PileEvent {
  kind: 'revenue' | 'redeem';
  amount: bigint;
  tokensIn?: bigint;
  pileAfter: bigint;
  block: bigint;
  hash: Hash;
}

async function readInfo(c: PublicClient, pile: Address, config: AppConfig): Promise<PileInfo> {
  const [token, asset] = await Promise.all([
    c.readContract({ address: pile, abi: feeRulesAbi, functionName: 'token' }),
    c.readContract({ address: pile, abi: feeRulesAbi, functionName: 'asset' }),
  ]);
  const [tokenSymbol, tokenDecimals] = await Promise.all([
    c.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
    c.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  if (asset === zeroAddress) return { token, asset, tokenSymbol, tokenDecimals, assetSymbol: nativeSymbol(), assetDecimals: 18 };
  const [assetSymbol, assetDecimals] = await Promise.all([
    c.readContract({ address: asset, abi: erc20Abi, functionName: 'symbol' }),
    c.readContract({ address: asset, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  return { token, asset, tokenSymbol, tokenDecimals, assetSymbol: coinLabel(config, asset, assetSymbol), assetDecimals };
}

async function readNow(c: PublicClient, pile: Address, info: PileInfo, account?: Address): Promise<PileNow> {
  const one = 10n ** BigInt(info.tokenDecimals);
  const r = (fn: 'pile' | 'circulatingSupply' | 'totalReceived' | 'totalPaidOut' | 'totalTokensRedeemed') =>
    c.readContract({ address: pile, abi: feeRulesAbi, functionName: fn });
  const [p, circulating, received, paidOut, tokensRedeemed] = await Promise.all([
    r('pile'),
    r('circulatingSupply'),
    r('totalReceived'),
    r('totalPaidOut'),
    r('totalTokensRedeemed'),
  ]);
  // The contract's own quote for one whole token; below one circulating token there is nothing to quote.
  const perToken = circulating >= one ? await c.readContract({ address: pile, abi: feeRulesAbi, functionName: 'quoteRedeem', args: [one] }) : undefined;
  let balance: bigint | undefined;
  let allowance: bigint | undefined;
  if (account) {
    [balance, allowance] = await Promise.all([
      c.readContract({ address: info.token, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
      c.readContract({ address: info.token, abi: erc20Abi, functionName: 'allowance', args: [account, pile] }),
    ]);
  }
  return { pile: p, circulating, received, paidOut, tokensRedeemed, perToken, balance, allowance };
}

/** The pile's recognised revenue and redemptions from the deployment's first block, read in windows (lib/logs). */
export async function readPileEvents(c: PublicClient, pile: Address, fromBlock: string): Promise<{ start: bigint; events: PileEvent[] }> {
  const start = BigInt(fromBlock);
  // SH-303: both kinds in one query per window
  type Rev = GetContractEventsReturnType<typeof feeRulesAbi, 'RevenueRecognised'>[number];
  type Red = GetContractEventsReturnType<typeof feeRulesAbi, 'Redeemed'>[number];
  const both = await readEventsMany<(Rev | Red) & { eventName: string }>(c, {
    address: [pile],
    events: [getAbiItem({ abi: feeRulesAbi, name: 'RevenueRecognised' }), getAbiItem({ abi: feeRulesAbi, name: 'Redeemed' })] as AbiEvent[],
    fromBlock: start,
  });
  const rev = both.filter((l) => l.eventName === 'RevenueRecognised') as Rev[];
  const red = both.filter((l) => l.eventName === 'Redeemed') as Red[];
  type Raw = { block: bigint; index: number; hash: Hash; ev: Omit<PileEvent, 'pileAfter' | 'block' | 'hash'> & { pileAfter?: bigint } };
  const raw: Raw[] = [
    ...rev.map((l) => ({
      block: l.blockNumber,
      index: l.logIndex,
      hash: l.transactionHash,
      ev: { kind: 'revenue' as const, amount: l.args.amount ?? 0n, pileAfter: l.args.pileAfter },
    })),
    ...red.map((l) => ({
      block: l.blockNumber,
      index: l.logIndex,
      hash: l.transactionHash,
      ev: { kind: 'redeem' as const, amount: l.args.assetOut ?? 0n, tokensIn: l.args.tokensIn },
    })),
  ].sort((a, b) => (a.block === b.block ? a.index - b.index : a.block < b.block ? -1 : 1));
  let pileNow = 0n;
  const events = raw.map((r) => {
    pileNow = r.ev.kind === 'revenue' ? (r.ev.pileAfter ?? pileNow + r.ev.amount) : pileNow - r.ev.amount;
    return { kind: r.ev.kind, amount: r.ev.amount, tokensIn: r.ev.tokensIn, pileAfter: pileNow, block: r.block, hash: r.hash };
  });
  return { start, events };
}

/** The pile over the events' window, one step per event, ending at the pile right now. */
function PileChart({ events, now, decimals, symbol }: { events: PileEvent[]; now: bigint; decimals: number; symbol: string }) {
  const points = [0n, ...events.map((e) => e.pileAfter), now];
  const max = points.reduce((m, v) => (v > m ? v : m), 0n);
  const W = 320;
  const H = 96;
  const n = points.length - 1;
  const y = (v: bigint) => (max === 0n ? H - 2 : H - 2 - Number(((v * 1000n) / max) * BigInt(H - 6)) / 1000);
  const x = (i: number) => (n === 0 ? 0 : (i / n) * W);
  let d = `M 0 ${y(points[0] ?? 0n)}`;
  points.forEach((v, i) => {
    if (i === 0) return;
    d += ` H ${x(i)} V ${y(v)}`;
  });
  return (
    <figure className="pile-chart" aria-label={`Pile over time, now ${formatAmount(now, decimals)} ${symbol}`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        <path d={`${d} V ${H} H 0 Z`} className="pile-area" />
        <path d={d} className="pile-line" fill="none" />
      </svg>
    </figure>
  );
}

/**
 * The pile panel. Any pile can be READ. Writes (approve, redeem) only when `writable` is given: a pile the deployment
 * file names, or one taken from a verified sale or token; with `writable.token` the pile's own token must be that
 * token, or the panel stays read only. `gas`: a fixed gas limit for its writes (a tax token's estimates come out short).
 */
export function PilePanel({ pile, gas, writable }: { pile: Address; gas?: bigint; writable?: { token?: Address } }) {
  const { config } = useApp();
  const wallet = useWallet();
  const info = useChainRead((c) => readInfo(c, pile, config), [pile]);
  const now = useChainRead(
    (c) => (info.state === 'ok' ? readNow(c, pile, info.value, wallet.account) : Promise.resolve(undefined)),
    [pile, info.state, wallet.account],
    { keepOnChange: true, owner: wallet.account ?? '', forOtherOwner: (v) => (v ? { ...v, balance: undefined, allowance: undefined } : v) },
  );
  const events = useChainRead((c) => readPileEvents(c, pile, config.fromBlock), [pile]);
  // SH-319: the pile's amount for the page's picture (this panel's own read).
  useShareFigure(
    'pile',
    info.state === 'ok' && now.state === 'ok' && now.value ? { value: now.value.pile, decimals: info.value.assetDecimals, symbol: info.value.assetSymbol } : undefined,
  );

  if (info.state === 'error' && info.error.name !== 'unknown') {
    // The chain answered: this address does not answer as a pile.
    return (
      <section className="sh-panel panel" data-testid="pile-panel" data-absent="">
        <p className="muted">No pile at {shortAddress(pile)}.</p>
      </section>
    );
  }
  if (info.state !== 'ok' || now.state !== 'ok' || now.value === undefined) {
    const failed = info.state === 'error' || now.state === 'error';
    return (
      <section className="sh-panel panel" data-testid="pile-panel" aria-busy="true">
        <p className="muted">{failed ? 'Could not read the pile yet. Trying again.' : 'Reading the pile…'}</p>
      </section>
    );
  }
  const pairOk = !writable?.token || writable.token.toLowerCase() === info.value.token.toLowerCase();
  return (
    <>
    {events.state === 'error' ? <ReadError text="Could not read the pile's history." testId="history-error" /> : null}
    <PileBody
      pile={pile}
      i={info.value}
      n={now.value}
      at={now.at}
      stale={now.stale}
      ev={events.state === 'ok' ? events.value : undefined}
      gas={gas}
      canWrite={Boolean(writable) && pairOk}
    />
    </>
  );
}

function PileBody(props: {
  pile: Address;
  i: PileInfo;
  n: PileNow;
  at: number;
  stale: boolean;
  ev?: { start: bigint; events: PileEvent[] };
  gas?: bigint;
  canWrite: boolean;
}) {
  const { pile, i, n, ev, gas, canWrite } = props;
  // The pile's last change since this page first read it: every trade shows here.
  const prev = useRef<bigint | null>(null);
  const [delta, setDelta] = useState<bigint | null>(null);
  useEffect(() => {
    if (prev.current !== null && prev.current !== n.pile) setDelta(n.pile - prev.current);
    prev.current = n.pile;
  }, [n.pile]);
  return (
    <section className="sh-panel panel" data-testid="pile-panel" data-writable={canWrite ? 'yes' : 'no'}>
      <header className="panel-head">
        <h2>
          Pile <span className="muted">· {i.tokenSymbol}</span>
        </h2>
        <span className="head-end">
          <Age at={props.at} stale={props.stale} />
          <Help label="About the pile">
            A holder hands tokens in and receives pile × tokens handed in ÷ tokens in circulation, rounded down. Tokens
            handed in go to the dead address. Some addresses (a launch vault) cannot redeem. Every token that is not burned and not
            in the pile counts, in the pool and unclaimed ones included: each token has the same claim on the pile wherever it
            sits. Pile <AddressLink address={pile} />,
            token <AddressLink address={i.token} />.
          </Help>
        </span>
      </header>
      <div className="pile-hero">
        <div className="pile-big" data-testid="pile-size">
          <Amount value={n.pile} decimals={i.assetDecimals} symbol={i.assetSymbol} />
          {delta !== null ? (
            <span className={`delta ${delta > 0n ? 'pos' : 'neg'}`} data-testid="pile-delta">
              {delta > 0n ? '+' : '−'}
              <Amount value={delta > 0n ? delta : -delta} decimals={i.assetDecimals} />
            </span>
          ) : null}
        </div>
        {ev ? <PileChart events={ev.events} now={n.pile} decimals={i.assetDecimals} symbol={i.assetSymbol} /> : null}
      </div>
      <div className="stats">
        <Stat label={`1 ${i.tokenSymbol} redeems for`} testId="per-token">
          {n.perToken !== undefined ? <Amount value={n.perToken} decimals={i.assetDecimals} symbol={i.assetSymbol} /> : '-'}
        </Stat>
        <Stat label="In circulation" testId="circulating">
          <Amount value={n.circulating} decimals={i.tokenDecimals} symbol={i.tokenSymbol} />
        </Stat>
        <Stat label="Paid out" testId="paid-out">
          <Amount value={n.paidOut} decimals={i.assetDecimals} symbol={i.assetSymbol} />
        </Stat>
        <Stat label="Received" testId="received">
          <Amount value={n.received} decimals={i.assetDecimals} symbol={i.assetSymbol} />
        </Stat>
      </div>
      {canWrite ? (
        <RedeemBox pile={pile} info={i} now={n} gas={gas} />
      ) : (
        <p className="muted small" data-testid="read-only">
          Read only: this page does not send to this pile.
        </p>
      )}
      {ev ? <Activity events={ev.events} start={ev.start} info={i} /> : null}
    </section>
  );
}

function RedeemBox({ pile, info, now, gas }: { pile: Address; info: PileInfo; now: PileNow; gas?: bigint }) {
  const wallet = useWallet();
  const { client } = useApp();
  const { ready, gate } = useWriteGate();
  const tx = useTx({ decimals: info.assetDecimals });
  const [amountText, setAmountText] = useState('');
  const [guardText, setGuardText] = useState('0.5');
  // Pending writes belong to the pile and account they were prepared for: a change of either drops them.
  useEffect(() => tx.reset(), [pile]); // eslint-disable-line react-hooks/exhaustive-deps
  const checked = checkRedeem({
    amountText,
    guardText,
    decimals: info.tokenDecimals,
    balance: now.balance,
    circulating: now.circulating,
  });
  const quote = useChainRead(
    (c) =>
      checked.ok
        ? c.readContract({ address: pile, abi: feeRulesAbi, functionName: 'quoteRedeem', args: [checked.value.amount] })
        : Promise.resolve(undefined),
    [pile, checked.ok ? checked.value.amount : -1n],
  );
  const q = quote.state === 'ok' ? quote.value : undefined;
  const min = checked.ok && q !== undefined ? redeemMinOut(q, checked.value.guardBps) : undefined;
  const empty = now.pile === 0n;
  const forNothing = q !== undefined && (q === 0n || min === 0n);
  const whole = checked.ok && checked.value.amount === now.circulating;

  const redeem = () =>
    checked.ok &&
    min !== undefined &&
    tx.run('Redeem', wallet, async (press) => {
      const amount = checked.value.amount;
      const quoteNow = async () => {
        const fresh = await client.readContract({ address: pile, abi: feeRulesAbi, functionName: 'quoteRedeem', args: [amount] });
        if (fresh === 0n) throw new PageRefusal('nothing', 'This amount redeems for nothing.');
        return minimumAtPress(fresh, checked.value.guardBps, min);
      };
      // The quote at the press (a zero or worse one stops it before any approval), the approval of exactly this amount
      // to the pile when the allowance is not exactly it, then the quote again: the minimum sent is from that read.
      const first = await quoteNow();
      // Every step needs the pile still naming this token and its quote at least the minimum, read when it goes.
      const meets = (least: bigint) => async () => {
        const [t, q] = await Promise.all([
          client.readContract({ address: pile, abi: feeRulesAbi, functionName: 'token' }),
          client.readContract({ address: pile, abi: feeRulesAbi, functionName: 'quoteRedeem', args: [amount] }),
        ]);
        if ((t as string).toLowerCase() !== info.token.toLowerCase()) return 'the pile names another token';
        return q >= least && q > 0n ? null : 'the quote moved below your minimum';
      };
      await withApproval(client, wallet, press, {
        token: info.token,
        spender: pile,
        amount,
        approveLabel: `Approve ${toDecimalString(amount, info.tokenDecimals)} ${info.tokenSymbol} for the pile`,
        mainLabel: 'Redeem',
        need: meets(first),
        gas,
      });
      const least = await quoteNow();
      const { request } = await client.simulateContract({
        account: press.account,
        address: pile,
        abi: feeRulesAbi,
        functionName: 'redeem',
        args: [checked.value.amount, least],
        gas,
      });
      return sendWrite(client, wallet, request, press, meets(least), gas);
    });

  return (
    <div className="box" data-testid="redeem-box">
      <h3>Redeem</h3>
      <div className="field-row">
        <label className="field">
          <span className="field-label">
            {info.tokenSymbol} to hand in
            {now.balance !== undefined ? (
              <button type="button" className="link-btn" disabled={tx.busy} onClick={() => setAmountText(toDecimalString(now.balance ?? 0n, info.tokenDecimals))}>
                you hold {formatAmount(now.balance, info.tokenDecimals)}
              </button>
            ) : null}
          </span>
          <input inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="0" disabled={tx.busy} data-testid="redeem-amount" />
        </label>
        <label className="field field-narrow">
          <span className="field-label">Guard %</span>
          <input inputMode="decimal" value={guardText} onChange={(e) => setGuardText(e.target.value)} disabled={tx.busy} data-testid="redeem-guard" />
        </label>
      </div>
      {empty ? (
        <p className="refusal" data-testid="redeem-refusal">
          The pile is empty.
        </p>
      ) : amountText !== '' && !checked.ok ? (
        <p className="refusal" data-testid="redeem-refusal">
          {REFUSALS[checked.refusal]}
        </p>
      ) : forNothing ? (
        <p className="refusal" data-testid="redeem-refusal">
          This amount redeems for nothing.
        </p>
      ) : null}
      {checked.ok && q !== undefined && min !== undefined && !forNothing && !empty ? (
        <p className="review" data-testid="redeem-review">
          {/* The last tokens in circulation are paid the whole pile as it stands after the hand-in: the quote or more. */}
          Quote <Amount value={q} decimals={info.assetDecimals} symbol={info.assetSymbol} />
          {whole ? ' or more' : ''} · at least <Amount value={min} decimals={info.assetDecimals} symbol={info.assetSymbol} />
        </p>
      ) : null}
      <div className="actions">
        {gate ??
          (ready ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!checked.ok || min === undefined || tx.busy || empty || forNothing}
              onClick={redeem}
              data-testid="redeem"
            >
              Redeem
            </button>
          ) : null)}
      </div>
      <TxStatus step={tx.step} />
      <Allowance token={info.token} spender={pile} symbol={info.tokenSymbol} decimals={info.tokenDecimals} to="the pile" />
    </div>
  );
}

function Activity({ events, start, info }: { events: PileEvent[]; start: bigint; info: PileInfo }) {
  const { config } = useApp();
  const last = events.slice(-8).reverse();
  if (last.length === 0) return null;
  return (
    <div className="activity" data-testid="pile-activity">
      <h3>
        Latest <span className="muted small">since block {start.toString()}</span>
      </h3>
      <ul>
        {last.map((e) => (
          <li key={`${e.hash}-${e.kind}-${e.amount}`}>
            <span className={e.kind === 'revenue' ? 'pos' : 'neg'}>
              {e.kind === 'revenue' ? '+' : '−'}
              <Amount value={e.amount} decimals={info.assetDecimals} symbol={info.assetSymbol} />
            </span>
            <span className="muted small">
              {e.kind === 'revenue' ? (
                'received'
              ) : (
                <>
                  <Amount value={e.tokensIn ?? 0n} decimals={info.tokenDecimals} symbol={info.tokenSymbol} /> handed in
                </>
              )}
            </span>
            <a className="mono small" href={txUrl(config, e.hash)} target="_blank" rel="noreferrer">
              {shortAddress(e.hash)}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
