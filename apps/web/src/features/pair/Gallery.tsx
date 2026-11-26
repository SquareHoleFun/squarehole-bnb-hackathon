import { ART, SquareHoleGlyph } from '@squarehole/design';
import type { NftGalleryItem, PairNftDetail } from '@squarehole/domain';
import { useState } from 'react';
import { useDataSource } from '../data-source';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

/**
 * One NFT. Metadata is untrusted text: the name becomes the image's alt text and a caption, attributes are rendered as
 * text, and artwork only ever comes from reviewed local assets (`artId`), never from a URL, HTML or SVG in metadata.
 */
function GalleryItem({ item }: { item: NftGalleryItem }) {
  const art = item.artId === null ? null : (ART.get(item.artId) ?? null);
  const [failed, setFailed] = useState(false);
  const available = art !== null && !failed;
  return (
    <li className="sh-gallery__item">
      <figure className="sh-gallery__figure">
        {available ? (
          <img
            className="sh-gallery__img"
            src={art.src}
            width={art.width}
            height={art.height}
            alt={item.name}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setFailed(true)}
          />
        ) : (
          <span className="sh-gallery__img sh-gallery__img--unavailable" role="img" aria-label={`${item.name}: artwork unavailable`}>
            <SquareHoleGlyph className="sh-gallery__glyph" />
          </span>
        )}
        <figcaption className="sh-gallery__caption">
          <span className="sh-gallery__name">{item.name}</span>
          <span className="sh-gallery__id sh-numeric">Token #{item.tokenId}</span>
          {available ? null : <span className="sh-gallery__na">Artwork unavailable</span>}
        </figcaption>
      </figure>
      {item.attributes.length > 0 ? (
        <dl className="sh-gallery__attrs" aria-label={`${item.name} attributes`}>
          {item.attributes.map((attribute, index) => (
            <div key={`${attribute.trait}-${index}`}>
              <dt>{attribute.trait}</dt>
              <dd>{attribute.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="sh-gallery__na">No attributes</p>
      )}
    </li>
  );
}

/** Collection gallery (SH-012): a labelled demo sample, never presented as the collection's size. */
export function Gallery({ nft, collection }: { nft: PairNftDetail; collection: string }) {
  const demo = useDataSource().isDemo && DEMO_BUILD;
  return (
    <section className="sh-detail-card sh-gallery" aria-labelledby="gallery-title">
      <div className="sh-detail-card__head">
        <h2 id="gallery-title" className="sh-detail-card__title">
          Collection gallery
        </h2>
        <p className="sh-muted">
          {nft.gallery.length === 0
            ? demo
              ? 'No sample NFTs in this snapshot.'
              : 'No gallery: creator-hosted artwork is not loaded from a chain data source (untrusted metadata).'
            : `A sample of ${nft.gallery.length} NFTs, not a count of the collection.`}
        </p>
      </div>
      {nft.gallery.length > 0 ? (
        <ul className="sh-gallery__grid" aria-label={`${collection} sample NFTs`}>
          {nft.gallery.map((item) => (
            <GalleryItem key={item.tokenId} item={item} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
