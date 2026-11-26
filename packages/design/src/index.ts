// Shared tokens, fonts, character art and contrast helpers (SH-003).
// Styles: import '@squarehole/design/styles.css' once at the app entry (font, tokens, base, art components).
export { AssetMonogram, monogramFor, type AssetMonogramProps } from './art/AssetMonogram';
export { CastCharacter, type CastCharacterProps } from './art/CastCharacter';
export { DEMO_AVATARS, demoAvatarFor } from './art/demo-avatars';
export { PairAvatar, displaySize, type PairAvatarProps } from './art/PairAvatar';
export { ART, CAST, castArt, castMember, type ArtAsset, type CastId, type CastMember } from './art/registry';
export { MISFITS_ART, boxArt, type BoxArtAsset } from './art/misfits-art';
export { SquareHoleGlyph } from './art/SquareHoleGlyph';
export { compositeOver, contrastRatio, parseHexColor, relativeLuminance } from './contrast';

/** Layout breakpoints in CSS px (CSS custom properties cannot be used inside media queries). */
export const BREAKPOINTS = Object.freeze({ compact: 640, rail: 1024 });
