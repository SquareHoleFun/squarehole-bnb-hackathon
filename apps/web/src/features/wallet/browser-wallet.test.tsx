/**
 * Browser (injected) wallet, Stage C (UI-09): discovery only when the person opens the browser-wallet window, connect
 * only on a click, window.ethereum only when "Other browser wallet" is picked, account/chain events, switch (adding the
 * local anvil chain when needed), disconnect, the last-used hint that never auto-connects, and one wallet at a time.
 */
import { ACCOUNT_A, ACCOUNT_B, FakeChain, FakeWallet } from '@squarehole/chain/write/test-support';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BROWSER_WALLET_TITLE, ConnectWalletButton, DEMO_WALLET_TITLE, WalletProvider, createDemoWalletAdapter, createInjectedWalletAdapter, shortAddress, useWallet, type WalletContextValue } from '.';

const UUID = '350670db-19fa-4704-a166-e52e178b59d2';

/** A window stand-in: EIP-6963 events, and an `ethereum` property whose every read is recorded. */
class FakeWindow extends EventTarget {
  reads = 0;
  requests = 0;
  injected: FakeWallet | null = null;
  get ethereum(): unknown {
    this.reads += 1;
    return this.injected ?? undefined;
  }
}

let target: FakeWindow;
let announced: FakeWallet;
let storage: Map<string, string>;
const memoryStorage = () => ({ getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) });

beforeEach(() => {
  storage = new Map();
  target = new FakeWindow();
  announced = new FakeWallet(new FakeChain(), [ACCOUNT_A], { chainId: 31337 });
  target.addEventListener('eip6963:requestProvider', () => {
    target.requests += 1;
    target.dispatchEvent(
      Object.assign(new Event('eip6963:announceProvider'), {
        detail: { info: { uuid: UUID, name: 'Test Wallet', rdns: 'org.example.testwallet', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }, provider: announced },
      }),
    );
  });
});

afterEach(() => cleanup());

const live = {} as { wallet: WalletContextValue };
function Probe() {
  const wallet = useWallet();
  useEffect(() => {
    live.wallet = wallet;
  });
  return null;
}

/** The adapter the last render holds (its own signer, apart from the context's). */
let injectedInUse: ReturnType<typeof createInjectedWalletAdapter>;
function renderWallet(options: { defaultDialog?: 'demo' | 'browser'; targetChainId?: number; reconnect?: boolean } = {}) {
  const injectedAdapter = createInjectedWalletAdapter({ target: target as unknown as Window, storage: memoryStorage(), localRpcUrl: 'http://127.0.0.1:8552' });
  injectedInUse = injectedAdapter;
  return render(
    <WalletProvider adapter={createDemoWalletAdapter({ latencyMs: 0 })} injectedAdapter={injectedAdapter} defaultDialog={options.defaultDialog ?? 'browser'} targetChainId={options.targetChainId ?? 31337} reconnect={options.reconnect ?? false}>
      <ConnectWalletButton />
      <Probe />
    </WalletProvider>,
  );
}

