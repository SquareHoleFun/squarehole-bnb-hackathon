export interface AssetMonogramProps {
  /** Asset symbol as displayed text (untrusted; rendered as text only). */
  symbol: string;
  /** Hide from assistive tech when the symbol is already written next to the chip. */
  decorative?: boolean;
  className?: string;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

function graphemes(value: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value), (s) => s.segment);
  }
  return Array.from(value);
}

/** Up to two letters/digits from the symbol before any "-SUFFIX" (e.g. "AAPLx-DEMO" → "AA"); "?" when none. */
export function monogramFor(symbol: string): string {
  const base = symbol.split('-')[0] ?? '';
  const picked = graphemes(base).filter((g) => LETTER_OR_DIGIT.test(g)).slice(0, 2).join('');
  return picked ? picked.toUpperCase() : '?';
}

/**
 * Neutral monogram chip for quote assets. Quote assets never use issuer logos: identity is chain + address evidence,
 * not a picture (REFERENCE_OVERRIDES "Apple-style logo or verification tick").
 */
export function AssetMonogram({ symbol, decorative = false, className }: AssetMonogramProps) {
  const classes = ['sh-monogram', className].filter(Boolean).join(' ');
  if (decorative) {
    return (
      <span className={classes} aria-hidden="true">
        {monogramFor(symbol)}
      </span>
    );
  }
  return (
    <span className={classes} role="img" aria-label={symbol || 'Unknown asset'}>
      {monogramFor(symbol)}
    </span>
  );
}
