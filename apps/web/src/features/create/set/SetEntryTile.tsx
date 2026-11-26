/**
 * SH-EXISTING-NFTS-E08C: the existing-NFTs add-on's entry, first on format 2 Basics, shown only where the add-on is (a
 * local build that names its manifest, its factory checked on chain; never the production site). It opens the
 * add-on's own flow at /create/set-basics; nothing of the format 2 draft moves there. It lives here, beside the flow,
 * so a production build (where V2Steps never renders it) drops it together with the add-on's stylesheet.
 */
import { Link } from 'react-router';
import { GridGlyph } from '../../boxes/BoxParts';
import type { CoreBuild } from '../../core/core-build';
import { useSetSource } from '../../set/set-build';
import './create-set.css';

export function SetEntryTile({ build }: { readonly build?: CoreBuild } = {}) {
  const set = useSetSource(build);
  if (set.status !== 'ready') return null;
  return (
    <Link to="/create/set-basics" className="sh-set-entry" data-set-entry="">
      <GridGlyph size={24} />
      <span className="sh-set-entry__text">
        <span className="sh-set-entry__name">Existing NFTs</span>
        <small className="sh-set-entry__line">Your NFTs · one collection</small>
      </span>
    </Link>
  );
}
