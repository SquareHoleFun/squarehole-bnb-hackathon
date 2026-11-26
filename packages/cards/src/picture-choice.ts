import { chooseSlotPicture, type SlotSource, type SlotChoice } from '@squarehole/artwork/picture-choice';

export type CardSource = SlotSource;

/**
 * Select by the page's square-slot order and withholding rule. Draw that picture if the renderer can;
 * any render failure stops at brand, never another creator picture. Only absence or admission failure
 * permits the next picture; withholding stops the slot as on the page. No format table decides drawability.
 */
export function chooseCardPicture(logo: CardSource, cover: CardSource): SlotChoice {
  return chooseSlotPicture('square', logo, cover);
}
