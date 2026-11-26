/**
 * The pictures of About & risks (SH-V2-FE7): small line icons for the cards, the launch-window tax as 32 bars, the fee
 * splits as fifteenths and the failure timeline. Every figure comes from about-facts.ts; every picture has its words
 * beside it (a legend, labels or an accessible name), so colour is never the only signal.
 */
import type { ReactNode } from 'react';
import { ABOUT_FACTS, type FeePart } from './about-facts';

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** A box with its square hole. */
export const BoxGlyph = () => (
  <Glyph>
    <path d="M3.5 8 12 4l8.5 4v8L12 20l-8.5-4Z" />
    <path d="M3.5 8 12 12l8.5-4M12 12v8" />
    <rect x="13.6" y="7.1" width="2.6" height="2.6" transform="rotate(-27 14.9 8.4)" />
  </Glyph>
);

/** A rising curve with its end marked. */
export const CurveGlyph = () => (
  <Glyph>
    <path d="M4 19h16" />
    <path d="M5 17c4-.5 8-3.5 11-10" />
    <circle cx="17" cy="6" r="1.6" />
  </Glyph>
);

/** A list of addresses: three lines, each led by a small square (Square Hole's own boxes, F133). */
export const ListGlyph = () => (
  <Glyph>
    <rect x="3.5" y="5" width="3" height="3" />
    <rect x="3.5" y="10.5" width="3" height="3" />
    <rect x="3.5" y="16" width="3" height="3" />
    <path d="M9.5 6.5h11M9.5 12h11M9.5 17.5h7" />
  </Glyph>
);

/** A coin with a square hole (the FIT coin's shape). */
export const CoinGlyph = () => (
  <Glyph>
    <circle cx="12" cy="12" r="8" />
    <rect x="10" y="10" width="4" height="4" />
  </Glyph>
);

/** A clock: deadlines and the claim. */
export const ClockGlyph = () => (
  <Glyph>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 7.5V12l3 2" />
  </Glyph>
);

/** A chart line: listed coins, stocks and gold. */
export const ChartGlyph = () => (
  <Glyph>
    <path d="M4 4v16h16" />
    <path d="m7 15 4-4 3 3 5-6" />
  </Glyph>
);

/** A gem: box 0 and the Misfits. */
export const GemGlyph = () => (
  <Glyph>
    <path d="M7 4h10l4 5-9 11L3 9Z" />
    <path d="M3 9h18M9.5 4 12 9l2.5-5M12 9v11" />
  </Glyph>
);

/** A warning sign: the other risks. */
export const WarningGlyph = () => (
  <Glyph>
    <path d="M12 4 21 19H3Z" />
    <path d="M12 10v4M12 16.8v.2" />
  </Glyph>
);

/** An arrow out of a frame: trading happens elsewhere. */
export const LinkOutGlyph = () => (
  <Glyph>
    <path d="M14 4h6v6M20 4l-8 8" />
    <path d="M18 14v5H5V6h5" />
  </Glyph>
);

/** A page with lines: the Terms. */
export const TermsGlyph = () => (
  <Glyph>
    <path d="M6 3h9l3 3v15H6Z" />
    <path d="M9 9h6M9 13h6M9 17h4" />
  </Glyph>
);

/** A dashed square: the Demo. */
export const DemoGlyph = () => (
  <Glyph>
    <rect x="4" y="4" width="16" height="16" strokeDasharray="3 3" />
  </Glyph>
);

/**
 * The launch-window tax, one bar per 12-second step, height as a share of the first (the release's table,
 * LAUNCH_TAX_TABLE_PIPS). Integer math only: each bar is a whole tenth of a percent of the chart.
 */
export function TaxBars() {
  const table = ABOUT_FACTS.taxTable;
  const top = BigInt(table[0] ?? 1);
  const label = `Launch-window tax per ${ABOUT_FACTS.stepSeconds} step: ${ABOUT_FACTS.taxFirst} at the start, falling over ${ABOUT_FACTS.windowSteps} steps to ${ABOUT_FACTS.taxLast}, then nothing.`;
  return (
    <figure className="sh-about-tax">
      <div className="sh-about-tax__bars" role="img" aria-label={label}>
        {table.map((pips, step) => {
          const permille = (BigInt(pips) * 1000n) / top;
          return <span key={step} className="sh-about-tax__bar" style={{ height: `${permille / 10n}.${permille % 10n}%` }} />;
        })}
      </div>
      <figcaption className="sh-about-tax__axis" aria-hidden="true">
        <span>{ABOUT_FACTS.taxFirst}</span>
        <span>{`${ABOUT_FACTS.window} · ${ABOUT_FACTS.windowSteps} × ${ABOUT_FACTS.stepSeconds}`}</span>
        <span>{ABOUT_FACTS.taxLast}</span>
      </figcaption>
    </figure>
  );
}

/**
 * One fee split: 15 cells, each part spanning its fifteenths, then the same parts in words under the bar (review FE7,
 * WCAG 1.4.1: colour is never the only signal). The bar is decoration; the list under it is what is read.
 */
export function SplitBar({ title, parts }: { title: string; parts: readonly FeePart[] }) {
  return (
    <div className="sh-about-split">
      <p className="sh-about-split__title">{title}</p>
      <div className="sh-about-split__bar" aria-hidden="true">
        {parts.map((part) => (
          <span key={part.key} className="sh-about-split__part" data-part={part.key} style={{ gridColumn: `span ${part.fifteenths}` }}>
            {part.fifteenths >= 2n ? `${part.fifteenths}/15` : ''}
          </span>
        ))}
      </div>
      <ul className="sh-about-legend" aria-label={title}>
        {parts.map((part) => (
          <li key={part.key}>
            <span className="sh-about-split__part sh-about-legend__swatch" data-part={part.key} aria-hidden="true" />
            {`${part.fifteenths}/15 ${part.label}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What happens to a box that misses its deadline, step by step. */
export function FailureSteps() {
  const steps: readonly { readonly figure: string; readonly label: string }[] = [
    { figure: ABOUT_FACTS.deadlineRange, label: 'Deadline' },
    { figure: 'Anyone', label: 'Close box' },
    { figure: ABOUT_FACTS.claims, label: 'Claim' },
    { figure: 'Unclaimed', label: 'Locked for good' },
  ];
  return (
    <ol className="sh-about-steps" aria-label="After a missed deadline">
      {steps.map((step) => (
        <li key={step.label}>
          <span className="sh-about-steps__figure">{step.figure}</span>
          <span className="sh-about-steps__label">{step.label}</span>
        </li>
      ))}
    </ol>
  );
}
