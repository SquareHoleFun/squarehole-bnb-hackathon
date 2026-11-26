import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseInput } from '../config.mjs';
import { httpRpc } from '../rpc.mjs';
import { buildListingKit } from '../kit.mjs';
import { runCli } from '../cli.mjs';
import { fakeRpc, input, H } from './rpc.mjs';

describe('chain-bound listing packs', () => {
  it.each(['11155111', '31337'])('runs the real CLI offline on chain %s without mainnet acknowledgement', async chainId => {
    await mkdir('.cache/lane/listing-kit-b', { recursive: true });
    const dir = await mkdtemp('.cache/lane/listing-kit-b/network-');
    const source = { ...input(), chainId }, rpc = fakeRpc();
    rpc.chainId = `0x${BigInt(chainId).toString(16)}`;
    const file = join(dir, 'input.json'), out = join(dir, 'out');
    await writeFile(file, JSON.stringify(source));
    const endpoint = chainId === '31337' ? 'http://127.0.0.1:8545' : 'https://sepolia.invalid';
    expect(await runCli(['--input', file, '--out', out], {
      env: { LISTING_RPC: endpoint }, stdout: { write() {} }, stderr: { write() {} },
      rpcFactory: (url, options) => httpRpc(url, options, async (_url, request) => {
        expect(url).toBe(endpoint);
        const { id, method, params } = JSON.parse(request.body);
        try { return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: await rpc.request(method, params) })); }
        catch (error) { return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: error.code ?? 3, data: error.data } })); }
      }),
    })).toBe(2);
    expect(JSON.parse(await readFile(join(out, 'report.json'), 'utf8')).chainId).toBe(chainId);
    const batch = JSON.parse(await readFile(join(out, 'safe-batch.json'), 'utf8'));
    expect(batch.chainId).toBe(chainId);
    expect(JSON.parse(await readFile(join(out, 'royalty-lots.json'), 'utf8')).chainId).toBe(chainId);
    expect(batch.transactions).toHaveLength(6);
    expect(rpc.requests.some(r => r.method === 'eth_getBlockByNumber' && r.params[0] === (chainId === '31337' ? 'latest' : 'finalized'))).toBe(true);
  });

  it.each(['LISTING_FAKE_RPC', 'PATH', 'HOME', 'OTHER_RPC'])('refuses RPC variable %s before accessing the environment', name => {
    expect(() => parseInput({ ...input(), rpcEnv: name }, true)).toThrow(/input/);
  });

  it.each(['http://localhost:8545', 'http://127.1:8545', 'http://2130706433:8545', 'http://127.0.0.2:8545',
    'http://[::1]:8545', 'http://rpc.invalid', 'https://127.0.0.1', 'http://127.0.0.1.invalid',
    'http://user@127.0.0.1', 'http://127.0.0.1/#fragment'])('rejects a noncanonical fork URL %s', url => {
    expect(() => httpRpc(url, { chainId: '31337' })).toThrow();
  });

  it('allows only the three selected networks, HTTPS on public networks and mainnet acknowledgement', () => {
    expect(() => httpRpc('http://127.0.0.1:8545', { chainId: '31337' })).not.toThrow();
    expect(() => httpRpc('https://rpc.invalid', { chainId: '11155111' })).not.toThrow();
    expect(() => httpRpc('http://127.0.0.1', { chainId: '11155111' })).toThrow();
    expect(() => httpRpc('https://rpc.invalid', { chainId: '1' })).toThrow(/allow-mainnet/);
    expect(() => httpRpc('https://rpc.invalid', { chainId: '10', allowMainnet: true })).toThrow(/chain/);
    expect(() => parseInput({ ...input(), chainId: '10' }, true)).toThrow(/chain/);
  });

  it.each(['11155111', '31337'])('checks every infrastructure pin and chain identity on %s', async chainId => {
    const config = { ...input(), chainId };
    await expect(buildListingKit(config, fakeRpc())).rejects.toThrow(/chain/);
    const pins = [config.registry, config.multiSend, ...Object.values(config.market).flatMap(v =>
      Object.values(v).filter(p => p?.codeHash))];
    for (const pin of pins) {
      const hash = pin.codeHash; pin.codeHash = H(123);
      const rpc = fakeRpc(); rpc.chainId = `0x${BigInt(chainId).toString(16)}`;
      await expect(buildListingKit(config, rpc)).rejects.toThrow(/pin mismatch/);
      pin.codeHash = hash;
    }
  });
});
