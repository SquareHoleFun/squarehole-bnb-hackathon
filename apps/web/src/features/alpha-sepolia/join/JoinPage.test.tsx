import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
import { TEST_NETWORK_NOTICE } from '../../legal/test-network';
import type { AlphaApi, AlphaMe, AlphaResult } from '../alpha-api';
import { JOIN_WORDS } from '../alpha-words';
import type { MadeWallet, PrivyBridge } from '../privy-bridge';
import { JoinPage } from './JoinPage';

afterEach(cleanup);

/**
 * F161 (4), SH-ALPHA-SITE: the join page in each of its states, over a double of our server and of Privy's bridge (the
 * browser suite runs the real alpha-api and the Privy stand-in: e2e/alpha-access).
 */
const me = (status: AlphaMe['status'], handle = 'tester'): AlphaResult<AlphaMe> => ({ ok: true, value: { status, handle, claim: null } });
const refused = (status: number, error = 'request refused'): AlphaResult<never> => ({ ok: false, status, error });

function apiDouble(answers: Partial<{ me: AlphaResult<AlphaMe>; session: AlphaResult<AlphaMe>; signOut: AlphaResult<true> }>) {
  const api: AlphaApi & { calls: string[] } = {
    calls: [],
    intake: vi.fn(async () => ({ ok: true as const, value: { open: true, returning: false } })), me: vi.fn(async () => { api.calls.push('me'); return answers.me ?? refused(401, 'sign in required'); }),
    session: vi.fn(async (token: string) => { api.calls.push(`session:${token}`); return answers.session ?? me('pending'); }),
    signOut: vi.fn(async (): Promise<AlphaResult<true>> => { api.calls.push('signOut'); return answers.signOut ?? { ok: true, value: true }; }),
    claimMessage: vi.fn(), claim: vi.fn(), claimState: vi.fn(), signups: vi.fn(), decide: vi.fn(),
  };
  return api;
}

function bridgeDouble(over: Partial<PrivyBridge> & { signedIn?: boolean; wallet?: MadeWallet | null } = {}) {
  let signedIn = over.signedIn ?? false;
  const bridge: PrivyBridge = {
    ready: vi.fn(async () => undefined),
    authenticated: vi.fn(() => signedIn),
    signIn: vi.fn(async () => undefined),
    finishSignIn: vi.fn(async () => 'id.token.fresh'),
    identityToken: vi.fn(async () => (signedIn ? 'id.token.kept' : null)),
    signOut: vi.fn(async () => { signedIn = false; }),
    madeWallet: vi.fn(async () => over.wallet ?? null),
    makeWallet: vi.fn(),
    exportWallet: vi.fn(async () => undefined),
    ...over,
  };
  return { bridge, load: vi.fn(async () => bridge) };
}

const acceptance = () => ({ version: 'v', isAccepted: () => false, accept: vi.fn(() => 'saved' as const), subscribe: () => () => undefined });
const page = (search = '') => ({ search, assign: vi.fn(), replace: vi.fn() });
const APP_ID = 'cmtestappid00000000000000';

