import type { ReactNode } from 'react';
import { Loader } from '../brand';
import { CHART, curveChartModel } from './curve-chart';
import { ethDecimal, formatBlock, formatBps, formatEth, formatTokenShort, shiftDecimal, significant } from './fit-format';
import type { FitMarketTarget } from './fit-target';
import { AlertIcon, headTierText, LiveChip, phaseText } from './FitParts';
import { InfoButton, InfoPanel, useInfoTip } from './InfoTip';
import type { Freshness, LiveView } from './live-controller';
import type { LiveData } from './live-model';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

function Figure({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="sh-fit-figure">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** "0.0047911" ETH per 1,000,000 FIT (or the market's token): the one price unit of the page. */
const perMillion = (priceEthPerToken: string) => significant(shiftDecimal(priceEthPerToken, 6), 5);

/** What each freshness word means (the info panel; the chip shows only the word). */
const FRESHNESS_HELP: Readonly<Record<Freshness, string>> = {
  connecting: 'Connecting: waiting for the first block.',
  live: 'Live: the live service delivered a new block within 36 seconds.',
  polling: 'Polling: the live stream is down, so the page asks the service for a snapshot every few seconds.',
  direct: 'Direct chain read: the page reads the chain itself, about every 12 seconds.',
  stale: 'Stale: no new block arrived; the last good state is shown, dashed.',
  unverified: 'Unverified: the service’s data does not agree with itself or with the chain, so its price is not shown.',
  unavailable: 'Unavailable: neither the live service nor the chain answered.',
};

const DEMO_HELP = 'The stream moves one block every 12 seconds.';

function freshnessHelp(freshness: Freshness, demo: boolean): string {
  return DEMO_BUILD && demo && (freshness === 'live' || freshness === 'polling') ? DEMO_HELP : FRESHNESS_HELP[freshness];
}

/**
 * Where the figures come from, saying only what was checked: the service's figures are always recomputed from the
 * price it reports (internal consistency); only a direct chain read at the same block checks that price itself.
 */
export function sourceText(data: LiveData, target: FitMarketTarget, checkedBlock: bigint | null): string {
  if (data.origin === 'direct') return 'read directly from the chain';
  if (DEMO_BUILD && target.kind === 'demo') return 'from the block stream, with the exact pool math';
  if (checkedBlock !== null) return `from the live service; its price matched a direct chain read at block ${formatBlock(checkedBlock)}`;
  return 'from the live service; its figures agree with the price it reports, which is not yet checked against the chain';
}

/**
 * The hero (BOX-SYSTEM § 4.1, VL-1): the price, then the band, ETH in the curve after sells over the 4.206980085 ETH
 * target, as a percentage and a bar. Fees never count. After graduation the band stays full, stops moving and says
 * "Curve complete" (the header's chip already says when). The drawing gets only the bounded bps integer; the exact
 * figures are in the progressbar's value text. Both blocks start at the top, so their small labels share a line.
 */
function Hero({ data, target, unverified }: { data: LiveData; target: FitMarketTarget; unverified: boolean }) {
  const graduated = data.state.phase === 'migrated';
  const figures = data.confirmed.figures;
  const fill = graduated ? 10_000 : figures.fillBps;
  const label = graduated ? 'Curve complete' : 'Progress to graduation';
  const valueText = graduated
    ? `Graduated at block ${formatBlock(data.state.migratedBlock ?? data.head.number)}`
    : `${formatEth(figures.retainedWei, 9)} of ${formatEth(target.curve.targetWei, 9)} (${formatBps(fill)}) · after sells`;
  return (
    <div className="sh-fit-hero">
      <dl className="sh-fit-hero__price">
        <dt>Price</dt>
        <dd>
          {unverified ? (
            <span className="sh-na">Not shown while unverified</span>
          ) : (
            <>
              <span className="sh-fit-hero__value">{perMillion(figures.priceEthPerToken)}</span> <span className="sh-fit-hero__unit">{`ETH per 1M ${target.names.tokenSymbol}`}</span>
            </>
          )}
        </dd>
      </dl>
      <div className="sh-fit-band" data-full={fill >= 10_000}>
        <p className="sh-fit-band__head">
          <span className="sh-fit-band__label">{label}</span>
          <strong className="sh-fit-band__pct">{formatBps(fill)}</strong>
        </p>
        <div className="sh-fit-band__track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.trunc(fill / 100)} aria-valuetext={valueText}>
          <span className="sh-fit-band__fill" style={{ width: `${fill / 100}%` }} />
        </div>
        {graduated ? null : (
          <p className="sh-fit-band__text">
            {ethDecimal(figures.retainedWei)} of {formatEth(target.curve.targetWei, 18)}
          </p>
        )}
      </div>
    </div>
  );
}

const percentX = (x: number) => `${(x / CHART.width) * 100}%`;
const percentY = (y: number) => `${(y / CHART.height) * 100}%`;

/**
 * The drawing: the line, the bought part and the dashed target in an SVG that stretches to its box (strokes keep their
 * width), so the box can be short and wide on a desktop and taller on a phone. The two markers are round HTML dots
 * placed by percentage, so they stay round at any shape. The legend is spoken in full; the visible one is short.
 */
function Chart({ data, target }: { data: LiveData; target: FitMarketTarget }) {
  const model = curveChartModel(
    target.curve,
    { retainedWei: data.confirmed.figures.retainedWei, tick: data.confirmed.tick },
    { retainedWei: data.state.figures.retainedWei, tick: data.state.tick },
  );
  return (
    <figure className="sh-fit-chart">
      <div className="sh-fit-chart__plot" aria-hidden="true">
        <svg className="sh-fit-chart__svg" viewBox={`0 0 ${CHART.width} ${CHART.height}`} preserveAspectRatio="none" focusable="false">
          <line className="sh-fit-chart__axis" x1={CHART.left} x2={CHART.width - CHART.right} y1={model.baseline} y2={model.baseline} />
          {model.filled ? <path className="sh-fit-chart__bought" d={model.filled} /> : null}
          <path className="sh-fit-chart__line" d={model.line} />
          <line className="sh-fit-chart__target" x1={model.targetX} x2={model.targetX} y1={CHART.top} y2={model.baseline} />
        </svg>
        {model.head ? <span className="sh-fit-chart__mark sh-fit-chart__mark--ring" style={{ left: percentX(model.head.x), top: percentY(model.head.y) }} /> : null}
        <span className="sh-fit-chart__mark sh-fit-chart__mark--dot" style={{ left: percentX(model.confirmed.x), top: percentY(model.confirmed.y) }} />
      </div>
      <figcaption className="sh-fit-chart__caption">
        <span className="sh-visually-hidden">
          The curve: ETH in the curve across, from 0 to the {formatEth(target.curve.targetWei, 18)} target, price up. Solid dot: the confirmed state
          {model.head ? '; dashed ring: the newest block, not final.' : ', the newest block.'}
        </span>
        <span className="sh-fit-chart__legend" aria-hidden="true">
          <span className="sh-fit-chart__key sh-fit-chart__key--dot" /> {model.head ? 'confirmed' : 'now'}
          {model.head ? (
            <>
              <span className="sh-fit-chart__key sh-fit-chart__key--ring" /> not final
            </>
          ) : null}
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * The explanations behind the curve's (i), short: how the curve works, the phase when it adds something, what the
 * chip's word means, and one small "Data" line (block, source, price per token, the drawing's scale). An unverified
 * price is not given here either. Every unit is the market's token symbol (FIT, or a rehearsal's neutral one).
 */
function CurveInfo({ view, target }: { view: LiveView; target: FitMarketTarget }) {
  const data = view.data;
  const help = freshnessHelp(view.freshness, DEMO_BUILD && target.kind === 'demo');
  const symbol = target.names.tokenSymbol;
  const how = `The price follows this curve: the more ETH in it, the higher the price. Once ${formatEth(target.curve.targetWei, 18)} sits in it (after sells; fees don’t count), graduation follows: its ETH and ${symbol} move into one Uniswap pool and the vault opens.`;
  if (!data) {
    return (
      <>
        <p>{how}</p>
        <p>{help}</p>
      </>
    );
  }
  const unverified = view.freshness === 'unverified';
  const phase = phaseText(data, target);
  const shown = data.confirmed;
  const newest = data.state;
  const differs = shown !== newest && shown.sqrtPriceX96 !== newest.sqrtPriceX96;
  const source = sourceText(data, target, view.checkedBlock);
  const price = unverified ? '' : ` 1 ${symbol} = ${significant(shown.figures.priceEthPerToken, 5)} ETH.`;
  const head = differs
    ? ` Newest block ${formatBlock(newest.block)}, ${headTierText(data)}${unverified ? '' : `: 1 ${symbol} = ${significant(newest.figures.priceEthPerToken, 5)} ETH`}.`
    : '';
  return (
    <>
      <p>{how}</p>
      {phase.detail ? <p>{phase.detail}</p> : null}
      <p>{help}</p>
      <p className="sh-info-panel__data">{`Data: block ${formatBlock(shown.block)}, ${source}.${price}${head} Drawing: price on a log scale.`}</p>
    </>
  );
}

/** The live curve (F38 (2)): one freshness chip, price, band, drawing and three figures, all from one block. */
export function CurvePanel({ view, target }: { view: LiveView; target: FitMarketTarget }) {
  const tip = useInfoTip();
  const data = view.data;
  return (
    <section className="sh-detail-card sh-fit-curve" aria-labelledby="fit-curve-title" data-freshness={view.freshness}>
      <div className="sh-detail-card__head">
        <h2 id="fit-curve-title" className="sh-detail-card__title">
          Bonding curve
        </h2>
        <div className="sh-fit-card-tools">
          <LiveChip view={view} />
          <InfoButton tip={tip} label="About the bonding curve" />
        </div>
      </div>
      <InfoPanel tip={tip}>
        <CurveInfo view={view} target={target} />
      </InfoPanel>
      {view.reason && view.freshness !== 'live' && view.freshness !== 'polling' ? (
        <p className="sh-fit-reason" data-freshness={view.freshness} data-catching-up={view.catchingUp || undefined} data-disclosure="">
          {view.catchingUp ? <Loader size="button" decorative /> : <AlertIcon />}
          <span>{view.reason}</span>
        </p>
      ) : null}
      {view.reorg ? (
        <p className="sh-fit-reorg" role="status" data-disclosure="">
          Block {formatBlock(view.reorg.fromBlock)} was replaced; the curve went back to block {formatBlock(view.reorg.toBlock)} and follows the new chain.
        </p>
      ) : null}
      {data ? <CurveBody data={data} target={target} unverified={view.freshness === 'unverified'} /> : <CurveEmpty view={view} />}
    </section>
  );
}

function CurveEmpty({ view }: { view: LiveView }) {
  if (view.freshness === 'connecting') {
    return (
      <div className="sh-fit-empty" aria-busy="true">
        <Loader size="card" decorative className="sh-fit-empty__loader" />
        <p>Connecting to the live curve…</p>
      </div>
    );
  }
  return (
    <div className="sh-fit-empty" role="alert">
      <p className="sh-fit-empty__title">The curve can’t be read right now</p>
      <p>Nothing is shown as empty or zero in its place. The page keeps trying.</p>
    </div>
  );
}

/**
 * The figures follow the band and the solid marker: the confirmed state (VL-3). The newest block, while it differs, is
 * the dashed ring on the drawing; its numbers are in the info panel. The phase line sits in the header.
 */
function CurveBody({ data, target, unverified }: { data: LiveData; target: FitMarketTarget; unverified: boolean }) {
  const symbol = target.names.tokenSymbol;
  const shown = data.confirmed;
  const graduated = data.state.phase === 'migrated';
  return (
    <>
      <Hero data={data} target={target} unverified={unverified} />
      <Chart data={data} target={target} />
      <dl className="sh-fit-figures">
        {graduated ? null : <Figure label="Sold" value={formatTokenShort(shown.figures.soldRaw, symbol)} />}
        <Figure label="Burned" value={shown.burnedRaw === null ? <span className="sh-na">Not available</span> : formatTokenShort(shown.burnedRaw, symbol)} />
        {shown.taxWei !== null ? <Figure label="Total tax" value={formatEth(shown.taxWei)} /> : null}
      </dl>
    </>
  );
}
