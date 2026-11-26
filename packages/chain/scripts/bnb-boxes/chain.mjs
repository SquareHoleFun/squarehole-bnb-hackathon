/**
 * SH-261: the chain the demo boxes' scripts work on, local or real, with one interface (`read`, `send`, `simulate`,
 * `events`, `balance`, `mineTo`, `act`, `remember`).
 *
 * Every transaction is prepared here (to, data, value, a fixed gas limit, its own nonce) and handed to a sender:
 *   - `nodeSender`: a local node's unlocked or impersonated account (`eth_sendTransaction` with the nonce);
 *   - `castSender`: `cast mktx` signs it with `--account <keystore name>` (or `--keystore <file>`) and
 *     `--password-file <path>`, both handed through unread (no key is ever in this process, a file or a command line),
 *     and `cast publish` broadcasts the signed bytes.
 * A send is durable BEFORE it is broadcast (`durableSend`): the exact call (sender, to, data, value, gas) and its nonce,
 * and for a signed one its bytes and hash, are written to the state file first. One transaction at a time: saved,
 * broadcast, its receipt awaited and its status checked; only then the next.
 *
 * A run is a list of named actions (`act`). A finished action's result is kept in the state file; a read an action
 * makes before it sends is kept too (`remember`); a transaction is kept by its action and its place in it. A run
 * started again reconciles a kept transaction before anything else: replayed only when its call is the same; mined
 * with it: go on; its nonce unused: the same signed bytes again (never a new nonce); its nonce used by something else,
 * or a lookup that failed: the run stops with a plain message.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { TransactionNotFoundError, TransactionReceiptNotFoundError, createPublicClient, encodeFunctionData, erc20Abi, http, keccak256, parseEventLogs, toHex } from 'viem';
import { ALLOWED_RPCS } from '../../../contracts/script/bnb/bnb-testnet.mjs';

export const CHAIN_ID = 97;
/**
 * The fixed gas limits of the scripts' own transactions (the site's create steps keep the executor's estimates):
 * an ERC-20 approve 120,000; everything else 15,000,000 (the local stack's LOCAL_TX_GAS, below EIP-7825's cap). A swap
 * needs it: the hook's holder notice (HOLDER_NOTICE_GAS 1,400,000 plus its 1,200,000 reserve) and the token's
 * checkpoint call are skipped when less gas is left, so an estimated limit silently pays the holders nothing.
 * collect, graduate, sellFees, settleBatch and claim take the same limit (they run the same fail-safe calls).
 */
export const GAS = Object.freeze({ approve: 120_000n, other: 15_000_000n });
export const gasOf = functionName => (functionName === 'approve' ? GAS.approve : GAS.other);
const delay = ms => new Promise(done => setTimeout(done, ms));
/**
 * A test hook of the proof only (proof.mjs): `SH_BNB_STOP_AT=before-publish:N` ends the process right after the Nth
 * transaction's call and nonce were saved and before it is broadcast; `after-publish:N` right after the Nth broadcast,
 * before its receipt is awaited. Unset: never.
 */
const STOP_AT = /^(before|after)-publish:([1-9][0-9]*)$/.exec(process.env.SH_BNB_STOP_AT ?? '');
let publishes = 0;
function stopHook(when, log) {
  if (STOP_AT && STOP_AT[1] === when && publishes === Number(STOP_AT[2])) { log(`stopping hard ${when} publish ${publishes} (SH_BNB_STOP_AT)`); process.exit(137); }
}

// ---- Reads that survive a rate limit, and local nodes that never fail over.

/** The public endpoints reads may use, in order (the first is the one sends go to): `setReadEndpoints`, from `--rpc a,b`. */
const READS = { urls: [], log: () => undefined };
export function setReadEndpoints(urls, log = () => undefined) { READS.urls = [...urls]; READS.log = log; }
const RATE_LIMIT = /rate.?limit|too many requests|limit exceeded|request limit/i;
/** The waits between rounds of tries: six more rounds over about a minute. */
export const RATE_WAITS_MS = Object.freeze([1_000, 2_000, 4_000, 8_000, 15_000, 30_000]);
export const isLoopback = url => /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(String(url));

