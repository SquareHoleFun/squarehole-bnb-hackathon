import { describe, expect, it } from 'vitest';
import { compositeOver, contrastRatio, parseHexColor, relativeLuminance } from './contrast';

describe('parseHexColor', () => {
  it('reads 6- and 3-digit hex colours case-insensitively', () => {
    expect(parseHexColor('#A78BFA')).toEqual([167, 139, 250]);
    expect(parseHexColor('#a78bfa')).toEqual([167, 139, 250]);
    expect(parseHexColor('#fff')).toEqual([255, 255, 255]);
  });

  it('rejects anything that is not a hex colour', () => {
    for (const bad of ['', 'A78BFA', '#12345', '#GGGGGG', 'rgb(1,2,3)', '#1234567']) {
      expect(() => parseHexColor(bad)).toThrow(/hex colour/);
    }
  });
});

describe('relativeLuminance (WCAG 2.x)', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBe(1);
  });

  it('uses the sRGB linearisation threshold', () => {
    // 0x0A / 255 = 0.0392 is below the 0.04045 threshold → linear segment.
    expect(relativeLuminance('#0a0a0a')).toBeCloseTo(0.0392 / 12.92, 5);
  });
});

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
    // Well-known pair: #767676 on white is the lightest grey that passes 4.5:1.
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.5);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#A78BFA', '#080D16')).toBeCloseTo(contrastRatio('#080D16', '#A78BFA'), 10);
  });
});

describe('compositeOver', () => {
  it('blends a translucent colour over an opaque background', () => {
    expect(compositeOver('#ffffff', 0, '#000000')).toBe('#000000');
    expect(compositeOver('#ffffff', 1, '#000000')).toBe('#ffffff');
    expect(compositeOver('#ffffff', 0.5, '#000000')).toBe('#808080');
  });

  it('rejects alpha outside 0..1', () => {
    expect(() => compositeOver('#ffffff', 1.5, '#000000')).toThrow(/alpha/);
    expect(() => compositeOver('#ffffff', -0.1, '#000000')).toThrow(/alpha/);
  });
});
