/**
 * jsdom harness for the M3 pages (SH-014, SH-015 part 2): the whole app at a path, with the demo wallet at zero latency,
 * a controllable demo clock shared by the account provider and the transaction flows, and fake timers.
 */
import { DEMO_NOW, formatIsoUtc, parseIsoTimestamp } from '@squarehole/domain';
import { notifyManager } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router';
import { expect, vi } from 'vitest';
import { AppProviders } from '../app-providers';
import { createDemoAccountSources, type AccountSources } from '../features/accounts';
import { TxFlowConfigProvider } from '../features/tx';
import { DEMO_WALLET_TITLE, PICKER_PERSONAS, PickerPersonasContext, WALLET_PERSONAS, createDemoWalletAdapter } from '../features/wallet';
import { AppRoutes } from '../routes';
import { LEGACY_PAGES } from './legacy-pages';

export const STEP_MS = 100;

// React Query batches notifications with a zero-delay timer; under fake timers a nested zero-delay timer is pushed to
// +1 ms, so queries would only settle when time moves. Microtasks settle inside `flush()` without moving the clock.
notifyManager.setScheduler((callback) => queueMicrotask(callback));

export interface DemoClock {
  ms: number;
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

let navigateInApp: NavigateFunction | null = null;

/** Hands the router's navigate to `goTo`, for pages that left the primary navigation (the launch set). */
function NavigateProbe() {
  const navigate = useNavigate();
  useEffect(() => {
    navigateInApp = navigate;
  }, [navigate]);
  return null;
}

export interface RenderedApp {
  readonly clock: DemoClock;
  readonly sources: AccountSources;
}

export interface RenderM3Options {
  /**
   * Mount the first handoff's pages (Claims, Portfolio, the pair pages) at their old paths, for their own tests. No build
   * routes them since F134 R46B; without this the app redirects them as every build does.
   */
  readonly legacy?: boolean;
}

/** Renders the app at `path`. Call `vi.useFakeTimers()` first (scripted steps are STEP_MS apart). */
export function renderM3(path: string, { legacy = false }: RenderM3Options = {}): RenderedApp {
  const clock: DemoClock = { ms: parseIsoTimestamp(DEMO_NOW) };
  const sources = createDemoAccountSources({ now: () => formatIsoUtc(clock.ms) });
  render(
    // The old pages' tests connect as the old pairs' holders, whom the picker no longer offers (SH-V2-FE11).
    <PickerPersonasContext.Provider value={legacy ? WALLET_PERSONAS : PICKER_PERSONAS}>
      <AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })} accountSources={sources}>
        <TxFlowConfigProvider value={{ stepMs: STEP_MS, now: () => clock.ms }}>
          <MemoryRouter initialEntries={[path]}>
            <AppRoutes legacyPages={legacy ? LEGACY_PAGES : undefined} />
            <LocationProbe />
            <NavigateProbe />
          </MemoryRouter>
        </TxFlowConfigProvider>
      </AppProviders>
    </PickerPersonasContext.Provider>,
  );
  return { clock, sources };
}

export const location = () => screen.getByTestId('location').textContent;
export const main = () => screen.getByRole('main');

/** Lets promises, react-query notifications and zero-delay timers settle. */
export async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

export async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flush(2);
}

/**
 * Client-side navigation inside the rendered app (a connection lives in memory, so a page is never reloaded): Launch,
 * Claims and Portfolio left the primary navigation with the launch set (and every build with F134 R46B: `legacy`).
 */
export async function goTo(path: string): Promise<void> {
  const navigate = navigateInApp;
  if (!navigate) throw new Error('renderM3 first');
  await act(async () => {
    await navigate(path);
  });
  await flush(2);
}

export async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
  await flush(2);
}

/**
 * The top-bar wallet button. jsdom's role mapping also counts a `<header>` inside `main` (the pair detail header) as a
 * banner, which browsers do not, so the site banner is the one that holds the wallet button.
 */
function walletButton(): HTMLElement {
  for (const banner of screen.getAllByRole('banner')) {
    const button = within(banner).queryByRole('button', { name: /wallet/i });
    if (button) return button;
  }
  throw new Error('no wallet button in the top bar');
}

/** Connects through the top-bar button and the demo wallet window, as a person would. */
export async function connectAs(personaTitle: 'Current holder' | 'Past holder' | 'Never held' | 'Box wallet A' | 'Box wallet B', { wrongNetwork = false } = {}) {
  await click(walletButton());
  const dialog = screen.getByRole('dialog', { name: DEMO_WALLET_TITLE });
  fireEvent.click(within(dialog).getByRole('radio', { name: personaTitle }));
  const check = within(dialog).getByRole('checkbox', { name: /Simulate wrong network/ }) as HTMLInputElement;
  if (check.checked !== wrongNetwork) fireEvent.click(check);
  await click(within(dialog).getByRole('button', { name: /^(Connect|Update) sample wallet$/ }));
  await flush();
}

export async function disconnect() {
  await click(walletButton());
  await click(within(screen.getByRole('dialog', { name: DEMO_WALLET_TITLE })).getByRole('button', { name: 'Disconnect' }));
}

/** The claim card for a pair name (its h3). */
export function claimCard(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 3, name: new RegExp(`^${name}\\b`) });
  const card = heading.closest('article');
  if (!card) throw new Error(`no card for ${name}`);
  return card as HTMLElement;
}

export const figure = (card: HTMLElement, name: string) => card.querySelector(`[data-figure="${name}"] dd`)?.textContent ?? null;
export const txPanel = (card: HTMLElement) => card.querySelector<HTMLElement>('[data-tx-status]');
export const txStatus = (card: HTMLElement) => txPanel(card)?.dataset.txStatus ?? 'idle';
export const claimButton = (card: HTMLElement) => within(card).getByTestId('claim-button') as HTMLButtonElement;

/** Advances the scripted steps, signing when the demo wallet asks; returns the distinct statuses seen. */
export async function driveClaim(card: HTMLElement, maxSteps = 12): Promise<string[]> {
  const seen = [txStatus(card)];
  for (let i = 0; i < maxSteps; i += 1) {
    const sign = within(card).queryByRole('button', { name: 'Sign' });
    if (sign) await click(sign);
    else await advance(STEP_MS);
    const current = txStatus(card);
    if (current !== seen[seen.length - 1]) seen.push(current);
  }
  return seen;
}

export function expectNoAmountInputs(container: HTMLElement = document.body) {
  expect(within(container).queryAllByRole('textbox')).toEqual([]);
  expect(within(container).queryAllByRole('spinbutton')).toEqual([]);
  expect(container.querySelectorAll('input[type="number"], input[type="text"], textarea, iframe')).toHaveLength(0);
}
