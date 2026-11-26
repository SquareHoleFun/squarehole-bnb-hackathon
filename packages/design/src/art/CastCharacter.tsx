import type { CSSProperties } from 'react';
import { castArt, castMember, type CastId } from './registry';
import { SquareHoleGlyph } from './SquareHoleGlyph';

export interface CastCharacterProps {
  id: CastId;
  /** Maximum CSS pixel width; the art is never shown above its native size. */
  size?: number;
  /** Show the character's name under the art (default true). */
  caption?: boolean;
  className?: string;
}

/**
 * A platform-cast character (ADR-0004). Storytelling only: characters never imply fees, rewards or rights.
 * Characters without clean source art render an explicit "original art pending" placeholder.
 */
export function CastCharacter({ id, size = 96, caption = true, className }: CastCharacterProps) {
  const member = castMember(id);
  const art = castArt(id);
  const width = art ? Math.min(Math.max(1, Math.round(size)), art.width) : Math.max(1, Math.round(size));
  const height = art ? Math.round((art.height * width) / art.width) : width;
  const style = { '--sh-cast-width': `${width}px` } as CSSProperties;
  const classes = ['sh-cast', className].filter(Boolean).join(' ');

  return (
    <figure className={classes} style={style} data-cast={id}>
      {art ? (
        <img className="sh-cast__img" src={art.src} width={width} height={height} alt={art.alt} loading="lazy" decoding="async" draggable={false} />
      ) : (
        <span className="sh-cast__pending" role="img" aria-label={`${member.name}: original art pending`} data-art-state="pending">
          <SquareHoleGlyph className="sh-cast__glyph" />
          <span className="sh-cast__pending-text" aria-hidden="true">Original art pending</span>
        </span>
      )}
      {caption ? <figcaption className="sh-cast__name">{member.name}</figcaption> : null}
    </figure>
  );
}
