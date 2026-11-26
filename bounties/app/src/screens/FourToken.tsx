import { usePageTitle } from '../lib/page-title';
import { useEffect, useState } from 'react';
import { parseEventLogs, zeroAddress, type Address, type PublicClient } from 'viem';
import { erc20Abi } from '../abi/feeRules';
import {
  FOUR_MIGRATED,
  FOUR_PHASE,
  FOUR_ROUTER_97,
  forwardVaultAbi,
  fourCoreAbi,
  fourToolsAbi,
  fourVaultAbi,
  pileTaxVaultAbi,
  pileTradeModuleAbi,
  rulesTaxVaultAbi,
  TAX_TOKEN_GAS,
  taxRatesAbi,
  taxTokenFounderAbi,
  transferAbi,
  wbnbAbi,
  type FourEstimate,
  type FourTokenInfo,
} from '../abi/openfour';
import { feeRulesAbi } from '../abi/feeRules';
import { AddressLink, Age, Amount, Help, Stat, TxStatus } from '../components/bits';
import { PilePanel } from '../components/PilePanel';
import { FINAL_SAYS, RulesPanel, type FixedRule } from '../components/RulesPanel';
import { FOUR_SET_UP_SAYS, fourRulesState, ruleName } from '../lib/rules';
import { PoolTradeBox } from '../components/PoolTradeBox';
import { HoldersPanel } from '../components/HoldersPanel';
import { fourPayees } from '../lib/stake';
import { useWriteGate } from '../components/WalletBar';
import { formatBps, minOut, parseAmount, parsePercentToBps, shareBps, toDecimalString } from '../lib/amounts';
import { minimumAtPress, NO_STATE, sendWrite, useApp, useChainRead, useTx, withApproval } from '../lib/app-context';
import { PageRefusal } from '../lib/errors';
import { Allowances } from '../components/Allowance';
import { nativeSymbol, shortAddress } from '../lib/chain';
import { coinLabel, type AppConfig, type OpenFourToken } from '../lib/config';
import { REFUSALS, type Refusal } from '../lib/forms';
import { useWallet } from '../lib/wallet';
import { ShopLinks } from '../components/ShopLinks';
import { FourPicture } from '../components/LaunchPicture';
import { FiguresShare, useLiveFigures } from '../picture/live-figures';
import { fourLivePicture } from '../picture/live-picture';
import { LivePicture, type PartTargets } from '../picture/LivePicture';

const TOKEN_FIELDS = [
  'version', 'creator', 'presetId', 'token', 'name', 'symbol', 'maxSupply', 'saleAmount', 'raiseAmount', 'quoteAsset',
  'vault', 'curveModule', 'tradeModule', 'migrateModule', 'tokenModule', 'customData', 'createBlock', 'exists', 'paused',
] as const;
const TRADING = 1;

export async function readFourToken(c: PublicClient, core: Address, token: Address): Promise<FourTokenInfo> {
  const r = (await c.readContract({ address: core, abi: fourCoreAbi, functionName: 'tokens', args: [token] })) as readonly unknown[];
  return Object.fromEntries(TOKEN_FIELDS.map((k, i) => [k, r[i]])) as unknown as FourTokenInfo;
}

