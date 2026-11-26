/**
 * TEST SUPPORT for the anvil integration test (never bundled, never imported by the app):
 * - starts a throwaway anvil (chain 31337, EIP-7825 cap on) on a port in 8550–8599 (default 8552) and stops it;
 * - deploys Square Hole with the CONTRACTS' OWN deploy script (`script/Deploy.s.sol --broadcast --slow`) and its
 *   read-only finalizer (`script/WriteManifest.s.sol`), exactly as `scripts/local-e2e.sh` does, using anvil's PUBLIC
 *   default mnemonic; the resulting `deployments/31337.json` (gitignored) is what the writers load;
 * - a test-only EIP-1193 wallet backed by one of anvil's unlocked default accounts;
 * - EXTERNAL trades through the contracts lane's external test harness (`script/harness/ExternalSwapHarness.sol`, the
 *   Universal Router's V4_SWAP action engine, deployed from its forge artifact) so holders have entitlements to claim.
 *   This is the documented external-trading test harness of GOAL item 4 and ADR-0011 §11, driven by the test itself:
 *   the app has no trade form, and nothing here is exported to it.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address, TxHash } from '@squarehole/domain';
import { encodeAbiParameters, encodeDeployData, encodeFunctionData, encodePacked, parseAbi, type Abi, type Hex } from 'viem';
import type { Eip1193Request } from '../eip1193';
import { createHttpRequest } from '../rpc';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
export const CONTRACTS = join(ROOT, 'packages/contracts');
export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'; // anvil's public default

/** anvil's unlocked default accounts (public, derived from the mnemonic above), in index order. */
export async function anvilAccounts(chain: AnvilChain): Promise<Address[]> {
  const accounts = (await chain.request({ method: 'eth_accounts' })) as Address[];
  if (!Array.isArray(accounts) || accounts.length < 8) throw new Error('anvil did not report its default accounts');
  return accounts;
}

const PATH = `${join(homedir(), '.foundry/bin')}:${process.env.PATH ?? ''}`;

