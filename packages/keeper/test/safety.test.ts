import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig, secretsOf } from '../src/config';
import { makeLogger } from '../src/log';

// Made-up values built at run time (no real key or token is ever written in this repository).
const KEY = `0x${'ab'.repeat(31)}cd`;
const RPC = `https://rpc.example.invalid/v2/${'t'.repeat(3)}oken-one`;
const PRIVATE_RPC = `https://private.example.invalid/fast?auth=${'t'.repeat(3)}oken-two`;

describe('keys, dry run and logs (the ticket\'s review lens)', () => {
  it('reads its key only from the environment and runs dry unless told to send', () => {
    const dry = loadConfig({ SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: RPC });
    expect(dry.dryRun).toBe(true);
    expect(dry.privateKey).toBeNull();
    const live = loadConfig({ SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: RPC, SH_KEEPER_DRY_RUN: '0', SH_KEEPER_PRIVATE_KEY: KEY });
    expect(live.dryRun).toBe(false);
    expect(live.privateKey).toBe(KEY);
  });

  it('refuses to send without a key, and refuses a malformed one', () => {
    expect(() => loadConfig({ SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: RPC, SH_KEEPER_DRY_RUN: '0' })).toThrow(/SH_KEEPER_PRIVATE_KEY/);
    expect(() => loadConfig({ SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: RPC, SH_KEEPER_DRY_RUN: '0', SH_KEEPER_PRIVATE_KEY: '0x12' })).toThrow();
  });

  it('never prints the key or an RPC token, in its summary or in any log line', () => {
    const cfg = loadConfig({
      SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: RPC,
      SH_KEEPER_PRIVATE_RPC_URL: PRIVATE_RPC,
      SH_KEEPER_DRY_RUN: '0',
      SH_KEEPER_PRIVATE_KEY: KEY,
    });
    const lines: string[] = [];
    const log = makeLogger(secretsOf(cfg), (line) => lines.push(line));
    log.info('config', { summary: describeConfig(cfg) });
    log.error('send failed', { error: new Error(`could not reach ${RPC} with ${KEY} or ${KEY.slice(2)}`) });
    log.warn(`private endpoint ${PRIVATE_RPC} refused`);
    const all = lines.join('\n');
    for (const secret of [KEY, KEY.slice(2), RPC, PRIVATE_RPC, 'tttoken-one', 'tttoken-two']) {
      expect(all).not.toContain(secret);
    }
    expect(all).toContain('[redacted]');
    expect(lines).toHaveLength(3);
  });
});
