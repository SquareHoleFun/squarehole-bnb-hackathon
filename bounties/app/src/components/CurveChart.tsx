import { formatAmount } from '../lib/amounts';
import { curvePoints, reserveAt } from '../lib/flap';

/** Pixel position of `v` on a 0..max axis of `len` pixels (geometry only: amounts stay bigint until here). */
function px(v: bigint, max: bigint, len: number): number {
  if (max === 0n) return 0;
  return Number((v * 10_000n) / max) * (len / 10_000);
}

/**
 * The sale's curve: BNB on the curve (up) against tokens sold (across), the target marked at the end and, when
 * given, where the sale stands now.
 */
export function CurveChart(props: {
  virtualBnb: bigint;
  virtualTokens: bigint;
  saleTokens: bigint;
  sold?: bigint;
  /** The sale's quote coin: its symbol and decimals label the curve. */
  symbol: string;
  decimals?: number;
}) {
  const { virtualBnb, virtualTokens, saleTokens, sold, symbol } = props;
  const decimals = props.decimals ?? 18;
  const W = 1000;
  const H = 260;
  const PAD = { l: 8, r: 8, t: 50, b: 8 };
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const pts = curvePoints(virtualBnb, virtualTokens, saleTokens);
  const target = pts[pts.length - 1]?.[1] ?? 0n;
  const X = (s: bigint) => PAD.l + px(s, saleTokens, iw);
  const Y = (r: bigint) => PAD.t + ih - px(r, target, ih);
  const line = pts.map(([s, r], i) => `${i ? 'L' : 'M'} ${X(s).toFixed(1)} ${Y(r).toFixed(1)}`).join(' ');
  const now = sold !== undefined && sold <= saleTokens ? sold : undefined;
  const nowR = now !== undefined ? (now === saleTokens ? target : reserveAt(virtualBnb, virtualTokens, now)) : undefined;
  let filled = '';
  if (now !== undefined) {
    const upTo = pts.filter(([s]) => s <= now);
    filled =
      upTo.map(([s, r], i) => `${i ? 'L' : 'M'} ${X(s).toFixed(1)} ${Y(r).toFixed(1)}`).join(' ') +
      ` L ${X(now).toFixed(1)} ${Y(nowR ?? 0n).toFixed(1)} L ${X(now).toFixed(1)} ${PAD.t + ih} L ${PAD.l} ${PAD.t + ih} Z`;
  }
  return (
    <figure className="curve-chart" data-testid="curve-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Curve to ${formatAmount(target, decimals)} ${symbol}`}>
        <line x1={PAD.l} y1={PAD.t + ih} x2={W - PAD.r} y2={PAD.t + ih} className="axis" />
        <line x1={X(saleTokens)} y1={PAD.t} x2={X(saleTokens)} y2={PAD.t + ih} className="target-line" />
        {filled ? <path d={filled} className="curve-fill" /> : null}
        <path d={line} className="curve-line" fill="none" />
        <text x={W - PAD.r} y={2} textAnchor="end" dominantBaseline="hanging" className="chart-label">
          {formatAmount(target, decimals)} {symbol}
        </text>
        {now !== undefined && nowR !== undefined ? (
          <>
            <circle cx={X(now)} cy={Y(nowR)} r={8} className="curve-dot" />
            {now < saleTokens ? (
            <text
              x={Math.min(Math.max(X(now), 90), W - 260)}
              y={Math.max(Y(nowR) - 14, 22)}
              textAnchor="middle"
              className="chart-label chart-now"
            >
              {formatAmount(nowR, decimals)} {symbol}
            </text>
            ) : null}
          </>
        ) : null}
      </svg>
    </figure>
  );
}
