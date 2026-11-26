#!/usr/bin/env node
/**
 * The BNB Chain test network (chain id 97) deployment: the runbook's steps, the two rehearsals and the file writer.
 * Run from packages/contracts as `node --experimental-transform-types script/bnb/bnb-testnet.mjs ...` (the check imports
 * TypeScript of packages/chain) with forge, cast and anvil on PATH. No npm dependency; this file never reads a key:
 * a real run hands `--account <keystore name>` and `--password-file <path>` to forge, unread.
 *
 *   probe --rpc-url <url>                                read-only facts of a chain-97 endpoint
 *   rehearse --mode plain|fork [--interrupt N] [--fork-url <url>] [--out <dir>] [--dump <file>]
 *   deploy --rpc-url <url> --account <name> [--password-file <path>] --steps <a,b,...> [--resume] [--routes 1..7]
 *   files --rpc-url <url> [--state <file>] [--out <dir>] [--write-repo] [--git-commit <sha>]
 *
 * Steps, in runbook order: dependencies, release, coins, routes, listings, helpers, pools, faucet. Every step's
 * addresses and per-transaction gas go into the state file (default .cache/bnb-testnet/97-state.json at the
 * repository's top). An extra step of another script (a later lane's) runs as `extra:<script path>:<Contract>:<sig>`
 * with `--extra-args a,b,...`, where `$factory`, `$coins.nvda`, `$dependencies.manager` and so on name state values;
 * its printed `BNB|<name>|<0x...>` lines are kept under `extra` in the state.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTRACTS = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const ROOT = resolve(CONTRACTS, '../..');
export const CHAIN_ID = 97n;
/** The deployer of the real run (its key stays on the machine; the rehearsals impersonate it on anvil). */
export const DEPLOYER = '0x2EF9A78074bbf674bEA16f21154a30c821A3C576';
export const WBNB = '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd';
export const GAS_PRICE = 100_000_000n; // 0.1 gwei, the test network's eth_gasPrice on 25 November 2026
export const TX_GAS_CAP = 16_777_216n; // EIP-7825, live on chain 97
export const FORK_URL = 'https://bsc-testnet-rpc.publicnode.com';
/** The keeper's wallet: the fixed trigger of every converter route (the deployer stays lister and owner). */
export const KEEPER = '0x920B1439BC0BF2f30f9E01B9Bb94d90A9ba35189';
const ETHER = 10n ** 18n;

/** Defaults of the demo (raw units). The native raise is the smallest round amount the release builds a box for. */
export const DEFAULTS = Object.freeze({
  nativeRaise: 10n ** 15n, // 0.001 BNB
  coinRaises: { usdc: 1_000_000n, nvda: 10n ** 15n, gold: 10n ** 15n, pepe: 10n ** 15n, teth: 10n ** 17n },
  bnbPerPool: 10n ** 14n, // 0.0001 BNB per native pool
  nvdaInPair: 10n * ETHER,
});

export const STEPS = ['dependencies', 'release', 'coins', 'routes', 'listings', 'helpers', 'pools', 'faucet'];
/** The only endpoints a real run (`deploy`, `files --write-repo`) may use: the public chain-97 RPCs of the runbook. */
export const ALLOWED_RPCS = Object.freeze(['https://bsc-testnet-rpc.publicnode.com', 'https://bsc-testnet-dataseed.bnbchain.org',
  'https://bsc-testnet.bnbchain.org', 'https://bsc-prebsc-dataseed.bnbchain.org']);
/** Gas of each step in the plain rehearsal (listings: the fork's, 18,990 higher). The refusal's measure is this gas at
 * 0.1 gwei plus the BNB the step sends, plus 10%, rounded up in wei. */
export const STEP_GAS = Object.freeze({ dependencies: 10_932_186n, release: 95_338_087n, coins: 3_869_808n,
  listings: 3_845_065n, helpers: 4_569_139n, pools: 2_828_230n, faucet: 47_004n });
/** Each route's own gas (module creation plus registration): BNB to tNVDA, BNB to tGOLD, tUSDC to tNVDA. */
export const ROUTE_GAS = Object.freeze([4_905_818n, 4_905_818n, 4_908_657n]);
/** The steps a second run completes from what is on chain (they read first, then send only what is missing). */
export const RESTARTABLE = new Set(['routes', 'listings', 'pools', 'faucet']);

/** What a step needs in the wallet before it may start (wei). */
export function stepNeed(step, p, o = {}) {
  let cost;
  if (step === 'routes') cost = ROUTE_GAS.reduce((a, g, i) => (p.routes & (1 << i) ? a + g : a), 0n) * GAS_PRICE;
  else if (step.startsWith('extra:')) {
    if (o['extra-budget'] === undefined) throw new Error('an extra step needs --extra-budget <wei> (its cost is unknown here)');
    cost = BigInt(o['extra-budget']);
  } else cost = STEP_GAS[step] * GAS_PRICE + (step === 'pools' ? 2n * p.bnbPerPool : 0n);
  return (cost * 11n + 9n) / 10n;
}

const hex = n => `0x${BigInt(n).toString(16)}`;
const json = value => `${JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2)}\n`;
const say = text => process.stdout.write(`${text}\n`);
const delay = ms => new Promise(done => setTimeout(done, ms));
const words = data => data.slice(2).match(/.{64}/g) ?? [];
const wordAddress = w => `0x${w.slice(24)}`;

export async function rpc(url, method, params = []) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { data: body.error.data });
  return body.result;
}

/** forge, cast and anvil get only what they need: the search path, the home folder (forge's keystores and solc),
 * the user and language, and what a step sets itself. Nothing else of this process's environment reaches them. */
