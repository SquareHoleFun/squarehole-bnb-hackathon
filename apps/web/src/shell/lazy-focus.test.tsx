import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { lazy } from 'react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../app-providers';
import { PageHeading } from '../pages/page-parts';
import { lazyRoute } from './lazy-route';
import { Shell } from './Shell';

// Focus after a client-side page change to a lazy page that has not loaded yet (WCAG 2.4.3): the Shell's route-change
// effect runs while the Suspense fallback is on screen, so the page takes the focus request over once it has rendered.

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function Plain() {
  return (
    <section>
      <PageHeading>Plain page</PageHeading>
      <Link to="/slow">Go to the slow page</Link>
      <Link to="/other">Go to the other page</Link>
    </section>
  );
}

function Other() {
  return (
    <section>
      <PageHeading>Other page</PageHeading>
    </section>
  );
}

function FirstLazy() {
  return (
    <section>
      <PageHeading>First lazy page</PageHeading>
      <Link to="/slow">Go on to the slow page</Link>
    </section>
  );
}

function renderWith(slow: ReturnType<typeof lazy>, start = '/plain') {
  render(
    <AppProviders>
      <MemoryRouter initialEntries={[start]}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="plain" element={<Plain />} />
            <Route path="other" element={<Other />} />
            <Route path="settings" element={<Other />} />
            <Route path="first" element={lazyRoute(FirstLazy, 'the first lazy page', {})} />
            <Route path="slow" element={lazyRoute(slow, 'the slow page', {})} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('focus after navigating to a lazy page', () => {
  it('moves to the new page’s heading once its chunk has loaded', async () => {
    let load: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      load = resolve;
    });
    const Slow = lazy(() => gate.then(() => ({ default: () => <PageHeading>Slow page</PageHeading> })));
    renderWith(Slow);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'Go to the slow page' })));
    expect(screen.getByText('Loading the slow page…')).toBeTruthy();
    expect(document.activeElement?.tagName).not.toBe('H1');
    await act(async () => {
      load();
      await gate;
    });
    const heading = await screen.findByRole('heading', { level: 1, name: 'Slow page' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('from one lazy page to another: never the old, hidden heading, then the new heading once loaded', async () => {
    let load: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      load = resolve;
    });
    const Slow = lazy(() => gate.then(() => ({ default: () => <PageHeading>Slow page</PageHeading> })));
    renderWith(Slow, '/first');
    const link = await screen.findByRole('link', { name: 'Go on to the slow page' });
    await act(async () => fireEvent.click(link));
    expect(screen.getByText('Loading the slow page…')).toBeTruthy();
    // The first page is gone, not hidden behind the loader with a heading the Shell could "focus".
    expect(screen.queryByText('First lazy page')).toBeNull();
    await act(async () => {
      load();
      await gate;
    });
    const heading = await screen.findByRole('heading', { level: 1, name: 'Slow page' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('leaving before the chunk has loaded focuses the next page’s heading at once', async () => {
    const never = new Promise<{ default: () => null }>(() => undefined);
    const Slow = lazy(() => never);
    renderWith(Slow);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'Go to the slow page' })));
    expect(screen.getByText('Loading the slow page…')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('navigation', { name: 'Primary' }).querySelector('a[href="/settings"]') as HTMLElement));
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Other page' }));
  });
});
