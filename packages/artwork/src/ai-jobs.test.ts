/**
 * SH-011 optional paid AI artwork jobs (C07; ART-03, ART-04, ART-05). No provider is configured, so the only adapter
 * is the unconfigured one: it reports "unavailable" with no price and no duration, and it cannot be asked for a quote.
 * A future provider must return an explicit quote (total, asset, expiry, failure and refund policy) before any charge.
 */
import { describe, expect, it } from 'vitest';
import { AiArtworkUnavailableError, aiJobQuoteIssues, createUnconfiguredAiArtworkProvider, type AiJobQuote } from './index';

const quote = (): AiJobQuote => ({
  quoteId: 'q-1',
  providerName: 'Example broker',
  itemCount: 4,
  price: {
    asset: { chainId: 31337, address: '0x000000000000000000000000000000000000232a', symbol: 'USDC-DEMO', decimals: 6, issuerStatus: 'mock' },
    totalRaw: '2000000',
  },
  expiresAt: '2026-09-25T12:10:00Z',
  estimatedDuration: null,
  failurePolicy: 'A failed job is not charged.',
  refundPolicy: 'Rejected previews are refunded in full within 7 days.',
});

describe('createUnconfiguredAiArtworkProvider', () => {
  it('is unavailable with a reason and no price or duration', async () => {
    const provider = createUnconfiguredAiArtworkProvider();
    expect(provider.configured).toBe(false);
    const status = await provider.status();
    expect(status).toEqual({ state: 'unavailable', reason: 'not_configured', message: expect.any(String) });
    if (status.state === 'unavailable') {
      expect(status.message).not.toMatch(/\$|€|\d+\s*(s|sec|min|minutes?|hours?)\b|price:|costs?\s+\d/i);
    }
  });

  it('refuses quotes and jobs', async () => {
    const provider = createUnconfiguredAiArtworkProvider();
    await expect(provider.requestQuote({ prompt: 'trees', itemCount: 4 })).rejects.toBeInstanceOf(AiArtworkUnavailableError);
    await expect(provider.requestQuote({ prompt: 'trees', itemCount: 4 })).rejects.toMatchObject({ code: 'ai_unavailable' });
  });

  it('holds no credential: the adapter is created without any configuration (ART-05)', () => {
    expect(createUnconfiguredAiArtworkProvider.length).toBe(0);
    expect(JSON.stringify(createUnconfiguredAiArtworkProvider())).not.toMatch(/key|secret|token|bearer/i);
  });
});

describe('aiJobQuoteIssues (ART-04)', () => {
  it('accepts an explicit quote with both policies; the duration may be unknown', () => {
    expect(aiJobQuoteIssues(quote(), '2026-09-25T12:00:00Z')).toEqual([]);
  });

  it.each([
    ['a zero total', (q: AiJobQuote) => ({ ...q, price: { ...q.price, totalRaw: '0' } }), 'price.totalRaw'],
    ['a decimal total', (q: AiJobQuote) => ({ ...q, price: { ...q.price, totalRaw: '1.5' } }), 'price.totalRaw'],
    ['no failure policy', (q: AiJobQuote) => ({ ...q, failurePolicy: '  ' }), 'failurePolicy'],
    ['no refund policy', (q: AiJobQuote) => ({ ...q, refundPolicy: '' }), 'refundPolicy'],
    ['an expired quote', (q: AiJobQuote) => ({ ...q, expiresAt: '2026-09-25T11:59:59Z' }), 'expiresAt'],
    ['a malformed expiry', (q: AiJobQuote) => ({ ...q, expiresAt: 'soon' }), 'expiresAt'],
    ['no items', (q: AiJobQuote) => ({ ...q, itemCount: 0 }), 'itemCount'],
    ['a zero-address asset', (q: AiJobQuote) => ({ ...q, price: { ...q.price, asset: { ...q.price.asset, address: '0x0000000000000000000000000000000000000000' } } }), 'price.asset'],
  ] as const)('flags %s', (_name, mutate, path) => {
    expect(aiJobQuoteIssues(mutate(quote()) as AiJobQuote, '2026-09-25T12:00:00Z')).toContain(path);
  });
});
