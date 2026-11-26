import { afterEach, describe, expect, it, vi } from 'vitest';
import { PIN_COLLAPSED_KEY, readPinCollapsed, writePinCollapsed } from './pin-preference';

afterEach(() => {
  vi.restoreAllMocks();
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
});

describe('pin collapse preference (per-viewer convenience, 03-FEED)', () => {
  it('defaults to expanded and remembers a collapse', () => {
    expect(readPinCollapsed()).toBe(false);
    writePinCollapsed(true);
    expect(window.localStorage.getItem(PIN_COLLAPSED_KEY)).toBe('1');
    expect(readPinCollapsed()).toBe(true);
    writePinCollapsed(false);
    expect(readPinCollapsed()).toBe(false);
  });

  it('ignores unexpected stored values', () => {
    window.localStorage.setItem(PIN_COLLAPSED_KEY, 'yes please');
    expect(readPinCollapsed()).toBe(false);
  });

  it('survives storage that throws (private mode, blocked site data)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(readPinCollapsed()).toBe(false);
    expect(() => writePinCollapsed(true)).not.toThrow();
  });
});
