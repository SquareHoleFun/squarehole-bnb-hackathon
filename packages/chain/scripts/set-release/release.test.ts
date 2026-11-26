import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, stringToHex } from 'viem';
vi.mock('node:child_process', () => ({spawn:vi.fn()}));
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(), lstatSync:vi.fn(), readFileSync:vi.fn(),
}));
const { parseConfig, guardChain, forgeArguments, runForge, assertNoDotEnv, assertNewOutput } = await import(new URL('./release.mjs', import.meta.url).href);
const addr = (n: string) => `0x${n.padStart(40, '0')}`;
const config = JSON.stringify({chainId:'1',poolManager:addr('1'),weth:addr('2'),platformSafe:addr('3'),fitSafe:addr('4'),v1RegistryDirectory:[addr('5')]});
describe('release operator boundary', () => {
  it('requires the exact reviewed input manifest hash for mainnet', () => {
    const c = parseConfig(config);
    expect(() => guardChain(c, 1n, 'Geth', {})).toThrow('mainnet-ack');
    expect(() => guardChain(c, 1n, 'Geth', {'mainnet-ack':keccak256(stringToHex('wrong'))})).toThrow('mainnet-ack');
    expect(() => guardChain(c, 1n, 'Geth', {'mainnet-ack':keccak256(stringToHex(config))})).not.toThrow();
  });
  it('refuses chain mismatches and requires Anvil for local forks', () => {
    const c = parseConfig(config.replace('"1"','"11155111"'));
    expect(() => guardChain(c, 1n, 'anvil/v1', {})).toThrow('chain');
    expect(() => guardChain(c, 11155111n, 'Geth', {'local-fork':true})).toThrow('Anvil');
    expect(() => guardChain(c, 11155111n, 'anvil/v1', {'local-fork':true})).not.toThrow();
  });
  it('refuses numeric chain ids, unknown config keys and empty directories', () => {
    for (const bad of [{...JSON.parse(config), chainId:1}, {...JSON.parse(config), key:'secret'}, {...JSON.parse(config), v1RegistryDirectory:[]}]) {
      expect(() => parseConfig(JSON.stringify(bad))).toThrow();
    }
  });
  it('accepts only an explicit sender and one founder signing method', () => {
    const base = {sender:addr('a'),rpc:'http://127.0.0.1:8545',unlocked:true,evm:'amsterdam'};
    expect(forgeArguments('parts', config, base)).toContain('--sender');
    expect(forgeArguments('parts', config, base)).not.toContain('--broadcast');
    expect(() => forgeArguments('parts', config, {...base, sender:undefined})).toThrow('sender');
    expect(() => forgeArguments('parts', config, {...base, ledger:true})).toThrow('signer');
    expect(() => forgeArguments('parts', config, {...base, 'private-key':'no'})).toThrow('option');
  });
  it('resolves the founder keystore from the invocation directory while Forge runs in packages/contracts', async () => {
    const invocationDirectory = process.cwd();
    const contracts = fileURLToPath(new URL('../../../contracts/', import.meta.url));
    const relativeKey = '.cache/release/signer.json';
    const expectedKey = resolve(invocationDirectory, relativeKey);
    expect(expectedKey).not.toBe(resolve(contracts, relativeKey));
    vi.mocked(lstatSync).mockImplementation(() => { throw Object.assign(new Error('absent'), {code:'ENOENT'}); });
    const child = Object.assign(new EventEmitter(), {stdout:new PassThrough()});
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    for (const keyFile of [relativeKey, expectedKey]) {
      const args = forgeArguments('parts', config, {sender:addr('a'),rpc:'http://127.0.0.1:8545',evm:'amsterdam','key-file':keyFile});
      const run = runForge(args);
      child.emit('close', 0);
      await run;
      expect(spawn).toHaveBeenLastCalledWith('forge', args, expect.objectContaining({cwd:contracts}));
      expect(args[args.indexOf('--keystore') + 1]).toBe(expectedKey);
    }
    expect(readFileSync).not.toHaveBeenCalled();
    expect(process.cwd()).toBe(invocationDirectory);
  });
});

it('refuses dotenv discovery without reading any file contents', () => {
  expect(() => assertNoDotEnv('.', () => ({isFile:()=>true}))).toThrow('dotenv');
});
it('refuses an existing output before running any deployment or writer', () => {
  expect(() => assertNewOutput('existing.json', () => ({}))).toThrow('exists');
  expect(() => assertNewOutput('new.json', () => {throw Object.assign(new Error('absent'),{code:'ENOENT'});})).not.toThrow();
});
