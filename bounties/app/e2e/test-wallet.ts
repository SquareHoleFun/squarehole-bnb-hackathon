import type { Page } from '@playwright/test';

/**
 * Stands in for the browser wallet: an injected provider whose account is one of the local anvil chain's unlocked
 * development accounts (or an address the fork impersonates). Requests go straight to the local chain, which signs for
 * that account; no key is involved. It records every request the page makes (`window.__wallet.requests`) and can
 * change its account or chain and tell the page, as a real wallet does (`window.__wallet.setAccount`, `.setChain`,
 * `.onNext(method, fn)` to act when the page next makes a request of that method; `.sent` holds every transaction
 * object the page handed over).
 */
export async function injectTestWallet(page: Page, rpcUrl: string, accountIndex = 0, address?: string): Promise<void> {
  await page.addInitScript(
    ({ rpcUrl, accountIndex, address }) => {
      let id = 0;
      const rpc = async (method: string, params: unknown[] = []) => {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        });
        const j = await res.json();
        if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
        return j.result;
      };
      const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
      const emit = (event: string, value: unknown) => (listeners[event] ?? []).forEach((fn) => fn(value));
      const requests: string[] = [];
      const sent: unknown[] = [];
      const hooks: Record<string, () => Promise<void> | void> = {};
      let connected = false;
      let index = accountIndex;
      let chainOverride: number | null = null;
      const account = async () => (index === accountIndex && address ? address : ((await rpc('eth_accounts')) as string[])[index]);
      const wallet = {
        requests,
        sent,
        async setAccount(i: number) {
          index = i;
          emit('accountsChanged', [await account()]);
        },
        setChain(chain: number) {
          chainOverride = chain;
          emit('chainChanged', '0x' + chain.toString(16));
        },
        onNext(method: string, fn: () => Promise<void> | void) {
          hooks[method] = fn;
        },
      };
      (window as unknown as { __wallet: typeof wallet }).__wallet = wallet;
      (window as unknown as { ethereum: unknown }).ethereum = {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          requests.push(method);
          const hook = hooks[method];
          if (hook) {
            delete hooks[method];
            await hook();
          }
          if (method === 'eth_requestAccounts') {
            connected = true;
            return [await account()];
          }
          if (method === 'eth_accounts') return connected ? [await account()] : [];
          if (method === 'eth_chainId') return chainOverride !== null ? '0x' + chainOverride.toString(16) : rpc('eth_chainId');
          if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') {
            chainOverride = null;
            return null;
          }
          if (method === 'eth_sendTransaction') {
            const tx = (params?.[0] ?? {}) as { from?: string };
            sent.push(tx);
            const now = await account();
            if (tx.from && now && tx.from.toLowerCase() !== now.toLowerCase()) throw Object.assign(new Error('from is not the selected account'), { code: 4100 });
          }
          return rpc(method, params ?? []);
        },
        on(event: string, fn: (...a: unknown[]) => void) {
          (listeners[event] ??= []).push(fn);
        },
        removeListener(event: string, fn: (...a: unknown[]) => void) {
          listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
        },
      };
    },
    { rpcUrl, accountIndex, address },
  );
}
