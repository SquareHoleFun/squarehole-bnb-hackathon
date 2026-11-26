import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { TERMS_GATE, TERMS_VERSION } from './terms';
import { termsReturnPath, useTermsAccess } from './terms-access';
import { TERMS_ACCEPTANCE_KEY, browserTermsEnv, createTermsAcceptanceStore, type TermsAcceptanceStore } from './terms-acceptance';
import { TermsGate } from './TermsGate';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.cookie = 'squarehole.terms=; Path=/; Max-Age=0';
});

function Page({ title, children }: { title: string; children?: ReactNode }) {
  const accepted = useTermsAccess();
  const back = termsReturnPath(useLocation().state);
  return (
    <main data-terms-access={accepted ? 'accepted' : 'restricted'} data-back={back ?? ''}>
      <h1 id="page-title" tabIndex={-1}>
        {title}
      </h1>
      <button type="button">Page action</button>
      {children}
    </main>
  );
}

/** The gate over a small route table, at `path`, with its own store (the browser env over jsdom unless given). */
function renderGate(path = '/', store: TermsAcceptanceStore = createTermsAcceptanceStore(TERMS_VERSION)) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <TermsGate store={store}>
        <Routes>
          <Route path="/" element={<Page title="Feed" />} />
          <Route
            path="/about/terms"
            element={
              <Page title="Terms page">
                <Link to="/">Back to the feed</Link>
              </Page>
            }
          />
          <Route path="/about/risks" element={<Page title="Risks page" />} />
          <Route path="/about/privacy" element={<Page title="Privacy page" />} />
          <Route path="*" element={<Page title="Not found" />} />
        </Routes>
      </TermsGate>
    </MemoryRouter>,
  );
  return store;
}

const dialog = () => screen.getByRole('dialog', { name: TERMS_GATE.title });
const checkbox = () => within(dialog()).getByRole('checkbox', { name: TERMS_GATE.checkbox }) as HTMLInputElement;
const acceptButton = () => within(dialog()).getByRole('button', { name: 'Accept' }) as HTMLButtonElement;
const declineButton = () => within(dialog()).getByRole('button', { name: 'Decline' });
const appContent = () => screen.queryByRole('main');