/** EIP-1167 clone code of `impl` (OpenZeppelin's 45-byte runtime): a tax vault must be a clone of our template. */
export function isCloneOf(code: string | undefined, impl: Address): boolean {
  return (code ?? '').toLowerCase() === `0x363d3d373d3d3d363d73${impl.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
}

/**
 * The token's kind, pile and whether this page may send for it. Core says the token exists and which preset made it;
 * a preset token's pile is its Trade module's, a tax token's pile is its tax vault's, which must be a clone of our
 * template. Either pile must name this token. A token the deployment file lists counts as ours when the file carries
 * no preset ids. Read errors are thrown: "no pile" is only said when the vault answered that it has none.
 */
/**
 * SH-303: a tax token's kind, vault, pile and rules are set once on chain (the vault's pile, a rules token's splitter):
 * kept for the visit once it is ours and set up, so a poll reads only what changes (the sale, the counters). A preset
 * token is never kept: its pile is its trade module's, and the module sits behind an upgradeable beacon.
 */
export function keptForVisit(found: { ours: boolean; pile?: Address; kind: 'preset' | 'tax' | 'tax-rules'; rules?: { splitter?: Address } }): boolean {
  if (!found.ours || !found.pile) return false;
  return found.kind === 'tax' || (found.kind === 'tax-rules' && Boolean(found.rules?.splitter));
}

const settled = new Map<string, Awaited<ReturnType<typeof findPileOnChain>>>();

export async function findPile(c: PublicClient, config: AppConfig, entry: OpenFourToken | undefined, info: FourTokenInfo) {
  const key = `${config.openfour?.core ?? ''}|${String(info.token).toLowerCase()}`;
  const had = settled.get(key);
  if (had) return had;
  const found = await findPileOnChain(c, config, entry, info);
  if (keptForVisit(found)) settled.set(key, found);
  return found;
}

async function findPileOnChain(c: PublicClient, config: AppConfig, entry: OpenFourToken | undefined, info: FourTokenInfo) {
  const o = config.openfour!;
  const presetId = String(info.presetId);
  let kind: FourKindRead =
    o.taxPresetId !== undefined && presetId === o.taxPresetId ? 'tax' : o.presetId !== undefined && presetId === o.presetId ? 'preset' : entry?.kind === 'tax-rules' ? 'tax' : (entry?.kind ?? 'preset');
  const known = (o.presetId !== undefined && presetId === o.presetId) || (o.taxPresetId !== undefined && presetId === o.taxPresetId);
  let pile: Address | undefined;
  let clone: Address | undefined;
  // A preset token needs no vault; a tax token's vault must be proven: a clone of our template (no template in the
  // file, no proof, no writes), reached from the token's own founder, so it is bound to this token.
  let cloneOk = kind !== 'tax';
  let rules: RulesRead | undefined;
  if (kind === 'tax') {
    const founder = (await c.readContract({ address: info.token as Address, abi: taxTokenFounderAbi, functionName: 'founder' })) as Address;
    clone = (await c.readContract({ address: founder, abi: forwardVaultAbi, functionName: 'clonedVault' })) as Address;
    const code = await c.getBytecode({ address: clone });
    // SH-287: a clone of our rules template is a tax-rules token; its rules are shown only then.
    if (o.rulesTemplate && isCloneOf(code, o.rulesTemplate)) {
      kind = 'tax-rules';
      const r = (functionName: string) => c.readContract({ address: clone!, abi: rulesTaxVaultAbi, functionName });
      const [creator, creatorBps, pileBps, burnBps, splitter] = (await Promise.all([r('creator'), r('creatorBps'), r('pileBps'), r('burnBps'), r('splitter')])) as [
        Address,
        number,
        number,
        number,
        Address,
      ];
      const fixed: FixedRule[] = [];
      if (Number(creatorBps) > 0) fixed.push({ kind: 1, bps: Number(creatorBps), target: creator });
      if (Number(pileBps) > 0) fixed.push({ kind: 2, bps: Number(pileBps), target: zeroAddress });
      if (Number(burnBps) > 0) fixed.push({ kind: 3, bps: Number(burnBps), target: zeroAddress });
      rules = { fixed, splitter: splitter === zeroAddress ? undefined : splitter };
    }
    cloneOk = kind === 'tax-rules' || (Boolean(o.taxTemplate) && isCloneOf(code, o.taxTemplate!));
    if (cloneOk) {
      // The clone must also be set up for this token and its quote coin, with or without a pile yet.
      const [forToken, forQuote] = await Promise.all([
        c.readContract({ address: clone, abi: pileTaxVaultAbi, functionName: 'taxVaultToken' }) as Promise<Address>,
        c.readContract({ address: clone, abi: pileTaxVaultAbi, functionName: 'taxVaultQuote' }) as Promise<Address>,
      ]);
      cloneOk = forToken.toLowerCase() === (info.token as string).toLowerCase() && forQuote.toLowerCase() === (info.quoteAsset as string).toLowerCase();
    }
    const p = (await c.readContract({ address: clone, abi: pileTaxVaultAbi, functionName: 'pile' })) as Address;
    pile = p === zeroAddress ? undefined : p;
  } else {
    const p = (await c.readContract({ address: info.tradeModule, abi: pileTradeModuleAbi, functionName: 'pile' })) as Address;
    pile = p === zeroAddress ? undefined : p;
  }
  const pileToken = pile ? await c.readContract({ address: pile, abi: feeRulesAbi, functionName: 'token' }) : undefined;
  const pairOk = !pile || pileToken?.toLowerCase() === (info.token as string).toLowerCase();
  const ours = info.exists && pairOk && cloneOk && (known || (o.presetId === undefined && o.taxPresetId === undefined && Boolean(entry)));
  return { kind, pile, clone, ours, rules };
}

type FourKindRead = 'preset' | 'tax' | 'tax-rules';

/** A tax-rules token's rules as its clone fixed them, and the splitter once createRules made it. */
interface RulesRead {
  fixed: FixedRule[];
  splitter?: Address;
}

interface FourRead {
  info: FourTokenInfo;
  phase: number;
  remaining: bigint;
  raised: bigint;
  quoteSymbol: string;
  quoteDecimals: number;
  tokenDecimals: number;
  pile?: Address;
  clone?: Address;
  kind: FourKindRead;
  ours: boolean;
  rules?: RulesRead;
  fees?: { buy: number; sell: number };
  /** The tax booked and not yet paid out: in the quote coin and in the token's own units (its own counters). */
  taxWaiting?: { quote: bigint; tokens: bigint };
  taxRates?: { buy: number; sell: number };
  mine?: { quote: bigint; token: bigint };
}

async function readAll(c: PublicClient, config: AppConfig, token: Address, entry: OpenFourToken | undefined, account?: Address): Promise<FourRead> {
  const core = config.openfour!.core;
  const info = await readFourToken(c, core, token);
  const v = (functionName: string) => c.readContract({ address: info.vault, abi: fourVaultAbi, functionName });
  const [phase, remaining, raised, quoteSymbol, quoteDecimals, tokenDecimals, found] = await Promise.all([
    v('phase') as Promise<number>,
    v('remainingForSale') as Promise<bigint>,
    v('totalRaised') as Promise<bigint>,
    c.readContract({ address: info.quoteAsset, abi: erc20Abi, functionName: 'symbol' }),
    c.readContract({ address: info.quoteAsset, abi: erc20Abi, functionName: 'decimals' }),
    c.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
    findPile(c, config, entry, info),
  ]);
  let fees: FourRead['fees'];
  let taxWaiting: FourRead['taxWaiting'];
  let taxRates: FourRead['taxRates'];
  if (found.kind === 'preset') {
    const [b, s] = await Promise.all([
      c.readContract({ address: info.tradeModule, abi: pileTradeModuleAbi, functionName: 'buyFeeBps' }) as Promise<number>,
      c.readContract({ address: info.tradeModule, abi: pileTradeModuleAbi, functionName: 'sellFeeBps' }) as Promise<number>,
    ]);
    fees = { buy: Number(b), sell: Number(s) };
  } else {
    // A tax token books its tax in its own counters (in the quote coin and in tokens) until a transfer pays it out.
    const [inQuote, inTokens, b, s] = await Promise.all([
      c.readContract({ address: token, abi: taxRatesAbi, functionName: 'feeAccumulated' }),
      c.readContract({ address: token, abi: taxRatesAbi, functionName: 'tokenAccumulated' }),
      c.readContract({ address: token, abi: taxRatesAbi, functionName: 'buyFeeRate' }),
      c.readContract({ address: token, abi: taxRatesAbi, functionName: 'sellFeeRate' }),
    ]);
    taxWaiting = { quote: inQuote, tokens: inTokens };
    taxRates = { buy: Number(b), sell: Number(s) };
  }
  let mine: FourRead['mine'];
  if (account) {
    const [q, t] = await Promise.all([
      c.readContract({ address: info.quoteAsset, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
      c.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    ]);
    mine = { quote: q, token: t };
  }
  return {
    info,
    phase: Number(phase),
    remaining,
    raised,
    quoteSymbol: coinLabel(config, info.quoteAsset, quoteSymbol),
    quoteDecimals,
    tokenDecimals,
    pile: found.pile,
    clone: found.clone,
    kind: found.kind,
    ours: found.ours,
    rules: found.rules,
    fees,
    taxWaiting,
    taxRates,
    mine,
  };
}

/** A curve step needs the token still trading on its curve, read when it goes to the wallet. */
function onCurveNow(c: PublicClient, core: Address, token: Address) {
  return async () => {
    const info = await readFourToken(c, core, token);
    const phase = Number(await c.readContract({ address: info.vault, abi: fourVaultAbi, functionName: 'phase' }));
    return phase === TRADING && !info.paused ? null : 'the token is no longer trading on its curve';
  };
}

/** A pool step needs the token moved to PancakeSwap, read when it goes to the wallet. */
function migratedNow(c: PublicClient, core: Address, token: Address) {
  return async () => {
    const info = await readFourToken(c, core, token);
    const phase = Number(await c.readContract({ address: info.vault, abi: fourVaultAbi, functionName: 'phase' }));
    return phase === FOUR_MIGRATED ? null : 'the token is not on PancakeSwap';
  };
}

/** The phase in words: on the curve (trading), on PancakeSwap (migrated), paused, or not trading. */
export function fourPhaseWord(phase: number, paused: boolean): string {
  if (paused) return 'Paused';
  if (phase === FOUR_MIGRATED) return 'On PancakeSwap';
  if (phase === TRADING) return 'On the curve';
  return 'Not trading';
}

export function FourToken({ token }: { token: Address }) {
  const { config, client } = useApp();
  const wallet = useWallet();
  const entry = config.openfour?.tokens.find((t) => t.token.toLowerCase() === token.toLowerCase());
  const data = useChainRead((c) => (config.openfour ? readAll(c, config, token, entry, wallet.account) : Promise.resolve(undefined)), [token, wallet.account], {
    keepOnChange: true,
    owner: wallet.account ?? '',
    forOtherOwner: (v) => (v ? { ...v, mine: undefined } : v),
  });
  // The curve trade's status lives here: the buy that ends the sale moves the token to PancakeSwap and replaces the
  // curve box, and its link must stay on screen.
  const curveTx = useTx();
  usePageTitle('four-token', data.state === 'ok' ? data.value?.info.name : undefined);
  // SH-319: what the panels below read, shared with the picture at the top (no read of its own).
  const [figures, share] = useLiveFigures();
  if (!config.openfour) return <p className="empty">No OpenFour launches on this page yet.</p>;
  if (data.state === 'loading' || (data.state === 'ok' && data.value === undefined)) return <p className="muted">Reading the token…</p>;
  if (data.state === 'error' && data.error.name === 'unknown') return <p className="muted">Could not read the token yet. Trying again.</p>;
  if (data.state === 'error') return <p className="muted">No token at {shortAddress(token)}.</p>;
  const d = data.value!;
  const sold = d.info.saleAmount - d.remaining;
  const migrated = d.phase === FOUR_MIGRATED;
  const trading = d.phase === TRADING && !d.info.paused;
  const taxLike = d.kind !== 'preset';
  const gas = taxLike ? TAX_TOKEN_GAS : undefined;
  const rates = taxLike ? d.taxRates : d.fees;
  const picture = fourLivePicture({
    ticker: d.info.symbol,
    quote: { symbol: d.quoteSymbol, decimals: d.quoteDecimals },
    kind: d.kind,
    buyBps: rates?.buy ?? 0,
    sellBps: rates?.sell ?? 0,
    // the same numbers as the stats below
    raised: d.raised,
    target: d.info.raiseAmount,
    soldBps: shareBps(sold, d.info.saleAmount),
    fixed: d.rules?.fixed.map((r) => ({ kind: r.kind, bps: r.bps, name: ruleName(r.kind, r.target, d.info.creator as Address) })),
    figures,
  });
  const trade = ['curve-trade', 'pool-trade', 'four-raised'];
  const targets: PartTargets = {
    token: trade,
    buyers: trade,
    sellers: trade,
    pool: ['pool-trade', 'curve-trade', 'four-raised'],
    raise: ['four-raised'],
    price: ['four-raised'],
    deadline: ['four-sold'],
    creator: ['rules-panel', 'no-rules', 'settle-box', 'pile-panel'],
    tax: ['rules-panel', 'no-rules', 'settle-box', 'pile-panel', 'no-pile'],
    pile: ['pile-panel', 'no-pile', 'no-rules'],
    holders: ['holders-panel', 'rules-panel'],
    shop: ['shop-links', 'rules-panel'],
  };
  return (
    <FiguresShare value={share}>
    <div className="screen" data-testid="four-token" data-kind={d.kind} data-trusted={d.ours ? 'yes' : 'no'}>
      <section className="sh-panel panel">
        <header className="panel-head">
          <h1 className="screen-title">
            <FourPicture token={token} size={40} className="launch-picture launch-picture--head" />
            {d.info.name} <span className="muted">· {d.info.symbol}</span>
          </h1>
          <span className="head-end">
            <Age at={data.at} stale={data.stale} />
            <span className={`pill ${migrated ? 'phase-1' : 'phase-0'}`} data-testid="four-phase">
              {fourPhaseWord(d.phase, d.info.paused)}
            </span>
            <Help label="Rules">
              {d.kind === 'tax-rules'
                ? `A tax token: ${formatBps(BigInt(d.taxRates?.buy ?? 0))} on buys and ${formatBps(BigInt(d.taxRates?.sell ?? 0))} on sells; the tax it collects goes to the rules below once it is paid out, and is shared at a share-out.`
                : d.kind === 'tax'
                ? `A tax token: ${formatBps(BigInt(d.taxRates?.buy ?? 0))} on buys and ${formatBps(BigInt(d.taxRates?.sell ?? 0))} on sells on PancakeSwap; the tax it collects goes to the pile through OpenFour's tax vault once it is paid out.`
                : `Each curve trade pays ${formatBps(BigInt(d.fees?.buy ?? 0))} on buys and ${formatBps(BigInt(d.fees?.sell ?? 0))} on sells into the pile.`}{' '}
              {d.kind === 'tax-rules' ? FINAL_SAYS.four : 'The pile\u2019s rule cannot be changed.'} Token <AddressLink address={token} />, quote coin <AddressLink address={d.info.quoteAsset} />.
            </Help>
          </span>
        </header>
        <div className="sh-live-top">
        <LivePicture picture={picture} name={`${d.info.name} on Four.meme`} targets={targets} />
        <div className="sh-live-top__rest">
        <svg className="progress" viewBox="0 0 1000 14" preserveAspectRatio="none" role="img" aria-label={`Sold ${formatBps(shareBps(sold, d.info.saleAmount))}`}>
          <rect x="0" y="0" width="1000" height="14" rx="7" className="progress-track" />
          <rect x="0" y="0" width={Number(shareBps(sold, d.info.saleAmount)) / 10} height="14" rx="7" className="progress-fill" />
        </svg>
        {migrated ? (
          <div data-testid="curve-status">
            <TxStatus step={curveTx.step} />
          </div>
        ) : null}
        <div className="stats">
          <Stat label="Raised" testId="four-raised">
            <Amount value={d.raised} decimals={d.quoteDecimals} symbol={d.quoteSymbol} />{' '}
            <span className="muted small">
              of <Amount value={d.info.raiseAmount} decimals={d.quoteDecimals} />
            </span>
          </Stat>
          <Stat label="Sold" testId="four-sold">
            {formatBps(shareBps(sold, d.info.saleAmount))}
          </Stat>
          <Stat label="Left on the curve" testId="four-remaining">
            <Amount value={d.remaining} decimals={d.tokenDecimals} symbol={d.info.symbol} />
          </Stat>
        </div>
        </div>
        </div>
        {!d.ours ? (
          <p className="muted small" data-testid="read-only">
            Read only: this page could not verify this token for writes.
          </p>
        ) : null}
      </section>
      <div className="split">
        <div className="side">
          {d.kind === 'tax-rules' && fourRulesState(d.rules?.splitter, d.pile) === 'set-up' ? (
            <section className="sh-panel panel" data-testid="no-rules">
              <p className="empty">{FOUR_SET_UP_SAYS}</p>
              {d.ours && d.clone ? <CreateRulesBox clone={d.clone} /> : null}
            </section>
          ) : d.pile ? (
            <PilePanel pile={d.pile} gas={gas} writable={d.ours ? { token } : undefined} />
          ) : d.kind === 'tax-rules' ? null : (
            <section className="sh-panel panel" data-testid="no-pile">
              <p className="empty">No pile yet.</p>
              {d.ours && d.clone ? <CreatePileBox clone={d.clone} /> : null}
            </section>
          )}
          <ShopLinks token={token} symbol={d.info.symbol} creator={d.info.creator as Address} />
        </div>
        <div className="side">
          {d.kind === 'tax-rules' && d.rules ? (
            <RulesPanel
              rail="four"
              creator={d.info.creator as Address}
              token={token}
              fixed={d.rules.fixed}
              splitter={d.rules.splitter}
              asset={{ symbol: d.quoteSymbol, decimals: d.quoteDecimals }}
              tokenSymbol={d.info.symbol}
              writable={d.ours}
              of="Of the token's tax."
            />
          ) : null}
          {d.ours && migrated ? (
            <PoolTradeBox
              token={token}
              symbol={d.info.symbol}
              tokenDecimals={d.tokenDecimals}
              balance={d.mine?.token}
              buyTaxBps={d.taxRates?.buy ?? 0}
              sellTaxBps={d.taxRates?.sell ?? 0}
              defaultGuard={taxLike ? '5' : undefined}
              router={config.openfour.router ?? FOUR_ROUTER_97}
              needs={migratedNow(client, config.openfour.core, token)}
              quote={{ address: d.info.quoteAsset, symbol: d.quoteSymbol, decimals: d.quoteDecimals, balance: d.mine?.quote }}
              gas={gas}
            />
          ) : null}
          {d.ours && trading ? <CurveTradeBox core={config.openfour.core} token={token} data={d} gas={gas} tx={curveTx} /> : null}
          {d.ours ? (
            <Allowances
              pairs={[
                { token: d.info.quoteAsset, spender: config.openfour.core, symbol: d.quoteSymbol, decimals: d.quoteDecimals, to: "OpenFour's Core" },
                { token, spender: config.openfour.core, symbol: d.info.symbol, decimals: d.tokenDecimals, to: "OpenFour's Core" },
                { token, spender: config.openfour.router ?? FOUR_ROUTER_97, symbol: d.info.symbol, decimals: d.tokenDecimals, to: 'the pool router' },
                { token: d.info.quoteAsset, spender: config.openfour.router ?? FOUR_ROUTER_97, symbol: d.quoteSymbol, decimals: d.quoteDecimals, to: 'the pool router' },
              ]}
            />
          ) : null}
          {d.ours && taxLike && (d.pile || d.rules?.splitter) ? <SettleBox token={token} waiting={d.taxWaiting ?? { quote: 0n, tokens: 0n }} data={d} /> : null}
        </div>
      </div>
      {/* SH-290: holder payouts on this token (the creator's own stake made by our factory; else nothing). */}
      <HoldersPanel token={token} creator={d.info.creator as Address} payees={fourPayees(d.info.vault as Address)} payeesKey={String(d.info.vault)} />
    </div>
    </FiguresShare>
  );
}

