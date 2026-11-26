/**
 * Local stack for the integration suite: the same steps as packages/contracts/scripts/local-e2e.sh (which cannot be
 * reused as-is because it stops anvil on exit), on port 8551 by default:
 *   anvil (chain 31337, EIP-7825 cap, anvil's PUBLIC default mnemonic) → script/Deploy.s.sol --broadcast --slow →
 *   script/WriteManifest.s.sol (finalizer) → script/VerifyManifest.s.sol → StateView + V4Quoter from the pinned
 *   v4-periphery (forge create) → script/LocalE2E.s.sol --broadcast --slow (external-style trades, fees, burns, claims).
 * No contract is modified. Keys: anvil's public default test keys only, on the local chain only.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, type Address } from 'viem';

export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../../../..');
export const CONTRACTS_DIR = join(REPO_ROOT, 'packages/contracts');

export interface LocalStack {
  readonly port: number;
  readonly rpcUrl: string;
  readonly manifest: unknown;
  readonly stateView: Address;
  readonly v4Quoter: Address;
  readonly log: readonly string[];
  key(index: number): `0x${string}`;
  address(index: number): Address;
  stop(): Promise<void>;
}

function toolEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const foundry = join(homedir(), '.foundry/bin');
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${foundry}:${process.env.PATH ?? ''}`, ...extra };
  delete env.DEPLOYER_PRIVATE_KEY;
  return { ...env, ...extra };
}

function run(command: string, args: readonly string[], options: { cwd?: string; env?: Record<string, string>; log: string[] }): string {
  const output = execFileSync(command, [...args], {
    cwd: options.cwd ?? CONTRACTS_DIR,
    env: toolEnv(options.env),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  options.log.push(`$ ${command} ${args.filter((arg) => !/^0x[0-9a-fA-F]{64}$/.test(arg)).join(' ')}`);
  return output;
}

async function rpcAnswers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

export async function startLocalStack(): Promise<LocalStack> {
  const port = Number(process.env.SH_CHAIN_IT_PORT ?? 8551);
  if (!Number.isInteger(port) || port < 8550 || port > 8599) throw new Error('SH_CHAIN_IT_PORT must be within 8550-8599 (this repo’s anvil range)');
  const rpcUrl = `http://127.0.0.1:${port}`;
  if (await rpcAnswers(rpcUrl)) throw new Error(`Something already answers on ${rpcUrl}; stop it or set SH_CHAIN_IT_PORT`);
  const log: string[] = [];
  const anvil: ChildProcess = spawn(
    join(homedir(), '.foundry/bin/anvil'),
    ['--port', String(port), '--chain-id', '31337', '--mnemonic', ANVIL_MNEMONIC, '--enable-tx-gas-limit', '--silent'],
    { stdio: 'ignore', env: toolEnv() },
  );
  const stop = async (): Promise<void> => {
    if (anvil.exitCode === null) {
      anvil.kill('SIGTERM');
      await new Promise((done) => anvil.once('exit', done));
    }
  };
  try {
    for (let attempt = 0; attempt < 100 && !(await rpcAnswers(rpcUrl)); attempt += 1) await new Promise((done) => setTimeout(done, 100));
    if (!(await rpcAnswers(rpcUrl))) throw new Error('anvil did not start');
    const keys = new Map<number, `0x${string}`>();
    const key = (index: number): `0x${string}` => {
      let value = keys.get(index);
      if (!value) {
        value = run('cast', ['wallet', 'private-key', ANVIL_MNEMONIC, String(index)], { log: [] }).trim() as `0x${string}`;
        keys.set(index, value);
      }
      return value;
    };
    const address = (index: number): Address => getAddress(run('cast', ['wallet', 'address', key(index)], { log: [] }).trim());

    const gitCommit = run('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, log }).trim();
    // Provenance only: a `git status` that fails (e.g. nested submodules in a worktree) records "dirty", never
    // "clean", and does not abort the local chain.
    let gitDirty: 'true' | 'false' = 'true';
    try {
      gitDirty = run('git', ['status', '--porcelain'], { cwd: REPO_ROOT, log }).trim() === '' ? 'false' : 'true';
    } catch (error) {
      log.push(`git status --porcelain failed (${error instanceof Error ? (error.message.split('\n')[0] ?? '') : 'unknown'}); recording gitDirty=true`);
    }
    const provenance = { SH_GIT_COMMIT: gitCommit, SH_GIT_DIRTY: gitDirty };
    rmSync(join(CONTRACTS_DIR, 'deployments/31337.json'), { force: true });
    rmSync(join(CONTRACTS_DIR, 'deployments/pending/31337.json'), { force: true });

    const deploy = run('forge', ['script', 'script/Deploy.s.sol', '--rpc-url', rpcUrl, '--broadcast', '--slow'], {
      env: { ...provenance, DEPLOYER_PRIVATE_KEY: key(0) },
      log,
    });
    if (!deploy.includes('ONCHAIN EXECUTION COMPLETE & SUCCESSFUL')) throw new Error('Deploy.s.sol did not complete');
    run('forge', ['script', 'script/WriteManifest.s.sol', '--rpc-url', rpcUrl], { env: provenance, log });
    const manifestPath = join(CONTRACTS_DIR, 'deployments/31337.json');
    if (!existsSync(manifestPath)) throw new Error('WriteManifest.s.sol wrote no manifest');
    const verify = run('forge', ['script', 'script/VerifyManifest.s.sol', '--rpc-url', rpcUrl], { env: provenance, log });
    if (!verify.includes('SQUAREHOLE_VERIFY OK')) throw new Error('VerifyManifest.s.sol failed');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { contracts: { poolManager: { address: string } } };

    // Lens contracts from the pinned v4-periphery, deployed by anvil account 9 (not a Square Hole role).
    const lens = (target: string): Address => {
      const out = run(
        'forge',
        ['create', target, '--rpc-url', rpcUrl, '--private-key', key(9), '--broadcast', '--constructor-args', manifest.contracts.poolManager.address],
        { log },
      );
      const match = /Deployed to: (0x[0-9a-fA-F]{40})/.exec(out);
      if (!match?.[1]) throw new Error(`forge create ${target} printed no address`);
      return getAddress(match[1]);
    };
    const stateView = lens('lib/v4-periphery/src/lens/StateView.sol:StateView');
    const v4Quoter = lens('lib/v4-periphery/src/lens/V4Quoter.sol:V4Quoter');

    const trades = run('forge', ['script', 'script/LocalE2E.s.sol', '--rpc-url', rpcUrl, '--broadcast', '--slow'], { log });
    if (!trades.includes('ONCHAIN EXECUTION COMPLETE & SUCCESSFUL')) throw new Error('LocalE2E.s.sol did not complete');
    return { port, rpcUrl, manifest, stateView, v4Quoter, log, key, address, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** `cast send` from anvil account `index` (local chain only). Returns the transaction hash. */
export function castSend(stack: LocalStack, index: number, to: string, signature: string, args: readonly string[]): `0x${string}` {
  const out = run('cast', ['send', '--json', '--rpc-url', stack.rpcUrl, '--private-key', stack.key(index), to, signature, ...args], { log: [] });
  const receipt = JSON.parse(out) as { status: string; transactionHash: `0x${string}` };
  if (receipt.status !== '0x1' && receipt.status !== '1') throw new Error(`cast send ${signature} reverted`);
  return receipt.transactionHash;
}

/** `cast call` (eth_call), optionally from an address. */
export function castCall(stack: LocalStack, to: string, signature: string, args: readonly string[], from?: string): string {
  return run('cast', ['call', '--rpc-url', stack.rpcUrl, ...(from ? ['--from', from] : []), to, signature, ...args], { log: [] }).trim();
}
