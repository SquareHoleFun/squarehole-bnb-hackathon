// @vitest-environment node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin, type Rolldown } from 'vite';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../../vitest.timeouts.mjs';
import { buildDefines, productionSideEffects } from '../../build-target';
import { buildModeOf } from '../../deployments-plugin';
import { TRADE_PATTERN } from '../../production-check';
import { ABOUT_FACTS } from './about-facts';
import { ABOUT_CARDS, IN_APP_TRADING, NO_TRADING_CARD, SHOWN_PROVIDERS, TEST_TRADING_CARD, TRADING_CARD, type AboutCardCopy } from './about-content';

/**
 * SH-ALPHA-NOTICE: About & risks shows one trading card per build, chosen by the trade literal
 * (`import.meta.env.SH_SEPOLIA_TRADE`, build-target.ts `sepoliaTradeOf`): the main site's "No trading here" without the
 * trade code, the Sepolia alpha's "Test trades only" with it. vitest defines no literal, so the modules give the main
 * site's card here; the builds below fold the choice as the site's own build does, and each keeps one card's words only.
 */
const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = 'virtual:squarehole-trading-card-entry';
const RESOLVED = `\0${ENTRY}`;
const entryPlugin: Plugin = {
  name: 'squarehole-trading-card-entry',
  resolveId: (id) => (id === ENTRY ? RESOLVED : null),
  load: (id) => (id === RESOLVED ? `export { ABOUT_CARDS, IN_APP_TRADING, TRADING_CARD } from ${JSON.stringify(join(WEB, 'src/pages/about-content.ts'))};` : null),
};

type Env = Record<string, string>;

