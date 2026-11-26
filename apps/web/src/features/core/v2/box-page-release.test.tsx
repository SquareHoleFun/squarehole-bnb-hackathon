/**
 * SH-300: the box page hands a box's OWN release to the reads that depend on it: The Alchemist's module check
 * (`useBoxAlchemist`) and the pile coin's listing book (`usePileCoin`). Rendered for a second-release box (the stand's
 * QCARD, recorded on the fork stand) with fork-3's two-release manifest; fails if the page passes the first release.
 */
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCoreManifestV2 } from '../../../../../../packages/chain/src/core/v2';
import { AppProviders } from '../../../app-providers';
import { createDemoWalletAdapter } from '../../wallet';
import { parseSnapshotV2, type V2Source } from './indexer-v2';
import { recordV2 } from './record-v2';
import feed from './test-support/fork3-feed-three.json' with { type: 'json' };
import manifest from './test-support/fork3-manifest-97.json' with { type: 'json' };
import { required } from './test-support/required';
import { V2BoxPage } from './V2BoxPage';

const seen = vi.hoisted(() => ({ alchemist: [] as unknown[], pile: [] as unknown[] }));
vi.mock('../../create/v2/alchemist', async (original) => ({ ...await original<object>(), useBoxAlchemist: (...args: unknown[]) => { seen.alchemist.push(args[3]); return null; } }));
vi.mock('./pile-coin', async (original) => ({ ...await original<object>(), usePileCoin: (...args: unknown[]) => { seen.pile.push(args[3]); return null; } }));
vi.mock('./SafesV2', () => ({ SafesV2: () => null }));
vi.mock('./BurnLogV2', () => ({ BurnLogV2: () => null }));
vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));

const source: V2Source = { network: 'sepolia', manifest: parseCoreManifestV2(manifest), origin: 'https://index.invalid', rpc: 'http://127.0.0.1:9' };
beforeEach(() => { vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline'))); seen.alchemist.length = 0; seen.pile.length = 0; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('a second-release box page', () => {
  it('passes the box\'s own release to The Alchemist\'s check and the pile coin\'s book, never the first', () => {
    const view = parseSnapshotV2(required(feed.cards[1]), source);
    const [first, second] = [required(source.manifest.releases[0]), required(source.manifest.releases[1])];
    expect(view.release).toBe(second);
    render(<AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}><MemoryRouter><V2BoxPage record={recordV2(view, source, null, 'tUSDC')} /></MemoryRouter></AppProviders>);
    expect(seen.alchemist.length).toBeGreaterThan(0);
    expect(seen.pile.length).toBeGreaterThan(0);
    for (const release of [...seen.alchemist, ...seen.pile]) {
      expect(release).toBe(second);
      expect(release).not.toBe(first);
    }
  });
});