/** The local nodes this process started (local-chain.mjs): a request to one whose process is gone is refused. */
const LOCAL_NODES = new Map();
export function registerLocalNode(url, child) { LOCAL_NODES.set(new URL(url).origin, child); }

/**
 * `fetch` for JSON-RPC. A LOOPBACK node that is not an endpoint of the `--rpc` list (a local chain, a dry run's fork)
 * is asked directly and only: no failover, no retry, never a public endpoint, and refused once its process (started
 * here) has exited: every send, impersonation, clock move and read of a fork stays on the fork. An endpoint of the
 * `--rpc` list whose answer is a rate limit (HTTP 429, or a JSON-RPC error naming one) or a failed connection is tried
 * at the list's other endpoints only, then, round after round, after a growing wait (`RATE_WAITS_MS`); after the last
 * round it stops plainly. Every other answer is returned as it came.
 */
export async function resilientFetch(input, init = {}) {
  const asked = String(typeof input === 'string' || input instanceof URL ? input : input.url);
  // One spelling per endpoint (a client may add a trailing slash).
  const norm = url => String(url).replace(/\/+$/, '');
  const listed = READS.urls.some(url => norm(url) === norm(asked));
  if (isLoopback(asked) && !listed) {
    const child = LOCAL_NODES.get(new URL(asked).origin);
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`the local node at ${asked} is gone: nothing more is asked of it`);
    return fetch(asked, { ...init, signal: init.signal ?? AbortSignal.timeout(120_000) });
  }
  // An endpoint of the --rpc list fails over only within that list (the local proof's list is loopback only).
  const order = [asked, ...(listed ? READS.urls.filter(url => norm(url) !== norm(asked)) : [])];
  let last = '';
  for (let round = 0; round <= RATE_WAITS_MS.length; round += 1) {
    for (const url of order) {
      try {
        const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(120_000) });
        const text = await response.text();
        let limited = response.status === 429;
        if (!limited) {
          try {
            const body = JSON.parse(text);
            limited = [body].flat().some(item => item && item.error && RATE_LIMIT.test(String(item.error.message ?? '')));
          } catch { limited = RATE_LIMIT.test(text) && response.status >= 400; }
        }
        if (!limited) return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
        last = `${url}: rate limited (${response.status} ${text.slice(0, 120)})`;
      } catch (error) {
        if (init.signal?.aborted) throw error;
        last = `${url}: ${error.message}`;
      }
    }
    if (round < RATE_WAITS_MS.length) {
      READS.log(`reads refused (${last}); trying again in ${RATE_WAITS_MS[round] / 1000} s`);
      await delay(RATE_WAITS_MS[round]);
    }
  }
  throw new Error(`the endpoints refused reads for about a minute: ${last}`);
}

/** A viem transport over `resilientFetch` (no viem retries of its own). */
export const readTransport = (url, options = {}) => http(url, { retryCount: 0, timeout: 120_000, ...options, fetchFn: resilientFetch });

export async function rpc(url, method, params = []) {
  const response = await resilientFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json();
  if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { data: body.error.data });
  return body.result;
}

/**
 * The endpoint of a cast run: one of the runbook's public chain-97 RPCs (lane c's `ALLOWED_RPCS`, imported), or a
 * loopback node only with `localProof` (the proof of this mode on a local chain). Either must answer chain id 97.
 */
export async function castEndpoint(url, { localProof = false } = {}) {
  if (!ALLOWED_RPCS.includes(url) && !(localProof && isLoopback(url))) {
    throw new Error(`a real run uses only these endpoints: ${ALLOWED_RPCS.join(', ')}${localProof ? ' (or a loopback node for the local proof)' : ''}`);
  }
  if (BigInt(await rpc(url, 'eth_chainId')) !== BigInt(CHAIN_ID)) throw new Error('not chain 97');
  return url;
}

// ---- The state file: JSON with bigints kept exactly.

const encode = value => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v), 2);
const decode = text => JSON.parse(text, (_k, v) => (v && typeof v === 'object' && typeof v.$bigint === 'string' && Object.keys(v).length === 1 ? BigInt(v.$bigint) : v));