/** About & risks' copy module built as vite.config.ts builds the site for `env`: its defines and its tree-shaking. */
async function buildCards(env: Env): Promise<string> {
  const production = buildModeOf(env) === 'production';
  const output = (await build({
    configFile: false,
    root: WEB,
    logLevel: 'silent',
    define: buildDefines(env, 'build'),
    plugins: [entryPlugin],
    build: {
      write: false,
      minify: false,
      emptyOutDir: false,
      rolldownOptions: { input: ENTRY, preserveEntrySignatures: 'strict', ...(production ? { treeshake: { moduleSideEffects: productionSideEffects } } : {}) },
    },
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const outputs = Array.isArray(output) ? output : [output];
  return outputs.flatMap((result) => result.output).map((chunk) => (chunk.type === 'chunk' ? chunk.code : String(chunk.source))).join('\n');
}

/** The values the cards' words take from elsewhere (a template's part in the code, not its text). */
const INTERPOLATED = [ABOUT_FACTS.window, SHOWN_PROVIDERS.map((provider) => provider.name).join(', ')];

/** Every word of a card a visitor can read (title, figure labels, lead, details), as the pieces its source holds. */
function fragments(card: AboutCardCopy): string[] {
  return [card.title, ...card.figures.map((figure) => figure.label), card.lead, ...card.details]
    .flatMap((text) => INTERPOLATED.reduce<string[]>((parts, value) => parts.flatMap((part) => part.split(value)), [text]))
    .map((part) => part.trim())
    .filter((part) => part.length >= 8);
}

const MAIN = fragments(NO_TRADING_CARD);
const ALPHA = fragments(TEST_TRADING_CARD);
const markers = (code: string): string[] => [...code.matchAll(new RegExp(TRADE_PATTERN.source, TRADE_PATTERN.flags))].map((match) => match[0]);
/** The status strip's line as the code holds it: a quoted string, not words inside other text. */
const literal = (words: string): RegExp => new RegExp(`(["'\x60])${words}\\1`);

describe('the trading card of About & risks (SH-ALPHA-NOTICE, F156)', () => {
  it('the development modules (no trade literal) show the main site’s card, unchanged', () => {
    expect(TRADING_CARD).toBe(NO_TRADING_CARD);
    expect(ABOUT_CARDS.at(-1)).toBe(NO_TRADING_CARD);
    expect(NO_TRADING_CARD).toEqual({
      id: 'risks-trading',
      title: 'No trading here',
      figures: [
        { value: '0', label: 'Trade forms' },
        { value: '0', label: 'Wallet pop-ups' },
      ],
      lead: 'Trades happen on outside venues; browsing never opens your wallet.',
      details: [
        `Box pages link only to reviewed sites (${SHOWN_PROVIDERS.map((provider) => provider.name).join(', ')}), with the exact chain and contract address. A name or picture proves nothing.`,
        'A wallet asks for your approval only after you connect and start an action: creating a box, a vault action, a claim or closing a box.',
        'A browser wallet you connected here reconnects when you come back, without opening; Disconnect stops that.',
        'Square Hole never holds your tokens or keys.',
      ],
      terms: ['5'],
    });
    expect(Object.isFrozen(NO_TRADING_CARD)).toBe(true);
    // The status strip's line goes with the card (F131 R45D's words on the main site).
    expect(IN_APP_TRADING).toBe('None today');
  });

  it('the Sepolia alpha’s card has the same shape: its slot, two figures, one lead sentence, details, the same Terms section', () => {
    expect(TEST_TRADING_CARD.id).toBe(NO_TRADING_CARD.id);
    expect(TEST_TRADING_CARD.terms).toEqual(NO_TRADING_CARD.terms);
    expect(TEST_TRADING_CARD.title).toBe('Test trades only');
    expect(TEST_TRADING_CARD.figures).toEqual([
      { value: '0', label: 'Real money' },
      { value: 'Exact', label: 'Wallet amounts' },
    ]);
    expect(TEST_TRADING_CARD.lead).toBe('Box pages buy and sell test tokens only; browsing never opens your wallet.');
    expect(TEST_TRADING_CARD.details).toEqual([
      'Trades open your wallet only when you press Buy or Sell, for the exact amount; a wallet Privy made signs on that press, with no window of its own.',
      'In a box’s first 6.4 min, buys go through the box’s launch router and pay its tax.',
      'Other trades go through Uniswap’s test swap contract, with a price limit but no deadline; they can fill in part.',
      'Square Hole never holds your test tokens or your keys.',
    ]);
    expect(Object.isFrozen(TEST_TRADING_CARD)).toBe(true);
    // No line of one card is a line of the other, so a build scan tells them apart.
    expect(MAIN.filter((piece) => ALPHA.some((other) => other.includes(piece) || piece.includes(other)))).toEqual([]);
    // The switch's trade rule refuses its markers outside the lazy trade chunk; this page is not that chunk.
    expect([...MAIN, ...ALPHA].filter((piece) => markers(piece).length > 0)).toEqual([]);
    expect(ALPHA.join(' ')).not.toMatch(/PoolSwapTest|0x[0-9a-f]{8}/i);
  });

  it('a mainnet production build ships the main site’s card and strip line, and none of the alpha card’s words', async () => {
    const code = await buildCards({ SH_BUILD: 'production', SH_TARGET: 'mainnet' });
    for (const piece of MAIN) expect(code, piece).toContain(piece);
    for (const piece of ALPHA) expect(code, piece).not.toContain(piece);
    expect(code).toMatch(literal('None today'));
    expect(code).not.toMatch(literal('Test trades only'));
    expect(markers(code)).toEqual([]);
  }, shLimit(60_000));

  it('the Sepolia production build ships the alpha’s card and strip line, and none of the main site card’s words', async () => {
    const code = await buildCards({ SH_BUILD: 'production', SH_TARGET: 'sepolia' });
    for (const piece of ALPHA) expect(code, piece).toContain(piece);
    for (const piece of MAIN) expect(code, piece).not.toContain(piece);
    // The review's fix F3: the strip says "Test trades only" (the footer's own fact is "Test tokens only").
    expect(code).toMatch(literal('Test trades only'));
    expect(code).not.toMatch(literal('None today'));
    expect(markers(code)).toEqual([]);
  }, shLimit(60_000));

  it('a development build follows the opt-in: the alpha’s card with SH_SEPOLIA_TRADE=1, the main site’s without', async () => {
    const optedIn = await buildCards({ SH_SEPOLIA_TRADE: '1' });
    for (const piece of ALPHA) expect(optedIn, piece).toContain(piece);
    for (const piece of MAIN) expect(optedIn, piece).not.toContain(piece);
    const plain = await buildCards({});
    for (const piece of MAIN) expect(plain, piece).toContain(piece);
    for (const piece of ALPHA) expect(plain, piece).not.toContain(piece);
  }, shLimit(60_000));
});