function CurveTradeBox(props: { core: Address; token: Address; data: FourRead; gas?: bigint; tx: ReturnType<typeof useTx> }) {
  const { core, token, data, gas, tx } = props;
  const { config, client } = useApp();
  const wallet = useWallet();
  const { ready, gate } = useWriteGate();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [text, setText] = useState('');
  const [guardText, setGuardText] = useState('1');
  useEffect(() => tx.reset(), [token, side]); // eslint-disable-line react-hooks/exhaustive-deps
  const guard = parsePercentToBps(guardText);
  const inDecimals = side === 'buy' ? data.quoteDecimals : data.tokenDecimals;
  const outDecimals = side === 'buy' ? data.tokenDecimals : data.quoteDecimals;
  const a = parseAmount(text, inDecimals);
  const tools = config.openfour!.tools;
  const quote = data.info.quoteAsset;
  const wbnb = config.openfour!.wbnb;
  const isWbnb = !!wbnb && quote.toLowerCase() === wbnb.toLowerCase();
  const onCurve = onCurveNow(client, config.openfour!.core, token);
  const held = side === 'buy' ? data.mine?.quote : data.mine?.token;
  // Buying with wrapped BNB: what is missing can be wrapped from the wallet's BNB first.
  const wrapNeeded = side === 'buy' && isWbnb && a.ok && held !== undefined && a.value > held ? a.value - held : 0n;
  const refusal: Refusal | undefined = !a.ok ? a.reason : held !== undefined && a.value > held && wrapNeeded === 0n ? 'over-balance' : !guard.ok ? 'bad-guard' : undefined;
  const me = wallet.account ?? zeroAddress;
  const estimate = (c: PublicClient, amount: bigint) =>
    c.readContract({
      address: tools,
      abi: fourToolsAbi,
      functionName: side === 'buy' ? 'estimateBuyByBudget' : 'estimateSell',
      args: [token, me, amount, 0n, '0x'],
    }) as Promise<FourEstimate>;
  const est = useChainRead(
    async (c) => {
      if (!a.ok || refusal) return undefined;
      const e = await estimate(c, a.value);
      return { e };
    },
    [side, a.ok ? a.value : -1n, refusal, token, wallet.account, tools],
  );
  const q = est.state === 'ok' ? est.value : undefined;
  const out = q ? (side === 'buy' ? q.e.tokenAmount : q.e.userReceives) : undefined;
  const least = out !== undefined && guard.ok ? minOut(out, guard.value) : undefined;
  // Core pays a sell on a WBNB curve in native BNB.
  const outSym = side === 'buy' ? data.info.symbol : isWbnb ? nativeSymbol() : data.quoteSymbol;

  const go = () => {
    if (!a.ok || least === undefined || !guard.ok) return;
    if (wrapNeeded > 0n && wbnb) {
      const budget = a.value;
      const shown = wrapNeeded;
      void tx.run('Wrap', wallet, async (press) => {
        // What is missing for THIS account, read now: never more than the button showed.
        const has = await client.readContract({ address: wbnb, abi: erc20Abi, functionName: 'balanceOf', args: [press.account] });
        if (has >= budget) throw new PageRefusal('nothing-to-wrap', 'You hold enough already.');
        if (budget - has > shown) throw new PageRefusal('balance-changed', 'Your balance changed. Press again.');
        const value = budget - has;
        return sendWrite(client, wallet, { address: wbnb, abi: wbnbAbi, functionName: 'deposit', value }, press, async () => {
          const gone = await onCurve();
          if (gone) return gone;
          const now = await client.readContract({ address: wbnb, abi: erc20Abi, functionName: 'balanceOf', args: [press.account] });
          return budget - now === value ? null : 'your balance changed. Press again';
        });
      });
      return;
    }
    const label = side === 'buy' ? 'Buy' : 'Sell';
    void tx.run(label, wallet, async (press) => {
      const spend = side === 'buy' ? quote : token;
      // Every step needs the token on its curve and the estimate at least the minimum, read when it goes to the wallet.
      const meets = (min: bigint) => async () => {
        const gone = await onCurve();
        if (gone) return gone;
        const e = await estimate(client, a.value);
        return (side === 'buy' ? e.tokenAmount : e.userReceives) >= min ? null : 'the quote moved below your minimum';
      };
      await withApproval(client, wallet, press, {
        token: spend,
        spender: core,
        amount: a.value,
        approveLabel: `Approve ${toDecimalString(a.value, inDecimals)} ${side === 'buy' ? data.quoteSymbol : data.info.symbol} for OpenFour's Core`,
        mainLabel: label,
        need: meets(least),
        gas,
      });
      const e = await estimate(client, a.value);
      const min = minimumAtPress(side === 'buy' ? e.tokenAmount : e.userReceives, guard.value, least);
      const { request } = await client.simulateContract({
        account: press.account,
        address: core,
        abi: fourCoreAbi,
        functionName: side === 'buy' ? 'buyByBudget' : 'sell',
        args: [token, a.value, min, 0n, '0x'],
        gas,
      });
      return sendWrite(client, wallet, request, press, meets(min), gas);
    });
  };

  return (
    <section className="sh-panel panel box-panel" data-testid="curve-trade">
      <h3>Trade on the curve</h3>
      <div className="segmented" role="tablist">
        {(['buy', 'sell'] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={side === s} className={side === s ? 'on' : ''} onClick={() => setSide(s)} disabled={tx.busy} data-testid={`curve-${s}-tab`}>
            {s === 'buy' ? 'Buy' : 'Sell'}
          </button>
        ))}
      </div>
      <div className="field-row">
        <label className="field">
          <span className="field-label">
            {side === 'buy' ? `${data.quoteSymbol} to spend` : `${data.info.symbol} to sell`}
            {held !== undefined ? (
              <span className="muted">
                you hold <Amount value={held} decimals={inDecimals} />
              </span>
            ) : null}
          </span>
          <input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="0" disabled={tx.busy} data-testid="curve-amount" />
        </label>
        <label className="field field-narrow">
          <span className="field-label">Guard %</span>
          <input inputMode="decimal" value={guardText} onChange={(e) => setGuardText(e.target.value)} disabled={tx.busy} data-testid="curve-guard" />
        </label>
      </div>
      {text !== '' && refusal ? <p className="refusal">{REFUSALS[refusal]}</p> : null}
      {q && out !== undefined && least !== undefined ? (
        <p className="review" data-testid="curve-review">
          Quote <Amount value={out} decimals={outDecimals} symbol={outSym} /> · at least <Amount value={least} decimals={outDecimals} /> · fee{' '}
          <Amount value={q.e.totalFee} decimals={data.quoteDecimals} symbol={data.quoteSymbol} />
        </p>
      ) : null}
      <div className="actions">
        {gate ??
          (ready ? (
            <button type="button" className="btn btn-primary" disabled={!!refusal || !least || tx.busy} onClick={go} data-testid="curve-trade-btn">
              {wrapNeeded > 0n ? (
                <>
                  Wrap <Amount value={wrapNeeded} decimals={18} symbol={nativeSymbol()} />
                </>
              ) : side === 'buy' ? (
                'Buy'
              ) : (
                'Sell'
              )}
            </button>
          ) : null)}
      </div>
      <TxStatus step={tx.step} />
    </section>
  );
}

