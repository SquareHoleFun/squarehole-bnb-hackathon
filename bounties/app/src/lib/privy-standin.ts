/**
 * SH-280: the browser tests' stand-in for Privy's made wallet on the launch pages (Privy has no test X login). Only the
 * development server opted in with `PILE_PRIVY_STANDIN=1` loads it (privy-load.ts; vite.config.ts refuses the setting in
 * a build). It plays the platform's own stand-in (apps/web/src/features/trade-sepolia/test-support/privy-standin.ts):
 * the made wallet's key in this browser's storage under the same item, a provider that answers without a window and
 * sends only to the loopback chain `/__standin/privy/config` names, from its own address.
 */
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { MadeWallet } from './privy-made';

const WALLET_ITEM = 'sh.standin.privy.wallet.v1';
const LOOPBACK_RPC = /^http:\/\/127\.0\.0\.1:\d{2,5}\/?$/;

async function configOf(): Promise<{ chainId: number; rpcUrl: string | null }> {
  try {
    const value = (await (await fetch('/__standin/privy/config', { cache: 'no-store' })).json()) as { chainId?: unknown; rpcUrl?: unknown };
    return { chainId: Number.isSafeInteger(value.chainId) ? (value.chainId as number) : 97, rpcUrl: typeof value.rpcUrl === 'string' && LOOPBACK_RPC.test(value.rpcUrl) ? value.rpcUrl : null };
  } catch {
    return { chainId: 97, rpcUrl: null };
  }
}

export async function madeWallet(): Promise<MadeWallet | null> {
  let key: Hex | null = null;
  try { key = JSON.parse(window.localStorage.getItem(WALLET_ITEM) ?? 'null') as Hex | null; } catch { key = null; }
  if (!key) return null;
  const account = privateKeyToAccount(key);
  const config = await configOf();
  const request = async ({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> => {
    const list = Array.isArray(params) ? params : [];
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account.address];
    if (method === 'eth_chainId') return `0x${config.chainId.toString(16)}`;
    if (method === 'personal_sign') return account.signMessage({ message: String(list[0] ?? '') });
    if (method === 'eth_sendTransaction' && config.rpcUrl !== null) {
      const tx = list[0] as { from?: string } | undefined;
      if (tx?.from?.toLowerCase() !== account.address.toLowerCase()) throw Object.assign(new Error('The stand-in sends from its own address only'), { code: 4100 });
      const response = await fetch(config.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [tx] }) });
      const answer = (await response.json()) as { result?: unknown; error?: { code?: number; message?: string } };
      if (answer.error) throw Object.assign(new Error(answer.error.message ?? 'refused'), { code: answer.error.code ?? -32603 });
      return answer.result;
    }
    throw Object.assign(new Error(`The stand-in does not answer ${method}`), { code: 4200 });
  };
  return Object.freeze({ address: account.address, provider: { request, on() {}, removeListener() {} } });
}