function toolEnv() {
  const keep = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR'];
  return Object.fromEntries(keep.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
}

/** Runs a tool; resolves with its exit code and combined output. `onSpawn` sees the child (to stop it by its PID). */
export function run(cmd, args, { cwd = CONTRACTS, env = {}, timeoutMs = 3_600_000, onSpawn } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { cwd, env: { ...toolEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', fail);
    child.on('close', code => { clearTimeout(timer); done({ code, out }); });
    onSpawn?.(child);
  });
}

async function tool(cmd, args, options) {
  const { code, out } = await run(cmd, args, options);
  if (code !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed (${code}):\n${out.slice(-4000)}`);
  return out.trim();
}

const cast = (...args) => tool('cast', args);
const calldata = (sig, ...args) => cast('calldata', sig, ...args.map(String));
async function call(url, to, sig, ...args) {
  return rpc(url, 'eth_call', [{ to, data: await calldata(sig, ...args) }, 'latest']);
}

/** The printed `BNB|<name>|<value>` line of a forge script. */
function printed(out, name) {
  const value = out.match(new RegExp(`BNB\\|${name}\\|\\s*(0x[0-9a-fA-F]+)`))?.[1];
  if (!value) throw new Error(`forge omitted ${name}`);
  return value;
}
const addresses = (data, names) => Object.fromEntries(words(data).map((w, i) => [names[i], wordAddress(w)]));
const tuple = values => `(${values.join(',')})`;

/** What each step sends: script, signature and arguments from the state of the earlier steps. */
export function stepCall(step, s, p) {
  const coins = () => tuple([s.coins.usdc, s.coins.nvda, s.coins.gold, s.coins.pepe, s.coins.teth]);
  const C = '(address,address,address,address,address)';
  if (step.startsWith('extra:')) {
    const [, path, contract, sig] = step.split(':');
    const value = a => (a.startsWith('$') ? a.slice(1).split('.').reduce((o, k) => o?.[k], s) : a);
    const args = (p.extraArgs ?? []).map(value);
    if (args.some(a => a === undefined)) throw new Error(`${step}: an argument names no state value`);
    return { path, contract, sig, args };
  }
  switch (step) {
    case 'dependencies': return { file: 'BnbTestnetGenesis', sig: 'run()', args: [] };
    case 'release': return { file: 'DeployCoreV2Bnb', sig: 'run(address,address,address,address,address)',
      args: [s.dependencies.manager, s.dependencies.weth, s.dependencies.drand, s.dependencies.firstFee, s.dependencies.platform] };
    case 'coins': return { file: 'BnbTestnetSetup', sig: 'runCoins()', args: [] };
    case 'routes': return { file: 'BnbTestnetSetup', sig: `runRoutes(address,${C},address,uint8,address[])`,
      args: [s.factory, coins(), p.trigger, p.routes, `[${(p.candidates ?? []).join(',')}]`] };
    case 'listings': return { file: 'BnbTestnetSetup', sig: `runListings(address,${C},(uint256,uint256,uint256,uint256,uint256,uint256))`,
      args: [s.factory, coins(), tuple([p.nativeRaise, ...['usdc', 'nvda', 'gold', 'pepe', 'teth'].map(k => p.coinRaises[k])])] };
    case 'helpers': return { file: 'BnbTestnetSetup', sig: 'runHelpers(address,(address,address))',
      args: [s.dependencies.manager, tuple([p.recovered?.pairs ?? ZERO, p.recovered?.nativePools ?? ZERO])] };
    case 'pools': return { file: 'BnbTestnetSetup', sig: `runPools((address,address),${C},uint256,uint256)`,
      args: [tuple([s.helpers.pairs, s.helpers.nativePools]), coins(), p.bnbPerPool, p.nvdaInPair] };
    case 'faucet': return { file: 'BnbTestnetSetup', sig: 'runFaucet(address)', args: [s.coins.teth] };
    case 'box-bnb': return { file: 'BnbTestnetSetup', sig: 'runBox(address,address,uint32)', args: [s.factory, s.dependencies.swapper, 0] };
    case 'box-nvda': return { file: 'BnbTestnetSetup', sig: 'runBox(address,address,uint32)', args: [s.factory, s.dependencies.swapper, 2] };
    case 'trade-bnb': return { file: 'BnbTestnetSetup', sig: 'runTrade(address,address)', args: [s.boxes['box-bnb'], s.dependencies.swapper] };
    case 'trade-nvda': return { file: 'BnbTestnetSetup', sig: 'runTrade(address,address)', args: [s.boxes['box-nvda'], s.dependencies.swapper] };
    default: throw new Error(`unknown step ${step}`);
  }
}

/** Reads a step's printed output into the state. */
function absorb(step, s, out) {
  if (step === 'dependencies') s.dependencies = addresses(printed(out, 'dependencies'),
    ['manager', 'weth', 'drand', 'firstFee', 'platform', 'swapper', 'poolSwapTest']);
  if (step === 'release') s.factory = printed(out, 'factory');
  if (step === 'coins') s.coins = addresses(printed(out, 'coins'), ['usdc', 'nvda', 'gold', 'pepe', 'teth']);
  if (step === 'faucet') printed(out, 'faucet');
  if (step.startsWith('extra:')) {
    (s.extra ??= {})[step] = Object.fromEntries([...out.matchAll(/BNB\|([A-Za-z0-9_-]+)\|\s*(0x[0-9a-fA-F]+)/g)].map(m => [m[1], m[2]]));
  }
  if (step === 'routes') {
    const made = addresses(printed(out, 'routes'), ['nvdaFromBnb', 'goldFromBnb', 'nvdaFromUsdc']);
    s.routes = { ...s.routes, ...Object.fromEntries(Object.entries(made).filter(([, a]) => BigInt(a) !== 0n)) };
    s.directory = printed(out, 'directory');
  }
  if (step === 'listings') s.listingRegistry = printed(out, 'listings');
  if (step === 'helpers') s.helpers = addresses(printed(out, 'helpers'), ['pairs', 'nativePools']);
  if (step.startsWith('box-')) (s.boxes ??= {})[step] = printed(out, 'box');
  if (step.startsWith('trade-')) printed(out, 'traded');
}

/** forge's own record of the step's transactions: hash, nonce, what it was, gas limit, gas used, value. */
function broadcastRecord(c, root) {
  const path = join(root, scriptPath(c).split('/').pop(), String(CHAIN_ID), `${c.sig.split('(')[0]}-latest.json`);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  const receipts = new Map(record.receipts.map(r => [r.transactionHash.toLowerCase(), r]));
  return record.transactions.map(t => {
    const r = receipts.get(t.hash?.toLowerCase());
    return { hash: t.hash, nonce: BigInt(t.transaction.nonce).toString(), what: t.contractName ? `create ${t.contractName}` : `call ${t.function ?? t.transaction.to}`,
      to: t.contractAddress ?? t.transaction.to, gasLimit: BigInt(t.transaction.gas).toString(), value: BigInt(t.transaction.value ?? 0).toString(),
      gasUsed: r ? BigInt(r.gasUsed).toString() : null, status: r ? (BigInt(r.status) === 1n ? 'success' : 'reverted') : 'not mined',
      block: r ? BigInt(r.blockNumber).toString() : null };
  });
}

const scriptPath = c => c.path ?? `script/bnb/${c.file}.s.sol`;

/** forge arguments of one step; `signer` is ['--unlocked'] on anvil, or ['--account', name, '--password-file', path]
 * on the real network (handed to forge unread). */
function forgeArgs(step, s, p, url, signer, resume) {
  const c = stepCall(step, s, p);
  return { c, args: ['script', `${scriptPath(c)}:${c.contract ?? c.file}`, '--sig', c.sig, ...c.args.map(String),
    '--rpc-url', url, '--broadcast', '--slow', '--legacy', '--with-gas-price', GAS_PRICE.toString(),
    '--sender', DEPLOYER, ...signer, ...(resume ? ['--resume'] : [])] };
}

const FORGE_ENV = { FOUNDRY_LINT_LINT_ON_BUILD: 'false' };

const ROUTE_NAMES = ['BNB to tNVDA', 'BNB to tGOLD', 'tUSDC to tNVDA'];
/** The state's key of a step: a routes call is keyed by the routes it adds (a later call can add the others). */
export const gasKey = (step, p) => (step === 'routes' && p.routes !== 7 ? `routes (${ROUTE_NAMES.filter((_, i) => p.routes & (1 << i)).join(', ')})` : step);

const safeName = step => step.replace(/[^A-Za-z0-9_-]+/g, '_');
const nonceOf = async url => BigInt(await rpc(url, 'eth_getTransactionCount', [DEPLOYER, 'latest']));

/** Writes the state beside itself and renames it into place: a stop during the write never loses a checkpoint. */
export function saveState(path, s) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, json(s));
  renameSync(tmp, path);
}

/** Every recorded transaction must be on the endpoint: mined, successful, sent by the deployer, at or after the step's
 * starting nonce. The receipt's gas is the one kept. */
async function verifyReceipts(url, transactions, startNonce) {
  for (const t of transactions) {
    const [receipt, tx] = await Promise.all([rpc(url, 'eth_getTransactionReceipt', [t.hash]), rpc(url, 'eth_getTransactionByHash', [t.hash])]);
    if (!receipt || !tx) throw new Error(`transaction ${t.hash} is not on this endpoint`);
    if (BigInt(receipt.status) !== 1n) throw new Error(`transaction ${t.hash} reverted`);
    if (tx.from.toLowerCase() !== DEPLOYER.toLowerCase() || BigInt(tx.nonce) < startNonce) throw new Error(`transaction ${t.hash} is not this step's`);
    Object.assign(t, { gasUsed: BigInt(receipt.gasUsed).toString(), status: 'success', block: BigInt(receipt.blockNumber).toString() });
  }
}

/** A stopped release whose factory is on chain after all (forge stopped after its last transaction, or its record was
 * lost): the factory is a plain CREATE of the deployer at a nonce from the release's starting nonce on. Read-only. */
export async function findReleasedFactory(url, s, fromNonce) {
  const end = await nonceOf(url);
  for (let n = end - 1n; n >= fromNonce; n--) {
    const at = (await cast('compute-address', DEPLOYER, '--nonce', n.toString())).match(/0x[0-9a-fA-F]{40}/)?.[0];
    if (!at || (await rpc(url, 'eth_getCode', [at, 'latest'])).length <= 2) continue;
    try {
      const manager = wordAddress(words(await call(url, at, 'poolManager()'))[0]);
      const listings = wordAddress(words(await call(url, at, 'listingRegistry()'))[0]);
      if (manager.toLowerCase() === s.dependencies.manager.toLowerCase() && (await rpc(url, 'eth_getCode', [listings, 'latest'])).length > 2) return at;
    } catch { /* another contract of the release */ }
  }
  return null;
}

/** CREATE addresses of the deployer at the nonces a stopped attempt of this step used, where code is now. */
async function createdSince(url, fromNonce) {
  const end = await nonceOf(url);
  const found = [];
  for (let n = BigInt(fromNonce); n < end; n++) {
    const at = (await cast('compute-address', DEPLOYER, '--nonce', n.toString())).match(/0x[0-9a-fA-F]{40}/)?.[0];
    if (at && (await rpc(url, 'eth_getCode', [at, 'latest'])).length > 2) found.push(at);
  }
  return found;
}

const callOk = async (url, to, sig, ...args) => { try { return await call(url, to, sig, ...args); } catch { return null; } };

/** What a stopped attempt left that this step may take over: route modules, or the two helpers (checked by the
 * script again before use). */
async function recoverable(step, s, url) {
  if (!s.pending || s.pending.step !== step || !['routes', 'helpers'].includes(step)) return {};
  const made = await createdSince(url, s.pending.startNonce);
  if (step === 'routes') return { candidates: made };
  const h = { pairs: ZERO, nativePools: ZERO };
  for (const at of made) {
    const owner = await callOk(url, at, 'owner()');
    if (!owner || wordAddress(words(owner)[0]).toLowerCase() !== DEPLOYER.toLowerCase()) continue;
    if (await callOk(url, at, 'LOWER()')) h.pairs = at;
    else if (await callOk(url, at, 'key(address)', ZERO.replace(/0$/, '1'))) h.nativePools = at;
  }
  return { recovered: h };
}

/**
 * The recorded transactions of one attempt against the deployer's nonces: distinct, contiguous from the attempt's
 * starting nonce to `endNonce`, each mined, successful and from the deployer (receipts read from the endpoint).
 */
async function reconcile(url, transactions, startNonce, endNonce) {
  const nonces = transactions.map(t => BigInt(t.nonce)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const expected = [];
  for (let n = startNonce; n < endNonce; n++) expected.push(n);
  if (nonces.length !== expected.length || nonces.some((n, i) => n !== expected[i])) {
    throw new Error(`the record has nonces ${nonces.join(',') || 'none'}, the chain moved from ${startNonce} to ${endNonce}`);
  }
  await verifyReceipts(url, transactions, startNonce);
}

/**
 * One step. Before forge starts, a pending marker is saved (step, script, signature, arguments, and every attempt
 * with its starting nonce and forge record folder); a retry adds an attempt and keeps the earlier ones. After forge,
 * the last attempt's record is reconciled with the deployer's nonces and the receipts, earlier attempts' records
 * where they exist; then the step's results must hold ON CHAIN (postconditions) before the step is written into the
 * state and the marker removed. A restartable step that finds everything in place sends nothing (nonce unmoved).
 */
export async function runStep(step, s, p, { url, signer, resume = false, log, onSpawn, broadcastRoot, save = () => {} }) {
  const t0 = Date.now();
  if (s.pending && s.pending.step !== step) throw new Error(`step ${s.pending.step} stopped before it completed: finish it first`);
  if (resume && !(step === 'release' && s.pending?.step === 'release')) throw new Error('--resume continues a stopped release only; any other step runs again');
  if (step === 'release' && s.pending?.step === 'release' && !resume) {
    const factory = await findReleasedFactory(url, s, BigInt(s.pending.startNonce));
    if (factory) {
      s.factory = factory;
      await requireHolds(step, s, p, url);
      (s.gas ??= {}).release = { recovered: true, transactions: [], attempts: s.pending.attempts,
        note: `factory found on chain after a stop (from nonce ${s.pending.startNonce}); nothing sent` };
      delete s.pending; save(s);
      return s;
    }
  }
  Object.assign(p, { candidates: undefined, recovered: undefined }, await recoverable(step, s, url));
  const startNonce = await nonceOf(url);
  const { c, args } = forgeArgs(step, s, p, url, signer, resume);
  const attempt = resume ? s.pending.attempts.at(-1)
    : { startNonce: startNonce.toString(), broadcast: join(broadcastRoot, `${safeName(step)}-${startNonce}-${Date.now()}`), startedAt: new Date().toISOString() };
  s.pending = s.pending?.step === step
    ? { ...s.pending, attempts: resume ? s.pending.attempts : [...(s.pending.attempts ?? []), attempt] }
    : { step, script: `${scriptPath(c)}:${c.contract ?? c.file}`, sig: c.sig, args: c.args.map(String), startNonce: startNonce.toString(), attempts: [attempt] };
  save(s);
  const { code, out } = await run('forge', args, { env: { ...FORGE_ENV, FOUNDRY_BROADCAST: attempt.broadcast }, onSpawn });
  log?.(step, out);
  if (code !== 0) throw Object.assign(new Error(`step ${step} did not complete (forge exit ${code})`), { out });
  const endNonce = await nonceOf(url);
  const attempts = s.pending.attempts;
  const transactions = [];
  const unrecorded = [];
  for (const [i, a] of attempts.entries()) {
    const from = BigInt(a.startNonce);
    const to = i + 1 < attempts.length ? BigInt(attempts[i + 1].startNonce) : endNonce;
    let record = [];
    try { record = broadcastRecord(c, a.broadcast); } catch { /* none written (a stop) */ }
    if (i + 1 === attempts.length) {
      await reconcile(url, record, from, to);
      transactions.push(...record);
      continue;
    }
    // A stopped attempt: its record lists what it planned; what it sent are the nonces up to the next attempt's start.
    const sent = record.filter(x => BigInt(x.nonce) >= from && BigInt(x.nonce) < to);
    try {
      await reconcile(url, sent, from, to);
      transactions.push(...sent);
    } catch (error) {
      if (to > from) unrecorded.push({ fromNonce: from.toString(), toNonce: (to - 1n).toString(), note: `a stopped attempt's record does not cover them (${error.message}); the step's on-chain results decide` });
    }
  }
  if (resume) {
    s.factory = await findReleasedFactory(url, s, BigInt(s.pending.startNonce));
    if (!s.factory) throw new Error('the resumed release left no factory on chain');
  } else absorb(step, s, out);
  await requireHolds(step, s, p, url);
  // SH-262: an extra step that sent nothing (its script found everything on chain, e.g. the card stock rerun after all
  // its transactions mined but before the state was saved) is complete only when every address it printed has code.
  if (step.startsWith('extra:') && transactions.length === 0) {
    const printedAddresses = [...out.matchAll(/BNB\|[A-Za-z0-9_-]+\|\s*(0x[0-9a-fA-F]{40})\b/g)].map(m => m[1]);
    if (!printedAddresses.length) throw new Error(`step ${step} sent nothing and printed no address`);
    for (const at of printedAddresses) {
      const code = await rpc(url, 'eth_getCode', [at, 'latest']);
      if (!code || code === '0x') throw new Error(`step ${step} sent nothing, but ${at} has no code`);
    }
  }
  (s.gas ??= {})[gasKey(step, p)] = { seconds: Math.round((Date.now() - t0) / 1000), transactions,
    ...(attempts.length > 1 ? { attempts, unrecorded } : {}), ...(transactions.length ? {} : { nothingToSend: true }) };
  delete s.pending; save(s);
  return s;
}

const EXPECTED_SYMBOLS = { usdc: ['tUSDC', 6n], nvda: ['tNVDA', 18n], gold: ['tGOLD', 18n], pepe: ['tPEPE', 18n], teth: ['tETH', 18n] };
const LISTING_ROWS = (s, p) => [[ZERO, 'NATIVE', p.nativeRaise], [s.coins.usdc, 'STABLE', p.coinRaises.usdc], [s.coins.nvda, 'STOCK', p.coinRaises.nvda],
  [s.coins.gold, 'OTHER', p.coinRaises.gold], [s.coins.pepe, 'OTHER', p.coinRaises.pepe], [s.coins.teth, 'OTHER', p.coinRaises.teth]];

const isqrt = n => { if (n < 2n) return n; let x = n; let y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
/** The pair helper's opening price for these budgets (its `_startingPrice`; the coins sorted by address). */
export function pairPrice(a, b, amountA, amountB) {
  const [x0, x1] = BigInt(a) < BigInt(b) ? [amountA, amountB] : [amountB, amountA];
  return (x1 >> 64n) < x0 ? isqrt((x1 << 192n) / x0) : isqrt((x1 << 128n) / x0) << 32n;
}

/** The seven pools step 7 makes: helper, coins, budgets in seed order, the exact encoded opening price. */
export function expectedPools(s, p) {
  const native = (coin, price) => ({ kind: 'native', helper: s.helpers.nativePools, a: ZERO, b: coin, price });
  const pair = (a, b, x, y) => ({ kind: 'pair', helper: s.helpers.pairs, a, b, price: pairPrice(a, b, x, y) });
  const e18 = 10n ** 18n;
  return [native(s.coins.nvda, 2n << 96n), native(s.coins.gold, 1n << 95n),
    pair(s.coins.nvda, s.coins.usdc, p.nvdaInPair, p.nvdaInPair / 10n ** 12n),
    pair(s.coins.teth, s.coins.usdc, 1000n * e18, 100_000n * 10n ** 6n), pair(s.coins.teth, s.coins.nvda, 1000n * e18, 100_000n * e18),
    pair(s.coins.teth, s.coins.gold, 1000n * e18, 1000n * e18), pair(s.coins.teth, s.coins.pepe, 200n * e18, 200_000_000n * e18)];
}

/** A pool's key, its encoded price and the helper's full-range liquidity, all read from the PoolManager's storage at
 * `tag` (slot0 and the position in `pools[id]`, mapping slot 6, positions at offset 6). */
export async function readPool(url, manager, pool, tag = 'latest') {
  const [c0, c1] = BigInt(pool.a) < BigInt(pool.b) ? [pool.a, pool.b] : [pool.b, pool.a];
  const id = await cast('keccak', await cast('abi-encode', 'f(address,address,uint24,int24,address)', c0, c1, '3000', '60', ZERO));
  const stateSlot = BigInt(await cast('keccak', await cast('abi-encode', 'f(bytes32,uint256)', id, '6')));
  const load = async slot => BigInt(`0x${words(await rpc(url, 'eth_call', [{ to: manager, data: await calldata('extsload(bytes32)', hex(slot)) }, tag]))[0]}`);
  const tick = n => (BigInt.asUintN(24, BigInt(n))).toString(16).padStart(6, '0');
  const positionKey = await cast('keccak', `0x${pool.helper.slice(2).toLowerCase()}${tick(-887220)}${tick(887220)}${'0'.repeat(64)}`);
  const positionSlot = BigInt(await cast('keccak', await cast('abi-encode', 'f(bytes32,uint256)', positionKey, (stateSlot + 6n).toString())));
  return { currency0: c0, currency1: c1, sqrtPriceX96: (await load(stateSlot)) & ((1n << 160n) - 1n), liquidity: (await load(positionSlot)) & ((1n << 128n) - 1n) };
}

/** Everything a step promises, read on chain; an empty list means it holds. */
export async function postconditions(step, s, p, url, tag = 'latest') {
  const problems = [];
  const code = async (label, at) => { if (!at || (await rpc(url, 'eth_getCode', [at, tag])).length <= 2) problems.push(`${label}: no code at ${at}`); };
  const at = async (to, sig, ...args) => rpc(url, 'eth_call', [{ to, data: await calldata(sig, ...args) }, tag]);
  const addr = async (to, sig, ...args) => wordAddress(words(await at(to, sig, ...args))[0]).toLowerCase();
  const uint = async (to, sig, ...args) => BigInt(`0x${words(await at(to, sig, ...args))[0]}`);
  const same = (x, y) => String(x).toLowerCase() === String(y).toLowerCase();
  const d = s.dependencies;
  if (step === 'dependencies') {
    for (const [k, v] of Object.entries(d)) await code(`dependencies.${k}`, v);
    if (!same(await addr(d.swapper, 'pm()'), d.manager)) problems.push('the swapper is not on the PoolManager');
    if (!same(await addr(d.poolSwapTest, 'manager()'), d.manager)) problems.push('PoolSwapTest is not on the PoolManager');
  } else if (step === 'release') {
    await code('factory', s.factory);
    if (!same(await addr(s.factory, 'poolManager()'), d.manager)) problems.push('the factory is not on the PoolManager');
    const directory = wordAddress(words(await at(await addr(s.factory, 'implementation(uint256)', 5), 'receiverCode()'))[2]);
    if ((await uint(directory, 'count()')) < 4n) problems.push('the directory has fewer than four modules');
  } else if (step === 'coins') {
    for (const [k, [symbol, decimals]] of Object.entries(EXPECTED_SYMBOLS)) {
      await code(`coins.${k}`, s.coins[k]);
      if (await readString(url, s.coins[k], 'symbol()', tag) !== symbol || await uint(s.coins[k], 'decimals()') !== decimals) problems.push(`coins.${k} is not ${symbol}`);
    }
  } else if (step === 'routes') {
    const directory = wordAddress(words(await at(await addr(s.factory, 'implementation(uint256)', 5), 'receiverCode()'))[2]);
    const want = [[ZERO, s.coins.nvda], [ZERO, s.coins.gold], [s.coins.usdc, s.coins.nvda]].filter((_, i) => p.routes & (1 << i));
    const rows = [];
    const count = await uint(directory, 'count()');
    for (let id = 4n; id < count; id++) {
      const w = words(await at(directory, 'record(uint32)', id));
      const m = wordAddress(w[0]);
      if (BigInt(`0x${w[3]}`) !== 0n) continue;
      rows.push([await addr(m, 'priceCoin()'), await addr(m, 'pileCoin()'), await addr(m, 'conversionTrigger()')]);
    }
    for (const [from, to] of want) {
      if (!rows.some(([f, t, trig]) => same(f, from) && same(t, to) && same(trig, p.trigger))) problems.push(`no registered route ${from} to ${to} for trigger ${p.trigger}`);
    }
  } else if (step === 'listings') {
    const registry = await addr(s.factory, 'listingRegistry()');
    const rows = LISTING_ROWS(s, p);
    if ((await uint(registry, 'listingCount()')) < BigInt(rows.length)) problems.push('fewer than six listings');
    else {
      for (const [id, [token, klass, raise]] of rows.entries()) {
        const w = words(await at(registry, 'listing(uint32)', id));
        if (!same(wordAddress(w[1]), token) || CLASSES[Number(BigInt(`0x${w[3]}`))] !== klass || BigInt(`0x${w[6]}`) !== raise) problems.push(`listing ${id} is not ${klass} ${token} raise ${raise}`);
      }
    }
  } else if (step === 'helpers') {
    for (const [k, v] of Object.entries(s.helpers)) {
      await code(`helpers.${k}`, v);
      if (!same(await addr(v, 'owner()'), DEPLOYER) || !same(await addr(v, 'manager()'), d.manager)) problems.push(`helpers.${k} has another owner or manager`);
    }
  } else if (step === 'pools') {
    for (const pool of expectedPools(s, p)) {
      const r = await readPool(url, d.manager, pool, tag);
      if (r.sqrtPriceX96 !== pool.price) problems.push(`pool ${pool.a}/${pool.b}: price ${r.sqrtPriceX96}, expected ${pool.price}`);
      if (r.liquidity === 0n) problems.push(`pool ${pool.a}/${pool.b}: no position of the helper`);
    }
  } else if (step === 'faucet') {
    if (await uint(s.coins.teth, 'open()') !== 1n) problems.push('tETH is not open');
  }
  return problems;
}

async function requireHolds(step, s, p, url) {
  if (step.startsWith('extra:') || step.startsWith('box-') || step.startsWith('trade-')) return;
  const problems = await postconditions(step, s, p, url);
  if (problems.length) throw new Error(`step ${step} does not hold on chain: ${problems.join('; ')}`);
}

export function gasTable(s, gasPrice = GAS_PRICE) {
  const rows = [];
  let total = 0n; let value = 0n; let count = 0;
  for (const step of Object.keys(s.gas ?? {})) {
    const txs = s.gas[step].transactions;
    const used = txs.reduce((a, t) => a + BigInt(t.gasUsed), 0n);
    const sent = txs.reduce((a, t) => a + BigInt(t.value), 0n);
    const largest = txs.reduce((a, t) => BigInt(t.gasUsed) > a ? BigInt(t.gasUsed) : a, 0n);
    const largestLimit = txs.reduce((a, t) => BigInt(t.gasLimit) > a ? BigInt(t.gasLimit) : a, 0n);
    total += used; value += sent; count += txs.length;
    rows.push({ step, transactions: txs.length, gasUsed: used, largestGasUsed: largest, largestGasLimit: largestLimit,
      overCap: txs.filter(t => BigInt(t.gasLimit) > TX_GAS_CAP).length, bnbForGas: used * gasPrice, bnbSent: sent,
      runningGas: total, runningBnb: total * gasPrice + value });
  }
  return { rows, total, value, count, bnb: total * gasPrice + value, withHalf: (total * gasPrice + value) * 3n / 2n };
}

/** All 18 decimals: the exact amount in a message, never rounded. */
export const bnbExact = wei => { const s = BigInt(wei).toString().padStart(19, '0'); return `${s.slice(0, -18)}.${s.slice(-18)}`; };
export const bnb = wei => { const w = BigInt(wei); const s = (w * 10n ** 6n / ETHER).toString().padStart(7, '0'); return `${s.slice(0, -6)}.${s.slice(-6)}`; };

export function gasMarkdown(table) {
  const lines = ['| Step | Transactions | Gas used | Largest tx (used / limit) | Over cap | tBNB for gas | tBNB sent | Running gas | Running tBNB |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const r of table.rows) lines.push(`| ${r.step} | ${r.transactions} | ${r.gasUsed} | ${r.largestGasUsed} / ${r.largestGasLimit} | ${r.overCap} | ${bnb(r.bnbForGas)} | ${bnb(r.bnbSent)} | ${r.runningGas} | ${bnb(r.runningBnb)} |`);
  lines.push(`| total | ${table.count} | ${table.total} | | | ${bnb(table.total * GAS_PRICE)} | ${bnb(table.value)} | | ${bnb(table.bnb)} (plus 50%: ${bnb(table.withHalf)}) |`);
  return `${lines.join('\n')}\n`;
}

// ---- The files the TypeScript side reads, read back from the chain (never written by hand).

const IMPLEMENTATIONS = { 0: 'coordinator', 1: 'token', 2: 'hook', 3: 'vault', 4: 'collection', 5: 'receiver', 6: 'launchRouter',
  7: 'tickets', 8: 'royaltyRouter', 16: 'itemLedger', 17: 'holderLedger', 19: 'starterSetLoader', 20: 'tokenLedger', 21: 'shopVault', 22: 'pileVault' };
const CLASSES = ['NONE', 'NATIVE', 'STANDARD', 'STABLE', 'STOCK', 'OTHER'];

async function readString(url, to, sig, tag = 'latest') {
  const data = await rpc(url, 'eth_call', [{ to, data: await calldata(sig) }, tag]);
  const w = words(data); const length = Number(BigInt(`0x${w[1]}`));
  return Buffer.from(w.slice(2).join('').slice(0, length * 2), 'hex').toString('utf8');
}
const readUint = async (url, to, sig, ...args) => BigInt(`0x${words(await call(url, to, sig, ...args))[0]}`);

const lower = a => a.toLowerCase();
const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = `0x${'0'.repeat(64)}`;

/**
 * The files, read back from the chain at one evidence block (the `finalized` block of the endpoint):
 * - `core-v1/97.json`: the release manifest in the shape SH-258 parses (`squarehole.core-deployment/v1`, network
 *   `bnb-testnet`, no core v1 version, the v2 release in `releases`, the two holding contracts as Safe-shaped pins
 *   exactly as `readLocalManifest` writes a `LocalV2Custody` double);
 * - `coin-deployment-97.json`: the trade box's coin record, the Sepolia record's shape (`teth` = the TestETH faucet coin);
 * - the create-options data of the factory;
 * - `97-extras.json`: what the demo boxes need beyond those (listings, converter routes and directory ids, pools).
 */
export async function readFiles(url, s, { gitCommit = null, p = params({}) } = {}) {
  const block = await rpc(url, 'eth_getBlockByNumber', ['finalized', false]);
  const n = BigInt(block.number);
  if (s.startBlock !== undefined && n < BigInt(s.startBlock)) throw new Error('the finalized block is older than the release');
  const tag = hex(n);
  // The evidence block must be at or after the last receipt any step of the state recorded.
  const lastReceipt = Object.values(s.gas ?? {}).flatMap(g => g.transactions ?? []).reduce((m, x) => (x.block && BigInt(x.block) > m ? BigInt(x.block) : m), 0n);
  if (n < lastReceipt) throw new Error(`the finalized block ${n} is before the last step's receipt (block ${lastReceipt}): wait and run again`);
  // Every step's results must hold at that block: all seven pools at their encoded price with the helpers' positions,
  // the open faucet, the six listings, the three routes, the helpers, the coins, the release, its dependencies.
  const problems = [];
  for (const step of STEPS) problems.push(...await postconditions(step, s, { ...p, routes: 7 }, url, tag));
  // The state's release is this chain's: the factory had no code at the state's start block, which exists.
  if (s.startBlock !== undefined) {
    const start = await rpc(url, 'eth_getBlockByNumber', [hex(BigInt(s.startBlock)), false]);
    if (!start) problems.push(`the start block ${s.startBlock} is not on this chain`);
    else if ((await rpc(url, 'eth_getCode', [s.factory, hex(BigInt(s.startBlock))])).length > 2) problems.push('the factory existed before the start block');
  }
  if (problems.length) throw new Error(`not publishable at block ${n}: ${problems.join('; ')}`);
  const at = async (to, sig, ...args) => rpc(url, 'eth_call', [{ to, data: await calldata(sig, ...args) }, tag]);
  const addr = async (to, sig, ...args) => wordAddress(words(await at(to, sig, ...args))[0]);
  const uint = async (to, sig, ...args) => BigInt(`0x${words(await at(to, sig, ...args))[0]}`);
  const entry = async address => {
    const code = await rpc(url, 'eth_getCode', [address, tag]);
    if (!code || code === '0x') throw new Error(`no code at ${address} in block ${n}`);
    return { address: lower(address), codeHash: await cast('keccak', code) };
  };
  const f = s.factory;
  const implementations = {};
  for (const [role, name] of Object.entries(IMPLEMENTATIONS)) implementations[name] = await entry(await addr(f, 'implementation(uint256)', role));
  implementations.hookExtension = await entry(await addr(implementations.hook.address, 'extension()'));
  const registry = await entry(await addr(f, 'registry()'));
  const listingRegistry = await entry(await addr(f, 'listingRegistry()'));
  const versionCodeHash = `0x${words(await at(f, 'versionCodeHash()'))[0]}`;
  const directory = await entry(wordAddress(words(await at(implementations.receiver.address, 'receiverCode()'))[2]));
  const safe = async address => {
    const e = await entry(address);
    return { ...e, version: '1.4.1', singleton: e.address, singletonCodeHash: e.codeHash,
      owners: words(await at(address, 'getOwners()')).slice(2).map(wordAddress), threshold: (await uint(address, 'getThreshold()')).toString(),
      guard: ZERO, guardCodeHash: ZERO_HASH, handler: ZERO, handlerCodeHash: ZERO_HASH, modulesEnabled: false,
      controlTransferProof: 'BNB Chain testnet: BnbTestnetCustody, a holding contract owned by the deployer; not a Safe' };
  };
  const safes = { fit: await safe(await addr(implementations.receiver.address, 'FIT_SAFE()')),
    platform: await safe(await addr(implementations.receiver.address, 'PLATFORM_SAFE()')) };
  const manifest = { schema: 'squarehole.core-deployment/v1', status: 'deployed', chainId: 97, network: 'bnb-testnet',
    chain: { poolManager: await entry(s.dependencies.manager), weth: await entry(s.dependencies.weth),
      randomness: await entry(s.dependencies.drand), platformSafe: { address: safes.platform.address, codeHash: safes.platform.codeHash } },
    versions: [], evidence: { block: { number: n.toString(), hash: block.hash }, finality: 'finalized' }, gitCommit,
    releases: [{ version: 2, factory: await entry(f), registry, listingRegistry, feeModuleDirectory: directory, safes,
      startBlock: String(s.startBlock ?? 0), implementations, versionCodeHash }] };

  // Everything below is read at the same block `n` as the manifest: symbols, decimals, rows, pools.
  const word = async (to, sig, ...args) => words(await at(to, sig, ...args));
  const symbolOf = async coin => (BigInt(coin) === 0n ? 'BNB' : readString(url, coin, 'symbol()', tag));
  const decimalsOf = async coin => (BigInt(coin) === 0n ? 18 : Number(await uint(coin, 'decimals()')));
  const names = ['eat', 'holdersT', 'itemsT', 'pile'];
  const modules = []; const routes = [];
  const count = await uint(directory.address, 'count()');
  const delay = await uint(directory.address, 'DELAY()');
  for (let id = 0n; id < count; id++) {
    const w = await word(directory.address, 'record(uint32)', id);
    const module = wordAddress(w[0]);
    const row = { id: Number(id), module, codeHash: `0x${w[1]}`, readyAt: BigInt(`0x${w[2]}`).toString(), withdrawn: BigInt(`0x${w[3]}`) !== 0n };
    if (id < 4n) { modules.push({ ...row, name: names[Number(id)] }); continue; }
    // A converter: its coins, trigger, cap and dust from the module itself (never from local notes).
    const from = await addr(module, 'priceCoin()'); const to = await addr(module, 'pileCoin()');
    const route = { ...row, name: `converter ${await symbolOf(from)} to ${await symbolOf(to)}`, priceCoin: from, pileCoin: to,
      trigger: await addr(module, 'conversionTrigger()'), inputCap: (await uint(module, 'inputCap()')).toString(),
      dustMax: (await uint(module, 'dustMax()')).toString() };
    modules.push(route); routes.push(route);
  }
  const listings = [];
  const listingCount = await uint(listingRegistry.address, 'listingCount()');
  for (let id = 0n; id < listingCount; id++) {
    const w = await word(listingRegistry.address, 'listing(uint32)', id);
    const token = wordAddress(w[1]);
    listings.push({ id: Number(id), token, symbol: await symbolOf(token),
      decimals: Number(BigInt(`0x${w[2]}`)), class: CLASSES[Number(BigInt(`0x${w[3]}`))], raise: BigInt(`0x${w[6]}`).toString(),
      bootstrapQ: BigInt(`0x${w[7]}`).toString(), batchMinQ: BigInt(`0x${w[8]}`).toString(), tipMaxQ: BigInt(`0x${w[9]}`).toString(),
      swapStepMinQ: BigInt(`0x${w[10]}`).toString() });
  }
  const poolSwapTest = await entry(s.dependencies.poolSwapTest);
  const manager = s.dependencies.manager;
  // A pool's key from its helper, and its price from the PoolManager's storage (slot0 of pools[id], mapping slot 6).
  const keyOf = async (helper, sig, ...args) => {
    const w = await word(helper, sig, ...args);
    return { currency0: wordAddress(w[0]), currency1: wordAddress(w[1]), fee: BigInt(`0x${w[2]}`), tickSpacing: Number(BigInt.asIntN(24, BigInt(`0x${w[3]}`))), hooks: wordAddress(w[4]) };
  };
  const sqrtPriceOf = async key => {
    const id = await cast('keccak', await cast('abi-encode', 'f(address,address,uint24,int24,address)', key.currency0, key.currency1, String(key.fee), String(key.tickSpacing), key.hooks));
    const slot = await cast('keccak', await cast('abi-encode', 'f(bytes32,uint256)', id, '6'));
    const value = words(await at(manager, 'extsload(bytes32)', slot))[0];
    return BigInt(`0x${value}`) & ((1n << 160n) - 1n);
  };
  const coinEntry = async (coin, extra = {}) => ({ coin: lower(coin), symbol: await symbolOf(coin), decimals: await decimalsOf(coin), ...extra });
  const pairs = []; const otherPairs = []; const nativePools = [];
  if (s.helpers && s.coins) {
    const lowerTick = Number(BigInt.asIntN(24, await uint(s.helpers.pairs, 'LOWER()')));
    const upperTick = Number(BigInt.asIntN(24, await uint(s.helpers.pairs, 'UPPER()')));
    const shape = key => ({ fee: key.fee.toString(), tickSpacing: key.tickSpacing, hooks: key.hooks, tickLower: lowerTick, tickUpper: upperTick });
    // The trade box's pairs: each coin with tETH, written only when the helper holds a position at this block.
    for (const k of ['usdc', 'nvda', 'gold', 'pepe']) {
      if (await uint(s.helpers.pairs, 'liquidity(address,address)', s.coins.teth, s.coins[k]) === 0n) throw new Error(`no tETH/${k} position at block ${n}`);
      pairs.push(await coinEntry(s.coins[k], shape(await keyOf(s.helpers.pairs, 'key(address,address)', s.coins.teth, s.coins[k]))));
    }
    if (await uint(s.helpers.pairs, 'liquidity(address,address)', s.coins.usdc, s.coins.nvda) !== 0n) {
      otherPairs.push(await coinEntry(s.coins.usdc, { ...shape(await keyOf(s.helpers.pairs, 'key(address,address)', s.coins.usdc, s.coins.nvda)), other: lower(s.coins.nvda), otherSymbol: await symbolOf(s.coins.nvda) }));
    }
    // The converter's native pools: written only when initialized at this block (a seed initializes and adds at once);
    // the price is read back and compared with the stated one (4 tNVDA and 0.25 tGOLD per BNB).
    for (const [k, num, den] of [['nvda', 4n, 1n], ['gold', 1n, 4n]]) {
      const key = await keyOf(s.helpers.nativePools, 'key(address)', s.coins[k]);
      const sqrtPriceX96 = await sqrtPriceOf(key);
      if (sqrtPriceX96 === 0n) throw new Error(`the ${k} native pool is not initialized at block ${n}`);
      nativePools.push(await coinEntry(s.coins[k], { currency0: key.currency0, ...shape(key), sqrtPriceX96: sqrtPriceX96.toString(),
        statedPrice: `${num}/${den}`, priceAsStated: sqrtPriceX96 * sqrtPriceX96 * den === num << 192n }));
    }
  }
  // As on Sepolia: `teth` is the TestETH faucet coin, each test coin paired with it through the pair helper.
  const coinDeployment = s.coins && s.helpers && pairs.length ? { chainId: 97, status: 'deployed', teth: await entry(s.coins.teth),
    pairHelper: await entry(s.helpers.pairs), poolManager: lower(manager), poolSwapTest: poolSwapTest.address,
    poolSwapTestCodeHash: poolSwapTest.codeHash, pairs: pairs.map(({ coin, symbol, decimals, fee, tickSpacing, hooks, tickLower, tickUpper }) =>
      ({ coin, symbol, decimals, fee, tickSpacing, hooks, tickLower, tickUpper })) } : null;
  const coins = {};
  if (s.coins) {
    for (const k of ['usdc', 'nvda', 'gold', 'pepe', 'teth']) {
      const e = await entry(s.coins[k]);
      coins[await symbolOf(s.coins[k])] = { ...e, decimals: await decimalsOf(s.coins[k]) };
    }
  }
  // Configuration, not chain data: switches the create-options data sets.
  const configuration = { createOptionsOff: ['addon.1'], why: 'hidden draws stay off for the event; DrandSource verifies a real round on chain 97' };
  const extras = { schema: 'square-hole-bnb-testnet-extras/1', chainId: 97, evidence: manifest.evidence, deployer: lower(DEPLOYER),
    feeModuleDirectory: { ...directory, delaySeconds: delay.toString(), modules }, routes, listings, coins,
    nativePoolHelper: s.helpers ? await entry(s.helpers.nativePools) : null, nativePools, otherPairs,
    faucetOpen: s.coins ? (await uint(s.coins.teth, 'open()')) === 1n : null,
    trade: { poolManager: lower(manager), poolSwapTest: poolSwapTest.address, poolSwapTestCodeHash: poolSwapTest.codeHash,
      swapper: lower(s.dependencies.swapper) }, configuration };
  const createOptions = { schema: 1, chainId: 97, factory: lower(f), registry: registry.address, versionCodeHash, revision: 1,
    off: configuration.createOptionsOff.map(key => ({ key })) };
  return { manifest, createOptions, coinDeployment, extras };
}

/** The four files' places in the repository (written only by `files --write-repo` after the real run). */
export function repoTargets(factory) {
  return { manifest: join(CONTRACTS, 'deployments/core-v1/97.json'), extras: join(CONTRACTS, 'deployments/bnb-testnet/97-extras.json'),
    coins: join(ROOT, 'packages/chain/src/trade-sepolia/coin-deployment-97.json'),
    createOptions: join(ROOT, `packages/chain/src/create-options/data/97/${factory}.json`) };
}

/** A rehearsal's output, a dump or a staging folder must be under the repository's .cache or hackathon/rehearsals:
 * never one of the real files' places. */
export function scratchPath(path, what) {
  const p = resolve(path);
  const roots = [join(ROOT, '.cache'), join(ROOT, 'hackathon', 'rehearsals')];
  if (!roots.some(r => p.startsWith(r + sep))) throw new Error(`${what} must be under .cache/ or hackathon/rehearsals/ of the repository: ${p}`);
  return p;
}

/** Writes the files into a staging folder (never the repository's places). */
export function writeFiles(dir, { manifest, createOptions, coinDeployment, extras }) {
  const root = scratchPath(dir, 'the files folder');
  const targets = { manifest: join(root, 'core-v1/97.json'), extras: join(root, 'bnb-testnet/97-extras.json'),
    coins: join(root, 'trade-sepolia/coin-deployment-97.json'), createOptions: join(root, `create-options/data/97/${createOptions.factory}.json`) };
  for (const path of Object.values(targets)) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(targets.manifest, json(manifest));
  writeFileSync(targets.extras, json(extras));
  if (coinDeployment) writeFileSync(targets.coins, json(coinDeployment));
  writeFileSync(targets.createOptions, json(createOptions));
  return targets;
}

/** After every check passed: the staged files move to the repository's places. Each new file is written beside its
 * place first; then each old file is renamed aside and the new one renamed in; on any failure the old files are put
 * back, so the four places hold either the old set or the new one. */
export function publishFiles(staged, read) {
  if (!read.coinDeployment) throw new Error('no coin record was generated by this read');
  const real = repoTargets(read.createOptions.factory);
  const keys = Object.keys(real);
  const tag = `${Date.now()}-${process.pid}`;
  for (const k of keys) { mkdirSync(dirname(real[k]), { recursive: true }); copyFileSync(staged[k], `${real[k]}.new-${tag}`); }
  const moved = [];
  try {
    for (const k of keys) {
      const had = existsSync(real[k]);
      if (had) renameSync(real[k], `${real[k]}.old-${tag}`);
      moved.push([k, had]);
      renameSync(`${real[k]}.new-${tag}`, real[k]);
      if (!readFileSync(staged[k]).equals(readFileSync(real[k]))) throw new Error(`copy of ${k} differs`);
    }
  } catch (error) {
    for (const [k, had] of moved.reverse()) {
      if (existsSync(real[k])) unlinkSync(real[k]);
      if (had) renameSync(`${real[k]}.old-${tag}`, real[k]);
    }
    for (const k of keys) if (existsSync(`${real[k]}.new-${tag}`)) unlinkSync(`${real[k]}.new-${tag}`);
    throw error;
  }
  for (const [k, had] of moved) if (had) unlinkSync(`${real[k]}.old-${tag}`);
  return real;
}

/** SH-258's parser and on-chain check (SH_TESTNET=bnb), run on what was written; the coin record against the Sepolia
 * record's parser with only its chain id swapped (that parser takes 31337 and 11155111 until SH-258 widens it). */
export async function checkFiles(url, targets) {
  process.env.SH_TESTNET = 'bnb';
  await import(join(ROOT, 'packages/chain/scripts/register-ts.mjs'));
  const { parseCoreManifestV2 } = await import(join(ROOT, 'packages/chain/src/core/v2/manifest-v2.ts'));
  const { checkTestnetReleaseOnChain } = await import(join(ROOT, 'packages/chain/src/core/v2/testnet-release-check.ts'));
  const manifest = parseCoreManifestV2(JSON.parse(readFileSync(targets.manifest, 'utf8')));
  const reads = {
    chainId: async () => Number(BigInt(await rpc(url, 'eth_chainId'))),
    blockHash: async n => (await rpc(url, 'eth_getBlockByNumber', [hex(n), false])).hash,
    codeHash: async (address, n) => cast('keccak', await rpc(url, 'eth_getCode', [address, hex(n)])),
    call: async (address, view, _args, n) => wordAddress(words(await rpc(url, 'eth_call', [{ to: address, data: await calldata(`${view}()`) }, hex(n)]))[0]),
  };
  const problems = await checkTestnetReleaseOnChain(manifest, reads);
  if (problems.length) throw new Error(`on-chain check: ${problems.join('; ')}`);
  const result = { manifestParsed: true, onChainProblems: problems };
  const { parseCreateOptions } = await import(join(ROOT, 'packages/chain/src/create-options/schema.ts'));
  const release = manifest.releases[0];
  const options = parseCreateOptions(readFileSync(targets.createOptions, 'utf8'), { chainId: 97,
    factory: release.factory.address.toLowerCase(), registry: release.registry.address.toLowerCase(), versionCodeHash: release.versionCodeHash });
  if (!options.ok) throw new Error(`create-options data refused: ${options.reason}`);
  result.createOptions = `parses for this release, off: ${options.document.off.map(o => o.key).join(', ')}`;
  if (existsSync(targets.coins)) {
    const { parseCoinDeployment } = await import(join(ROOT, 'packages/chain/src/trade-sepolia/coin-deployment.ts'));
    const record = JSON.parse(readFileSync(targets.coins, 'utf8'));
    try {
      parseCoinDeployment(record);
      result.coinRecord = 'parses with its real chain id 97';
    } catch {
      // The parser on this branch takes 31337 and 11155111 only (SH-258 widens it to 97 on its branch). Everything but
      // the chain id literal is then checked: the same record with 31337 in its place must parse.
      parseCoinDeployment({ ...record, chainId: 31337 });
      result.coinRecord = 'parses with its chain id swapped for 31337: this branch\'s parser does not take 97 yet';
    }
  }
  return result;
}

// ---- Rehearsals on anvil (chain id 97): plain, or a fork of the real test network. The deployer is impersonated.

async function startAnvil(mode, port, forkUrl, out, dump) {
  const args = ['--host', '127.0.0.1', '--port', String(port), '--hardfork', 'osaka', '--gas-limit', '100000000',
    '--base-fee', '0', ...(dump ? ['--dump-state', dump] : [])];
  if (mode === 'plain') args.push('--chain-id', '97');
  else args.push('--fork-url', forkUrl, '--no-storage-caching');
  const { openSync, closeSync } = await import('node:fs');
  const logFd = openSync(join(out, 'anvil.log'), 'a');
  const child = spawn('anvil', args, { stdio: ['ignore', logFd, logFd] });
  closeSync(logFd);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error('anvil exited before it was ready');
    try { if (BigInt(await rpc(url, 'eth_chainId')) === CHAIN_ID) return { child, url }; } catch { /* not up yet */ }
    await delay(200);
  }
  throw new Error('anvil readiness');
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGINT'); // anvil writes its --dump-state file on a graceful stop
  for (let i = 0; i < 600 && child.exitCode === null; i++) await delay(100);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function assertAnvil(url) {
  if (!(await rpc(url, 'web3_clientVersion')).startsWith('anvil/')) throw new Error('a rehearsal runs on anvil only');
  if (BigInt(await rpc(url, 'eth_chainId')) !== CHAIN_ID) throw new Error('chain id 97 expected');
}

async function send(url, to, data, value = 0n) {
  const hash = await rpc(url, 'eth_sendTransaction', [{ from: DEPLOYER, to, data, value: hex(value), gas: hex(1_000_000n) }]);
  for (let i = 0; i < 100; i++) {
    const r = await rpc(url, 'eth_getTransactionReceipt', [hash]);
    if (r) { if (BigInt(r.status) !== 1n) throw new Error(`transaction to ${to} reverted`); return r; }
    await delay(100);
  }
  throw new Error('receipt');
}

/** Fork only: the real WBNB takes a deposit and gives it back (WETH9's deposit, balanceOf, withdraw). */
async function proveWbnb(url) {
  const amount = 10n ** 15n;
  const before = BigInt(await call(url, WBNB, 'balanceOf(address)', DEPLOYER));
  await send(url, WBNB, await calldata('deposit()'), amount);
  const held = BigInt(await call(url, WBNB, 'balanceOf(address)', DEPLOYER));
  await send(url, WBNB, await calldata('withdraw(uint256)', amount));
  const after = BigInt(await call(url, WBNB, 'balanceOf(address)', DEPLOYER));
  if (held - before !== amount || after !== before) throw new Error('WBNB deposit and withdraw do not match WETH9');
  return { amount: amount.toString(), before: before.toString(), held: held.toString(), after: after.toString(), ok: true };
}

/** One known drand quicknet round (test/vectors/drand-quicknet-box.json) posted through the deployed DrandSource. */
async function proveDrand(url, drand, { send: sending = true } = {}) {
  const v = JSON.parse(readFileSync(join(CONTRACTS, 'test/vectors/drand-quicknet-box.json'), 'utf8'));
  const i = v.rounds.length - 1;
  const data = await calldata('postRound(uint256,bytes)', v.rounds[i], v.signaturesXY[i]);
  const answer = await rpc(url, 'eth_call', [{ from: DEPLOYER, to: drand, data }, 'latest']);
  const result = { round: v.rounds[i], expected: v.randomness[i], ethCall: answer, ok: answer === v.randomness[i] };
  if (sending && result.ok) {
    await send(url, drand, data);
    result.posted = `0x${words(await call(url, drand, 'beaconOf(uint256)', v.rounds[i]))[0]}` === v.randomness[i];
  }
  return result;
}

/** A visitor (an address that never held anything) drips one tETH from the open faucet; each tETH pair has liquidity. */
async function proveFaucet(url, s) {
  const visitor = '0x000000000000000000000000000000000000bEEF';
  await rpc(url, 'anvil_impersonateAccount', [visitor]);
  await rpc(url, 'anvil_setBalance', [visitor, hex(10n ** 16n)]);
  const hash = await rpc(url, 'eth_sendTransaction', [{ from: visitor, to: s.coins.teth, data: await calldata('drip()'), gas: hex(200_000n) }]);
  let receipt = null;
  for (let i = 0; i < 100 && !receipt; i++) { receipt = await rpc(url, 'eth_getTransactionReceipt', [hash]); if (!receipt) await delay(100); }
  await rpc(url, 'anvil_stopImpersonatingAccount', [visitor]);
  const dripped = BigInt(await call(url, s.coins.teth, 'balanceOf(address)', visitor));
  const liquidity = {};
  for (const k of ['usdc', 'nvda', 'gold', 'pepe']) liquidity[k] = (await readUint(url, s.helpers.pairs, 'liquidity(address,address)', s.coins.teth, s.coins[k])).toString();
  return { dripped: dripped.toString(), ok: BigInt(receipt.status) === 1n && dripped === ETHER && Object.values(liquidity).every(l => BigInt(l) > 0n), liquidity };
}

async function rehearse(o) {
  const mode = o.mode ?? 'plain';
  if (!['plain', 'fork'].includes(mode)) throw new Error('--mode plain|fork');
  const port = Number(o.port ?? (mode === 'plain' ? 8573 : 8574));
  const out = scratchPath(o.out ?? join(ROOT, '.cache/bnb-rehearsal', `${mode}-${Date.now()}`), 'a rehearsal\'s output');
  mkdirSync(out, { recursive: true });
  const p = params(o);
  const log = (step, text) => writeFileSync(join(out, `${step}.log`), text);
  // --dump: the chain's whole state (blocks, transactions, logs) is written there when anvil stops; another anvil
  // starts from it with `anvil --load-state <file> --chain-id 97 --hardfork osaka --base-fee 0 --gas-limit 100000000`.
  const dump = o.dump ? scratchPath(o.dump, 'the dump') : null;
  const { child, url } = await startAnvil(mode, port, o['fork-url'] ?? FORK_URL, out, dump);
  const result = { mode, port, started: new Date().toISOString(), deployer: DEPLOYER, params: p, complete: false };
  // --from-state: a fork rehearsal that continues a real run's state file (steps already in it are not sent again).
  const s = o['from-state'] ? JSON.parse(readFileSync(resolve(o['from-state']), 'utf8')) : { chainId: 97, deployer: DEPLOYER };
  if (o['from-state'] && mode !== 'fork') throw new Error('--from-state continues a real run: fork mode only');
  try {
    await assertAnvil(url);
    result.client = await rpc(url, 'web3_clientVersion');
    result.forkBlock = mode === 'fork' ? BigInt(await rpc(url, 'eth_blockNumber')).toString() : null;
    result.deployerAtStart = { nonce: BigInt(await rpc(url, 'eth_getTransactionCount', [DEPLOYER, 'latest'])).toString(),
      balance: BigInt(await rpc(url, 'eth_getBalance', [DEPLOYER, 'latest'])).toString() };
    result.codeAt = { wbnb: (await rpc(url, 'eth_getCode', [WBNB, 'latest'])).length > 2,
      v4PoolManager56: (await rpc(url, 'eth_getCode', ['0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF', 'latest'])).length > 2 };
    if (mode === 'plain' && !o['from-state']) {
      // The real network has WBNB at its address: plant WETH9-shaped code there so the plain chain takes the same path
      // (and the same nonces, so the same addresses) as the fork and the real run.
      const weth = JSON.parse(readFileSync(join(CONTRACTS, 'out/LocalQuoteMocks.sol/LocalWETH9.json'), 'utf8'));
      await rpc(url, 'anvil_setCode', [WBNB, weth.deployedBytecode.object]);
      result.plantedWbnb = 'LocalWETH9 runtime at the WBNB address';
    }
    await rpc(url, 'anvil_impersonateAccount', [DEPLOYER]);
    await rpc(url, 'anvil_setBalance', [DEPLOYER, hex(100n * ETHER)]);
    const balanceStart = BigInt(await rpc(url, 'eth_getBalance', [DEPLOYER, 'latest']));
    s.startBlock ??= BigInt(await rpc(url, 'eth_blockNumber')).toString();
    const signer = ['--unlocked'];
    const ctx = { url, signer, log, broadcastRoot: join(out, 'broadcast'), save: st => saveState(join(out, 'state.json'), st) };
    const interruptStep = o['interrupt-step'] ?? (o.interrupt ? 'release' : null);
    result.interrupts = [];
    for (const step of STEPS) {
      if (s.gas?.[gasKey(step, p)]) continue; // done in the state this rehearsal continues
      if (step === interruptStep && o.interrupt) result.interrupts.push(await interrupted(step, s, p, ctx, Number(o.interrupt)));
      else await runStep(step, s, p, ctx);
      // A finished restartable step run a second time sends nothing.
      if (RESTARTABLE.has(step) && o['second-runs']) result.interrupts.push(await secondRun(step, s, p, ctx));
    }
    if (o['prove-release-recovery']) result.releaseRecovery = await releaseRecovery(s, p, ctx);
    // --again: every step once more, as the runbook's deploy would: a restartable step runs its script (which must send
    // nothing), any other step is read on chain; the deployer's nonce must not move.
    if (o.again) result.again = await againAll(s, p, ctx);
    const balanceEnd = BigInt(await rpc(url, 'eth_getBalance', [DEPLOYER, 'latest']));
    result.deployerSpent = (balanceStart - balanceEnd).toString();
    result.table = gasTable(s);
    writeFileSync(join(out, 'gas.md'), gasMarkdown(result.table));
    // The files are read at the endpoint's finalized block: on anvil that trails the head, so mine past it first.
    await rpc(url, 'anvil_mine', [hex(200n)]);
    const files = await readFiles(url, s, { p, gitCommit: typeof o['git-commit'] === 'string' ? o['git-commit'] : null });
    result.files = writeFiles(join(out, 'files'), files);
    result.check = await checkFiles(url, result.files);
    result.nativePools = files.extras.nativePools.map(({ symbol, sqrtPriceX96, statedPrice, priceAsStated }) => ({ symbol, sqrtPriceX96, statedPrice, priceAsStated }));
    if (files.extras.nativePools.length !== 2 || !files.extras.nativePools.every(x => x.priceAsStated)) throw new Error('a native pool is missing or not at its stated price');
    if (files.coinDeployment?.pairs.length !== 4) throw new Error('the coin record has not four tETH pairs');
    result.raiseFloor = await raiseFloor(url, s.listingRegistry);
    // Proofs after the runbook's steps, so their transactions never move the deployer's nonces of the real run.
    if (mode === 'fork') result.wbnb = await proveWbnb(url);
    result.drand = await proveDrand(url, s.dependencies.drand);
    result.faucet = await proveFaucet(url, s);
    // The proof that the release is wired: a BNB box and a tNVDA box, each created, bought into, sold from and filled.
    if (!o['no-box']) {
      // Release modules become selectable a day after the directory: move this rehearsal chain past it first.
      await rpc(url, 'evm_increaseTime', [hex(86_401n)]);
      await rpc(url, 'evm_mine', []);
      for (const step of ['box-bnb', 'box-nvda']) await runStep(step, s, p, ctx);
      // Past the later box's open time and its launch window (buys go through the launch router until then).
      let open = 0n;
      for (const box of Object.values(s.boxes)) { const at = await readUint(url, box, 'effectiveOpenAt()'); if (at > open) open = at; }
      const now = BigInt((await rpc(url, 'eth_getBlockByNumber', ['latest', false])).timestamp);
      if (open + 400n > now) await rpc(url, 'evm_increaseTime', [hex(open + 400n - now)]);
      await rpc(url, 'evm_mine', []);
      for (const step of ['trade-bnb', 'trade-nvda']) await runStep(step, s, p, ctx);
      result.boxes = s.boxes;
      result.boxGas = gasTable({ gas: Object.fromEntries(['box-bnb', 'box-nvda', 'trade-bnb', 'trade-nvda'].map(k => [k, s.gas[k]])) });
      result.boxReads = {};
      for (const [name, box] of Object.entries(s.boxes)) {
        result.boxReads[name] = { graduated: BigInt(await call(url, box, 'graduated()')) === 1n,
          raise: (await readUint(url, box, 'raise()')).toString() };
      }
    }
    saveState(join(out, 'state.json'), s);
    result.complete = true;
  } catch (error) {
    result.error = String(error.stack ?? error);
    if (error.out) writeFileSync(join(out, 'failed-step.log'), error.out);
  } finally {
    await stopChild(child);
    writeFileSync(join(out, 'result.json'), json(result));
  }
  say(`${result.complete ? 'REHEARSAL COMPLETE' : 'REHEARSAL FAILED'} ${mode} -> ${out}`);
  if (result.table) process.stdout.write(gasMarkdown(result.table));
  if (!result.complete) { say(result.error); process.exitCode = 1; }
  return result;
}

/** The smallest raw raise `ListingRegistry.checkLayout` accepts (the same rule for every coin: raw units only), by
 * bisection, then checked at the floor and refused one unit below it. Read-only. */
export async function raiseFloor(url, registry) {
  const ok = async raise => { try { await call(url, registry, 'checkLayout(uint256)', raise); return true; } catch { return false; } };
  let lo = 1n; let hi = 10n ** 18n;
  if (!(await ok(hi))) throw new Error('one whole coin (1e18 raw) does not build');
  while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (await ok(mid)) hi = mid; else lo = mid; }
  const probes = {};
  for (const r of [hi - 1n, hi, hi * 10n, 10n ** 12n, 10n ** 13n, 10n ** 14n, 10n ** 15n, 10n ** 16n]) probes[r.toString()] = await ok(r);
  return { floor: hi.toString(), probes };
}

/** A step stopped after `after` of its transactions (forge stopped by its PID with SIGINT, as Ctrl-C or a dropped
 * session would), then what the runbook says: a release first with forge's `--resume` and, if forge refuses, the step
 * again (which first looks for the factory on chain); any other step again from its start. */
async function interrupted(step, s, p, ctx, after) {
  const start = await nonceOf(ctx.url);
  let child; let stopped = null;
  const watch = (async () => {
    while (!child || child.exitCode === null) {
      const nonce = await nonceOf(ctx.url);
      if (child && nonce >= start + BigInt(after)) { stopped = nonce - start; child.kill('SIGINT'); return; }
      await delay(50);
    }
  })();
  const first = await runStep(step, s, p, { ...ctx, log: (st, out) => ctx.log(`${st}-interrupted`, out), onSpawn: c => { child = c; } })
    .then(() => 'completed before the interruption', e => `stopped: ${e.message}`);
  await watch;
  const mid = await nonceOf(ctx.url);
  const pendingAfterStop = s.pending ? { step: s.pending.step, startNonce: s.pending.startNonce } : null;
  let resumed = null;
  if (step === 'release' && s.pending) {
    resumed = await runStep(step, s, p, { ...ctx, resume: true, log: (st, out) => ctx.log(`${st}-resumed`, out) })
      .then(() => 'forge --resume completed the release', e => `forge --resume refused: ${e.message}`);
  }
  let again = null;
  if (s.pending) {
    const before = await nonceOf(ctx.url);
    await runStep(step, s, p, { ...ctx, log: (st, out) => ctx.log(`${st}-again`, out) });
    const key = gasKey(step, p);
    again = { sentTransactions: s.gas[key].transactions.length, nonceMoved: (await nonceOf(ctx.url) - before).toString() };
  }
  return { step, startNonce: start.toString(), stoppedAfter: stopped?.toString() ?? null, nonceAtStop: mid.toString(),
    first, pendingAfterStop, resumed, again, endNonce: (await nonceOf(ctx.url)).toString() };
}

/** Every step of a complete state run again: nothing may be sent. */
async function againAll(s, p, ctx) {
  const report = [];
  for (const step of STEPS) {
    const before = await nonceOf(ctx.url);
    if (RESTARTABLE.has(step)) report.push(await secondRun(step, s, p, ctx));
    else {
      const problems = await postconditions(step, s, p, ctx.url);
      if (problems.length) throw new Error(`${step} does not hold: ${problems.join('; ')}`);
      report.push({ step, readOnChain: true, nonceMoved: (await nonceOf(ctx.url) - before).toString() });
    }
  }
  if (report.some(r => r.nonceMoved !== '0')) throw new Error('a step sent a transaction on its second run');
  return report;
}

/** A restartable step run a second time after it completed: it must send nothing. */
async function secondRun(step, s, p, ctx) {
  const key = gasKey(step, p); const kept = s.gas[key];
  const before = await nonceOf(ctx.url);
  await runStep(step, s, p, { ...ctx, log: (st, out) => ctx.log(`${st}-second`, out) });
  const second = { step, secondRun: true, nonceMoved: (await nonceOf(ctx.url) - before).toString(), nothingToSend: Boolean(s.gas[key].nothingToSend) };
  s.gas[key] = kept;
  if (second.nonceMoved !== '0') throw new Error(`a second ${step} sent transactions`);
  return second;
}

/** A release whose record is lost after its last transaction: with the pending marker back and the factory forgotten,
 * the step finds the factory on chain and sends nothing. */
async function releaseRecovery(s, p, ctx) {
  const kept = { factory: s.factory, gas: s.gas.release };
  s.pending = { step: 'release', startNonce: kept.gas.transactions[0].nonce };
  delete s.factory;
  const before = await nonceOf(ctx.url);
  await runStep('release', s, p, ctx);
  const result = { found: s.factory, same: s.factory?.toLowerCase() === kept.factory.toLowerCase(), nonceMoved: (await nonceOf(ctx.url) - before).toString() };
  s.factory = kept.factory; s.gas.release = kept.gas;
  ctx.save(s);
  if (!result.same || result.nonceMoved !== '0') throw new Error('release recovery failed');
  return result;
}

function params(o) {
  const big = (k, d) => (o[k] === undefined ? d : BigInt(o[k]));
  return { trigger: o.trigger ?? KEEPER, nativeRaise: big('native-raise', DEFAULTS.nativeRaise),
    coinRaises: Object.fromEntries(Object.entries(DEFAULTS.coinRaises).map(([k, d]) => [k, big(`${k}-raise`, d)])),
    bnbPerPool: big('bnb-per-pool', DEFAULTS.bnbPerPool), nvdaInPair: big('nvda-in-pair', DEFAULTS.nvdaInPair),
    routes: Number(o.routes ?? 7), extraArgs: o['extra-args'] ? String(o['extra-args']).split(',') : [] };
}

// ---- The real run: the orchestrator's commands. Only the runbook's public endpoints, only chain 97, a keystore name.

/** A real run's endpoint: one of the runbook's public chain-97 RPCs, answering chain id 97 (so never a local node). */
async function realEndpoint(url) {
  if (!ALLOWED_RPCS.includes(url)) throw new Error(`a real run uses only these endpoints: ${ALLOWED_RPCS.join(', ')}`);
  if (BigInt(await rpc(url, 'eth_chainId')) !== CHAIN_ID) throw new Error('not chain 97');
  return url;
}

async function deploy(o) {
  const url = await realEndpoint(o['rpc-url']);
  const account = o.account;
  if (typeof account !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(account)) throw new Error('--account takes a keystore name (letters, digits, . _ -)');
  if (o['password-file'] !== undefined && typeof o['password-file'] !== 'string') throw new Error('--password-file takes a path');
  if (o['skip-balance-check'] && !o.resume) throw new Error('--skip-balance-check goes with --resume only');
  const statePath = resolve(o.state ?? join(ROOT, '.cache/bnb-testnet/97-state.json'));
  mkdirSync(dirname(statePath), { recursive: true });
  const s = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { chainId: 97, deployer: DEPLOYER };
  const p = params(o);
  const steps = o.extra ? [`extra:${o.extra}`] : String(o.steps ?? '').split(',').filter(Boolean);
  for (const step of steps) if (!STEPS.includes(step) && !step.startsWith('extra:')) throw new Error(`unknown step ${step}`);
  // The keystore's password reaches forge as a file path it reads itself; this script never opens it.
  const signer = ['--account', account, ...(o['password-file'] ? ['--password-file', o['password-file']] : [])];
  const logDir = join(dirname(statePath), 'logs'); mkdirSync(logDir, { recursive: true });
  const ctx = { url, signer, broadcastRoot: join(dirname(statePath), 'broadcast'), save: st => saveState(statePath, st),
    log: (st, out) => writeFileSync(join(logDir, `${safeName(st)}-${Date.now()}.log`), out) };
  for (const step of steps) {
    if (s.gas?.[gasKey(step, p)] && !s.pending) {
      // A completed step is not sent again: its results are read on chain instead.
      const problems = await postconditions(step, s, p, url);
      if (problems.length) throw new Error(`step ${step} is in the state file but does not hold on chain: ${problems.join('; ')}`);
      say(`${step}: already complete (its results read on chain); nothing sent`);
      continue;
    }
    const nonce = await nonceOf(url);
    const balance = BigInt(await rpc(url, 'eth_getBalance', [DEPLOYER, 'latest']));
    say(`${step}: deployer nonce ${nonce}, balance ${bnbExact(balance)} tBNB`);
    // Refuse before sending when the wallet holds less than the step's rehearsal cost plus 10%: a step that runs dry
    // in the middle has to be paid again from its start (a release) or continued (a restartable step).
    const need = stepNeed(step, p, o);
    if (balance < need && !o['skip-balance-check']) {
      throw new Error(`${step}: the wallet holds ${bnbExact(balance)} tBNB, the step needs ${bnbExact(need)} tBNB (rehearsal cost plus 10%); nothing sent`);
    }
    if (step === 'dependencies' && !s.startBlock) s.startBlock = BigInt(await rpc(url, 'eth_blockNumber')).toString();
    await runStep(step, s, p, { ...ctx, resume: Boolean(o.resume) });
    const entry = s.gas[gasKey(step, p)];
    const t = gasTable({ gas: { [gasKey(step, p)]: entry } });
    say(`${step}: done, ${t.count} transactions${entry.recovered ? ' (factory found on chain, nothing sent)' : ''}${entry.nothingToSend ? ' (everything already on chain)' : ''}, ${t.total} gas, ${bnbExact(t.bnb)} tBNB`);
  }
  process.stdout.write(gasMarkdown(gasTable(s)));
}

/** The files, read at one finalized block into a staging folder and checked there; with `--write-repo` (the real
 * run's endpoint only) they then move to the repository's places. Any problem: non-zero exit, nothing published. */
async function files(o) {
  const real = Boolean(o['write-repo']);
  const url = real ? await realEndpoint(o['rpc-url']) : o['rpc-url'];
  if (real && o.out) throw new Error('--write-repo stages into a fresh folder of its own: no --out');
  const s = JSON.parse(readFileSync(resolve(o.state ?? join(ROOT, '.cache/bnb-testnet/97-state.json')), 'utf8'));
  if (s.pending) throw new Error(`step ${s.pending.step} stopped before it completed`);
  if (BigInt(await rpc(url, 'eth_chainId')) !== CHAIN_ID) throw new Error('not chain 97');
  const p = params(o);
  const read = await readFiles(url, s, { gitCommit: typeof o['git-commit'] === 'string' && /^[0-9a-f]{40}$/.test(o['git-commit']) ? o['git-commit'] : null, p });
  // A fresh, private staging folder for a real publication (never one that holds older files).
  const dir = o.out ?? join(ROOT, '.cache/bnb-testnet', `staging-${Date.now()}-${process.pid}`);
  if (real) mkdirSync(scratchPath(dir, 'the staging folder'), { recursive: false, mode: 0o700 });
  const staged = writeFiles(dir, read);
  const check = await checkFiles(url, staged);
  const published = real ? publishFiles(staged, read) : null;
  say(json({ staged, evidence: read.manifest.evidence, check, published }));
}

/** Read-only facts of an endpoint: chain id, gas price, the deployer, code at WBNB and chain 56's v4 address, Osaka's
 * CLZ opcode, and one drand quicknet round verified by the chain's own precompiles (eth_call with DrandSource's code
 * overridden at a free address: nothing is sent). */
async function probe(o) {
  const url = o['rpc-url'];
  const chainId = BigInt(await rpc(url, 'eth_chainId'));
  if (chainId !== CHAIN_ID) throw new Error(`chain ${chainId}, not 97: nothing else read`);
  const facts = { chainId: chainId.toString(), client: await rpc(url, 'web3_clientVersion'),
    block: BigInt(await rpc(url, 'eth_blockNumber')).toString(), gasPrice: BigInt(await rpc(url, 'eth_gasPrice')).toString(),
    deployer: { address: DEPLOYER, nonce: BigInt(await rpc(url, 'eth_getTransactionCount', [DEPLOYER, 'latest'])).toString(),
      balance: bnb(await rpc(url, 'eth_getBalance', [DEPLOYER, 'latest'])) },
    wbnbCodeBytes: ((await rpc(url, 'eth_getCode', [WBNB, 'latest'])).length - 2) / 2,
    v4PoolManager56CodeBytes: ((await rpc(url, 'eth_getCode', ['0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF', 'latest'])).length - 2) / 2,
    clzOfOne: BigInt(await rpc(url, 'eth_call', [{ data: '0x60011e5f5260205ff3' }, 'latest'])).toString() };
  const runtime = JSON.parse(readFileSync(join(CONTRACTS, 'out/DrandSource.sol/DrandSource.json'), 'utf8')).deployedBytecode.object;
  const v = JSON.parse(readFileSync(join(CONTRACTS, 'test/vectors/drand-quicknet-box.json'), 'utf8'));
  const i = v.rounds.length - 1; const at = '0x00000000000000000000000000000000000d7a4d';
  const answer = await rpc(url, 'eth_call', [{ to: at, data: await calldata('postRound(uint256,bytes)', v.rounds[i], v.signaturesXY[i]) },
    'latest', { [at]: { code: runtime } }]);
  facts.drand = { round: v.rounds[i], expected: v.randomness[i], answer, verified: answer === v.randomness[i] };
  say(json(facts));
  return facts;
}

function parseFlags(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) throw new Error(`unexpected ${a}`);
    const key = a.slice(2);
    if (i + 1 < args.length && !args[i + 1].startsWith('--')) o[key] = args[++i]; else o[key] = true;
  }
  return o;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const o = parseFlags(rest);
  const commands = { rehearse, deploy, files, probe };
  if (!commands[command]) { console.error('usage: bnb-testnet.mjs probe|rehearse|deploy|files [--flags]'); process.exit(2); }
  commands[command](o).catch(error => { console.error(error.stack ?? error); process.exit(1); });
}
