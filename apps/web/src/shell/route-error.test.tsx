import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../app-providers';
import { PageHeading } from '../pages/page-parts';
import { lazyRoute } from './lazy-route';
import { Shell } from './Shell';

// A page that throws while rendering (SH-BOX-CREATE review: a spec that did not encode blanked the whole app) shows a
// message with a heading; the shell and the other routes keep working.

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  // React reports a caught render error to the console; keep the test output quiet.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function Broken(): never {
  throw new Error('Number "20964979273" is not in safe 32-bit unsigned integer range');
}

function Fine() {
  return (
    <section>
      <PageHeading>Fine page</PageHeading>
    </section>
  );
}

describe('a page that fails to render', () => {
  it('shows "This page hit a problem" with a heading, and the next route renders normally', async () => {
    render(
      <AppProviders>
        <MemoryRouter initialEntries={['/broken']}>
          <Routes>
            <Route element={<Shell />}>
              <Route path="broken" element={lazyRoute(Broken, 'the broken page', {})} />
              <Route path="fine" element={lazyRoute(Fine, 'the fine page', {})} />
            </Route>
          </Routes>
          <Link to="/fine">Go on</Link>
        </MemoryRouter>
      </AppProviders>,
    );
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('This page hit a problem');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to the boxes' }).getAttribute('href')).toBe('/');
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'Go on' })));
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Fine page');
  });
});
