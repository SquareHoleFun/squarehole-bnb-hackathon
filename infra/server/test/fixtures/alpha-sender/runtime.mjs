import assert from 'node:assert/strict';
import { constants, readFileSync } from 'node:fs';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import * as runtime from '../../../services/runtime.mjs';
const [enabled, mode, fault] = process.argv.slice(2);
const events = [], address = `0x${'12'.repeat(20)}`;
const context = createContext({ URL, process: { argv: ['node'], stdout: { write() {} } } });
const chain = { chainId: async () => { events.push('chain'); return 11155111; } };
const fs = {
  constants,
  openSync(path, flags) { events.push(['open', path]); assert.ok(flags & constants.O_NOFOLLOW); return path; },
  fstatSync(path) {
    return { uid: fault === 'owner' ? 1000 : 0, mode: 0o100600, size: 66,
      isFile: () => path.endsWith('desk.key'), isDirectory: () => path === '/state' && fault !== 'file' };
  },
  readFileSync(path) { assert.equal(path, '/run/service-config/desk.key'); return `0x${'01'.repeat(32)}`; },
  fchmodSync(path, mode) { assert.equal(path, '/state'); events.push(['mode', mode]); },
  closeSync() {},
  realpathSync(path) { return path; }, // the entry check's real path (scripts/test/entry-points.test.mjs)
};
const imports = {
  'node:fs': fs, 'node:url': { pathToFileURL }, 'node:timers/promises': { setTimeout: wait }, './runtime.mjs': runtime,
  './alpha/sender/chain.mjs': { createChain: () => chain, getAddress: v => v, privateKeyToAccount: () => ({ address }), SEPOLIA: 11155111 },
  './alpha/sender/engine.mjs': { createSender: async cfg => { events.push(['sender', cfg.state]); return {}; } },
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
  if (enabled === '1') await entry.namespace.createDriver({ SH_SERVICE_ENABLED: enabled, SH_SERVICE_MODE: mode,
    SH_ALPHA_DESK_ADDRESS: address, SH_ALPHA_TETH: address, SH_KEEPER_RPC_URL: 'https://fixture.invalid' });
} catch { refused = true; }
process.stdout.write(JSON.stringify({ events, refused }));
