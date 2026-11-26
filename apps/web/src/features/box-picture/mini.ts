/**
 * SH-251: a template's small picture: the same box as the big picture, small, with the recipe's own icon over its hole
 * (the template icons of brand/template-icons.tsx, so a tile and its name read as on the steps' row). Pure geometry.
 */
export const MINI = Object.freeze({
  width: 72,
  height: 52,
  shadow: Object.freeze({ cx: 36, cy: 49, rx: 25, ry: 2.5 }),
  top: 'M16 29 H56 L61 36 H11 Z',
  front: 'M11 36 H61 V45 Q61 48 58 48 H14 Q11 48 11 45 Z',
  hole: 'M30 30.5 H42 L44 34.5 H28 Z',
  /** Where the 24-unit icon sits over the box, and its scale. */
  icon: Object.freeze({ x: 25, y: 2, scale: 0.92 }),
});

/** The station icons of the big picture that have no template icon: a padlock, for a price coin locked forever. */
export const LOCK_ICON = 'M5 10.5h14v10H5zM8 10.5V7.8a4 4 0 0 1 8 0v2.7M12 14.6v2';
