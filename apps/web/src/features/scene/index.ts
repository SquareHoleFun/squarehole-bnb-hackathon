/**
 * Public surface of the decorative shape-sorter scene (SH-008). Importing this module never loads
 * three.js; the WebGL scene is a separate lazy chunk fetched only when gating allows it.
 */
export { ShapeSorterAccent, type ShapeSorterAccentProps } from './ShapeSorterAccent';
export type { AccentPhase, AccentStatus } from './controller';
export type { SceneFallbackReason } from './gate';
export type { SceneVariant } from './sceneTypes';
