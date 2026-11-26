import { formatUsdCompact, type PairRecord, type PriceHistory } from '@squarehole/domain';
import { useId, useState } from 'react';
import { useDataSource } from '../data-source';
import { formatAsOf } from '../feed/format';
import { amountSymbol } from './pair-model';
import { chartGeometry, coveredTimeframes, segmentPath, type ChartGeometry, type TimeframeId } from './price-chart';
import { useElementWidth } from './useElementWidth';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

const DEFAULT_WIDTH = 640;
const MIN_WIDTH = 240;
const HEIGHT = 220;

const UNAVAILABLE_REASON: Readonly<Record<Extract<PriceHistory, { state: 'unavailable' }>['reason'], string>> = {
  demo_no_history: 'This pair has no recorded observations.',
  unpriced: 'This pair has no price observation yet, so there is nothing to draw.',
  not_indexed: 'No observations are indexed for the period this snapshot covers.',
};

function shortDate(iso: string): string {
  const full = formatAsOf(iso);
  return full ? full.replace(/ \d{4},/, ',').replace(' UTC', '') : iso;
}

function ChartSvg({ geometry, titleId, descId, title, desc }: { geometry: ChartGeometry; titleId: string; descId: string; title: string; desc: string }) {
  const { plot } = geometry;
  return (
    <svg
      className="sh-chart__svg"
      width={geometry.width}
      height={geometry.height}
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      role="img"
      aria-labelledby={`${titleId} ${descId}`}
    >
      <title id={titleId}>{title}</title>
      <desc id={descId}>{desc}</desc>
      <defs>
        <pattern id={`${titleId}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" className="sh-chart__hatch" />
        </pattern>
      </defs>
      {geometry.yTicks.map((tick) => (
        <g key={tick.label}>
          <line x1={plot.left} x2={plot.right} y1={tick.y} y2={tick.y} className="sh-chart__grid" />
          <text x={plot.left - 8} y={tick.y + 4} className="sh-chart__label" textAnchor="end">
            {tick.label}
          </text>
        </g>
      ))}
      {geometry.xTicks.map((tick, index) => (
        <text
          key={tick.t}
          x={tick.x}
          y={geometry.height - 8}
          className="sh-chart__label"
          textAnchor={geometry.xTicks.length === 1 ? 'middle' : index === 0 ? 'start' : 'end'}
        >
          {shortDate(tick.t)}
        </text>
      ))}
      {geometry.gaps.map((gap) => (
        <g key={gap.t} className="sh-chart__gap">
          <rect x={gap.x0} y={plot.top} width={Math.max(0, gap.x1 - gap.x0)} height={plot.bottom - plot.top} fill={`url(#${titleId}-hatch)`} />
          <line x1={gap.x} x2={gap.x} y1={plot.top} y2={plot.bottom} className="sh-chart__gap-line" />
          <text x={gap.x} y={plot.top + 12} className="sh-chart__gap-label" textAnchor="middle">
            No observation
          </text>
        </g>
      ))}
      {geometry.segments.map((segment) =>
        segment.length === 1 ? (
          <circle key={segment[0]?.t} cx={segment[0]?.x} cy={segment[0]?.y} r="3" className="sh-chart__dot" />
        ) : (
          <path key={segment[0]?.t} d={segmentPath(segment)} className="sh-chart__line" vectorEffect="non-scaling-stroke" />
        ),
      )}
      {geometry.last ? <circle cx={geometry.last.x} cy={geometry.last.y} r="4" className="sh-chart__last" /> : null}
    </svg>
  );
}

/**
 * Read-only price chart (01-PRODUCT, FEED-10): observed points only, visible gaps, and timeframe buttons only for
 * windows the history fully covers. No chart library: one small inline SVG plus a text table of the observations.
 */
export function PriceChart({ pair, history, asOf }: { pair: PairRecord; history: PriceHistory; asOf: string }) {
  const demo = useDataSource().isDemo && DEMO_BUILD;
  const baseId = useId();
  const unit = amountSymbol(pair.token.symbol);
  const frames = history.state === 'observed' ? coveredTimeframes(history.points, asOf) : [];
  const [selected, setSelected] = useState<TimeframeId>('all');
  const [frameRef, measured] = useElementWidth(DEFAULT_WIDTH);
  const frame = frames.find((candidate) => candidate.id === selected) ?? frames.at(-1);
  const size = { width: Math.max(MIN_WIDTH, measured), height: HEIGHT };
  const geometry = history.state === 'observed' && frame ? chartGeometry(history.points, asOf, frame, size) : null;

  return (
    <section className="sh-detail-card sh-chart" aria-labelledby="chart-title">
      <div className="sh-detail-card__head">
        <h2 id="chart-title" className="sh-detail-card__title">
          Price <span className="sh-muted">USD per {unit}</span>
        </h2>
        {pair.priceUsd !== null ? (
          <p className="sh-chart__price">
            <span className="sh-numeric">{formatUsdCompact(pair.priceUsd)}</span>
            <span className="sh-muted"> at {formatAsOf(pair.provenance.asOf) ?? pair.provenance.asOf}</span>
          </p>
        ) : null}
      </div>
      {geometry && frame ? (
        <>
          <div className="sh-timeframes" role="group" aria-label="Chart timeframe">
            {frames.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className="sh-timeframe"
                aria-pressed={candidate.id === frame.id}
                aria-label={candidate.name}
                onClick={() => setSelected(candidate.id)}
              >
                {candidate.label}
              </button>
            ))}
          </div>
          <div className="sh-chart__frame" ref={frameRef}>
            <ChartSvg
              geometry={geometry}
              titleId={`${baseId}-title`}
              descId={`${baseId}-desc`}
              title={`${pair.name} price in USD per ${unit}, ${frame.name.toLowerCase()}`}
              desc={`${geometry.points.length} observations from ${formatAsOf(geometry.points[0]?.t ?? '') ?? ''} to ${formatAsOf(geometry.points.at(-1)?.t ?? '') ?? ''}; ${geometry.gaps.length === 0 ? 'no gaps' : `${geometry.gaps.length} without an observation, shown as a gap`}.`}
            />
          </div>
          <p className="sh-chart__note">
            Recorded observations only. Timeframes appear only when observed history covers them
            {geometry.gaps.length > 0 ? '; hatched bands are gaps with no observation, never filled in' : ''}.
          </p>
          <details className="sh-chart__table">
            <summary>Observations as a table</summary>
            <table>
              <caption className="sh-visually-hidden">{pair.name} price observations</caption>
              <thead>
                <tr>
                  <th scope="col">Time (UTC)</th>
                  <th scope="col">USD per {unit}</th>
                </tr>
              </thead>
              <tbody>
                {geometry.points.map((point) => (
                  <tr key={point.t}>
                    <td>
                      <time dateTime={point.t}>{formatAsOf(point.t) ?? point.t}</time>
                    </td>
                    <td className="sh-numeric">{point.priceUsd === null ? 'No observation' : formatUsdCompact(point.priceUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      ) : (
        <div className="sh-chart__empty">
          <p className="sh-chart__empty-title">{demo ? 'No observed price history in this snapshot' : 'No USD price history on this test chain'}</p>
          <p className="sh-muted">{history.state === 'unavailable' ? UNAVAILABLE_REASON[history.reason] : 'Nothing observed falls inside this snapshot.'}</p>
        </div>
      )}
    </section>
  );
}