describe('the alpha join page (F161 (4), SH-ALPHA-SITE)', () => {
  it('shows a stranger the notice, its box and “Sign in with X”, which waits for the box and loads Privy only on the press', async () => {
    const api = apiDouble({});
    const { bridge, load } = bridgeDouble();
    const store = acceptance();
    const { container } = render(<JoinPage api={api} loadPrivy={load} appId={APP_ID} page={page()} acceptance={store} />);
    const button = await screen.findByRole('button', { name: JOIN_WORDS.signIn });
    expect(screen.getByRole('heading', { level: 1, name: JOIN_WORDS.title })).toBeTruthy();
    const points = screen.getByRole('region', { name: 'Test network notice' }).querySelectorAll('li');
    expect(Array.from(points, (point) => point.textContent)).toEqual(TEST_NETWORK_NOTICE.points.map((point) => point.replaceAll('**', '')));
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(load).not.toHaveBeenCalled();
    // The box says what the app's own gate says (one sentence, one source: the notice's gate).
    expect(screen.getByRole('checkbox', { name: TEST_NETWORK_NOTICE.gate.checkbox })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { fireEvent.click(button); });
    expect(store.accept).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(APP_ID);
    expect(bridge.signIn).toHaveBeenCalledTimes(1);
    expect(api.calls).toEqual(['me']);
    expect(appCopyFraming(renderedCopy(container))).toEqual([]);
  });

  it('sends a kept Privy sign-in straight to our server, and an approved account into the app', async () => {
    const api = apiDouble({ session: me('approved') });
    const { bridge, load } = bridgeDouble({ signedIn: true });
    const where = page();
    render(<JoinPage api={api} loadPrivy={load} appId={APP_ID} page={where} acceptance={acceptance()} />);
    fireEvent.click(await screen.findByRole('checkbox'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: JOIN_WORDS.signIn })); });
    expect(bridge.signIn).not.toHaveBeenCalled();
    expect(api.calls).toEqual(['me', 'session:id.token.kept']);
    expect(where.assign).toHaveBeenCalledWith('/');
  });

  it('finishes a sign-in X sent back: the token to our server once, then where the account stands', async () => {
    const api = apiDouble({ session: me('pending', 'new_tester') });
    const { bridge, load } = bridgeDouble();
    render(<JoinPage api={api} loadPrivy={load} appId={APP_ID} page={page('?privy_oauth_code=c&privy_oauth_state=s&privy_oauth_provider=twitter')} acceptance={acceptance()} />);
    expect(screen.getByText(JOIN_WORDS.signingIn)).toBeTruthy();
    expect(await screen.findByText(JOIN_WORDS.pending)).toBeTruthy();
    expect(screen.getByText('@new_tester')).toBeTruthy();
    expect(screen.getByText(JOIN_WORDS.pendingHint)).toBeTruthy();
    expect(bridge.finishSignIn).toHaveBeenCalledTimes(1);
    expect(api.calls).toEqual(['session:id.token.fresh']);
  });

  it('goes into the app after a fresh approved sign-in; shows the way in on a later visit', async () => {
    const fresh = page('?privy_oauth_code=c&privy_oauth_state=s&privy_oauth_provider=twitter');
    render(<JoinPage api={apiDouble({ session: me('approved') })} loadPrivy={bridgeDouble().load} appId={APP_ID} page={fresh} acceptance={acceptance()} />);
    await waitFor(() => expect(fresh.assign).toHaveBeenCalledWith('/'));
    cleanup();
    const later = page();
    render(<JoinPage api={apiDouble({ me: me('approved') })} loadPrivy={bridgeDouble().load} appId={APP_ID} page={later} acceptance={acceptance()} />);
    expect(await screen.findByText(JOIN_WORDS.approved)).toBeTruthy();
    expect(screen.getByRole('link', { name: JOIN_WORDS.openApp }).getAttribute('href')).toBe('/');
    expect(screen.getByRole('link', { name: JOIN_WORDS.claim }).getAttribute('href')).toBe('/test-coins');
    expect(later.assign).not.toHaveBeenCalled();
  });

  it('tells a removed account its access ended and keeps the export and sign-out there', async () => {
    const { bridge, load } = bridgeDouble({ signedIn: true, wallet: { address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', provider: { request: vi.fn() } } });
    render(<JoinPage api={apiDouble({ me: me('removed') })} loadPrivy={load} appId={APP_ID} page={page()} acceptance={acceptance()} />);
    expect(await screen.findByText(JOIN_WORDS.removed)).toBeTruthy();
    expect(screen.getByText(JOIN_WORDS.removedHint)).toBeTruthy();
    expect(screen.queryByRole('link', { name: JOIN_WORDS.openApp })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: JOIN_WORDS.exportWallet })); });
    expect(bridge.exportWallet).toHaveBeenCalledTimes(1);
  });

  it('an export with Privy’s sign-in lapsed (ours still on) says so and offers “Sign in with X” right there, which comes back here, not into the app (XR-ALPHA-SITE af2)', async () => {
    const lapsed = bridgeDouble({ signedIn: false });
    const where = page();
    render(<JoinPage api={apiDouble({ me: me('approved') })} loadPrivy={lapsed.load} appId={APP_ID} page={where} acceptance={acceptance()} />);
    const exportPress = await screen.findByRole('button', { name: JOIN_WORDS.exportWallet });
    await act(async () => { fireEvent.click(exportPress); });
    expect(screen.getByRole('status').textContent).toBe(JOIN_WORDS.exportSignIn);
    expect(lapsed.bridge.exportWallet).not.toHaveBeenCalled();
    // Only now, and with no box to tick: the account accepted the notice when it joined.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: JOIN_WORDS.signIn })); });
    expect(where.replace).toHaveBeenCalledWith('/join?then=export');
    expect(lapsed.bridge.signIn).toHaveBeenCalledTimes(1);
    cleanup();
    // Back from X: our server gets the fresh identity token, and the page stays (the export is pressed again here).
    const back = bridgeDouble({ signedIn: true });
    const returned = page('?then=export&privy_oauth_code=c&privy_oauth_state=s&privy_oauth_provider=twitter');
    const api = apiDouble({ session: me('approved') });
    render(<JoinPage api={api} loadPrivy={back.load} appId={APP_ID} page={returned} acceptance={acceptance()} />);
    await screen.findByText(JOIN_WORDS.approved);
    expect(api.calls).toEqual(['session:id.token.fresh']);
    expect(returned.assign).not.toHaveBeenCalled();
    expect(returned.replace).toHaveBeenCalledWith('/join');
    // XR-ALPHA-SITE af3: the return from X does not offer the sign-in again.
    expect(screen.queryByRole('button', { name: JOIN_WORDS.signIn })).toBeNull();
  });

  it('opened from the Claim card while it asks for Privy’s sign-in (/join?then=export), offers “Sign in with X” at once, which comes back here (XR-ALPHA-SITE af3)', async () => {
    const lapsed = bridgeDouble({ signedIn: false });
    const linked = page('?then=export');
    render(<JoinPage api={apiDouble({ me: me('approved') })} loadPrivy={lapsed.load} appId={APP_ID} page={linked} acceptance={acceptance()} />);
    await screen.findByText(JOIN_WORDS.approved);
    expect(linked.assign).not.toHaveBeenCalled();
    expect(linked.replace).toHaveBeenCalledWith('/join');
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: JOIN_WORDS.signIn })); });
    expect(linked.replace).toHaveBeenLastCalledWith('/join?then=export');
    expect(lapsed.bridge.signIn).toHaveBeenCalledTimes(1);
    cleanup();
    // Opened plainly, the same account's view offers no sign-in until an export finds Privy's lapsed.
    render(<JoinPage api={apiDouble({ me: me('approved') })} loadPrivy={bridgeDouble({ signedIn: false }).load} appId={APP_ID} page={page()} acceptance={acceptance()} />);
    await screen.findByText(JOIN_WORDS.approved);
    expect(screen.queryByRole('button', { name: JOIN_WORDS.signIn })).toBeNull();
  });

  it('says why an export cannot open: no Privy sign-in, or no wallet Privy made', async () => {
    const out = bridgeDouble({ signedIn: false });
    render(<JoinPage api={apiDouble({ me: me('pending') })} loadPrivy={out.load} appId={APP_ID} page={page()} acceptance={acceptance()} />);
    const pressed = await screen.findByRole('button', { name: JOIN_WORDS.exportWallet });
    await act(async () => { fireEvent.click(pressed); });
    expect(screen.getByRole('status').textContent).toBe(JOIN_WORDS.exportSignIn);
    cleanup();
    const none = bridgeDouble({ signedIn: true, wallet: null });
    render(<JoinPage api={apiDouble({ me: me('pending') })} loadPrivy={none.load} appId={APP_ID} page={page()} acceptance={acceptance()} />);
    const again = await screen.findByRole('button', { name: JOIN_WORDS.exportWallet });
    await act(async () => { fireEvent.click(again); });
    expect(screen.getByRole('status').textContent).toBe(JOIN_WORDS.noMadeWallet);
    expect(none.bridge.exportWallet).not.toHaveBeenCalled();
  });

  it('an export whose Privy part fails (its wallet frame never answered) says so in one line and opens nothing (XR-ALPHA-SITE af3)', async () => {
    const broken = bridgeDouble({ signedIn: true, madeWallet: vi.fn(async () => { throw new Error('Privy’s wallets did not load'); }) });
    render(<JoinPage api={apiDouble({ me: me('approved') })} loadPrivy={broken.load} appId={APP_ID} page={page()} acceptance={acceptance()} />);
    const pressed = await screen.findByRole('button', { name: JOIN_WORDS.exportWallet });
    await act(async () => { fireEvent.click(pressed); });
    expect(screen.getByRole('status').textContent).toBe(JOIN_WORDS.exportFailed);
    expect(JOIN_WORDS.exportFailed).toBe('Export did not open. Try again.');
    expect(broken.bridge.exportWallet).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: JOIN_WORDS.exportWallet }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('signs out of our server and of Privy, back to the stranger’s page', async () => {
    const api = apiDouble({ me: me('pending') });
    const { bridge, load } = bridgeDouble({ signedIn: true });
    render(<JoinPage api={api} loadPrivy={load} appId={APP_ID} page={page()} acceptance={acceptance()} />);
    const pressed = await screen.findByRole('button', { name: JOIN_WORDS.signOut });
    await act(async () => { fireEvent.click(pressed); });
    expect(api.calls).toEqual(['me', 'signOut']);
    expect(bridge.signOut).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: JOIN_WORDS.signIn })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(JOIN_WORDS.signedOut);
  });

  it('a sign-out Privy did not complete (not ready, or its logout failed) is said apart: ours ended, Privy’s may not have (XR-ALPHA-SITE af2)', async () => {
    const api = apiDouble({ me: me('approved') });
    const { bridge, load } = bridgeDouble({ signedIn: true, signOut: vi.fn(async () => { throw new Error('Privy is not ready'); }) });
    render(<JoinPage api={api} loadPrivy={load} appId={APP_ID} page={page()} acceptance={acceptance()} />);
    const pressed = await screen.findByRole('button', { name: JOIN_WORDS.signOut });
    await act(async () => { fireEvent.click(pressed); });
    expect(api.calls).toEqual(['me', 'signOut']);
    expect(bridge.signOut).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: JOIN_WORDS.signIn })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Signed out here; Privy’s own sign-in in this browser may still be on.');
  });

  it('offers no sign-in while the Privy app ID is the placeholder, or in a build without Privy', async () => {
    render(<JoinPage api={apiDouble({})} loadPrivy={bridgeDouble().load} appId={null} page={page()} acceptance={acceptance()} />);
    expect(await screen.findByText(JOIN_WORDS.notSetUp)).toBeTruthy();
    expect(screen.queryByRole('button', { name: JOIN_WORDS.signIn })).toBeNull();
    cleanup();
    render(<JoinPage api={apiDouble({})} loadPrivy={null} appId={APP_ID} page={page()} acceptance={acceptance()} />);
    expect(await screen.findByText(JOIN_WORDS.notSetUp)).toBeTruthy();
  });

  it('says what went wrong in one line: a sign-in Privy did not finish, a token our server refused, a server that is down', async () => {
    const lost = bridgeDouble({ finishSignIn: vi.fn(async () => null) });
    render(<JoinPage api={apiDouble({})} loadPrivy={lost.load} appId={APP_ID} page={page('?privy_oauth_code=c&privy_oauth_state=s&privy_oauth_provider=twitter')} acceptance={acceptance()} />);
    expect((await screen.findByRole('status')).textContent).toBe('Sign-in did not complete. Try again.');
    expect(screen.getByRole('button', { name: JOIN_WORDS.signIn })).toBeTruthy();
    cleanup();
    render(<JoinPage api={apiDouble({ session: refused(401, 'expired identity') })} loadPrivy={bridgeDouble().load} appId={APP_ID} page={page('?privy_oauth_code=c&privy_oauth_state=s&privy_oauth_provider=twitter')} acceptance={acceptance()} />);
    expect((await screen.findByRole('status')).textContent).toBe('Your X sign-in expired. Sign in again.');
    cleanup();
    render(<JoinPage api={apiDouble({ me: refused(503, 'service unavailable') })} loadPrivy={bridgeDouble().load} appId={APP_ID} page={page()} acceptance={acceptance()} />);
    expect((await screen.findByRole('status')).textContent).toBe('The alpha service is not available. Try again later.');
    cleanup();
    render(<JoinPage api={apiDouble({ me: refused(0, 'no answer') })} loadPrivy={bridgeDouble().load} appId={APP_ID} page={page()} acceptance={acceptance()} />);
    expect((await screen.findByRole('status')).textContent).toBe('No answer from our server. Try again.');
  });
});


