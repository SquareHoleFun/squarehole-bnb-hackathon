import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_KEY,
  applyMotionPreference,
  parsePreferences,
  readPreferences,
  resetPreferences,
  savePreferences,
  subscribePreferences,
} from './preferences';

afterEach(() => {
  vi.restoreAllMocks();
  resetPreferences();
  window.localStorage.clear();
  delete document.documentElement.dataset.motion;
});

describe('parsePreferences (untrusted stored text)', () => {
  it.each([null, '', 'not json', '[]', '"reduce"', '{"motion":"sideways","searchShortcut":"yes"}'])('falls back to the defaults for %j', (raw) => {
    expect(parsePreferences(raw)).toEqual(DEFAULT_PREFERENCES);
  });

  it('keeps valid fields and ignores unknown ones', () => {
    expect(parsePreferences('{"motion":"reduce","theme":"light","__proto__":{"x":1}}')).toEqual({ motion: 'reduce', searchShortcut: true });
    expect(parsePreferences('{"searchShortcut":false}')).toEqual({ motion: 'allow', searchShortcut: false });
  });
});

describe('guarded localStorage', () => {
  it('starts at the defaults, saves to one versioned key and reads back the same object', () => {
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
    expect(savePreferences({ motion: 'reduce', searchShortcut: false })).toBe('saved');
    expect(JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) ?? 'null')).toEqual({ motion: 'reduce', searchShortcut: false });
    expect(readPreferences()).toBe(readPreferences());
    expect(readPreferences()).toEqual({ motion: 'reduce', searchShortcut: false });
  });

  it('a blocked write still applies for this tab and reports not_saved; a later good write wins', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(savePreferences({ motion: 'reduce', searchShortcut: true })).toBe('not_saved');
    expect(readPreferences().motion).toBe('reduce');
    setItem.mockRestore();
    expect(savePreferences({ motion: 'allow', searchShortcut: false })).toBe('saved');
    expect(readPreferences()).toEqual({ motion: 'allow', searchShortcut: false });
  });

  it('a throwing read gives the defaults instead of an error', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('notifies subscribers on save, reset and a change from another tab', () => {
    const listener = vi.fn();
    const off = subscribePreferences(listener);
    savePreferences({ motion: 'reduce', searchShortcut: true });
    resetPreferences();
    window.localStorage.setItem(PREFERENCES_KEY, '{"searchShortcut":false}');
    window.dispatchEvent(new StorageEvent('storage', { key: PREFERENCES_KEY }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }));
    expect(listener).toHaveBeenCalledTimes(3);
    expect(readPreferences().searchShortcut).toBe(false);
    off();
  });

  it('applyMotionPreference toggles data-motion on the root element', () => {
    applyMotionPreference({ motion: 'reduce', searchShortcut: true });
    expect(document.documentElement.dataset.motion).toBe('reduce');
    applyMotionPreference(DEFAULT_PREFERENCES);
    expect(document.documentElement.dataset.motion).toBeUndefined();
  });
});