/** A tax token holds its tax as its own tokens until a transfer pays it out to the pile; anyone may try. */
function SettleBox({ token, waiting, data }: { token: Address; waiting: { quote: bigint; tokens: bigint }; data: FourRead }) {
  const { client } = useApp();
  const wallet = useWallet();
  const { ready, gate } = useWriteGate();
  const tx = useTx();
  return (
    <section className="sh-panel panel box-panel" data-testid="settle-box">
      <div className="panel-head">
        <h3>Tax not paid out yet</h3>
        <Help label="About this tax">The token&apos;s own counters of tax it has not paid out. A zero transfer lets it pay out what is due. It may pay out nothing.</Help>
      </div>
      <p className="stat-value" data-testid="tax-held">
        <Amount value={waiting.quote} decimals={data.quoteDecimals} symbol={data.quoteSymbol} />
        {' · '}
        <Amount value={waiting.tokens} decimals={data.tokenDecimals} symbol={data.info.symbol} />
      </p>
      <div className="actions">
        {gate ??
          (ready ? (
            <button
              type="button"
              className="btn"
              disabled={tx.busy}
              data-testid="settle"
              onClick={() =>
                void tx.run('Settle', wallet, (press) =>
                  // A zero transfer to oneself depends on no state: it may pay out nothing, as its (?) says.
                  sendWrite(client, wallet, { address: token, abi: transferAbi, functionName: 'transfer', args: [press.account, 0n] }, press, NO_STATE, TAX_TOKEN_GAS),
                )
              }
            >
              Settle held tax
            </button>
          ) : null)}
      </div>
      <TxStatus step={tx.step} />
    </section>
  );
}

