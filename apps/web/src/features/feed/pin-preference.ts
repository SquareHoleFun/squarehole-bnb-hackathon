/**
 * "Collapse the platform pin" is a remembered per-viewer convenience (03-FEED). Storage can be missing or throw
 * (private windows, blocked site data), so every access is guarded and the pin simply starts expanded.
 */
export const PIN_COLLAPSED_KEY = 'squarehole.feed.pinCollapsed';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readPinCollapsed(): boolean {
  try {
    return storage()?.getItem(PIN_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writePinCollapsed(collapsed: boolean): void {
  try {
    storage()?.setItem(PIN_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Not remembered this time; the pin still toggles.
  }
}
