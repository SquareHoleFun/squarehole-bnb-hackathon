/**
 * SH-WITHHELD-SITE (F157 (3)): the neutral tile in a withheld picture's place (withheld.ts). The slot it stands in gives
 * its size (pass the slot's class); it shows the two words where they fit (withheld.css) and says them to screen
 * readers and in its title everywhere. No reason, no badge, no colour that judges: the same quiet surface as an empty
 * picture. `decorative`: where the picture itself was decoration (the token's small mark), the tile is too.
 */
import type { CSSProperties } from 'react';
import { WITHHELD_TEXT } from './withheld';
import './withheld.css';

export interface WithheldTileProps {
  /** The slot's own class (its size and corners), and any modifier (`sh-withheld--mark`, `sh-withheld--fill`). */
  readonly className?: string;
  /** The accessible name, when the slot names what it shows ("Item #3, picture withheld"). */
  readonly label?: string;
  readonly decorative?: boolean;
  readonly style?: CSSProperties;
}

export function WithheldTile({ className = '', label = WITHHELD_TEXT, decorative = false, style }: WithheldTileProps) {
  const name = decorative ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': label };
  return (
    <span className={`sh-withheld ${className}`.trim()} data-withheld="" title={WITHHELD_TEXT} style={style} {...name}>
      <span className="sh-withheld__words" aria-hidden="true">{WITHHELD_TEXT}</span>
    </span>
  );
}
