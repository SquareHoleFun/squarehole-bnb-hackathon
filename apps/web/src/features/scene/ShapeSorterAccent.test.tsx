import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShapeSorterAccent } from './index';
import { VISIBLE_ENV, createHarness, flushAsync, type Harness } from './testing';

afterEach(cleanup);

function root(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

async function goLive(h: Harness): Promise<void> {
  await act(async () => {
    h.runIdle();
    h.setInView(true);
    await flushAsync();
  });
}

describe('ShapeSorterAccent', () => {
  it('renders the decorative poster immediately in a fixed aspect-ratio box, before any import', () => {
    const h = createHarness();
    const { container } = render(<ShapeSorterAccent variant="pin" deps={h.deps} />);
    const el = root(container);
    expect(el.style.aspectRatio).toBe('36 / 17');
    expect(el.dataset.scenePhase).toBe('poster');
    const img = container.querySelector('img');
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.getAttribute('width')).toBe('720');
    expect(img?.getAttribute('height')).toBe('340');
    expect(img?.getAttribute('src')).toMatch(/shape-sorter-pin.*\.webp/);
    expect(img?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(h.loadScene).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('uses the wizard ratio and poster for the creation preview', () => {
    const h = createHarness();
    const { container } = render(<ShapeSorterAccent variant="wizard" deps={h.deps} className="extra" />);
    expect(root(container).style.aspectRatio).toBe('4 / 3');
    expect(root(container).classList.contains('extra')).toBe(true);
    expect(container.querySelector('img')?.getAttribute('src')).toMatch(/shape-sorter-wizard.*\.webp/);
  });

  it('reduced motion: never imports the scene, keeps the poster, offers no replay', async () => {
    const h = createHarness({ ...VISIBLE_ENV, reducedMotion: true });
    const { container } = render(<ShapeSorterAccent variant="pin" deps={h.deps} />);
    await goLive(h);
    expect(h.loadScene).not.toHaveBeenCalled();
    expect(root(container).dataset.scenePhase).toBe('fallback');
    expect(root(container).dataset.sceneReason).toBe('reduced-motion');
    expect(container.querySelector('img')).not.toBeNull();
    expect(container.querySelector('canvas')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('data saver: never imports the scene', async () => {
    const h = createHarness({ ...VISIBLE_ENV, saveData: true });
    render(<ShapeSorterAccent variant="pin" deps={h.deps} />);
    await goLive(h);
    expect(h.loadScene).not.toHaveBeenCalled();
  });

  it('WebGL failure: the poster remains', async () => {
    const h = createHarness();
    h.probeContext.mockReturnValue({ ok: false, reason: 'context-failed' });
    const { container } = render(<ShapeSorterAccent variant="pin" deps={h.deps} />);
    await goLive(h);
    expect(h.loadScene).not.toHaveBeenCalled();
    expect(root(container).dataset.sceneReason).toBe('context-failed');
    expect(container.querySelector('img')?.dataset.hidden).toBeUndefined();
  });

  it('live: hidden canvas, poster swapped out, keyboard-reachable Replay restarts the sequence', async () => {
    const h = createHarness();
    const { container } = render(<ShapeSorterAccent variant="pin" deps={h.deps} />);
    await goLive(h);
    expect(root(container).dataset.scenePhase).toBe('live');
    const canvas = container.querySelector('canvas');
    expect(canvas?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(container.querySelector('img')?.dataset.hidden).toBe('true');

    const replay = screen.getByRole('button', { name: /replay/i });
    expect(replay.getAttribute('type')).toBe('button');
    expect(replay.closest('[aria-hidden="true"]')).toBeNull();
    replay.focus();
    expect(document.activeElement).toBe(replay);

    act(() => h.scene().settle({ frames: 170, sequenceFrames: 168 }));
    expect(root(container).dataset.sceneSettled).toBe('true');
    expect(root(container).dataset.sceneFrames).toBe('168');
    fireEvent.click(replay);
    expect(h.scene().play).toHaveBeenCalledTimes(2);
    expect(root(container).dataset.sceneSettled).toBe('false');
  });

  it('reports lifecycle changes', async () => {
    const h = createHarness();
    const onStatusChange = vi.fn();
    render(<ShapeSorterAccent variant="pin" deps={h.deps} onStatusChange={onStatusChange} />);
    await goLive(h);
    expect(onStatusChange.mock.calls.map(([s]) => s.phase)).toEqual(['poster', 'loading', 'live']);
  });

  it('unmount disposes the scene and removes the canvas', async () => {
    const h = createHarness();
    const { container, unmount } = render(<ShapeSorterAccent variant="pin" deps={h.deps} />);
    await goLive(h);
    const canvas = container.querySelector('canvas');
    unmount();
    expect(h.scene().dispose).toHaveBeenCalledTimes(1);
    expect(canvas?.isConnected).toBe(false);
    expect(h.listenerCount()).toBe(0);
  });

  it('never implies a transaction or holds essential text (UI-08)', async () => {
    const h = createHarness();
    const { container } = render(<ShapeSorterAccent variant="pin" deps={h.deps} />);
    await goLive(h);
    const text = container.textContent ?? '';
    expect(text.trim()).toBe('Replay');
    expect(text).not.toMatch(/confirm|success|launched|buy|sell|swap|transaction|complete/i);
  });
});
