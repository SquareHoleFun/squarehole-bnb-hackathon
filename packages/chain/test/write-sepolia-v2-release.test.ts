/**
 * SH-SEP-MANIFEST: the CLI (scripts/write-sepolia-v2-release.mjs) end to end, as the runbook runs it: files in, the chain
 * check through viem against a fake JSON-RPC on 127.0.0.1 (answers from FakeReleaseChain, so the viem adapter's real
 * requests are exercised), the manifest file out. The fork plan's code hashes are replaced by hashes of synthetic code
 * the fake serves, consistently in every place the plan names them. No network beyond loopback.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { decodeFunctionData, encodeFunctionResult, keccak256, parseAbi, toHex, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { parseCoreManifestV2 } from '../src/core/v2/manifest-v2';
import { buildSepoliaRelease } from '../src/core/v2/sepolia-release';
import { RELEASE_VIEWS, type ReleaseView } from '../src/core/v2/sepolia-release-chain';
import { FakeReleaseChain, forkPlan, forkRun, forkV1Manifest, forkVerifyOutput, type Json } from '../src/core/v2/test-support/sepolia-release-fixture';

const run = promisify(execFile);
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = ['--experimental-transform-types', '--no-warnings=ExperimentalWarning', '--import', './scripts/register-ts.mjs', 'scripts/write-sepolia-v2-release.mjs'];
const ABI = parseAbi(Object.values(RELEASE_VIEWS));

/** The fork plan with every code hash replaced by keccak of synthetic code `0x60` + address. */
function syntheticCodePlan(): { plan: Json; code: Map<string, Hex> } {
  const plan = forkPlan();
  const code = new Map<string, Hex>();
  const hashOf = (address: string): Hex => {
    const bytes = `0x60${address.slice(2).toLowerCase()}` as Hex;
    code.set(address.toLowerCase(), bytes);
    return keccak256(bytes);
  };
  plan.partCodeHashes = plan.parts.map(hashOf);
  plan.implementationCodeHashes = plan.implementations.map((a: string) => (BigInt(a) === 0n ? `0x${'0'.repeat(64)}` : hashOf(a)));
  plan.royaltyCowHandlerCodeHash = hashOf(plan.royaltyCowHandler);
  for (const pin of Object.values(plan.safes) as Json[]) {
    pin.codeHash = hashOf(pin.address);
    pin.singletonCodeHash = hashOf(pin.singleton);
    if (BigInt(pin.handler) !== 0n) pin.handlerCodeHash = hashOf(pin.handler);
  }
  return { plan, code };
}

const { plan, code } = syntheticCodePlan();
const v1 = forkV1Manifest(plan);
const expected = buildSepoliaRelease({ v1Manifest: v1, plan, run: forkRun(plan), verifyOutput: forkVerifyOutput(plan), registry: plan.registry });
const fake = new FakeReleaseChain(expected.manifest, expected.manifest.releases[0] as never);
const methods: string[] = [];
const arrivals: number[] = [];

async function answer(method: string, params: unknown[]): Promise<unknown> {
  methods.push(method);
  arrivals.push(performance.now());
  const n = BigInt(expected.manifest.evidence.block.number);
  switch (method) {
    case 'eth_chainId': return toHex(fake.chain);
    case 'eth_getBlockByNumber': {
      const number = BigInt(params[0] as string);
      return { number: toHex(number), hash: await fake.blockHash(number), parentHash: `0x${'0'.repeat(64)}`, timestamp: '0x1', transactions: [], gasLimit: '0x1', gasUsed: '0x0', logsBloom: `0x${'0'.repeat(512)}`, miner: `0x${'0'.repeat(40)}`, difficulty: '0x0', extraData: '0x', nonce: '0x0000000000000000', size: '0x1', uncles: [], baseFeePerGas: '0xf' };
    }
    case 'eth_getCode': return code.get(String(params[0]).toLowerCase()) ?? '0x';
    case 'eth_getStorageAt': {
      const [address, slot, block] = params as [string, Hex, Hex];
      const key = BigInt(slot) === 0n ? '0x0' : (`0x${slot.slice(2).padStart(64, '0')}` as Hex);
      return fake.storage(address as never, key, BigInt(block));
    }
    case 'eth_call': {
      const [{ to, data }, block] = params as [{ to: string; data: Hex }, Hex];
      const { functionName, args } = decodeFunctionData({ abi: ABI, data });
      const value = await fake.call(to as never, functionName as ReleaseView, args ?? [], BigInt(block));
      return encodeFunctionResult({ abi: ABI, functionName, result: value } as never);
    }
    default: throw new Error(`unexpected ${method} (block ${n})`);
  }
}

