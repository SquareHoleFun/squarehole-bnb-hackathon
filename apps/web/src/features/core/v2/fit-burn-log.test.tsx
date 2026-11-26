import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppProviders, createQueryClient } from '../../../app-providers';
import { FitBurnLogV2, loadFitBurnLogV2 } from './FitBurnLogV2';
import { safeHistory } from './test-support/safe-history';
import { required } from './test-support/required';

let history: Awaited<ReturnType<typeof safeHistory>>;
beforeAll(async () => { history = await safeHistory(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function publication() {
  const { source, view } = history.burned;
  const feed = structuredClone(history.burned.feed);
  const activity = structuredClone(history.burned.activity);
  const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/activity') ? activity : feed)));
  return { source, view, feed, activity, fetcher };
}

describe('CQ11-E4 on-chain FIT burn publication', () => {
  it('reads the genesis registry and only its burn records, with exact amounts and event identities', async () => {
    const f = publication();
    const log = await loadFitBurnLogV2(f.source, f.fetcher);
    expect(log).toMatchObject({ token: history.fit, executor: history.executor });
    expect(log.burns).toHaveLength(1);
    expect(log.burns[0]).toMatchObject({ amount: 900719925474099300000003n, block: 102n, index: 0 });
    expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([
      `${f.source.origin}/v1/feed?chain=${f.source.manifest.chainId}`,
      `${f.source.origin}/v1/boxes/${f.source.manifest.chainId}/${history.fit.toLowerCase()}/activity?kind=buyback&limit=100`,
    ]);
  });

  it('deduplicates a repeated event and refuses conflicting amounts for the same event', async () => {
    const f = publication(); const burn = required(f.activity.items.find((item) => item.kind === 'buyback'));
    f.activity.items.push(structuredClone(burn));
    expect((await loadFitBurnLogV2(f.source, f.fetcher)).burns).toHaveLength(1);
    f.activity.items.push({ ...burn, data: { bought: '8', unsolicited: '0' } });
    await expect(loadFitBurnLogV2(f.source, f.fetcher)).rejects.toThrow('Conflicting FIT burn');
  });

  it.each(['pending', 'reverted', 'removed', 'funding', 'payout'])('does not treat %s records as burns', async (kind) => {
    const f = publication(); const burn = required(f.activity.items.find((item) => item.kind === 'buyback'));
    f.activity.items = [{ ...burn, ...(kind === 'removed' ? { removed: true } : kind === 'pending' || kind === 'reverted' ? { status: kind } : { kind }) }];
    expect((await loadFitBurnLogV2(f.source, f.fetcher)).burns).toEqual([]);
  });

  it.each(['chain', 'registry', 'pool', 'stale', 'unverified', 'head', 'card', 'duplicate genesis', 'missing genesis'])('refuses a mismatched or unavailable %s', async (kind) => {
    const f = publication(); const card = required(f.feed.cards[0]);
    const badHash = `0x${'f'.repeat(64)}`;
    // Mutate only wire JSON; keep the test's source manifest trusted.
    const feed = f.feed as unknown as Record<string, unknown>;
    if (kind === 'chain') feed.chainId = 1;
    if (kind === 'registry') (card.row as unknown as Record<string, unknown>).registry = f.view.token;
    if (kind === 'pool') (card.row.record as unknown as Record<string, unknown>).poolManager = f.view.token;
    if (kind === 'stale') (card as unknown as Record<string, unknown>).stale = true;
    if (kind === 'unverified') (card as unknown as Record<string, unknown>).verified = false;
    if (kind === 'head') f.activity.asOf = { ...required(f.feed.asOf), hash: badHash };
    if (kind === 'card') (card as unknown as Record<string, unknown>).asOf = { ...card.asOf, hash: badHash };
    if (kind === 'duplicate genesis') feed.cards = [card, card];
    if (kind === 'missing genesis') feed.cards = [];
    await expect(loadFitBurnLogV2(f.source, f.fetcher)).rejects.toThrow();
  });

  it.each(['number', 'negative', 'exponent', 'future', 'old', 'hash', 'index'])('refuses malformed %s burn evidence', async (kind) => {
    const f = publication(); const burn = required(f.activity.items.find((item) => item.kind === 'buyback'));
    if (kind === 'number' || kind === 'negative' || kind === 'exponent') burn.data = { bought: kind === 'number' ? 1 : kind === 'negative' ? '-1' : '1e18', unsolicited: '0' };
    if (kind === 'future') burn.block = '103';
    if (kind === 'old') burn.block = '99';
    if (kind === 'hash') burn.blockHash = `0x${'f'.repeat(64)}`;
    if (kind === 'index') burn.logIndex = -1;
    await expect(loadFitBurnLogV2(f.source, f.fetcher)).rejects.toThrow();
  });

  it('shows loading and unavailable states, and hides old burns when a refresh fails', async () => {
    const f = publication(); const client = createQueryClient();
    vi.stubGlobal('fetch', f.fetcher);
    render(<AppProviders queryClient={client}><FitBurnLogV2 source={f.source} view={f.view} /></AppProviders>);
    expect(screen.getByText('Reading FIT burns…')).toBeTruthy();
    expect(await screen.findByText('900719.925474099300000003 FIT')).toBeTruthy();
    f.fetcher.mockRejectedValue(new Error('offline'));
    await act(async () => { await client.invalidateQueries({ queryKey: ['v2-fit-burns'] }); });
    expect(await screen.findByText('FIT executor history unavailable.')).toBeTruthy();
    expect(screen.queryByText('900719.925474099300000003 FIT')).toBeNull();
  });
});
