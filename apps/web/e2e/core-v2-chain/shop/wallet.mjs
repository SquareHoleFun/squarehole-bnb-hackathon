/**
 * The shop life's browser wallet (as helpers.mjs `testWallet`): an EIP-6963 provider only this Playwright context has,
 * answering with the local anvil's one unlocked actor. It sends only zero-value calls from that actor to the addresses
 * the test allows (the new box's coin and shop, the collections it lists), each diagnosed by function name, and records
 * every request, so a test can prove navigation asked nothing. No provider ships in the app.
 */
import { decodeFunctionData } from 'viem';
import { artifact } from '../../../../../packages/chain/scripts/lib/core-v2-local-manifest.mjs';
import { assertLocalRpc, rpc, runLocalStep, waitLocalReceipt } from '../../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';

export const WALLET_NAME = 'Local shop test wallet';

export async function shopWallet(page, chain) {
  await assertLocalRpc(chain.rpcUrl);
  const requests = []; const sent = [];
  const allowed = new Map();
  const allow = (address, contract, label = contract) => allowed.set(address.toLowerCase(), { abi: artifact(contract).abi, label });
  await page.exposeFunction('shopLifeWalletRequest', async ({ method, params = [] }) => {
    requests.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [chain.accounts.actor];
    if (method === 'eth_chainId') return rpc(chain.rpcUrl, method);
    if (method !== 'eth_sendTransaction') throw new Error(`unsupported test wallet method ${method}`);
    await assertLocalRpc(chain.rpcUrl);
    const tx = params[0];
    const target = allowed.get(tx?.to?.toLowerCase() ?? '');
    if (!tx || tx.from?.toLowerCase() !== chain.accounts.actor.toLowerCase() || !target || BigInt(tx.value ?? '0') !== 0n) {
      throw new Error('test wallet only sends zero-value calls from its one account to the shop life’s addresses');
    }
    let action = tx.data?.slice(0, 10) ?? 'empty calldata';
    try { action = decodeFunctionData({ abi: target.abi, data: tx.data }).functionName; } catch { /* keep the selector for the diagnostic */ }
    return runLocalStep(chain, `shop-life.${target.label}.${action}@${tx.to}`, async () => {
      const hash = await rpc(chain.rpcUrl, method, [tx]);
      sent.push({ ...tx, hash, action });
      await waitLocalReceipt(chain.rpcUrl, hash);
      return hash;
    });
  });
  await page.addInitScript((name) => {
    const provider = { request: (request) => window.shopLifeWalletRequest(request), on() {}, removeListener() {} };
    window.localStorage.setItem('squarehole.data-source.v1', JSON.stringify({ source: 'local' }));
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { info: { uuid: '7f3a1c52-4c0e-4f6e-9a51-2b7c3d9e1f80', name, rdns: 'org.example.shop-life', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }, provider },
    })));
  }, WALLET_NAME);
  // Nothing outside the loopback stack: no public RPC, gateway or fixture.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  return { requests, sent, allow };
}
