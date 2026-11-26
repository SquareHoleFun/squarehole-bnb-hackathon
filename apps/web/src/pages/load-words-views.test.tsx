/**
 * SH-246 fix round (review L4, C2): the wallet view's Claims tab and header rendered in every state of the v2 feed
 * (reading, never answered, answered with no v2 box holding a claim, answered with claims, no v2 part), and /misfits
 * when box 0's feed could not be read.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoxSources, LookupPart } from '../features/boxes/box-sources';
import { WalletBoxView, type WalletBoxViewProps } from '../features/boxes/WalletBoxView';
import { claimsWaiting } from '../features/core/v2/WalletClaimsV2';

const ADDRESS = `0x${'ab'.repeat(20)}`;

afterEach(() => {
  cleanup();
  vi.doUnmock('../features/boxes/useBoxSources');
  vi.resetModules();
});

function view(props: Partial<WalletBoxViewProps>, tab: 'contents' | 'claims' = 'claims') {
  render(
    <MemoryRouter initialEntries={[tab === 'claims' ? '/?tab=claims' : '/']}>
      <WalletBoxView wallet={null} unavailable={null} address={ADDRESS} own demo={false} chainId={11_155_111} networkLabel="Sepolia testnet" {...props} />
    </MemoryRouter>,
  );
}
const readyStat = () => within(screen.getByText('Claims ready').closest('div') as HTMLElement).getByRole('definition').textContent;
const tabLead = () => document.querySelector('.sh-box-lead h2')?.textContent;
const part = (overrides: Partial<LookupPart>): LookupPart => ({ loading: false, answered: true, error: null, ...overrides });

describe('the wallet view’s Claims, rendered in each state of the v2 feed', () => {
  it('reading: "Reading…" in the tab and the header', () => {
    view({ claims: claimsWaiting(part({ loading: true, answered: false })) });
    expect(tabLead()).toBe('Reading…');
    expect(readyStat()).toBe('Reading…');
    expect(document.body.textContent).not.toMatch(/not built yet/i);
  });

  it('never answered: "Not available" in the tab and the header, "Claims did not load." and Retry', async () => {
    const retry = vi.fn();
    view({ claims: claimsWaiting(part({ answered: false, error: 'V2 data unavailable' }), retry) });
    expect(tabLead()).toBe('Not available');
    expect(readyStat()).toBe('Not available');
    expect(await screen.findByText('Claims did not load.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toMatch(/not built yet|V2 data unavailable/i);
  });

  it('answered, no v2 box holds a claim: the earlier words, as on the base (a true replacement must know box 0’s share)', () => {
    view({ claims: claimsWaiting(part({})) });
    expect(tabLead()).toBe('Nothing yet');
    expect(readyStat()).toBe('Not built yet');
  });

  it('answered with claims: the claims’ own lead, count and panel', () => {
    view({ claims: { lead: 'On 2 boxes', ready: '3', panel: <p>Claim all panel</p> } });
    expect(tabLead()).toBe('On 2 boxes');
    expect(readyStat()).toBe('3');
    expect(screen.getByText('Claim all panel')).toBeTruthy();
  });

  it('no v2 part on this source (the sample data): the earlier words stay', () => {
    view({ claims: claimsWaiting(null) });
    expect(tabLead()).toBe('Nothing yet');
    expect(readyStat()).toBe('Not built yet');
  });
});

describe('/misfits when box 0’s feed could not be read (review C2)', () => {
  async function misfits(sources: Partial<BoxSources>) {
    vi.resetModules();
    vi.doMock('../features/boxes/useBoxSources', () => ({
      useBoxSources: () => ({ boxes: [], launch: null, missing: null, core: { status: 'ready', via: 'indexer', summaries: new Map(), dropped: 0 }, ...sources }),
    }));
    const { LaunchRedirect } = await import('./LaunchRedirect');
    render(<MemoryRouter initialEntries={['/misfits']}><LaunchRedirect /></MemoryRouter>);
  }

  it('box 0’s feed never answered (the v2 boxes did): "This box did not load." and Retry, no raw reason', async () => {
    const retry = vi.fn();
    await misfits({ v1: { loading: false, answered: false, error: 'The indexer did not answer: Failed to fetch' }, retry });
    expect(await screen.findByText('This box did not load.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/indexer|Failed to fetch|is shown as FIT/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('box 0’s feed reading again after a Retry: "Reading box 0…", never a guess', async () => {
    await misfits({ v1: { loading: true, answered: false, error: null } });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Reading box 0…');
  });
});
