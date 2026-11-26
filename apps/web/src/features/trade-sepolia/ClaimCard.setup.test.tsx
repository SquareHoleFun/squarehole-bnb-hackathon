/**
 * F166 (SH-ALPHA-ONBOARDING): the Claim card's entry. Until the tester is set up it leads with "Set me up", today's
 * steps behind the small "I'll do it myself"; a browser wallet of the tester's own goes to today's steps at once; a claim
 * this device's setup did not make shows where it stands, as today, with a way to the wallet Privy made (another
 * device's setup, af1 F5); after a setup left midway, "Finish setup" for its own claim only (af1 F6). A run's end, put
 * away, leaves the card on the claim as our server holds it. Today's steps themselves: ClaimCard.test.tsx.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRY_RUN_REASON, type AlphaApi, type AlphaMe, type AlphaResult, type ClaimChallenge, type ClaimState } from '../alpha-sepolia/alpha-api';
import { CLAIM_WORDS, JOIN_WORDS, SETUP_WORDS, claimLine } from '../alpha-sepolia/alpha-words';
import type { MadeWallet, PrivyBridge } from '../alpha-sepolia/privy-bridge';
import { readSetupHint, writeSetupHint } from '../alpha-sepolia/setup-hint';
import { ClaimCard } from './ClaimCard';
import { resetMadeWalletForTests } from './made-wallet';
import { resetSetupForTests } from './setup-run';

// Anvil's well-known default account #1 (a public test key): the made wallet's signature is a real one.
const MADE = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const BROWSER = '0x00000000000000000000000000000000000000Bb' as const;
const ID = '0b6a2f9e-6c1d-4f3a-9b2e-1d2c3b4a5f60';
const APP_ID = 'cmtestappid00000000000000';
const textFor = (address: string) => `Square Hole alpha claim\n\nI link my X account @tester (X ID 123) to wallet ${address}.\nI request starter SepETH on Sepolia (chain 11155111).\nClaim ID: ${ID}\nTime: 2026-11-01T08:00:00.000Z\nSite: https://test-app.squarehole.fun`;

const wallet = vi.hoisted(() => ({}) as {
  status: 'disconnected' | 'connecting' | 'connected'; kind: 'injected'; account: string | null; chainId: number | null; walletName: string | null;
  signer: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown>; walletName: string; confirmsInPage?: true } | null;
  resumeProvidedWallet: (() => { current: () => boolean; connect: (made: unknown) => Promise<boolean> }) | null;
  switchChain: (chainId: number) => Promise<void>;
  requests: { method: string; params?: unknown[] }[];
});
vi.mock('../wallet', async () => {
  const React = await import('react');
  return {
    useWallet: () => wallet,
    shortAddress: (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`,
    BrowserWalletDialog: ({ open }: { open: boolean }) => (open ? React.createElement('div', { role: 'dialog', 'aria-label': 'Connect a browser wallet' }) : null),
  };
});

const madeSigner = () => ({
  walletName: 'Wallet Privy made', confirmsInPage: true as const,
  request: async (args: { method: string; params?: unknown[] }) => {
    wallet.requests.push(args);
    return MADE.signMessage({ message: { raw: (args.params as [`0x${string}`])[0] } });
  },
});

beforeEach(() => {
  resetMadeWalletForTests();
  resetSetupForTests();
  clock.now = 0;
  Object.assign(wallet, {
    status: 'disconnected', kind: 'injected', account: null, chainId: null, walletName: null, signer: null, requests: [], switchChain: async () => undefined,
    resumeProvidedWallet: () => ({
      current: () => wallet.status === 'disconnected',
      connect: async () => {
        if (wallet.status !== 'disconnected') return false;
        Object.assign(wallet, { status: 'connected', account: MADE.address, chainId: 11155111, walletName: 'Wallet Privy made', signer: madeSigner() });
        return true;
      },
    }),
  });
  try { window.localStorage.clear(); } catch { /* none */ }
});
afterEach(cleanup);

const receipt = (status: ClaimState['status'], over: Partial<ClaimState> = {}): ClaimState => ({ id: ID, status, admitTx: null, sendTx: null, reason: null, at: status === 'queued' ? null : '2026-11-01T08:05:00Z', ...over });
const approved = (claim: ClaimState | null = null): AlphaResult<AlphaMe> => ({ ok: true, value: { status: 'approved', handle: 'tester', claim } });

