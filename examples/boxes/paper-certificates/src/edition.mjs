/**
 * The two editions of the box. Gold Certificates comes first and is priced in a gold coin. Paper Certificates follows
 * when the index coin's pool is deep enough, and is priced in the index coin. The certificates, the mark, the hidden
 * picture and SCRIP are the same in both. Each edition has its own name, cover line, price coin in the pictures and
 * frame color, and its pieces are built into their own folder.
 */
import { C, MIX } from './palette.mjs';

/** The literal line that goes next to the cover line wherever it is posted. It is the same in both editions. */
export const LITERAL_LINE = 'In plain words, after graduation the buyers\' share of every fee buys SCRIP and burns it, and the sellers\' share buys SCRIP for the certificates.';

export const EDITIONS = Object.freeze({
  gold: Object.freeze({
    id: 'gold',
    name: 'Gold Certificates',
    /** The name as lettered on the banners and the cover. */
    lines: ['GOLD', 'CERTIFICATES'],
    /** The cover line as lettered; the brand book quotes it in sentence case. */
    cover: ['GOLD IN,', 'PAPER OUT.'],
    coin: 'gold',
    coinName: 'the gold coin',
    accent: C.gold,
    accentDark: MIX.goldDark,
    accentLight: MIX.goldPale,
    /** Lettering in the edition's color on paper: dark enough to read. */
    text: C.goldInk,
    dir: 'art',
  }),
  paper: Object.freeze({
    id: 'paper',
    name: 'Paper Certificates',
    lines: ['PAPER', 'CERTIFICATES'],
    cover: ['STOCK IN,', 'PAPER OUT.'],
    coin: 'index',
    coinName: 'the index coin',
    accent: C.bond,
    accentDark: MIX.bondDark,
    accentLight: MIX.bondTint,
    text: C.bond,
    dir: 'art/paper',
  }),
});

/** The cover line in sentence case, as the brand book and the posts quote it. */
export const coverSentence = (e) => {
  const joined = e.cover.join(' ');
  return joined[0] + joined.slice(1).toLowerCase();
};