describe('SH-220 the phone line under “Sign in with X”', () => {
  /** The line the page renders, if any (shown on phones only, by join.css: this test sees the element, not its style). */
  const phoneLine = (container: HTMLElement) => container.querySelector<HTMLElement>('.sh-join__phone');

  it('holds the founder’s approved words exactly (15 November 2026)', () => {
    expect(JOIN_WORDS.phoneLogin).toBe('On a phone, X asks you to log in once. That’s X, not us.');
  });

  it('sits directly under the stranger’s button row, as plain text: no link, no button, no status or live region', async () => {
    const { container } = render(<JoinPage api={apiDouble({})} loadPrivy={bridgeDouble().load} appId={APP_ID} page={page()} acceptance={acceptance()} />);
    const button = await screen.findByRole('button', { name: JOIN_WORDS.signIn });
    const line = phoneLine(container);
    expect(line?.tagName).toBe('P');
    expect(line?.textContent).toBe(JOIN_WORDS.phoneLogin);
    expect(button.closest('.sh-join__actions')?.nextElementSibling).toBe(line);
    expect(line?.children.length).toBe(0);
    expect(line?.getAttribute('role')).toBeNull();
    expect(line?.getAttribute('aria-live')).toBeNull();
    expect(container.querySelectorAll('.sh-join__phone')).toHaveLength(1);
  });

  it('sits directly under the member view’s button row while it offers “Sign in with X” again (XR-ALPHA-SITE af3)', async () => {
    const { container } = render(<JoinPage api={apiDouble({ me: me('approved') })} loadPrivy={bridgeDouble({ signedIn: false }).load} appId={APP_ID} page={page('?then=export')} acceptance={acceptance()} />);
    const button = await screen.findByRole('button', { name: JOIN_WORDS.signIn });
    const line = phoneLine(container);
    expect(line?.textContent).toBe(JOIN_WORDS.phoneLogin);
    expect(button.closest('.sh-join__actions')?.nextElementSibling).toBe(line);
    expect(container.querySelectorAll('.sh-join__phone')).toHaveLength(1);
  });

  it('is absent from every view without a “Sign in with X” button', async () => {
    const views = [
      // Loading (our server never answers), a closed or unknown intake, no Privy in this build, a plain member view.
      { api: { ...apiDouble({}), me: vi.fn(() => new Promise<never>(() => undefined)), intake: vi.fn(() => new Promise<never>(() => undefined)) }, appId: APP_ID, wait: JOIN_WORDS.checking },
      { api: Object.assign(apiDouble({}), { intake: vi.fn(async () => ({ ok: true as const, value: { open: false, returning: false } })) }), appId: APP_ID, wait: JOIN_WORDS.closed },
      { api: Object.assign(apiDouble({}), { intake: vi.fn(async () => refused(503)) }), appId: APP_ID, wait: JOIN_WORDS.intakeUnknown },
      { api: apiDouble({}), appId: null, wait: JOIN_WORDS.notSetUp },
      { api: apiDouble({ me: me('pending') }), appId: APP_ID, wait: JOIN_WORDS.pending },
      { api: apiDouble({ me: me('approved') }), appId: APP_ID, wait: JOIN_WORDS.approved },
      { api: apiDouble({ me: me('removed') }), appId: APP_ID, wait: JOIN_WORDS.removed },
    ];
    for (const view of views) {
      const { container } = render(<JoinPage api={view.api as AlphaApi} loadPrivy={bridgeDouble().load} appId={view.appId} page={page()} acceptance={acceptance()} />);
      await screen.findByText(view.wait);
      expect(screen.queryByRole('button', { name: JOIN_WORDS.signIn }), view.wait).toBeNull();
      expect(phoneLine(container), view.wait).toBeNull();
      expect(screen.queryByText(JOIN_WORDS.phoneLogin), view.wait).toBeNull();
      cleanup();
    }
  });
});

