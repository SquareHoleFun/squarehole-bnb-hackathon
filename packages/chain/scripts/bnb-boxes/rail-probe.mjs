#!/usr/bin/env node
/**
 * SH-286: does the listing registry's own probe accept a token from Flap or Four.meme (OpenFour) as a price coin?
 * On a FORK of chain 97 pinned at one block (nothing reaches the real chain): the lister (the Atlas raise setter, a
 * contract) is impersonated on the fork, funded with the probe's 10,000 raw units from a wallet that holds them, and
 * approves the registry; then `add(token, OTHER, raise)` is SIMULATED from it. The answer per token: accepted (the
 * call returns an id), or the refusal's reason. A raise that does not build is found with `checkLayout`.
 *
 *   node packages/chain/scripts/bnb-boxes/rail-probe.mjs --rpc <public chain-97 endpoint> [--block <n>] [--port <n>]
 */
import assert from 'node:assert/strict';
import { createPublicClient, decodeErrorResult, encodeFunctionData, erc20Abi, http, parseAbi } from 'viem';
import { rpc } from './chain.mjs';
import { freePort, startFork } from './local-chain.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const say = line => process.stdout.write(`${line}\n`);
const REGISTRY = '0xcCf0B8CC9257DB834d77F29EA9eB8e5554ba0170';
const SETTER = '0x34A364Bd2E4129E92e1102245e582fe22aa266A8';
const CANDIDATES = [
  ['OpenFour preset token', '0x64019AEA4e0322Dc6cd4e314315Cf08385C23AfC'],
  ['OpenFour tax token', '0x00C80DFaC0465F10E9a8D3eFB9cEf8750a733835'],
  ['Flap token (BNB sale)', '0x7Eb53F6D508a9c24A3d0594DB3C41f04FcC37777'],
  ['Flap token (USDT sale)', '0x115c374C655e503af579C9F426B8FA30d8d67777'],
];
// Wallets that may hold the tokens: ours, the platforms' contracts of our launches (bounties/app/public/addresses.json).
const HOLDERS = {
  deployer: '0x2EF9A78074bbf674bEA16f21154a30c821A3C576', keeper: '0x920B1439BC0BF2f30f9E01B9Bb94d90A9ba35189',
  alice: '0x2908E3351ec8F20a8a6746773e42EA1D2FFb3c7F', bob: '0xc979F6Cb8902f56f76b926358dC451cBF8f310F0',
  custody: '0x974d108cf896fb4b0981a13df759349d44296d27', openFourSigner: '0xd5D5633737f2fFd8E79E0AAf008795aB43215530',
  flapPortal: '0x000042108465206185A077Edc3F3fd2b49060000', flapLauncher: '0x4938E88Ecf39A4549a38B858a4D02D2326D91D8d',
  flapUsdtLauncher: '0xEc913d94Cb34df026Ee724E7084275196fE83493', openFourCore: '0xC7A76fEcec11e1F2290Eb60B0E14671e2FEb2f82',
  presetPile: '0x4586b51076B99e0480bB8144B28087571358aDe0', taxPile: '0x80E4A7FDD8bd8ADf02F41aB458f41806dB67DD73',
};
const WBNB = '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd';
const TETH = '0x860822580d4EB2529DE0C74c3E2B1D6D7C183302';
const ROUTER = '0xD99D1c33F9fC3444f8101754aBC46c52416550D1';
let FACTORY;
const REGISTRY_ABI = parseAbi([
  'function add(address token, uint8 class, uint256 raise) returns (uint32)',
  'function checkLayout(uint256 raise) view',
  'function lister() view returns (address)',
  'error ListingRefused(uint8 reason)',
  'error ProbeUnfunded(address token, address funder, uint256 amount)',
  'error NotLister(address caller)',
  'error AlreadyListed(address token, uint32 id)',
]);
const REFUSALS = ['NONE', 'TOKEN_NOT_CONTRACT', 'DECIMALS_OUT_OF_RANGE', 'TRANSFER_NOT_EXACT', 'ERC777_HOOKS', 'ALLOWLIST_ONLY', 'ADDRESS_TOO_HIGH', 'BOX_TOKEN_BY_RULE', 'RESERVED_RELIST_TOO_EARLY', 'CLASS_NOT_ALLOWED', 'RESERVED_ROUTE_SHAPE', 'RESERVED_INTERMEDIATE_NOT_ALLOWED', 'RESERVED_POOL_NOT_FOUND', 'RESERVED_FIXED_RATE_UNKNOWN', 'RESERVED_FIXED_RATE_CHECK', 'RESERVED_FIXED_RATE_IMPLEMENTATION', 'RESERVED_ORACLE_BUFFER_BELOW_FLOOR', 'RESERVED_ORACLE_NOT_COVERING', 'RESERVED_V2_SNAPSHOTS_MISSING', 'RESERVED_AVERAGE_NOT_READY', 'RAISE_NOT_BUILDABLE'];

