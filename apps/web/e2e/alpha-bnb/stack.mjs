#!/usr/bin/env node
/**
 * SH-275: the stack of the BNB Chain testnet alpha suite (apps/web/playwright.alpha-bnb.config.ts), LOCAL ONLY:
 * 1. a local chain 97: SH-260's plain rehearsal (hackathon/rehearsals/plain-97: the release, a box priced in the native
 *    coin and one in tNVDA, both graduated and traded; tETH and its open faucet), replayed block by block onto a fresh
 *    anvil by hackathon/scripts/replay-97.mjs, as hackathon/scripts/local-97-runs.sh does; then mined every second at
 *    the chain's own gas price (0.1 gwei). Its coin record is the committed one, byte for byte the same addresses.
 *    (A fork of the public chain was tried first: anvil's fork answers the indexer's eth_getLogs over the release's
 *    history with an internal error, so the index never came up.)
 * 2. the indexer (packages/indexer, as the hackathon stack runs it: `SH_TESTNET=bnb`, the rehearsal's manifest, its
 *    history in memory) over that chain, its gateway on loopback: the BNB site's box data comes from its index;
 * 3. the site for BNB Chain testnet (`SH_TESTNET=bnb`) with the trade code and Privy's stand-in
 *    (`SH_SEPOLIA_TRADE=1 SH_ALPHA_STANDIN=1`; no production build takes the stand-in) on Vite's dev server, which
 *    serves the join page from apps/web/join/index.html as well. Not a development `vite build`: under `SH_TESTNET=bnb`
 *    that build stops on box 0's modules the Demo keeps (build/bnb-variants.ts checks every BNB build; only the
 *    production build folds the Demo away), and the stand-in is refused by every production build.
 * Nothing is sent to a real network (one read: Multicall3's code from the public endpoint, as local-97-runs.sh reads
 * it); the suite routes the profile's two read endpoints to this anvil, and the stand-in's made wallet sends only to it.
 * Every process started here is stopped by its own handle on exit.
 * Ports: the site E2E_ALPHA_BNB_PORT (5392), anvil SH_ALPHA_BNB_ANVIL_PORT (8622), the indexer's gateway the next one (8623).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = resolve(WEB, '../..');
const OUT = resolve(ROOT, '.cache/alpha-bnb');
const DATA = resolve(ROOT, 'hackathon/rehearsals/plain-97');
const MANIFEST = resolve(DATA, 'core-v1/97.json');
const port = Number(process.env.E2E_ALPHA_BNB_PORT ?? 5392);
const anvilPort = Number(process.env.SH_ALPHA_BNB_ANVIL_PORT ?? 8622);
const rpcUrl = `http://127.0.0.1:${anvilPort}`;
const gatewayPort = anvilPort + 1;
const indexOrigin = `http://127.0.0.1:${gatewayPort}`;
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const children = [];
function stop() {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
}
process.on('SIGTERM', () => { stop(); process.exit(0); });
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('exit', stop);

async function rpc(url, method, params = []) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

mkdirSync(OUT, { recursive: true });
const dumpPath = resolve(OUT, 'anvil-state.json');
writeFileSync(dumpPath, gunzipSync(readFileSync(resolve(DATA, 'anvil-state.json.gz'))));
const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
const genesis = BigInt(dump.blocks.find((block) => block.header.number === '0x0').header.timestamp);
const anvil = spawn('anvil', ['--chain-id', '97', '--hardfork', 'osaka', '--base-fee', '0', '--gas-limit', '100000000', '--timestamp', genesis.toString(),
  '--port', String(anvilPort), '--host', '127.0.0.1', '--no-mining', '--silent'], { stdio: 'inherit' });
children.push(anvil);
let ready = false;
for (let i = 0; i < 150 && !ready; i += 1) {
  try { ready = (await rpc(rpcUrl, 'eth_chainId')) === '0x61'; } catch { await new Promise((r) => setTimeout(r, 200)); }
}
if (!ready) throw new Error('the local chain 97 did not start');
// The real chain 97 has Multicall3 at its canonical address and the indexer batches its views through it (read only).
const code = await rpc('https://bsc-testnet-rpc.publicnode.com', 'eth_getCode', [MULTICALL3, 'latest']);
if (typeof code !== 'string' || code.length < 1000) throw new Error('no Multicall3 code read');
await rpc(rpcUrl, 'anvil_setCode', [MULTICALL3, code]);
const replay = spawnSync('node', [resolve(ROOT, 'hackathon/scripts/replay-97.mjs'), dumpPath, rpcUrl], { cwd: ROOT, encoding: 'utf8' });
if (replay.status !== 0) throw new Error(`the replay failed: ${replay.stderr}`);
process.stdout.write(`replayed: ${replay.stdout.trim()}\n`);
// The replay keeps the recorded block times; the next block takes the wall clock's time, as the real chain's head has
// it (a box page whose head is older than a minute says "Stale" and offers no action).
await rpc(rpcUrl, 'evm_setNextBlockTimestamp', [Math.floor(Date.now() / 1000)]);
// From here the chain moves: a block every second, each transaction mined at once, at BNB Chain testnet's price.
await rpc(rpcUrl, 'anvil_setMinGasPrice', ['0x5f5e100']).catch(() => undefined);
await rpc(rpcUrl, 'evm_setAutomine', [true]);
await rpc(rpcUrl, 'evm_setIntervalMining', [1]);
const block = BigInt(await rpc(rpcUrl, 'eth_blockNumber'));
writeFileSync(resolve(OUT, 'stack.json'), JSON.stringify({ rpcUrl, indexOrigin, block: block.toString(), boxes: JSON.parse(readFileSync(resolve(DATA, 'result.json'), 'utf8')).boxes, origin: `http://127.0.0.1:${port}` }, null, 2));
process.stdout.write(`local chain 97 at block ${block}\n`);

const indexer = spawn('node', ['--experimental-transform-types', '--no-warnings=ExperimentalWarning', '--import', './scripts/register-ts.mjs', 'src/core/core-main.ts'], {
  cwd: resolve(ROOT, 'packages/indexer'),
  env: { ...process.env, SH_TESTNET: 'bnb', SH_CORE_MANIFEST: MANIFEST, SH_CORE_HTTP_URLS: rpcUrl, SH_CORE_WS_URLS: '', SH_CORE_POLL_MS: '1000', SH_CORE_BLOCK_MS: '450',
    SH_CORE_GATEWAY_HOST: '127.0.0.1', SH_CORE_GATEWAY_PORT: String(gatewayPort), SH_HISTORY: 'memory', SH_CORE_CREATE_OPTIONS_DIR: resolve(DATA, 'create-options/data') },
  stdio: ['ignore', 'ignore', 'inherit'],
});
children.push(indexer);
let up = false;
for (let i = 0; i < 300 && !up; i += 1) {
  try { up = (await fetch(`${indexOrigin}/healthz`)).ok; } catch { /* not yet */ }
  if (!up) await new Promise((r) => setTimeout(r, 1000));
}
if (!up) throw new Error('the indexer did not come up');
process.stdout.write(`indexer up at ${indexOrigin}\n`);

const env = { ...process.env, SH_TESTNET: 'bnb', SH_SEPOLIA_TRADE: '1', SH_ALPHA_STANDIN: '1', SH_BUILD: '', SH_TARGET: '', SH_DEV_SERVER_WATCH: 'off', DEV_PORT: String(port),
  SH_CORE_SEPOLIA_MANIFEST: MANIFEST, SH_CORE_SEPOLIA_INDEXER_ORIGIN: indexOrigin, SH_SEPOLIA_INDEXER_ORIGIN: indexOrigin };
const site = spawn('pnpm', ['exec', 'vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: WEB, env, stdio: 'inherit' });
children.push(site);
await new Promise((resolveExit) => site.on('exit', resolveExit));