/** A run's memory: in memory only, or in a file written after every change (write, then rename). */
export function stateStore(path = null) {
  const data = path && existsSync(path) ? decode(readFileSync(path, 'utf8')) : { tx: {}, memo: {}, done: {} };
  const save = () => {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, encode(data));
    renameSync(`${path}.tmp`, path);
  };
  return { data, save, path, plain: value => decode(encode(value)) };
}

// ---- Prices, nonces, lookups.

/**
 * The price of a send on chain 97: a LEGACY transaction at max(`eth_gasPrice` read from `priceUrl`, the fee the
 * caller offers). Why legacy: chain 97's base fee is 0, so a type-2 transaction pays only its tip, and the site's fee
 * logic capped that tip at 0.01 gwei there (packages/chain/src/write/executor.ts:66-81, `tipCapOf` and `sendFeesOf`:
 * twice a zero base fee, floored at MIN_PRIORITY_FEE_WEI = 10,000,000 wei, :44; lane a's 4a16a461 fixes it), ten times
 * below what validators take. Never below the network's price: the assert stops the send otherwise. The network's
 * price is read for every send, and again at its publication (`belowPriceNow`).
 */
const networkPrice = async priceUrl => BigInt(await rpc(priceUrl, 'eth_gasPrice'));

/**
 * At publication: signed (or saved) bytes priced below the chain's price NOW are not broadcast; the entry stays as it is
 * (its nonce kept) and the run stops.
 */
async function belowPriceNow(priceUrl, prepared, from) {
  if (prepared.price === null || prepared.price === undefined) return;
  const now = await networkPrice(priceUrl);
  if (BigInt(prepared.price) < now) throw new Error(`nonce ${prepared.nonce} of ${from} is priced ${prepared.price}, below the chain's price now (${now}): not broadcast; the saved transaction is kept; stop`);
}
export async function sendPrice(priceUrl, fees = null) {
  const network = await networkPrice(priceUrl);
  const offered = fees?.maxFeePerGas ?? 0n;
  const price = offered > network ? offered : network;
  assert.ok(price >= network && price > 0n, `a send priced ${price} is below the network's price ${network}`);
  return { price, network };
}

/** An address's transaction count, the highest any of `urls` answers (one lagging node cannot pull it back). */
export async function nonceCount(urls, address, tag = 'latest') {
  let best = null;
  for (const url of urls) {
    const count = await rpc(url, 'eth_getTransactionCount', [address, tag]).then(BigInt, () => null);
    if (count !== null && (best === null || count > best)) best = count;
  }
  if (best === null) throw new Error(`no endpoint answered the transaction count of ${address}; nothing was sent`);
  return best;
}

/**
 * Before a new send from `address`: no transaction of that account may be waiting that is not this run's (the route's
 * trigger is also the live keeper's wallet). Its pending count above both its mined count and the next nonce after this
 * run's own sends (`ownNext`: an endpoint whose mined count lags must not make the run's own mined send look foreign)
 * means one is.
 */
async function noForeignPending(url, address, ownNext = 0n) {
  const [pending, mined] = await Promise.all([rpc(url, 'eth_getTransactionCount', [address, 'pending']).then(BigInt), rpc(url, 'eth_getTransactionCount', [address, 'latest']).then(BigInt)]);
  const latest = mined > ownNext ? mined : ownNext;
  if (pending > latest) throw new Error(`${address} has ${pending - latest} pending transaction(s) that are not this run's (is the keeper service sending?): nothing was sent; run again when none is pending`);
}

/** A receipt and a transaction by hash: null only for a confirmed "not found"; a failed lookup throws. */
export async function lookup(client, hash) {
  const receipt = await client.getTransactionReceipt({ hash }).catch(error => { if (error instanceof TransactionReceiptNotFoundError) return null; throw error; });
  if (receipt) return { receipt, tx: null };
  const tx = await client.getTransaction({ hash }).catch(error => { if (error instanceof TransactionNotFoundError) return null; throw error; });
  return { receipt: null, tx };
}

// ---- Senders: prepare (nonce, price, a signed transaction where there is a keystore), then publish.

