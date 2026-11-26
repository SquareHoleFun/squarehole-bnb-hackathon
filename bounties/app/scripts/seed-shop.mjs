#!/usr/bin/env node
// SH-288: seeds a LOCAL FORK of BSC Testnet for the card shop's browser tests (scripts/shop-fork.sh). On the fork only:
// - a plain test token T with a PancakeSwap V2 pool against BNB (the shop's refill buys T there);
// - the shop factory, and a shop for T (asset BNB) over the four test card collections of chain 97
//   (packages/contracts/deployments/bnb-testnet/97-cards.json), give prices 1,000 / 2,000 / 4,000 / 8,000 T, pick part
//   100%, a weekly cap of 12,000 T;
// - new cards minted by the collections' owner (impersonated on the fork), stocked into the shop (three of each), and
//   two kept by the test account to give; the shop's budget in T; 0.01 BNB sent to the shop as waiting tax;
// - a second shop for the Flap sale's token the real deployment file names, for the link from the sale page.
// Writes public/local/shop-addresses.json (the page's deployment file for the test) and public/local/shop-seed.json.
// usage: node scripts/seed-shop.mjs <fork rpc url> <shop build out dir> <deployment file of chain 97>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, decodeEventLog, http, parseAbi, parseEther, getAddress, zeroAddress } from 'viem';

