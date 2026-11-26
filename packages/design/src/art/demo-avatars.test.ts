import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEMO_AVATARS, demoAvatarFor } from './demo-avatars';
import { ART } from './registry';

interface FixturePair {
  pairId: string;
  name: string;
}
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../square-hole-handoff/fixtures/feed.json', import.meta.url)), 'utf8'),
) as { items: FixturePair[] };

describe('demo avatar map (fixture pairIds → art)', () => {
  it('covers every fixture pair except exactly one, NO PRICE YET, which exercises the unavailable-artwork state', () => {
    const unmapped = fixture.items.filter((pair) => demoAvatarFor(pair.pairId) === null).map((pair) => pair.name);
    expect(unmapped).toEqual(['NO PRICE YET']);
  });

  it('only references extracted art and only fixture pairIds', () => {
    const fixtureIds = new Set(fixture.items.map((pair) => pair.pairId));
    for (const [pairId, artId] of DEMO_AVATARS) {
      expect(fixtureIds.has(pairId), pairId).toBe(true);
      expect(ART.has(artId), artId).toBe(true);
    }
  });

  it('never gives an ordinary demo pair a platform cast member (the cast hosts the platform, F09)', () => {
    const casted = fixture.items.filter((pair) => demoAvatarFor(pair.pairId)?.cast === 'sorter').map((pair) => pair.name);
    expect(casted).toEqual([]);
  });

  it('follows the documented mapping', () => {
    const byName = Object.fromEntries(fixture.items.map((pair) => [pair.name, demoAvatarFor(pair.pairId)?.id ?? null]));
    expect(byName).toEqual({
      'Square Hole': 'platform-tile',
      ORCHARD: 'orchard-tree',
      'ROUND TRIP': 'shape-sphere',
      'MISFIT STUDIO': 'orchard-tree-sunglasses',
      APPLEHOLE: 'shape-sphere',
      'TINY FRAMES': 'collector-frame',
      'SOFT CORNERS': 'shape-cube',
      'WRONG ANGLE': 'shape-pyramid',
      'COIN CONFETTI': 'shape-gem',
      'LITTLE ORCHARD': 'orchard-tree-blossom',
      'NEW SHAPE': 'shape-cube',
      'NO PRICE YET': null,
    });
  });

  it('matches the address case-insensitively (pairId canonical form is lowercase, ADR-0003)', () => {
    expect(demoAvatarFor('31337:0x000000000000000000000000000000000000006A')?.id).toBe('collector-frame');
    expect(demoAvatarFor('1:0x0000000000000000000000000000000000000066')).toBeNull();
    expect(demoAvatarFor('')).toBeNull();
  });
});