/**
 * A local node's own accounts (unlocked, or impersonated on that node). With `priceUrl` (the dry run's fork) every send
 * is priced exactly as a real send (`sendPrice` against the REAL endpoint) and refused below that endpoint's price, so
 * the dry run shows an underpriced transaction; without it (a plain local chain) the node prices it. The nonce is
 * explicit here too. Every request goes to the node only (resilientFetch: loopback, no failover).
 */
export function nodeSender(url, { priceUrl = null } = {}) {
  return {
    kind: 'node',
    nonceUrls: [url],
    prepare: async ({ from, fees }) => {
      await noForeignPending(url, from);
      const nonce = await nonceCount([url], from);
      const priced = priceUrl ? await sendPrice(priceUrl, fees) : { price: null, network: null };
      return { nonce, ...priced, fees };
    },
    publish: async (prepared, { from, to, data, value, gas }) => {
      if (priceUrl) await belowPriceNow(priceUrl, prepared, from);
      const tx = { from, to, data, value: toHex(value), gas: toHex(gas), nonce: toHex(prepared.nonce) };
      if (prepared.price !== null) return rpc(url, 'eth_sendTransaction', [{ ...tx, gasPrice: toHex(prepared.price) }]);
      const fees = prepared.fees;
      return rpc(url, 'eth_sendTransaction', [{ ...tx, ...(fees ? { maxFeePerGas: toHex(fees.maxFeePerGas), maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas) } : {}) }]);
    },
  };
}

/** cast and anvil get only what they need (lane c's driver keeps the same five, bnb-testnet.mjs `toolEnv`). */
function toolEnv() {
  const keep = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR'];
  return Object.fromEntries(keep.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
}

/** A tool run with a deadline (default two minutes): a hang is an error, never a wait without end. */
function runTool(cmd, args, timeoutMs = 120_000) {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: toolEnv() });
    let out = ''; let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', fail);
    child.on('close', code => { clearTimeout(timer); return code === 0 ? done(out.trim()) : fail(new Error(`${cmd} ${args[0]} failed (${code}): ${err.slice(-1500)}`)); });
  });
}

/**
 * A keystore role: its NAME, and where cast finds it. Its password file is `<passwordDir>/<name>.pass` when a folder
 * is given (each keystore has its own), else `passwordFile`. The path is passed on to cast; only its existence is
 * checked here, its content is never opened. `requirePassword`: a real signer must have one.
 */
export function keystoreRole(name, { keystoreDir = null, passwordFile = null, passwordDir = null, requirePassword = false } = {}) {
  assert.match(name, /^[A-Za-z0-9._-]{1,64}$/, 'a keystore name (letters, digits, . _ -)');
  const where = keystoreDir ? ['--keystore', `${keystoreDir}/${name}`] : ['--account', name];
  const password = passwordDir ? `${passwordDir}/${name}.pass` : passwordFile;
  if (password) assert.ok(existsSync(password), `no password file for keystore ${name}: ${password}`);
  else assert.ok(!requirePassword, `keystore ${name} needs a password file (--password-dir or --password-file)`);
  return { name, password, signer: [...where, ...(password ? ['--password-file', password] : [])] };
}

/** A role's address, as cast reads it from the keystore (cast decrypts it; this process sees only the address). */
export async function roleAddress(role) {
  return (await runTool('cast', ['wallet', 'address', ...role.signer])).split(/\s+/).pop();
}

/** The highest nonce each address used in a state (its life's transactions and the creation's), to go on from. */
export function usedNonces(state) {
  const used = new Map();
  for (const tx of [...Object.values(state.tx ?? {}), ...(state.memo?.['create:walletSent'] ?? [])]) {
    if (tx.nonce === undefined || tx.nonce === null || !tx.from) continue;
    const key = tx.from.toLowerCase();
    if (!used.has(key) || used.get(key) < BigInt(tx.nonce)) used.set(key, BigInt(tx.nonce));
  }
  return used;
}

/**
 * Keystore roles through cast: `prepare` takes the nonce (the higher of the highest mined count any endpoint of the
 * list answers and this address's last used nonce plus one, `used`, from the state on a restart), the price, and signs
 * the legacy transaction with `cast mktx` (its hash is the bytes' keccak); `publish` broadcasts those exact bytes with
 * `cast publish`. "nonce too low" (an endpoint behind), a rate limit or "already known" retries the SAME bytes, at most
 * six times, then the run stops plainly. A step never gets a different nonce.
 */
