import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MadeWallet, PrivyBridge } from '../alpha-sepolia/privy-bridge';

const address = '0x0000000000000000000000000000000000000001';
const previousEnv = process.env;

beforeEach(() => {
  // The adapter and shell use the build's boolean literal (as in reveal-session.test.ts).
  process.env = { ...previousEnv, SH_TESTNET: 'bnb' };
  Object.assign(process.env, { SH_SEPOLIA_TRADE: true });
  vi.resetModules();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.doUnmock('./privy-load');
  vi.doUnmock('./TradeBox');
  process.env = previousEnv;
});

async function returnVisit(serverStatus: 200 | 401 | 503, privySession: boolean, nextPage?: () => Promise<ReactNode>) {
  const provider = {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_accounts') return [address];
      if (method === 'eth_chainId') return '0x61';
      throw new Error(method);
    }),
  };
  const bridge: PrivyBridge = {
    ready: vi.fn(), authenticated: vi.fn(() => privySession),
    madeWallet: vi.fn(async (): Promise<MadeWallet> => ({ address, provider })),
    signIn: vi.fn(), finishSignIn: vi.fn(), signOut: vi.fn(), identityToken: vi.fn(), exportWallet: vi.fn(), makeWallet: vi.fn(),
  };
  const load = vi.fn(async () => bridge);
  vi.doMock('./privy-load', () => ({ loadPrivyBridge: load }));
  const injected = vi.fn();
  vi.stubGlobal('ethereum', { request: injected });
  vi.stubGlobal('scrollTo', vi.fn());
  const fetcher = vi.fn(async () => serverStatus === 200
    ? Response.json({ status: 'approved', handle: 'tester', claim: null })
    : Response.json({}, { status: serverStatus }));
  vi.stubGlobal('fetch', fetcher);
  const [{ Shell }, { WalletProvider }, { REMEMBERED_KEY }, { writeSetupHint }] = await Promise.all([
    import('../../shell/Shell'), import('../wallet'), import('../wallet/injected-adapter'), import('../alpha-sepolia/setup-hint'),
  ]);
  writeSetupHint({ handle: 'tester', state: 'done' });
  localStorage.setItem(REMEMBERED_KEY, JSON.stringify({ provider: 'provided:privy', address }));
  const router = createMemoryRouter([{ element: <Shell />, children: [
    { path: '/settings', element: <></> }, { path: '*', element: await nextPage?.() ?? <></> },
  ] }], { initialEntries: ['/settings'] });
  render(<QueryClientProvider client={new QueryClient()}><WalletProvider targetChainId={97} walletKinds="browser" reconnect>
    <RouterProvider router={router} />
  </WalletProvider></QueryClientProvider>);
  return { bridge, load, injected, provider, router, fetcher };
}

it('restores the remembered signer in the top bar on a first visit to Settings without asking the browser wallet', async () => {
  const { bridge, injected, provider } = await returnVisit(200, true);
  const name = 'Wallet Privy made 0x0000…0001';
  expect(await screen.findByRole('button', { name }, { timeout: 5000 })).toBeTruthy();
  fireEvent.click(screen.getByRole('link', { name: 'Boxes' }));
  expect(screen.getByRole('button', { name })).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(bridge.madeWallet).toHaveBeenCalledTimes(1);
  expect(bridge.makeWallet).not.toHaveBeenCalled();
  expect(bridge.signIn).not.toHaveBeenCalled();
  expect(provider.request.mock.calls.map(([args]) => args.method)).toEqual(['eth_accounts', 'eth_chainId']);
  expect(injected).not.toHaveBeenCalled();
});

it.each([false, true])('leaves the wallet disconnected with an expired sign-in (server session %s)', async (serverSession) => {
  const { bridge, load, injected, provider } = await returnVisit(serverSession ? 200 : 401, false);
  if (serverSession) await waitFor(() => expect(bridge.authenticated).toHaveBeenCalled(), { timeout: 5000 });
  else {
    await screen.findByRole('link', { name: 'Sign in with X' });
    expect(load).not.toHaveBeenCalled();
  }
  expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(bridge.madeWallet).not.toHaveBeenCalled();
  expect(bridge.makeWallet).not.toHaveBeenCalled();
  expect(bridge.signIn).not.toHaveBeenCalled();
  expect(provider.request).not.toHaveBeenCalled();
  expect(injected).not.toHaveBeenCalled();
});

it.each(['/test-coins', '/box/97/0x0000000000000000000000000000000000000002'])(
  'restores on %s after the shell received a 503 on Settings', async (path) => {
    vi.doMock('./TradeBox', () => ({ TradeBox: () => null }));
    const { bridge, load, injected, provider, router, fetcher } = await returnVisit(503, true, async () => {
      const { TestCoinPage, default: TradeSlot } = await import('./TradeSlot');
      return path === '/test-coins' ? <TestCoinPage target={{ reason: 'deployment_predicted' }} />
        : <TradeSlot {...({} as Parameters<typeof TradeSlot>[0])} />;
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/alpha/me', expect.anything()));
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeTruthy();
    expect(load).not.toHaveBeenCalled();

    await act(() => router.navigate(path));
    expect(await screen.findByRole('button', { name: 'Wallet Privy made 0x0000…0001' })).toBeTruthy();
    expect(bridge.madeWallet).toHaveBeenCalledTimes(1);
    expect(bridge.signIn).not.toHaveBeenCalled();
    expect(bridge.makeWallet).not.toHaveBeenCalled();
    expect(provider.request.mock.calls.map(([args]) => args.method)).toEqual(['eth_accounts', 'eth_chainId']);
    expect(injected).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  },
);