const upstream = flag('--rpc');
assert.ok(/^https:\/\//.test(upstream ?? ''), '--rpc <a public chain-97 endpoint>');
const block = flag('--block') ?? BigInt(await rpc(upstream, 'eth_blockNumber')).toString();
const fork = await startFork({ forkUrl: upstream, port: Number(flag('--port', String(await freePort()))), forkBlock: block });
say(`fork of ${upstream} at block ${block} (${fork.url}); nothing is sent to the real chain`);
const client = createPublicClient({ transport: http(fork.url, { retryCount: 0 }) });
// One fork transaction; its receipt's status, and on a revert the reason a replayed call gives.
const send = async (from, to, data) => {
  const hash = await rpc(fork.url, 'eth_sendTransaction', [{ from, to, data, gas: '0x7a1200' }]);
  let receipt = await rpc(fork.url, 'eth_getTransactionReceipt', [hash]);
  if (!receipt) { await rpc(fork.url, 'evm_mine'); receipt = await rpc(fork.url, 'eth_getTransactionReceipt', [hash]); }
  if (!receipt) return 'not mined';
  if (receipt.status === '0x1') return 'ok';
  const why = await rpc(fork.url, 'eth_call', [{ from, to, data, gas: '0x7a1200' }, 'latest']).then(() => 'no reason', error => error.message);
  return `reverted (${why})`;
};
const out = [];
try {
  assert.equal((await client.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'lister' })).toLowerCase(), SETTER.toLowerCase(), 'the setter is the lister at this block');
  FACTORY = await client.readContract({ address: ROUTER, abi: parseAbi(['function factory() view returns (address)']), functionName: 'factory' });
  await rpc(fork.url, 'anvil_impersonateAccount', [SETTER]);
  await rpc(fork.url, 'anvil_setBalance', [SETTER, '0xde0b6b3a7640000']);
  for (const [name, token] of CANDIDATES) {
    const decimals = await client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' });
    const held = {};
    for (const [who, address] of Object.entries(HOLDERS)) held[who] = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
    // The token's PancakeSwap pool (v2 factory behind the testnet router) holds it too, quoted in WBNB or tETH.
    for (const quote of [WBNB, TETH]) {
      const pair = await client.readContract({ address: FACTORY, abi: parseAbi(['function getPair(address,address) view returns (address)']), functionName: 'getPair', args: [token, quote] });
      if (pair !== '0x0000000000000000000000000000000000000000') { HOLDERS[`pancakePair/${quote === WBNB ? 'WBNB' : 'tETH'}`] = pair; held[`pancakePair/${quote === WBNB ? 'WBNB' : 'tETH'}`] = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [pair] }); }
    }
    const funder = Object.entries(held).find(([, amount]) => amount >= 10_000n);
    const row = { name, token, decimals, held: Object.fromEntries(Object.entries(held).filter(([, v]) => v > 0n)) };
    if (!funder) { row.answer = 'not probed: none of the listed wallets holds 10,000 raw units'; out.push(row); say(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))); continue; }
    await rpc(fork.url, 'anvil_impersonateAccount', [HOLDERS[funder[0]]]);
    await rpc(fork.url, 'anvil_setBalance', [HOLDERS[funder[0]], '0xde0b6b3a7640000']);
    row.funder = funder[0];
    row.fundTransfer = await send(HOLDERS[funder[0]], token, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [SETTER, 20_000n] }));
    row.approve = await send(SETTER, token, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [REGISTRY, 10_000n] }));
    row.setterHolds = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [SETTER] });
    row.allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [SETTER, REGISTRY] });
    // A raise that builds: one whole coin, else powers of ten around it (checkLayout reverts when it does not build).
    let raise = null;
    for (const exp of [0, 1, 2, -1, 3, -2, 4, 5, 6]) {
      const candidate = exp >= 0 ? 10n ** BigInt(decimals) * 10n ** BigInt(exp) : 10n ** BigInt(decimals) / 10n ** BigInt(-exp);
      const ok = await client.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'checkLayout', args: [candidate] }).then(() => true, () => false);
      if (ok) { raise = candidate; break; }
    }
    row.raise = raise ?? 10n ** BigInt(decimals);
    try {
      const { result } = await client.simulateContract({ account: SETTER, address: REGISTRY, abi: REGISTRY_ABI, functionName: 'add', args: [token, 5, row.raise] });
      row.answer = `ACCEPTED (the listing would be row ${result})`;
    } catch (error) {
      const data = error.walk?.(e => typeof e.data === 'string' || typeof e.data?.data === 'string')?.data;
      const raw = typeof data === 'string' ? data : data?.data;
      try {
        const decoded = decodeErrorResult({ abi: REGISTRY_ABI, data: raw });
        row.answer = decoded.errorName === 'ListingRefused' ? `REFUSED: ${REFUSALS[Number(decoded.args[0])]}` : `REVERT ${decoded.errorName} ${decoded.args.join(', ')}`;
      } catch { row.answer = `REVERT (undecoded): ${raw ?? error.shortMessage}`; }
    }
    // A checked burn (addWithBurn with burn(uint256)): would the box's eat burn the coin (supply down) instead of 0xdEaD?
    if (row.answer.startsWith('ACCEPTED')) {
      row.checkedBurn = await client.simulateContract({ account: SETTER, address: REGISTRY, abi: parseAbi(['function addWithBurn(address,uint8,uint256,bytes4) returns (uint32)', 'error BurnRefused()']), functionName: 'addWithBurn', args: [token, 5, row.raise, '0x42966c68'] })
        .then(() => 'accepted: eat would burn it', error => `refused (${error.shortMessage?.split('\n')[0] ?? 'revert'}): eat sends it to 0xdEaD`);
    }
    out.push(row);
    say(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  }
} finally {
  fork.stop();
}