export function castSender(url, roles, { used = new Map(), log = () => undefined } = {}) {
  const byAddress = new Map(roles.map(role => [role.address.toLowerCase(), role]));
  const nonceUrls = () => [url, ...READS.urls.filter(u => u !== url)];
  const publishRaw = async (raw, hash, nonce, from) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await runTool('cast', ['publish', '--rpc-url', url, raw]);
        return hash;
      } catch (error) {
        if (/already known|known transaction/i.test(error.message)) return hash;
        const tooLow = /nonce too low/i.test(error.message);
        const limited = RATE_LIMIT.test(error.message);
        if ((!tooLow && !limited) || attempt >= 6) {
          if (tooLow) throw new Error(`nonce too low six times for nonce ${nonce} of ${from}: the endpoint stays behind, or the nonce is used; nothing else was sent`, { cause: error });
          throw error;
        }
        log(`${tooLow ? 'the endpoint is behind ("nonce too low")' : 'rate limited'} for nonce ${nonce} of ${from}: the same transaction again in ${attempt * 3} s`);
        await delay(attempt * 3_000);
      }
    }
  };
  return {
    kind: 'cast',
    nonceUrls: nonceUrls(),
    prepare: async ({ from, to, data, value, gas, fees }) => {
      const role = byAddress.get(from.toLowerCase());
      if (!role) throw new Error(`no keystore role sends for ${from}`);
      const own = used.get(from.toLowerCase());
      await noForeignPending(url, from, own === undefined ? 0n : own + 1n);
      const { price, network } = await sendPrice(url, fees);
      const latest = await nonceCount(nonceUrls(), from);
      const previous = used.get(from.toLowerCase());
      const nonce = previous !== undefined && previous + 1n > latest ? previous + 1n : latest;
      const raw = (await runTool('cast', ['mktx', '--legacy', '--gas-price', price.toString(), '--nonce', nonce.toString(), '--rpc-url', url,
        '--chain', String(CHAIN_ID), '--gas-limit', gas.toString(), '--value', value.toString(), ...role.signer, to, data])).split(/\s+/).pop();
      assert.match(raw, /^0x[0-9a-fA-F]+$/, 'cast mktx printed a signed transaction');
      used.set(from.toLowerCase(), nonce);
      return { nonce, price, network, raw, hash: keccak256(raw) };
    },
    publish: async (prepared, { from }) => {
      await belowPriceNow(url, prepared, from);
      return publishRaw(prepared.raw, prepared.hash, prepared.nonce, from);
    },
  };
}

// ---- Durable sends.

const sameCall = (slot, tx) => slot.from?.toLowerCase() === tx.from.toLowerCase() && slot.to?.toLowerCase() === tx.to.toLowerCase()
  && slot.data?.toLowerCase() === tx.data.toLowerCase() && BigInt(slot.value ?? -1) === BigInt(tx.value);

/**
 * Waits for a saved send's receipt and checks its status. No receipt after 45 seconds while its sender's mined count
 * has not passed its nonce: the run stops plainly ("sent but not mined"), nothing else is sent. Its nonce used while the
 * endpoint does not know its hash: another transaction took the nonce: the run stops plainly.
 */
export async function waitMined(client, sender, slot, poll) {
  const started = Date.now();
  for (;;) {
    const { receipt, tx } = await lookup(client, slot.hash);
    if (receipt) {
      assert.equal(receipt.status, 'success', `transaction ${slot.hash} (${slot.label ?? 'a step'}) reverted`);
      return receipt;
    }
    if (Date.now() - started > 45_000) {
      const latest = await nonceCount(sender.nonceUrls, slot.from);
      if (latest <= slot.nonce) {
        const network = slot.network ?? await rpc(sender.nonceUrls[0], 'eth_gasPrice').then(BigInt, () => 'unknown');
        throw Object.assign(new Error(`sent but not mined: ${slot.hash}, price ${slot.price ?? tx?.gasPrice ?? 'unknown'}, the network's price ${network}`), { code: 'not-mined' });
      }
      if (!tx) throw Object.assign(new Error(`nonce ${slot.nonce} of ${slot.from} is used, and the endpoint does not know ${slot.hash}: another transaction took it; check by hand`), { code: 'replaced' });
      if (Date.now() - started > 600_000) throw new Error(`no receipt for ${slot.hash} in ten minutes although its nonce is used`);
    }
    await delay(poll);
  }
}

