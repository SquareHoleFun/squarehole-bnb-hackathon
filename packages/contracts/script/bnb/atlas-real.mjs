#!/usr/bin/env node
/**
 * SH-266 and SH-272: the operator's tool for the Atlas raise contracts on BNB Chain testnet (chain 97), while the keeper
 * service stays dry. THIS TOOL IS THE KEEPER WALLET'S ONLY SENDER WHILE THE KEEPER SERVICE IS DRY: never run both.
 *
 *   poke <row>.. refused unless the setter holds the registry's lister role; reads each row's quote; a row without a
 *                fresh quote, still in its wait, or moving less than 2% is skipped with its reason, as is a row whose
 *                reads fail; the others go on, one transaction each, and each changed raise is read back. No row: every
 *                row the setter manages.
 *   status       per managed row of the setter: direct or copy, age against its limit, the quote, the registry's raise,
 *                seconds until a poke may change it; and who holds the lister role.
 *   record       writes deployments/bnb-testnet/97-atlas.json (or --out) from the deploy driver's state file (--state:
 *                forge's broadcast records of deployOpen, handBack and handover as the driver kept them) and chain reads:
 *                the source, the setter, each row's feed and age limit read from the source, the mirror as it is, the
 *                setter's first raises from its own events, and a `retired` part naming the first deployment (first
 *                source, first two setters, first BNB/USD feed) with its whole earlier record. Nobody types an address.
 *   relay        (SH-266; kept, unused since SH-272: every managed row reads Atlas directly, no row needs the copy.) Per
 *                feed of the file: copies an answer into the mirror when the source has no direct answer for it.
 *
 *   node script/bnb/atlas-real.mjs <poke 0 2 3 5|status|record|relay> [--fork <loopback anvil url>]
 *        [--state <deploy driver state file>]                    (the setter of its deployOpen step; record needs it)
 *        [--setter <address>]                                    (otherwise the setter of --state, else of the file)
 *        [--out <file>]                                          (record: where to write; default the repository's file)
 *        [--account <keystore name> --password-file <path>]     (real sends: the keeper's keystore; read by cast only)
 *        [--rpc-a <url>] [--rpc-b <url>]                         (two endpoints of chain 97 from different providers)
 *
 * Sends: both endpoints must serve chain 97 and the signature pins chain 97; the keystore's address must be the mirror's
 * writer (the keeper's wallet); legacy, at the larger of the two endpoints' gas prices (never below 0.1 gwei), refused
 * when the two differ by more than a quarter or the price is above 0.5 gwei; a fixed gas limit per kind; an explicit
 * nonce (the highest mined count of the two endpoints). A send whose result is unclear (no receipt, a timeout) STOPS the
 * whole command, and a receipt that is not success is an error. --fork <url>: a dry run against an anvil forking the
 * real chain (loopback only); the keeper is impersonated there and every send goes there. Without --fork and without
 * --account nothing is sent (reads only). Record reads, without --fork, come from both endpoints at one block and must
 * agree. Never a key on a command line or in a file of ours.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { CONTRACTS, DEPLOYER, KEEPER, ROOT, run } from './bnb-testnet.mjs';

const UINT80 = (1n << 80n) - 1n;
const GWEI = 1_000_000_000n;
const PRICE_FLOOR = GWEI / 10n;
const PRICE_CEILING = GWEI / 2n;
const PUSH_GAS = 250_000n;
const POKE_GAS = 900_000n;
const FILE = join(CONTRACTS, 'deployments/bnb-testnet/97-atlas.json');
const deployed = JSON.parse(readFileSync(FILE, 'utf8'));
/** The deploy driver's step keys (bnb-testnet.mjs deploy --extra '<path>:<Contract>:<sig>'). */
const STEP = sig => `extra:script/bnb/AtlasRaiseDeploy.s.sol:AtlasRaiseDeploy:${sig}`;
const DEPLOY_STEP = STEP('deployOpen(address,address,uint256)');
const HANDOVER_STEP = STEP('handover(address,address,address,uint256,address)');
const HANDBACK_STEP = STEP('handBack(address,address)');
/** Feed ids and their pairs (AtlasRaiseDeploy.s.sol): Atlas's numbers 633, 632 and 934; XAU/USD keyed by the bytes "XAU". */
const PAIRS = { '0x00000279': 'BNB/USD', '0x00000278': 'ETH/USD', '0x000003a6': 'NVDAB/USD', '0x58415500': 'XAU/USD' };
const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  setter: { type: 'string' }, fork: { type: 'string' }, account: { type: 'string' }, 'password-file': { type: 'string' },
  state: { type: 'string' }, out: { type: 'string' },
  'rpc-a': { type: 'string' }, 'rpc-b': { type: 'string' },
} });
const [command, ...rest] = positionals;
if (!['relay', 'poke', 'status', 'record'].includes(command)) throw new Error('usage: atlas-real.mjs poke <row>... | status | record --state <file> | relay [--fork] [--account --password-file]');
if (command === 'record' && (!o.state || o.account)) throw new Error('record reads --state and sends nothing (no --account)');
if (Boolean(o.account) !== Boolean(o['password-file'])) throw new Error('--account and --password-file go together');
if (o.account && !/^[A-Za-z0-9._-]{1,64}$/.test(o.account)) throw new Error('--account takes a keystore name');
if (o.account && o.fork) throw new Error('--fork sends to the fork as the impersonated keeper: no --account');
const RPC_A = o['rpc-a'] ?? 'https://bsc-testnet-rpc.publicnode.com';
const RPC_B = o['rpc-b'] ?? 'https://bsc-testnet-dataseed.bnbchain.org';
/** The registrable domain of an endpoint: two votes need two providers. */
const providerOf = url => new URL(url).hostname.toLowerCase().split('.').filter(Boolean).slice(-2).join('.');
if (providerOf(RPC_A) === providerOf(RPC_B)) throw new Error('the two endpoints must belong to two different providers');
const driverState = o.state ? JSON.parse(readFileSync(resolve(o.state), 'utf8')) : null;
const stateSetter = driverState?.extra?.[DEPLOY_STEP]?.atlasRaiseSetter;
if (o.state && !stateSetter) throw new Error(`--state holds no completed deployOpen step (${DEPLOY_STEP})`);
const setter = o.setter ?? stateSetter ?? deployed.setter;
const { source, mirror, listingRegistry: listings } = deployed;
const say = line => process.stdout.write(`${line}\n`);
const sending = Boolean(o.fork || o.account);