function run(cmd: string, args: string[], env: Record<string, string> = {}, cwd = CONTRACTS): string {
  const result = spawnSync(cmd, args, { cwd, env: { ...process.env, PATH, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${cmd} ${args.slice(0, 2).join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

export interface AnvilChain {
  readonly port: number;
  readonly rpcUrl: string;
  readonly request: Eip1193Request;
  readonly process: ChildProcess;
  stop(): Promise<void>;
}

export async function startAnvil(port: number): Promise<AnvilChain> {
  if (port < 8550 || port > 8599) throw new RangeError('anvil ports for this project are 8550–8599');
  const rpcUrl = `http://127.0.0.1:${port}`;
  const request = createHttpRequest(rpcUrl, { timeoutMs: 30_000 });
  const busy = await request({ method: 'eth_chainId' }).then(() => true, () => false);
  if (busy) throw new Error(`something already answers on ${rpcUrl}; stop it or set SH_WRITE_ANVIL_PORT (8550–8599)`);
  const child = spawn('anvil', ['--port', String(port), '--chain-id', '31337', '--mnemonic', ANVIL_MNEMONIC, '--enable-tx-gas-limit'], {
    env: { ...process.env, PATH },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i += 1) {
    if (await request({ method: 'eth_chainId' }).then(() => true, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    port,
    rpcUrl,
    request,
    process: child,
    stop: () =>
      new Promise((done) => {
        if (child.exitCode !== null) return done();
        child.once('exit', () => done());
        child.kill();
      }),
  };
}

/** Deploys with the contracts' deploy script and finalizer; returns the parsed deployment manifest JSON. */
export function deployWithContractsScript(rpcUrl: string): { manifest: unknown; log: string } {
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() !== '' ? 'true' : 'false';
  const deployerKey = run('cast', ['wallet', 'private-key', ANVIL_MNEMONIC, '0']).trim();
  const provenance = { SH_GIT_COMMIT: commit, SH_GIT_DIRTY: dirty };
  const deploy = run('forge', ['script', 'script/Deploy.s.sol', '--rpc-url', rpcUrl, '--broadcast', '--slow'], { ...provenance, DEPLOYER_PRIVATE_KEY: deployerKey });
  if (!deploy.includes('ONCHAIN EXECUTION COMPLETE & SUCCESSFUL')) throw new Error(`deploy did not complete:\n${deploy}`);
  const finalize = run('forge', ['script', 'script/WriteManifest.s.sol', '--rpc-url', rpcUrl], provenance);
  const manifest: unknown = JSON.parse(readFileSync(join(CONTRACTS, 'deployments/31337.json'), 'utf8'));
  const lines = `${deploy}\n${finalize}`.split('\n').filter((line) => /SQUAREHOLE_|ONCHAIN EXECUTION/.test(line));
  return { manifest, log: lines.join('\n') };
}

/**
 * Test-only EIP-1193 wallet: anvil's unlocked default `account` signs (anvil signs `eth_sendTransaction` for its
 * default accounts), everything else is forwarded to anvil. Records every method for assertions.
 */
export function anvilWallet(chain: AnvilChain, account: Address): { request: Eip1193Request; methods: string[] } {
  const methods: string[] = [];
  const request: Eip1193Request = async (args) => {
    methods.push(args.method);
    switch (args.method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [account];
      case 'wallet_switchEthereumChain':
        return null;
      default:
        return chain.request(args);
    }
  };
  return { request, methods };
}

/** Sends a plain transaction from an unlocked anvil account and waits for its receipt (test setup only). */
export async function sendAndWait(chain: AnvilChain, tx: { from: Address; to?: Address; data: Hex; value?: bigint }): Promise<TxHash> {
  const hash = (await chain.request({
    method: 'eth_sendTransaction',
    params: [{ from: tx.from, ...(tx.to ? { to: tx.to } : {}), data: tx.data, value: `0x${(tx.value ?? 0n).toString(16)}` }],
  })) as TxHash;
  for (let i = 0; i < 200; i += 1) {
    const receipt = (await chain.request({ method: 'eth_getTransactionReceipt', params: [hash] })) as { status: string; contractAddress?: string } | null;
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error(`setup transaction ${hash} reverted`);
      return hash;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`setup transaction ${hash} was not mined`);
}

async function contractAddressOf(chain: AnvilChain, hash: TxHash): Promise<Address> {
  const receipt = (await chain.request({ method: 'eth_getTransactionReceipt', params: [hash] })) as { contractAddress: Address };
  return receipt.contractAddress;
}

const erc20 = parseAbi(['function deposit() payable', 'function approve(address spender, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const harnessAbi = parseAbi(['function execute(bytes unlockData)']);
const ACTION_SWAP_IN_SINGLE = 0x06; // v4-periphery Actions.SWAP_EXACT_IN_SINGLE
const ACTION_SETTLE_ALL = 0x0c;
const ACTION_TAKE_ALL = 0x0f;

export interface PoolForTrades {
  readonly token: Address;
  readonly quote: Address;
  readonly hook: Address;
  readonly tickSpacing: number;
}

/** The external swap harness (local only), deployed from its forge artifact by a test operator account. */
export async function deployExternalHarness(chain: AnvilChain, poolManager: Address, operator: Address): Promise<Address> {
  const artifact = JSON.parse(readFileSync(join(CONTRACTS, 'out/ExternalSwapHarness.sol/ExternalSwapHarness.json'), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [poolManager] });
  const hash = await sendAndWait(chain, { from: operator, data });
  return contractAddressOf(chain, hash);
}

/** An external exact-in buy of T with `qIn` WETH through the harness (wrap, exact approval, one V4_SWAP). */
export async function externalBuy(chain: AnvilChain, harness: Address, trader: Address, pool: PoolForTrades, qIn: bigint): Promise<void> {
  await sendAndWait(chain, { from: trader, to: pool.quote, data: encodeFunctionData({ abi: erc20, functionName: 'deposit' }), value: qIn });
  await sendAndWait(chain, { from: trader, to: pool.quote, data: encodeFunctionData({ abi: erc20, functionName: 'approve', args: [harness, qIn] }) });
  const tIsCurrency0 = pool.token.toLowerCase() < pool.quote.toLowerCase();
  const poolKey = {
    currency0: tIsCurrency0 ? pool.token : pool.quote,
    currency1: tIsCurrency0 ? pool.quote : pool.token,
    fee: 30_000,
    tickSpacing: pool.tickSpacing,
    hooks: pool.hook,
  };
  const keyType = { type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] } as const;
  const singleParams = encodeAbiParameters(
    [{ type: 'tuple', components: [{ name: 'poolKey', ...keyType }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'minHopPriceX36', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }],
    [{ poolKey, zeroForOne: !tIsCurrency0, amountIn: qIn, amountOutMinimum: 1n, minHopPriceX36: 0n, hookData: '0x' }],
  );
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [pool.quote, qIn]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [pool.token, 1n]);
  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [ACTION_SWAP_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL]);
  const unlockData = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [singleParams, settle, take]]);
  await sendAndWait(chain, { from: trader, to: harness, data: encodeFunctionData({ abi: harnessAbi, functionName: 'execute', args: [unlockData] }) });
}

export async function balanceOf(chain: AnvilChain, token: Address, account: Address): Promise<bigint> {
  const data = encodeFunctionData({ abi: erc20, functionName: 'balanceOf', args: [account] });
  return BigInt((await chain.request({ method: 'eth_call', params: [{ to: token, data }, 'latest'] })) as string);
}
