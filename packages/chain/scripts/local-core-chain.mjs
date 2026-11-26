#!/usr/bin/env node
/**
 * Core v1 on a local chain (S10a, docs/design/s10a-core-v1-site.md § 7.2; the `local-chain.mjs` pattern). NEVER touches a
 * public network.
 *
 *   1. anvil on a port in 8550-8599 with Sepolia's chain id 11155111 (a "local twin": factory v1 accepts only a drand
 *      source pinned for its chain, and pins exist for 1 and 11155111), EIP-7825's per-transaction gas cap, base fee 0,
 *      Osaka (the BLS precompiles the drand source checks rounds with), and a genesis time one day before the committed
 *      quicknet rounds (test/vectors/drand-quicknet-box.json), so graduation and a draw can land on real rounds. Refuses
 *      a port where anything already answers.
 *   2. script/local/DeployCoreV1Local.s.sol --broadcast --unlocked --sender <anvil account 0>: anvil signs with its own
 *      unlocked account; no key on any command line. Every forge run here passes --no-storage-caching: the twin has
 *      Sepolia's chain id, and Foundry would otherwise cache its state as Sepolia's at those block numbers. The PoolManager from the pinned source, a local WETH, the pinned
 *      DrandSource, factory v1, box 0 from the fixture spec opening at a clock time a few minutes after the deploy
 *      (`openIn` seconds; openAt, open-at-clock-time.md), a test swap router.
 *   3. `<out>/core-manifest-11155111.json` from chain reads (write-core-manifest.mjs, network "local").
 *   4. Optionally box 0's life, stage by stage (`runLife`): the launch window, the curve, the close at P1, graduation on
 *      a real round, the graduation word, a draw settled on a later real round, trades and batches after it, the
 *      deepen cooldown and price average, a placeholder opened and its stream share claimed (CoreV1LocalLife.s.sol;
 *      simple calls go straight to anvil's unlocked accounts). `<out>/local-core-chain.json` records the RPC, the
 *      accounts and the block of every stage.
 *
 * Usage: node packages/chain/scripts/local-core-chain.mjs --port 8562 --out .local/core-chain [--until stream|none]
 * The process keeps anvil running until it is interrupted.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi } from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../../..');
export const CONTRACTS_DIR = join(REPO_ROOT, 'packages/contracts');
const CHAIN_DIR = resolve(HERE, '..');
const FOUNDRY_BIN = join(homedir(), '.foundry/bin');
const PATH = `${FOUNDRY_BIN}:${process.env.PATH ?? ''}`;
export const TWIN_CHAIN_ID = 11_155_111;
export const ACCOUNT_NAMES = Object.freeze(['deployer', 'alice', 'bob', 'carol', 'keeper']);
/** Ports another workflow's anvils use on this machine (never started here). */
const RESERVED = new Set([8547, 8548, 8549, 8553, 8554, 8555, 8556, 8557, 8558, 8560, 8561]);

/** The life's stages in order (see the header); `upcoming` is box 0 right after its creation. */
export const LIFE_STAGES = Object.freeze(['upcoming', 'window', 'bonding', 'closed', 'graduated', 'word', 'draw', 'busy', 'deepen', 'stream']);

function toolEnv(extra = {}) {
  const env = { ...process.env, PATH, ...extra };
  delete env.DEPLOYER_PRIVATE_KEY;
  delete env.ETH_PRIVATE_KEY;
  return env;
}

