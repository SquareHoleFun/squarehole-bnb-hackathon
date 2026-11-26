import type { CSSProperties } from 'react';
import { demoAvatarFor } from './demo-avatars';
import type { ArtAsset } from './registry';
import { SquareHoleGlyph } from './SquareHoleGlyph';

export interface PairAvatarProps {
  /** `${chainId}:${address}`; unknown or malformed ids render the unavailable-artwork state. */
  pairId: string;
  /** Requested CSS pixel size of the square avatar. Clamped to the art's native size (no upscaling). */
  size?: number;
  /** Hide the image from assistive tech when the pair name is already adjacent. */
  decorative?: boolean;
  className?: string;
}

const DEFAULT_SIZE = 40;

/** Largest square the art can fill with object-fit: cover without being enlarged beyond its native pixels. */
export function displaySize(requested: number, art: Pick<ArtAsset, 'width' | 'height'> | null): number {
  const safe = Number.isFinite(requested) && requested > 0 ? Math.round(requested) : DEFAULT_SIZE;
  return art ? Math.min(safe, art.width, art.height) : safe;
}

export function PairAvatar({ pairId, size = DEFAULT_SIZE, decorative = false, className }: PairAvatarProps) {
  const art = demoAvatarFor(pairId);
  const px = displaySize(size, art);
  const style = { '--sh-avatar-size': `${px}px` } as CSSProperties;
  const classes = ['sh-avatar', className].filter(Boolean).join(' ');

  if (!art) {
    return (
      <span className={`${classes} sh-avatar--unavailable`} style={style} role="img" aria-label="Artwork unavailable" data-art-state="unavailable">
        <SquareHoleGlyph className="sh-avatar__glyph" />
      </span>
    );
  }
  return (
    <span className={classes} style={style} data-art-state="available">
      <img
        className="sh-avatar__img"
        src={art.src}
        width={px}
        height={px}
        alt={decorative ? '' : art.alt}
        loading="lazy"
        decoding="async"
        draggable={false}
      />
    </span>
  );
}
