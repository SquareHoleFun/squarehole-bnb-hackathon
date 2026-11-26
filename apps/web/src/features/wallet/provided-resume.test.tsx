import { ACCOUNT_A, ACCOUNT_B } from '@squarehole/chain/write/test-support';
import { act, cleanup, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WalletProvider, createDemoWalletAdapter, useWallet, type InjectedWalletAdapter, type ProvidedWallet, type WalletConnection, type WalletContextValue } from '.';

/**
 * F161 (4), SH-ALPHA-SITE, XR-ALPHA-SITE af1: the wallet context's ticket for bringing a wallet the page holds itself
 * back without a press (`resumeProvidedWallet`, used by the made wallet's reconnect on load). A ticket taken while nothing
 * is connected ends at the person's next connect or disconnect, and at a wallet that came back by itself (F135); once it
 * has ended, its `connect` asks the adapter nothing and leaves the person's wallet as it is. The adapter here is a double
 * with the seam present, as in a Sepolia trade build (unit tests never define the trade literal).
 */
const SEPOLIA = 11_155_111;

function adapterDouble(options: { provided?: boolean } = {}) {
  let signer: InjectedWalletAdapter['signer'] = null;
  const calls: string[] = [];
  let release: (() => void) | null = null;
  const adapter: InjectedWalletAdapter = {
    kind: 'injected',
    connect: vi.fn(async (request = {}): Promise<WalletConnection> => {
      calls.push(`connect ${request.walletId ?? ''}`);
      signer = { request: vi.fn(), walletName: 'Browser wallet' };
      return { account: ACCOUNT_B, chainId: SEPOLIA, personaId: null, walletName: 'Browser wallet' };
    }),
    connectProvider: options.provided === false ? null : vi.fn(async (wallet: ProvidedWallet): Promise<WalletConnection> => {
      calls.push(`provided ${wallet.id}`);
      signer = { request: vi.fn(), walletName: wallet.name, confirmsInPage: true };
      return { account: ACCOUNT_A, chainId: SEPOLIA, personaId: null, walletName: wallet.name };
    }),
    disconnect: vi.fn(() => { calls.push('disconnect'); signer = null; }),
    switchChain: vi.fn(async () => undefined),
    onAccountsChanged: () => () => undefined,
    onChainChanged: () => () => undefined,
    discover: () => () => undefined,
    resume: vi.fn(async () => null),
    release: vi.fn(),
    get signer() { return signer; },
  };
  return {
    adapter,
    calls,
    /** A wallet that came back by itself (F135): the adapter holds it before the context hears of it. */
    resumedByItself: () => { signer = { request: vi.fn(), walletName: 'Browser wallet' }; },
    /** Holds the person's next connect until `free()`. */
    hold: () => {
      const held = new Promise<void>((resolve) => { release = resolve; });
      vi.mocked(adapter.connect).mockImplementationOnce(async (request = {}) => {
        calls.push(`connect ${request.walletId ?? ''}`);
        await held;
        signer = { request: vi.fn(), walletName: 'Browser wallet' };
        return { account: ACCOUNT_B, chainId: SEPOLIA, personaId: null, walletName: 'Browser wallet' };
      });
      return () => release?.();
    },
  };
}

const live = {} as { wallet: WalletContextValue };
function Probe() {
  const wallet = useWallet();
  useEffect(() => { live.wallet = wallet; });
  return null;
}
function renderWallet(adapter: InjectedWalletAdapter) {
  return render(
    <WalletProvider adapter={createDemoWalletAdapter({ latencyMs: 0 })} injectedAdapter={adapter} defaultDialog="browser" walletKinds="browser" targetChainId={SEPOLIA}>
      <Probe />
    </WalletProvider>,
  );
}
const made = (): ProvidedWallet => ({ id: 'privy', name: 'Wallet Privy made', provider: { request: vi.fn(), on: vi.fn(), removeListener: vi.fn() }, resume: { address: ACCOUNT_A } });

afterEach(cleanup);

describe('the wallet context’s ticket for a reconnect on load (XR-ALPHA-SITE af1)', () => {
  it('connects the wallet while nothing changed since the ticket was taken', async () => {
    const double = adapterDouble();
    renderWallet(double.adapter);
    const ticket = live.wallet.resumeProvidedWallet?.();
    expect(ticket?.current()).toBe(true);
    let done = false;
    await act(async () => { done = (await ticket?.connect(made())) ?? false; });
    expect(done).toBe(true);
    expect(double.calls).toEqual(['provided privy']);
    expect(live.wallet).toMatchObject({ status: 'connected', account: ACCOUNT_A, walletName: 'Wallet Privy made' });
  });

  it('the review’s case: a browser wallet the person connected after the ticket stays, and the ticket asks the adapter nothing', async () => {
    const double = adapterDouble();
    renderWallet(double.adapter);
    const ticket = live.wallet.resumeProvidedWallet?.();
    await act(async () => { await live.wallet.connectBrowserWallet('org.example.wallet'); });
    expect(ticket?.current()).toBe(false);
    let done = true;
    await act(async () => { done = (await ticket?.connect(made())) ?? true; });
    expect(done).toBe(false);
    expect(double.calls).toEqual(['connect org.example.wallet']);
    expect(live.wallet).toMatchObject({ status: 'connected', account: ACCOUNT_B, walletName: 'Browser wallet' });
  });

  it('ends the moment the person presses connect, before that connect finishes, and the person’s connect still lands', async () => {
    const double = adapterDouble();
    renderWallet(double.adapter);
    const ticket = live.wallet.resumeProvidedWallet?.();
    const free = double.hold();
    let pressed: Promise<void> = Promise.resolve();
    act(() => { pressed = live.wallet.connectBrowserWallet('org.example.wallet'); });
    expect(ticket?.current()).toBe(false);
    let done = true;
    await act(async () => { done = (await ticket?.connect(made())) ?? true; });
    expect(done).toBe(false);
    await act(async () => { free(); await pressed; });
    expect(double.calls).toEqual(['connect org.example.wallet']);
    expect(live.wallet).toMatchObject({ status: 'connected', account: ACCOUNT_B });
  });

  it('ends at a disconnect, and at a wallet that came back by itself', async () => {
    const first = adapterDouble();
    renderWallet(first.adapter);
    const afterDisconnect = live.wallet.resumeProvidedWallet?.();
    act(() => live.wallet.disconnect());
    expect(afterDisconnect?.current()).toBe(false);
    expect(await afterDisconnect?.connect(made())).toBe(false);
    expect(first.calls).toEqual(['disconnect']);
    cleanup();
    const second = adapterDouble();
    renderWallet(second.adapter);
    const ticket = live.wallet.resumeProvidedWallet?.();
    second.resumedByItself();
    expect(ticket?.current()).toBe(false);
    expect(await ticket?.connect(made())).toBe(false);
    expect(second.calls).toEqual([]);
  });

  it('is not there without the seam (every build but the Sepolia alpha’s)', () => {
    renderWallet(adapterDouble({ provided: false }).adapter);
    expect(live.wallet.resumeProvidedWallet).toBeNull();
    expect(live.wallet.connectProvidedWallet).toBeNull();
  });
});