/** A tax-rules token whose clone has no splitter yet: anyone may make the pile and the splitter, once (createRules). */
export function CreateRulesBox({ clone }: { clone: Address }) {
  const { client } = useApp();
  const wallet = useWallet();
  const { ready, gate } = useWriteGate();
  const tx = useTx();
  return (
    <div className="actions" data-testid="create-rules-box">
      {gate ??
        (ready ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={tx.busy}
            data-testid="create-rules"
            onClick={() =>
              void tx.run(
                'Set up the rules',
                wallet,
                async (press) => {
                  const { request } = await client.simulateContract({ account: press.account, address: clone, abi: rulesTaxVaultAbi, functionName: 'createRules' });
                  return sendWrite(client, wallet, request, press, async () =>
                    (await client.readContract({ address: clone, abi: rulesTaxVaultAbi, functionName: 'splitter' })) === zeroAddress ? null : 'the rules are set up already',
                  );
                },
                (receipt) =>
                  parseEventLogs({ abi: rulesTaxVaultAbi, logs: receipt.logs, eventName: 'RulesCreated' }).some((l) => l.address.toLowerCase() === clone.toLowerCase())
                    ? { ok: true }
                    : { ok: false, error: { name: 'existed', sentence: 'The rules were set up already: this transaction made nothing.' } },
              )
            }
          >
            Set up the rules
          </button>
        ) : null)}
      <TxStatus step={tx.step} />
    </div>
  );
}

