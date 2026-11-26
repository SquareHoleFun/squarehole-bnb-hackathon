import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runCli } from '../cli.mjs';
import { httpRpc } from '../rpc.mjs';
import { fakeRpc, input } from './rpc.mjs';

describe('read-only CLI, files and error redaction', () => {
  it('writes all public artifacts, refuses overwrite, and returns 2 for excluded coins', async () => {
    await mkdir('.cache/lane/listing-kit', { recursive: true });
    const dir = await mkdtemp(resolve('.cache/lane/listing-kit/cli-'));
    const path = join(dir, 'input.json'), out = join(dir, 'result');
    await writeFile(path, JSON.stringify(input()));
    let stdout = '', stderr = '';
    const deps = { env: { LISTING_RPC: 'https://rpc.invalid/obviously-fake-value' }, rpcFactory: () => fakeRpc(),
      stdout: { write: v => { stdout += v; } }, stderr: { write: v => { stderr += v; } } };
    expect(await runCli(['--input', path, '--out', out, '--allow-mainnet'], deps)).toBe(2);
    expect(JSON.parse(await readFile(join(out, 'safe-batch.json'), 'utf8')).transactions).toHaveLength(6);
    expect(JSON.parse(await readFile(join(out, 'report.json'), 'utf8')).coins).toHaveLength(6);
    expect(JSON.parse(await readFile(join(out, 'dust.json'), 'utf8'))).toHaveLength(6);
    expect(JSON.parse(await readFile(join(out, 'burn-bot-routes.json'), 'utf8')).routes).toHaveLength(2);
    const lots = JSON.parse(await readFile(join(out, 'royalty-lots.json'), 'utf8'));
    expect(lots.format).toBe('squarehole.royalty-lots/1');
    expect(lots.entries.map(e => e.listingId)).toEqual(['1', '2']);
    expect(lots.entries.map(e => e.lot)).toEqual(['50000000000000000', '50000000000000000']);
    expect(await readFile(join(out, 'issuer-powers', `${input().tokens[0].token}.md`), 'utf8')).toContain('Issuer powers');
    expect(await runCli(['--input', path, '--out', out, '--allow-mainnet'], deps)).toBe(1);
    expect(stdout + stderr).not.toContain('obviously-fake-value');
  });

  it('refuses mainnet and unsupported flags before accessing environment or RPC', async () => {
    const deps = { env: new Proxy({}, { get() { throw new Error('environment read'); } }),
      rpcFactory: () => { throw new Error('RPC created'); }, stdout: { write() {} }, stderr: { write() {} } };
    expect(await runCli(['--input', 'absent', '--out', 'unused'], deps)).toBe(1);
    expect(await runCli(['--allow-mainnet', '--send'], deps)).toBe(1);
    expect(await runCli(['--help'], deps)).toBe(0);
  });

  it('the HTTP transport is allowlisted, rejects redirects and never leaks upstream messages', async () => {
    const fakeUrl = 'https://rpc.invalid/obviously-fake-value';
    expect(() => httpRpc(fakeUrl)).toThrow(/allow-mainnet/);
    expect(() => httpRpc('http://rpc.invalid', { allowMainnet: true })).toThrow(/HTTPS/);
    let requests = 0;
    const rpc = httpRpc(fakeUrl, { allowMainnet: true }, async (_url, options) => {
      requests++;
      expect(options.redirect).toBe('error');
      const body = JSON.parse(options.body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id,
        error: { code: -32602, message: fakeUrl, data: { endpoint: fakeUrl } } }));
    });
    await expect(rpc.request('eth_sendRawTransaction', [])).rejects.toThrow(/refused/);
    expect(requests).toBe(0);
    try { await rpc.request('eth_call', []); } catch (error) { expect(String(error)).not.toContain(fakeUrl); }
    expect(requests).toBe(1);
  });
});

describe('persistent CLI scan progress', () => {
  it('resumes bounded scans and emits a pack only after all histories finish', async () => {
    await mkdir('.cache/lane/listing-kit-b', { recursive: true });
    const dir = await mkdtemp('.cache/lane/listing-kit-b/resume-');
    const file = join(dir, 'input.json'), cursor = join(dir, 'cursor.json'), out = join(dir, 'out');
    await writeFile(file, JSON.stringify({ ...input(), tokens: [input().tokens[0]], logChunk: '500', maxScanBlocks: '1000' }));
    const rpc = fakeRpc(), deps = { env: { LISTING_RPC: 'https://rpc.invalid' }, rpcFactory: () => rpc,
      stdout: { write() {} }, stderr: { write() {} } };
    const args = ['--input', file, '--out', out, '--cursor', cursor, '--allow-mainnet'];
    expect(await runCli(args, deps)).toBe(1);
    await expect(readFile(join(out, 'report.json'))).rejects.toThrow();
    const progress = JSON.parse(await readFile(cursor, 'utf8'));
    expect(progress.pages).toHaveLength(2);
    let status = 1;
    for (let attempt = 0; attempt < 5 && status === 1; attempt++) status = await runCli(args, deps);
    expect(status).toBe(0);
    expect(JSON.parse(await readFile(join(out, 'report.json'), 'utf8')).coins[0].eligible).toBe(true);
    const scans = rpc.requests.filter(r => r.method === 'eth_getLogs').map(r => JSON.stringify(r.params));
    expect(new Set(scans).size).toBe(scans.length);
  });
});