/**
 * One transaction, durable before it is broadcast: `slot` (an object in the state) gets the exact call and its nonce
 * (and a signed transaction's bytes and hash) and is saved; then it is broadcast; then its hash is saved; then its
 * receipt is awaited and checked. A slot that already holds a call is RECONCILED instead (`reconcile`).
 */
export async function durableSend({ store, slot, tx, client, sender, log = () => undefined, poll = 2_000, label = '' }) {
  // A record in an older format (a hash without its nonce, or without its calldata): refused, nothing sent.
  if ((slot.hash && (slot.nonce === undefined || slot.nonce === null)) || (slot.nonce !== undefined && slot.nonce !== null && !slot.data)) {
    throw new Error(`${label}: a record in an older format (${slot.hash ?? `nonce ${slot.nonce}`}): this life is complete; nothing was sent`);
  }
  if (slot.nonce !== undefined && slot.nonce !== null) return reconcile({ store, slot, tx, client, sender, log, poll, label });
  const prepared = await sender.prepare(tx);
  Object.assign(slot, { from: tx.from, to: tx.to, data: tx.data, value: BigInt(tx.value), gas: BigInt(tx.gas), label, nonce: prepared.nonce,
    price: prepared.price, network: prepared.network, hash: prepared.hash ?? null, raw: prepared.raw ?? null });
  store.save();
  publishes += 1;
  stopHook('before', log);
  const hash = await sender.publish(prepared, tx);
  if (slot.hash) assert.equal(hash.toLowerCase(), slot.hash.toLowerCase(), 'the broadcast hash is the signed one');
  slot.hash = hash;
  store.save();
  log(`sent ${label}: ${hash}${slot.price === null ? '' : ` at ${slot.price} wei/gas (the network's ${slot.network})`}, nonce ${slot.nonce}`);
  stopHook('after', log);
  return waitMined(client, sender, slot, poll);
}

/**
 * A kept send: replayed only when its call (sender, to, calldata, value) is the one asked for now. Mined: its receipt
 * (status checked). Known and waiting: awaited. Unknown to the endpoint and its nonce unused: the same signed bytes are
 * broadcast again (a node send: the same call with the same nonce), never a new nonce. Unknown and its nonce used, or a
 * kept send without its call (an older state file): the run stops plainly.
 */
export async function reconcile({ store, slot, tx, client, sender, log = () => undefined, poll = 2_000, label = '' }) {
  if (!sameCall(slot, tx)) throw new Error(`${label}: the kept transaction is another call than this step's (sender, to, calldata or value differ): stop; check the state file by hand`);
  if (slot.hash) {
    const { receipt, tx: known } = await lookup(client, slot.hash);
    if (receipt) {
      assert.equal(receipt.status, 'success', `kept transaction ${slot.hash} (${label}) reverted: stop`);
      log(`kept ${label}: ${slot.hash} (mined)`);
      return receipt;
    }
    if (known) { log(`kept ${label}: ${slot.hash} (waiting)`); return waitMined(client, sender, slot, poll); }
  }
  const latest = await nonceCount(sender.nonceUrls, slot.from);
  if (latest > slot.nonce) throw new Error(`${label}: nonce ${slot.nonce} of ${slot.from} is used, and not by ${slot.hash ?? 'a broadcast this run saved'}: stop; check by hand which transaction took it`);
  log(`kept ${label}: nonce ${slot.nonce} unused; the same transaction is broadcast again`);
  const hash = await sender.publish({ nonce: slot.nonce, price: slot.price, network: slot.network, raw: slot.raw, hash: slot.hash, fees: null }, tx);
  if (slot.hash) assert.equal(hash.toLowerCase(), slot.hash.toLowerCase(), 'the rebroadcast is the same signed transaction');
  slot.hash = hash;
  store.save();
  return waitMined(client, sender, slot, poll);
}

// ---- The chain.

/**
 * `clock`: 'warp' moves a local node's time (evm_setNextBlockTimestamp); 'wait' waits for the real chain's blocks.
 * `log`: one line per transaction and per finished action.
 */
export function makeChain({ url, sender, store = stateStore(), clock = 'warp', log = () => undefined }) {
  const client = createPublicClient({ transport: readTransport(url), pollingInterval: clock === 'warp' ? 100 : 1_500 });
  const state = store.data;
  let action = null; let index = 0;
  const gasBy = state.gasBy ?? (state.gasBy = {});
  const gasCounted = state.gasCounted ?? (state.gasCounted = {});
  const count = receipt => {
    if (gasCounted[receipt.transactionHash]) return;
    gasCounted[receipt.transactionHash] = true;
    const from = receipt.from.toLowerCase();
    gasBy[from] = (gasBy[from] ?? 0n) + receipt.gasUsed * receipt.effectiveGasPrice;
    store.save();
  };
  const chain = {
    url, client, store, sender, count,
    now: async () => (await client.getBlock()).timestamp,
    /** The first block at or after `timestamp`: mined now on a local node, waited for on the real chain. */
    mineTo: async timestamp => {
      if (clock === 'warp') {
        const now = await chain.now();
        await rpc(url, 'evm_setNextBlockTimestamp', [toHex(timestamp > now ? timestamp : now + 1n)]);
        await rpc(url, 'evm_mine');
        return;
      }
      for (;;) {
        const now = await chain.now();
        if (now >= timestamp) return;
        log(`waiting for the chain's clock: ${timestamp - now} s`);
        await delay(Number(timestamp - now > 30n ? 30n : timestamp - now) * 1000 + 1500);
      }
    },
    /** A view call, at the latest block or at `blockNumber`. */
    read: (address, abi, functionName, args = [], blockNumber) => client.readContract({ address, abi, functionName, args, ...(blockNumber === undefined ? {} : { blockNumber }) }),
    simulate: async (from, to, abi, functionName, args = [], value = 0n) =>
      (await client.simulateContract({ account: from, address: to, abi, functionName, args, value, gas: gasOf(functionName) })).result,
    events: (receipt, abi, eventName, address) => parseEventLogs({ abi, logs: receipt.logs, eventName })
      .filter(log => !address || log.address.toLowerCase() === address.toLowerCase()).map(log => log.args),
    balance: (coin, owner) => client.readContract({ address: coin, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
    /** A named action: its kept result when it finished before, else run and kept. */
    act: async (key, fn) => {
      if (Object.hasOwn(state.done, key)) return state.done[key];
      const outer = [action, index];
      action = key; index = 0;
      try {
        const result = store.plain((await fn()) ?? null);
        state.done[key] = result;
        store.save();
        log(`done ${key}`);
        return result;
      } finally { [action, index] = outer; }
    },
    /** A read the current action keeps (so a run started again compares with the value it saw before sending). */
    remember: async (name, fn) => {
      const key = `${action}:${name}`;
      if (!Object.hasOwn(state.memo, key)) { state.memo[key] = store.plain(await fn()); store.save(); }
      return state.memo[key];
    },
    /** One transaction of the current action, durable before it is broadcast (`durableSend`), its receipt checked. */
    sendRaw: async ({ from, to, data, value = 0n, gas, label, fees = null }) => {
      assert.ok(action, 'every transaction belongs to an action');
      const key = `${action}#${index}`;
      index += 1;
      const slot = state.tx[key] ?? (state.tx[key] = {});
      const receipt = await durableSend({ store, slot, tx: { from, to, data, value, gas, fees }, client, sender, log, poll: clock === 'warp' ? 100 : 2_000, label: `${key} ${label}` });
      slot.gasUsed = receipt.gasUsed;
      count(receipt);
      return receipt;
    },
    send: (from, to, abi, functionName, args = [], value = 0n, gas = gasOf(functionName)) =>
      chain.sendRaw({ from, to, data: encodeFunctionData({ abi, functionName, args }), value, gas, label: functionName }),
    /** What each sending address paid in gas over this state file, from every successful receipt (wei). */
    gasPaid: () => ({ ...gasBy }),
  };
  return chain;
}
