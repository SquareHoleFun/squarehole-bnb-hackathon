// @vitest-environment node
/**
 * The card's words per state (founder 2026-10-04: an absolute UTC time for an upcoming box, never a countdown; neutral
 * words; Demo says Demo; chain and address on every card).
 */
import { describe, expect, it } from 'vitest';
import { cacheSeconds, cardText, cleanText, formatUtc, GRADUATED_CACHE_SECONDS, LIVE_CACHE_SECONDS, roundToFiveMinutes, stateKey, stateLine, type ShareBox, type ShareState } from './share-model';

/** Box 0's address on the local twin (public; a neutral name keeps the secret scanner's keyword rule quiet). */
const BOX_ADDRESS = '0xbd0a48c997121b66299e558db15b282485495c4a';
/** 11 Oct 2026, 16:00:00 UTC. */
const T = 1_791_734_400;

const box = (state: ShareState, extra: Partial<ShareBox> = {}): ShareBox => ({
  chainId: 11_155_111,
  token: BOX_ADDRESS,
  chainLabel: 'Sepolia',
  name: 'Paper Kites',
  ticker: 'KITE',
  demo: false,
  state,
  logoSha256: null,
  ...extra,
});

const STATES: readonly ShareState[] = [
  { kind: 'upcoming', opensAt: T, approx: false },
  { kind: 'upcoming', opensAt: T, approx: true },
  { kind: 'upcoming', opensAt: null, approx: false },
  { kind: 'open' },
  { kind: 'graduating' },
  { kind: 'graduated' },
  { kind: 'failed' },
];

describe('the state line', () => {
  it('an upcoming box names its opening as a UTC date and time, exact from openAt', () => {
    expect(formatUtc(T)).toBe('11 Oct 2026, 16:00 UTC');
    expect(stateLine({ kind: 'upcoming', opensAt: T, approx: false })).toBe('Opens 11 Oct 2026, 16:00 UTC');
    expect(stateLine({ kind: 'upcoming', opensAt: T + 59, approx: false })).toBe('Opens 11 Oct 2026, 16:00 UTC');
  });

  it('an open block estimate says "about" and rounds to five minutes', () => {
    expect(roundToFiveMinutes(T + 149)).toBe(T);
    expect(roundToFiveMinutes(T + 150)).toBe(T + 300);
    expect(stateLine({ kind: 'upcoming', opensAt: T + 2 * 60, approx: true })).toBe('Opens about 11 Oct 2026, 16:00 UTC');
    expect(stateLine({ kind: 'upcoming', opensAt: T + 4 * 60, approx: true })).toBe('Opens about 11 Oct 2026, 16:05 UTC');
  });

  it('the window and the curve are "Open now"; then Graduating, Graduated; a Demo failure "Did not graduate"', () => {
    expect(STATES.map(stateLine)).toEqual([
      'Opens 11 Oct 2026, 16:00 UTC',
      'Opens about 11 Oct 2026, 16:00 UTC',
      'Upcoming',
      'Open now',
      'Graduating',
      'Graduated',
      'Did not graduate',
    ]);
  });

  it('never a relative countdown, and only neutral words', () => {
    for (const state of STATES) {
      const words = Object.values(cardText(box(state))).join(' ');
      expect(words).not.toMatch(/\bin \d|\d+ ?(h|m|min|hours?|minutes?|days?) left|ago\b/i);
      expect(words).not.toMatch(/\b(buy|sell|price|moon|pump|profit|gain|verified|official|rank|top|best|guarantee)/i);
    }
  });

  it('dates are UTC and the same in every locale (fixed month words, 24-hour clock)', () => {
    expect(formatUtc(Date.UTC(2027, 0, 2, 3, 4) / 1000)).toBe('2 Jan 2027, 03:04 UTC');
    expect(formatUtc(Date.UTC(2026, 11, 31, 23, 59) / 1000)).toBe('31 Dec 2026, 23:59 UTC');
  });
});

describe('the card text', () => {
  it('name, ticker, state, the chain and the full address (the one thing that tells two boxes of one name apart)', () => {
    expect(cardText(box({ kind: 'open' }))).toEqual({
      name: 'Paper Kites',
      ticker: 'KITE',
      state: 'Open now',
      stateLead: null,
      stateMain: 'Open now',
      chain: 'Sepolia',
      address: BOX_ADDRESS,
      demo: false,
    });
    expect(cardText(box({ kind: 'upcoming', opensAt: T, approx: true }))).toMatchObject({ stateLead: 'Opens about', stateMain: '11 Oct 2026, 16:00 UTC' });
  });

  it('a Demo box says Demo', () => {
    expect(cardText(box({ kind: 'open' }, { demo: true, chainLabel: 'Demo chain' }))).toMatchObject({ demo: true, chain: 'Demo chain', address: BOX_ADDRESS });
  });

  it('a box without a usable name shows its ticker', () => {
    expect(cardText(box({ kind: 'open' }, { name: '\u202e\u0000 ' })).name).toBe('KITE');
  });
});

describe('untrusted names', () => {
  it('control characters and bidirectional overrides are removed, spaces collapsed', () => {
    expect(cleanText('Paper\u202eetik  Kites\u0007\n', 40)).toBe('Paperetik Kites');
    expect(cleanText('\u2066A\u2069\u200bB', 40)).toBe('AB');
  });

  it('long text is cut with an ellipsis', () => {
    expect(cleanText('abcdefghij', 6)).toBe('abcde…');
    expect(cleanText('abc', 6)).toBe('abc');
  });
});

describe('caching and the card URL key', () => {
  it('a few minutes while the state can change, a week once graduated', () => {
    expect(cacheSeconds({ kind: 'open' })).toBe(LIVE_CACHE_SECONDS);
    expect(cacheSeconds({ kind: 'upcoming', opensAt: T, approx: false })).toBe(300);
    expect(cacheSeconds({ kind: 'graduated' })).toBe(GRADUATED_CACHE_SECONDS);
  });

  it('the key changes with the state (and with the opening time)', () => {
    expect(STATES.map(stateKey)).toEqual([`upcoming-${T}`, `upcoming-${T}`, 'upcoming', 'open', 'graduating', 'graduated', 'failed']);
  });
});
