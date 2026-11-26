/**
 * The hidden picture: what every toad shows until it is drawn, and what every ticket shows. A box with hidden art
 * stores this picture on chain (the placeholders add-on's `hiddenSvg`), where it must be one line of printable ASCII
 * of at most 4,096 bytes. So it is drawn by hand here in whole numbers on a 240-unit grid: a toad wrapped in paper,
 * with a twist on top and a clay seal with a question mark, on the bisque wall. It carries a short title and
 * description; the kit's PNG of it is rendered from exactly this text.
 */
import { C, MIX } from './palette.mjs';

/** The most bytes the on-chain field takes. */
export const HIDDEN_MAX_BYTES = 4096;

const S = C.soot;

/** The hidden picture as one line of SVG text. */
export function hiddenSvg() {
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="1024" height="1024" role="img">`,
    `<title>Frog Kiln: a toad still wrapped</title>`,
    `<desc>A clay toad wrapped in paper with a twist on top and a clay seal with a question mark. It shows which toad it is once it is drawn.</desc>`,
    `<rect width="240" height="240" fill="${C.bisque}"/>`,
    `<path d="M60 210V146A60 66 0 0 1 180 146V210Z" fill="${MIX.wallArch}"/>`,
    `<ellipse cx="120" cy="214" rx="78" ry="8" fill="${MIX.wallDeep}"/>`,
    // The paper skin over the toad's shape, its shade on the lower right.
    `<path d="M120 214C92 214 58 214 50 196C44 178 52 154 64 132C72 114 78 92 92 80C102 72 112 70 120 70C128 70 138 72 148 80C162 92 168 114 176 132C188 154 196 178 190 196C182 214 148 214 120 214Z" fill="${MIX.bisqueDark}"/>`,
    `<path d="M116 208C90 208 60 207 54 192C49 176 57 154 68 134C76 117 81 96 94 85C103 77 111 75 118 75C126 75 135 78 143 86C155 98 160 118 166 136C175 158 178 180 172 194C164 207 140 208 116 208Z" fill="${C.bisque}"/>`,
    `<path d="M120 214C92 214 58 214 50 196C44 178 52 154 64 132C72 114 78 92 92 80C102 72 112 70 120 70C128 70 138 72 148 80C162 92 168 114 176 132C188 154 196 178 190 196C182 214 148 214 120 214Z" fill="none" stroke="${S}" stroke-width="4" stroke-linejoin="round"/>`,
    // Folds in the paper.
    `<path d="M80 104C92 128 88 156 84 178M160 106C148 132 152 160 158 182M104 84C120 104 112 132 108 150M66 160C82 168 80 190 76 204M174 160C162 170 166 192 170 204" fill="none" stroke="${S}" stroke-width="2" stroke-linecap="round"/>`,
    // The twist on top.
    `<path d="M112 74C108 62 112 50 120 48C128 50 132 62 128 74Z" fill="${C.bisque}" stroke="${S}" stroke-width="3" stroke-linejoin="round"/>`,
    `<path d="M116 58L120 70L124 58" fill="none" stroke="${S}" stroke-width="2" stroke-linecap="round"/>`,
    // The clay seal and its question mark.
    `<circle cx="120" cy="138" r="22" fill="${C.clay}" stroke="${S}" stroke-width="3"/>`,
    `<path d="M112 132C112 125 116 122 120 122C125 122 128 125 128 130C128 136 120 137 120 144M120 152V153" fill="none" stroke="${C.bisque}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`,
    `</svg>`,
  ];
  return parts.join('');
}
