import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { TERMS_GATE } from '../legal';
import { acceptTermsForTests } from '../../test-support/terms';
import { EXAMPLES_PAGE, EXAMPLES_PATH, examplesNavigation, examplesPageFor } from './examples-page';

// SH-252: the app's /examples hands the visit over to the explainer's own page (apps/web/public/examples/index.html),
// through the production router as on the site. jsdom cannot leave its document: the one way out is spied on.

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  acceptTermsForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('/examples (SH-252)', () => {
  it('opens the explainer’s page in place of the app, once, with the app’s loader and the site’s own “Loading…” meanwhile', async () => {
    const go = vi.spyOn(examplesNavigation, 'go').mockImplementation(() => undefined);
    window.history.replaceState(null, '', EXAMPLES_PATH);
    render(<App />);
    await waitFor(() => expect(go).toHaveBeenCalledWith('/examples/index.html'));
    expect(go).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(EXAMPLES_PATH).toBe('/examples');
  });

  it('keeps the place a link names, and takes the folder address with its slash as well', async () => {
    const go = vi.spyOn(examplesNavigation, 'go').mockImplementation(() => undefined);
    window.history.replaceState(null, '', '/examples/#rent-free');
    render(<App />);
    await waitFor(() => expect(go).toHaveBeenCalledWith('/examples/index.html#rent-free'));
  });

  it('a first visit meets the entry terms gate first, as on every route: nothing is opened behind it', async () => {
    const go = vi.spyOn(examplesNavigation, 'go').mockImplementation(() => undefined);
    window.localStorage.clear();
    window.history.replaceState(null, '', EXAMPLES_PATH);
    render(<App />);
    expect(screen.getByRole('dialog', { name: TERMS_GATE.title })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(go).not.toHaveBeenCalled();
  });

  it('passes on only a plain place name, never anything that could lead elsewhere', () => {
    expect(EXAMPLES_PAGE).toBe('/examples/index.html');
    expect(examplesPageFor('')).toBe(EXAMPLES_PAGE);
    expect(examplesPageFor('#basics')).toBe('/examples/index.html#basics');
    expect(examplesPageFor('#how-it-works-1')).toBe('/examples/index.html#how-it-works-1');
    for (const hash of ['#', '#1', '#a b', '#a"b', '#//elsewhere.example', '#a/../b', `#${'a'.repeat(65)}`]) expect(examplesPageFor(hash), hash).toBe(EXAMPLES_PAGE);
  });
});
