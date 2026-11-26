import { useEffect, useState } from 'react';
import type { Address, PublicClient } from 'viem';
import { erc20Abi } from '../abi/feeRules';
import { ROUTER_97, routerAbi, WBNB_97 } from '../abi/flap';
import { BPS, formatBps, minOut, parseAmount, parsePercentToBps, toDecimalString } from '../lib/amounts';
import { minimumAtPress, sendWrite, useApp, useChainRead, useTx, withApproval, type Need } from '../lib/app-context';
import { nativeSymbol } from '../lib/chain';
import { PageRefusal } from '../lib/errors';
import { REFUSALS, type Refusal } from '../lib/forms';
import { useWallet } from '../lib/wallet';
import { Amount, TxStatus } from './bits';
import { useWriteGate } from './WalletBar';

const tokenSwapAbi = [
  {
    type: 'function',
    name: 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

/** The router's output for an input less the token's tax on that side; refused when the router gives no output. */
export async function poolQuote(
  c: PublicClient,
  router: Address,
  path: readonly [Address, Address],
  amountIn: bigint,
  side: 'buy' | 'sell',
  taxBps: bigint,
): Promise<bigint> {
  const inAfterTax = side === 'sell' ? (amountIn * (BPS - taxBps)) / BPS : amountIn;
  const amounts = await c.readContract({ address: router, abi: routerAbi, functionName: 'getAmountsOut', args: [inAfterTax, [...path]] });
  const out = amounts[1];
  if (out === undefined) throw new PageRefusal('no-quote', 'The pool gave no quote.');
  return side === 'buy' ? (out * (BPS - taxBps)) / BPS : out;
}

/**
 * Buy and sell on the token's PancakeSwap V2 pool after the launch. The pool's other side is BNB (the Flap rail) or an
 * ERC-20 quote coin (the OpenFour rail), each in its own decimals. The quote is the router's `getAmountsOut` less the
 * token's tax on that side; at the press it is read again and the minimum taken from it with the guard on screen.
 * The router is the deployment's (never from the page's address); approvals are of the amount entered.
 */
export function PoolTradeBox(props: {
  token: Address;
  symbol: string;
  tokenDecimals: number;
  balance?: bigint;
  buyTaxBps: number;
  sellTaxBps: number;
  router?: Address;
  /** The pool's other side when it is an ERC-20 (absent: BNB). */
  quote?: { address: Address; symbol: string; decimals: number; balance?: bigint };
  /** A fixed gas limit for every write (tax tokens). */
  gas?: bigint;
  /** The chain state every step of a trade needs (the pool live), read when it goes to the wallet. */
  needs: Need;
  /** What the tax rate rests on, shown beside the minimum (e.g. that the tax may have ended). */
  taxNote?: string;
  /** The guard's starting value in percent (3 by default). */
  defaultGuard?: string;
}) {
  const { token, symbol, balance, quote, tokenDecimals } = props;
  const { config, client } = useApp();
  const wallet = useWallet();
  const router = props.router ?? config.flap?.router ?? ROUTER_97;
  const wbnb = config.flap?.wbnb ?? WBNB_97;
  const other = quote?.address ?? wbnb;
  const otherSym = quote?.symbol ?? nativeSymbol();
  const otherDecimals = quote?.decimals ?? 18;
  const { ready, gate } = useWriteGate();
  const tx = useTx({ decimals: otherDecimals });
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [text, setText] = useState('');
  const [guardText, setGuardText] = useState(props.defaultGuard ?? '3');
  useEffect(() => tx.reset(), [token, side]); // eslint-disable-line react-hooks/exhaustive-deps
  const guard = parsePercentToBps(guardText);
  const inDecimals = side === 'buy' ? otherDecimals : tokenDecimals;
  const outDecimals = side === 'buy' ? tokenDecimals : otherDecimals;
  const a = parseAmount(text, inDecimals);
  const held = side === 'sell' ? balance : quote?.balance;
  const refusal: Refusal | undefined = !a.ok ? a.reason : held !== undefined && a.value > held ? 'over-balance' : !guard.ok ? 'bad-guard' : undefined;
  const taxBps = BigInt(side === 'buy' ? props.buyTaxBps : props.sellTaxBps);
  const spend = side === 'sell' ? token : quote?.address;
  const path: readonly [Address, Address] = side === 'buy' ? [other, token] : [token, other];
  const read = useChainRead(
    async (c) => {
      if (!a.ok || refusal) return undefined;
      const out = await poolQuote(c, router, path, a.value, side, taxBps);
      return { out };
    },
    [side, a.ok ? a.value : -1n, refusal, token, router],
  );
  const q = read.state === 'ok' ? read.value : undefined;
  const least = q && guard.ok ? minOut(q.out, guard.value) : undefined;

  const go = () => {
    if (!a.ok || least === undefined || !guard.ok) return;
    const label = side === 'buy' ? 'Buy' : 'Sell';
    void tx.run(label, wallet, async (press) => {
      // Every step needs the pool live and its quote at least the minimum on screen, read when it goes to the wallet.
      const quoteMeets = (min: bigint) => async () => ((await poolQuote(client, router, path, a.value, side, taxBps)) >= min ? null : 'the quote moved below your minimum');
      const before = least;
      // An ERC-20 input goes to the router through an exact approval first, when the allowance is not exactly it.
      if (spend) {
        await withApproval(client, wallet, press, {
          token: spend,
          spender: router,
          amount: a.value,
          approveLabel: `Approve ${toDecimalString(a.value, inDecimals)} ${side === 'sell' ? symbol : otherSym} for the pool router`,
          mainLabel: label,
          need: async () => (await props.needs()) ?? (await quoteMeets(before)()),
          gas: props.gas,
        });
      }
      const fresh = await poolQuote(client, router, path, a.value, side, taxBps);
      const min = minimumAtPress(fresh, guard.value, least);
      const need = async () => (await props.needs()) ?? (await quoteMeets(min)());
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
      if (quote) {
        const { request } = await client.simulateContract({
          account: press.account,
          address: router,
          abi: tokenSwapAbi,
          functionName: 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
          args: [a.value, min, [...path], press.account, deadline],
          gas: props.gas,
        });
        return sendWrite(client, wallet, request, press, need, props.gas);
      }
      if (side === 'buy') {
        const { request } = await client.simulateContract({
          account: press.account,
          address: router,
          abi: routerAbi,
          functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
          args: [min, [...path], press.account, deadline],
          value: a.value,
          gas: props.gas,
        });
        return sendWrite(client, wallet, request, press, need, props.gas);
      }
      const { request } = await client.simulateContract({
        account: press.account,
        address: router,
        abi: routerAbi,
        functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
        args: [a.value, min, [...path], press.account, deadline],
        gas: props.gas,
      });
      return sendWrite(client, wallet, request, press, need, props.gas);
    });
  };

  return (
    <section className="sh-panel panel box-panel" data-testid="pool-trade">
      <div className="panel-head">
        <h3>Trade</h3>
        <a href={`https://pancakeswap.finance/swap?chain=bscTestnet&outputCurrency=${token}${quote ? `&inputCurrency=${quote.address}` : ''}`} target="_blank" rel="noreferrer" className="small">
          PancakeSwap ↗
        </a>
      </div>
      <div className="segmented" role="tablist">
        {(['buy', 'sell'] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={side === s} className={side === s ? 'on' : ''} onClick={() => setSide(s)} disabled={tx.busy} data-testid={`trade-${s}-tab`}>
            {s === 'buy' ? 'Buy' : 'Sell'}
          </button>
        ))}
      </div>
      <div className="field-row">
        <label className="field">
          <span className="field-label">
            {side === 'buy' ? `${otherSym} to spend` : `${symbol} to sell`}
            {held !== undefined ? (
              <span className="muted">
                you hold <Amount value={held} decimals={inDecimals} />
              </span>
            ) : null}
          </span>
          <input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="0" disabled={tx.busy} data-testid="trade-amount" />
        </label>
        <label className="field field-narrow">
          <span className="field-label">Guard %</span>
          <input inputMode="decimal" value={guardText} onChange={(e) => setGuardText(e.target.value)} disabled={tx.busy} data-testid="trade-guard" />
        </label>
      </div>
      {text !== '' && refusal ? <p className="refusal">{REFUSALS[refusal]}</p> : null}
      {q && least !== undefined ? (
        <p className="review" data-testid="trade-review">
          Quote <Amount value={q.out} decimals={outDecimals} symbol={side === 'buy' ? symbol : otherSym} /> · at least <Amount value={least} decimals={outDecimals} />
          {taxBps > 0n ? (
            <span className="muted small" data-testid="trade-tax-note">
              {' '}
              · counts the token&apos;s {formatBps(taxBps)} {side === 'buy' ? 'buy' : 'sell'} tax{props.taxNote ? `, ${props.taxNote}` : ''}
            </span>
          ) : null}
        </p>
      ) : null}
      <div className="actions">
        {gate ??
          (ready ? (
            <button type="button" className="btn btn-primary" disabled={!!refusal || !least || tx.busy} onClick={go} data-testid="trade">
              {side === 'buy' ? 'Buy' : 'Sell'}
            </button>
          ) : null)}
      </div>
      <TxStatus step={tx.step} />
    </section>
  );
}
