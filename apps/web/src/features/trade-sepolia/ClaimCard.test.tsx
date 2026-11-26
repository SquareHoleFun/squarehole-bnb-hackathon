import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { hexToString, recoverMessageAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlphaApi, AlphaMe, AlphaResult, ClaimChallenge, ClaimState } from '../alpha-sepolia/alpha-api';
import { DRY_RUN_REASON } from '../alpha-sepolia/alpha-api';
import { CLAIM_WORDS, JOIN_WORDS } from '../alpha-sepolia/alpha-words';
import type { MadeWallet, PrivyBridge } from '../alpha-sepolia/privy-bridge';
import { readSetupHint } from '../alpha-sepolia/setup-hint';
import { appCopyFraming, renderedCopy } from '../legal/wording';
import { ClaimCard } from './ClaimCard';
import { MADE_WALLET_ID, MADE_WALLET_NAME, resetMadeWalletForTests } from './made-wallet';
import { chooseManual, resetSetupForTests } from './setup-run';

/**
 * F161 (4), SH-ALPHA-SITE, work package E: the Claim card over doubles of our server, of Privy's bridge and of the
 * wallet context; the signature is a real EIP-191 one (viem), recovered here to the claiming address.
 */
// Anvil's well-known default account #1 (a public test key): the claim's signature is a real one.
const SIGNER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const ID = '0b6a2f9e-6c1d-4f3a-9b2e-1d2c3b4a5f60';
const TX = `0x${'ab'.repeat(32)}` as const;
const textFor = (address: string) => `Square Hole alpha claim\n\nI link my X account @tester (X ID 123) to wallet ${address}.\nI request starter SepETH on Sepolia (chain 11155111).\nClaim ID: ${ID}\nTime: 2026-10-29T12:00:00.000Z\nSite: https://test-app.squarehole.fun`;

