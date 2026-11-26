import { describe, expect, it } from 'vitest';
import { zeroAddress, type Hex } from 'viem';

// URL imports keep these JS operations under test without adding production declarations.
const runtime = await import(new URL('../../../../../scripts/lib/core-v2-local-runtime.mjs', import.meta.url).href);
const local = await import(new URL('../../../../../scripts/local-core-v2-chain.mjs', import.meta.url).href);
const manifest = await import(new URL('../../../../../scripts/lib/core-v2-local-manifest.mjs', import.meta.url).href);

describe('FINAL2-LOCAL: the rehearsal preserves real amounts, caller roles and transaction envelopes', () => {
  it('direct sends preserve bigint value and use a cap-valid envelope, including new payout stipends', async () => {
    const requests: { method: string; params: unknown[] }[] = [];
    const hash = `0x${'31'.repeat(32)}` as Hex;
    const value = (1n << 200n) + 7n;
    await runtime.send('local-double', { from: zeroAddress, to: zeroAddress, value },
      async (_url: string, method: string, params: unknown[]) => {
        requests.push({ method, params });
        if (method === 'eth_sendTransaction') return hash;
        if (method === 'eth_getTransactionReceipt') return { status: '0x1', transactionHash: hash };
        throw new Error('unexpected request');
      });
    const sent = requests[0]?.params[0] as { gas: Hex; value: Hex };
    expect(BigInt(sent.value)).toBe(value);
    expect(BigInt(sent.gas)).toBe(15_000_000n);
    expect(BigInt(sent.gas)).toBeLessThanOrEqual(16_777_216n);
    expect(requests.map(r => r.method)).toEqual(['eth_sendTransaction', 'eth_getTransactionReceipt']);
  });

  it('the local forge boundary authenticates loopback before invoking the runner and pins Osaka', async () => {
    const invocations: string[][] = [];
    const chain = { rpcUrl: 'http://127.0.0.1:8566', accounts: { actor: zeroAddress, backup: zeroAddress } };
    const actions = {
      assertLocalRpc: async (url: string) => {
        await runtime.assertLocalRpc(url, async (_url: string, method: string) => method === 'eth_chainId' ? '0xaa36a7' : 'anvil/test');
        invocations.push(['checked']);
      },
      runLocalStep: async (_chain: unknown, _name: string, action: () => Promise<unknown>) => action(),
      run: async (command: string, args: string[]) => { invocations.push([command, ...args]); return 'ONCHAIN EXECUTION COMPLETE & SUCCESSFUL'; },
    };
    await local.localForge(chain, 'local-test', 'run()', [], chain.accounts.actor, 'test', actions);
    expect(invocations[0]).toEqual(['checked']);
    const command = invocations[1] ?? [];
    expect(command.slice(command.indexOf('--hardfork'), command.indexOf('--hardfork') + 2)).toEqual(['--hardfork', 'osaka']);
    expect(command).toContain('--isolate');
    expect(command).toContain('--unlocked');
    for (const url of ['https://rpc.example/', 'http://localhost:8566/', 'http://127.0.0.1:8566/?key=fixture']) {
      await expect(local.localForge({ ...chain, rpcUrl: url }, 'local-test', 'run()', [], zeroAddress, 'test', actions)).rejects.toThrow('loopback');
    }
    expect(invocations).toHaveLength(2);
  });

  it('collected fees use both sides at the named block and never convert raw money to Number', async () => {
    const huge = (1n << 200n) + 7n;
    const calls: Record<string, unknown>[] = [];
    const value = await manifest.readCollectedFees({ getContractEvents: async (args: Record<string, unknown>) => {
      calls.push(args);
      return [{ args: { buyersP: huge, sellersP: 11n, qToReserve: 3n, tip: 1n } },
        { args: { buyersP: 17n, sellersP: huge, qToReserve: 0n, tip: 2n } }];
    } }, zeroAddress, 100n, 101n);
    expect(value).toEqual({ buyersP: huge + 17n, sellersP: huge + 11n, qToReserve: 3n, tip: 3n });
    expect(calls).toEqual([expect.objectContaining({ address: zeroAddress, fromBlock: 100n, toBlock: 101n, strict: true })]);
    expect(JSON.parse(runtime.json(value)).buyersP).toBe(String(huge + 17n));
  });
});
