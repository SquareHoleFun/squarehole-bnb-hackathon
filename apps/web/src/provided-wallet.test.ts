// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ACCOUNT_A, ACCOUNT_B, FakeChain, FakeWallet } from '@squarehole/chain/write/test-support';
import { build, type Rolldown } from 'vite';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * F161 (4), SH-ALPHA-SITE: the wallet context's seam for a wallet the page holds itself (the Sepolia alpha's wallet
 * Privy made, features/wallet/injected-adapter.ts `connectProvider`). It exists where the trade literal is `true` and
 * folds away everywhere else, so the unit tests (which never define the literal) build the adapter as the site does,
 * with each literal, and run what each build ships.
 */
type Adapter = {
  connect(request?: { walletId?: string }): Promise<{ account: string; chainId: number }>;
  connectProvider: ((wallet: { id: string; name: string; provider: unknown; resume?: { address: string } }) => Promise<{ account: string; chainId: number }>) | null;
  resume(): Promise<unknown>;
  disconnect(): void;
  readonly signer: { walletName: string; confirmsInPage?: true } | null;
};
type Module = {
  createInjectedWalletAdapter(options: { target: EventTarget; storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }): Adapter;
  readRemembered(storage: Pick<Storage, 'getItem'>): { provider: string; address: string } | null;
  REMEMBERED_KEY: string;
  BROWSER_WALLET_ID: string;
};

async function adapterBuilt(trade: boolean): Promise<{ module: Module; code: string }> {
  const result = await build({
    configFile: false, root: WEB, logLevel: 'silent', publicDir: false,
    define: { 'import.meta.env.SH_SEPOLIA_TRADE': JSON.stringify(trade), 'import.meta.env.SH_PRODUCTION': 'true' },
    build: { write: false, minify: false, lib: { entry: join(WEB, 'src/features/wallet/injected-adapter.ts'), formats: ['es'], fileName: 'adapter' } },
  }) as Rolldown.RolldownOutput[] | Rolldown.RolldownOutput;
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((output) => output.output);
  const chunk = outputs.find((item) => item.type === 'chunk' && item.isEntry);
  if (!chunk || chunk.type !== 'chunk') throw new Error('no adapter chunk');
  const folder = join(WEB, '.cache/provided-wallet-test');
  mkdirSync(folder, { recursive: true });
  const dir = mkdtempSync(join(folder, trade ? 'trade-' : 'mainnet-'));
  const file = join(dir, 'adapter.mjs');
  writeFileSync(file, chunk.code);
  return { module: await import(/* @vite-ignore */ pathToFileURL(file).href) as Module, code: chunk.code };
}

/** A browser wallet (`window.ethereum`) whose account request waits for the person's answer: `yes()` lets it through. */
function heldWallet(accounts: ConstructorParameters<typeof FakeWallet>[1]) {
  const wallet = new FakeWallet(new FakeChain(), accounts, { chainId: 11155111 });
  const answer = wallet.request;
  let yes: () => void = () => undefined;
  const asked = new Promise<void>((resolve) => { yes = resolve; });
  wallet.request = async (args) => {
    if (args.method === 'eth_requestAccounts') await asked;
    return answer(args);
  };
  return { wallet, yes, target: Object.assign(new EventTarget(), { ethereum: wallet }) };
}

const memory = () => {
  const map = new Map<string, string>();
  return { map, storage: { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) } };
};

