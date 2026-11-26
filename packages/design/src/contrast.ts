/**
 * WCAG 2.x relative luminance and contrast ratio for design-token verification.
 * Colour maths only: these helpers never touch financial amounts.
 */
export type Rgb = readonly [number, number, number];

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function parseHexColor(value: string): Rgb {
  if (!HEX.test(value)) throw new Error(`Expected a #rgb or #rrggbb hex colour, got "${value}"`);
  const digits = value.slice(1);
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb;
}

function linearise(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHexColor(hex);
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

/** Contrast ratio between two opaque colours, 1 (none) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const toHex = (channel: number) => Math.round(channel).toString(16).padStart(2, '0');

/** Opaque result of painting `fg` at `alpha` over an opaque `bg` (sRGB source-over). */
export function compositeOver(fg: string, alpha: number, bg: string): string {
  if (!(alpha >= 0 && alpha <= 1)) throw new Error(`alpha must be within 0..1, got ${alpha}`);
  const f = parseHexColor(fg);
  const b = parseHexColor(bg);
  return `#${f.map((channel, i) => toHex(alpha * channel + (1 - alpha) * (b[i] as number))).join('')}`;
}
