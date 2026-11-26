/**
 * SH-246 (finding 11.3): a part of a page whose script fails to load says so in one line with Reload; while it still
 * loads nothing changes; a part that loads shows as before.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Suspense, lazy, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AppProviders } from '../app-providers';
import { LiveLine, PART_WORDS, PartBoundary, PartFailed } from './PartFailed';

const CHUNK_ERROR = 'Failed to fetch dynamically imported module: /assets/TradeSlot-old.js';

beforeEach(() => {
  // React reports a caught error to the console; keep the output quiet.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Part() {
  return <p>The part</p>;
}

/** A lazily loaded part and the hand that settles its import. */
function lazyPart() {
  let settle: { resolve: (module: { default: ComponentType }) => void; reject: (error: Error) => void } = { resolve: () => undefined, reject: () => undefined };
  const imported = new Promise<{ default: ComponentType }>((resolve, reject) => { settle = { resolve, reject }; });
  return { Lazy: lazy(() => imported), settle: () => settle };
}

function mount(Lazy: ComponentType, onReload: () => void) {
  render(
    <section>
      <h1>Page</h1>
      <PartBoundary fallback={<PartFailed line={PART_WORDS.part} onReload={onReload} />}>
        <Suspense fallback={null}><Lazy /></Suspense>
      </PartBoundary>
    </section>,
  );
}

describe('a part that loads on its own', () => {
  it('while its script loads: nothing in its place, no message (as before)', async () => {
    const { Lazy } = lazyPart();
    mount(Lazy, () => undefined);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('heading', { name: 'Page' })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.querySelector('[data-part]')).toBeNull();
  });

  it('its script loaded: the part, no message', async () => {
    const { Lazy, settle } = lazyPart();
    mount(Lazy, () => undefined);
    await act(async () => { settle().resolve({ default: Part }); });
    expect(await screen.findByText('The part')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('its script failed to load: one line and Reload in its place; the page stays; Reload loads the page again', async () => {
    const reload = vi.fn();
    const { Lazy, settle } = lazyPart();
    mount(Lazy, reload);
    await act(async () => { settle().reject(new TypeError(CHUNK_ERROR)); });
    expect(await screen.findByText('This part of the page hit a problem.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('This part of the page hit a problem.');
    expect(screen.getByRole('heading', { name: 'Page' })).toBeTruthy();
    expect(screen.queryByText('The part')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a part that throws while drawing (loaded, then failed): the same line, true here too, never a blank page', async () => {
    function Broken(): never {
      throw new Error('render failed');
    }
    mount(Broken, () => undefined);
    expect(await screen.findByText(PART_WORDS.part)).toBeTruthy();
    expect(PART_WORDS.part).toBe('This part of the page hit a problem.');
    expect(screen.getByRole('heading', { name: 'Page' })).toBeTruthy();
  });

  it('the line is a live region React renders empty, its words put in after it is on the page; Reload outside it (review L2)', async () => {
    // What React itself puts on the page: the region, with no words yet.
    expect(renderToStaticMarkup(<PartFailed line={PART_WORDS.part} />)).toBe('<div class="sh-panel sh-part-failed" data-part="failed"><p role="status"></p><button type="button" class="sh-button">Reload</button></div>');
    function Broken(): never {
      throw new Error('render failed');
    }
    mount(Broken, () => undefined);
    await screen.findByText(PART_WORDS.part);
    const region = screen.getByRole('status');
    expect(region.textContent).toBe(PART_WORDS.part);
    expect(region.querySelector('button')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reload' }).closest('[role="status"]')).toBeNull();
  });

  it('LiveLine mounts empty and takes its text right after', async () => {
    render(<LiveLine text="Some words." />);
    expect(await screen.findByText('Some words.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Some words.');
  });
});

/**
 * The two mounts in a build that carries them cannot be rendered here: their doors sit behind a build literal vitest
 * never defines as `true` (vi.stubEnv makes every value a string), and build-target.test.ts pins those door lines byte
 * for byte. Their wiring is pinned here instead, and the browser suites load them for real in the Sepolia build and
 * make their chunk fail (e2e/production/production-load-failures.spec.ts, e2e/sepolia-readonly/load-failures.spec.ts).
 */
describe('the two mounts that load a part on their own', () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

  it('the trade slot on a v2 box page: the boundary with the part line, Suspense showing nothing while it loads', () => {
    const mount = read('../features/core/v2/TradeSlotMount.tsx');
    expect(mount).toContain('<PartBoundary fallback={<PartFailed line={PART_WORDS.part} />}><Suspense fallback={null}><TradeSlot {...props} /></Suspense></PartBoundary>');
    expect(mount).not.toMatch(/Component|getDerivedStateFromError/);
  });

  it('the setup step above every page: the boundary with its own line, behind the same build literal as its door', () => {
    const mount = read('./AlphaWelcomeMount.tsx');
    expect(mount).toContain("const WELCOME_FAILED = import.meta.env?.SH_SEPOLIA_TRADE === true ? 'The setup step hit a problem.' : null;");
    expect(mount).toContain('<PartBoundary fallback={<PartFailed line={WELCOME_FAILED} />}><Suspense fallback={null}><AlphaWelcome me={gate.me} /></Suspense></PartBoundary>');
    expect(mount).not.toMatch(/Component|getDerivedStateFromError/);
  });

  it('a build without the trade code (this one): the slot mount renders nothing', async () => {
    const { TradeSlotMount, TRADE_IN_BUILD } = await import('../features/core/v2/TradeSlotMount');
    expect(TRADE_IN_BUILD).toBe(false);
    const { container } = render(<TradeSlotMount {...({} as Parameters<typeof TradeSlotMount>[0])} />);
    expect(container.innerHTML).toBe('');
  });

  it('a build without the trade code (this one): the setup step mount renders nothing either, the notice accepted', async () => {
    const { AlphaWelcomeMount } = await import('./AlphaWelcomeMount');
    const { container } = render(<AppProviders><MemoryRouter><div data-testid="mount"><AlphaWelcomeMount /></div></MemoryRouter></AppProviders>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.querySelector('[data-testid="mount"]')?.innerHTML).toBe('');
  });
});
