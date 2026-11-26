import { DEMO_CHAIN_ID } from '@squarehole/domain';
import { DEMO_PERSONAS } from '@squarehole/providers';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConnectWalletButton,
  DEMO_WALLET_TITLE,
  DEMO_WRONG_CHAIN_ID,
  BOX_PERSONAS,
  PICKER_PERSONAS,
  WALLET_PERSONAS,
  WalletError,
  WalletProvider,
  chainLabel,
  createDemoWalletAdapter,
  shortAddress,
  useWallet,
  type WalletAdapter,
  type WalletContextValue,
} from '.';

// A fake injected wallet that counts every touch: the demo wallet must never read or call it (UI-09).
let ethereumTouches: string[] = [];
beforeEach(() => {
  ethereumTouches = [];
  const provider = new Proxy(
    {},
    {
      get(_target, key) {
        ethereumTouches.push(`get:${String(key)}`);
        return () => Promise.reject(new Error('unit spy wallet'));
      },
    },
  );
  Object.defineProperty(window, 'ethereum', {
    configurable: true,
    get() {
      ethereumTouches.push('window.ethereum');
      return provider;
    },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'ethereum');
  expect(ethereumTouches).toEqual([]);
});

const [holder, pastHolder, neverHeld] = DEMO_PERSONAS;
if (!holder || !pastHolder || !neverHeld) throw new Error('fixture personas missing');
const [boxA] = BOX_PERSONAS;
if (!boxA) throw new Error('box personas missing');

describe('demo wallet adapter', () => {
  it('connects as a persona, switches chain and disconnects, emitting EIP-1193-style events', async () => {
    const adapter = createDemoWalletAdapter({ latencyMs: 0 });
    const accounts: string[][] = [];
    const chains: number[] = [];
    const offAccounts = adapter.onAccountsChanged((list) => accounts.push([...list]));
    adapter.onChainChanged((chainId) => chains.push(chainId));

    expect(await adapter.connect({ personaId: holder.id })).toEqual({ account: holder.address, chainId: DEMO_CHAIN_ID, personaId: holder.id });
    expect(accounts).toEqual([]); // the first connection is the result, not an event

    await adapter.connect({ personaId: pastHolder.id, chainId: DEMO_WRONG_CHAIN_ID });
    expect(accounts).toEqual([[pastHolder.address]]);
    expect(chains).toEqual([DEMO_WRONG_CHAIN_ID]);

    await adapter.switchChain(DEMO_CHAIN_ID);
    await adapter.switchChain(DEMO_CHAIN_ID); // already there: no event
    expect(chains).toEqual([DEMO_WRONG_CHAIN_ID, DEMO_CHAIN_ID]);

    adapter.disconnect();
    adapter.disconnect(); // idempotent
    expect(accounts).toEqual([[pastHolder.address], []]);

    offAccounts();
    await adapter.connect({ personaId: holder.id });
    adapter.disconnect();
    expect(accounts).toHaveLength(2);
  });

  it('rejects unknown personas, bad chain ids and switching while disconnected', async () => {
    const adapter = createDemoWalletAdapter({ latencyMs: 0 });
    await expect(adapter.connect({ personaId: 'whale' })).rejects.toMatchObject({ code: 'unknown_persona' });
    await expect(adapter.connect()).rejects.toBeInstanceOf(WalletError);
    await expect(adapter.switchChain(DEMO_CHAIN_ID)).rejects.toMatchObject({ code: 'not_connected' });
    await expect(adapter.connect({ personaId: holder.id, chainId: 0 })).rejects.toMatchObject({ code: 'invalid_chain' });
    await adapter.connect({ personaId: holder.id });
    await expect(adapter.switchChain(-1)).rejects.toMatchObject({ code: 'invalid_chain' });
    expect(() => createDemoWalletAdapter({ latencyMs: 1.5 })).toThrow(RangeError);
  });

  it('labels chains and shortens addresses without inventing names', () => {
    expect(chainLabel(31337)).toBe('Local chain (31337)');
    expect(chainLabel(1)).toBe('Ethereum (1)');
    expect(chainLabel(11155111)).toBe('Sepolia (11155111)');
    expect(chainLabel(424242)).toBe('Chain 424242');
    expect(shortAddress('0x00000000000000000000000000000000de000001')).toBe('0x0000…0001');
  });
});

// Latest hook value, published after each commit (tests read it between acts).
const live = {} as { wallet: WalletContextValue };
function Probe() {
  const wallet = useWallet();
  useEffect(() => {
    live.wallet = wallet;
  });
  return <output data-testid="wallet">{`${wallet.status}|${wallet.account ?? '-'}|${wallet.chainId ?? '-'}|${wallet.personaId ?? '-'}`}</output>;
}

function renderWallet(adapter: WalletAdapter = createDemoWalletAdapter({ latencyMs: 0 })) {
  render(
    <WalletProvider adapter={adapter}>
      <header>
        <ConnectWalletButton />
      </header>
      <Probe />
    </WalletProvider>,
  );
  return adapter;
}

const probe = () => screen.getByTestId('wallet').textContent;
const walletButton = () => within(screen.getByRole('banner')).getByRole('button');

async function connectVia(personaTitle: string, { wrongNetwork = false } = {}) {
  await act(async () => fireEvent.click(walletButton()));
  const dialog = screen.getByRole('dialog', { name: DEMO_WALLET_TITLE });
  fireEvent.click(within(dialog).getByRole('radio', { name: personaTitle }));
  const check = within(dialog).getByRole('checkbox', { name: /Simulate wrong network/ }) as HTMLInputElement;
  if (check.checked !== wrongNetwork) fireEvent.click(check);
  await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: /^(Connect|Update) sample wallet$/ })));
}

