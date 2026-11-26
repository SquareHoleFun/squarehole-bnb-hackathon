#!/usr/bin/env node
/**
 * A local Square Hole chain for development and the chain E2E suite (SH-C). NEVER touches a public network.
 *
 *   1. anvil on a port in 8550-8599 (chain 31337, EIP-7825 per-transaction gas cap, anvil's PUBLIC default mnemonic);
 *   2. `forge build` (the full build: the local PoolManager artifact and a complete out/), then the contracts' own
 *      scripts, exactly as packages/contracts/scripts/local-e2e.sh runs them: script/Deploy.s.sol --broadcast --slow →
 *      script/WriteManifest.s.sol (read-only finalizer, writes deployments/31337.json) → script/VerifyManifest.s.sol.
 *      The plan is the F10 local plan (script/config/31337.json): THE_MISFITS (T = FIT, 10,000 NFTs, quote WETH, R = Q)
 *      and ORCHARD (T = ORCH, 1,000 NFTs, quote FIT, R = T), ORCHARD always on here (SH_LAUNCH_ORCHARD=true, as
 *      local-e2e.sh sets it);
 *   3. script/LocalE2E.s.sol --broadcast --slow: the contracts' external-trading test harness (ExternalSwapHarness,
 *      the V4Router actions the Universal Router runs) with external-style buys, sells, fee processing, burns, R = Q
 *      claims on The Misfits (paid in WETH) and R = T conversions on ORCHARD (paid in ORCH);
 *   4. two more external buys through that same harness by dave: WETH → FIT on The Misfits, then FIT → ORCH on ORCHARD
 *      (paid with the FIT dave holds), so the holders have fresh claimable rewards to claim in the app: R = Q on The
 *      Misfits (paid in WETH) and R = T on ORCHARD (paid in ORCH); the step fails unless alice and bob, who hold FIT
 *      and ORCH after step 3, have a claimable entitlement on both;
 *   5. switches anvil to one block per second (interval mining), so app transactions reach the local finality policy
 *      (2 confirmations) on their own;
 *   6. copies the finalized manifest to `<outDir>/manifest-31337.json` and writes `<outDir>/local-chain.json`
 *      (RPC URL, accounts, pairs) for the app build and the tests.
 *
 * The app never builds a swap: the buys here are test setup outside the app (GOAL item 4; ADR-0011 §11). Keys are
 * anvil's public default test keys, used only on this local chain. `deployments/31337.json`, `broadcast/` and
 * `cache/` in packages/contracts are gitignored; only one local deployment per checkout runs at a time.
 *
 * Usage (standalone): node packages/chain/scripts/local-chain.mjs --port 8560 --out .local/dev-chain
 * The process keeps anvil running until it is interrupted.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeAbiParameters, encodeFunctionData, encodePacked, parseAbi } from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../../..');
export const CONTRACTS_DIR = join(REPO_ROOT, 'packages/contracts');
/** anvil's PUBLIC default mnemonic (every Foundry user has these accounts; local chain only). */
export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
export const ACCOUNT_NAMES = Object.freeze(['deployer', 'alice', 'bob', 'carol', 'dave', 'creator', 'keeper', 'harness operator']);

const FOUNDRY_BIN = join(homedir(), '.foundry/bin');
const PATH = `${FOUNDRY_BIN}:${process.env.PATH ?? ''}`;

function toolEnv(extra = {}) {
  const env = { ...process.env, PATH, ...extra };
  if (!('DEPLOYER_PRIVATE_KEY' in extra)) delete env.DEPLOYER_PRIVATE_KEY;
  return env;
}

