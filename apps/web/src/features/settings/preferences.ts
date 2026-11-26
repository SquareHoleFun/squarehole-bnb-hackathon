/**
 * Local preferences (01-PRODUCT `/settings`: data provider, motion and theme; WCAG 2.1.4 character-key shortcuts).
 *
 * One versioned key per browser. Storage can be missing or throw (private windows, blocked site data, a full quota),
 * so every access is guarded: a failed save still applies for this tab, and `savePreferences` says it was not saved.
 * Values read back are validated field by field; anything unknown falls back to the default, never to a guess.
 */
import { useSyncExternalStore } from 'react';

export type MotionPreference = 'allow' | 'reduce';

export interface Preferences {
  /** `allow`: animations and transitions may play (the system reduced-motion setting still wins). `reduce`: static art, no animation. */
  readonly motion: MotionPreference;
  /** The single-key "/" shortcut that opens search (WCAG 2.1.4: it can be turned off). */
  readonly searchShortcut: boolean;
}

export type SaveResult = 'saved' | 'not_saved';

export const PREFERENCES_KEY = 'squarehole.settings.v1';

export const DEFAULT_PREFERENCES: Preferences = Object.freeze({ motion: 'allow', searchShortcut: true });

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validated preferences from a stored string (or null); malformed JSON or fields fall back to the defaults. */
export function parsePreferences(raw: string | null): Preferences {
  if (raw === null) return DEFAULT_PREFERENCES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFERENCES;
  }
  if (!isRecord(parsed)) return DEFAULT_PREFERENCES;
  return Object.freeze({
    motion: parsed.motion === 'reduce' || parsed.motion === 'allow' ? parsed.motion : DEFAULT_PREFERENCES.motion,
    searchShortcut: typeof parsed.searchShortcut === 'boolean' ? parsed.searchShortcut : DEFAULT_PREFERENCES.searchShortcut,
  });
}

// A choice that could not be written wins over storage until a later save succeeds (it is newer).
let unsaved: Preferences | null = null;
// Parsed value per raw string, so repeated reads return the same object (useSyncExternalStore needs stable snapshots).
let cache: { readonly raw: string | null; readonly value: Preferences } | null = null;
const listeners = new Set<() => void>();

function readRaw(): string | null {
  try {
    return storage()?.getItem(PREFERENCES_KEY) ?? null;
  } catch {
    return null;
  }
}

export function readPreferences(): Preferences {
  if (unsaved !== null) return unsaved;
  const raw = readRaw();
  if (cache !== null && cache.raw === raw) return cache.value;
  const value = parsePreferences(raw);
  cache = { raw, value };
  return value;
}

function notify(): void {
  [...listeners].forEach((listener) => listener());
}

/** Saves and applies the whole preference set. `not_saved` when storage refused it (it still applies in this tab). */
export function savePreferences(next: Preferences): SaveResult {
  const value = parsePreferences(JSON.stringify(next));
  let result: SaveResult = 'not_saved';
  try {
    const target = storage();
    if (target !== null) {
      target.setItem(PREFERENCES_KEY, JSON.stringify(value));
      result = 'saved';
    }
  } catch {
    result = 'not_saved';
  }
  unsaved = result === 'saved' ? null : value;
  notify();
  return result;
}

/** Back to the defaults (removes the stored key). */
export function resetPreferences(): SaveResult {
  let result: SaveResult = 'not_saved';
  try {
    const target = storage();
    if (target !== null) {
      target.removeItem(PREFERENCES_KEY);
      result = 'saved';
    }
  } catch {
    result = 'not_saved';
  }
  unsaved = result === 'saved' ? null : DEFAULT_PREFERENCES;
  notify();
  return result;
}

function onStorage(event: StorageEvent): void {
  if (event.key === null || event.key === PREFERENCES_KEY) notify();
}

/** Also follows changes made in another tab (the `storage` event). */
export function subscribePreferences(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribePreferences, readPreferences, () => DEFAULT_PREFERENCES);
}

/** `data-motion="reduce"` on the root element: the CSS in settings.css then removes transitions and animations. */
export function applyMotionPreference(preferences: Preferences, root: HTMLElement = document.documentElement): void {
  if (preferences.motion === 'reduce') root.dataset.motion = 'reduce';
  else delete root.dataset.motion;
}

/** Whether the operating system asks for reduced motion (independent of the preference). */
export function systemPrefersReducedMotion(win: Window = window): boolean {
  try {
    return typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
