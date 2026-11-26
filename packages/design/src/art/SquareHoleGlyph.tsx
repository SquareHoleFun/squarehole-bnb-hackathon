/** Neutral square-hole mark: a rounded tile with a square opening. Decorative; callers supply the text. */
export function SquareHoleGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
      <rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="none" stroke="currentColor" strokeWidth="1.75" />
      <rect x="8" y="8" width="8" height="8" rx="1.5" fill="currentColor" opacity="0.55" />
    </svg>
  );
}