function server(me: AlphaResult<AlphaMe>, states: ClaimState[] = []) {
  const calls: string[] = [];
  const api: AlphaApi = {
    intake: vi.fn(async () => ({ ok: true as const, value: { open: true, returning: false } })), me: vi.fn(async () => { calls.push('me'); return me; }),
    session: vi.fn(), signOut: vi.fn(), signups: vi.fn(), decide: vi.fn(),
    claimMessage: vi.fn(async (address: string): Promise<AlphaResult<ClaimChallenge>> => { calls.push(`message:${address}`); return { ok: true, value: { id: ID, address: address as `0x${string}`, message: textFor(address), requestedAt: '2026-11-01T08:00:00.000Z' } }; }),
    claim: vi.fn(async (): Promise<AlphaResult<ClaimState>> => { calls.push('claim'); return { ok: true, value: receipt('queued') }; }),
    claimState: vi.fn(async (): Promise<AlphaResult<ClaimState>> => { calls.push('state'); return { ok: true, value: states.shift() ?? receipt('queued') }; }),
  };
  return { api, calls };
}

function privyDouble() {
  const made: MadeWallet = { address: MADE.address, provider: { request: vi.fn() } };
  const bridge: PrivyBridge = {
    ready: vi.fn(async () => undefined), authenticated: vi.fn(() => true), signIn: vi.fn(), finishSignIn: vi.fn(), identityToken: vi.fn(), signOut: vi.fn(),
    madeWallet: vi.fn(async () => made), makeWallet: vi.fn(async () => made), exportWallet: vi.fn(),
  };
  return { bridge, load: vi.fn(async () => bridge) };
}

