import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { keeperEnvironment, settings } from '../services/runtime.mjs';
import { KEEPER_ENV_NAMES, loadConfig } from '../../../packages/keeper/src/config.ts';

// SH-TA-16: docs/runbooks/keeper-sepolia-env.md names only real keeper variables, lists all of them, and its
// keeper.env block loads as a dry run through the same wrapper the service uses.
const read = path => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const sheet = read('docs/runbooks/keeper-sepolia-env.md');
const runtime = read('infra/server/services/runtime.mjs');
const REFUSED = ['SH_KEEPER_PRIVATE_KEY', 'SH_KEEPER_PRIVATE_SEND_KEY', 'SH_KEEPER_DRY_RUN', 'SH_KEEPER_ALLOW_MAINNET'];
const SERVICE = ['SH_SERVICE_ENABLED', 'SH_SERVICE_MODE', 'SH_SERVICE_ALLOW_MAINNET', 'SH_KEEPER_KEY_FILE', 'SH_KEEPER_PRIVATE_SEND_KEY_FILE'];

const block = (() => {
  const m = sheet.match(/## The file for a dry run\n[\s\S]*?```sh\n([\s\S]*?)```/);
  if (!m) throw new Error('keeper.env block missing');
  return m[1].trim().split('\n');
})();
const FILLED = { SH_KEEPER_RPC_URL: 'https://rpc.invalid/', SH_KEEPER_ADDRESS: '0x0000000000000000000000000000000000000001' };
const fileEnv = () => Object.fromEntries(block.map(line => {
  const at = line.indexOf('=');
  const name = line.slice(0, at);
  const value = line.slice(at + 1);
  return [name, value.startsWith('<founder:') ? FILLED[name] : value];
}));
const dryRun = env => {
  const service = settings('keeper', env);
  return loadConfig(keeperEnvironment(env, service, () => { throw new Error('a dry run reads no key'); }));
};
const rows = section => {
  const m = sheet.match(new RegExp(`### ${section}[^\\n]*\\n([\\s\\S]*?)(?=\\n#|$)`));
  if (!m) throw new Error(`section ${section} missing`);
  return m[1].split('\n').filter(l => l.startsWith('| `SH_')).map(l => l.split('|').slice(1, -1).map(c => c.trim()));
};

describe('the Sepolia keeper sheet (SH-TA-16)', () => {
  it('names only variables the keeper schema or the service wrapper reads', () => {
    const named = new Set(sheet.match(/\bSH_[A-Z0-9_]+\b/g));
    for (const name of SERVICE) expect(runtime, name).toContain(`env.${name}`);
    for (const name of named) expect([...KEEPER_ENV_NAMES, ...SERVICE], name).toContain(name);
    expect(named.size).toBe(KEEPER_ENV_NAMES.length + SERVICE.length);
  });

  it('gives every schema variable its own table row', () => {
    const listed = sheet.split('\n').filter(l => l.startsWith('| `SH_')).map(l => l.match(/^\| `(SH_[A-Z0-9_]+)`/)[1]);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...KEEPER_ENV_NAMES, ...SERVICE].sort());
  });

  it('keeps the refused variables out of the file, which loads as a dry run on Sepolia', () => {
    const env = fileEnv();
    for (const name of REFUSED) expect(env[name], name).toBeUndefined();
    const cfg = dryRun(env);
    expect(cfg.dryRun).toBe(true);
    expect(cfg.privateKey).toBeNull();
    expect(cfg.chainId).toBe(11155111);
    expect(cfg.destinationGas).toEqual({ fork: 'amsterdam', transactionCap: 16777216n });
    expect(cfg.box0).toEqual({
      coordinator: '0x4039f68558Fb8cfce3070712FBb1D530D5e1cb5D', hook: '0xfF107F6e6A4173E6938147bB5AD52EbD2148Aae0',
      receiver: '0x4C75930f44F0b5C1D6BA0Aa6030f551F428816Dd', executor: '0xf1B15FC37BE694F70C25e1a94c1d0AdC7b145CE1' });
    expect(cfg.boxRegistry).toBe('0x5D2866EF084d801aE734D3A2A6E4F7179898737C');
    expect(cfg.fromBlock).toBe(11960339n);
    expect(cfg.limits.maxFeePerGas).toBe(3_000_000_000n);
    expect(cfg.limits.drandRescueMaxFeeWei).toBe(50_000_000_000n);
    expect(cfg.limits.drandRescueWindowSeconds).toBe(259_200n);
    expect(cfg.limits.drandRescueWeiPerDay).toBe(50_000_000_000_000_000n);
    expect(cfg.stateFile).toBe('/state/keeper.json');
  });

  it('states each default the keeper really uses', () => {
    const base = dryRun(fileEnv());
    const defaults = rows('Fees and daily limits').filter(([, value]) => /^`[^`]+`$/.test(value));
    expect(defaults.length).toBe(18);
    for (const [cell, value] of defaults) {
      const name = cell.slice(1, -1);
      expect(dryRun({ ...fileEnv(), [name]: value.slice(1, -1) }), name).toEqual(base);
    }
  });

  it('takes its addresses from the deploy records', () => {
    const v1 = read('docs/evidence/SH-SEPOLIA-CORE-V1-DEPLOY.md').toLowerCase();
    const v2 = read('docs/evidence/SH-SEPOLIA-CORE-V2-DEPLOY.md').toLowerCase();
    const cfg = dryRun(fileEnv());
    for (const a of Object.values(cfg.box0)) expect(v1, a).toContain(a.toLowerCase());
    expect(v1).toContain('start block 11,960,339');
    expect(v2).toContain(cfg.boxRegistry.toLowerCase());
  });

  it('carries no key, hash or keyed URL', () => {
    expect(sheet).not.toMatch(/0x[0-9a-fA-F]{64}/);
    for (const url of sheet.match(/https:\/\/[^\s`)>,]+/g)) {
      expect(['https://sepolia.drpc.org', 'https://ethereum-sepolia-rpc.publicnode.com'], url).toContain(url);
    }
  });
});
