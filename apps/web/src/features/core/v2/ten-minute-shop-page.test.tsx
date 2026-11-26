/**
 * SH-300: a REAL ten-minute card shop box of the second release through the site's own parsers and its box page. The
 * card is the indexer's answer on the SH-300 stand (lane c's fork-3 rehearsal replayed: "Rehearsal Quick Cards",
 * QCARD, made by the second release's factory, its spec encoded and hashed on the fork stand's chain with a 600-second wait; recorded on the fork stand, fork addresses); the
 * manifest is fork-3's two-release file (fork addresses). Nothing here substitutes the wait after parsing.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCoreManifestV2 } from '../../../../../../packages/chain/src/core/v2';
import { shopConfigV2 } from '../../../../../../packages/chain/src/core/v2/m2-spec-v2';
import { AppProviders } from '../../../app-providers';
import { createDemoWalletAdapter } from '../../wallet';
import { parseSnapshotV2, type V2Source } from './indexer-v2';
import { utcDate } from './ShopActionsV2';
import { recordV2 } from './record-v2';
import feed from './test-support/fork3-feed-three.json' with { type: 'json' };
import manifest from './test-support/fork3-manifest-97.json' with { type: 'json' };
import { V2BoxPage } from './V2BoxPage';
import { required } from './test-support/required';
vi.mock('./SafesV2', () => ({ SafesV2: () => null }));
vi.mock('./BurnLogV2', () => ({ BurnLogV2: () => null }));
vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));

const SECOND_REGISTRY = '0x8b4eefaed20a49b9139881963aa1d4b0825df5d3';
// The stand's feed: VRAM and RENT of the first release, QCARD of the second.
const card = required(feed.cards[1]);
const source: V2Source = { network: 'sepolia', manifest: parseCoreManifestV2(manifest), origin: 'https://index.invalid', rpc: 'http://127.0.0.1:9' };

beforeEach(() => { vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline'))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('a ten-minute card shop box of the second release', () => {
  it('parses with the site\'s snapshot parser: its own release, its shop config says 600 seconds', () => {
    const view = parseSnapshotV2(card, source);
    expect(view.release.registry.address).toBe(SECOND_REGISTRY);
    expect(view.release).toBe(source.manifest.releases[1]);
    expect(shopConfigV2(view.spec.contentsParams).listDelay).toBe(600);
  });
  it('its box page opens, and the shop reads its wait in minutes', async () => {
    const view = parseSnapshotV2(card, source);
    render(<AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}><MemoryRouter><V2BoxPage record={recordV2(view, source, null, 'tUSDC')} /></MemoryRouter></AppProviders>);
    const shop = screen.getByRole('region', { name: 'Shop' });
    fireEvent.click(within(shop).getByRole('button', { name: 'About the shop' }));
    expect(within(shop).getByText(/10 minutes before a new entry accepts gives\.$/)).toBeTruthy();
    expect(shop.textContent).not.toMatch(/\d+(\.\d+)? days before a new entry/);
  });
});

describe('an accepted snapshot never fails its whole box page', () => {
  it('a starter add-on (8) that does not decode: the box page opens, the shop stays', () => {
    const parsed = parseSnapshotV2(card, source);
    const view = { ...parsed, spec: { ...parsed.spec, addOns: [...parsed.spec.addOns.filter((a) => a.id !== 8), { id: 8, params: '0x1234' as const }] } };
    render(<AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}><MemoryRouter><V2BoxPage record={recordV2(view as never, source, null, 'tUSDC')} /></MemoryRouter></AppProviders>);
    const shop = screen.getByRole('region', { name: 'Shop' });
    // The starter count is unknown: no starter part, so no state line ("Ready to complete" sits inside it).
    expect(screen.queryByRole('region', { name: 'Starter loading' })).toBeNull();
    expect(shop.textContent).not.toContain('Ready to complete');
  });
  it('a shop time no date can show reads so; a real one as before', () => {
    expect(utcDate(10n ** 30n)).toBe('a date this page cannot show');
    expect(utcDate(0n)).toBe('1 Jan 1970, 00:00 UTC');
  });
});