const walletButton = () => document.querySelector<HTMLButtonElement>('.sh-wallet-button') as HTMLButtonElement;
/** Holds the wallet's own window for its next account request; the returned press is the person's yes in it. */
function holdAccountRequest(wallet: FakeWallet) {
  const answer = wallet.request;
  let yes: () => void = () => undefined;
  const asked = new Promise<void>((resolve) => { yes = resolve; });
  wallet.request = async (args) => {
    if (args.method === 'eth_requestAccounts') await asked;
    return answer(args);
  };
  return () => act(async () => {
    yes();
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
const open = () => act(async () => void fireEvent.click(walletButton()));
const dialog = (name: string) => screen.getByRole('dialog', { name });

describe('browser wallet (injected adapter)', () => {
  it('nothing is discovered, read or requested on render or when the demo wallet window opens', async () => {
    renderWallet({ defaultDialog: 'demo' });
    expect(target.requests).toBe(0);
    await open();
    expect(dialog(DEMO_WALLET_TITLE)).toBeTruthy();
    expect(target.requests).toBe(0);
    expect(target.reads).toBe(0);
    expect(announced.requests).toEqual([]);
    // Choosing "Use a browser wallet instead" opens the browser-wallet window: only now are wallets asked to announce.
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Use a browser wallet instead' })));
    expect(dialog(BROWSER_WALLET_TITLE)).toBeTruthy();
    expect(target.requests).toBe(1);
    expect(target.reads).toBe(0);
    expect(announced.requests).toEqual([]);
  });

  it('a click on a listed wallet connects it (one account request, then the chain id) and the top bar shows it', async () => {
    renderWallet();
    await open();
    const row = within(dialog(BROWSER_WALLET_TITLE)).getByRole('button', { name: /Test Wallet/ });
    expect(announced.requests).toEqual([]);
    await act(async () => void fireEvent.click(row));
    expect(announced.accountRequests).toBe(1);
    expect(announced.requests).toHaveLength(2);
    expect(announced.requests[1]).toBe('eth_chainId');
    expect(live.wallet).toMatchObject({ status: 'connected', kind: 'injected', account: ACCOUNT_A, chainId: 31337, walletName: 'Test Wallet' });
    expect(live.wallet.signer).not.toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(walletButton().getAttribute('aria-label')).toBe(`Test Wallet ${shortAddress(ACCOUNT_A)}`);
    expect(walletButton().textContent).not.toContain('Demo');
    expect(storage.get('sh.wallet.last-rdns')).toBe('org.example.testwallet');
  });

  it('follows accountsChanged / chainChanged; an empty account list disconnects', async () => {
    renderWallet();
    await open();
    await act(async () => void fireEvent.click(within(dialog(BROWSER_WALLET_TITLE)).getByRole('button', { name: /Test Wallet/ })));
    act(() => announced.setAccounts([ACCOUNT_B]));
    expect(live.wallet.account).toBe(ACCOUNT_B);
    act(() => announced.setChain(11_155_111));
    expect(live.wallet.chainId).toBe(11_155_111);
    expect(walletButton().getAttribute('aria-label')).toBe(`Test Wallet ${shortAddress(ACCOUNT_B)}, wrong network`);
    act(() => announced.setAccounts([]));
    expect(live.wallet.status).toBe('disconnected');
  });

  it('wrong network: the window offers a switch to the page’s chain; the local anvil chain is added when unknown', async () => {
    announced = new FakeWallet(new FakeChain(), [ACCOUNT_A], { chainId: 11_155_111, knownChains: [11_155_111] });
    renderWallet({ targetChainId: 31337 });
    await open();
    await act(async () => void fireEvent.click(within(dialog(BROWSER_WALLET_TITLE)).getByRole('button', { name: /Test Wallet/ })));
    expect(walletButton().dataset.wrongNetwork).toBe('true');
    await open();
    await act(async () => void fireEvent.click(within(dialog(BROWSER_WALLET_TITLE)).getByRole('button', { name: 'Switch to Local anvil chain (31337)' })));
    expect(announced.requests.slice(2)).toEqual(['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain']);
    expect(live.wallet.chainId).toBe(31337);
    expect(walletButton().dataset.wrongNetwork).toBeUndefined();
  });

  it('Disconnect forgets the wallet and asks it to revoke the permission', async () => {
    renderWallet();
    await open();
    await act(async () => void fireEvent.click(within(dialog(BROWSER_WALLET_TITLE)).getByRole('button', { name: /Test Wallet/ })));
    await open();
    await act(async () => void fireEvent.click(within(dialog(BROWSER_WALLET_TITLE)).getByRole('button', { name: 'Disconnect' })));
    expect(live.wallet.status).toBe('disconnected');
    await waitFor(() => expect(announced.requests).toContain('wallet_revokePermissions'));
    expect(announced.listenerCount('accountsChanged')).toBe(0);
  });

  it('"Other browser wallet" reads window.ethereum only on that click, and says so when there is none', async () => {
    renderWallet();
    await open();
    expect(target.reads).toBe(0);
    await act(async () => void fireEvent.click(within(dialog(BROWSER_WALLET_TITLE)).getByRole('button', { name: /Other browser wallet/ })));
    expect(target.reads).toBe(1);
    expect(within(dialog(BROWSER_WALLET_TITLE)).getByRole('alert').textContent).toMatch(/No browser wallet was found/);
    expect(live.wallet.status).toBe('disconnected');
    target.injected = new FakeWallet(new FakeChain(), [ACCOUNT_B], { chainId: 31337 });
    await act(async () => void fireEvent.click(within(dialog(BROWSER_WALLET_TITLE)).getByRole('button', { name: /Other browser wallet/ })));
    expect(live.wallet).toMatchObject({ status: 'connected', account: ACCOUNT_B, walletName: 'Browser wallet' });
  });

  it('a declined connection (4001) shows the reason and stays disconnected', async () => {
    announced.sendBehaviour = 'reject';
    renderWallet();
    await open();
    await act(async () => void fireEvent.click(within(dialog(BROWSER_WALLET_TITLE)).getByRole('button', { name: /Test Wallet/ })));
    expect(within(dialog(BROWSER_WALLET_TITLE)).getByRole('alert').textContent).toMatch(/declined in the wallet/);
    expect(live.wallet.status).toBe('disconnected');
  });

  it('the last-used hint marks the wallet but never connects it by itself', async () => {
    storage.set('sh.wallet.last-rdns', 'org.example.testwallet');
    renderWallet();
    expect(announced.requests).toEqual([]);
    await open();
    expect(within(dialog(BROWSER_WALLET_TITLE)).getByRole('button', { name: /Test Wallet/ }).textContent).toContain('last used here');
    expect(announced.requests).toEqual([]);
    expect(live.wallet.status).toBe('disconnected');
  });

  it('one wallet at a time: connecting the demo wallet lets go of the browser wallet', async () => {
    renderWallet();
    await open();
    await act(async () => void fireEvent.click(within(dialog(BROWSER_WALLET_TITLE)).getByRole('button', { name: /Test Wallet/ })));
    await act(() => live.wallet.connect('current_holder'));
    expect(live.wallet).toMatchObject({ status: 'connected', kind: 'demo', signer: null, walletName: null });
    expect(announced.listenerCount('accountsChanged')).toBe(0);
    await waitFor(() => expect(announced.requests).toContain('wallet_revokePermissions'));
  });

  it('a yes that comes after another wallet was picked changes nothing: pick it, Cancel, pick "Other browser wallet", yes there, then yes in the first (XR-ALPHA-SITE af4)', async () => {
    const yesInFirst = holdAccountRequest(announced);
    const other = new FakeWallet(new FakeChain(), [ACCOUNT_B], { chainId: 31337 });
    const yesInOther = holdAccountRequest(other);
    target.injected = other;
    renderWallet();
    await open();
    await act(async () => void fireEvent.click(within(dialog(BROWSER_WALLET_TITLE)).getByRole('button', { name: /Test Wallet/ })));
    await act(async () => void fireEvent.click(within(dialog(BROWSER_WALLET_TITLE)).getByRole('button', { name: 'Cancel' })));
    expect(screen.queryByRole('dialog')).toBeNull();
    await open();
    await act(async () => void fireEvent.click(within(dialog(BROWSER_WALLET_TITLE)).getByRole('button', { name: /Other browser wallet/ })));
    await yesInOther();
    await yesInFirst();
    // The wallet picked last stays everywhere: the top bar, the context and its signer, the adapter's signer, the memory.
    const stays = () => {
      expect(walletButton().getAttribute('aria-label')).toBe(`Browser wallet ${shortAddress(ACCOUNT_B)}`);
      expect(live.wallet).toMatchObject({ status: 'connected', kind: 'injected', account: ACCOUNT_B, walletName: 'Browser wallet' });
      expect(live.wallet.signer?.walletName).toBe('Browser wallet');
      expect(injectedInUse.signer?.walletName).toBe('Browser wallet');
      expect(JSON.parse(storage.get('sh.wallet.connected.v1') ?? 'null')).toEqual({ provider: 'window.ethereum', address: ACCOUNT_B });
    };
    stays();
    // The first wallet: its yes is not taken, so nothing listens to it and nothing is revoked in it.
    expect(['accountsChanged', 'chainChanged', 'disconnect'].map((event) => announced.listenerCount(event))).toEqual([0, 0, 0]);
    expect(announced.requests).toEqual(['eth_requestAccounts', 'eth_chainId']);
    expect(other.requests).not.toContain('wallet_revokePermissions');
    // No window and no error text: the refused yes belonged to a window the person had closed.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.textContent).not.toContain('A later choice');
    await act(async () => { announced.emit('accountsChanged', [ACCOUNT_A]); });
    stays();
  });
});

describe('F135: a refresh keeps the browser wallet connected, silently', () => {
  const REMEMBERED = 'sh.wallet.connected.v1';
  /** A page load later: a fresh provider and adapter over the same device storage and the same wallet. */
  const reload = (options: { reconnect?: boolean } = {}) => {
    cleanup();
    announced.requests = [];
    announced.accountRequests = 0;
    target.requests = 0;
    target.reads = 0;
    return renderWallet({ reconnect: options.reconnect ?? true });
  };
  const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  async function connectByClick() {
    renderWallet({ reconnect: true });
    await open();
    await act(async () => void fireEvent.click(within(dialog(BROWSER_WALLET_TITLE)).getByRole('button', { name: /Test Wallet/ })));
    expect(live.wallet.status).toBe('connected');
  }

  it('without a remembered connect, a provider that may reconnect touches nothing: no discovery, no window.ethereum, no request', async () => {
    renderWallet({ reconnect: true });
    await settle();
    expect(target.requests).toBe(0);
    expect(target.reads).toBe(0);
    expect(announced.requests).toEqual([]);
    expect(live.wallet.status).toBe('disconnected');
  });

  it('a click connect is remembered (the wallet by rdns, the address); the next load reconnects with eth_accounts and eth_chainId only', async () => {
    await connectByClick();
    expect(JSON.parse(storage.get(REMEMBERED) ?? 'null')).toEqual({ provider: 'eip6963:org.example.testwallet', address: ACCOUNT_A });
    reload();
    await waitFor(() => expect(live.wallet.status).toBe('connected'));
    expect(live.wallet).toMatchObject({ kind: 'injected', account: ACCOUNT_A, chainId: 31337, walletName: 'Test Wallet' });
    expect(live.wallet.signer).not.toBeNull();
    // Never an account request (the one that opens a wallet window): only the two silent reads, after one discovery ping.
    expect(announced.accountRequests).toBe(0);
    expect(announced.requests).toEqual(['eth_accounts', 'eth_chainId']);
    expect(target.requests).toBe(1);
    expect(target.reads).toBe(0);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(walletButton().getAttribute('aria-label')).toBe(`Test Wallet ${shortAddress(ACCOUNT_A)}`);
  });

  it('behind the terms gate (reconnect off) a remembered wallet is not touched either', async () => {
    await connectByClick();
    reload({ reconnect: false });
    await settle();
    expect(target.requests).toBe(0);
    expect(announced.requests).toEqual([]);
    expect(live.wallet.status).toBe('disconnected');
  });

  it('Disconnect forgets it: the next load touches nothing', async () => {
    await connectByClick();
    await open();
    await act(async () => void fireEvent.click(within(dialog(BROWSER_WALLET_TITLE)).getByRole('button', { name: 'Disconnect' })));
    expect(storage.has(REMEMBERED)).toBe(false);
    reload();
    await settle();
    expect(target.requests).toBe(0);
    expect(announced.requests).toEqual([]);
    expect(live.wallet.status).toBe('disconnected');
  });

  it('a wallet that shares accounts but no longer the remembered one stays disconnected, and the memory is forgotten', async () => {
    await connectByClick();
    announced.accounts = [ACCOUNT_B];
    reload();
    await settle();
    expect(live.wallet.status).toBe('disconnected');
    expect(announced.requests).toEqual(['eth_accounts']);
    expect(storage.has(REMEMBERED)).toBe(false);
    reload();
    await settle();
    expect(announced.requests).toEqual([]);
  });

  it('a locked wallet (no account shared) keeps the memory: the load after it is unlocked reconnects', async () => {
    await connectByClick();
    announced.accounts = [];
    reload();
    await settle();
    expect(live.wallet.status).toBe('disconnected');
    expect(announced.requests).toEqual(['eth_accounts']);
    expect(storage.has(REMEMBERED)).toBe(true);
    announced.accounts = [ACCOUNT_A];
    reload();
    await waitFor(() => expect(live.wallet).toMatchObject({ status: 'connected', account: ACCOUNT_A }));
    expect(announced.accountRequests).toBe(0);
  });

  it('only as the remembered account: another active account in the wallet means a click, and the memory stays', async () => {
    await connectByClick();
    announced.accounts = [ACCOUNT_B, ACCOUNT_A];
    reload();
    await settle();
    expect(live.wallet.status).toBe('disconnected');
    expect(announced.requests).toEqual(['eth_accounts']);
    expect(JSON.parse(storage.get(REMEMBERED) ?? 'null')).toMatchObject({ address: ACCOUNT_A });
  });

  it('a wallet that empties its accounts while connected (it locked) shows disconnected and keeps the memory', async () => {
    await connectByClick();
    act(() => announced.setAccounts([]));
    expect(live.wallet.status).toBe('disconnected');
    expect(storage.has(REMEMBERED)).toBe(true);
  });

  it('a provider that goes away mid-resume lets go quietly: no session adopted, nothing revoked, the memory kept', async () => {
    await connectByClick();
    reload();
    cleanup();
    await settle();
    expect(announced.requests).not.toContain('wallet_revokePermissions');
    expect(announced.listenerCount('accountsChanged')).toBe(0);
    expect(storage.has(REMEMBERED)).toBe(true);
  });

  it('window.ethereum is read on load only because this device connected "Browser wallet" before', async () => {
    target.injected = new FakeWallet(new FakeChain(), [ACCOUNT_B], { chainId: 31337 });
    renderWallet({ reconnect: true });
    await open();
    await act(async () => void fireEvent.click(within(dialog(BROWSER_WALLET_TITLE)).getByRole('button', { name: /Other browser wallet/ })));
    expect(JSON.parse(storage.get(REMEMBERED) ?? 'null')).toEqual({ provider: 'window.ethereum', address: ACCOUNT_B });
    const injected = target.injected;
    reload();
    injected.requests = [];
    injected.accountRequests = 0;
    await waitFor(() => expect(live.wallet).toMatchObject({ status: 'connected', account: ACCOUNT_B, walletName: 'Browser wallet' }));
    expect(target.reads).toBe(1);
    expect(target.requests).toBe(0);
    expect(injected.accountRequests).toBe(0);
    expect(injected.requests).toEqual(['eth_accounts', 'eth_chainId']);
  });

  it('a malformed memory is ignored and touches nothing', async () => {
    for (const value of ['not json', JSON.stringify({ provider: 'eip6963:<script>', address: ACCOUNT_A }), JSON.stringify({ provider: 'window.ethereum', address: '0x1234' }), JSON.stringify(['window.ethereum'])]) {
      storage.set(REMEMBERED, value);
      reload();
      await settle();
      expect(target.requests, value).toBe(0);
      expect(target.reads, value).toBe(0);
      expect(live.wallet.status, value).toBe('disconnected');
    }
  });

  it('a failed switch to another browser wallet shows disconnected, not the old wallet, and forgets the old one (FE10 point 13)', async () => {
    await connectByClick();
    expect(JSON.parse(storage.get(REMEMBERED) ?? 'null')).toEqual({ provider: 'eip6963:org.example.testwallet', address: ACCOUNT_A });
    target.injected = new FakeWallet(new FakeChain(), [ACCOUNT_B], { chainId: 31337 });
    target.injected.sendBehaviour = 'reject';
    await open();
    await act(async () => void fireEvent.click(within(dialog(BROWSER_WALLET_TITLE)).getByRole('button', { name: /Other browser wallet/ })));
    expect(within(dialog(BROWSER_WALLET_TITLE)).getByRole('alert').textContent).toMatch(/declined in the wallet/);
    // The adapter let go of Test Wallet to try the other one: the top bar says so, and nothing can sign.
    expect(live.wallet).toMatchObject({ status: 'disconnected', account: null, signer: null });
    expect(`${walletButton().getAttribute('aria-label') ?? ''} ${walletButton().textContent}`).not.toContain(shortAddress(ACCOUNT_A));
    await waitFor(() => expect(announced.requests).toContain('wallet_revokePermissions'));
    expect(storage.has(REMEMBERED)).toBe(false);
    // A refresh then touches nothing: the old wallet does not come back silently.
    reload();
    await settle();
    expect(live.wallet.status).toBe('disconnected');
    expect(announced.requests).toEqual([]);
  });

  it('a failed reconnect of the same browser wallet keeps its memory: the next load resumes it silently', async () => {
    await connectByClick();
    announced.sendBehaviour = 'reject';
    await open();
    await act(async () => void fireEvent.click(within(dialog(BROWSER_WALLET_TITLE)).getByRole('button', { name: /Test Wallet/ })));
    expect(live.wallet).toMatchObject({ status: 'disconnected', signer: null });
    expect(announced.requests).not.toContain('wallet_revokePermissions');
    expect(JSON.parse(storage.get(REMEMBERED) ?? 'null')).toEqual({ provider: 'eip6963:org.example.testwallet', address: ACCOUNT_A });
    announced.sendBehaviour = 'send';
    reload();
    await waitFor(() => expect(live.wallet).toMatchObject({ status: 'connected', account: ACCOUNT_A }));
    expect(announced.accountRequests).toBe(0);
  });

  it('a click while it reconnects wins: connecting the demo wallet leaves the browser wallet and forgets it', async () => {
    await connectByClick();
    reload();
    await act(() => live.wallet.connect('current_holder'));
    await settle();
    expect(live.wallet).toMatchObject({ status: 'connected', kind: 'demo' });
    expect(storage.has(REMEMBERED)).toBe(false);
    expect(announced.accountRequests).toBe(0);
  });
});
