import { encodeFunctionData } from 'viem';
import { assertLocalRpc, hex, rpc, waitLocalReceipt } from '../../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { localClient } from '../../../../../packages/chain/scripts/local-core-v2-chain.mjs';
import { artifact } from './chain.mjs';

const canonical = tx => JSON.stringify(Object.fromEntries(Object.entries(tx).sort(([a], [b]) => a.localeCompare(b))));
const quantity = value => typeof value === 'string' && /^0x(0|[1-9a-f][0-9a-f]*)$/.test(value);
/**
 * SH-186: every send of the page names its own EIP-1559 fee and leaves none to the wallet. A page send must therefore
 * carry both fee fields as hex quantities, with a tip above zero and not above the cap, and no other fee field
 * (`gasPrice` is not among the keys a page send may have). This checks that the page names a fee and its shape, not
 * its size: how the app derives the amount is tested with the sender itself (packages/chain/src/write).
 */
const PAGE_SEND_KEYS = ['from', 'to', 'data', 'value', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'chainId'];
export const carriesPageFee = tx => quantity(tx.maxFeePerGas) && quantity(tx.maxPriorityFeePerGas)
  && BigInt(tx.maxPriorityFeePerGas) > 0n && BigInt(tx.maxFeePerGas) >= BigInt(tx.maxPriorityFeePerGas);
/**
 * A page send against the call its confirmation showed (`expected`: to, data): the one account, that target and
 * calldata, no value, a gas limit within the per-transaction cap (EIP-7825: 2^24), this chain, a fee the page names
 * itself, and no field beyond these.
 */
export const isConfirmedPageSend = (tx, expected, account, chainId) => typeof tx?.from === 'string' && typeof tx.to === 'string'
  && tx.from.toLowerCase() === account.toLowerCase() && tx.to.toLowerCase() === expected.to.toLowerCase() && tx.data === expected.data
  && (tx.value === undefined || (quantity(tx.value) && BigInt(tx.value) === 0n))
  && quantity(tx.gas) && BigInt(tx.gas) <= 16_777_216n && quantity(tx.chainId) && BigInt(tx.chainId) === BigInt(chainId)
  && carriesPageFee(tx) && Object.keys(tx).every(key => PAGE_SEND_KEYS.includes(key));
export function permitWallet(account, broadcast) {
  const permits = new Set();
  return {
    permit(tx) { permits.add(canonical(tx)); },
    async send(tx) {
      const key = canonical(tx);
      if (tx.from?.toLowerCase() !== account.toLowerCase() || !permits.delete(key)) throw new Error('transaction not permitted by this example');
      return broadcast(tx);
    },
  };
}

/** No keys and no impersonation. Every send is an explicit exact test action from one unlocked Anvil account. */
export async function installWallet(page, chain, evidence) {
  await assertLocalRpc(chain.rpcUrl);
  const requests = [];
  let ui;
  const gate = permitWallet(chain.accounts.actor, async tx => {
    await assertLocalRpc(chain.rpcUrl);
    const hash = await rpc(chain.rpcUrl, 'eth_sendTransaction', [tx]);
    evidence.transactions.push({ ...tx, hash });
    await waitLocalReceipt(chain.rpcUrl, hash);
    return hash;
  });
  await page.exposeFunction('exampleWalletRequest', async ({ method, params = [] }) => {
    requests.push(method);
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [chain.accounts.actor];
    if (method === 'eth_chainId') return hex(chain.chainId);
    if (method === 'eth_sendTransaction') {
      const tx = params[0];
      if (ui) {
        const expected = ui; ui = null;
        try {
          if (!isConfirmedPageSend(tx, expected, chain.accounts.actor, chain.chainId)) throw new Error('page sent a different call than its confirmed claim');
          gate.permit(tx);
          const hash = await gate.send(tx); expected.resolve(hash); return hash;
        } catch (error) { expected.reject(error); throw error; }
      }
      return gate.send(tx);
    }
    throw new Error(`unsupported example wallet method ${method}`);
  });
  await page.addInitScript(() => {
    const provider = { request: args => window.exampleWalletRequest(args), on() {}, removeListener() {} };
    window.exampleWallet = provider;
    localStorage.setItem('squarehole.data-source.v1', JSON.stringify({ source: 'local' }));
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { info: { uuid: '8f9d986d-b50c-4f4f-92fb-418ed8cf8c24', name: 'Example local wallet', rdns: 'org.example.squarehole.examples', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }, provider },
    })));
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, route => route.abort());
  async function send(tx) {
    const transaction = { from: chain.accounts.actor, value: '0x0', gas: hex(15_000_000n), ...tx };
    gate.permit(transaction);
    const hash = await page.evaluate(tx => window.exampleWallet.request({ method: 'eth_sendTransaction', params: [tx] }), transaction);
    return localClient(chain).waitForTransactionReceipt({ hash, timeout: 30_000, pollingInterval: 50 });
  }
  return { requests, send,
    async uiCall(name, to, functionName, args, action) {
      if (ui) throw new Error('a page confirmation is already pending');
      let timer;
      const sent = new Promise((resolve, reject) => {
        ui = { to, data: encodeFunctionData({ abi: artifact(name).abi, functionName, args }), resolve, reject };
        timer = setTimeout(() => reject(new Error(`page did not send ${functionName}`)), 30_000);
      });
      // Attach the rejection handler before the page can reject it asynchronously.
      const receipt = sent.then(hash => localClient(chain).getTransactionReceipt({ hash }));
      try { const [, mined] = await Promise.all([action(), receipt]); return mined; }
      finally { clearTimeout(timer); ui = null; }
    },
    call: (name, to, functionName, args = [], value = 0n, gas = 15_000_000n) => send({ to,
      data: encodeFunctionData({ abi: artifact(name).abi, functionName, args }), value: hex(value), gas: hex(gas) }),
  };
}