describe('SH-198 intake before Privy', () => {
  it.each([false, null])('closed or unreadable intake (%s) loads no vendor and offers no new sign-in', async open => {
    const api = apiDouble({}), { load, bridge } = bridgeDouble();
    vi.mocked(api.intake).mockResolvedValue(open === null ? refused(503) : { ok: true, value: { open, returning: false } });
    render(<JoinPage api={api} loadPrivy={load} appId={APP_ID} page={page()} acceptance={acceptance()} />);
    await screen.findByText(open === null ? JOIN_WORDS.intakeUnknown : JOIN_WORDS.closed);
    expect(screen.queryByRole('button', { name: JOIN_WORDS.signIn })).toBeNull();
    expect(load).not.toHaveBeenCalled(); expect(bridge.signIn).not.toHaveBeenCalled();
  });
  it('rechecks at the press when the last slot was taken after page load', async () => {
    const api = apiDouble({}), { load } = bridgeDouble();
    render(<JoinPage api={api} loadPrivy={load} appId={APP_ID} page={page()} acceptance={acceptance()} />);
    fireEvent.click(await screen.findByRole('checkbox'));
    vi.mocked(api.intake).mockResolvedValue({ ok: true, value: { open: false, returning: false } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: JOIN_WORDS.signIn })); });
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryAllByText(JOIN_WORDS.closed).length).toBeGreaterThan(0);
  });
  it('lets a recognized returning browser start sign-in at the cap', async () => {
    const api = apiDouble({}), { load, bridge } = bridgeDouble();
    vi.mocked(api.intake).mockResolvedValue({ ok: true, value: { open: false, returning: true } });
    render(<JoinPage api={api} loadPrivy={load} appId={APP_ID} page={page()} acceptance={acceptance()} />);
    fireEvent.click(await screen.findByRole('checkbox'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: JOIN_WORDS.signIn })); });
    expect(bridge.signIn).toHaveBeenCalledTimes(1);
  });
});
