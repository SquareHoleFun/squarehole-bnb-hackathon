/**
 * The box pages' art (SH-BOX-UI-launch): the Misfits box cover, the Demo boxes' covers and sealed items, and the
 * ordinary Misfit examples of the sneak peek (F47: never a one-of-one, Classic, Diamond, Glass or Gold piece).
 * Copied byte for byte from the box mock-up; `art/misfits/manifest.json` records each file's source, size and sha256,
 * and misfits-art.test.ts checks both. `?no-inline` keeps each WebP a separately cached file.
 */
import manifest from '../../art/misfits/manifest.json';
import coverClaimsDeskGlass from '../../art/misfits/cover-claims-desk-glass.webp?no-inline';
import coverCollectionGalleryMirror from '../../art/misfits/cover-collection-gallery-mirror.webp?no-inline';
import coverControlNookToy from '../../art/misfits/cover-control-nook-toy.webp?no-inline';
import coverFeedDeckGilded from '../../art/misfits/cover-feed-deck-gilded.webp?no-inline';
import coverLaunchWorkshopWalnut from '../../art/misfits/cover-launch-workshop-walnut.webp?no-inline';
import coverMisfits256 from '../../art/misfits/cover-misfits-256.webp?no-inline';
import coverMisfits from '../../art/misfits/cover-misfits.webp?no-inline';
import mB02256 from '../../art/misfits/m-B02-256.webp?no-inline';
import mB02 from '../../art/misfits/m-B02.webp?no-inline';
import mB04256 from '../../art/misfits/m-B04-256.webp?no-inline';
import mB04 from '../../art/misfits/m-B04.webp?no-inline';
import mB06256 from '../../art/misfits/m-B06-256.webp?no-inline';
import mB06 from '../../art/misfits/m-B06.webp?no-inline';
import mB09256 from '../../art/misfits/m-B09-256.webp?no-inline';
import mB09 from '../../art/misfits/m-B09.webp?no-inline';
import mB13256 from '../../art/misfits/m-B13-256.webp?no-inline';
import mB13 from '../../art/misfits/m-B13.webp?no-inline';
import mB15256 from '../../art/misfits/m-B15-256.webp?no-inline';
import mB17256 from '../../art/misfits/m-B17-256.webp?no-inline';
import mB17 from '../../art/misfits/m-B17.webp?no-inline';
import mB18256 from '../../art/misfits/m-B18-256.webp?no-inline';
import mB18 from '../../art/misfits/m-B18.webp?no-inline';
import mB19256 from '../../art/misfits/m-B19-256.webp?no-inline';
import mB19 from '../../art/misfits/m-B19.webp?no-inline';
import sealedGilded from '../../art/misfits/sealed-gilded.webp?no-inline';
import sealedGlass from '../../art/misfits/sealed-glass.webp?no-inline';
import sealedMirror from '../../art/misfits/sealed-mirror.webp?no-inline';
import sealedToy from '../../art/misfits/sealed-toy.webp?no-inline';
import sealedWalnut from '../../art/misfits/sealed-walnut.webp?no-inline';

export interface BoxArtAsset {
  /** The file name without `.webp`: "cover-misfits", "m-B09-256", "sealed-walnut". */
  readonly id: string;
  readonly src: string;
  readonly width: number;
  readonly height: number;
}

const FILES: Readonly<Record<string, string>> = {
  'cover-claims-desk-glass.webp': coverClaimsDeskGlass,
  'cover-collection-gallery-mirror.webp': coverCollectionGalleryMirror,
  'cover-control-nook-toy.webp': coverControlNookToy,
  'cover-feed-deck-gilded.webp': coverFeedDeckGilded,
  'cover-launch-workshop-walnut.webp': coverLaunchWorkshopWalnut,
  'cover-misfits-256.webp': coverMisfits256,
  'cover-misfits.webp': coverMisfits,
  'm-B02-256.webp': mB02256,
  'm-B02.webp': mB02,
  'm-B04-256.webp': mB04256,
  'm-B04.webp': mB04,
  'm-B06-256.webp': mB06256,
  'm-B06.webp': mB06,
  'm-B09-256.webp': mB09256,
  'm-B09.webp': mB09,
  'm-B13-256.webp': mB13256,
  'm-B13.webp': mB13,
  'm-B15-256.webp': mB15256,
  'm-B17-256.webp': mB17256,
  'm-B17.webp': mB17,
  'm-B18-256.webp': mB18256,
  'm-B18.webp': mB18,
  'm-B19-256.webp': mB19256,
  'm-B19.webp': mB19,
  'sealed-gilded.webp': sealedGilded,
  'sealed-glass.webp': sealedGlass,
  'sealed-mirror.webp': sealedMirror,
  'sealed-toy.webp': sealedToy,
  'sealed-walnut.webp': sealedWalnut,
};

/** Every bundled box picture by id. A manifest entry without a file is left out, never guessed. */
export const MISFITS_ART: ReadonlyMap<string, BoxArtAsset> = new Map(
  manifest.files.flatMap((file): [string, BoxArtAsset][] => {
    const src = FILES[file.path];
    if (!src) return [];
    const id = file.path.replace(/\.webp$/, '');
    return [[id, Object.freeze({ id, src, width: file.width, height: file.height })]];
  }),
);

/** A box picture by id, or null. */
export function boxArt(id: string): BoxArtAsset | null {
  return MISFITS_ART.get(id) ?? null;
}