describe('a wallet the page holds itself (F161 (4), SH-ALPHA-SITE)', () => {
  it('in a build with the trade literal: connects through its own provider, says it confirms in the page, and is remembered by its kind', async () => {
    const { module } = await adapterBuilt(true);
    const { map, storage } = memory();
    const adapter = module.createInjectedWalletAdapter({ target: new EventTarget(), storage });
    const provider = new FakeWallet(new FakeChain(), [ACCOUNT_A], { chainId: 11155111 });
    expect(typeof adapter.connectProvider).toBe('function');
    const connection = await adapter.connectProvider?.({ id: 'privy', name: 'Wallet Privy made', provider });
    expect(connection).toMatchObject({ account: ACCOUNT_A, chainId: 11155111 });
    expect(adapter.signer).toMatchObject({ walletName: 'Wallet Privy made', confirmsInPage: true });
    expect([...provider.requests]).toEqual(['eth_requestAccounts', 'eth_chainId']);
    const remembered = JSON.parse(map.get(module.REMEMBERED_KEY) ?? 'null') as { provider: string; address: string };
    expect(remembered).toEqual({ provider: 'provided:privy', address: ACCOUNT_A });
    expect(module.readRemembered(storage)).toEqual({ provider: 'provided:privy', address: ACCOUNT_A });
    // The adapter's own reconnect on load leaves it to its owner (the trade folder), and keeps the memory.
    const fresh = module.createInjectedWalletAdapter({ target: new EventTarget(), storage });
    expect(await fresh.resume()).toBeNull();
    expect(map.has(module.REMEMBERED_KEY)).toBe(true);
    adapter.disconnect();
    expect(map.has(module.REMEMBERED_KEY)).toBe(false);
  }, shLimit(120_000));

  it('a reconnect on load asks the provider only eth_accounts (and its chain), never an account request, and only for the same address', async () => {
    const { module } = await adapterBuilt(true);
    const { storage } = memory();
    const adapter = module.createInjectedWalletAdapter({ target: new EventTarget(), storage });
    const provider = new FakeWallet(new FakeChain(), [ACCOUNT_A], { chainId: 11155111 });
    await adapter.connectProvider?.({ id: 'privy', name: 'Wallet Privy made', provider, resume: { address: ACCOUNT_A } });
    expect([...provider.requests]).toEqual(['eth_accounts', 'eth_chainId']);
    // Nothing connected (as on a page load): a provider that shares another address is refused after eth_accounts.
    adapter.disconnect();
    const other = new FakeWallet(new FakeChain(), [ACCOUNT_B], { chainId: 11155111 });
    await expect(adapter.connectProvider?.({ id: 'privy', name: 'Wallet Privy made', provider: other, resume: { address: ACCOUNT_A } })).rejects.toThrow('The wallet no longer shares that address.');
    expect([...other.requests]).toEqual(['eth_accounts']);
    await expect(adapter.connectProvider?.({ id: 'Bad Id', name: 'x', provider })).rejects.toThrow('Unknown wallet.');
  }, shLimit(120_000));

  it('a reconnect on load never takes the place of a wallet connected now (XR-ALPHA-SITE af1): refused, and that wallet stays', async () => {
    const { module } = await adapterBuilt(true);
    const { map, storage } = memory();
    const adapter = module.createInjectedWalletAdapter({ target: new EventTarget(), storage });
    const chosen = new FakeWallet(new FakeChain(), [ACCOUNT_B], { chainId: 11155111 });
    await adapter.connectProvider?.({ id: 'chosen', name: 'The wallet picked', provider: chosen });
    const late = new FakeWallet(new FakeChain(), [ACCOUNT_A], { chainId: 11155111 });
    await expect(adapter.connectProvider?.({ id: 'privy', name: 'Wallet Privy made', provider: late, resume: { address: ACCOUNT_A } })).rejects.toThrow('Another wallet was chosen meanwhile.');
    expect([...late.requests]).toEqual([]);
    expect(adapter.signer).toMatchObject({ walletName: 'The wallet picked' });
    expect(JSON.parse(map.get(module.REMEMBERED_KEY) ?? 'null')).toEqual({ provider: 'provided:chosen', address: ACCOUNT_B });
  }, shLimit(120_000));

  it('a browser wallet’s yes that comes after the made wallet connected changes nothing: not adopted, not revoked (XR-ALPHA-SITE af3, order C)', async () => {
    const { module } = await adapterBuilt(true);
    const { map, storage } = memory();
    const mine = heldWallet([ACCOUNT_B]);
    const adapter = module.createInjectedWalletAdapter({ target: mine.target, storage });
    // "Browser wallet" pressed; its window stays open while the wallet Privy made connects, then the person says yes.
    const connecting = adapter.connect({ walletId: module.BROWSER_WALLET_ID });
    connecting.catch(() => undefined);
    const made = new FakeWallet(new FakeChain(), [ACCOUNT_A], { chainId: 11155111 });
    await adapter.connectProvider?.({ id: 'privy', name: 'Wallet Privy made', provider: made });
    mine.yes();
    await expect(connecting).rejects.toThrow('A later choice took its place.');
    expect(adapter.signer).toMatchObject({ walletName: 'Wallet Privy made', confirmsInPage: true });
    expect(JSON.parse(map.get(module.REMEMBERED_KEY) ?? 'null')).toEqual({ provider: 'provided:privy', address: ACCOUNT_A });
    expect([...mine.wallet.requests]).toEqual(['eth_requestAccounts', 'eth_chainId']);
    expect(mine.wallet.listenerCount('accountsChanged') + mine.wallet.listenerCount('chainChanged') + mine.wallet.listenerCount('disconnect')).toBe(0);
    mine.wallet.emit('accountsChanged', [ACCOUNT_B]);
    expect(adapter.signer).toMatchObject({ walletName: 'Wallet Privy made' });
  }, shLimit(120_000));

  it('in a build without it (mainnet) too: a browser wallet’s yes after a disconnect is not adopted, remembered or revoked (XR-ALPHA-SITE af3)', async () => {
    const { module } = await adapterBuilt(false);
    const { map, storage } = memory();
    const mine = heldWallet([ACCOUNT_B]);
    const adapter = module.createInjectedWalletAdapter({ target: mine.target, storage });
    const connecting = adapter.connect({ walletId: module.BROWSER_WALLET_ID });
    connecting.catch(() => undefined);
    adapter.disconnect();
    mine.yes();
    await expect(connecting).rejects.toThrow('A later choice took its place.');
    expect(adapter.signer).toBeNull();
    expect(map.has(module.REMEMBERED_KEY)).toBe(false);
    expect([...mine.wallet.requests]).toEqual(['eth_requestAccounts', 'eth_chainId']);
    expect(mine.wallet.listenerCount('accountsChanged')).toBe(0);
  }, shLimit(120_000));

  it('in a build without it (mainnet): no seam, no such memory, and none of its words in the code', async () => {
    const { module, code } = await adapterBuilt(false);
    const { storage, map } = memory();
    expect(module.createInjectedWalletAdapter({ target: new EventTarget(), storage }).connectProvider).toBeNull();
    map.set(module.REMEMBERED_KEY, JSON.stringify({ provider: 'provided:privy', address: ACCOUNT_A }));
    expect(module.readRemembered(storage)).toBeNull();
    expect(code).not.toContain('confirmsInPage');
    expect(code).not.toContain('Another wallet was chosen meanwhile.');
    expect(code).not.toContain('no longer shares that address');
  }, shLimit(120_000));
});
