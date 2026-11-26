/**
 * SH-BOX-PICTURE-FIT: the Launch flow's picture steps show where each picture goes, as the site will draw it: the
 * square logo as the icon (the box page's header, the token's coin), the collection cover whole on the feed card (a
 * box without one shows its logo there). Both slots follow the site's own choice (picture-slot.ts) and frame
 * (PictureFrame). Nothing shows before a picture is picked.
 *
 * Fix round af2 (review M2): the icon also shows the token's round mark (CoinPicture) beside the square frame, with the
 * real upload, so a creator sees what the circle cuts before creating. A visual only: no words added.
 */
import { CoinPicture, PictureFrame } from '../boxes/BoxParts';
import { chooseSlotPicture, NO_SOURCE, slotSource, type PictureSlot, type SlotSource } from '../boxes/picture-slot';

const NOTHING = { url: null, missing: false, withheld: false } as const;
const local = (url: string | null): SlotSource => (url ? slotSource(null, NOTHING, false, url) : NO_SOURCE);

/** The round mark beside the icon: the header peek's size (HeaderSide.tsx, My Box's token tiles too). */
const COIN_SIZE = 40;

const SLOTS: readonly { readonly slot: PictureSlot; readonly label: string }[] = [
  { slot: 'square', label: 'Icon' },
  { slot: 'card', label: 'Card' },
];

export function PictureSlots({ logo, cover }: { logo: string | null; cover: string | null }) {
  if (!logo && !cover) return null;
  const sources = { logo: local(logo), cover: local(cover) };
  return (
    <div className="sh-newbox-slots" role="group" aria-label="Where your pictures show">
      {SLOTS.map(({ slot, label }) => {
        const [first, second] = slot === 'square' ? [sources.logo, sources.cover] : [sources.cover, sources.logo];
        const choice = chooseSlotPicture(slot, first, second);
        if (choice.kind !== 'picture') return null;
        return (
          <figure key={slot} className="sh-newbox-slot" data-slot={slot}>
            {slot === 'square' ? (
              <span className="sh-newbox-slot__pair">
                <PictureFrame url={choice.url} slot={slot} which={choice.which} className="sh-newbox-slot__frame" />
                <CoinPicture url={choice.url} which={choice.which} size={COIN_SIZE} />
              </span>
            ) : (
              <PictureFrame url={choice.url} slot={slot} which={choice.which} className="sh-newbox-slot__frame" />
            )}
            <figcaption>{`${label} · ${choice.which === 'logo' ? 'logo' : 'cover'}`}</figcaption>
          </figure>
        );
      })}
    </div>
  );
}
