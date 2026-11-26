/**
 * F161 (4), SH-ALPHA-SITE: the browser suites' stand-in for Privy (Privy has no test X login, and the suites never
 * reach Privy's service). Development builds opted in with `SH_ALPHA_STANDIN=1` load it in place of privy-live.tsx
 * (privy-load.ts); every production build refuses that opt-in (build-target.ts `alphaStandinOf`), and
 * `pnpm check:production` fails on any trace of it (`/__standin/`) in a production build.
 *
 * It plays Privy's part against the suite's own edge server (apps/web/e2e/alpha-access/edge.mjs), which plays X and
 * Privy's token service:
 * - sign-in goes to `/__standin/privy/authorize` and comes back with Privy's three query parameters, as X and Privy do;
 * - the code is exchanged at `/__standin/privy/token` for an identity token the suite's alpha-api accepts (ES256 with
 *   the suite's own throwaway key, Privy's claims and an X linked account);
 * - "Make me a wallet" makes a local key in this browser; its EIP-1193 provider signs a message without a window, as
 *   Privy's embedded wallet does with `showWalletUIs: false` (the suites' claims); "Export key" only records that it was
 *   asked. It sends a transaction only where the suite's config names a loopback chain (`rpcUrl`: the alpha-trade
 *   suite's anvil, F166 "Set me up"'s first drip): the request goes there as it is, from the made wallet's address,
 *   which that suite lets anvil send for (`anvil_impersonateAccount`); everywhere else it is refused, as before.
 * Nothing here is shipped: test-support code (the source audits treat it so).
 */
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Eip1193Provider } from '@squarehole/chain/write/wallet';
import { SIGN_IN_RETURN_PARAMETERS, type MadeWallet, type PrivyBridge } from '../../alpha-sepolia/privy-bridge';

/** The browser storage items the stand-in keeps its sign-in and its made wallet's key in (test builds only). */
const SESSION_ITEM = 'sh.standin.privy.v1';
const WALLET_ITEM = 'sh.standin.privy.wallet.v1';

interface StandinSession { readonly token: string; readonly account: string }
interface StandinConfig { readonly chainId: number; readonly rpcUrl: string | null }
/** A loopback chain's RPC (the alpha-trade suite's anvil), the only place the stand-in sends a transaction to. */
const LOOPBACK_RPC = /^http:\/\/127\.0\.0\.1:\d{2,5}\/?$/;

const read = <T>(key: string): T | null => {
  try { const raw = window.localStorage.getItem(key); return raw ? JSON.parse(raw) as T : null; } catch { return null; }
};
const write = (key: string, value: unknown): void => {
  try { if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* the stand-in keeps nothing then */ }
};

async function configOf(): Promise<StandinConfig> {
  try {
    const response = await fetch('/__standin/privy/config', { cache: 'no-store' });
    const value = await response.json() as Partial<Record<keyof StandinConfig, unknown>>;
    return {
      chainId: Number.isSafeInteger(value.chainId) ? value.chainId as number : 11155111,
      rpcUrl: typeof value.rpcUrl === 'string' && LOOPBACK_RPC.test(value.rpcUrl) ? value.rpcUrl : null,
    };
  } catch {
    return { chainId: 11155111, rpcUrl: null };
  }
}

/** One JSON-RPC request to the suite's loopback chain; an error answer is thrown with its code. */
async function loopback(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const answer = await response.json() as { result?: unknown; error?: { code?: number; message?: string } };
  if (answer.error) throw Object.assign(new Error(answer.error.message ?? 'the chain refused it'), { code: answer.error.code ?? -32603 });
  return answer.result;
}

/** The made wallet's EIP-1193 provider: answers the page's requests itself and signs with the local key, no window. */
function providerOf(key: Hex, config: StandinConfig): Eip1193Provider {
  const account = privateKeyToAccount(key);
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    async request({ method, params }) {
      const list = Array.isArray(params) ? params : [];
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account.address];
      if (method === 'eth_chainId') return `0x${config.chainId.toString(16)}`;
      if (method === 'wallet_switchEthereumChain') {
        const wanted = (list[0] as { chainId?: string } | undefined)?.chainId;
        if (wanted !== undefined && Number.parseInt(wanted, 16) === config.chainId) return null;
        throw Object.assign(new Error('Unrecognized chain'), { code: 4902 });
      }
      if (method === 'wallet_revokePermissions') return null;
      if (method === 'personal_sign') {
        const message = String(list[0] ?? '');
        return account.signMessage({ message: /^0x(?:[0-9a-fA-F]{2})*$/.test(message) ? { raw: message as Hex } : message });
      }
      if (method === 'eth_sendTransaction' && config.rpcUrl !== null) {
        const tx = list[0] as { from?: unknown } | undefined;
        if (typeof tx?.from !== 'string' || tx.from.toLowerCase() !== account.address.toLowerCase()) throw Object.assign(new Error('The stand-in sends from its own address only'), { code: 4100 });
        return loopback(config.rpcUrl, method, [tx]);
      }
      throw Object.assign(new Error(`The stand-in does not answer ${method}`), { code: 4200 });
    },
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) { set = new Set(); listeners.set(event, set); }
      set.add(listener);
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
  };
}

export function standinBridge(): Promise<PrivyBridge> {
  let config: Promise<StandinConfig> | null = null;
  const settings = () => (config ??= configOf());
  const made = async (): Promise<MadeWallet | null> => {
    const key = read<Hex>(WALLET_ITEM);
    return key ? Object.freeze({ address: privateKeyToAccount(key).address, provider: providerOf(key, await settings()) }) : null;
  };
  const bridge: PrivyBridge = {
    ready: () => Promise.resolve(),
    authenticated: () => read<StandinSession>(SESSION_ITEM) !== null,
    async signIn() {
      window.location.assign(`/__standin/privy/authorize?return=${encodeURIComponent(window.location.href)}`);
    },
    async finishSignIn() {
      const url = new URL(window.location.href);
      const code = url.searchParams.get('privy_oauth_code');
      for (const name of SIGN_IN_RETURN_PARAMETERS) url.searchParams.delete(name);
      window.history.replaceState({}, '', url);
      if (!code) return null;
      const response = await fetch('/__standin/privy/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
      if (!response.ok) return null;
      const session = await response.json() as StandinSession;
      write(SESSION_ITEM, session);
      return session.token;
    },
    async identityToken() {
      const session = read<StandinSession>(SESSION_ITEM);
      if (!session) return null;
      const response = await fetch('/__standin/privy/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: session.account }) });
      if (!response.ok) return null;
      const renewed = await response.json() as StandinSession;
      write(SESSION_ITEM, renewed);
      return renewed.token;
    },
    async signOut() {
      write(SESSION_ITEM, null);
    },
    madeWallet: made,
    async makeWallet() {
      if (!bridge.authenticated()) throw new Error('not signed in');
      const existing = await made();
      if (existing) return existing;
      write(WALLET_ITEM, generatePrivateKey());
      return made() as Promise<MadeWallet>;
    },
    async exportWallet() {
      const wallet = await made();
      if (!wallet) throw new Error('no made wallet');
      document.documentElement.dataset.standinExport = wallet.address;
    },
  };
  return Promise.resolve(bridge);
}
