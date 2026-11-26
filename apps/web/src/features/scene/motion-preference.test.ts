/** Settings "Reduce motion" (SH-014 settings) gates the decorative scene exactly like the system setting (UI-07). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetPreferences, savePreferences } from '../settings';
import { defaultSceneDeps, sceneEnvironmentWithPreferences } from './deps';
import { staticBlockReason } from './gate';

afterEach(() => {
  resetPreferences();
  window.localStorage.clear();
});

describe('scene gate + motion preference', () => {
  it('"Reduce motion" counts as reduced motion, so the poster stays (no three.js download)', () => {
    expect(sceneEnvironmentWithPreferences(window).reducedMotion).toBe(false);
    savePreferences({ motion: 'reduce', searchShortcut: true });
    const env = sceneEnvironmentWithPreferences(window);
    expect(env.reducedMotion).toBe(true);
    expect(staticBlockReason(env)).toBe('reduced-motion');
  });

  it('switching to "Reduce motion" while a scene is mounted tells it to fall back', () => {
    const deps = defaultSceneDeps(window);
    const callback = vi.fn();
    const off = deps.onReducedMotionChange(callback);
    savePreferences({ motion: 'allow', searchShortcut: false });
    expect(callback).not.toHaveBeenCalled();
    savePreferences({ motion: 'reduce', searchShortcut: false });
    expect(callback).toHaveBeenCalledWith(true);
    off();
    callback.mockClear();
    savePreferences({ motion: 'reduce', searchShortcut: true });
    expect(callback).not.toHaveBeenCalled();
  });
});