function run(command, args, { cwd = CONTRACTS_DIR, env = {}, log } = {}) {
  log?.(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, env: toolEnv(env), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

export async function rpc(url, method, params = []) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function answers(url) {
  try {
    await rpc(url, 'eth_chainId');
    return true;
  } catch {
    return false;
  }
}

const hex = (n) => `0x${BigInt(n).toString(16)}`;
export const head = async (url) => BigInt(await rpc(url, 'eth_blockNumber'));
const latestTime = async (url) => BigInt((await rpc(url, 'eth_getBlockByNumber', ['latest', false])).timestamp);

/** The committed quicknet rounds: the first "local" round and the time of any committed round. */
export function drandVectors() {
  const json = JSON.parse(readFileSync(join(CONTRACTS_DIR, 'test/vectors/drand-quicknet-box.json'), 'utf8'));
  const first = json.rounds.find((_, i) => json.why[i] === 'local');
  if (first === undefined) throw new Error('drand vectors: no local rounds');
  const index = (round) => {
    const i = json.rounds.indexOf(Number(round));
    if (i < 0) throw new Error(`drand vectors: round ${round} is not committed`);
    return i;
  };
  return { first, timeOf: (round) => BigInt(json.roundTimes[index(round)]), signatureOf: (round) => json.signaturesXY[index(round)], period: BigInt(json.period) };
}

/** A plain transaction from one of anvil's unlocked accounts (local test tooling), waited for and checked. */
async function send(url, from, to, data) {
  // A fixed gas limit under EIP-7825's cap: graduate() pokes fail-safe callees with fixed gas and the observers check
  // what they are left, so an estimate is not enough (the base fee is 0 here, the limit costs nothing).
  const hash = await rpc(url, 'eth_sendTransaction', [{ from, to, data, gas: hex(15_000_000n) }]);
  for (let i = 0; i < 300; i += 1) {
    const receipt = await rpc(url, 'eth_getTransactionReceipt', [hash]);
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error(`transaction ${hash} to ${to} reverted`);
      return receipt;
    }
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`transaction ${hash} was not mined`);
}

/**
 * The single calls this script sends itself, at exact times (forge simulates at the latest block's time, too early for a
 * round that is not due yet): signatures of IBoxCoordinator, IDrandSource, IBoxTickets, IBoxPriceAverage and IBoxHook
 * (test tooling, as local-chain.mjs builds its harness calls).
 */
const LIFE_ABI = parseAbi([
  'function graduate() returns (uint256)',
  'function postRound(uint256 round, bytes signature) returns (bytes32)',
  'function acceptGraduationWord()',
  'function draw(uint256 maxTokenIn, uint256 deadline) payable returns (uint256)',
  'function settle(uint256 maxCount) returns (uint256)',
  'function requestOf(address consumer, uint256 key) view returns (uint64 requestedAt, uint64 round)',
  'function poke() returns (int24)',
  'function deepen(address tipTo) returns (uint8, uint8, uint256, uint256, uint256)',
  'function priceAverage() view returns (address)',
  'function latestSampleTick() view returns (int24)',
  'function twap() view returns (bool ready, int24 tick, uint32 window)',
  'function poolId() view returns (bytes32)',
  'function poolManager() view returns (address)',
  'function extsload(bytes32 slot) view returns (bytes32)',
  'function pairedLiquidity() view returns (uint128)',
  'function openAt() view returns (uint256)',
  'function windowEndsAt() view returns (uint256)',
  'function deployBlock() view returns (uint256)',
]);
const call = (functionName, args = []) => encodeFunctionData({ abi: LIFE_ABI, functionName, args });

async function view(url, to, functionName, args = []) {
  const data = await rpc(url, 'eth_call', [{ to, data: call(functionName, args) }, 'latest']);
  return decodeFunctionResult({ abi: LIFE_ABI, functionName, data });
}

/** Mines `count` blocks 12 seconds apart (Ethereum's slots), so the clock moves with the blocks. */
async function mineSlots(url, count) {
  if (count > 0n) await rpc(url, 'anvil_mine', [hex(count), hex(12n)]);
}

/** Mines 12-second blocks until the head's time is at or after `time` (box 0's open and window end are clock times). */
async function mineToTime(url, time) {
  const now = await latestTime(url);
  if (time > now) await mineSlots(url, (time - now + 11n) / 12n);
}

/** Sends one call in a block of its own at exactly `timestamp` (when given). */
async function sendAt(url, from, to, data, timestamp) {
  if (timestamp !== undefined) await rpc(url, 'evm_setNextBlockTimestamp', [hex(timestamp)]);
  return send(url, from, to, data);
}

/**
 * Starts anvil on `port`, deploys core v1 and box 0, writes the manifest. Returns the chain and its controls; `stop()`
 * ends anvil. Refuses a port outside 8550-8599 and 5460-5469, a reserved one, or one that already answers.
 */
export async function startLocalCoreChain({ port, outDir, openIn = 240, log = (line) => console.warn(line) }) {
  // 8550-8599: this repository's anvil range; 5460-5469: the band attended parallel lanes on this machine keep for their
  // temporary servers (SH-BOX0-ACTIONS), so a lane's chain never collides with another lane's.
  if (!Number.isInteger(port) || !((port >= 8550 && port <= 8599) || (port >= 5460 && port <= 5469))) throw new Error('the local core chain port must be within 8550-8599 (this repository’s anvil range) or 5460-5469 (the attended lanes’ band)');
  if (RESERVED.has(port)) throw new Error(`port ${port} is reserved for another local chain; choose another in 8550-8599`);
  const rpcUrl = `http://127.0.0.1:${port}`;
  if (await answers(rpcUrl)) throw new Error(`something already answers on ${rpcUrl}; stop it or choose another port`);
  const out = resolve(outDir);
  mkdirSync(out, { recursive: true });
  const drand = drandVectors();
  const genesis = drand.timeOf(drand.first) - 86_400n;

  log(`anvil on ${rpcUrl} (chain ${TWIN_CHAIN_ID}, a local twin; genesis time ${genesis})`);
  const anvil = spawn(
    join(FOUNDRY_BIN, 'anvil'),
    ['--port', String(port), '--chain-id', String(TWIN_CHAIN_ID), '--enable-tx-gas-limit', '--base-fee', '0', '--hardfork', 'osaka', '--timestamp', String(genesis), '--silent'],
    { stdio: 'ignore', env: toolEnv() },
  );
  const stop = () =>
    new Promise((done) => {
      if (anvil.exitCode !== null || anvil.signalCode !== null) return done();
      anvil.once('exit', () => done());
      anvil.kill('SIGTERM');
    });
  try {
    for (let i = 0; i < 100 && !(await answers(rpcUrl)); i += 1) await new Promise((done) => setTimeout(done, 100));
    if (BigInt(await rpc(rpcUrl, 'eth_chainId')) !== BigInt(TWIN_CHAIN_ID)) throw new Error(`anvil did not start on chain ${TWIN_CHAIN_ID}`);
    if (!String(await rpc(rpcUrl, 'web3_clientVersion')).startsWith('anvil/')) throw new Error('the node is not anvil');
    // A box cannot be created in block 0 (BoxHook.initialize records its creation block): move past it first.
    await rpc(rpcUrl, 'anvil_mine', ['0x10']);
    const accounts = await rpc(rpcUrl, 'eth_accounts');
    const named = Object.fromEntries(ACCOUNT_NAMES.map((name, i) => [name, accounts[i]]));

    log('1/2 core v1 and box 0: forge build, then script/local/DeployCoreV1Local.s.sol --broadcast --unlocked');
    run('forge', ['build'], { log });
    const deployed = run(
      'forge',
      ['script', 'script/local/DeployCoreV1Local.s.sol:DeployCoreV1Local', '--rpc-url', rpcUrl, '--broadcast', '--unlocked', '--sender', named.deployer, '--slow', '--no-storage-caching'],
      // Box 0 opens `openIn` seconds after the deploy script's block time (0: Now, the block after the creation).
      { env: { SH_CORE_LOCAL_OPEN_DELAY: String(openIn) }, log },
    );
    if (!deployed.includes('ONCHAIN EXECUTION COMPLETE & SUCCESSFUL')) throw new Error('DeployCoreV1Local.s.sol did not complete');
    const printed = Object.fromEntries([...deployed.matchAll(/LOCAL\|(\w+)\|(\S+)/g)].map((m) => [m[1], m[2]]));
    // Addresses follow nonces, so the simulation's are the chain's; blocks do not (forge simulates every transaction in
    // one block, `--slow` mines each in its own): the creation block and the open time are read from the chain below.
    for (const key of ['factory', 'registry', 'swapper', 'coordinator', 'token', 'hook', 'tickets', 'randomness', 'drand']) {
      if (!printed[key]) throw new Error(`DeployCoreV1Local.s.sol printed no ${key}`);
    }

    log('2/2 the core manifest from chain reads (write-core-manifest.mjs, network local)');
    const manifestPath = join(out, `core-manifest-${TWIN_CHAIN_ID}.json`);
    run(
      process.execPath,
      ['--experimental-transform-types', '--no-warnings=ExperimentalWarning', '--import', './scripts/register-ts.mjs', 'scripts/write-core-manifest.mjs', '--rpc', rpcUrl, '--factory', printed.factory, '--network', 'local', '--out', manifestPath],
      { cwd: CHAIN_DIR, log },
    );
    if (!existsSync(manifestPath)) throw new Error('write-core-manifest.mjs wrote no manifest');

    const chain = {
      chainId: TWIN_CHAIN_ID,
      rpcUrl,
      port,
      manifest: manifestPath,
      factory: printed.factory,
      registry: printed.registry,
      swapper: printed.swapper,
      coordinator: printed.coordinator,
      token: printed.token,
      hook: printed.hook,
      tickets: printed.tickets,
      randomness: printed.randomness,
      // F143: box 0's source (`randomness`) is the BoxBackedSource; rounds are posted on the DrandSource it names.
      drand: printed.drand,
      creationBlock: BigInt(await view(rpcUrl, printed.hook, 'deployBlock')),
      openAt: BigInt(await view(rpcUrl, printed.hook, 'openAt')),
      windowEndsAt: BigInt(await view(rpcUrl, printed.hook, 'windowEndsAt')),
      accounts: named,
      stages: { upcoming: Number(await head(rpcUrl)) },
    };
    writeDescription(out, chain);
    log(`local core chain ready: ${rpcUrl}, box 0 created in block ${chain.creationBlock}, opens at ${chain.openAt} (Unix seconds)`);
    return { ...chain, out, stop, life: (options = {}) => runLife({ ...chain, out }, { log, ...options }) };
  } catch (error) {
    await stop();
    throw error;
  }
}

function writeDescription(out, chain) {
  const json = JSON.stringify({ ...chain, creationBlock: String(chain.creationBlock), openAt: String(chain.openAt), windowEndsAt: String(chain.windowEndsAt) }, null, 2);
  writeFileSync(join(out, 'local-core-chain.json'), `${json}\n`);
}

/**
 * One forge stage of the life. The gas estimate gets a wide margin: the vault's and the collection's observer calls
 * check the gas they are left (ObserverGasTooLow), which forge's 130% estimate does not always leave.
 */
function lifeStage(chain, stage, extra = {}, log) {
  const output = run(
    'forge',
    ['script', 'script/local/CoreV1LocalLife.s.sol:CoreV1LocalLife', '--rpc-url', chain.rpcUrl, '--broadcast', '--unlocked', '--sender', chain.accounts.deployer, '--slow', '--no-storage-caching', '--gas-estimate-multiplier', '300'],
    { env: { SH_LIFE_STAGE: stage, SH_LIFE_REGISTRY: chain.registry, SH_LIFE_SWAPPER: chain.swapper, ...extra }, log },
  );
  if (!output.includes('ONCHAIN EXECUTION COMPLETE & SUCCESSFUL')) throw new Error(`life stage ${stage} did not complete`);
  return output;
}

/**
 * Box 0's life, stage by stage, up to and including `until` (one of LIFE_STAGES). `onStage(name, block)` runs after
 * each, so a test can look at the chain, the indexer and the site in every state.
 */
export async function runLife(chain, { until = 'stream', onStage = async () => undefined, log = (line) => console.warn(line) } = {}) {
  const last = LIFE_STAGES.indexOf(until);
  if (last < 0) throw new Error(`unknown stage ${until}; one of ${LIFE_STAGES.join(', ')}`);
  const url = chain.rpcUrl;
  const drand = drandVectors();
  const r0 = drand.first;
  const done = async (name) => {
    chain.stages[name] = Number(await head(url));
    writeDescription(chain.out, chain);
    log(`life: ${name} at block ${chain.stages[name]}`);
    await onStage(name, chain.stages[name]);
  };
  const steps = {
    upcoming: async () => undefined,
    window: async () => {
      // Into the window by the clock, two 12-second steps after the open (the router taxes by step).
      await mineToTime(url, chain.openAt + 24n);
      lifeStage(chain, 'window', {}, log);
    },
    bonding: async () => {
      await mineToTime(url, chain.windowEndsAt);
      lifeStage(chain, 'bonding', {}, log);
      await rpc(url, 'anvil_mine', ['0xc']);
      lifeStage(chain, 'collect', {}, log);
    },
    closed: async () => {
      lifeStage(chain, 'close', {}, log);
    },
    graduated: async () => {
      // graduate() exactly 12 s before the first committed round: the tickets' graduation poke fixes that round.
      const at = drand.timeOf(r0) - 12n;
      if ((await latestTime(url)) >= at) throw new Error('the life ran past the committed quicknet rounds; restart the chain');
      await sendAt(url, chain.accounts.keeper, chain.coordinator, call('graduate'), at);
      const [, round] = await view(url, chain.randomness, 'requestOf', [chain.tickets, 0n]);
      if (BigInt(round) !== BigInt(r0)) throw new Error(`graduation requested round ${round}, not ${r0}`);
    },
    word: async () => {
      // The round posted at its time by anyone, the add-on accepts the word.
      await sendAt(url, chain.accounts.carol, chain.drand, call('postRound', [BigInt(r0), drand.signatureOf(r0)]), drand.timeOf(r0));
      await send(url, chain.accounts.carol, chain.tickets, call('acceptGraduationWord'));
    },
    draw: async () => {
      // Carol's draw 12 s before round r0 + 6 (its own round), posted at its time, then settled by anyone.
      const drawRound = BigInt(r0) + 6n;
      const deadline = drand.timeOf(drawRound) + 3_600n;
      await sendAt(url, chain.accounts.carol, chain.tickets, call('draw', [2n ** 256n - 1n, deadline]), drand.timeOf(drawRound) - 12n);
      await sendAt(url, chain.accounts.carol, chain.drand, call('postRound', [drawRound, drand.signatureOf(drawRound)]), drand.timeOf(drawRound));
      await send(url, chain.accounts.keeper, chain.tickets, call('settle', [1n]));
    },
    busy: async () => {
      lifeStage(chain, 'trade', {}, log);
      await rpc(url, 'anvil_mine', ['0xc']);
      lifeStage(chain, 'collect', {}, log);
      lifeStage(chain, 'settle', {}, log);
    },
    deepen: async () => {
      // The 300-block cooldown, then box 0's price average (FIT's executor ring) brought to the price: its latest sample
      // moves at most 100 ticks per poke (MAX_OBSERVATION_STEP), and deepen() skips while that sample is more than 99
      // ticks from spot (DeepenSkip.AverageNotCaughtUp) or the 1-hour average is (Deviation). So: poke 5 minutes apart
      // until the sample is within 99 ticks, then a full hour more at the price, then deepen. The trades after
      // graduation moved the price far from P1 (the first sample), which is why the plain hour of pokes was not enough
      // (S10a review: the recorded deepen was skipped with reason 4). A deepen that only converts (its T side below the
      // minimum add, each conversion within 49 ticks) is followed, after the cooldown, by one that pairs.
      // A round trip and a batch first: the busy stage's fees alone leave the budget too small to pair (the
      // conversion that buys the T side would take the Q side below MIN_ADD).
      lifeStage(chain, 'depth', {}, log);
      await rpc(url, 'anvil_mine', [hex(310n), hex(1n)]);
      const average = await view(url, chain.hook, 'priceAverage');
      const poolId = await view(url, chain.hook, 'poolId');
      const manager = await view(url, chain.hook, 'poolManager');
      // StateLibrary: Pool.State at keccak256(poolId, 6); slot0's tick is bits 160-183 (int24).
      const slot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, 6n]));
      const spot = async () => Number(BigInt.asIntN(24, BigInt(await view(url, manager, 'extsload', [slot])) >> 160n));
      const poke = async () => {
        await send(url, chain.accounts.keeper, average, call('poke'));
        await rpc(url, 'evm_increaseTime', [hex(300n)]);
      };
      const withinBand = async () => Math.abs(Number(await view(url, average, 'latestSampleTick')) - (await spot())) <= 99;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        let pokes = 0;
        while (!(await withinBand())) {
          if ((pokes += 1) > 400) throw new Error('the price average did not catch up with the price');
          await poke();
        }
        for (let i = 0; i < 13; i += 1) await poke();
        await send(url, chain.accounts.keeper, average, call('poke'));
        const [ready, avgTick] = await view(url, average, 'twap');
        const at = await spot();
        if (!ready || Math.abs(Number(avgTick) - at) > 99) throw new Error(`the 1-hour average (${avgTick}, ready ${ready}) is not within 99 ticks of the price (${at})`);
        log(`life: deepen with the average at ${avgTick}, its latest sample within 99 ticks of the price ${at} (${pokes} catch-up pokes)`);
        await send(url, chain.accounts.keeper, chain.hook, call('deepen', [chain.accounts.keeper]));
        if (BigInt(await view(url, chain.hook, 'pairedLiquidity')) > 0n) return;
        // Converted only: the next add after the 300-block cooldown pairs.
        await rpc(url, 'anvil_mine', [hex(301n), hex(1n)]);
      }
      throw new Error('deepen() added no paired depth in four tries');
    },
    stream: async () => {
      // Past the 30-day reveal grace (box 0's fixture carries no reveal proofs): Alice's placeholder opens into a Misfit.
      await rpc(url, 'evm_increaseTime', [hex(31n * 86_400n)]);
      await rpc(url, 'anvil_mine', ['0x1']);
      lifeStage(chain, 'stream', {}, log);
    },
  };
  // A stage already run is skipped (a later call continues the life); `upcoming` runs (it only reports) until the life
  // has moved past it.
  const moved = LIFE_STAGES.slice(1).some((name) => chain.stages[name] !== undefined);
  for (const name of LIFE_STAGES.slice(0, last + 1)) {
    if (chain.stages[name] !== undefined && (name !== 'upcoming' || moved)) continue;
    await steps[name]();
    await done(name);
  }
  return chain;
}

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  const chain = await startLocalCoreChain({ port: Number(argument('port', '8562')), outDir: argument('out', join(REPO_ROOT, '.local/core-chain')) });
  const until = argument('until', 'stream');
  if (until !== 'none') await chain.life({ until });
  const shutdown = () => void chain.stop().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.warn('anvil keeps running; press Ctrl+C to stop it.');
}
