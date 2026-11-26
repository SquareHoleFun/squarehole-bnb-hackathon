import { VARIANTS } from '../../src/items.mjs';
import { C, MIX } from '../../src/palette.mjs';

export const FACES = {
  Round: { w: 420, h: 460, jaw: 340, chin: 180 },
  Long: { w: 340, h: 540, jaw: 290, chin: 130 },
  Square: { w: 420, h: 500, jaw: 420, chin: 300 },
  Pear: { w: 350, h: 500, jaw: 430, chin: 240 },
  Broad: { w: 470, h: 460, jaw: 440, chin: 260 },
};
export const MOUTHS = { Smile: 'smile', Grin: 'grin', Surprise: 'o', Cheer: 'cheer' };
const PROPS = { Spoon: 0, Fork: 1, Teacup: 2, Bell: 3, Salt: 4, Menu: 6 };
export function specFor({ traits: t }) {
  const rank = VARIANTS.find(v => v.name === t.Rank);
  if (!rank) throw new Error('Unknown rank');
  return {
    face: FACES[t.Face], hat: 'peakedCap', hatOpts: rank.spec.hatOpts,
    eyes: t.Eyes.toLowerCase(), mouth: MOUTHS[t.Mouth],
    extras: t.Grooming === 'Freckles' ? ['freckles'] : t.Grooming === 'Sideburns' ? ['sideburns']
      : t.Grooming.endsWith('moustache') ? ['mustache'] : [],
    braids: t.Grooming === 'Twin braids' ? [-1, 1] : t.Grooming === 'Single braid' ? [-1] : [],
    hairColor: MIX.hair, mustacheColor: t.Grooming === 'White moustache' ? C.white : C.ink,
    wear: t.Collar === 'Napkin' ? 'napkin' : undefined,
    hold: VARIANTS[PROPS[t.Prop]].spec.hold,
  };
}
