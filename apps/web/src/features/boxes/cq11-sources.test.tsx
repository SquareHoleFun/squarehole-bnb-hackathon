import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppProviders } from '../../app-providers';
import { DataSourceProvider, resetDataSourceForTests, saveDataSource, useDataSource } from '../data-source';
import { DataSourceSettings } from '../data-source/DataSourceSettings';
import { coreAvailability, type CoreBuild } from '../core/core-build';
import { mixedDeployment } from '../core/v2/test-support/mixed-deployment';
import { useBoxSources } from './useBoxSources';
import type { Fetcher } from '../core/core-client';

afterEach(() => { cleanup(); resetDataSourceForTests(); });

it.each([false, true])('CQ11-E4: real source selection retains v1 and v2 rows (independently enabled: %s)', async (independent) => {
  resetDataSourceForTests(); saveDataSource('demo');
  const { manifest, feed, v1, v1Token, body } = await mixedDeployment();
  expect(manifest.releases[0]?.safes.platform.address).toBe(manifest.chain.platformSafe.address.toLowerCase());
  const availability = coreAvailability([manifest]);
  const coreBuild: CoreBuild = { manifests: [manifest], localRpcUrl: 'http://127.0.0.1:8599', indexers: { local: 'https://indexer.invalid', sepolia: null } };
  const fetcher: Fetcher = vi.fn(async (input) => {
    const path = new URL(String(input)).pathname;
    const result = path === '/v1/feed' ? v1.feed : path === '/v2/feed' ? feed : null;
    if (!result) throw new Error(`Unexpected request ${path}`);
    return new Response(JSON.stringify(result), { status: 200 });
  });
  function Sources() {
    const source = useDataSource();
    const { boxes } = useBoxSources({ fitMarkets: [], localRpcUrl: coreBuild.localRpcUrl }, coreBuild, fetcher);
    return <><DataSourceSettings /><p data-testid="source">{source.id}</p>
      <ul>{boxes.map((box) => <li key={box.id}>{`${box.token.toLowerCase()} ${box.row ? 'v1' : box.v2Chain ? 'v2' : 'demo'}`}</li>)}</ul></>;
  }
  render(<DataSourceProvider build={{ localManifest: independent ? {} : null, sepoliaManifest: null, localRpcUrl: coreBuild.localRpcUrl, coreLocal: availability.local }}>
    <AppProviders><Sources /></AppProviders>
  </DataSourceProvider>);
  const local = screen.getByRole('radio', { name: /Local chain/ });
  expect((local as HTMLInputElement).disabled).toBe(false);
  fireEvent.click(local);
  expect(screen.getByTestId('source').textContent).toBe('local');
  await waitFor(() => {
    expect(screen.getByText(`${v1Token.toLowerCase()} v1`)).toBeTruthy();
    expect(screen.getByText(`${body.token.toLowerCase()} v2`)).toBeTruthy();
  });
  // SH-SITE-FIXES-10: each feed read carries its deadline's signal (an unanswered request is aborted, then asked again).
  expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/v1/feed?'), { signal: expect.any(AbortSignal) });
  expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/v2/feed?'), { signal: expect.any(AbortSignal) });
});

// FE1 (the flaky BC-086 browser case): box 0 lives in the v1 feed. While that feed is still loading, a v2 feed that
// fails or answers first must not end the loading state, or /misfits falls back to the launch market's box for good.
it.each(['fails', 'answers'] as const)('FE1: while the v1 feed loads, a v2 feed that %s first keeps the sources loading', async (v2) => {
  resetDataSourceForTests(); saveDataSource('local');
  const { manifest, feed, v1 } = await mixedDeployment();
  const availability = coreAvailability([manifest]);
  const coreBuild: CoreBuild = { manifests: [manifest], localRpcUrl: 'http://127.0.0.1:8599', indexers: { local: 'https://indexer.invalid', sepolia: null } };
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const fetcher: Fetcher = vi.fn(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/feed') { await held; return new Response(JSON.stringify(v1.feed), { status: 200 }); }
    if (path === '/v2/feed') return v2 === 'fails' ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(feed), { status: 200 });
    throw new Error(`Unexpected request ${path}`);
  });
  const seen: string[] = [];
  function Sources() {
    const { core, boxes } = useBoxSources({ fitMarkets: [], localRpcUrl: coreBuild.localRpcUrl }, coreBuild, fetcher);
    seen.push(core.status);
    return <><p data-testid="status">{core.status}</p><p data-testid="box0">{String(boxes.some((box) => box.row?.row.isBox0 === true))}</p></>;
  }
  render(<DataSourceProvider build={{ localManifest: null, sepoliaManifest: null, localRpcUrl: coreBuild.localRpcUrl, coreLocal: availability.local }}>
    <AppProviders><Sources /></AppProviders>
  </DataSourceProvider>);
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/v2/feed?'), { signal: expect.any(AbortSignal) }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.getByTestId('status').textContent).toBe('loading');
  release();
  await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
  expect(screen.getByTestId('box0').textContent).toBe('true');
  expect(seen).not.toContain('error');
});