function run(command, args, { cwd = CONTRACTS_DIR, env = {}, log } = {}) {
  const result = spawnSync(command, args, { cwd, env: toolEnv(env), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const shown = args.filter((arg) => !/^0x[0-9a-fA-F]{64}$/.test(arg)).join(' ');
  log?.(`$ ${command} ${shown}`);
  if (result.status !== 0) throw new Error(`${command} ${shown} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function rpc(url, method, params = []) {
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

async function waitForReceipt(url, hash) {
  for (let i = 0; i < 300; i += 1) {
    const receipt = await rpc(url, 'eth_getTransactionReceipt', [hash]);
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error(`seed transaction ${hash} reverted`);
      return receipt;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`seed transaction ${hash} was not mined`);
}

/** anvil signs eth_sendTransaction for its unlocked default accounts (local chain only). */
async function send(url, tx) {
  const hash = await rpc(url, 'eth_sendTransaction', [{ ...tx, value: `0x${(tx.value ?? 0n).toString(16)}` }]);
  return waitForReceipt(url, hash);
}

const erc20 = parseAbi(['function deposit() payable', 'function approve(address spender, uint256 amount) returns (bool)']);
const harnessAbi = parseAbi(['function execute(bytes unlockData)']);
const ACTION_SWAP_EXACT_IN_SINGLE = 0x06; // v4-periphery Actions
const ACTION_SETTLE_ALL = 0x0c;
const ACTION_TAKE_ALL = 0x0f;
const KEY = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' },
    { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'tickSpacing', type: 'int24' },
    { name: 'hooks', type: 'address' },
  ],
};

/**
 * One external exact-in buy of T with `qIn` of the pair's quote through the contracts' swap harness. `wrapEth`: the
 * quote is WETH and the trader first wraps `qIn` test ETH; otherwise the trader must already hold `qIn` of the quote
 * (ORCHARD: FIT). Either way the harness gets an exact approval of `qIn`, no more.
 */
async function externalBuy(url, harness, trader, launch, hook, qIn, { wrapEth }) {
  if (wrapEth) await send(url, { from: trader, to: launch.quote, data: encodeFunctionData({ abi: erc20, functionName: 'deposit' }), value: qIn });
  await send(url, { from: trader, to: launch.quote, data: encodeFunctionData({ abi: erc20, functionName: 'approve', args: [harness, qIn] }) });
  const token = launch.contracts.token.address;
  const tIsCurrency0 = token.toLowerCase() < launch.quote.toLowerCase();
  const poolKey = {
    currency0: tIsCurrency0 ? token : launch.quote,
    currency1: tIsCurrency0 ? launch.quote : token,
    fee: launch.lpFeePips,
    tickSpacing: launch.tickSpacing,
    hooks: hook,
  };
  const single = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'poolKey', ...KEY },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'amountIn', type: 'uint128' },
          { name: 'amountOutMinimum', type: 'uint128' },
          { name: 'minHopPriceX36', type: 'uint256' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    [{ poolKey, zeroForOne: !tIsCurrency0, amountIn: qIn, amountOutMinimum: 1n, minHopPriceX36: 0n, hookData: '0x' }],
  );
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [launch.quote, qIn]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [token, 1n]);
  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL]);
  const unlockData = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [single, settle, take]]);
  await send(url, { from: trader, to: harness, data: encodeFunctionData({ abi: harnessAbi, functionName: 'execute', args: [unlockData] }) });
}

/**
 * Step 4 sizes: 0.02 WETH of FIT (under 200 Misfits NFTs at the seeded price, far below the ~1,300 NFTs one EIP-7825
 * transaction can deliver) and 20,000 FIT of ORCH (the size of LocalE2E.s.sol's first ORCHARD buy).
 */
const MISFITS_BUY_WETH = 20_000_000_000_000_000n;
const ORCHARD_BUY_FIT = 20_000n * 10n ** 18n;

const views = parseAbi(['function balanceOf(address) view returns (uint256)', 'function claimable(address) view returns (uint256)']);

async function readUint(url, to, functionName, args) {
  return BigInt(await rpc(url, 'eth_call', [{ to, data: encodeFunctionData({ abi: views, functionName, args }) }, 'latest']));
}

/**
 * The F10 local plan's two launches from the finalized manifest, checked before anything is bought: The Misfits
 * (T = FIT, quote WETH, R = Q) and ORCHARD (T = ORCH, quote FIT = The Misfits' token, R = T).
 */
function f10Launches(manifest) {
  const misfits = manifest.launches?.THE_MISFITS;
  const orchard = manifest.launches?.ORCHARD;
  if (!misfits || !orchard) throw new Error(`the local plan must launch THE_MISFITS and ORCHARD; the manifest has ${Object.keys(manifest.launches ?? {}).join(', ') || 'no launches'}`);
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  const checks = [
    [misfits.symbol === 'FIT' && misfits.rewardSide === 'Q', 'THE_MISFITS is T = FIT with R = Q'],
    [same(misfits.quote, manifest.contracts?.WETH?.address), 'THE_MISFITS is quoted in WETH'],
    [orchard.symbol === 'ORCH' && orchard.rewardSide === 'T', 'ORCHARD is T = ORCH with R = T'],
    [same(orchard.quote, misfits.contracts?.token?.address), 'ORCHARD is quoted in FIT (The Misfits token)'],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, what]) => what);
  if (failed.length > 0) throw new Error(`the manifest does not follow the F10 local plan: ${failed.join('; ')}`);
  return { misfits, orchard };
}

/**
 * Starts anvil on `port`, deploys and seeds (see the header), writes `outDir`. Returns the chain description and a
 * `stop()` that ends anvil. Refuses a port outside 8550-8599 or one that already answers.
 */
export async function startLocalChain({ port, outDir, log = (line) => console.warn(line) }) {
  if (!Number.isInteger(port) || port < 8550 || port > 8599) throw new Error('the local chain port must be within 8550-8599 (this repository’s anvil range)');
  const rpcUrl = `http://127.0.0.1:${port}`;
  if (await answers(rpcUrl)) throw new Error(`something already answers on ${rpcUrl}; stop it or choose another port in 8550-8599`);
  const out = resolve(outDir);
  mkdirSync(out, { recursive: true });

  log(`anvil on ${rpcUrl} (chain 31337, anvil's public default accounts)`);
  const anvil = spawn(join(FOUNDRY_BIN, 'anvil'), ['--port', String(port), '--chain-id', '31337', '--mnemonic', ANVIL_MNEMONIC, '--enable-tx-gas-limit', '--silent'], {
    stdio: 'ignore',
    env: toolEnv(),
  });
  const stop = () =>
    new Promise((done) => {
      if (anvil.exitCode !== null || anvil.signalCode !== null) return done();
      anvil.once('exit', () => done());
      anvil.kill('SIGTERM');
    });
  try {
    for (let i = 0; i < 100 && !(await answers(rpcUrl)); i += 1) await new Promise((done) => setTimeout(done, 100));
    if ((await rpc(rpcUrl, 'eth_chainId')) !== '0x7a69') throw new Error('anvil did not start on chain 31337');

    const accounts = await rpc(rpcUrl, 'eth_accounts');
    const commit = run('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).trim();
    // Provenance only: a `git status` that fails (e.g. nested submodules in a worktree) records "dirty", never
    // "clean", and does not abort the local chain.
    let dirty = 'true';
    try {
      dirty = run('git', ['status', '--porcelain'], { cwd: REPO_ROOT }).trim() === '' ? 'false' : 'true';
    } catch (error) {
      log(`git status --porcelain failed (${String(error?.message ?? error).split('\n')[0]}); recording gitDirty=true`);
    }
    const provenance = { SH_GIT_COMMIT: commit, SH_GIT_DIRTY: dirty };
    const deployerKey = run('cast', ['wallet', 'private-key', ANVIL_MNEMONIC, '0']).trim();
    rmSync(join(CONTRACTS_DIR, 'deployments/31337.json'), { force: true });
    rmSync(join(CONTRACTS_DIR, 'deployments/pending/31337.json'), { force: true });

    // A full build first (a no-op when up to date): Deploy.s.sol deploys the local PoolManager with
    // deployCode("PoolManager.sol:PoolManager"), an artifact that only the full build writes (the scripts' own sparse
    // compile does not), and a partial out/ would also fail the ABI drift test (packages/chain abi-drift.test.ts).
    log('1/4 build and deploy: forge build, then script/Deploy.s.sol --broadcast --slow');
    run('forge', ['build'], { log });
    // ORCHARD always on (as local-e2e.sh sets it): step 4 and the chain E2E need both reward sides.
    const deploy = run('forge', ['script', 'script/Deploy.s.sol', '--rpc-url', rpcUrl, '--broadcast', '--slow'], {
      env: { ...provenance, DEPLOYER_PRIVATE_KEY: deployerKey, SH_LAUNCH_ORCHARD: 'true' },
      log,
    });
    if (!deploy.includes('ONCHAIN EXECUTION COMPLETE & SUCCESSFUL')) throw new Error('Deploy.s.sol did not complete');
    log('2/4 finalize and verify: script/WriteManifest.s.sol, script/VerifyManifest.s.sol');
    run('forge', ['script', 'script/WriteManifest.s.sol', '--rpc-url', rpcUrl], { env: provenance, log });
    const manifestPath = join(CONTRACTS_DIR, 'deployments/31337.json');
    if (!existsSync(manifestPath)) throw new Error('WriteManifest.s.sol wrote no manifest');
    const verify = run('forge', ['script', 'script/VerifyManifest.s.sol', '--rpc-url', rpcUrl], { env: provenance, log });
    if (!verify.includes('SQUAREHOLE_VERIFY OK')) throw new Error('VerifyManifest.s.sol failed');

    log('3/4 external-style trades, fees, burns and claims: script/LocalE2E.s.sol --broadcast --slow');
    const trades = run('forge', ['script', 'script/LocalE2E.s.sol', '--rpc-url', rpcUrl, '--broadcast', '--slow'], { log });
    if (!trades.includes('ONCHAIN EXECUTION COMPLETE & SUCCESSFUL')) throw new Error('LocalE2E.s.sol did not complete');
    const harness = /E2E harness \(external swap router, local only\) (0x[0-9a-fA-F]{40})/.exec(trades)?.[1];
    if (!harness) throw new Error('LocalE2E.s.sol printed no harness address');

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const { misfits, orchard } = f10Launches(manifest);
    const hook = manifest.contracts.hook.address;
    const [alice, bob, dave] = [accounts[1], accounts[2], accounts[4]];
    log('4/4 fresh rewards for the holders: dave buys FIT with WETH (The Misfits), then ORCH with FIT (ORCHARD), through the same harness');
    await externalBuy(rpcUrl, harness, dave, misfits, hook, MISFITS_BUY_WETH, { wrapEth: true });
    const daveFit = await readUint(rpcUrl, misfits.contracts.token.address, 'balanceOf', [dave]);
    if (daveFit < ORCHARD_BUY_FIT) throw new Error(`dave holds ${daveFit} raw FIT, less than the ${ORCHARD_BUY_FIT} the ORCHARD buy pays`);
    await externalBuy(rpcUrl, harness, dave, orchard, hook, ORCHARD_BUY_FIT, { wrapEth: false });
    // The app's claim tests start from these entitlements: R = Q on The Misfits, R = T on ORCHARD, for alice and bob.
    for (const [name, holder] of [['alice', alice], ['bob', bob]]) {
      for (const launch of [misfits, orchard]) {
        const owed = await readUint(rpcUrl, launch.contracts.rewardLedger.address, 'claimable', [holder]);
        if (owed === 0n) throw new Error(`${name} has nothing claimable on ${launch.name} after dave's buys`);
      }
    }

    // From here on anvil builds a block every second, like a live chain: a transaction the app sends is included in the
    // next block and reaches the local finality policy (2 confirmations) without anyone mining by hand.
    await rpc(rpcUrl, 'evm_setIntervalMining', [1]);

    const outManifest = join(out, 'manifest-31337.json');
    copyFileSync(manifestPath, outManifest);
    const description = {
      chainId: 31337,
      rpcUrl,
      port,
      manifest: outManifest,
      harness,
      accounts: Object.fromEntries(ACCOUNT_NAMES.map((name, index) => [name, accounts[index]])),
      // F10 local plan: THE_MISFITS (T = FIT, quote WETH, R = Q) and ORCHARD (T = ORCH, quote FIT, R = T).
      pairs: Object.fromEntries(
        Object.entries({ THE_MISFITS: misfits, ORCHARD: orchard }).map(([key, launch]) => [
          key,
          { appPairId: launch.appPairId, token: launch.contracts.token.address, quote: launch.quote, rewardSide: launch.rewardSide, symbol: launch.symbol },
        ]),
      ),
      head: Number.parseInt(await rpc(rpcUrl, 'eth_blockNumber'), 16),
    };
    writeFileSync(join(out, 'local-chain.json'), `${JSON.stringify(description, null, 2)}\n`);
    log(`local chain ready: ${rpcUrl}, head block ${description.head}, manifest ${outManifest}`);
    return { ...description, stop };
  } catch (error) {
    await stop();
    throw error;
  }
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
  const chain = await startLocalChain({ port: Number(argument('port', '8560')), outDir: argument('out', join(REPO_ROOT, '.local/dev-chain')) });
  const shutdown = () => void chain.stop().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.warn('anvil keeps running; press Ctrl+C to stop it.');
}
