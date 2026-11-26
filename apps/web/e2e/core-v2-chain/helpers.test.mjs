import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { encodeErrorResult, encodeFunctionData, parseAbi } from 'viem';

const address = suffix => `0x${suffix.padStart(40, '0')}`;
const actor = address('1'); const coordinator = address('2'); const token = address('3');
const vault = address('4'); const ledger = address('5'); const holderLedger = address('6');
const hash = `0x${'92'.repeat(32)}`;
const abi = parseAbi(['function claim(uint256[] ids, address to)', 'function approve(address to, uint256 amount)',
  'function redeem(uint256 amount, uint256 minOut, address to)', 'function roleAddress(uint8 role) view returns (address)',
  'error Error(string)']);
const revert = encodeErrorResult({ abi, errorName: 'Error', args: ['item owner required'] });
const chain = { rpcUrl: 'http://127.0.0.1:8566', accounts: { actor }, boxes: { everyItem: coordinator },
  addressLabels: { [ledger]: 'everyItem.itemLedger', [token]: 'coinPile.token', [vault]: 'coinPile.vault' } };
let status;
// Only compiled ABIs and read-side chain data are doubled. The browser helpers, RPC sender, receipt checks,
// diagnostic runner and revert decoder are the actual implementations; fetch never opens a socket.
mock.module('../../../../packages/chain/scripts/lib/core-v2-local-manifest.mjs', { namedExports: { artifact: () => ({ abi }) } });
mock.module('../../../../packages/chain/scripts/local-core-v2-chain.mjs', { namedExports: {
  readLocalBox: async () => ({ token, vault, holderLedger }),
  localClient: () => ({ readContract: async () => ledger,
    waitForTransactionReceipt: async () => ({ transactionHash: hash, status, gasUsed: 12n, effectiveGasPrice: 3n }) }),
} });
const { browserContractCall, expectBoxFileSaved, saveMark, testWallet } = await import('./helpers.mjs');

function transport(t, { rejection, success = false } = {}) {
  status = success ? 'success' : 'reverted';
  const calls = []; const reports = [];
  t.mock.method(console, 'error', message => reports.push(message));
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const { method, params } = JSON.parse(options.body);
    calls.push({ method, params });
    let result;
    if (method === 'eth_chainId') result = '0xaa36a7';
    else if (method === 'web3_clientVersion') result = 'anvil/test';
    else if (method === 'eth_sendTransaction' && rejection) {
      return { ok: true, json: async () => ({ error: { message: 'execution reverted', data: rejection } }) };
    } else if (method === 'eth_sendTransaction') result = hash;
    else if (method === 'eth_getTransactionReceipt') result = { transactionHash: hash, status: success ? '0x1' : '0x0' };
    else if (method === 'debug_traceTransaction') result = { error: 'execution reverted', output: revert };
    else throw new Error(`unexpected RPC ${method}`);
    return { ok: true, json: async () => ({ result }) };
  });
  return { calls, reports };
}

async function walletPage() {
  let request;
  const page = { exposeFunction: async (_name, callback) => { request = callback; },
    addInitScript: async () => {}, route: async () => {},
    evaluate: async (_callback, tx) => {
      try { return await request({ method: 'eth_sendTransaction', params: [tx] }); }
      catch (error) {
        // eslint-disable-next-line preserve-caught-error -- Model the browser binding losing RPC data/hash/cause fields.
        throw new Error(error.message);
      }
    } };
  // SH-229: the wallet's first step, the wait for the indexer, needs a running Playwright test; here it is passed in.
  const wallet = await testWallet(page, chain, { follow: async () => 0 });
  return { page, wallet, request: (...args) => request(...args) };
}

function assertReplay(d, step) {
  const traces = d.calls.filter(call => call.method === 'debug_traceTransaction');
  assert.equal(traces.length, 1, 'exactly one replay must finish before the failed send returns');
  assert.equal(traces[0].params[0], hash);
  assert(d.reports.some(message => message.includes(step) && message.includes(hash) && message.includes('Error(item owner required)')),
    `decoded failure must identify ${step} and its mined hash`);
}

test('actual browserContractCall replays a reverted receipt and identifies box/role/method', async t => {
  const d = transport(t);
  await assert.rejects(browserContractCall({ evaluate: async () => hash }, chain, 'ItemLedgerV2', ledger, 'claim', [[1n], actor]));
  assertReplay(d, 'everyItem.itemLedger.claim');
});

