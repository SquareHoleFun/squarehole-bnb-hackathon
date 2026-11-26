// SH-275: alpha-sender.mjs's createDriver on chain 97, loaded with stand-ins for the file system, the chain and the
// engine (as runtime.mjs beside it does for Sepolia). Prints the steps it took and whether it refused.
//   node --experimental-vm-modules infra/server/test/fixtures/alpha-sender/runtime-97.mjs <dry-run|live> <none|owner|sepolia-node>
import assert from 'node:assert/strict';
import { constants, readFileSync } from 'node:fs';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import * as runtime from '../../../services/runtime.mjs';
const [mode, fault] = process.argv.slice(2);
const events = [], address = `0x${'12'.repeat(20)}`, uid = 1000;
const context = createContext({ URL, process: { argv: ['node'], stdout: { write() {} }, getuid: () => uid } });
const fs = {
  constants,
  openSync(path, flags) { events.push(['open', path]); assert.ok(flags & constants.O_NOFOLLOW); return path; },
  fstatSync(path) {
    assert.equal(path, '/state');
    return { uid: fault === 'owner' ? 0 : uid, mode: 0o40755, isFile: () => false, isDirectory: () => true };
  },
  readFileSync() { assert.fail('the chain-97 sender reads its key only through the keeper reader'); },
  fchmodSync(path, value) { assert.equal(path, '/state'); events.push(['mode', value]); },
  closeSync() {},
  realpathSync(path) { return path; },
};
const imports = {
  'node:fs': fs, 'node:url': { pathToFileURL }, 'node:timers/promises': { setTimeout: wait },
  './runtime.mjs': { ...runtime, readKeyFile: path => { events.push(['keeper-key', path]); return `0x${'01'.repeat(32)}`; } },
  './alpha/sender/chain.mjs': { SEPOLIA: 11155111, getAddress: v => v, privateKeyToAccount: () => ({ address }),
    createChain: base => ({ chainId: async () => { events.push(['chain', base.chainId]); return fault === 'sepolia-node' ? 11155111 : 97; } }) },
  './alpha/sender/engine.mjs': { createSender: async cfg => { events.push(['sender', cfg.state, cfg.chainId]); return {}; } },
};
const entry = new SourceTextModule(readFileSync(new URL('../../../services/alpha-sender.mjs', import.meta.url), 'utf8'), { context });
await entry.link(specifier => {
  const exports = imports[specifier]; assert.ok(exports, specifier);
  return new SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  }, { context });
});
await entry.evaluate();
let refused = false;
try {
  await entry.namespace.createDriver({ SH_SERVICE_ENABLED: '1', SH_SERVICE_MODE: mode, SH_ALPHA_CHAIN_ID: '97',
    SH_ALPHA_DESK_ADDRESS: address, SH_ALPHA_TETH: address, SH_KEEPER_RPC_URL: 'https://fixture.invalid' });
} catch { refused = true; }
process.stdout.write(JSON.stringify({ events, refused }));