type Wallet = {
  status: 'disconnected' | 'connected'; kind: 'injected' | 'demo'; account: `0x${string}` | null; chainId: number | null; walletName: string | null;
  signer: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown>; walletName: string; confirmsInPage?: true } | null;
  /** The wallet context's ticket (wallet-context.tsx `resumeProvidedWallet`); its connects land in `ticketConnects`. */
  resumeProvidedWallet: (() => { current: () => boolean; connect: (wallet: { id: string; name: string; provider: unknown }) => Promise<boolean> }) | null;
  ticketConnects: { id: string; name: string; provider: unknown }[];
  requests: { method: string; params?: unknown[] }[];
};
const wallet = vi.hoisted(() => ({}) as Wallet);
vi.mock('../wallet', async () => {
  const React = await import('react');
  return {
    useWallet: () => wallet,
    shortAddress: (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`,
    BrowserWalletDialog: ({ open }: { open: boolean }) => (open ? React.createElement('div', { role: 'dialog', 'aria-label': 'Connect a browser wallet' }) : null),
  };
});

/** The context's ticket as this double plays it: current while nothing connected, its connect recorded. */
const ticketDouble = () => ({
  current: () => wallet.status === 'disconnected',
  connect: async (made: { id: string; name: string; provider: unknown }) => {
    if (wallet.status !== 'disconnected') return false;
    wallet.ticketConnects.push(made);
    return true;
  },
});

/** A browser wallet that signs with the test key (and says no when asked to decline). */
function connect(options: { decline?: boolean; made?: boolean } = {}) {
  wallet.status = 'connected'; wallet.kind = 'injected'; wallet.account = SIGNER.address; wallet.chainId = 11155111;
  wallet.walletName = options.made ? MADE_WALLET_NAME : 'Test wallet';
  wallet.signer = {
    walletName: wallet.walletName,
    ...(options.made ? { confirmsInPage: true as const } : {}),
    request: async (args) => {
      wallet.requests.push(args);
      if (args.method !== 'personal_sign') throw new Error(`unexpected ${args.method}`);
      if (options.decline) throw Object.assign(new Error('User rejected'), { code: 4001 });
      return SIGNER.signMessage({ message: { raw: (args.params as [`0x${string}`, string])[0] } });
    },
  };
}

beforeEach(() => {
  resetMadeWalletForTests();
  // F166: these are today's steps, as the tester meets them after "I'll do it myself" (the module's own flag, which
  // that press sets); the choice before them is ClaimCard.setup.test.tsx's.
  resetSetupForTests();
  chooseManual();
  Object.assign(wallet, { status: 'disconnected', kind: 'injected', account: null, chainId: null, walletName: null, signer: null, requests: [], ticketConnects: [], resumeProvidedWallet: ticketDouble });
  try { window.localStorage.clear(); } catch { /* none */ }
});
afterEach(cleanup);

const approved = (claim: ClaimState | null = null): AlphaResult<AlphaMe> => ({ ok: true, value: { status: 'approved', handle: 'tester', claim } });
const receipt = (status: ClaimState['status'], over: Partial<ClaimState> = {}): ClaimState => ({ id: ID, status, admitTx: null, sendTx: null, reason: null, at: status === 'queued' ? null : '2026-10-29T12:05:00Z', ...over });

function server(me: AlphaResult<AlphaMe>, over: Partial<AlphaApi> = {}) {
  const calls: string[] = [];
  const api: AlphaApi = {
    intake: vi.fn(async () => ({ ok: true as const, value: { open: true, returning: false } })), me: vi.fn(async () => { calls.push('me'); return me; }),
    session: vi.fn(), signOut: vi.fn(), signups: vi.fn(), decide: vi.fn(),
    claimMessage: vi.fn(async (address: string): Promise<AlphaResult<ClaimChallenge>> => { calls.push(`message:${address}`); return { ok: true, value: { id: ID, address: address as `0x${string}`, message: textFor(address), requestedAt: '2026-10-29T12:00:00.000Z' } }; }),
    claim: vi.fn(async (input: { address: string; message: string; signature: string }): Promise<AlphaResult<ClaimState>> => { calls.push(`claim:${input.address}`); return { ok: true, value: receipt('queued') }; }),
    claimState: vi.fn(async (): Promise<AlphaResult<ClaimState>> => { calls.push('state'); return { ok: true, value: receipt('sent', { admitTx: TX, sendTx: TX }) }; }),
    ...over,
  };
  return { api, calls };
}

function privyDouble(over: Partial<PrivyBridge> & { signedIn?: boolean } = {}) {
  const made: MadeWallet = { address: SIGNER.address, provider: { request: vi.fn() } };
  const bridge: PrivyBridge = {
    ready: vi.fn(async () => undefined), authenticated: vi.fn(() => over.signedIn ?? true), signIn: vi.fn(), finishSignIn: vi.fn(), identityToken: vi.fn(), signOut: vi.fn(),
    madeWallet: vi.fn(async () => made), makeWallet: vi.fn(async () => made), exportWallet: vi.fn(async () => undefined), ...over,
  };
  return { bridge, made, load: vi.fn(async () => bridge) };
}

const APP_ID = 'cmtestappid00000000000000';
const card = () => screen.getByRole('region', { name: CLAIM_WORDS.title });
const line = () => within(card()).queryByRole('status')?.textContent ?? null;

describe('the Claim card (F161 (4), SH-ALPHA-SITE)', () => {
  it('without our sign-in: one line and the way to the join page; nothing else is asked', async () => {
    const { api, calls } = server({ ok: false, status: 401, error: 'sign in required' });
    render(<ClaimCard api={api} loadPrivy={privyDouble().load} appId={APP_ID} />);
    await waitFor(() => expect(line()).toBe(CLAIM_WORDS.notSignedIn));
    expect(within(card()).getByRole('link', { name: CLAIM_WORDS.joinPage }).getAttribute('href')).toBe('/join');
    expect(within(card()).queryByRole('link', { name: CLAIM_WORDS.walletPage })).toBeNull();
    expect(calls).toEqual(['me']);
  });

  it('a pending account cannot claim yet, and keeps the way to the join page', async () => {
    render(<ClaimCard api={server({ ok: true, value: { status: 'pending', handle: 'tester', claim: null } }).api} loadPrivy={privyDouble().load} appId={APP_ID} />);
    await waitFor(() => expect(line()).toBe(CLAIM_WORDS.notApproved));
    expect(within(card()).queryByRole('button', { name: CLAIM_WORDS.getText })).toBeNull();
    expect(within(card()).getByRole('link', { name: CLAIM_WORDS.walletPage }).getAttribute('href')).toBe('/join');
  });

  it('a removed account reads the join page’s own line, and keeps the way there (the made wallet’s export lives on it)', async () => {
    render(<ClaimCard api={server({ ok: true, value: { status: 'removed', handle: 'tester', claim: null } }).api} loadPrivy={privyDouble().load} appId={APP_ID} />);
    await waitFor(() => expect(line()).toBe('Your access has ended.'));
    expect(within(card()).queryByRole('button', { name: CLAIM_WORDS.getText })).toBeNull();
    expect(within(card()).queryByRole('button', { name: CLAIM_WORDS.useMine })).toBeNull();
    expect(within(card()).getByRole('link', { name: CLAIM_WORDS.walletPage }).getAttribute('href')).toBe('/join');
  });

  it('approved with no wallet: “Use my wallet” opens the wallet window; “Make me a wallet” is offered beside it', async () => {
    render(<ClaimCard api={server(approved()).api} loadPrivy={privyDouble().load} appId={APP_ID} />);
    const mine = await within(card()).findByRole('button', { name: CLAIM_WORDS.useMine });
    expect(within(card()).getByRole('button', { name: CLAIM_WORDS.makeOne })).toBeTruthy();
    fireEvent.click(mine);
    expect(screen.getByRole('dialog', { name: 'Connect a browser wallet' })).toBeTruthy();
  });

  it('“Make me a wallet”: Privy makes it on the press, and it joins the app’s wallets; never without the press', async () => {
    const privy = privyDouble();
    render(<ClaimCard api={server(approved()).api} loadPrivy={privy.load} appId={APP_ID} />);
    const make = await within(card()).findByRole('button', { name: CLAIM_WORDS.makeOne });
    expect(privy.load).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(make); });
    expect(privy.bridge.makeWallet).toHaveBeenCalledTimes(1);
    expect(wallet.ticketConnects).toEqual([{ id: MADE_WALLET_ID, name: MADE_WALLET_NAME, provider: privy.made.provider }]);
  });

  it('“Make me a wallet” without Privy’s sign-in in this browser asks for X again, and makes nothing', async () => {
    const privy = privyDouble({ signedIn: false });
    render(<ClaimCard api={server(approved()).api} loadPrivy={privy.load} appId={APP_ID} />);
    const make = await within(card()).findByRole('button', { name: CLAIM_WORDS.makeOne });
    expect(within(card()).getByRole('link', { name: CLAIM_WORDS.walletPage }).getAttribute('href')).toBe('/join');
    await act(async () => { fireEvent.click(make); });
    expect(line()).toBe(CLAIM_WORDS.signInAgain);
    expect(privy.bridge.makeWallet).not.toHaveBeenCalled();
    // XR-ALPHA-SITE af3: the link now opens the join page with "Sign in with X" offered at once.
    expect(within(card()).getByRole('link', { name: CLAIM_WORDS.walletPage }).getAttribute('href')).toBe('/join?then=export');
  });

  it('claims: the exact text for the connected address shown, one press signs exactly it, the claim is sent and followed to its receipt', async () => {
    connect();
    const { api, calls } = server(approved());
    render(<ClaimCard api={api} loadPrivy={privyDouble().load} appId={APP_ID} pollMs={10} />);
    const get = await within(card()).findByRole('button', { name: CLAIM_WORDS.getText });
    expect(wallet.requests).toEqual([]);
    await act(async () => { fireEvent.click(get); });
    expect(card().querySelector('[data-claim-text]')?.textContent).toBe(textFor(SIGNER.address));
    expect(wallet.requests).toEqual([]);
    await act(async () => { fireEvent.click(within(card()).getByRole('button', { name: CLAIM_WORDS.sign })); });
    // One request: the text as UTF-8 hex, then the account; the signature recovers to that account.
    expect(wallet.requests).toHaveLength(1);
    const [hex, account] = wallet.requests[0]?.params as [`0x${string}`, string];
    expect(hexToString(hex)).toBe(textFor(SIGNER.address));
    expect(account).toBe(SIGNER.address);
    const posted = (api.claim as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { address: string; message: string; signature: `0x${string}` };
    expect(posted.message).toBe(textFor(SIGNER.address));
    expect(await recoverMessageAddress({ message: posted.message, signature: posted.signature })).toBe(SIGNER.address);
    await waitFor(() => expect(line()).toBe('Sent: your starter SepETH and tETH faucet access.'));
    expect(within(card()).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([`https://sepolia.etherscan.io/tx/${TX}`, `https://sepolia.etherscan.io/tx/${TX}`, '/join']);
    expect(calls).toEqual(['me', `message:${SIGNER.address}`, `claim:${SIGNER.address}`, 'state']);
    expect(appCopyFraming(renderedCopy(card()))).toEqual([]);
    // F166 af1 F6: a claim made on these steps is the manual path on this device: no page offers "Set me up" for it.
    expect(readSetupHint('tester')).toEqual({ state: 'manual', claimId: null });
  });

  it('the made wallet signs on the press with no window of its own: the card says “Signing…”, and its export is on the card', async () => {
    connect({ made: true });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const request = wallet.signer?.request;
    if (wallet.signer && request) wallet.signer.request = async (args) => { await held; return request(args); };
    const privy = privyDouble();
    render(<ClaimCard api={server(approved()).api} loadPrivy={privy.load} appId={APP_ID} pollMs={10} />);
    const button1 = await within(card()).findByRole('button', { name: CLAIM_WORDS.getText });
    await act(async () => { fireEvent.click(button1); });
    act(() => { fireEvent.click(within(card()).getByRole('button', { name: CLAIM_WORDS.sign })); });
    expect(within(card()).getByRole('button', { name: CLAIM_WORDS.signMade })).toBeTruthy();
    await act(async () => { release(); await held; });
    await act(async () => { fireEvent.click(within(card()).getByRole('button', { name: CLAIM_WORDS.exportKey })); });
    expect(privy.bridge.exportWallet).toHaveBeenCalledTimes(1);
  });

  it('a signature said no to sends nothing; a refusal of our server is one line', async () => {
    connect({ decline: true });
    const { api, calls } = server(approved());
    render(<ClaimCard api={api} loadPrivy={privyDouble().load} appId={APP_ID} />);
    const button2 = await within(card()).findByRole('button', { name: CLAIM_WORDS.getText });
    await act(async () => { fireEvent.click(button2); });
    await act(async () => { fireEvent.click(within(card()).getByRole('button', { name: CLAIM_WORDS.sign })); });
    expect(line()).toBe(CLAIM_WORDS.declined);
    expect(calls).not.toContain(`claim:${SIGNER.address}`);
    cleanup();
    connect();
    const taken = server(approved(), { claim: vi.fn(async (): Promise<AlphaResult<ClaimState>> => ({ ok: false, status: 409, error: 'already claimed' })) });
    render(<ClaimCard api={taken.api} loadPrivy={privyDouble().load} appId={APP_ID} />);
    const button3 = await within(card()).findByRole('button', { name: CLAIM_WORDS.getText });
    await act(async () => { fireEvent.click(button3); });
    await act(async () => { fireEvent.click(within(card()).getByRole('button', { name: CLAIM_WORDS.sign })); });
    expect(line()).toBe('This X account or wallet has claimed already.');
    cleanup();
    connect();
    const cap = server(approved(), { claimMessage: vi.fn(async (): Promise<AlphaResult<ClaimChallenge>> => ({ ok: false, status: 409, error: 'already claimed' })) });
    render(<ClaimCard api={cap.api} loadPrivy={privyDouble().load} appId={APP_ID} />);
    const button4 = await within(card()).findByRole('button', { name: CLAIM_WORDS.getText });
    await act(async () => { fireEvent.click(button4); });
    expect(line()).toBe('This X account or wallet has claimed already.');
  });

  it('a claim already made shows its state, and offers a fresh one only after the sender’s exact dry-run receipt', async () => {
    connect();
    render(<ClaimCard api={server(approved(receipt('refused', { reason: 'address already admitted' }))).api} loadPrivy={privyDouble().load} appId={APP_ID} />);
    await waitFor(() => expect(line()).toBe('Refused. Nothing was sent.'));
    expect(within(card()).queryByRole('button', { name: CLAIM_WORDS.getText })).toBeNull();
    cleanup();
    render(<ClaimCard api={server(approved(receipt('skipped', { reason: DRY_RUN_REASON }))).api} loadPrivy={privyDouble().load} appId={APP_ID} />);
    await waitFor(() => expect(line()).toBe('Not sent: a dry run. Claim again later.'));
    expect(within(card()).getByRole('button', { name: CLAIM_WORDS.getText })).toBeTruthy();
  });

  it.each(['queued', 'waiting', 'sending'] as const)('%s keeps polling a refill wait until sent, without another signature or claim', async status => {
    const waiting = receipt('waiting', { reason: 'insufficient float for starter and gas' });
    let refilled = false;
    const { api } = server(approved({ ...waiting, status }), { claimState: vi.fn(async (): Promise<AlphaResult<ClaimState>> =>
      ({ ok: true, value: refilled ? receipt('sent', { admitTx: TX, sendTx: TX }) : waiting })) });
    render(<ClaimCard api={api} loadPrivy={privyDouble().load} appId={APP_ID} pollMs={5} />);
    await waitFor(() => expect(line()).toBe('Waiting: the faucet is being refilled.'));
    await waitFor(() => expect(vi.mocked(api.claimState).mock.calls.length).toBeGreaterThanOrEqual(2));
    refilled = true;
    await waitFor(() => expect(line()).toBe('Sent: your starter SepETH and tETH faucet access.'));
    for (const args of vi.mocked(api.claimState).mock.calls) expect(args).toEqual([waiting.id]);
    expect(api.claim).not.toHaveBeenCalled(); expect(api.claimMessage).not.toHaveBeenCalled();
    expect(wallet.requests).toEqual([]);
  });

  it('a queued claim is read again until its receipt, and stops after its limit with “Check again”', async () => {
    connect();
    let answers = 0;
    const { api } = server(approved(receipt('queued')), { claimState: vi.fn(async (): Promise<AlphaResult<ClaimState>> => { answers += 1; return answers < 3 ? { ok: true, value: receipt('queued') } : { ok: true, value: receipt('failed', { reason: 'rpc down' }) }; }) });
    render(<ClaimCard api={api} loadPrivy={privyDouble().load} appId={APP_ID} pollMs={5} />);
    await waitFor(() => expect(line()).toBe('It did not go through. We look into it.'));
    expect(answers).toBe(3);
  });

  it('every signed-in card links the join page (sign-out, the made wallet’s export), whatever wallet is chosen or let go (XR-ALPHA-SITE af1)', async () => {
    const wayBack = () => within(card()).getByRole('link', { name: CLAIM_WORDS.walletPage });
    const exportButton = () => within(card()).queryByRole('button', { name: CLAIM_WORDS.exportKey });
    connect({ made: true });
    const props = { api: server(approved()).api, loadPrivy: privyDouble().load, appId: APP_ID };
    const view = render(<ClaimCard {...props} />);
    await within(card()).findByRole('button', { name: CLAIM_WORDS.getText });
    expect(wayBack().getAttribute('href')).toBe('/join');
    expect(exportButton()).toBeTruthy();
    // A disconnect: the wallet Privy made is not gone, and the way to its export stays.
    Object.assign(wallet, { status: 'disconnected', account: null, chainId: null, walletName: null, signer: null });
    view.rerender(<ClaimCard {...props} />);
    await within(card()).findByRole('button', { name: CLAIM_WORDS.useMine });
    expect(wayBack().getAttribute('href')).toBe('/join');
    // A switch to a browser wallet: the same.
    connect();
    view.rerender(<ClaimCard {...props} />);
    await within(card()).findByRole('button', { name: CLAIM_WORDS.getText });
    expect(wayBack().getAttribute('href')).toBe('/join');
    expect(exportButton()).toBeNull();
  });

  it('after a claim went out, the card holds its receipt and still links the join page', async () => {
    render(<ClaimCard api={server(approved(receipt('sent', { admitTx: TX, sendTx: TX }))).api} loadPrivy={privyDouble().load} appId={APP_ID} />);
    await waitFor(() => expect(line()).toBe('Sent: your starter SepETH and tETH faucet access.'));
    expect(within(card()).queryByRole('button', { name: CLAIM_WORDS.useMine })).toBeNull();
    expect(within(card()).getByRole('link', { name: CLAIM_WORDS.walletPage }).getAttribute('href')).toBe('/join');
  });

  it('the card’s Export key with Privy’s sign-in lapsed names the right step (XR-ALPHA-SITE af2), and opens nothing', async () => {
    connect({ made: true });
    const privy = privyDouble({ signedIn: false });
    render(<ClaimCard api={server(approved()).api} loadPrivy={privy.load} appId={APP_ID} />);
    const press = await within(card()).findByRole('button', { name: CLAIM_WORDS.exportKey });
    expect(within(card()).getByRole('link', { name: CLAIM_WORDS.walletPage }).getAttribute('href')).toBe('/join');
    await act(async () => { fireEvent.click(press); });
    expect(line()).toBe('Sign in with X again first, then export.');
    expect(privy.bridge.exportWallet).not.toHaveBeenCalled();
    // XR-ALPHA-SITE af3: the link now opens the join page with "Sign in with X" offered at once.
    expect(within(card()).getByRole('link', { name: CLAIM_WORDS.walletPage }).getAttribute('href')).toBe('/join?then=export');
  });

  it('the card’s Export key asks Privy on the press: for an X account Privy made no wallet for, one line and no export', async () => {
    connect({ made: true });
    const privy = privyDouble({ madeWallet: vi.fn(async () => null) });
    render(<ClaimCard api={server(approved()).api} loadPrivy={privy.load} appId={APP_ID} />);
    const press = await within(card()).findByRole('button', { name: CLAIM_WORDS.exportKey });
    await act(async () => { fireEvent.click(press); });
    expect(line()).toBe('Privy made no wallet for this X account.');
    expect(privy.bridge.exportWallet).not.toHaveBeenCalled();
  });

  it('the card’s Export key whose Privy part fails (its wallet frame never answered) says so in one line and opens nothing (XR-ALPHA-SITE af3)', async () => {
    connect({ made: true });
    const privy = privyDouble({ madeWallet: vi.fn(async () => { throw new Error('Privy’s wallets did not load'); }) });
    render(<ClaimCard api={server(approved()).api} loadPrivy={privy.load} appId={APP_ID} />);
    const press = await within(card()).findByRole('button', { name: CLAIM_WORDS.exportKey });
    await act(async () => { fireEvent.click(press); });
    expect(line()).toBe(JOIN_WORDS.exportFailed);
    expect(privy.bridge.exportWallet).not.toHaveBeenCalled();
    expect((within(card()).getByRole('button', { name: CLAIM_WORDS.exportKey }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers no made wallet in a build without the seam, or while the Privy app ID is the placeholder', async () => {
    wallet.resumeProvidedWallet = null;
    render(<ClaimCard api={server(approved()).api} loadPrivy={privyDouble().load} appId={APP_ID} />);
    await within(card()).findByRole('button', { name: CLAIM_WORDS.useMine });
    expect(within(card()).queryByRole('button', { name: CLAIM_WORDS.makeOne })).toBeNull();
    cleanup();
    wallet.resumeProvidedWallet = ticketDouble;
    render(<ClaimCard api={server(approved()).api} loadPrivy={privyDouble().load} appId={null} />);
    await within(card()).findByRole('button', { name: CLAIM_WORDS.useMine });
    expect(within(card()).queryByRole('button', { name: CLAIM_WORDS.makeOne })).toBeNull();
  });
});
