/**
 * The station drawings the launch picture needs, copied unchanged for SH-281 from the platform's template icons
 * (apps/web/src/features/brand/template-icons.tsx at main b8fbcef9: burn, pile, holders, creator, liquidity): a 24-unit
 * grid, a 1.9-unit stroke in the current colour, round caps and joins, no fills.
 */
import type { ReactNode } from 'react';

export type IconId = 'burn' | 'pile' | 'holders' | 'creator' | 'liquidity';

export const ICONS: Readonly<Record<IconId, ReactNode>> = Object.freeze({
  burn: (
    <>
      <path d="M12 2.8c.6 3.1 5.2 5 5.2 10.2a5.2 5.2 0 0 1-10.4 0c0-2.6 1.3-4.4 2.6-5.6.2 2.1 1.1 3.3 2.3 3.8-.7-2.8-.6-5.6.3-8.4z" />
      <path d="M12 21v-3.2" />
    </>
  ),
  pile: (
    <>
      <ellipse cx="9.5" cy="9.5" rx="5.5" ry="2" />
      <path d="M4 9.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9" />
      <path d="M4 12.5c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2M4 15.5c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" />
      <circle cx="18.5" cy="17.5" r="3" />
    </>
  ),
  holders: (
    <>
      <circle cx="8.5" cy="8" r="2.8" />
      <circle cx="16" cy="8.8" r="2.4" />
      <path d="M3 19.5a5.5 5.5 0 0 1 11 0" />
      <path d="M13.8 15.2A4.6 4.6 0 0 1 21 19.5" />
    </>
  ),
  creator: (
    <>
      <circle cx="9" cy="7.5" r="3.2" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <circle cx="18" cy="15.5" r="3" />
      <rect x="17" y="14.5" width="2" height="2" rx="0.5" />
    </>
  ),
  liquidity: (
    <>
      <circle cx="12" cy="8.5" r="5" />
      <rect x="10.5" y="7" width="3" height="3" rx="0.6" />
      <path d="M3 16.5c1.5 0 1.5-1.2 3-1.2s1.5 1.2 3 1.2 1.5-1.2 3-1.2 1.5 1.2 3 1.2 1.5-1.2 3-1.2 1.5 1.2 3 1.2" />
      <path d="M3 20.5c1.5 0 1.5-1.2 3-1.2s1.5 1.2 3 1.2 1.5-1.2 3-1.2 1.5 1.2 3 1.2 1.5-1.2 3-1.2 1.5 1.2 3 1.2" />
    </>
  ),
});