describe('entry terms gate (F19)', () => {
  it('blocks the app on first visit with a labelled, described modal dialog and focuses its heading', () => {
    renderGate('/');
    const gate = dialog();
    expect(gate.getAttribute('aria-modal')).toBe('true');
    const description = (gate.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent);
    // The draft status in words (not only the "Draft" chip), then the intro.
    expect(description).toEqual([TERMS_GATE.status, TERMS_GATE.intro]);
    expect(appContent()).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Feed' })).toBeNull();
    expect(document.activeElement).toBe(within(gate).getByRole('heading', { level: 1, name: TERMS_GATE.title }));
    for (const bullet of TERMS_GATE.bullets) expect(gate.textContent).toContain(bullet);
    expect(gate.textContent).toContain('anyone in or from the US, Canada or the UK');
    expect(within(gate).getByRole('link', { name: TERMS_GATE.fullTermsLink }).getAttribute('href')).toBe('/about/terms');
    // The summary is a focusable scroll region, so keyboard users can scroll it.
    expect(within(gate).getByRole('region', { name: 'Summary of the Terms of Use' }).tabIndex).toBe(0);
  });

  it('gates every route but the full Terms, About & risks and the privacy notice, including unknown routes', () => {
    renderGate('/no/such/page');
    expect(dialog()).toBeTruthy();
    expect(appContent()).toBeNull();
  });

  it('keeps Accept disabled until the box is ticked', () => {
    renderGate('/');
    expect(checkbox().checked).toBe(false);
    expect(acceptButton().disabled).toBe(true);
    fireEvent.click(checkbox());
    expect(acceptButton().disabled).toBe(false);
    fireEvent.click(checkbox());
    expect(acceptButton().disabled).toBe(true);
    fireEvent.click(acceptButton());
    expect(dialog()).toBeTruthy();
    expect(window.localStorage.getItem(TERMS_ACCEPTANCE_KEY)).toBeNull();
  });

  it('ignores Escape (the gate cannot be dismissed)', () => {
    renderGate('/');
    fireEvent.click(checkbox());
    fireEvent.keyDown(acceptButton(), { key: 'Escape' });
    expect(dialog()).toBeTruthy();
    expect(checkbox().checked).toBe(true);
    expect(appContent()).toBeNull();
  });

  it('Decline shows the decline message and a way back, stores nothing and never shows the app', () => {
    renderGate('/');
    fireEvent.click(checkbox());
    fireEvent.click(declineButton());
    const gate = dialog();
    expect(gate.textContent).toContain(TERMS_GATE.declined);
    expect(document.activeElement?.textContent).toBe(TERMS_GATE.declined);
    expect(within(gate).queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(within(gate).queryByRole('checkbox')).toBeNull();
    expect(appContent()).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(document.cookie).toBe('');

    fireEvent.click(within(gate).getByRole('button', { name: TERMS_GATE.reviewAgain }));
    expect(checkbox().checked).toBe(false);
    expect(acceptButton().disabled).toBe(true);
    expect(document.activeElement).toBe(within(dialog()).getByRole('heading', { level: 1, name: TERMS_GATE.title }));
  });

  it('Accept stores {version, acceptedAt}, lets the viewer in, moves focus to the page heading and survives a reload', () => {
    renderGate('/');
    fireEvent.click(checkbox());
    fireEvent.click(acceptButton());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Feed' })).toBe(document.activeElement);
    const stored = JSON.parse(window.localStorage.getItem(TERMS_ACCEPTANCE_KEY) ?? 'null') as { version: string; acceptedAt: string };
    expect(stored.version).toBe(TERMS_VERSION);
    expect(new Date(stored.acceptedAt).toISOString()).toBe(stored.acceptedAt);
    expect(window.localStorage.length).toBe(1);
    expect(document.cookie).toBe('');

    cleanup();
    renderGate('/');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Feed' })).toBeTruthy();
  });

  it('asks again when the Terms version changes', () => {
    window.localStorage.setItem(TERMS_ACCEPTANCE_KEY, JSON.stringify({ version: '2026-01-01-old', acceptedAt: '2026-01-01T00:00:00.000Z' }));
    renderGate('/');
    expect(dialog()).toBeTruthy();
    expect(appContent()).toBeNull();
  });

  it('lets the viewer in for the session when storage throws', () => {
    const blocked = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    const store = createTermsAcceptanceStore(TERMS_VERSION, { ...browserTermsEnv(), storage: blocked, readCookies: blocked, writeCookie: blocked });
    renderGate('/', store);
    fireEvent.click(checkbox());
    expect(() => fireEvent.click(acceptButton())).not.toThrow();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Feed' })).toBeTruthy();
  });

  it('keeps the decorative character out of the dialog’s accessible text', () => {
    renderGate('/');
    const art = dialog().querySelector('[data-cast="sorter"]');
    expect(art?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it.each([
    ['/about/terms', 'Terms page'],
    ['/about/risks', 'Risks page'],
    ['/about/privacy', 'Privacy page'],
  ])('%s is readable without accepting, marked restricted for the frame; leaving it for the app shows the gate', (path, title) => {
    renderGate(path);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeTruthy();
    // The frame reads this and leaves out wallet, launch and search until acceptance.
    expect(appContent()?.getAttribute('data-terms-access')).toBe('restricted');
    if (path === '/about/terms') {
      fireEvent.click(screen.getByRole('link', { name: 'Back to the feed' }));
      expect(dialog()).toBeTruthy();
      expect(appContent()).toBeNull();
    }
  });

  it('once accepted, pages are marked accepted for the frame', () => {
    renderGate('/about/risks');
    expect(appContent()?.getAttribute('data-terms-access')).toBe('restricted');
    cleanup();
    const store = createTermsAcceptanceStore(TERMS_VERSION);
    store.accept();
    renderGate('/about/risks', store);
    expect(appContent()?.getAttribute('data-terms-access')).toBe('accepted');
  });

  it('the link to the full Terms opens them without accepting, with focus on their heading, and carries the requested page', () => {
    renderGate('/pair/31337/0x66?tab=nfts#gallery');
    fireEvent.click(within(dialog()).getByRole('link', { name: TERMS_GATE.fullTermsLink }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Terms page' })).toBe(document.activeElement);
    expect(appContent()?.getAttribute('data-back')).toBe('/pair/31337/0x66?tab=nfts#gallery');
  });

  it('accepts only an in-app path as the page to return to', () => {
    expect(termsReturnPath({ from: '/pair/31337/0x66' })).toBe('/pair/31337/0x66');
    expect(termsReturnPath({ from: '/' })).toBe('/');
    for (const state of [null, undefined, 'x', {}, { from: 42 }, { from: 'https://evil.example/' }, { from: '//evil.example' }, { from: '/\\evil.example' }, { from: '/about/terms' }, { from: '/about/terms#terms-5' }, { from: `/${'a'.repeat(2048)}` }]) {
      expect(termsReturnPath(state), JSON.stringify(state)).toBeNull();
    }
  });

  it('traps Tab and Shift+Tab inside the dialog', () => {
    renderGate('/');
    const gate = dialog();
    const region = within(gate).getByRole('region', { name: 'Summary of the Terms of Use' });
    const heading = within(gate).getByRole('heading', { level: 1 });

    // Accept disabled: Decline is the last stop.
    declineButton().focus();
    fireEvent.keyDown(declineButton(), { key: 'Tab' });
    expect(document.activeElement).toBe(region);
    fireEvent.keyDown(region, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(declineButton());

    // Shift+Tab from the focused heading (the initial focus) wraps to the last stop, not out of the dialog.
    heading.focus();
    fireEvent.keyDown(heading, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(declineButton());

    fireEvent.click(checkbox());
    acceptButton().focus();
    fireEvent.keyDown(acceptButton(), { key: 'Tab' });
    expect(document.activeElement).toBe(region);
    fireEvent.keyDown(region, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(acceptButton());
  });

  it('follows an acceptance made in another tab', () => {
    renderGate('/');
    window.localStorage.setItem(TERMS_ACCEPTANCE_KEY, JSON.stringify({ version: TERMS_VERSION, acceptedAt: '2026-09-27T00:00:00.000Z' }));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: TERMS_ACCEPTANCE_KEY }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Feed' })).toBeTruthy();
  });
});
