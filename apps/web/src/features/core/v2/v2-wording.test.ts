/**
 * The v2 words (F99, F100, F103): a failed box pays the closing price from its closing pool, the button is "Close box",
 * and the word "refund" is not used. Every v2 source file is checked whole (code, strings and comments), and the
 * failed-state words the shared box parts use for a v2 box.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLONE_LINE, CLOSE_BOX, CLOSED, CLOSING_POOL, CLOSING_PRICE, closingPriceInfo, failedWords } from './v2-words';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('v2 wording', () => {
  it('no v2 source file says "refund", in code, strings or comments', () => {
    const files = readdirSync(HERE).filter((name) => /\.(ts|tsx|css)$/.test(name) && !/\.test\.tsx?$/.test(name));
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const name of files) expect(readFileSync(join(HERE, name), 'utf8'), name).not.toMatch(/refund/i);
  });

  it('the words themselves', () => {
    expect([CLOSE_BOX, CLONE_LINE, CLOSED, CLOSING_PRICE, CLOSING_POOL]).toEqual(['Close box', 'Clone, not upgradeable', 'Closed', 'Closing price', 'Closing pool']);
  });

  it('the closing price is paid in the pricing token P, named; never in the box’s own token T (ADR-0017 § 5)', () => {
    for (const symbol of ['ETH', 'LINK', 'USDC']) {
      expect(closingPriceInfo(symbol)).toMatch(new RegExp(`paid in ${symbol}\\b`));
      expect(closingPriceInfo(symbol)).not.toMatch(/own token|refund/i);
    }
  });

  it('a v2 box’s failed-state words in the shared parts never say "refund"; a v1 box keeps its own until the site-wide rename', () => {
    expect(Object.values(failedWords(true)).join(' · ')).not.toMatch(/refund/i);
    expect(failedWords(true)).toEqual({ figure: 'Closed', lead: 'Unused ones go back to the creator.', market: 'Open on Uniswap', phone: 'Closing price' });
    // The change request in SH-V2-M1-53B.md: v1's Demo words are the integrator's to rename (their tests are not this slot's).
    expect(failedWords(false)).toEqual({ figure: 'Refunds open', lead: 'Refunds open.', market: 'Refund on Uniswap', phone: 'Refund' });
  });
});
