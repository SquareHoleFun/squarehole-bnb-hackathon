import type { ReactNode } from 'react';

/** Original 16px stroke icons for the feed. Always decorative: adjacent text or an aria-label names the control. */
function Glyph({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={['sh-glyph', className].filter(Boolean).join(' ')}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Platform placement mark (a square in a square), deliberately not a crown or rank badge. */
export const PinIcon = () => (
  <Glyph>
    <rect x="2" y="2" width="12" height="12" rx="3.5" />
    <rect x="5.5" y="5.5" width="5" height="5" rx="1" fill="currentColor" stroke="none" />
  </Glyph>
);

/** A line that splits in two: part of each fee goes to holders (F23), deliberately not a gift or prize badge. */
export const FeeShareIcon = () => (
  <Glyph>
    <path d="M2.5 8H6.5" />
    <path d="M6.5 8C8.5 8 9 4.5 11.5 4.5H13.5" />
    <path d="M6.5 8C8.5 8 9 11.5 11.5 11.5H13.5" />
  </Glyph>
);

export const ArrowRightIcon = () => (
  <Glyph>
    <path d="M3 8h9.5M9 4.5 12.5 8 9 11.5" />
  </Glyph>
);

export const ChevronIcon = ({ up }: { up: boolean }) => (
  <Glyph className={up ? undefined : 'sh-glyph--flip'}>
    <path d="M4 10l4-4 4 4" />
  </Glyph>
);

/** Dashed ring: a route that has not been verified (never a check mark). */
export const UnverifiedIcon = () => (
  <Glyph>
    <circle cx="8" cy="8" r="5.5" strokeDasharray="2.2 2.2" />
  </Glyph>
);

/** Solid ring: a route that passed verification (used only once real adapters report one, SH-013). */
export const RouteReadyIcon = () => (
  <Glyph>
    <circle cx="8" cy="8" r="5.5" />
    <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
  </Glyph>
);

export const RefreshIcon = () => (
  <Glyph>
    <path d="M13 8a5 5 0 1 1-1.46-3.54M13 2.5v3h-3" />
  </Glyph>
);

export const WarningIcon = () => (
  <Glyph>
    <path d="M8 2.2 14.3 13H1.7z" />
    <path d="M8 6.5v3M8 11.3h.01" />
  </Glyph>
);

export const SortArrowIcon = ({ direction }: { direction: 'down' | 'up' }) => (
  <Glyph className={direction === 'up' ? 'sh-glyph--flip' : undefined}>
    <path d="M8 3v10M4.5 9.5 8 13l3.5-3.5" />
  </Glyph>
);
