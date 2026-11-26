/** /settings: data source (SH-C), motion, the "/" shortcut (WCAG 2.1.4) and dark-only theme; guarded storage. */
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREFERENCES_KEY, resetPreferences } from '../features/settings';
import { flush, location, main, renderM3 } from '../test-support/m3';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetPreferences();
  window.localStorage.clear();
  delete document.documentElement.dataset.motion;
});

async function open(path = '/settings') {
  renderM3(path);
  await flush();
}

const stored = () => JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) ?? 'null') as unknown;

describe('/settings', () => {
  it('offers the three data sources (the sample data in use; the local chain and Sepolia disabled with their reasons) and the dark-only theme', async () => {
    await open();
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    const data = screen.getByRole('group', { name: 'Data source' });
    const radios = within(data).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((radio) => [radio.value, radio.checked, radio.disabled])).toEqual([
      ['demo', true, false],
      ['local', false, true],
      ['sepolia', false, true],
    ]);
    // F130: the sample data's one name, "Sample data"; no Demo, mock or test word for it.
    expect(within(data).getByRole('radio', { name: /^Sample data/ })).toBeTruthy();
    expect(data.textContent).not.toMatch(/\b(demo|mock)\b/i);
    expect(data.textContent).toContain('No local deployment in this build. Run `pnpm dev:local`');
    expect(data.textContent).toContain('Not deployed yet: Square Hole has no Sepolia deployment');
    expect(data.textContent).toContain('never decides balances or claims');
    expect(within(data).queryAllByRole('textbox')).toEqual([]);
    const theme = screen.getByRole('heading', { level: 2, name: 'Theme' }).closest('section') as HTMLElement;
    expect(theme.textContent).toContain('Dark only.');
    expect(within(theme).queryAllByRole('radio')).toEqual([]);
  });

  it('motion: "Reduce motion" sets data-motion on <html> and is saved; "Allow motion" removes it', async () => {
    await open();
    const group = screen.getByRole('group', { name: 'Motion' });
    const allow = within(group).getByRole('radio', { name: 'Allow motion' }) as HTMLInputElement;
    const reduce = within(group).getByRole('radio', { name: 'Reduce motion' }) as HTMLInputElement;
    expect(allow.checked).toBe(true);
    await act(async () => void fireEvent.click(reduce));
    await flush();
    expect(reduce.checked).toBe(true);
    expect(document.documentElement.dataset.motion).toBe('reduce');
    expect(stored()).toEqual({ motion: 'reduce', searchShortcut: true });
    expect(within(main()).getByRole('status').textContent).toBe('Saved on this device.');
    await act(async () => void fireEvent.click(allow));
    await flush();
    expect(document.documentElement.dataset.motion).toBeUndefined();
  });

  it('the "/" shortcut can be turned off (WCAG 2.1.4) and the header stops listening and advertising it', async () => {
    await open();
    const trigger = within(screen.getByRole('banner')).getByRole('button', { name: 'Search boxes' });
    expect(trigger.getAttribute('aria-keyshortcuts')).toBe('/');
    const toggle = within(main()).getByRole('checkbox', { name: 'Press / to search' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await act(async () => void fireEvent.click(toggle));
    await flush();
    expect(toggle.checked).toBe(false);
    expect(stored()).toEqual({ motion: 'allow', searchShortcut: false });
    expect(trigger.getAttribute('aria-keyshortcuts')).toBeNull();
    expect(trigger.querySelector('kbd')).toBeNull();
    await act(async () => void fireEvent.keyDown(document.body, { key: '/' }));
    await flush();
    expect(location()).toBe('/settings');
    // The button still works.
    await act(async () => void fireEvent.click(trigger));
    await flush();
    expect(location()).toBe('/');
  });

  it('with the shortcut on (default), "/" still opens the search', async () => {
    await open();
    await act(async () => void fireEvent.keyDown(document.body, { key: '/' }));
    await flush();
    expect(location()).toBe('/');
  });

  it('a saved choice is read back on the next visit', async () => {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ motion: 'reduce', searchShortcut: false }));
    await open();
    expect((within(main()).getByRole('radio', { name: 'Reduce motion' }) as HTMLInputElement).checked).toBe(true);
    expect((within(main()).getByRole('checkbox', { name: 'Press / to search' }) as HTMLInputElement).checked).toBe(false);
    expect(document.documentElement.dataset.motion).toBe('reduce');
  });

  it('blocked storage: the choice still applies in this tab, and the page says it was not saved', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    await open();
    await act(async () => void fireEvent.click(within(main()).getByRole('radio', { name: 'Reduce motion' })));
    await flush();
    expect(document.documentElement.dataset.motion).toBe('reduce');
    expect(within(main()).getByRole('status').textContent).toContain('Could not save on this device');
  });

  it('Reset to defaults clears the stored choice', async () => {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ motion: 'reduce', searchShortcut: false }));
    await open();
    await act(async () => void fireEvent.click(within(main()).getByRole('button', { name: 'Reset to defaults' })));
    await flush();
    expect(window.localStorage.getItem(PREFERENCES_KEY)).toBeNull();
    expect((within(main()).getByRole('radio', { name: 'Allow motion' }) as HTMLInputElement).checked).toBe(true);
    expect((within(main()).getByRole('checkbox', { name: 'Press / to search' }) as HTMLInputElement).checked).toBe(true);
  });

  it('has no text inputs and nothing that touches data or transactions', async () => {
    await open();
    expect(within(main()).queryAllByRole('textbox')).toEqual([]);
    expect(within(main()).queryAllByRole('spinbutton')).toEqual([]);
    expect(within(main()).getAllByRole('button').map((button) => button.textContent)).toEqual(['Reset to defaults']);
  });
});
