// Seeds a LOCAL anvil chain for the page: a test token, the shared pile (bounties/core FeeRules) for it, holders,
// two revenues and one redemption, so every part of the pile panel has something to show. Writes
// public/local/addresses.json; open the page with ?addresses=local/addresses.json.
// Uses anvil's unlocked development accounts through eth_sendTransaction: no key is read or held here.
// usage: node scripts/seed-local.mjs [rpcUrl]   (default http://127.0.0.1:8581; build e2e/chain first)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseEther, zeroAddress } from 'viem';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, '..');
const rpcUrl = process.argv[2] ?? 'http://127.0.0.1:8581';
const art = (file, name) => JSON.parse(fs.readFileSync(path.join(app, 'e2e/chain/out', file, `${name}.json`), 'utf8'));
const Token = art('Fixtures.sol', 'TestToken');
const Pile = art('FeeRules.sol', 'FeeRules');

const pub = createPublicClient({ transport: http(rpcUrl) });
const chainId = await pub.getChainId();
const chain = { id: chainId, name: 'local', nativeCurrency: { name: 'BNB', symbol: 'tBNB', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
const [a0, a1] = await pub.request({ method: 'eth_accounts' });
const w = (account) => createWalletClient({ account, chain, transport: http(rpcUrl) });
const wait = async (hash) => {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`reverted: ${hash}`);
  return r;
};

const deploy = async (c, args) => {
  const hash = await w(a0).deployContract({ abi: c.abi, bytecode: c.bytecode.object, args });
  return (await wait(hash)).contractAddress;
};

const startBlock = await pub.getBlockNumber();
const token = await deploy(Token, ['Pile Demo', 'PILE']);
const pile = await deploy(Pile, [token, zeroAddress, []]);
const call = async (account, address, abi, functionName, args = [], value) =>
  wait(await w(account).writeContract({ address, abi, functionName, args, value }));

await call(a0, token, Token.abi, 'mint', [a0, parseEther('1000000')]);
await call(a0, token, Token.abi, 'mint', [a1, parseEther('250000')]);
// Revenue arrives as a plain transfer; sync() only reports it (the pile is always the live balance).
await wait(await w(a0).sendTransaction({ to: pile, value: parseEther('0.05') }));
await call(a0, pile, Pile.abi, 'sync');
await wait(await w(a0).sendTransaction({ to: pile, value: parseEther('0.0123') }));
await call(a0, pile, Pile.abi, 'sync');
await call(a1, token, Token.abi, 'approve', [pile, parseEther('10000')]);
await call(a1, pile, Pile.abi, 'redeem', [parseEther('10000'), 0n]);

// A pile the deployment file does not name (read only on the page), with some revenue, and a named pile that is empty.
const unlisted = await deploy(Pile, [token, zeroAddress, []]);
await wait(await w(a0).sendTransaction({ to: unlisted, value: parseEther('0.01') }));
const emptyPile = await deploy(Pile, [token, zeroAddress, []]);

const out = {
  chainId,
  rpcUrls: [rpcUrl],
  explorer: 'https://testnet.bscscan.com',
  fromBlock: startBlock.toString(),
  piles: [
    { pile, rail: 'core', label: 'PILE (local)' },
    { pile: emptyPile, rail: 'core', label: 'Empty pile (local)' },
  ],
};
fs.mkdirSync(path.join(app, 'public/local'), { recursive: true });
fs.writeFileSync(path.join(app, 'public/local/addresses.json'), JSON.stringify(out, null, 2) + '\n');
// A deployment file that must be refused as a whole (the page then shows the reason and nothing else).
fs.writeFileSync(path.join(app, 'public/local/bad.json'), JSON.stringify({ ...out, chainId: 56 }, null, 2) + '\n');
fs.writeFileSync(path.join(app, 'public/local/seed.json'), JSON.stringify({ token, pile, unlisted, emptyPile }, null, 2) + '\n');
console.log(JSON.stringify({ token, pile, unlisted, emptyPile, holder: a0, holder2: a1 }));