let server: Server;
let rpc = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      try {
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: await answer(method, params) }));
      } catch (error) {
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: (error as Error).message } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  rpc = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function files(v1Json: Json = v1) {
  const dir = mkdtempSync(join(tmpdir(), 'sh-sep-manifest-'));
  const put = (name: string, value: string) => {
    writeFileSync(join(dir, name), value);
    return join(dir, name);
  };
  return {
    dir,
    args: ['--plan', put('plan.json', JSON.stringify(plan)), '--run', put('run.json', JSON.stringify(forkRun(plan))), '--verify-json', put('verify.json', forkVerifyOutput(plan)), '--registry', plan.registry, '--v1', put('v1.json', JSON.stringify(v1Json))],
  };
}
const cli = (args: string[]) => run(process.execPath, [...SCRIPT, ...args], { cwd: PACKAGE }).then(
  (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
  (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
);

describe('SH-SEP-MANIFEST write-sepolia-v2-release.mjs', () => {
  it('checks the chain through viem, one request at a time and spaced, and writes the manifest the services parse', async () => {
    const { dir, args } = files();
    const out = join(dir, '11155111.json');
    const r = await cli([...args, '--rpc', rpc, '--min-interval-ms', '15', '--out', out]);
    expect(r.stderr).toMatch(/chain check: all reads at block/);
    expect(r.code).toBe(0);
    const written = JSON.parse(readFileSync(out, 'utf8'));
    expect(written).toEqual(JSON.parse(JSON.stringify(expected.json)));
    expect(parseCoreManifestV2(written).releases).toHaveLength(1);
    expect(new Set(methods)).toEqual(new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_getStorageAt']));
    const gaps = arrivals.slice(1).map((t, i) => t - (arrivals[i] as number));
    expect(arrivals.length).toBeGreaterThan(60);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(14);
  }, shLimit(60_000));

  it('refuses to write when the chain disagrees, and names the read', async () => {
    const { dir, args } = files();
    const out = join(dir, '11155111.json');
    const receiver = expected.manifest.releases[0]?.implementations.receiver.address as string;
    fake.setView(receiver, 'PLATFORM_SAFE', [], '0x7777777777777777777777777777777777777777');
    try {
      const r = await cli([...args, '--rpc', rpc, '--min-interval-ms', '0', '--out', out]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/receiver\.PLATFORM_SAFE\(\)/);
      expect(() => readFileSync(out)).toThrow();
    } finally {
      fake.setView(receiver, 'PLATFORM_SAFE', [], expected.manifest.releases[0]?.safes.platform.address);
    }
  }, shLimit(60_000));

  it('offline is a stdout preview only; bad inputs and unsafe options are refused before any write', async () => {
    const { args } = files();
    const preview = await cli([...args, '--offline']);
    expect(preview.code).toBe(0);
    expect(preview.stderr).toMatch(/SKIPPED/);
    expect(JSON.parse(preview.stdout)).toEqual(JSON.parse(JSON.stringify(expected.json)));
    expect((await cli([...args, '--offline', '--out', 'x.json'])).stderr).toMatch(/stdout only/);
    expect((await cli([...args])).stderr).toMatch(/exactly one of --rpc and --offline/);
    expect((await cli([...args, '--rpc', 'https://user:pw@rpc.example/'])).stderr).toMatch(/keyless/);
    expect((await cli([...args, '--rpc', 'http://rpc.example/'])).stderr).toMatch(/keyless https/);
    expect((await cli([...args, '--rpc', 'https://rpc.example/', '--min-interval-ms', '100'])).stderr).toMatch(/at least 2000/);
    const cache = join(PACKAGE, '../contracts/cache/DeployCoreV2.s.sol/11155111/run-latest.json');
    const withCache = args.map((a, i) => (args[i - 1] === '--run' ? cache : a));
    expect((await cli([...withCache, '--offline'])).stderr).toMatch(/forge's cache/);
    const wrong = args.map((a, i) => (args[i - 1] === '--registry' ? '0x5555555555555555555555555555555555555555' : a));
    const refused = await cli([...wrong, '--offline']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/not the plan's/);
  }, shLimit(60_000));
});