/** The run's clock: each wait moves it on at once, so every wait of the run ends (none can hang a test). */
const clock = { now: 0 };
const TIMING = { now: () => clock.now, sleep: async (ms: number) => { clock.now += ms; await Promise.resolve(); } };
const card = () => screen.getByRole('region', { name: CLAIM_WORDS.title });
function renderCard(api: AlphaApi, load = privyDouble().load) {
  return render(<ClaimCard api={api} loadPrivy={load} appId={APP_ID} pollMs={60_000} target={() => ({ ok: false, reason: 'source_unavailable' })} timing={TIMING} />);
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
/** A press once the panel's buttons are armed (SetupPanel.tsx `ARM_MS` after it appears). */
async function pressArmed(button: HTMLElement) {
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  await act(async () => { fireEvent.click(button); });
}

describe('the Claim card’s entry (F166, SH-ALPHA-ONBOARDING)', () => {
  it('an approved tester with nothing connected: “Set me up” first; today’s steps, unchanged, behind “I’ll do it myself”', async () => {
    const privy = privyDouble();
    const { api, calls } = server(approved());
    renderCard(api, privy.load);
    const start = await within(card()).findByRole('button', { name: SETUP_WORDS.start });
    expect(start.className).toContain('sh-button--primary');
    expect(within(card()).queryByRole('button', { name: CLAIM_WORDS.useMine })).toBeNull();
    expect(within(card()).queryByRole('button', { name: CLAIM_WORDS.makeOne })).toBeNull();
    // The card's own lines and links stay around it: its lead, and the way to the join page.
    expect(within(card()).getByText(CLAIM_WORDS.lead)).toBeTruthy();
    expect(within(card()).getByRole('link', { name: CLAIM_WORDS.walletPage }).getAttribute('href')).toBe('/join');
    await pressArmed(within(card()).getByRole('button', { name: SETUP_WORDS.manual }));
    expect(within(card()).getByRole('button', { name: CLAIM_WORDS.useMine })).toBeTruthy();
    expect(within(card()).getByRole('button', { name: CLAIM_WORDS.makeOne })).toBeTruthy();
    expect(within(card()).queryByRole('button', { name: SETUP_WORDS.start })).toBeNull();
    expect(readSetupHint('tester')?.state).toBe('manual');
    // af1 F3: the keyboard goes to the card's own heading.
    expect(document.activeElement).toBe(within(card()).getByRole('heading', { name: CLAIM_WORDS.title }));
    await settle();
    expect(calls).toEqual(['me']);
    expect(privy.load).not.toHaveBeenCalled();
    expect(wallet.requests).toEqual([]);
  });

  it('a browser wallet of the tester’s own connected: today’s steps at once, no choice', async () => {
    Object.assign(wallet, { status: 'connected', account: BROWSER, chainId: 11155111, walletName: 'Test wallet', signer: { walletName: 'Test wallet', request: async () => null } });
    renderCard(server(approved()).api);
    expect(await within(card()).findByRole('button', { name: CLAIM_WORDS.getText })).toBeTruthy();
    expect(within(card()).queryByRole('button', { name: SETUP_WORDS.start })).toBeNull();
  });

  it('the made wallet in use and no claim yet: the choice, and “Set me up” goes on with that wallet', async () => {
    Object.assign(wallet, { status: 'connected', account: MADE.address, chainId: 11155111, walletName: 'Wallet Privy made', signer: madeSigner() });
    renderCard(server(approved()).api);
    expect(await within(card()).findByRole('button', { name: SETUP_WORDS.start })).toBeTruthy();
  });

  it('a claim this device’s setup did not make shows where it stands, as today; after a setup left midway, “Finish setup” for its own claim only', async () => {
    renderCard(server(approved(receipt('queued'))).api);
    await waitFor(() => expect(within(card()).getByRole('status').textContent).toBe(claimLine(receipt('queued'))));
    expect(within(card()).queryByRole('button', { name: SETUP_WORDS.finish })).toBeNull();
    // af1 F6: a setup left midway whose claim is another (made by hand, or elsewhere): nothing to finish either.
    cleanup();
    writeSetupHint({ handle: 'tester', state: 'started', claimId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f' });
    renderCard(server(approved(receipt('queued'))).api);
    await waitFor(() => expect(within(card()).getByRole('status').textContent).toBe(claimLine(receipt('queued'))));
    expect(within(card()).queryByRole('button', { name: SETUP_WORDS.finish })).toBeNull();
    cleanup();
    writeSetupHint({ handle: 'tester', state: 'started', claimId: ID });
    const privy = privyDouble();
    const { api, calls } = server(approved(receipt('queued')));
    renderCard(api, privy.load);
    expect(await within(card()).findByRole('button', { name: SETUP_WORDS.finish })).toBeTruthy();
    await settle();
    // Nothing resumes by itself: our server asked once, Privy not loaded, no wallet asked.
    expect(calls).toEqual(['me']);
    expect(privy.load).not.toHaveBeenCalled();
    expect(wallet.requests).toEqual([]);
  });

  it('a claim the sender’s dry run freed: the choice again, under the dry run’s own line', async () => {
    const released = receipt('skipped', { reason: DRY_RUN_REASON });
    renderCard(server(approved(released)).api);
    expect(await within(card()).findByRole('button', { name: SETUP_WORDS.start })).toBeTruthy();
    expect(within(card()).getByRole('status').textContent).toBe(claimLine(released));
  });

  it('a stopped run, then “I’ll do it myself”: the run is put away and today’s steps show; this device remembers the choice', async () => {
    const privy = privyDouble();
    vi.mocked(privy.bridge.makeWallet).mockRejectedValueOnce(new Error('Privy’s wallet frame did not load'));
    renderCard(server(approved()).api, privy.load);
    await pressArmed(await within(card()).findByRole('button', { name: SETUP_WORDS.start }));
    await waitFor(() => expect(within(card()).getAllByRole('status').map((line) => line.textContent)).toContain(CLAIM_WORDS.madeWalletFailed));
    expect(within(card()).getByRole('button', { name: SETUP_WORDS.tryAgain })).toBeTruthy();
    expect(within(card()).getByRole('button', { name: SETUP_WORDS.close })).toBeTruthy();
    fireEvent.click(within(card()).getByRole('button', { name: SETUP_WORDS.manual }));
    expect(await within(card()).findByRole('button', { name: CLAIM_WORDS.useMine })).toBeTruthy();
    expect(within(card()).queryByRole('list', { name: SETUP_WORDS.stepsLabel })).toBeNull();
    expect(readSetupHint('tester')?.state).toBe('manual');
    // af1: the next visit (a fresh page, the visit's flag gone) still opens on today's steps: the device remembers.
    cleanup();
    resetSetupForTests();
    renderCard(server(approved()).api);
    expect(await within(card()).findByRole('button', { name: CLAIM_WORDS.useMine })).toBeTruthy();
    expect(within(card()).queryByRole('button', { name: SETUP_WORDS.start })).toBeNull();
  });

  it('af1 F5: a claim standing and no wallet here (another device set it up): the wallet Privy made, connected on a press; never made here', async () => {
    const privy = privyDouble();
    renderCard(server(approved(receipt('sent'))).api, privy.load);
    const use = await within(card()).findByRole('button', { name: SETUP_WORDS.useMade });
    await act(async () => { fireEvent.click(use); });
    await waitFor(() => expect(wallet.status).toBe('connected'));
    expect(wallet.account).toBe(MADE.address);
    expect(privy.bridge.madeWallet).toHaveBeenCalledTimes(1);
    expect(privy.bridge.makeWallet).not.toHaveBeenCalled();
    // Privy made none for this account: said so, nothing made.
    cleanup();
    resetMadeWalletForTests();
    Object.assign(wallet, { status: 'disconnected', account: null, signer: null });
    const none = privyDouble();
    vi.mocked(none.bridge.madeWallet).mockResolvedValue(null);
    renderCard(server(approved(receipt('sent'))).api, none.load);
    const again = await within(card()).findByRole('button', { name: SETUP_WORDS.useMade });
    await act(async () => { fireEvent.click(again); });
    await waitFor(() => expect(within(card()).getAllByRole('status').map((line) => line.textContent)).toContain(JOIN_WORDS.noMadeWallet));
    expect(none.bridge.makeWallet).not.toHaveBeenCalled();
    expect(wallet.status).toBe('disconnected');
  });

  it('af1: a lapsed sign-in makes the sign-in the one primary action; no Try again until then', async () => {
    const privy = privyDouble();
    vi.mocked(privy.bridge.authenticated).mockReturnValue(false);
    renderCard(server(approved()).api, privy.load);
    await pressArmed(await within(card()).findByRole('button', { name: SETUP_WORDS.start }));
    await waitFor(() => expect(within(card()).getAllByRole('status').map((line) => line.textContent)).toContain(CLAIM_WORDS.signInAgain));
    const signIn = within(card()).getByRole('link', { name: CLAIM_WORDS.joinPage });
    expect(signIn.className).toContain('sh-button--primary');
    expect(signIn.getAttribute('href')).toBe('/join?then=export');
    expect(within(card()).queryByRole('button', { name: SETUP_WORDS.tryAgain })).toBeNull();
    expect(within(card()).getByRole('button', { name: SETUP_WORDS.close })).toBeTruthy();
    expect(privy.bridge.makeWallet).not.toHaveBeenCalled();
  });

  it('af1 F1: while a wallet’s own window is asking, “Set me up” is greyed and a press does nothing', async () => {
    const privy = privyDouble();
    const { api, calls } = server(approved());
    renderCard(api, privy.load);
    const start = await within(card()).findByRole('button', { name: SETUP_WORDS.start }) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    Object.assign(wallet, { status: 'connecting' });
    cleanup();
    renderCard(api, privy.load);
    const held = await within(card()).findByRole('button', { name: SETUP_WORDS.start }) as HTMLButtonElement;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
    expect(held.disabled).toBe(true);
    await act(async () => { fireEvent.click(held); });
    await settle();
    expect(privy.load).not.toHaveBeenCalled();
    expect(privy.bridge.makeWallet).not.toHaveBeenCalled();
    expect(calls.filter((call) => call === 'me')).toHaveLength(2);
  });

  it('a run on the card ends in test mode; put away, the card shows the freed claim and “Finish setup”', async () => {
    const released = receipt('skipped', { reason: DRY_RUN_REASON });
    const { api, calls } = server(approved(), [released]);
    renderCard(api);
    await pressArmed(await within(card()).findByRole('button', { name: SETUP_WORDS.start }));
    await waitFor(() => expect(within(card()).getByRole('list', { name: SETUP_WORDS.stepsLabel })).toBeTruthy());
    await waitFor(() => expect(within(card()).getAllByRole('status').map((line) => line.textContent)).toContain(SETUP_WORDS.testMode));
    expect(calls).toEqual(['me', 'me', `message:${MADE.address}`, 'claim', 'state']);
    // No Privy window and no browser one: the made wallet signed on the press.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(wallet.requests.map(({ method }) => method)).toEqual(['personal_sign']);
    fireEvent.click(within(card()).getByRole('button', { name: SETUP_WORDS.close }));
    expect(await within(card()).findByRole('button', { name: SETUP_WORDS.finish })).toBeTruthy();
    expect(within(card()).getAllByRole('status').map((line) => line.textContent)).toContain(claimLine(released));
    expect(document.activeElement).toBe(within(card()).getByRole('heading', { name: CLAIM_WORDS.title }));
  });
});