class Unclear extends Error {}

const cast = async (...args) => {
  const { code, out } = await run('cast', args, { timeoutMs: 180_000 });
  if (code !== 0) throw Object.assign(new Error(`cast ${args[0]}: ${out.trim().split('\n').slice(-1)[0]}`), { out });
  return out.trim();
};
const words = hex => (/^0x([0-9a-f]{64})*$/i.test(hex) ? hex.slice(2).match(/.{64}/g)?.map(w => BigInt(`0x${w}`)) ?? [] : null);
const first = text => text.split('\n')[0].trim().split(' ')[0];
const reasonOf = error => (String(error.out ?? error.message).match(/(NoFreshPrice|AboveCeiling|BelowFloor|LowGas|NotManaged|NotLister|StalePrice|FuturePrice|NoPrice)[^\n"]*/) ?? [String(error.message).slice(0, 160)])[0];
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

let url = RPC_A;
async function preflight() {
  for (const e of [RPC_A, RPC_B]) if ((await cast('chain-id', '--rpc-url', e)) !== '97') throw new Error(`${e} does not serve chain 97`);
  if (o.fork) {
    if (!/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+$/.test(o.fork)) throw new Error('--fork takes a loopback anvil url');
    url = o.fork;
    if (!(await cast('rpc', '--rpc-url', url, 'web3_clientVersion')).includes('anvil')) throw new Error('--fork: not anvil');
    if ((await cast('chain-id', '--rpc-url', url)) !== '97') throw new Error('--fork: not a fork of chain 97');
    await cast('rpc', '--rpc-url', url, 'anvil_impersonateAccount', KEEPER);
  }
  if (sending) {
    const writer = await cast('call', '--rpc-url', url, mirror, 'writer()(address)');
    const signer = o.account ? await cast('wallet', 'address', '--account', o.account, '--password-file', o['password-file']) : KEEPER;
    if (!same(signer, writer)) throw new Error(`the signer ${signer} is not the mirror's writer ${writer}`);
  }
}

/** One legacy transaction from the keeper's wallet; an unclear result stops the command, a failed receipt is an error. */
async function send(to, sig, args, gasLimit) {
  if (!sending) { say(`  (reads only: would send ${sig} ${args.join(' ')})`); return null; }
  const prices = await Promise.all([RPC_A, RPC_B].map(async e => BigInt(await cast('gas-price', '--rpc-url', e))));
  const [lo, hi] = prices[0] < prices[1] ? prices : [prices[1], prices[0]];
  if ((hi - lo) * 4n > hi) throw new Error(`the two endpoints' gas prices differ by more than a quarter (${prices.join(', ')})`);
  const gasPrice = hi > PRICE_FLOOR ? hi : PRICE_FLOOR;
  if (gasPrice > PRICE_CEILING) throw new Error(`gas price ${gasPrice} above the ceiling ${PRICE_CEILING}`);
  const nonces = o.fork ? [BigInt(await cast('nonce', '--rpc-url', url, KEEPER))]
    : await Promise.all([RPC_A, RPC_B].map(async e => BigInt(await cast('nonce', '--rpc-url', e, KEEPER))));
  const nonce = nonces.reduce((m, n) => (n > m ? n : m), 0n);
  const signer = o.fork ? ['--unlocked', '--from', KEEPER] : ['--account', o.account, '--password-file', o['password-file']];
  let out;
  try {
    out = JSON.parse(await cast('send', '--rpc-url', url, '--chain', '97', ...signer, '--legacy', '--gas-price', gasPrice.toString(),
      '--nonce', nonce.toString(), '--gas-limit', gasLimit.toString(), '--timeout', '120', '--json', to, sig, ...args));
  } catch (error) {
    throw new Unclear(`the result of ${sig.split('(')[0]} at nonce ${nonce} is unclear (${reasonOf(error)}): stopped; look the nonce up before anything else`);
  }
  if (out?.status !== '0x1') throw new Error(`${sig.split('(')[0]} at nonce ${nonce} failed on chain: ${out?.transactionHash} status ${out?.status}`);
  say(`  sent ${sig.split('(')[0]}: ${out.transactionHash} status ${out.status} gas ${BigInt(out.gasUsed)} nonce ${nonce} price ${gasPrice}`);
  return out;
}

const chainNow = async () => BigInt(await cast('block', '--rpc-url', url, 'latest', '-f', 'timestamp'));

/** One feed's answer from both endpoints, or why not. */
async function agreedAnswer(feed, now, limit) {
  const dec = await Promise.all([RPC_A, RPC_B].map(e => cast('call', '--rpc-url', e, feed, 'decimals()')));
  if (!dec.every(d => { const w = words(d); return w && w.length === 1 && w[0] === 18n; })) return { why: 'decimals() is not one word equal to 18 on both endpoints' };
  const raw = await Promise.all([RPC_A, RPC_B].map(e => cast('call', '--rpc-url', e, feed, 'latestRoundData()')));
  if (raw[0] !== raw[1]) return { why: 'the two endpoints differ' };
  const w = words(raw[0]);
  if (!w || w.length !== 5) return { why: 'not five words' };
  const [round, answer, startedAt, updatedAt, answeredIn] = w;
  if (round > UINT80 || answeredIn > UINT80) return { why: 'a round word wider than 80 bits' };
  if (answer === 0n || answer > UINT80) return { why: 'price zero, negative or wider than 80 bits' };
  if (startedAt === 0n || startedAt > updatedAt || updatedAt > now) return { why: 'times out of order or after the chain\'s time' };
  if (now - updatedAt > limit) return { why: `${now - updatedAt} s old, over its limit of ${limit} s` };
  return { answer, startedAt, updatedAt };
}

async function relay() {
  const now = await chainNow();
  const ids = [], snaps = [];
  for (const f of deployed.feeds) {
    try {
      const bound = await cast('call', '--rpc-url', url, source, 'directFeedOf(bytes4)(address)', f.id);
      if (!same(bound, f.feed)) { say(`${f.pair}: not copied: the source names ${bound} for ${f.id}, the file ${f.feed}`); continue; }
      const limit = BigInt(first(await cast('call', '--rpc-url', url, source, 'ageLimitOf(bytes4)(uint256)', f.id)));
      let direct = false;
      try { direct = (await cast('call', '--rpc-url', url, source, 'fetchWithOrigin(bytes4)(uint256,uint256,uint256,bool)', f.id)).trim().endsWith('true'); } catch { /* no fresh price at the source */ }
      if (direct) { say(`${f.pair}: Atlas answers the source directly; not copied`); continue; }
      const a = await agreedAnswer(f.feed, now, limit);
      if (a.why) { say(`${f.pair}: not copied: ${a.why}`); continue; }
      const held = BigInt((await cast('call', '--rpc-url', url, mirror, 'fetch(bytes4)((uint80,uint48,uint48))', f.id)).replace(/[()\s]/g, '').split(',')[2].replace(/\[.*$/, ''));
      if (a.updatedAt <= held) { say(`${f.pair}: the mirror already holds this answer`); continue; }
      say(`${f.pair}: ${a.answer} at ${a.updatedAt} (${now - a.updatedAt} s old of ${limit}), both endpoints agree`);
      ids.push(f.id); snaps.push(`(${a.answer},${a.startedAt},${a.updatedAt})`);
    } catch (error) { say(`${f.pair}: skipped, a read failed: ${reasonOf(error)}`); }
  }
  if (!ids.length) { say('relay: nothing to copy'); return; }
  await send(mirror, 'push(bytes4[],(uint80,uint48,uint48)[])', [`[${ids.join(',')}]`, `[${snaps.join(',')}]`], PUSH_GAS);
}

async function holder() { return cast('call', '--rpc-url', url, listings, 'lister()(address)'); }

async function rowStatus(id) {
  const now = await chainNow();
  const r = (await cast('call', '--rpc-url', url, setter, 'rows(uint32)(bool,uint8,uint8,address,bytes4,uint256,uint64)', String(id))).split('\n').map(x => x.trim().split(' ')[0]);
  const [managed, , , rowSource, feedId, startRaise, lastChange] = r;
  if (managed !== 'true') return { id, why: 'not a managed row' };
  const limit = BigInt(first(await cast('call', '--rpc-url', url, rowSource, 'ageLimitOf(bytes4)(uint256)', feedId)));
  const raise = BigInt((await cast('call', '--rpc-url', url, listings, 'listing(uint32)((uint32,address,uint8,uint8,uint8,uint64,uint256,(uint256,uint256,uint256,uint256)))', String(id))).replace(/[()]/g, '').split(',')[6].trim().split(' ')[0]);
  const acceptedAt = BigInt(first(await cast('call', '--rpc-url', url, setter, 'acceptedAt()(uint256)')));
  const waitUntil = [acceptedAt + 600n, BigInt(lastChange) === 0n ? 0n : BigInt(lastChange) + 3600n].reduce((m, x) => (x > m ? x : m), 0n);
  const out = { id, feedId, pair: PAIRS[feedId] ?? feedId, raise, ceiling: BigInt(startRaise) * 10n, limit, waitSeconds: waitUntil > now ? waitUntil - now : 0n };
  try {
    const q = (await cast('call', '--rpc-url', url, setter, 'quote(uint32)(uint256,uint256,uint256,uint256,bool)', String(id))).split('\n').map(x => x.trim().split(' ')[0]);
    Object.assign(out, { quote: BigInt(q[0]), price: BigInt(q[1]), age: now - BigInt(q[3]), direct: q[4] === 'true' });
  } catch (error) { out.why = reasonOf(error); }
  return out;
}

async function managedIds() {
  const n = Number(first(await cast('call', '--rpc-url', url, setter, 'managedCount()(uint256)')));
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(first(await cast('call', '--rpc-url', url, setter, 'managedIds(uint256)(uint32)', String(i))));
  return ids;
}

async function poke(rows) {
  const lister = await holder();
  if (!same(lister, setter)) throw new Error(`the setter ${setter} does not hold the lister role (${lister} does): nothing sent`);
  for (const id of rows) {
    let s;
    try { s = await rowStatus(Number(id)); } catch (error) { say(`row ${id}: skipped, a read failed: ${reasonOf(error)}`); continue; }
    if (s.why) { say(`row ${id}: skipped: ${s.why}`); continue; }
    const step = s.quote > s.raise ? s.quote - s.raise : s.raise - s.quote;
    if (s.waitSeconds > 0n) { say(`row ${id}: skipped: ${s.waitSeconds} s until a poke may change it`); continue; }
    if (step * 10_000n < 200n * s.raise) { say(`row ${id}: skipped: ${s.quote} is less than 2% from ${s.raise}`); continue; }
    say(`row ${id}: ${s.raise} -> ${s.quote} (price ${s.price}, ${s.age} s old, ${s.direct ? 'direct' : 'copy'})`);
    await send(setter, 'poke(uint32)', [String(id)], POKE_GAS);
    if (!sending) continue;
    let after;
    try { after = (await rowStatus(Number(id))).raise; } catch (error) { say(`row ${id}: sent; the read-back failed: ${reasonOf(error)}`); continue; }
    if (after !== s.quote) throw new Error(`row ${id}: the raise is ${after} after the poke, not the quoted ${s.quote}`);
    say(`row ${id}: raise now ${after}`);
  }
}

async function status() {
  const lister = await holder();
  say(`lister role: ${lister}${same(lister, setter) ? ' (this setter)' : ` (NOT this setter, ${setter})`}`);
  for (const id of await managedIds()) {
    try {
      const s = await rowStatus(Number(id));
      say(`row ${id} ${s.pair}: raise ${s.raise} (ceiling ${s.ceiling}); ${s.why ? `no quote: ${s.why}` : `quote ${s.quote}, ${s.direct ? 'direct' : 'copy'}, ${s.age} s old of ${s.limit}`}; may change in ${s.waitSeconds} s`);
    } catch (error) { say(`row ${id}: a read failed: ${reasonOf(error)}`); }
  }
}

/** Selectors of the calls the deployment makes, for the file's "what". */
const CALLS = { '0x6cd3d462': 'addDirectFeed(bytes4,address,uint256)', '0xb61d27f6': 'execute(address,uint256,bytes)', '0x2852b71c': 'accept()',
  '0xfc161dd4': 'handBack()' };
const RAISE_SET = '0x' + BigInt(execFileSync('cast', ['keccak', 'RaiseSet(uint32,uint256,uint256,uint256,bool,uint256,uint256)'], { encoding: 'utf8' }).trim()).toString(16).padStart(64, '0');
const RAISE_KEPT = '0x' + BigInt(execFileSync('cast', ['keccak', 'RaiseKept(uint32,uint256,uint256,bool,uint256,bool)'], { encoding: 'utf8' }).trim()).toString(16).padStart(64, '0');

/** record: the deployment file from the driver's state (what forge sent) and chain reads (what is there now). */
async function record() {
  const st = driverState;
  if (o.fork && !o.out) throw new Error('record on a fork writes only to --out, never the repository\'s file');
  if (st.pending) throw new Error(`the driver's step ${st.pending.step} stopped before it completed: finish it first`);
  const steps = { deploy: st.gas?.[DEPLOY_STEP], handBack: st.gas?.[HANDBACK_STEP], handover: st.gas?.[HANDOVER_STEP] };
  for (const [k, v] of Object.entries(steps)) if (!v?.transactions?.length) throw new Error(`--state: the ${k} step sent nothing or is missing`);
  const printed = st.extra[DEPLOY_STEP];
  const src = printed.atlasSource;
  const set = printed.atlasRaiseSetter;
  if (!same(setter, set)) throw new Error(`--setter ${setter} is not the setter of the state's deployOpen step ${set}`);
  // Reads at one block; without --fork from both endpoints, which must agree.
  const endpoints = o.fork ? [url] : [RPC_A, RPC_B];
  const heads = await Promise.all(endpoints.map(async e => BigInt(await cast('block-number', '--rpc-url', e))));
  const at = heads.reduce((m, h) => (h < m ? h : m)) - (o.fork ? 0n : 3n);
  const agreed = async (fn, what) => {
    const got = await Promise.all(endpoints.map(fn));
    if (got.some(g => g !== got[0])) throw new Error(`the two endpoints disagree on ${what}`);
    return got[0];
  };
  const read = (to, sig, ...args) => agreed(e => cast('call', '--rpc-url', e, '--block', at.toString(), to, sig, ...args), `${sig} of ${to}`).then(first);
  // Providers order and extend their JSON differently: only the named fields are compared, and only they are kept.
  const rpcJson = async (method, fields, ...params) => {
    const got = await Promise.all(endpoints.map(async e => {
      const v = JSON.parse(await cast('rpc', '--rpc-url', e, method, ...params));
      return v === null ? null : Object.fromEntries(fields.map(f => [f, typeof v[f] === 'string' ? v[f].toLowerCase() : v[f] ?? null]));
    }));
    if (got.some(g => JSON.stringify(g) !== JSON.stringify(got[0]))) throw new Error(`the two endpoints disagree on ${method} ${params[0]}`);
    return got[0];
  };

  if (!same(await read(src, 'mirror()(address)'), mirror)) throw new Error('the new source names another mirror than the file\'s');
  const writer = await read(mirror, 'writer()(address)');
  const lister = await read(listings, 'lister()(address)');
  const returnTo = await read(set, 'returnTo()(address)');
  const target = await read(set, 'targetUsdX18()(uint256)');
  if (!same(await read(set, 'listings()(address)'), listings)) throw new Error('the setter names another listing registry');
  if (!same(returnTo, deployed.holdingContract)) throw new Error(`the setter hands back to ${returnTo}, not the holding contract`);
  const owner = await read(set, 'owner()(address)');
  const n = Number(await read(set, 'managedCount()(uint256)'));
  const feeds = [];
  for (let i = 0; i < n; i++) {
    const id = await read(set, 'managedIds(uint256)(uint32)', String(i));
    const row = (await agreed(e => cast('call', '--rpc-url', e, '--block', at.toString(), set, 'rows(uint32)(bool,uint8,uint8,address,bytes4,uint256,uint64)', id), `row ${id}`)).split('\n').map(x => x.trim().split(' ')[0]);
    if (!same(row[3], src)) throw new Error(`row ${id} reads another source (${row[3]})`);
    const feedId = row[4].toLowerCase();
    feeds.push({ id: feedId, pair: PAIRS[feedId] ?? feedId, feed: await read(src, 'directFeedOf(bytes4)(address)', feedId),
      maxAgeSeconds: Number(await read(src, 'ageLimitOf(bytes4)(uint256)', feedId)), listingRow: Number(id), startRaise: row[5] });
  }
  // Every transaction the driver recorded, read back: sender, nonce, mined with success, and what it was.
  const txs = async list => {
    const out = [];
    for (const t of list) {
      const tx = await rpcJson('eth_getTransactionByHash', ['from', 'nonce', 'to', 'input'], t.hash);
      const r = await rpcJson('eth_getTransactionReceipt', ['status', 'gasUsed', 'blockNumber', 'contractAddress'], t.hash);
      if (!r || BigInt(r.status) !== 1n) throw new Error(`${t.hash} is not mined with success`);
      if (!same(tx.from, DEPLOYER)) throw new Error(`${t.hash} was not sent by the deployer`);
      const what = tx.to === null ? `create ${same(r.contractAddress, src) ? 'AtlasSource' : same(r.contractAddress, set) ? 'AtlasRaiseSetter' : r.contractAddress}`
        : `call ${CALLS[tx.input.slice(0, 10)] ?? tx.input.slice(0, 10)} on ${same(tx.to, src) ? 'the source' : same(tx.to, set) ? 'the setter' : same(tx.to, deployed.holdingContract) ? 'the holding contract' : tx.to}`;
      out.push({ nonce: BigInt(tx.nonce).toString(), hash: t.hash, what, gasUsed: BigInt(r.gasUsed).toString(), block: BigInt(r.blockNumber).toString() });
    }
    return out;
  };
  const transactions = await txs(steps.deploy.transactions);
  const handBack = await txs(steps.handBack.transactions);
  const handover = await txs(steps.handover.transactions);
  if (!handover.some(t => t.what === 'call accept() on the setter')) throw new Error('the state\'s handover did not accept for this setter');
  const timeOf = async block => new Date(Number(BigInt((await rpcJson('eth_getBlockByNumber', ['timestamp'], `0x${BigInt(block).toString(16)}`, 'false')).timestamp)) * 1000).toISOString();
  // The setter's own events since its creation (logs from the first endpoint; each poke's receipt read from both).
  const from = BigInt(transactions.find(t => t.what === 'create AtlasRaiseSetter')?.block ?? at);
  const events = [];
  for (let b = from; b <= at; b += 5000n) {
    const to = b + 4999n < at ? b + 4999n : at;
    const logs = JSON.parse(await cast('rpc', '--rpc-url', endpoints[0], 'eth_getLogs', JSON.stringify({ address: set, fromBlock: `0x${b.toString(16)}`, toBlock: `0x${to.toString(16)}` })));
    for (const l of logs) {
      const w = words(l.data);
      if (l.topics[0] === RAISE_SET) events.push({ listingRow: Number(BigInt(l.topics[1])), kind: 'set', price: w[0], direct: w[3] === 1n, from: w[4], to: w[5], hash: l.transactionHash, block: BigInt(l.blockNumber) });
      else if (l.topics[0] === RAISE_KEPT) events.push({ listingRow: Number(BigInt(l.topics[1])), kind: 'kept', price: w[0], direct: w[2] === 1n, raise: w[3], tooSoon: w[4] === 1n, hash: l.transactionHash, block: BigInt(l.blockNumber) });
    }
  }
  for (const e of events) {
    const r = await rpcJson('eth_getTransactionReceipt', ['status'], e.hash);
    if (!r || BigInt(r.status) !== 1n) throw new Error(`poke ${e.hash} is not mined with success`);
  }
  const firstSet = feeds.map(f => events.find(e => e.kind === 'set' && e.listingRow === f.listingRow)).filter(Boolean);
  const retired = deployed.retired ?? (same(deployed.setter, set) ? null : {
    why: 'Atlas\'s first BNB/USD feed on chain 97 refused a contract caller and stopped updating on 25 November 2026; the source\'s feed per id is fixed, so a new source and setter read Atlas\'s open feeds (SH-272)',
    source: deployed.source, setters: [deployed.retiredSetter?.address, deployed.setter].filter(Boolean),
    bnbUsdFeed: deployed.feeds.find(f => f.id === '0x00000279')?.feed, firstDeployment: deployed });
  if (!retired) throw new Error('the file already names this setter but has no retired part: nothing to keep from');
  const file = {
    schema: 'square-hole-bnb-testnet-atlas/2', chainId: 97,
    recordedAtCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    readAtBlock: at.toString(), deployer: DEPLOYER, mirror, source: src, setter: set, setterOwner: owner, mirrorWriter: writer,
    mirrorNote: 'the mirror of the first deployment, reused as the new source\'s required mirror; never written again (every managed row reads Atlas directly)',
    targetUsdX18: target, feeds: feeds.map(({ startRaise, ...f }) => ({ ...f, startRaise })),
    listingRegistry: listings, holdingContract: deployed.holdingContract, listerHandedOver: same(lister, set), lister,
    transactions, handBack: { at: await timeOf(handBack.at(-1).block), transactions: handBack },
    handover: { at: await timeOf(handover.at(-1).block), by: 'the deployment driver (AtlasRaiseDeploy.handover), from the deployer', transactions: handover },
    firstPokes: firstSet.length ? { at: await timeOf(firstSet[0].block), rows: firstSet.map(e => ({ listingRow: e.listingRow, from: e.from.toString(), to: e.to.toString(),
      priceUsdX18: e.price.toString(), origin: e.direct ? 'direct' : 'copy', hash: e.hash })) } : null,
    pokes: events.map(e => ({ listingRow: e.listingRow, event: e.kind === 'set' ? 'RaiseSet' : 'RaiseKept', direct: e.direct, ...(e.kind === 'kept' ? { tooSoon: e.tooSoon } : {}), hash: e.hash, block: e.block.toString() })),
    retired,
  };
  const target_ = resolve(o.out ?? FILE);
  writeFileSync(`${target_}.tmp`, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(`${target_}.tmp`, target_);
  say(`recorded ${target_}: source ${src}, setter ${set}, ${feeds.length} rows (${feeds.map(f => `${f.listingRow} ${f.pair} ${f.maxAgeSeconds} s`).join(', ')}), lister ${same(lister, set) ? 'the setter' : lister}, ${firstSet.length} first raises, ${events.length} poke events, read at block ${at}`);
}

try {
  say(`atlas-real ${command} on chain 97: setter ${setter}, mirror ${mirror}${o.fork ? ' (fork, dry)' : o.account ? ' (real sends)' : ' (reads only)'}`);
  await preflight();
  if (command === 'relay') await relay();
  else if (command === 'poke') await poke(rest.length ? rest : await managedIds());
  else if (command === 'record') await record();
  else await status();
} catch (error) {
  say(`atlas-real ${error instanceof Unclear ? 'STOPPED' : 'refused'}: ${error instanceof Unclear ? error.message : reasonOf(error)}`);
  process.exitCode = 1;
}
