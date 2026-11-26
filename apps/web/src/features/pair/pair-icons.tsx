import type { ReactNode } from 'react';

/** Original 16px stroke icons for pair detail. Always decorative: adjacent text or an aria-label names the control. */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      className="sh-glyph"
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

export const CopyIcon = () => (
  <Glyph>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
    <path d="M10.5 5.5V3.8c0-.7-.6-1.3-1.3-1.3H3.8c-.7 0-1.3.6-1.3 1.3v5.4c0 .7.6 1.3 1.3 1.3h1.7" />
  </Glyph>
);

export const CheckIcon = () => (
  <Glyph>
    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
  </Glyph>
);

/** External-link arrow: shown next to every destination, linked or not (04 "explicit external-link icon"). */
export const ExternalIcon = () => (
  <Glyph>
    <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5" />
    <path d="M12 9.5v3.2c0 .5-.4.8-.8.8H3.3c-.5 0-.8-.3-.8-.8V4.8c0-.5.3-.8.8-.8h3.2" />
  </Glyph>
);

export const BackIcon = () => (
  <Glyph>
    <path d="M13 8H3.5M7 4.5 3.5 8 7 11.5" />
  </Glyph>
);

export const InfoIcon = () => (
  <Glyph>
    <circle cx="8" cy="8" r="5.8" />
    <path d="M8 7.2v3.6M8 5.1h.01" />
  </Glyph>
);

/** A right-pointing chevron (the Details button's); CSS turns it down while its panel is open. */
export const ChevronRightIcon = () => (
  <Glyph>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Glyph>
);

export const FlameIcon = () => (
  <Glyph>
    <path d="M8 14c2.6 0 4.2-1.8 4.2-4.1 0-2.6-2.2-3.8-2.6-6.4-1.4 1-2 2.3-2 3.6-.9-.6-1.3-1.5-1.4-2.4-1.3 1.2-2.4 2.8-2.4 5.1C3.8 12.2 5.4 14 8 14z" />
  </Glyph>
);
