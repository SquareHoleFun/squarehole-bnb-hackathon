/** The logo loader (F51): sizes, the spoken label, decorative use, reduced motion and the waiting mode. */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { resetPreferences, savePreferences, DEFAULT_PREFERENCES } from '../settings';
import { LOADER_PX, Loader, type LoaderSize } from './Loader';

/** A controllable `prefers-reduced-motion` (jsdom has no matchMedia). */
function systemMotion(reduce: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: reduce,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => query });
  return {
    set(next: boolean) {
      query.matches = next;
      act(() => listeners.forEach((listener) => listener()));
    },
  };
}

afterEach(() => {
  cleanup();
  resetPreferences();
  window.localStorage.clear();
  Reflect.deleteProperty(window, 'matchMedia');
});

const loaderIn = (root: ParentNode) => root.querySelector<HTMLElement>('.sh-loader');
const shapes = (root: ParentNode) => [...root.querySelectorAll('.sh-loader__shape')].map((layer) => layer.getAttribute('data-shape'));

describe('Loader', () => {
  it('on its own it is a status that says "Loading", with no visible text', () => {
    render(<Loader />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Loading');
    expect(status.querySelector('.sh-visually-hidden')?.textContent).toBe('Loading');
    expect(status.getAttribute('data-size')).toBe('inline');
    // The drawings themselves are never read out.
    for (const layer of status.querySelectorAll('svg')) expect(layer.getAttribute('aria-hidden')).toBe('true');
    expect(status.querySelector('title, text')).toBeNull();
  });

  it('takes a label for what is being waited for', () => {
    render(<Loader size="card" label="Reading the vault" />);
    expect(screen.getByRole('status').textContent).toBe('Reading the vault');
  });

  it('is hidden from screen readers when visible text beside it already says it', () => {
    const { container } = render(
      <p role="status">
        <Loader size="button" decorative />
        Reading the pool…
      </p>,
    );
    const loader = loaderIn(container);
    expect(loader?.getAttribute('aria-hidden')).toBe('true');
    expect(loader?.getAttribute('role')).toBeNull();
    expect(loader?.textContent).toBe('');
    // The one status is the line itself.
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('Reading the pool…');
  });

  it('has four fixed sizes: 16, 24, 48 and 160 px', () => {
    expect(LOADER_PX).toEqual({ button: 16, inline: 24, card: 48, page: 160 });
    for (const size of Object.keys(LOADER_PX) as LoaderSize[]) {
      const { container, unmount } = render(<Loader size={size} />);
      expect(loaderIn(container)?.getAttribute('data-size')).toBe(size);
      unmount();
    }
  });

  it('card and page: the five shapes drop into the master mark in turn, the hole flashes', () => {
    const { container } = render(<Loader size="page" />);
    expect(shapes(container)).toEqual(['cube', 'ball', 'pyramid', 'star', 'heart']);
    expect(container.querySelectorAll('.sh-loader__flash')).toHaveLength(1);
    expect(container.querySelectorAll('.sh-loader__glow')).toHaveLength(1);
    // Every layer shares the master's box (256 tile + 48 units of room), so the keyframes work at any size.
    for (const layer of container.querySelectorAll('svg')) expect(layer.getAttribute('viewBox')).toBe('-48 -48 352 352');
  });

  it('button and inline: the brand’s 16 and 24 px drawings, only the glow breathes', () => {
    for (const [size, px] of [['button', 16], ['inline', 24]] as const) {
      const { container, unmount } = render(<Loader size={size} />);
      expect(shapes(container)).toEqual([]);
      expect(container.querySelector('.sh-loader__flash')).toBeNull();
      expect(container.querySelectorAll('.sh-loader__glow')).toHaveLength(1);
      for (const layer of container.querySelectorAll('svg')) expect(layer.getAttribute('viewBox')).toBe(`0 0 ${px} ${px}`);
      unmount();
    }
  });

  it('gives each loader its own gradient ids, and every reference points inside its own layer', () => {
    const { container } = render(
      <>
        <Loader size="card" />
        <Loader size="page" />
      </>,
    );
    const ids = [...container.querySelectorAll('[id]')].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    for (const layer of container.querySelectorAll('svg')) {
      const refs = [...layer.innerHTML.matchAll(/url\(#([^)]+)\)/g)].map((match) => match[1] ?? '');
      for (const ref of refs) expect(layer.querySelector(`[id="${ref}"]`), ref).not.toBeNull();
    }
  });
});

describe('Loader: reduced motion', () => {
  it('the system setting leaves the still mark: no shapes, no flash, still announced', () => {
    systemMotion(true);
    const { container } = render(<Loader size="page" />);
    const loader = loaderIn(container);
    expect(loader?.getAttribute('data-motion')).toBe('reduce');
    expect(shapes(container)).toEqual([]);
    expect(container.querySelector('.sh-loader__flash')).toBeNull();
    // The glow is part of the mark, so it stays (still, at full strength).
    expect(container.querySelectorAll('.sh-loader__glow')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('Loading');
  });

  it('small sizes drop the breathing layer and show the exported drawing as it is', () => {
    systemMotion(true);
    const { container } = render(<Loader size="button" />);
    expect(container.querySelector('.sh-loader__glow')).toBeNull();
    expect(container.querySelectorAll('svg')).toHaveLength(1);
  });

  it('follows the system setting while the page is open', () => {
    const system = systemMotion(false);
    const { container } = render(<Loader size="card" />);
    expect(loaderIn(container)?.getAttribute('data-motion')).toBe('allow');
    expect(shapes(container)).toHaveLength(5);
    system.set(true);
    expect(loaderIn(container)?.getAttribute('data-motion')).toBe('reduce');
    expect(shapes(container)).toEqual([]);
  });

  it('the saved "Reduce motion" choice does the same', () => {
    const { container } = render(<Loader size="card" />);
    expect(shapes(container)).toHaveLength(5);
    act(() => void savePreferences({ ...DEFAULT_PREFERENCES, motion: 'reduce' }));
    expect(loaderIn(container)?.getAttribute('data-motion')).toBe('reduce');
    expect(shapes(container)).toEqual([]);
  });
});

describe('Loader: waiting', () => {
  it('shows one label (announced) and an optional status line (not announced on every change)', () => {
    const { container } = render(<Loader mode="waiting" label="Waiting for the random number" status="About 0:20" />);
    const wait = container.querySelector('.sh-loader-wait') as HTMLElement;
    expect(wait.getAttribute('data-size')).toBe('page');
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Waiting for the random number');
    expect(within(status).queryByText('About 0:20')).toBeNull();
    expect(wait.querySelector('.sh-loader-wait__line')?.textContent).toBe('About 0:20');
    // The mark inside is decorative: the label is what is read.
    expect(loaderIn(wait)?.getAttribute('aria-hidden')).toBe('true');
    expect(loaderIn(wait)?.getAttribute('data-size')).toBe('page');
  });

  it('leaves the status line out when there is none, and comes in a card size', () => {
    const { container } = render(<Loader mode="waiting" size="card" label="Reading your claims…" status={null} />);
    expect(container.querySelector('.sh-loader-wait__line')).toBeNull();
    expect(loaderIn(container)?.getAttribute('data-size')).toBe('card');
    expect(screen.getByRole('status').textContent).toBe('Reading your claims…');
  });
});