const here = path.dirname(fileURLToPath(import.meta.url));
const [rpc, shopOut, realFile] = process.argv.slice(2);
if (!rpc || !shopOut || !realFile) throw new Error('usage: seed-shop.mjs <rpc> <shop out dir> <addresses.json>');
const chain = { id: 97, name: 'BSC Testnet fork', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const pub = createPublicClient({ chain, transport: http(rpc) });
const raw = async (method, params = []) => {
  const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};
const [A] = await raw('eth_accounts');
const wallet = (account) => createWalletClient({ chain, transport: http(rpc), account });
const send = async (account, req) => {
  const hash = await wallet(account).writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${req.functionName} reverted`);
  return r;
};
const deploy = async (account, artifact, args = []) => {
  const a = JSON.parse(fs.readFileSync(artifact, 'utf8'));
  const hash = await wallet(account).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success' || !r.contractAddress) throw new Error(`deploy ${artifact} failed`);
  return r.contractAddress;
};
const E18 = 10n ** 18n;
const ROUTER = '0xD99D1c33F9fC3444f8101754aBC46c52416550D1';
const erc20 = parseAbi(['function approve(address,uint256) returns (bool)', 'function mint(address,uint256)', 'function transfer(address,uint256) returns (bool)']);
const router = parseAbi(['function addLiquidityETH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline) payable returns (uint256,uint256,uint256)']);
const cards721 = parseAbi(['function owner() view returns (address)', 'function mint(address to, uint256 id, uint8 picture)', 'function setApprovalForAll(address,bool)', 'function ownerOf(uint256) view returns (address)']);
const factoryAbi = parseAbi(['function create(address token, address asset, address router, address[] collections, uint256[] givePrices, uint16 pickBps, uint256 weeklyCap) returns (address shop)',
  'event ShopCreated(address indexed shop, address indexed creator, address indexed token, address asset, address router, bytes32 paramsHash)']);
/** The shop a create made: its ShopCreated event in the receipt. */
const created = (receipt) => {
  for (const log of receipt.logs) {
    try { const e = decodeEventLog({ abi: factoryAbi, data: log.data, topics: log.topics }); if (e.eventName === 'ShopCreated') return e.args.shop; } catch { /* another event */ }
  }
  throw new Error('no ShopCreated in the receipt');
};
const shopAbi = parseAbi(['function stock(address nft, uint256[] ids)']);

const from = await pub.getBlockNumber();
// The token and its pool.
const T = await deploy(A, path.join(here, '../e2e/chain/out/Fixtures.sol/TestToken.json'), ['Shop Test Token', 'SHOPT']);
await send(A, { address: T, abi: erc20, functionName: 'mint', args: [A, 10_000_000n * E18] });
await send(A, { address: T, abi: erc20, functionName: 'approve', args: [ROUTER, 1_000_000n * E18] });
const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600) + 10n ** 6n;
await send(A, { address: ROUTER, abi: router, functionName: 'addLiquidityETH', args: [T, 1_000_000n * E18, 0n, 0n, A, deadline], value: parseEther('1') });
// The factory and the shop for T.
const cardsFile = JSON.parse(fs.readFileSync(path.join(here, '../../../packages/contracts/deployments/bnb-testnet/97-cards.json'), 'utf8'));
const collections = ['common', 'uncommon', 'rare', 'legendary'].map((k) => getAddress(cardsFile.collections[k]));
// The factory accepts only the routers and card collections it is built with: PancakeSwap's V2 router and our four.
const factory = await deploy(A, path.join(shopOut, 'RailShopFactory.sol/RailShopFactory.json'), [[ROUTER], collections]);
const gives = [1_000n, 2_000n, 4_000n, 8_000n].map((v) => v * E18);
const shop = created(await send(A, { address: factory, abi: factoryAbi, functionName: 'create', args: [T, zeroAddress, ROUTER, collections, gives, 10_000, 12_000n * E18] }));
// Cards: minted on the fork by each collection's owner (impersonated), ids from 9001; three of each stocked, the
// account keeps 9004 of Common and Uncommon to give.
const stocked = [];
const kept = [];
for (const nft of collections) {
  const owner = await pub.readContract({ address: nft, abi: cards721, functionName: 'owner' });
  await raw('anvil_impersonateAccount', [owner]);
  await raw('anvil_setBalance', [owner, '0x8ac7230489e80000']);
  const ids = [9001n, 9002n, 9003n, 9004n];
  for (const id of ids) await send(owner, { address: nft, abi: cards721, functionName: 'mint', args: [A, id, Number((id - 1n) % 4n) + 1] });
  await raw('anvil_stopImpersonatingAccount', [owner]);
  await send(A, { address: nft, abi: cards721, functionName: 'setApprovalForAll', args: [shop, true] });
  const into = nft === collections[0] || nft === collections[1] ? ids.slice(0, 3) : ids;
  await send(A, { address: shop, abi: shopAbi, functionName: 'stock', args: [nft, into] });
  await send(A, { address: nft, abi: cards721, functionName: 'setApprovalForAll', args: [shop, false] });
  stocked.push(...into.map((id) => ({ nft, id: id.toString() })));
  if (into.length < ids.length) kept.push({ nft, id: '9004' });
}
// The budget, and the tax waiting in BNB.
await send(A, { address: T, abi: erc20, functionName: 'transfer', args: [shop, 20_000n * E18] });
const pay = await wallet(A).sendTransaction({ to: shop, value: parseEther('0.01') });
await pub.waitForTransactionReceipt({ hash: pay });
// A second shop for the real Flap sale's token, so the sale page links to it.
const real = JSON.parse(fs.readFileSync(realFile, 'utf8'));
const sale = real.flap?.sales?.[0];
let saleShop = null;
let strangerShop = null;
if (sale?.token && real.flap?.curveLauncherFactory) {
  // Made by the sale's own creator (impersonated on the fork), as a launch's page links only to its creator's shop.
  const madeEvent = parseAbi(['event CurveLauncherCreated(address indexed launcher, address indexed creator, bytes32 salt, bool viaPortal)'])[0];
  let saleCreator = null;
  for (let lo = BigInt(real.fromBlock); lo <= from && !saleCreator; lo += 40_000n) {
    const hi = lo + 39_999n < from ? lo + 39_999n : from;
    const logs = await pub.getLogs({ address: real.flap.curveLauncherFactory, event: madeEvent, args: { launcher: sale.launcher }, fromBlock: lo, toBlock: hi });
    saleCreator = logs[0]?.args.creator ?? null;
  }
  if (saleCreator) {
    await raw('anvil_impersonateAccount', [saleCreator]);
    await raw('anvil_setBalance', [saleCreator, '0x8ac7230489e80000']);
    saleShop = created(await send(saleCreator, { address: factory, abi: factoryAbi, functionName: 'create', args: [sale.token, zeroAddress, ROUTER, collections.slice(0, 1), gives.slice(0, 1), 10_000, 1_000n * E18] }));
    await raw('anvil_stopImpersonatingAccount', [saleCreator]);
  }
  // And one by a stranger (the test account) for the same token: the sale's page never links to it; opened by its
  // address, the shop page says who made it.
  strangerShop = created(await send(A, { address: factory, abi: factoryAbi, functionName: 'create', args: [sale.token, zeroAddress, ROUTER, collections.slice(1, 2), gives.slice(1, 2), 10_000, 4_000n * E18] })); // a give price above the week's cap is refused at creation
}
// The real file's first block: the page reads the Flap sale's creation event (its creator) from there.
const addresses = { chainId: 97, rpcUrls: [rpc], explorer: 'https://testnet.bscscan.com', fromBlock: real.fromBlock, flap: real.flap, shops: { factory } };
const out = path.join(here, '../public/local');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'shop-addresses.json'), JSON.stringify(addresses, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'shop-seed.json'), JSON.stringify({ account: A, token: T, factory, shop, collections, stocked, kept, sale: sale ?? null, saleShop, strangerShop }, null, 2) + '\n');
console.log('token', T, 'factory', factory, 'shop', shop, 'cards', stocked.length, 'kept', kept.length, 'sale shop', saleShop);
