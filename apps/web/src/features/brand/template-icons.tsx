/**
 * One small icon per template of the v2 creation flow (F128; generic recipes since the founder, 2026-10-11: "generalised
 * templates", named by what the box does) and one for a blank start, in the site's glyph language (boxes/BoxParts.tsx):
 * a 24-unit grid, a 1.9-unit stroke in the current colour, round caps and joins, corners of 1.2 to 2 units, no fills,
 * so each reads at 24 to 32 px and follows the colour it sits in. Original drawings; any page may use them.
 *
 * Accessible by default: each icon is an image named after its template. Beside visible words that already say the
 * name, pass `decorative` and it is hidden from screen readers.
 */
import type { ReactNode } from 'react';

export type TemplateIconId = 'liquidity' | 'burn' | 'creator' | 'holders' | 'collection' | 'collection-burn' | 'pile' | 'alchemist-pile' | 'shop' | 'blank';

/** Each icon's name and drawing, keyed by the template's id (create/v2/templates.ts). */
export const TEMPLATE_ICONS: Readonly<Record<TemplateIconId, { readonly name: string; readonly art: ReactNode }>> = Object.freeze({
  // The coin with its square hole, floating on the pool its fees deepen.
  liquidity: { name: 'Liquidity token', art: (
    <>
      <circle cx="12" cy="8.5" r="5" />
      <rect x="10.5" y="7" width="3" height="3" rx="0.6" />
      <path d="M3 16.5c1.5 0 1.5-1.2 3-1.2s1.5 1.2 3 1.2 1.5-1.2 3-1.2 1.5 1.2 3 1.2 1.5-1.2 3-1.2 1.5 1.2 3 1.2" />
      <path d="M3 20.5c1.5 0 1.5-1.2 3-1.2s1.5 1.2 3 1.2 1.5-1.2 3-1.2 1.5 1.2 3 1.2 1.5-1.2 3-1.2 1.5 1.2 3 1.2" />
    </>
  ) },
  // A flame: the token bought back and burned.
  burn: { name: 'Burn', art: (
    <>
      <path d="M12 2.8c.6 3.1 5.2 5 5.2 10.2a5.2 5.2 0 0 1-10.4 0c0-2.6 1.3-4.4 2.6-5.6.2 2.1 1.1 3.3 2.3 3.8-.7-2.8-.6-5.6.3-8.4z" />
      <path d="M12 21v-3.2" />
    </>
  ) },
  // The creator, and the coin the fees keep for them.
  creator: { name: 'To the creator', art: (
    <>
      <circle cx="9" cy="7.5" r="3.2" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <circle cx="18" cy="15.5" r="3" />
      <rect x="17" y="14.5" width="2" height="2" rx="0.5" />
    </>
  ) },
  // Two holders of the token, side by side.
  holders: { name: 'To holders', art: (
    <>
      <circle cx="8.5" cy="8" r="2.8" />
      <circle cx="16" cy="8.8" r="2.4" />
      <path d="M3 19.5a5.5 5.5 0 0 1 11 0" />
      <path d="M13.8 15.2A4.6 4.6 0 0 1 21 19.5" />
    </>
  ) },
  // Four items of a collection.
  collection: { name: 'Collection', art: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ) },
  // Three items, and a flame where the fourth would be: items in the vault burn the token.
  'collection-burn': { name: 'Collection that burns', art: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <path d="M16.5 12.6c.4 1.6 3 2.6 3 5.3a3 3 0 0 1-6 0c0-1.3.7-2.3 1.4-2.9.1 1.1.6 1.7 1.2 2-.4-1.4-.3-2.9.4-4.4z" />
    </>
  ) },
  // A pile of coins and one more beside it.
  pile: { name: 'Coin pile', art: (
    <>
      <ellipse cx="9.5" cy="9.5" rx="5.5" ry="2" />
      <path d="M4 9.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9" />
      <path d="M4 12.5c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2M4 15.5c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" />
      <circle cx="18.5" cy="17.5" r="3" />
    </>
  ) },
  // The pile of coins with an arrow up beside it: buyers' fees turned into the pile's coin and added to it (The Alchemist).
  'alchemist-pile': { name: 'Alchemist coin pile', art: (
    <>
      <ellipse cx="9.5" cy="9.5" rx="5.5" ry="2" />
      <path d="M4 9.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9" />
      <path d="M4 12.5c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2M4 15.5c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" />
      <path d="M18.5 20.5v-9M15.8 14.2l2.7-2.7 2.7 2.7" />
    </>
  ) },
  // A shop front under its awning, an item in its window: items given in and picked out (SH-V21-FE13).
  shop: { name: 'Shop', art: (
    <>
      <path d="M5 4h14l1.5 5.5h-17z" />
      <path d="M3.5 9.5a2.13 2.13 0 0 0 4.25 0a2.13 2.13 0 0 0 4.25 0a2.13 2.13 0 0 0 4.25 0a2.13 2.13 0 0 0 4.25 0" />
      <path d="M5 11.6V20h14v-8.4" />
      <rect x="7" y="13.5" width="4" height="3.5" rx="0.8" />
      <path d="M14 20v-6h3v6" />
    </>
  ) },
  // An empty square to fill in yourself.
  blank: { name: 'Blank', art: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="2.5 2.6" />
      <path d="M12 9v6M9 12h6" />
    </>
  ) },
});

export const isTemplateIconId = (id: string): id is TemplateIconId => Object.hasOwn(TEMPLATE_ICONS, id);

export interface TemplateIconProps {
  readonly id: TemplateIconId;
  /** CSS pixels; drawn for 24 to 32. */
  readonly size?: number;
  /** The accessible name, the template's name by default. */
  readonly label?: string;
  /** Beside words that already name it: hidden from screen readers. */
  readonly decorative?: boolean;
  readonly className?: string;
}

export function TemplateIcon({ id, size = 24, label, decorative = false, className }: TemplateIconProps) {
  const icon = TEMPLATE_ICONS[id];
  const named = decorative ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': label ?? icon.name };
  return (
    <svg
      className={['sh-template-icon', className].filter(Boolean).join(' ')}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      data-icon={id}
      {...named}
    >
      {icon.art}
    </svg>
  );
}