describe('WalletProvider, ConnectWalletButton and DemoWalletDialog (UI-09)', () => {
  it('starts disconnected with a closed "Connect wallet" button and no dialog', () => {
    renderWallet();
    expect(probe()).toBe('disconnected|-|-|-');
    expect(live.wallet.kind).toBe('demo');
    expect(walletButton().getAttribute('aria-expanded')).toBe('false');
    expect(walletButton()).toBe(screen.getByRole('button', { name: 'Connect wallet' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the sample wallet on click: accounts with descriptions and the wrong-network option, no Demo word (F130)', async () => {
    renderWallet();
    await act(async () => fireEvent.click(walletButton()));
    const dialog = screen.getByRole('dialog', { name: 'Sample wallet' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(walletButton().getAttribute('aria-expanded')).toBe('true');
    const radios = within(dialog).getAllByRole('radio');
    // SH-V2-FE11 (FE10 point 3): the old pairs' holders are not offered; the adapter still knows them.
    expect(radios.map((radio) => radio.getAttribute('value'))).toEqual(['never_held', 'box_wallet_a', 'box_wallet_b']);
    expect(PICKER_PERSONAS.map((persona) => persona.id)).toEqual(['never_held', 'box_wallet_a', 'box_wallet_b']);
    expect(WALLET_PERSONAS.map((persona) => persona.id)).toEqual([...DEMO_PERSONAS.map((persona) => persona.id), 'box_wallet_a', 'box_wallet_b']);
    expect(within(dialog).queryByRole('radio', { name: 'Current holder' })).toBeNull();
    expect(within(dialog).queryByRole('radio', { name: 'Past holder' })).toBeNull();
    expect(dialog.textContent).not.toMatch(/ORCHARD|Sold everything/);
    expect(within(dialog).getByRole('radio', { name: 'Never held' }).getAttribute('aria-describedby')).toBeTruthy();
    expect(dialog.textContent).toContain('A fresh account with no positions and nothing to claim.');
    expect(dialog.textContent).toContain('Signs nothing and never opens a browser wallet.');
    expect(dialog.textContent).not.toMatch(/demo|mock|synthetic/i);
    expect(within(dialog).getByRole('checkbox', { name: /Simulate wrong network/ })).toBeTruthy();
    // Focus starts on the selected persona.
    expect(document.activeElement).toBe(within(dialog).getByRole('radio', { name: 'Never held' }));
    expect(probe()).toBe('disconnected|-|-|-'); // opening the window connects nothing
  });

  it('Escape and Cancel close without connecting, and focus returns to the button', async () => {
    renderWallet();
    walletButton().focus();
    await act(async () => fireEvent.click(walletButton()));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(walletButton());
    await act(async () => fireEvent.click(walletButton()));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(walletButton());
    expect(probe()).toBe('disconnected|-|-|-');
  });

  it('makes the page behind the open dialog inert (aria-modal), and restores it before focus returns', async () => {
    renderWallet();
    const page = screen.getByTestId('wallet').parentElement as HTMLElement;
    expect(page.hasAttribute('inert')).toBe(false);
    walletButton().focus();
    await act(async () => fireEvent.click(walletButton()));
    const dialog = screen.getByRole('dialog');
    expect(page.hasAttribute('inert')).toBe(true);
    expect(dialog.closest('[inert]')).toBeNull();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(page.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(walletButton());
  });

  it('keeps Tab inside the dialog', async () => {
    renderWallet();
    await act(async () => fireEvent.click(walletButton()));
    const dialog = screen.getByRole('dialog');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const first = within(dialog).getByRole('radio', { name: 'Never held' });
    cancel.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancel);
  });

  it('connects as the chosen persona and shows "Demo" with the short account', async () => {
    renderWallet(createDemoWalletAdapter({ latencyMs: 5 }));
    await act(async () => fireEvent.click(walletButton()));
    fireEvent.click(screen.getByRole('radio', { name: 'Box wallet A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect sample wallet' }));
    expect(probe()).toBe('disconnected|-|-|-'.replace('disconnected', 'connecting'));
    expect(screen.getByRole('button', { name: 'Connecting…' })).toHaveProperty('disabled', true);
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(probe()).toBe(`connected|${boxA.address}|${DEMO_CHAIN_ID}|box_wallet_a`);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(walletButton().getAttribute('aria-label')).toBe(`Wallet ${shortAddress(boxA.address)}`);
    expect(walletButton().textContent).toContain('Wallet');
    expect(walletButton().textContent).not.toMatch(/demo/i);
    expect(walletButton().textContent).toContain(shortAddress(boxA.address));
    expect(document.activeElement).toBe(walletButton());
  });

  it('simulates a wrong network, switches persona and chain while connected, then disconnects', async () => {
    renderWallet();
    await connectVia('Box wallet A', { wrongNetwork: true });
    expect(probe()).toBe(`connected|${boxA.address}|${DEMO_WRONG_CHAIN_ID}|box_wallet_a`);
    expect(walletButton().getAttribute('aria-label')).toBe(`Wallet ${shortAddress(boxA.address)}, wrong network`);
    expect(walletButton().textContent).toContain('Wrong network');

    await act(() => live.wallet.switchChain(DEMO_CHAIN_ID));
    expect(probe()).toBe(`connected|${boxA.address}|${DEMO_CHAIN_ID}|box_wallet_a`);

    await act(async () => fireEvent.click(walletButton()));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Connected as Box wallet A');
    expect(within(dialog).getByRole('checkbox', { name: /Simulate wrong network/ })).toHaveProperty('checked', false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await connectVia('Never held');
    expect(probe()).toBe(`connected|${neverHeld.address}|${DEMO_CHAIN_ID}|never_held`);

    await act(async () => fireEvent.click(walletButton()));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(probe()).toBe('disconnected|-|-|-');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(walletButton()).toBe(screen.getByRole('button', { name: 'Connect wallet' }));
  });

  it('follows account and chain changes the wallet reports by itself', async () => {
    const adapter = renderWallet();
    await connectVia('Never held');
    await act(async () => {
      await adapter.connect({ personaId: pastHolder.id, chainId: 11155111 });
    });
    expect(probe()).toBe(`connected|${pastHolder.address}|11155111|past_holder`);
    act(() => adapter.disconnect());
    expect(probe()).toBe('disconnected|-|-|-');
  });

  it('drops a connection that resolves after the person disconnected', async () => {
    renderWallet(createDemoWalletAdapter({ latencyMs: 10 }));
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = live.wallet.connect(holder.id);
    });
    expect(probe()).toBe('connecting|-|-|-');
    act(() => live.wallet.disconnect());
    await act(() => pending);
    expect(probe()).toBe('disconnected|-|-|-');
  });

  it('switchChain while disconnected rejects without changing state', async () => {
    renderWallet();
    await expect(live.wallet.switchChain(DEMO_CHAIN_ID)).rejects.toMatchObject({ code: 'not_connected' });
    expect(probe()).toBe('disconnected|-|-|-');
  });

  it('useWallet outside the provider fails loudly', () => {
    const Lonely = () => {
      useWallet();
      return null;
    };
    const error = console.error;
    console.error = () => undefined;
    try {
      expect(() => render(<Lonely />)).toThrow(/WalletProvider/);
    } finally {
      console.error = error;
    }
  });
});