test('UI wallet send replays a mined revert before returning through the browser binding', async t => {
  const d = transport(t); const { request, wallet } = await walletPage();
  const tx = { from: actor, to: token, value: '0x0', data: encodeFunctionData({ abi, functionName: 'approve', args: [vault, 1n] }) };
  await assert.rejects(request({ method: 'eth_sendTransaction', params: [tx] }));
  assertReplay(d, 'coinPile.token.approve');
  assert.equal(wallet.sent[0].hash, hash, 'even a reverted wallet send keeps its hash for inspection');
});

for (const data of [revert, { data: revert }]) {
  test(`UI wallet decodes an unmined RPC rejection (${typeof data}) before browser serialization`, async t => {
    const d = transport(t, { rejection: data }); const { page, wallet } = await walletPage();
    await assert.rejects(browserContractCall(page, chain, 'ItemLedgerV2', ledger, 'claim', [[1n], actor]));
    assert(d.reports.some(message => /everyItem.itemLedger.claim.*not mined.*Error\(item owner required\)/s.test(message)));
    assert.equal(d.calls.filter(call => call.method === 'debug_traceTransaction').length, 0);
    assert.equal(wallet.sent.length, 0);
    assert.equal(d.calls.filter(call => call.method === 'eth_sendTransaction').length, 1);
  });
}

test('browser helper using the installed test wallet diagnoses a reverted pile redemption once', async t => {
  const d = transport(t); const { page } = await walletPage();
  await assert.rejects(browserContractCall(page, chain, 'PileVaultV2', vault, 'redeem', [1n, 1n, actor]));
  assertReplay(d, 'coinPile.vault.redeem');
  assert.equal(d.calls.filter(call => call.method === 'eth_sendTransaction').length, 1);
});

test('successful browser approval keeps exact calldata and gas without diagnostics or another send', async t => {
  const d = transport(t, { success: true }); const { page, wallet } = await walletPage();
  const amount = 900719925474099312345n;
  const receipt = await browserContractCall(page, chain, 'BoxTokenV2', token, 'approve', [vault, amount]);
  assert.equal(receipt.status, 'success');
  const sends = d.calls.filter(call => call.method === 'eth_sendTransaction');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].params[0].data, encodeFunctionData({ abi, functionName: 'approve', args: [vault, amount] }));
  assert.equal(sends[0].params[0].gas, '0xe4e1c0');
  assert.equal(wallet.sent[0].hash, hash);
  assert.deepEqual(d.reports, []);
  assert.equal(d.calls.filter(call => call.method === 'debug_traceTransaction').length, 0);
});

// SH-229: the wallet counts a send when it is asked for it, so a box file closed while a send is in flight is late.
test('the save check wants one named box file with content, closed before the wallet was asked for any send', () => {
  const file = { name: 'howl-boxspec-v2.json', bytes: 4096, sendsAsked: 0 };
  const wallet = { savedFiles: [], requests: ['eth_accounts', 'eth_chainId'] };
  const mark = saveMark(wallet);
  assert.deepEqual(mark, { files: 0, asked: 0 });
  assert.throws(() => expectBoxFileSaved(wallet, mark), /one box file per Create press/);
  wallet.savedFiles.push(file); wallet.requests.push('eth_sendTransaction', 'eth_sendTransaction');
  expectBoxFileSaved(wallet, mark);
  for (const [late, message] of [
    [{ ...file, sendsAsked: 1 }, /asked for no send before the box file is saved/],
    [{ ...file, bytes: 12 }, /has content/],
    [{ ...file, name: 'howl-reveal-file.json' }, /one box file per Create press/],
    [{ ...file, name: 'HOWL-boxspec-v2.json' }, /one box file per Create press/],
  ]) assert.throws(() => expectBoxFileSaved({ ...wallet, savedFiles: [late] }, mark), message, JSON.stringify(late));
  assert.throws(() => expectBoxFileSaved({ ...wallet, savedFiles: [file, file] }, mark), /one box file per Create press/);
  // A later press starts from its own mark: the earlier file and the two earlier sends are not its own.
  const next = saveMark(wallet);
  assert.deepEqual(next, { files: 1, asked: 2 });
  assert.throws(() => expectBoxFileSaved(wallet, next), /one box file per Create press/);
  wallet.savedFiles.push({ ...file, name: 'frog-boxspec-v2.json', sendsAsked: 2 });
  expectBoxFileSaved(wallet, next);
});