/** A tax token whose vault has no pile yet: anyone may create it, once. */
export function CreatePileBox({ clone }: { clone: Address }) {
  const { client } = useApp();
  const wallet = useWallet();
  const { ready, gate } = useWriteGate();
  const tx = useTx();
  return (
    <div className="actions" data-testid="create-pile-box">
      {gate ??
        (ready ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={tx.busy}
            data-testid="create-pile"
            onClick={() =>
              void tx.run(
                'Create the pile',
                wallet,
                async (press) => {
                  const { request } = await client.simulateContract({ account: press.account, address: clone, abi: pileTaxVaultAbi, functionName: 'createPile' });
                  // Only while the vault has no pile: one created meanwhile is said, and nothing is sent.
                  return sendWrite(client, wallet, request, press, async () =>
                    (await client.readContract({ address: clone, abi: pileTaxVaultAbi, functionName: 'pile' })) === zeroAddress ? null : 'the pile exists already',
                  );
                },
                // Confirmed only with this transaction's own creation event; without it, nothing was created.
                (receipt) =>
                  parseEventLogs({ abi: pileTaxVaultAbi, logs: receipt.logs, eventName: 'PileCreated' }).some((l) => l.address.toLowerCase() === clone.toLowerCase())
                    ? { ok: true }
                    : { ok: false, error: { name: 'existed', sentence: 'The pile existed already: this transaction created nothing.' } },
              )
            }
          >
            Create the pile
          </button>
        ) : null)}
      <TxStatus step={tx.step} />
    </div>
  );
}

export { FOUR_PHASE };
